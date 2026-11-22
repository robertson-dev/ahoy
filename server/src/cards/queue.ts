/**
 * Cards — the background queue: one job at a time in the card worker (a child process), dissolve jobs before
 * cut-out jobs, at most one queued job per game and stage (a newer key replaces an older one). No request ever waits on
 * it: requests read what is built and the queue says what is still coming. The worker is started on demand and
 * stopped after a minute without work (which frees the model's memory); a job that runs over ten minutes, or a worker
 * that dies, fails that job.
 */
import type { Subprocess } from "bun";
import { join } from "node:path";
import { logger } from "../log";
import type { WorkerCard, WorkerJob, WorkerReply } from "./worker";

const log = logger("Cards");
const WORKER = join(import.meta.dir, "worker.ts");
export const queueOptions = { idleMs: 60_000, jobTimeoutMs: 10 * 60_000 };

export type Stage = "dissolve" | "final";
export interface Job {
  gameId: number; stage: Stage; key: string;
  /** the worker's job (built when the job starts) */
  make: (id: number) => WorkerJob;
  done: (card: WorkerCard, ms: number) => Promise<void>;
  fail: (error: string) => void;
}

let list: Job[] = [];
let running: { job: Job; id: number; timer: ReturnType<typeof setTimeout>; proc: Subprocess } | null = null;
let proc: Subprocess<"ignore", "inherit", "inherit"> | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let seq = 0;
let finishing = false;

/** "queued", "running" or null for a game (and stage) */
export function jobState(gameId: number, stage?: Stage): "queued" | "running" | null {
  if (running && running.job.gameId === gameId && (!stage || running.job.stage === stage)) return "running";
  return list.some(j => j.gameId === gameId && (!stage || j.stage === stage)) ? "queued" : null;
}
export function jobStage(gameId: number): Stage | null {
  if (running && running.job.gameId === gameId) return running.job.stage;
  return list.find(j => j.gameId === gameId)?.stage ?? null;
}
export const queueLength = () => list.length + (running ? 1 : 0);

export function addJob(job: Job) {
  if (running && running.job.gameId === job.gameId && running.job.stage === job.stage && running.job.key === job.key) return;
  const i = list.findIndex(j => j.gameId === job.gameId && j.stage === job.stage);
  if (i >= 0) list[i] = job; else list.push(job);
  pump();
}

function spawn(): Subprocess<"ignore", "inherit", "inherit"> {
  const p = Bun.spawn([process.execPath, WORKER], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env },
    ipc: (msg: WorkerReply) => void onMessage(msg),
    onExit: (sub: Subprocess, code: number | null, signal: unknown) => onExit(sub, code, signal),
  });
  p.unref();
  proc = p;
  return p;
}

function pump() {
  if (running || finishing) return;
  const i = list.findIndex(j => j.stage === "dissolve"), at = i >= 0 ? i : list.length ? 0 : -1;
  if (at < 0) { armIdle(); return; }
  if (idle) { clearTimeout(idle); idle = null; }
  const job = list.splice(at, 1)[0], id = ++seq;
  let wj: WorkerJob;
  try { wj = job.make(id); } catch (e: any) { job.fail(String(e?.message ?? e)); queueMicrotask(pump); return; }
  let p: Subprocess;
  try { p = proc ?? spawn(); }
  catch (e: any) { job.fail(`the card worker did not start: ${e?.message ?? e}`); queueMicrotask(pump); return; }
  const timer = setTimeout(() => { log.warn(`card job for game ${job.gameId} (${job.stage}) ran over ${queueOptions.jobTimeoutMs / 60_000} min: stopping the worker`); p.kill(); }, queueOptions.jobTimeoutMs);
  running = { job, id, timer, proc: p };
  try { p.send({ type: "job", job: wj }); }
  catch (e: any) { clearTimeout(timer); running = null; job.fail(`the card worker could not take the job: ${e?.message ?? e}`); p.kill(); if (proc === p) proc = null; queueMicrotask(pump); }
}

async function onMessage(msg: WorkerReply) {
  if (!msg || msg.type === "ready" || !running || msg.id !== running.id) return;
  const { job, timer } = running;
  clearTimeout(timer);
  finishing = true;
  running = null;
  try {
    if (msg.type === "done") await job.done(msg.card, msg.ms);
    else job.fail(msg.error);
  } catch (e: any) { job.fail(String(e?.message ?? e)); }
  finally { finishing = false; pump(); }
}

function onExit(p: Subprocess, code: number | null, signal: unknown): void {
  if (proc === p) proc = null;
  if (running && running.proc === p) {                       // only the worker that holds the job fails it
    const { job, timer } = running;
    clearTimeout(timer);
    running = null;
    job.fail(`the card worker stopped (${signal != null ? "signal " + signal : "code " + code})`);
    pump();
  }
}

function armIdle() {
  if (idle || !proc) return;
  idle = setTimeout(() => { idle = null; if (!running && !list.length && proc) { proc.kill(); proc = null; } }, queueOptions.idleMs);
  (idle as { unref?: () => void }).unref?.();
}

/** stop everything (tests, shutdown): the worker, the timers and the queued jobs */
export function stopQueue() {
  list = [];
  if (running) { clearTimeout(running.timer); running = null; }
  if (idle) { clearTimeout(idle); idle = null; }
  finishing = false;
  if (proc) { const p = proc; proc = null; try { p.kill(); } catch { /* already gone */ } }
}
export const workerRunning = () => !!proc;

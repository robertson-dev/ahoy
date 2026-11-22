/**
 * Spotlight — the background queue: one job at a time in the spotlight worker (a child process), at most one job per layout (an
 * art key and a stage), oldest first, at most `queueOptions.max` waiting (a request beyond that is answered from what there is and
 * asked again later). No request waits on it. The worker starts on demand and stops after a minute without work; a job that runs
 * over two minutes, or a worker that dies, fails that job.
 */
import type { Subprocess } from "bun";
import { join } from "node:path";
import { logger } from "../log";
import type { SpotLayout } from "./contract";
import type { SpotJob, SpotReply } from "./worker";

const log = logger("Spotlight");
const WORKER = join(import.meta.dir, "worker.ts");
export const queueOptions = { idleMs: 60_000, jobTimeoutMs: 2 * 60_000, max: 64 };

export interface Job {
  /** the layout's identity: art key and stage */
  id: string;
  make: (seq: number) => SpotJob;
  done: (layout: SpotLayout) => Promise<void> | void;
  fail: (error: string) => void;
}

let list: Job[] = [];
let running: { job: Job; seq: number; timer: ReturnType<typeof setTimeout>; proc: Subprocess } | null = null;
let proc: Subprocess<"ignore", "inherit", "inherit"> | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let seq = 0, finishing = false;

/** "queued", "running" or null for a layout */
export const jobState = (id: string): "queued" | "running" | null => (running?.job.id === id ? "running" : list.some(j => j.id === id) ? "queued" : null);
export const queueLength = () => list.length + (running ? 1 : 0);

/** queue a layout; false when the queue is full (ask again later) */
export function addJob(job: Job): boolean {
  if (jobState(job.id)) return true;
  if (list.length >= queueOptions.max) return false;
  list.push(job);
  pump();
  return true;
}

function spawn(): Subprocess<"ignore", "inherit", "inherit"> {
  const p = Bun.spawn([process.execPath, WORKER], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env },
    ipc: (msg: SpotReply) => void onMessage(msg),
    onExit: (sub: Subprocess, code: number | null, signal: unknown) => onExit(sub, code, signal),
  });
  p.unref();
  proc = p;
  return p;
}

function pump() {
  if (running || finishing) return;
  const job = list.shift();
  if (!job) { armIdle(); return; }
  if (idle) { clearTimeout(idle); idle = null; }
  const n = ++seq;
  let sj: SpotJob;
  try { sj = job.make(n); } catch (e: any) { job.fail(String(e?.message ?? e)); queueMicrotask(pump); return; }
  let p: Subprocess;
  try { p = proc ?? spawn(); }
  catch (e: any) { job.fail(`the spotlight worker did not start: ${e?.message ?? e}`); queueMicrotask(pump); return; }
  const timer = setTimeout(() => { log.warn(`spotlight job ${job.id} ran over ${queueOptions.jobTimeoutMs / 1000} s: stopping the worker`); p.kill(); }, queueOptions.jobTimeoutMs);
  running = { job, seq: n, timer, proc: p };
  try { p.send({ type: "job", job: sj }); }
  catch (e: any) { clearTimeout(timer); running = null; job.fail(`the spotlight worker could not take the job: ${e?.message ?? e}`); p.kill(); if (proc === p) proc = null; queueMicrotask(pump); }
}

async function onMessage(msg: SpotReply) {
  if (!msg || msg.type === "ready" || !running || msg.id !== running.seq) return;
  const { job, timer } = running;
  clearTimeout(timer);
  finishing = true;
  running = null;
  try {
    if (msg.type === "done") await job.done(msg.layout);
    else job.fail(msg.error);
  } catch (e: any) { job.fail(String(e?.message ?? e)); }
  finally { finishing = false; pump(); }
}

function onExit(p: Subprocess, code: number | null, signal: unknown): void {
  if (proc === p) proc = null;
  if (running && running.proc === p) {
    const { job, timer } = running;
    clearTimeout(timer);
    running = null;
    job.fail(`the spotlight worker stopped (${signal != null ? "signal " + signal : "code " + code})`);
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

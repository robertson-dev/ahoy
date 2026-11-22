/**
 * Ahoy API — system.
 *
 *   GET  /api/health                  liveness (public)
 *   GET  /api/v1/system/status        version, uptime, the ludarr connection, counts
 *   GET  /api/v1/system/task  ·  POST /api/v1/system/task/:name     (admin)
 *   GET  /api/v1/log?level=&limit=    (admin)
 *   POST /api/v1/client-error         a page that failed to draw, from the web UI (public: the doors can fail too), into the log
 *   GET  /api/v1/events               Server-Sent Events: library | engine | user | activity | presence | friend | install,
 *                                     and to the one person they are about: pc | order | save
 *   GET  /api/v1/launcher  ·  GET /launcher/:file      the desktop launcher build published from <config>/launcher/ (public):
 *                                                      the installer, and latest.yml + .blockmap for the launcher's own updater
 */
import { Hono } from "hono";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../db";
import { VERSION, cfg, configDir } from "../config";
import { events } from "../events";
import { onLog, recentLogs, write, type Level } from "../log";
import { listTasks, runTask } from "../tasks";
import * as ludarr from "../ludarr";
import { everyone } from "../social";
import type { Env } from "../server";
import { attempt, clientAddress } from "../ratelimit";
import { sessionUser } from "../auth";

export const systemApi = new Hono<Env>();
const started = Date.now();

systemApi.get("/api/v1/system/status", c => c.json({
  appName: "ahoy", version: VERSION, startTime: new Date(started).toISOString(), uptime: Math.round((Date.now() - started) / 1000),
  runtime: `bun ${Bun.version}`, os: process.platform, docker: !!process.env.AHOY_CONFIG,
  // the engine's address is the admin's business; members only learn whether it is up
  ludarr: { connected: ludarr.connected(), url: c.get("user")?.role === "admin" ? cfg("LUDARR_URL") : null, library: ludarr.libraryStatus() },
  counts: {
    users: (db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n,
    online: everyone().filter(p => p.state !== "offline").length,
    games: ludarr.library().length,
    catalog: (db.query("SELECT COUNT(*) AS n FROM catalog").get() as { n: number }).n,
  },
}));

const adminOnly = async (c: any, next: () => Promise<void>) => { if (c.get("user")?.role !== "admin") return c.json({ error: "admins only" }, 403); await next(); };
systemApi.get("/api/v1/system/task", adminOnly, c => c.json({ items: listTasks() }));
systemApi.post("/api/v1/system/task/:name", adminOnly, async c => {
  try { const r = await runTask(c.req.param("name")); return c.json(r, r.ok ? 200 : 500); }
  catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 404); }
});
/* a page that failed to draw (web/src/ui/boundary.tsx): logged as an error from "web", so a blank window someone saw shows up here.
   Capped in size, and at 20 a person (or address) per 10 minutes, so a page stuck in a loop cannot fill the log. Someone not
   signed in is known by their address as the limiter knows it (ratelimit.ts: never a header anyone can write), and all of
   them together get 60 per 10 minutes: the log keeps its newest 20 000 lines, and strangers do not get to push the rest out */
export const guestErrors = { each: 20, all: 60, windowMs: 600_000 };
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
systemApi.post("/api/v1/client-error", async c => {
  const member = c.get("user") as { id: number; name: string } | undefined;
  const who = member?.name ?? `guest ${clientAddress(c)}`;
  // a member's count and the guests' shared one are the server's own few (held: other tries never start them over); a guest's
  // own is its address's
  const own = member ? attempt(`client-error:member ${member.id}`, guestErrors.each, guestErrors.windowMs, true) : attempt(`client-error:${who}`, guestErrors.each, guestErrors.windowMs);
  if (!own.ok) return c.json({ ok: false, error: "too many" }, 429);
  if (!member && !attempt("client-error:guests", guestErrors.all, guestErrors.windowMs, true).ok) return c.json({ ok: false, error: "too many" }, 429);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const frames = clip(body.stack, 1200), where = clip(body.component, 300);
  write("error", "web", `${who} on ${clip(body.path, 160) || "?"}: ${clip(body.message, 300) || "an error"}${frames ? ` | ${frames}` : ""}${where ? ` | in ${where}` : ""}`);
  return c.json({ ok: true });
});
systemApi.get("/api/v1/log", adminOnly, c => c.json({ items: recentLogs({ level: (c.req.query("level") as Level) || undefined, logger: c.req.query("logger") || undefined, limit: Number(c.req.query("limit") ?? 200) }) }));

/* ─────────── live events ─────────── */

/* A stream is its session's for as long as it stays open, not only when it opens: before anything is sent (an event, a log
   line, the 25 s ping) the session is asked for again, and once it has ended (signed out, a new password, the account
   removed, left idle) nothing more goes out and the stream closes. An admin's log lines stop the moment they are no longer one. */
systemApi.get("/api/v1/events", c => {
  const enc = new TextEncoder();
  let off: (() => void)[] = [];
  const stop = () => { for (const f of off) f(); off = []; };
  const session = c.get("session")?.id ?? null;
  const admin = c.get("user")?.role === "admin";
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => { try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ } };
      /** whoever the stream is for now; null (and the stream is over) once its session has ended */
      const who = () => {
        const u = session == null ? null : sessionUser(session);
        if (!u) { stop(); try { controller.close(); } catch { /* closed already */ } }
        return u;
      };
      send("hello", { version: VERSION, at: Date.now() });
      // an event for one person (their PCs, their orders, their saves) goes out on that person's streams only
      off.push(events.subscribe(e => { const u = who(); if (u && (e.to == null || e.to === u.id)) send(e.event, e.data); }));
      if (admin) off.push(onLog(l => { if (l.level !== "debug" && who()?.role === "admin") send("log", l); }));
      const ping = setInterval(() => { if (who()) send("ping", Date.now()); }, 25_000);
      off.push(() => clearInterval(ping));
    },
    cancel() { stop(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" } });
});

/* ─────────── the launcher build ─────────── */

export const launcherApi = new Hono();
const DIR = () => join(configDir(), "launcher");
/** what may be fetched from <config>/launcher/: the installer, electron-updater's manifest and the differential blockmap */
const SAFE = /^(?:[A-Za-z0-9._-]+\.exe(?:\.blockmap)?|latest\.yml)$/;
export async function latestLauncher(): Promise<{ file: string; version: string | null; size: number; url: string } | null> {
  // latest.yml (written by electron-builder) names the current installer; without it, the newest exe wins
  const yml = await Bun.file(join(DIR(), "latest.yml")).text().catch(() => "");
  const named = /^path:\s*(\S+)/m.exec(yml)?.[1];
  const names = (await readdir(DIR()).catch(() => [] as string[])).filter(n => /^[A-Za-z0-9._-]+\.exe$/.test(n));
  let best: { file: string; version: string | null; size: number; mtime: number } | null = null;
  for (const n of names) {
    const s = await stat(join(DIR(), n)).catch(() => null);
    if (!s?.isFile()) continue;
    const version = /(\d+\.\d+\.\d+)/.exec(n)?.[1] ?? null;
    if (n === named) { best = { file: n, version: /^version:\s*(\S+)/m.exec(yml)?.[1] ?? version, size: s.size, mtime: Infinity }; break; }
    if (!best || s.mtimeMs > best.mtime) best = { file: n, version, size: s.size, mtime: s.mtimeMs };
  }
  return best ? { file: best.file, version: best.version, size: best.size, url: `/launcher/${best.file}` } : null;
}
launcherApi.get("/api/v1/launcher", async c => c.json((await latestLauncher()) ?? { file: null }));
launcherApi.get("/launcher/:file", async c => {
  const name = c.req.param("file");
  if (!SAFE.test(name)) return c.json({ error: "no such file" }, 404);
  const f = Bun.file(join(DIR(), name));
  if (!(await f.exists())) return c.json({ error: "no such file" }, 404);
  if (name === "latest.yml") return new Response(f, { headers: { "content-type": "text/yaml; charset=utf-8", "cache-control": "no-store" } });
  return new Response(f, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"`, "content-length": String(f.size), "accept-ranges": "bytes" } });
});

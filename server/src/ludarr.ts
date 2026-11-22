/**
 * Ahoy — the ludarr client. ludarr is the engine behind Ahoy (requests, downloads, imports, packages); Ahoy is
 * its only caller and holds its one API key. Everything player-facing is built here on top of what it answers.
 *
 *   library   GET /api/v1/game, kept as a snapshot (kv) so Ahoy still shows the library while ludarr restarts;
 *             refreshed on every ludarr event and every minute.
 *   events    ludarr's SSE stream is followed and re-emitted on Ahoy's own bus.
 */
import { kv } from "./db";
import { cfg } from "./config";
import { events } from "./events";
import { logger } from "./log";
import { noteTransfers } from "./eta";
const log = logger("ludarr");

/* ─────────────────────── what ludarr answers (mirrors of its serializers) ─────────────────────── */

export type GameStatus = "unreleased" | "missing" | "searching" | "downloading" | "importing" | "available" | "unmonitored" | "failed";
export interface RequestView {
  id: number; gameId: number; state: string; stage: string | null; progress: number; message: string | null; attempt: number; candidates: number; createdAt: number; updatedAt: number; doneAt: number | null; release: { title: string; protocol: string; indexer: string | null; size: number | null; group: string | null } | null;
  /** Ahoy's own, on the members' view only (words.ts, eta.ts): seconds until the copy is on the server; null when it cannot be told */
  etaSeconds?: number | null;
}
export interface LudarrGame {
  id: number; igdbId: number | null; steamAppId: number | null; name: string; slug: string | null; summary: string | null; releaseYear: number | null; rating: number | null;
  drm: string | null; crackStatus: string | null; crackDate: string | null; crackGroup: string | null; crackwatchUrl: string | null;
  coverUrl: string | null; bannerUrl: string | null; screenshots: string[]; genres: string[]; themes: string[]; platforms: string[]; gameModes: string[];
  developer: string | null; publisher: string | null; comingSoon: boolean; releaseText: string | null; releaseIso: string | null;
  monitored: boolean; profileId: number | null; rootFolderId: number | null; path: string | null; tags: string[]; addedAt: number; titleId: number | null;
  /** The artwork revision exposed to players. */
  artRev?: number;
  /** how ludarr has it: 'steam' | 'igdb' | 'catalog' | 'manual'; its other names (searched like its name); the extra queries the
   *  engine sends (engine-side: never to members); the art kinds set by hand and when they last changed (a cache key) */
  source?: string; aliases?: string[]; searchTerms?: string[]; customArt?: string[]; customArtAt?: number | null;
  /** the versions it can be asked for (the platforms it is on, each with its name; a choice only when there are several), and
   *  the one that was asked for (an id of those, or null); absent from an engine that knows no versions */
  platformChoices?: { id: string; label: string }[]; wantPlatform?: string | null;
  status: GameStatus; statusDetail: string; hasFile: boolean;
  /** kind: the package's ('native' | 'rom' | 'recomp' | 'port' | 'emulated'); requiresLauncher: the oldest launcher that can install it;
   *  launchRev: the stamp of the admin's last change to how the copy starts (its manifest's launch.rev; null: never changed);
   *  start: the whole start line, for the admin (never to members) */
  file: { id: number; path: string; size: number | null; version: string | null; launch: string | null; files: number | null; importer: string | null; release: string | null; group: string | null; format: string; addedAt: number; kind?: string; requiresLauncher?: string | null; launchRev?: number | string | null; start?: unknown } | null;
  cutoffUnmet: boolean; request: RequestView | null; profile: { id: number; name: string } | null; rootFolder: { id: number; path: string } | null; tracked: boolean;
}
export interface LudarrGameDetail extends LudarrGame {
  history: { id: number; event: string; release: string | null; source: string | null; message: string | null; at: number }[];
  jobs: { id: number; state: string; tier: string | null; message: string | null; createdAt: number; doneAt: number | null }[];
  files: { id: number; path: string; size: number | null; version: string | null; format: string; createdAt: number }[];
  routes: unknown[]; catalogTitle: { id: number; slug: string } | null;
}
export interface LookupHit { id: { scheme: string; value: string }; name: string; year: number | null; platforms: string[]; cover: string | null; summary: string | null; releaseIso?: string | null; source: string; gameId: number | null; status: GameStatus | null; kinds?: string[] }
/** blocks: how the package can be taken in a few requests ({size, count, digest}), when the engine has it that way */
export interface PackageInfo { id: number; gameId: number | null; jobId: number | null; path: string; name: string; version: string | null; size: number | null; manifest: unknown; createdAt: number; blocks?: unknown }

export class LudarrError extends Error { constructor(msg: string, public status = 502) { super(msg); } }

/* ─────────────────────── the connection ─────────────────────── */

export const pdeps = { fetch: fetch as typeof fetch, now: () => Date.now(), log: (...a: unknown[]) => log.log(...a) };

export const connected = () => !!cfg("LUDARR_URL") && !!cfg("LUDARR_API_KEY");
const base = () => cfg("LUDARR_URL").replace(/\/+$/, "");
const headers = (extra: Record<string, string> = {}) => ({ "X-Api-Key": cfg("LUDARR_API_KEY"), ...extra });

/** one call to ludarr; its error text comes through unchanged, so the UI can show what the engine said */
export async function call<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  if (!connected()) throw new LudarrError("This server's engine is not connected yet; whoever runs it sets it up under Settings → The engine", 503);
  let res: Response;
  try {
    res = await pdeps.fetch(base() + path, { method, headers: headers(body !== undefined ? { "content-type": "application/json" } : {}), body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) { throw new LudarrError(`ludarr did not answer (${e?.message ?? e})`, 502); }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { throw new LudarrError(res.ok ? "ludarr answered with something that is not JSON (is it restarting?)" : `ludarr answered HTTP ${res.status}`, 502); }
  if (res.status === 401) throw new LudarrError("The engine refused this server's key; whoever runs it can fix it under Settings → The engine", 502);
  if (!res.ok) throw new LudarrError(String(data?.error ?? `ludarr answered HTTP ${res.status}`), res.status >= 500 ? 502 : res.status);
  return data as T;
}
export const get = <T,>(path: string) => call<T>("GET", path);
export const post = <T,>(path: string, body?: unknown) => call<T>("POST", path, body ?? {});
export const put = <T,>(path: string, body?: unknown) => call<T>("PUT", path, body ?? {});
export const del = <T,>(path: string) => call<T>("DELETE", path);

/** is there a ludarr at this address, and does the key open it? Used by the admin's setup page before saving. */
export async function probe(url: string, apiKey: string): Promise<{ ok: boolean; version?: string; detail: string }> {
  const b = url.replace(/\/+$/, "");
  try {
    const h = await pdeps.fetch(b + "/api/health", { signal: AbortSignal.timeout(6000) });
    const hj = await h.json().catch(() => ({})) as { ok?: boolean; version?: string };
    if (!hj.ok) return { ok: false, detail: `no ludarr at ${b} (HTTP ${h.status})` };
    const st = await pdeps.fetch(b + "/api/v1/system/status", { headers: { "X-Api-Key": apiKey }, signal: AbortSignal.timeout(6000) });
    if (st.status === 401) return { ok: false, version: hj.version, detail: "ludarr refused that API key" };
    if (!st.ok) return { ok: false, version: hj.version, detail: `ludarr answered HTTP ${st.status}` };
    return { ok: true, version: hj.version, detail: `ludarr ${hj.version ?? ""}`.trim() };
  } catch (e: any) { return { ok: false, detail: String(e?.message ?? e) }; }
}

/* ─────────────────────── the library snapshot ─────────────────────── */

const SNAPSHOT = "ludarr.games";
let games: LudarrGame[] = kv.json<LudarrGame[]>(SNAPSHOT, []);
let snapshotAt = kv.json<{ at: number }>(SNAPSHOT + ".at", { at: 0 }).at;
let lastError: string | null = null;
let inflight: Promise<LudarrGame[]> | null = null;
/** the snapshot as last announced: a refresh that finds the same library says nothing (every open page would reload for nothing) */
let lastJson = "";

export const library = () => games;
/** tests hand in a library without a ludarr */
export const _test = { setLibrary(list: LudarrGame[]) { games = list; snapshotAt = pdeps.now(); lastError = null; lastJson = ""; } };
export const libraryByApp = () => new Map(games.filter(g => g.steamAppId != null).map(g => [g.steamAppId!, g]));
export const libraryById = () => new Map(games.map(g => [g.id, g]));
export const libraryStatus = () => ({ games: games.length, at: snapshotAt, error: lastError, stale: pdeps.now() - snapshotAt > 5 * 60_000 });

/** re-read the library; the snapshot survives a ludarr outage, so a failure only marks it stale. "library" goes out only when
 *  something changed (the minute's re-read of an unchanged library is silent) */
export function refreshLibrary(): Promise<LudarrGame[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await get<{ items: LudarrGame[] }>("/api/v1/game");
      const json = JSON.stringify(r.items);
      games = r.items; snapshotAt = pdeps.now(); lastError = null;
      noteTransfers(games);
      kv.set(SNAPSHOT + ".at", JSON.stringify({ at: snapshotAt }));
      if (json !== lastJson) { lastJson = json; kv.set(SNAPSHOT, json); events.emit("library", { games: games.length }); }
    } catch (e: any) { lastError = String(e?.message ?? e); pdeps.log(`library refresh failed: ${lastError}`); }
    return games;
  })().finally(() => { inflight = null; });
  return inflight;
}

/* ─────────────────────── following ludarr's events ─────────────────────── */

let following = false;
let stop = false;
/** keep one SSE connection to ludarr open; every event refreshes the snapshot (debounced) and is re-emitted as "engine" */
export function followEvents() {
  if (following) return;
  following = true; stop = false;
  void (async () => {
    let backoff = 1000;
    let refresh: ReturnType<typeof setTimeout> | null = null;
    const bump = () => { if (refresh) return; refresh = setTimeout(() => { refresh = null; void refreshLibrary(); }, 500); };
    while (!stop) {
      if (!connected()) { await new Promise(r => setTimeout(r, 3000)); continue; }
      try {
        const res = await pdeps.fetch(`${base()}/api/v1/system/events`, { headers: headers({ accept: "text/event-stream" }) });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        backoff = 1000;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done || stop) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(chunk)?.[1] ?? "message";
            // members get the kind only: the data is the engine's own wording (release titles, indexers, groups), and the UI just reloads
            if (["request", "job", "package", "fetch", "follow", "game"].includes(ev)) { bump(); events.emit("engine", { event: ev }); }
            else if (ev === "hello") bump();
          }
        }
      } catch (e: any) { pdeps.log(`event stream: ${e?.message ?? e}; retrying in ${backoff / 1000}s`); }
      if (!stop) { await new Promise(r => setTimeout(r, backoff)); backoff = Math.min(30_000, backoff * 2); }
    }
    following = false;
  })();
}
export function stopFollowing() { stop = true; }

/* ─────────────────────── streaming through: package files, art ─────────────────────── */

/** a raw response from ludarr (package files, art), passed on to the client with the key stripped */
export async function raw(path: string, init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal; body?: string } = {}): Promise<Response> {
  if (!connected()) return new Response(JSON.stringify({ error: "not connected to ludarr" }), { status: 503, headers: { "content-type": "application/json" } });
  try {
    return await pdeps.fetch(base() + path, { method: init.method ?? "GET", headers: headers(init.headers ?? {}), signal: init.signal, ...(init.body !== undefined ? { body: init.body } : {}) });
  } catch (e: any) { return new Response(JSON.stringify({ error: `ludarr did not answer (${e?.message ?? e})` }), { status: 502, headers: { "content-type": "application/json" } }); }
}

/**
 * Ahoy API — the library (the same paths the UI always used; every answer carries the people around a game).
 *
 *   GET    /api/v1/game                       every game on the server, with who asked / who has it / who plays it, and what is
 *                                             the asker's to do about it (may.cancel: the search or download running for it)
 *   GET    /api/v1/game/lookup?term=          "search any game": ludarr's catalog, Steam and IGDB
 *   GET    /api/v1/game/:id                   detail (files, history, ways to play) + the game's activity
 *   POST   /api/v1/game                       { source: steam, id, searchNow } or { source: <scheme>, id, platform? }  — Get it / Track / Watch
 *                                             (platform: the version asked for, when the hit is on several: one of its choices' ids)
 *   PUT    /api/v1/game/:id/version           { platform }  which version of a game without a copy is looked for (may.version says
 *                                             who: library.ts mayVersion); a search for another version stops, and it is looked for
 *                                             (a game asked for is also to be installed on the asker's PCs that say so: api/pcs.ts)
 *   PUT    /api/v1/game/:id                   { monitored }
 *   DELETE /api/v1/game/:id?deleteFiles=1     (admins; or the member who brought the game to the server, while nobody else wants it)
 *   POST   /api/v1/game/:id/search
 *   DELETE /api/v1/queue/:requestId           (admins; or the member who started that search or brought its game): the search stops,
 *                                             and a game without a copy is no longer wanted by whoever cancelled (library.ts cancel)
 *   GET    /api/v1/package/:id                the package manifest (the launcher installs from it)
 *   GET    /api/v1/package/:id/launch         how the package starts now: {launch, rev, requires, kind} (the launcher asks at Play)
 *   GET    /api/v1/package/:id/files/*        the files themselves, streamed through from ludarr (Range honoured)
 *   GET    /api/v1/package/:id/blocks         the package as blocks: every block's sha256 (when the package says `blocks`)
 *   POST   /api/v1/package/:id/blocks         { digest, want: [[file, first block, count], …] } → those blocks as one stream:
 *                                             a game in a few requests instead of one per file, compressed where that helps
 *   GET    /api/v1/shelf                      five poster ids for the front page and the launcher's setup page (public, no names)
 */
import { Hono } from "hono";
import * as lib from "../library";
import * as ludarr from "../ludarr";
import type { PackageInfo } from "../ludarr";
import { logger } from "../log";
import { playerError } from "../words";
import type { Env } from "../server";
import { plainId } from "../ids";
import { shelfIds } from "../who";
import { pcOfRequest } from "./pcs";

export const libraryApi = new Hono<Env>();
const log = logger("Library");
/** a failure in the members' words (words.ts playerError); the engine's own text goes to the log, for whoever runs the server */
const fail = (c: any, e: any) => {
  const p = playerError(e);
  log.warn(`${c.req.method} ${c.req.path}: ${String(e?.message ?? e)}`);
  return c.json({ error: p.error }, p.status as 400);
};

libraryApi.get("/api/v1/game/lookup", async c => { try { return c.json(await lib.lookup(c.req.query("term") ?? "")); } catch (e) { return fail(c, e); } });
libraryApi.get("/api/v1/game", c => c.json({ items: lib.listGames(c.get("user")), status: ludarr.libraryStatus() }));
libraryApi.get("/api/v1/game/:id", async c => { try { return c.json({ item: await lib.gameDetail(Number(c.req.param("id")), c.get("user")) }); } catch (e) { return fail(c, e); } });
libraryApi.post("/api/v1/game", async c => {
  const b = await c.req.json().catch(() => ({})) as { source?: string; id?: string | number; searchNow?: boolean; platform?: unknown };
  const searchNow = b.searchNow !== false;
  const platform = typeof b.platform === "string" && /^[A-Za-z0-9]{1,16}$/.test(b.platform) ? b.platform : undefined;
  try {
    const from = pcOfRequest(c);
    const item = b.source === "steam" ? await lib.getSteam(c.get("user"), Number(b.id), searchNow, from) : await lib.getHit(c.get("user"), { scheme: String(b.source ?? ""), value: String(b.id ?? "") }, searchNow, from, platform);
    return c.json({ item }, 201);
  } catch (e) { return fail(c, e); }
});
libraryApi.put("/api/v1/game/:id", async c => {
  const b = await c.req.json().catch(() => ({})) as { monitored?: boolean };
  try { return c.json(await lib.monitor(c.get("user"), Number(c.req.param("id")), !!b.monitored)); } catch (e) { return fail(c, e); }
});
libraryApi.put("/api/v1/game/:id/version", async c => {
  const id = Number(c.req.param("id")), u = c.get("user");
  const b = await c.req.json().catch(() => ({})) as { platform?: unknown };
  const platform = b.platform == null ? null : typeof b.platform === "string" && /^[A-Za-z0-9]{1,16}$/.test(b.platform) ? b.platform : undefined;
  const g = ludarr.libraryById().get(id);
  if (!g) return c.json({ error: "That game couldn't be found" }, 404);
  if (platform === undefined || (platform !== null && !g.platformChoices?.some(p => p.id === platform))) return c.json({ error: "That version isn't one of this game's" }, 400);
  if (!lib.mayVersion(u, g)) return c.json({ error: "someone else asked for this game; an admin can change its version" }, 403);
  try {
    const r = await lib.setVersion(u, id, platform, pcOfRequest(c));
    log.info(`${u.name} asked for game ${id} as ${platform ?? "any version"}`);
    return c.json(r);
  } catch (e) { return fail(c, e); }
});
libraryApi.post("/api/v1/game/:id/search", async c => { try { return c.json(await lib.search(c.get("user"), Number(c.req.param("id")), pcOfRequest(c))); } catch (e) { return fail(c, e); } });
libraryApi.delete("/api/v1/game/:id", async c => {
  const id = Number(c.req.param("id"));
  const u = c.get("user");
  // an admin; or the member who brought the game to the server, while nobody else wants it. Wanting a game (Track, Watch,
  // looking again) is anyone's for the asking and gives no say over it: a game the admin added, or someone else's, stays
  const may = lib.mayRemove(u, id);
  if (!may.ok) return c.json({ error: may.others ? "someone else asked for this game; an admin can remove it" : "an admin can remove this game" }, 403);
  const files = c.req.query("deleteFiles") === "1";
  try {
    const r = await lib.remove(id, files);
    log.info(`${u.name} removed game ${id}${files ? " and its files" : ""}`);
    return c.json(r);
  } catch (e) { return fail(c, e); }
});
libraryApi.delete("/api/v1/queue/:id", async c => {
  const id = Number(c.req.param("id")), u = c.get("user");
  if (!lib.mayCancel(u, id)) return c.json({ error: "someone else asked for this game; an admin can cancel it" }, 403);
  try {
    const r = await lib.cancel(u, id);
    log.info(`${u.name} cancelled request ${id}${r.removed ? ": its game left the server" : ""}`);
    return c.json(r);
  } catch (e) { return fail(c, e); }
});

/* ─────────── packages: what the launcher installs ─────────── */

/** a package as the launcher needs it: its files and how it starts — not where it sits on the server, which release it came from,
 *  how it was made or the admin's notes (members' PCs keep the manifest) */
function forLauncher(p: PackageInfo): PackageInfo {
  const m = { ...((p.manifest ?? {}) as Record<string, unknown>) };
  for (const k of ["source", "notes", "tier", "runtime"]) delete m[k];
  return { id: p.id, gameId: p.gameId, jobId: null, path: "", name: p.name, version: p.version, size: p.size, manifest: m, createdAt: p.createdAt, blocks: blocksForLauncher(p.blocks) };
}
/** how a package can be taken as blocks, as the engine says it: the block size, how many, and the digest of the file list they
 *  belong to; anything else is no blocks at all (the launcher then takes the package file by file) */
export function blocksForLauncher(b: unknown): { size: number; count: number; digest: string } | null {
  const x = (b && typeof b === "object" ? b : {}) as { size?: unknown; count?: unknown; digest?: unknown };
  return Number.isSafeInteger(x.size) && (x.size as number) > 0 && Number.isSafeInteger(x.count) && (x.count as number) >= 0 && typeof x.digest === "string" && /^[0-9a-f]{64}$/.test(x.digest)
    ? { size: x.size as number, count: x.count as number, digest: x.digest } : null;
}

libraryApi.get("/api/v1/package/:id", async c => {
  try { return c.json({ item: forLauncher((await ludarr.get<{ item: PackageInfo }>(`/api/v1/package/${Number(c.req.param("id"))}`)).item) }); } catch (e) { return fail(c, e); }
});

/** how a package starts now, as the launcher needs it at Play: the start itself, the stamp of its last change, the oldest
 *  launcher that can follow it, and its kind — nothing else the engine says. ludarr's own answer ({launch, rev}, perhaps with
 *  requires and kind, or the same under item) is read either way; the stamp is the launch's own when it sends none apart */
export function launchForLauncher(r: unknown): { launch: unknown; rev: unknown; requires: unknown; kind: unknown } {
  const top = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const x = (top.item && typeof top.item === "object" ? top.item : top) as { launch?: unknown; rev?: unknown; requires?: unknown; kind?: unknown };
  const launch = x.launch && typeof x.launch === "object" && !Array.isArray(x.launch) ? x.launch as Record<string, unknown> : null;
  return { launch, rev: x.rev ?? launch?.rev ?? null, requires: x.requires ?? null, kind: x.kind ?? null };
}

// live, never cached: a launcher that heard yesterday's start would start yesterday's program. A package that is gone (the
// copy was replaced: that PC has an Update waiting) is asked about at every Play, so it is answered without a log line
libraryApi.get("/api/v1/package/:id/launch", async c => {
  try {
    const r = await ludarr.get<unknown>(`/api/v1/package/${Number(c.req.param("id"))}/launch`);
    return c.json(launchForLauncher(r), 200, { "cache-control": "no-store" });
  } catch (e) {
    if (e instanceof ludarr.LudarrError && e.status === 404) return c.json({ error: playerError(e).error }, 404, { "cache-control": "no-store" });
    return fail(c, e);
  }
});
/**
 * The engine's address for one file of a package, from the address a member asked for; null when that is not a file inside a
 * package. The engine holds much more than files behind the same key, so the member's path is never passed on as it came: it
 * is read as it was sent (still encoded), cut at its slashes, each piece decoded once and refused when it is empty, a dot
 * segment, or carries a slash, a backslash (a URL reads one as a slash) or a control character; the pieces are then encoded
 * afresh. What comes out must still be that same path under the package's files once a URL parser has read it.
 *
 * Once, because the engine reads each piece once too: what is still an escape after that is the file's own name (a file can
 * be called "path%5Cto.bin" or "100%.txt", and the launcher asks for it with its % escaped), and reaches the engine as that
 * name, a piece of text inside the package's folder.
 */
export function packageFilePath(pathname: string): string | null {
  const m = /^\/api\/v1\/package\/([^/]+)\/files\/(.+)$/.exec(pathname);
  const id = m ? plainId(m[1]) : null;
  if (!m || !id) return null;
  const parts: string[] = [];
  for (const raw of m[2]!.split("/")) {
    try {
      const seg = decodeURIComponent(raw);
      if (seg === "" || seg === "." || seg === ".." || /[\/\\\u0000-\u001f\u007f]/.test(seg)) return null;
      parts.push(encodeURIComponent(seg));
    } catch { return null; }                                                   // a broken escape, half a character
  }
  const path = `/api/v1/package/${id}/files/${parts.join("/")}`;
  try { if (new URL(path, "http://engine.invalid").pathname !== path) return null; } catch { return null; }
  return path;
}
libraryApi.on(["GET", "HEAD"], "/api/v1/package/:id/files/*", async c => {
  const path = packageFilePath(new URL(c.req.raw.url).pathname);
  if (!path) return c.json({ error: "no such file" }, 404);
  const h: Record<string, string> = {};
  for (const k of ["range", "if-range", "accept-encoding"]) { const v = c.req.header(k); if (v) h[k] = v; }
  const res = await ludarr.raw(path, { method: c.req.method, headers: h, signal: c.req.raw.signal });
  const out = new Headers();
  for (const k of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag", "cache-control"]) { const v = res.headers.get(k); if (v) out.set(k, v); }
  return new Response(c.req.method === "HEAD" ? null : res.body, { status: res.status, headers: out });
});

/* a package as blocks. The engine is asked for exactly /api/v1/package/<plain number>/blocks: the number is all of the
   member's address that is passed on. What the engine says when it refuses is its own (words.ts): the launcher gets the
   status, and for 409 the digest of the files the package has now, which is what it acts on. */
const BLOCKS_BODY_MAX = 1 << 20;
const blocksPath = (id: string | undefined) => { const n = plainId(id); return n ? `/api/v1/package/${n}/blocks` : null; };
const blocksRefusal = async (res: Response) => {
  const status = [400, 404, 409, 413].includes(res.status) ? res.status : 502;
  const said = status === 409 ? await res.json().catch(() => null) as { digest?: unknown } | null : (await res.body?.cancel().catch(() => {}), null);
  const digest = typeof said?.digest === "string" && /^[0-9a-f]{64}$/.test(said.digest) ? said.digest : undefined;
  return new Response(JSON.stringify({ error: status === 409 ? "the game changed on the server" : status === 404 ? "not available" : "refused", ...(digest ? { digest } : {}) }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
};
libraryApi.on(["GET", "HEAD"], "/api/v1/package/:id/blocks", async c => {
  const path = blocksPath(c.req.param("id"));
  if (!path) return c.json({ error: "not available" }, 404);
  const res = await ludarr.raw(path, { method: c.req.method, signal: c.req.raw.signal });
  if (res.status !== 200) return blocksRefusal(res);
  const out = new Headers({ "cache-control": "no-store" });
  for (const k of ["content-type", "content-length", "etag"]) { const v = res.headers.get(k); if (v) out.set(k, v); }
  return new Response(c.req.method === "HEAD" ? null : res.body, { status: 200, headers: out });
});
libraryApi.post("/api/v1/package/:id/blocks", async c => {
  const path = blocksPath(c.req.param("id"));
  if (!path) return c.json({ error: "not available" }, 404);
  // what is asked for: a digest and a list of numbers, read whole (a megabyte names every block one request may ask for)
  if (Number(c.req.header("content-length") ?? 0) > BLOCKS_BODY_MAX) return c.json({ error: "refused" }, 413);
  const text = await c.req.text().catch(() => "");
  if (text.length > BLOCKS_BODY_MAX) return c.json({ error: "refused" }, 413);
  let asked: { digest?: unknown; want?: unknown } | null = null;
  try { asked = JSON.parse(text); } catch { /* not a request for blocks */ }
  if (!asked || typeof asked !== "object" || typeof asked.digest !== "string" || !Array.isArray(asked.want)) return c.json({ error: "refused" }, 400);
  const res = await ludarr.raw(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ digest: asked.digest, want: asked.want }), signal: c.req.raw.signal });
  if (res.status !== 200) return blocksRefusal(res);
  return new Response(res.body, { status: 200, headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
});

libraryApi.get("/api/v1/shelf", c => c.json({ items: shelfIds().map(id => ({ id })) }));

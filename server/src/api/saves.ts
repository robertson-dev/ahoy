/**
 * Ahoy API — your saves (saves.ts, saverules.ts). All of it is whoever asks' own. `key` names a game the same way on every
 * PC: a<Steam app id>, else g<its id here>.
 *
 *   GET    /api/v1/saves                    → { items }: every game you have saves of (its newest version, how many there are)
 *   GET    /api/v1/saves/:key               → { items, paths }: the game's versions, newest first, and the folders you added
 *   GET    /api/v1/saves/:key/rules         → { paths, exclude, made, appId, known }: where the game keeps its saves on a PC
 *   PUT    /api/v1/saves/:key/paths         { paths }   folders you add as where it keeps them
 *   POST   /api/v1/saves/:key               one part of a version, as the launcher packs it (the body, at most a megabyte:
 *                                           a reverse proxy lets only so much through at once). Beside it: x-ahoy-part
 *                                           "<upload id>:<index>:<count>" and x-ahoy-save (JSON, percent-encoded):
 *                                           { digest, files, bytes, newest, device, gameId, name }
 *                                           → { next } until the last part, then { item, same }; the first part of saves
 *                                           the server already has as its newest is answered { item, same: true } at once
 *   GET    /api/v1/saves/:key/:id           that version's file
 */
import { Hono, type Context } from "hono";
import { PART_MAX, SaveError, appIdOf, extraPaths, fileFor, gamesOf, keepPart, keyOk, metaOf, partOf, setExtraPaths, snapsOf } from "../saves";
import { rulesFor } from "../saverules";
import type { UserRow } from "../auth";
import type { Env } from "../server";

export const savesApi = new Hono<Env>();
const me = (c: Context<Env>): UserRow => c.get("user");
const fail = (c: Context<Env>, e: unknown) => c.json({ error: String((e as Error)?.message ?? e) }, (e instanceof SaveError ? e.status : 500) as 400);
const none = (c: Context<Env>) => c.json({ error: "no such game" }, 404);

savesApi.get("/api/v1/saves", c => c.json({ items: gamesOf(me(c).id) }));
savesApi.get("/api/v1/saves/:key", c => {
  const key = c.req.param("key");
  if (!keyOk(key)) return none(c);
  return c.json({ items: snapsOf(me(c).id, key), paths: extraPaths(me(c).id, key) });
});
savesApi.get("/api/v1/saves/:key/rules", async c => {
  const key = c.req.param("key");
  if (!keyOk(key)) return none(c);
  return c.json(await rulesFor(appIdOf(key), extraPaths(me(c).id, key)), 200, { "cache-control": "no-store" });
});
savesApi.put("/api/v1/saves/:key/paths", async c => {
  const b = await c.req.json().catch(() => ({})) as { paths?: unknown };
  try { return c.json({ paths: setExtraPaths(me(c).id, c.req.param("key"), b.paths) }); } catch (e) { return fail(c, e); }
});
savesApi.post("/api/v1/saves/:key", async c => {
  const key = c.req.param("key");
  if (!keyOk(key)) return none(c);
  let said: unknown = null;
  try { said = JSON.parse(decodeURIComponent(c.req.header("x-ahoy-save") ?? "")); } catch { /* no word about it: refused below */ }
  const meta = metaOf(said), part = partOf(c.req.header("x-ahoy-part"));
  if (!meta || !part) return c.json({ error: "what these saves are was not said" }, 400);
  const length = c.req.header("content-length");
  if (length != null && !(Number(length) <= PART_MAX)) return c.json({ error: "that part is too large" }, 413);
  try {
    const r = await keepPart(me(c).id, key, meta, part, new Uint8Array(await c.req.arrayBuffer()));
    return c.json(r, "item" in r ? 201 : 200);
  } catch (e) { return fail(c, e); }
});
savesApi.get("/api/v1/saves/:key/:id", async c => {
  const f = await fileFor(me(c).id, c.req.param("key"), Number(c.req.param("id")));
  if (!f) return c.json({ error: "no such saves" }, 404);
  return new Response(Bun.file(f.path), { headers: { "content-type": "application/octet-stream", "content-length": String(f.size), "cache-control": "no-store" } });
});

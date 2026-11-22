/** whose game it is, whose search it is, and what of the engine a member can reach through the package files. */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { getPath } from "hono/utils/url";
import { game, http, setLibrary, signup, wipe } from "./helpers";
import { db, kv } from "../src/db";
import * as ludarr from "../src/ludarr";
import type { LudarrGame } from "../src/ludarr";
import { app } from "../src/server";
import { packageFilePath } from "../src/api/library";
import { askerOf, backfillAsked, starterOf } from "../src/social";

/** a fake ludarr: records every call, answers from a table */
let calls: { method: string; path: string; key: string | null; query: string; body: any }[] = [];
/** what the fake engine does with a call no test gave an answer for (engine().settles) */
let settle: ((method: string, path: string, body: any) => { status?: number; json?: unknown } | null) | null = null;
let answers: Record<string, (body: any) => { status?: number; json?: unknown; body?: BodyInit; headers?: Record<string, string> }> = {};
const realFetch = ludarr.pdeps.fetch, realLog = ludarr.pdeps.log;
afterAll(() => { ludarr.pdeps.fetch = realFetch; ludarr.pdeps.log = realLog; });
beforeEach(() => {
  wipe(); calls = []; answers = {}; settle = null;
  kv.set("cfg.LUDARR_URL", "http://engine:7979"); kv.set("cfg.LUDARR_API_KEY", "k3y");
  ludarr.pdeps.log = () => {};
  ludarr.pdeps.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    // the path as the engine would get it: read by a URL parser, as fetch does (dot segments folded, a backslash a slash)
    const at = new URL(String(url instanceof Request ? url.url : url)), path = at.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? "GET", path, key: (init?.headers as Record<string, string> | undefined)?.["X-Api-Key"] ?? null, query: at.search, body });
    const a = answers[`${init?.method ?? "GET"} ${path}`];
    const r: { status?: number; json?: unknown; body?: BodyInit; headers?: Record<string, string> } | null = a ? a(body) : settle?.(init?.method ?? "GET", path, body) ?? null;
    if (!r) return new Response(JSON.stringify({ error: "no such endpoint" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(r.body ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
});

const nowS = () => Math.floor(Date.now() / 1000);
const request = (id: number, gameId: number) => ({ id, gameId, state: "searching", stage: "searching", progress: 0, message: null, attempt: 1, candidates: 0, createdAt: nowS(), updatedAt: nowS(), doneAt: null, release: null });
/** an engine with a library that changes: add and remove work on `shelf`, and the list answers from it */
function engine(shelf: LudarrGame[]) {
  answers["GET /api/v1/game"] = () => ({ json: { items: shelf } });
  return {
    shelf,
    /** "add this game" answers with `g`: the engine's own copy when it has it already, else it is added now */
    adds: (g: LudarrGame) => { answers["POST /api/v1/game"] = () => { const have = shelf.find(x => x.id === g.id); if (!have) shelf.push(g); return { status: 201, json: { item: have ?? g } }; }; },
    removable: (id: number) => { answers[`DELETE /api/v1/game/${id}`] = () => { const i = shelf.findIndex(x => x.id === id); if (i >= 0) shelf.splice(i, 1); return { json: { deleted: id } }; }; },
    /** the engine does what a cancel asks of it once the search has stopped: a game is no longer watched, or leaves */
    settles: () => {
      settle = (method, path, body) => {
        const m = /^\/api\/v1\/game\/(\d+)$/.exec(path), i = m ? shelf.findIndex(x => x.id === Number(m[1])) : -1;
        if (i < 0) return null;
        if (method === "PUT") { shelf[i] = { ...shelf[i]!, monitored: !!body?.monitored }; return { json: { item: shelf[i] } }; }
        if (method === "DELETE") { shelf.splice(i, 1); return { json: { deleted: Number(m![1]) } }; }
        return null;
      };
    },
  };
}
const removed = () => calls.filter(c => c.method === "DELETE").map(c => c.path);
/** the searches the engine was told to stop */
const searchesStopped = () => calls.filter(c => c.method === "DELETE" && c.path.startsWith("/api/v1/queue/")).map(c => c.path);

describe("removing a game", () => {
  test("wanting a game gives no say over it: a member cannot make themselves its requester and delete it", async () => {
    const admin = await signup("skipper"), a = await signup("anne"), b = await signup("bart");
    // game 42 was added in the engine by the admin; game 43 was asked for by Anne
    const e = engine([game(42, "Elden Ring")]);
    await ludarr.refreshLibrary();
    e.adds(game(43, "Hades", { addedAt: nowS() }));
    await http("POST", "/api/v1/game", { source: "steam", id: 1145360 }, a.token);
    e.removable(42); e.removable(43);
    answers["PUT /api/v1/game/42"] = () => ({ json: { item: game(42, "Elden Ring") } });
    answers["PUT /api/v1/game/43"] = () => ({ json: { item: e.shelf.find(g => g.id === 43) } });
    answers["POST /api/v1/game/42/search"] = () => ({ status: 201, json: {} });
    answers["POST /api/v1/game/43/search"] = () => ({ status: 200, json: { duplicate: true } });

    for (const id of [42, 43]) {
      // every way a member has to book a want: Track / Watch, look again, "Get it" on a game that is already there
      expect((await http("PUT", `/api/v1/game/${id}`, { monitored: true }, b.token)).status).toBe(200);
      expect((await http("DELETE", `/api/v1/game/${id}?deleteFiles=1`, undefined, b.token)).status).toBe(403);
      expect((await http("POST", `/api/v1/game/${id}/search`, undefined, b.token)).status).toBe(200);
      expect((await http("DELETE", `/api/v1/game/${id}?deleteFiles=1`, undefined, b.token)).status).toBe(403);
      e.adds(e.shelf.find(g => g.id === id)!);
      expect((await http("POST", "/api/v1/game", { source: "steam", id: 1 }, b.token)).status).toBe(201);
      expect((await http("DELETE", `/api/v1/game/${id}?deleteFiles=1`, undefined, b.token)).status).toBe(403);
    }
    expect(removed()).toEqual([]);
    expect(askerOf(42)).toBeNull(); expect(askerOf(43)).toBe(a.user.id);

    // Anne asked for 43 first, but Bart wants it too now: it is no longer hers alone to take away
    const shared = await http("DELETE", "/api/v1/game/43", undefined, a.token);
    expect(shared.status).toBe(403); expect(shared.json.error).toContain("an admin can remove it");
    expect((await http("PUT", "/api/v1/game/43", { monitored: false }, b.token)).status).toBe(200);
    expect((await http("DELETE", "/api/v1/game/43?deleteFiles=1", undefined, a.token)).status).toBe(200);
    // the admin keeps every right
    expect((await http("DELETE", "/api/v1/game/42?deleteFiles=1", undefined, admin.token)).status).toBe(200);
    expect(removed()).toEqual(["/api/v1/game/43", "/api/v1/game/42"]);
    expect(askerOf(43)).toBeNull();                                                              // gone with the game: the id's next game is not Anne's
  });

  test("a game that was on the server before is not the next person's who asks for it, however the engine answers", async () => {
    await signup("skipper"); const b = await signup("bart");
    const e = engine([]);                                                                        // the library was never read: the snapshot is empty
    e.shelf.push(game(7, "Celeste"));                                                            // added to the engine long ago (helpers' addedAt)
    e.adds(game(7, "Celeste")); e.removable(7);
    expect((await http("POST", "/api/v1/game", { source: "steam", id: 504230 }, b.token)).status).toBe(201);
    expect(askerOf(7)).toBeNull();
    expect((await http("DELETE", "/api/v1/game/7", undefined, b.token)).status).toBe(403);
    expect(removed()).toEqual([]);
  });

  test("a server that ran before this: a game is given to whoever asked for it when it came to the server, and to nobody for a later want", async () => {
    await signup("skipper"); const a = await signup("anne"), b = await signup("bart");
    const CAME = 1_760_000_000, LONG_BEFORE = CAME - 300 * 86_400;                               // when the engine added each game
    const act = db.query("INSERT INTO activity (user_id, kind, game_id, created_at) VALUES (?,?,?,?)"), want = db.query("INSERT INTO wants (user_id, game_id, kind) VALUES (?,?,'get')");
    act.run(a.user.id, "requested", 1, CAME + 4); act.run(b.user.id, "requested", 1, CAME + 900); want.run(a.user.id, 1); want.run(b.user.id, 1);   // Anne asked for it, Bart looked again later
    act.run(b.user.id, "installed", 2, CAME + 1); act.run(a.user.id, "tracked", 2, CAME + 30); want.run(a.user.id, 2);       // Anne tracked it (a game not out yet) and so brought it
    act.run(b.user.id, "requested", 3, CAME + 5); want.run(a.user.id, 3);                                                    // whoever asked first no longer wants it
    act.run(b.user.id, "tracked", 4, CAME); want.run(b.user.id, 4);                                                          // game 4 was the admin's, there long before Bart tracked it
    act.run(b.user.id, "requested", 5, CAME + 601); want.run(b.user.id, 5);                                                  // looked again for the admin's new game, past the minutes that make it new
    act.run(b.user.id, "requested", 6, LONG_BEFORE); act.run(a.user.id, "requested", 6, CAME + 9); want.run(a.user.id, 6); want.run(b.user.id, 6);   // an older game had number 6 once: its line is not about this one
    act.run(b.user.id, "requested", 7, CAME + 2); want.run(b.user.id, 7);                                                    // not in the library the server last read
    const library = [game(1, "One", { addedAt: CAME }), game(2, "Two", { addedAt: CAME }), game(3, "Three", { addedAt: CAME }), game(4, "Four", { addedAt: LONG_BEFORE }),
      game(5, "Five", { addedAt: CAME }), game(6, "Six", { addedAt: CAME * 1000 })];             // the engine's time in milliseconds reads the same
    kv.del("asked.backfilled");
    backfillAsked(library);
    expect([1, 2, 3, 4, 5, 6, 7].map(askerOf)).toEqual([a.user.id, a.user.id, null, null, null, a.user.id, null]);
    db.exec("DELETE FROM asked"); backfillAsked(library);                                         // once only
    expect(askerOf(1)).toBeNull();
  });

  test("a server that ran before this: tracking a game the admin added long before does not make it the member's to delete", async () => {
    await signup("skipper"); const b = await signup("bart");
    // game 42 has been in the engine since helpers' addedAt; much later Bart pressed Track on it, which wrote what it always
    // wrote (his want and a "tracked" line), and nobody else has a want on it
    const e = engine([game(42, "Elden Ring", { status: "available", hasFile: true })]);
    await ludarr.refreshLibrary();                                                              // the library the server keeps, as at boot
    db.query("INSERT INTO activity (user_id, kind, game_id, created_at) VALUES (?,?,?,?)").run(b.user.id, "tracked", 42, 1_760_000_000);
    db.query("INSERT INTO wants (user_id, game_id, kind) VALUES (?,?,'track')").run(b.user.id, 42);
    kv.del("asked.backfilled");
    backfillAsked();                                                                             // what runs once when the new server first starts
    expect(askerOf(42)).toBeNull();
    e.removable(42);
    const r = await http("DELETE", "/api/v1/game/42?deleteFiles=1", undefined, b.token);
    expect(r.status).toBe(403); expect(r.json.error).toBe("an admin can remove this game");
    expect(removed()).toEqual([]);
  });
});

describe("cancelling a search", () => {
  test("only an admin, whoever started that search, or whoever brought its game", async () => {
    const admin = await signup("skipper"), a = await signup("anne"), b = await signup("bart");
    const e = engine([game(42, "Elden Ring")]);                                                   // the admin's, nothing running
    await ludarr.refreshLibrary();
    e.adds(game(43, "Hades", { addedAt: nowS(), status: "searching", request: request(9, 43) }));
    await http("POST", "/api/v1/game", { source: "steam", id: 1145360 }, a.token);                // Anne's game, her search 9
    answers["DELETE /api/v1/queue/9"] = () => ({ json: { ok: true } });
    answers["DELETE /api/v1/queue/11"] = () => ({ json: { ok: true } });
    answers["POST /api/v1/game/43/search"] = () => ({ status: 200, json: { request: request(9, 43), duplicate: true } });   // the engine's own answer: the search that runs, "already there"
    e.settles();
    const cancelled = searchesStopped;

    expect((await http("DELETE", "/api/v1/queue/9", undefined, b.token)).status).toBe(403);
    await http("POST", "/api/v1/game/43/search", undefined, b.token);                             // "look again" while it runs is not starting it
    await http("PUT", "/api/v1/game/43", { monitored: true }, b.token).catch(() => {});
    expect((await http("DELETE", "/api/v1/queue/9", undefined, b.token)).status).toBe(403);
    for (const id of [1, 2, 3, 9, 500]) await http("DELETE", `/api/v1/queue/${id}`, undefined, b.token);
    expect(cancelled()).toEqual([]);

    // Bart looks again for the admin's game: that search (11) is his to cancel, and Anne's to leave alone
    answers["POST /api/v1/game/42/search"] = () => { e.shelf[0] = game(42, "Elden Ring", { status: "searching", request: request(11, 42) }); return { status: 201, json: { request: request(11, 42), duplicate: false } }; };
    expect((await http("POST", "/api/v1/game/42/search", undefined, b.token)).status).toBe(200);
    expect((await http("DELETE", "/api/v1/queue/11", undefined, a.token)).status).toBe(403);
    expect((await http("DELETE", "/api/v1/queue/11", undefined, b.token)).status).toBe(200);
    expect((await http("DELETE", "/api/v1/queue/9", undefined, a.token)).status).toBe(200);
    expect((await http("DELETE", "/api/v1/queue/9", undefined, admin.token)).status).toBe(200);
    expect(cancelled()).toEqual(["/api/v1/queue/11", "/api/v1/queue/9", "/api/v1/queue/9"]);
  });

  test("a search is whoever's press started it, also when the library was being read again just then", async () => {
    await signup("skipper"); const a = await signup("anne"), b = await signup("bart");
    const e = engine([game(42, "Elden Ring", { status: "failed" })]);                             // the admin's game; its last search failed
    await ludarr.refreshLibrary();
    // a re-read is on its way (an engine event, the minute's task): the engine has read its library, without any search yet,
    // and that answer is still coming when Bart presses Try again
    const onItsWay = JSON.parse(JSON.stringify(e.shelf));
    let arrive!: () => void;
    const held = new Promise<void>(go => { arrive = go; });
    const real = ludarr.pdeps.fetch;
    let first = true;
    ludarr.pdeps.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (first && (init?.method ?? "GET") === "GET" && new URL(String(url)).pathname === "/api/v1/game") { first = false; await held; return new Response(JSON.stringify({ items: onItsWay }), { headers: { "content-type": "application/json" } }); }
      return real(url as string, init);
    }) as typeof fetch;
    const reread = ludarr.refreshLibrary();
    answers["POST /api/v1/game/42/search"] = () => { e.shelf[0] = game(42, "Elden Ring", { status: "searching", request: request(11, 42) }); setTimeout(arrive, 5); return { status: 201, json: { request: request(11, 42), duplicate: false } }; };
    expect((await http("POST", "/api/v1/game/42/search", undefined, b.token)).status).toBe(200);
    await reread;
    expect(ludarr.libraryById().get(42)?.request ?? null).toBeNull();                           // the library Ahoy holds does not show the search yet
    expect(starterOf(11)).toBe(b.user.id);
    await ludarr.refreshLibrary();                                                              // the next re-read shows it
    const mine = (await http("GET", "/api/v1/game", undefined, b.token)).json.items[0], hers = (await http("GET", "/api/v1/game", undefined, a.token)).json.items[0];
    expect(mine.request.id).toBe(11); expect(mine.may).toEqual({ cancel: true, version: false }); expect(hers.may).toEqual({ cancel: false, version: false });
    answers["DELETE /api/v1/queue/11"] = () => ({ json: { ok: true } });
    e.settles();
    expect((await http("DELETE", "/api/v1/queue/11", undefined, a.token)).status).toBe(403);
    expect((await http("DELETE", "/api/v1/queue/11", undefined, b.token)).status).toBe(200);
  });

  test("a search that had stopped and runs again is whoever's press set it going again", async () => {
    await signup("skipper"); const a = await signup("anne"), b = await signup("bart");
    // search 7 for the admin's game gave up waiting for its download an hour ago; the engine keeps its number when it is picked up
    const stopped = { ...request(7, 42), state: "failed", stage: "failed", updatedAt: nowS() - 3600, doneAt: nowS() - 3600 };
    const running = { ...request(7, 42), state: "fetching", stage: "downloading" };
    const e = engine([game(42, "Elden Ring", { status: "failed", request: stopped }), game(43, "Hades", { status: "failed", request: { ...stopped, id: 8, gameId: 43 } })]);
    await ludarr.refreshLibrary();
    db.query("INSERT INTO request_starts (request_id, game_id, user_id, created_at) VALUES (7, 42, ?, ?)").run(a.user.id, nowS() - 86_400);   // Anne started it, a day ago
    answers["DELETE /api/v1/queue/7"] = () => ({ json: { ok: true } });
    answers["DELETE /api/v1/queue/8"] = () => ({ json: { ok: true } });
    e.settles();
    const cancelled = searchesStopped;

    // an answer of "already there" for a search that is not running after the press either: nothing was started (game 43)
    answers["POST /api/v1/game/43/search"] = () => ({ status: 200, json: { request: { ...stopped, id: 8, gameId: 43 }, duplicate: true } });
    expect((await http("POST", "/api/v1/game/43/search", undefined, b.token)).json).toEqual({ duplicate: true });
    expect(starterOf(8)).toBeNull();
    expect((await http("DELETE", "/api/v1/queue/8", undefined, b.token)).status).toBe(403);

    // Bart presses Try again on 42: "already there", and running now. The library Ahoy holds still shows it stopped (the engine's
    // list is read again a moment later)
    answers["POST /api/v1/game/42/search"] = () => ({ status: 200, json: { request: running, duplicate: true } });
    expect((await http("POST", "/api/v1/game/42/search", undefined, b.token)).json).toEqual({ duplicate: true });
    expect(starterOf(7)).toBe(b.user.id);                                                        // his now: Anne's start was the run that stopped
    // Anne presses it too before the library is read again: it is running by Bart's press, hers changes nothing
    expect((await http("POST", "/api/v1/game/42/search", undefined, a.token)).json).toEqual({ duplicate: true });
    expect(starterOf(7)).toBe(b.user.id);
    e.shelf[0] = game(42, "Elden Ring", { status: "downloading", request: running });
    await ludarr.refreshLibrary();
    // and once the library shows it running, "already there" is somebody else's search
    expect((await http("POST", "/api/v1/game/42/search", undefined, a.token)).json).toEqual({ duplicate: true });
    expect(starterOf(7)).toBe(b.user.id);
    expect((await http("DELETE", "/api/v1/queue/7", undefined, a.token)).status).toBe(403);
    expect((await http("DELETE", "/api/v1/queue/7", undefined, b.token)).status).toBe(200);
    expect(cancelled()).toEqual(["/api/v1/queue/7"]);
  });

  test("every answer about a game tells whoever asks whether its search is theirs to cancel, by the route's own rule", async () => {
    const admin = await signup("skipper"), a = await signup("anne"), b = await signup("bart");
    const e = engine([game(42, "Elden Ring")]);                                                   // the admin's, nothing running
    await ludarr.refreshLibrary();
    e.adds(game(43, "Hades", { addedAt: nowS(), status: "searching", request: request(9, 43) }));
    const added = await http("POST", "/api/v1/game", { source: "steam", id: 1145360 }, a.token);  // Anne's game, her search 9
    expect(added.json.item.may).toEqual({ cancel: true, version: false });
    const says = async (token: string) => Object.fromEntries(((await http("GET", "/api/v1/game", undefined, token)).json.items as { id: number; may: unknown }[]).map(g => [g.id, g.may]));
    expect(await says(a.token)).toEqual({ 42: { cancel: false, version: false }, 43: { cancel: true, version: false } });         // nothing runs for 42: nothing to cancel
    expect(await says(b.token)).toEqual({ 42: { cancel: false, version: false }, 43: { cancel: false, version: false } });
    expect(await says(admin.token)).toEqual({ 42: { cancel: false, version: false }, 43: { cancel: true, version: false } });
    // the game's own page says the same
    answers["GET /api/v1/game/43"] = () => ({ json: { item: { ...e.shelf.find(g => g.id === 43), history: [], files: [], jobs: [], routes: [] } } });
    expect((await http("GET", "/api/v1/game/43", undefined, b.token)).json.item.may).toEqual({ cancel: false, version: false });
    expect((await http("GET", "/api/v1/game/43", undefined, a.token)).json.item.may).toEqual({ cancel: true, version: false });
    // and what it says is what the route does
    answers["DELETE /api/v1/queue/9"] = () => ({ json: { ok: true } });
    e.settles();
    expect((await http("DELETE", "/api/v1/queue/9", undefined, b.token)).status).toBe(403);
    expect((await http("DELETE", "/api/v1/queue/9", undefined, a.token)).status).toBe(200);
  });
});

describe("a cancelled search stays cancelled", () => {
  // the engine looks again by itself for every game it still watches and has no copy of: stopping the running search alone
  // brought the game back a few hours later, and each time the engine started
  const after = (calls0: number) => calls.slice(calls0).filter(c => c.method !== "GET").map(c => `${c.method} ${c.path}${c.query}${c.body ? ` ${JSON.stringify(c.body)}` : ""}`);
  /** Anne asks for Hades (game 43): it comes to the server as hers, with her search 9 */
  async function hades(extra: LudarrGame[] = []) {
    const admin = await signup("skipper"), a = await signup("anne"), b = await signup("bart");
    const e = engine([game(42, "Elden Ring"), ...extra]);                                         // 42: put there by hand, nobody asked here
    await ludarr.refreshLibrary();
    e.adds(game(43, "Hades", { addedAt: nowS(), status: "searching", request: request(9, 43) }));
    await http("POST", "/api/v1/game", { source: "steam", id: 1145360 }, a.token);
    answers["DELETE /api/v1/queue/9"] = () => ({ json: { ok: true } });
    e.settles();
    return { admin, a, b, e };
  }
  const wants = (gameId: number) => (db.query("SELECT user_id FROM wants WHERE game_id=? ORDER BY user_id").all(gameId) as { user_id: number }[]).map(r => r.user_id);

  test("the game someone asked for and cancels leaves the server: nothing looks for it again", async () => {
    const { a, e } = await hades();
    const n = calls.length;
    const r = await http("DELETE", "/api/v1/queue/9", undefined, a.token);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, removed: true });
    // the search first, then the game itself, with nothing of it deleted from disk (there is nothing)
    expect(after(n)).toEqual(["DELETE /api/v1/queue/9", "DELETE /api/v1/game/43?deleteFiles=0"]);
    expect(e.shelf.map(g => g.id)).toEqual([42]);
    expect(((await http("GET", "/api/v1/game", undefined, a.token)).json.items as { id: number }[]).map(g => g.id)).toEqual([42]);
    expect(wants(43)).toEqual([]);
    expect(askerOf(43)).toBeNull();                                                               // a game that comes back under that number is not hers by this
  });

  test("while someone else wants it, it stays: only the canceller's own wish ends", async () => {
    const { a, b, e } = await hades();
    await http("PUT", "/api/v1/game/43", { monitored: true }, b.token);                           // Bart tracks it too
    const n = calls.length;
    const r = await http("DELETE", "/api/v1/queue/9", undefined, a.token);
    expect(r.json).toEqual({ ok: true, removed: false });
    expect(after(n)).toEqual(["DELETE /api/v1/queue/9"]);                                         // the engine keeps watching it, for Bart
    expect(e.shelf.find(g => g.id === 43)?.monitored).toBe(true);
    expect(wants(43)).toEqual([b.user.id]);
    expect(askerOf(43)).toBe(a.user.id);
  });

  test("an admin's cancel ends everyone's wish for the game", async () => {
    const { admin, b, e } = await hades();
    await http("PUT", "/api/v1/game/43", { monitored: true }, b.token);
    const n = calls.length;
    expect((await http("DELETE", "/api/v1/queue/9", undefined, admin.token)).json).toEqual({ ok: true, removed: true });
    expect(after(n)).toEqual(["DELETE /api/v1/queue/9", "DELETE /api/v1/game/43?deleteFiles=0"]);
    expect(e.shelf.map(g => g.id)).toEqual([42]);
    expect(wants(43)).toEqual([]);
  });

  test("a game put on the server by hand stays, and is no longer looked for", async () => {
    const { admin, b, e } = await hades();
    // Bart looks for the game nobody here asked for: his search 11
    answers["POST /api/v1/game/42/search"] = () => { e.shelf[0] = game(42, "Elden Ring", { status: "searching", request: request(11, 42) }); return { status: 201, json: { request: request(11, 42), duplicate: false } }; };
    answers["DELETE /api/v1/queue/11"] = () => ({ json: { ok: true } });
    await http("POST", "/api/v1/game/42/search", undefined, b.token);
    let n = calls.length;
    expect((await http("DELETE", "/api/v1/queue/11", undefined, b.token)).json).toEqual({ ok: true, removed: false });
    expect(after(n)).toEqual(["DELETE /api/v1/queue/11", 'PUT /api/v1/game/42 {"monitored":false}']);
    expect(e.shelf.map(g => g.id)).toEqual([42, 43]);
    expect(e.shelf[0]!.monitored).toBe(false);
    // the same from an admin, for a search nobody here started
    e.shelf[0] = game(42, "Elden Ring", { status: "searching", request: request(12, 42) });
    answers["DELETE /api/v1/queue/12"] = () => ({ json: { ok: true } });
    await ludarr.refreshLibrary();
    n = calls.length;
    expect((await http("DELETE", "/api/v1/queue/12", undefined, admin.token)).json).toEqual({ ok: true, removed: false });
    expect(after(n)).toEqual(["DELETE /api/v1/queue/12", 'PUT /api/v1/game/42 {"monitored":false}']);
    expect(e.shelf.map(g => g.id)).toEqual([42, 43]);
  });

  test("a game that has a copy keeps it and stays as it is: the search was for a better copy", async () => {
    const copy = { id: 5, path: "", size: 1, version: null, launch: "g.exe", files: 1, importer: null, release: null, group: null, format: "folder", addedAt: nowS() };
    const { admin, a, e } = await hades([game(44, "Outer Wilds", { status: "available", hasFile: true, file: copy, request: request(13, 44) })]);
    db.query("INSERT INTO wants (user_id, game_id, kind) VALUES (?, 44, 'get')").run(a.user.id);
    answers["DELETE /api/v1/queue/13"] = () => ({ json: { ok: true } });
    const n = calls.length;
    expect((await http("DELETE", "/api/v1/queue/13", undefined, admin.token)).json).toEqual({ ok: true, removed: false });
    expect(after(n)).toEqual(["DELETE /api/v1/queue/13"]);
    expect(e.shelf.find(g => g.id === 44)?.monitored).toBe(true);
    expect(wants(44)).toEqual([a.user.id]);
  });

  test("a game the engine will not let go is at least no longer looked for; when it does neither, the cancel says so", async () => {
    const { a, e } = await hades();
    answers["DELETE /api/v1/game/43"] = () => ({ status: 500, json: { error: "its folder is held open" } });
    let n = calls.length;
    const r = await http("DELETE", "/api/v1/queue/9", undefined, a.token);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, removed: false });
    expect(after(n)).toEqual(["DELETE /api/v1/queue/9", "DELETE /api/v1/game/43?deleteFiles=0", 'PUT /api/v1/game/43 {"monitored":false}']);
    expect(e.shelf.find(g => g.id === 43)?.monitored).toBe(false);
    // neither: the member is told (in their words), not left believing it is gone
    e.shelf.find(g => g.id === 43)!.monitored = true;
    db.query("INSERT INTO wants (user_id, game_id, kind) VALUES (?, 43, 'get')").run(a.user.id);
    answers["PUT /api/v1/game/43"] = () => ({ status: 500, json: { error: "database is locked" } });
    n = calls.length;
    const bad = await http("DELETE", "/api/v1/queue/9", undefined, a.token);
    expect(bad.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(bad.json)).not.toContain("folder is held open");
    expect(JSON.stringify(bad.json)).not.toContain("database is locked");
  });
});

describe("package files", () => {
  const INSIDE = /^\/api\/v1\/package\/\d+\/files\/[^/]/;
  /** every address a member might send to climb out of a package's files */
  /** addresses that are refused outright: read once, a piece of them is a dot segment or carries a separator or a control character */
  const REFUSED = [
    "..%5C..%5C..%5Cconfig/host", "..%5c..%5c..%5cconfig%5chost", "%5C..%5C..%5C..%5Cconfig/host", "a/..%5C..%5C..%5C..%5Cconfig/host",       // encoded backslashes
    "%2e%2e/%2e%2e/%2e%2e/config/host", "%2E%2E/%2E%2E/%2E%2E/log", ".%2e/.%2e/.%2e/config/host", "%2e/config", "a/%2e%2e/%2e%2e/%2e%2e/%2e%2e/log",   // encoded dots
    "../../../config/host", "../../../../api/v1/config/host", "a/../../../../config/host", "./../../../log", "a/./../../../../log", "..\\..\\..\\config/host",   // literal dot segments, a literal backslash
    "..%2F..%2F..%2Fconfig%2Fhost", "a%2F..%2F..%2F..%2F..%2Flog", "%2F%2Fattacker.example/x", "a//b", "a/", "/a", "a%00b", "a%0Ab", "%",                 // an encoded slash, empty pieces, control characters, a broken escape
  ];
  /** encoded twice (or three times): read once these are odd file names, and that is all the engine is asked for */
  const TWICE = ["%252e%252e/%252e%252e/%252e%252e/config/host", "%252e%252e%255c%252e%252e%255c%252e%252e%255cconfig/host", "..%255C..%255C..%255Cconfig/host", "%25252e%25252e/x",
    "%252F%252Fattacker.example/x", "a%252F..%252F..%252Flog", "a%250Ab/%2500"];
  const CLIMBS = [...REFUSED, ...TWICE];
  /** the file the engine looks for under the package's folder, from the address it is sent: its own reading (ludarr's
   *  src/api/activity.ts: the path as its hono hands it over, decoded as a URI component) */
  const engineReads = (path: string) => decodeURIComponent(getPath(new Request(`http://engine:7979${path}`)).replace(/^\/api\/v1\/package\/\d+\/files\//, ""));
  /** file names that carry a percent sign of their own, as they sit in a package; the launcher asks for each piece encoded */
  const ODD_NAMES = ["100%.txt", "50%25 off.png", "caf%C3%A9.ogg", "@scope%2fpkg-1.0.0.tgz", "path%5Cto.bin", "line%0Abreak.txt", "100%1Free.dat", "%2e%2e", "%252e%252e", "My Game/data #1.pak", "saves/été/50%.sav"];

  test("a path is taken apart and put together again: nothing but a file inside the package comes out", () => {
    for (const tail of CLIMBS) {
      // as the request line carries it (a URL parser reads it first, as the server's own does), and exactly as written
      for (const sent of [new URL(`http://ahoy.test/api/v1/package/1/files/${tail}`).pathname, `/api/v1/package/1/files/${tail}`]) {
        const out = packageFilePath(sent);
        if (out === null) continue;
        expect(out).toMatch(INSIDE); expect(new URL(out, "http://engine:7979").pathname).toBe(out);
        // and what the engine makes of it stays inside the package's folder, whatever the folder's system takes for a separator
        const file = engineReads(out);
        expect(file).not.toMatch(/[\\\u0000-\u001f\u007f]/);
        expect(file.split("/").every(piece => piece !== "" && piece !== "." && piece !== "..")).toBe(true);
        expect(posix.resolve("/library/pkg", file).startsWith("/library/pkg/")).toBe(true);
        expect(win32.resolve("C:\\library\\pkg", file).startsWith("C:\\library\\pkg\\")).toBe(true);
      }
    }
    for (const tail of REFUSED) expect(packageFilePath(`/api/v1/package/1/files/${tail}`)).toBeNull();
    // read once, an address encoded twice names no folder above the package: the engine is asked for a file called "%2e%2e"
    expect(packageFilePath("/api/v1/package/1/files/%252e%252e/%252e%252e/config/host")).toBe("/api/v1/package/1/files/%252e%252e/%252e%252e/config/host");
    expect(engineReads("/api/v1/package/1/files/%252e%252e/%252e%252e/config/host")).toBe("%2e%2e/%2e%2e/config/host");
    for (const id of ["1e3", "0x10", "-1", "0", "1.0", "%31", "1%2f..", ".."]) expect(packageFilePath(`/api/v1/package/${id}/files/a.bin`)).toBeNull();
    expect(packageFilePath("/api/v1/package/1/files/")).toBeNull();
    expect(packageFilePath("/api/v1/package/1/filesx/a")).toBeNull();
    // real names come through whole, encoded once
    expect(packageFilePath("/api/v1/package/3/files/hades/game.exe")).toBe("/api/v1/package/3/files/hades/game.exe");
    expect(packageFilePath("/api/v1/package/3/files/My%20Game/100%25%20Orange%20Juice%23.pak")).toBe("/api/v1/package/3/files/My%20Game/100%25%20Orange%20Juice%23.pak");
    expect(packageFilePath("/api/v1/package/3/files/a...b/..hidden/data%3F.bin")).toBe("/api/v1/package/3/files/a...b/..hidden/data%3F.bin");
  });

  test("a file whose own name has a percent sign in it can be fetched: the engine is asked for that very name", async () => {
    const a = await signup("yam");
    for (const name of ODD_NAMES) {
      const asked = `/api/v1/package/3/files/${name.split("/").map(encodeURIComponent).join("/")}`;   // the launcher's own way (its manifestSource)
      const out = packageFilePath(asked);
      expect(out).toBe(asked);
      expect(engineReads(out!)).toBe(name);
      // and through the server, as a request
      answers[`GET ${asked}`] = () => ({ body: `bytes of ${name}`, headers: { "content-type": "application/octet-stream" } });
      const r = await http("GET", asked, undefined, a.token);
      expect(r.status).toBe(200); expect(r.json).toBe(`bytes of ${name}`);
    }
    expect(calls.map(c => engineReads(c.path))).toEqual(ODD_NAMES);
  });

  test("through the server no address reaches anything of the engine but a package's files", async () => {
    const a = await signup("yam");
    answers["GET /api/v1/config/host"] = () => ({ json: { apiKey: "k3y" } });
    answers["GET /api/v1/package/3/files/hades/game%20v1.exe"] = () => ({ body: "bytes!", headers: { "content-type": "application/octet-stream" } });
    for (const tail of CLIMBS) {
      for (const method of ["GET", "HEAD"]) {
        const r = await http(method, `/api/v1/package/1/files/${tail}`, undefined, a.token);
        expect(JSON.stringify(r.json ?? "")).not.toContain("k3y");
      }
    }
    for (const c of calls) expect(c.path).toMatch(INSIDE);
    expect(calls.some(c => /^\/api\/v1\/(config|log)/.test(c.path))).toBe(false);
    calls = [];
    const ok = await http("GET", "/api/v1/package/3/files/hades/game%20v1.exe", undefined, a.token);
    expect(ok.status).toBe(200); expect(ok.json).toBe("bytes!");
    expect(calls.map(c => ({ method: c.method, path: c.path, key: c.key }))).toEqual([{ method: "GET", path: "/api/v1/package/3/files/hades/game%20v1.exe", key: "k3y" }]);
  });

  test("the same over a real socket, where the request line is the caller's own bytes", async () => {
    const a = await signup("yam");
    answers["GET /api/v1/config/host"] = () => ({ json: { apiKey: "k3y" } });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    /** one raw request; the answer's first bytes */
    const raw = (target: string) => new Promise<string>((done, fail) => {
      let got = "";
      const t = setTimeout(() => done(got), 1500);
      void Bun.connect({
        hostname: "127.0.0.1", port: server.port!,
        socket: {
          open(s) { s.write(`GET ${target} HTTP/1.1\r\nHost: ahoy.test\r\nAuthorization: Bearer ${a.token}\r\nConnection: close\r\n\r\n`); },
          data(_s, d) { got += new TextDecoder().decode(d); },
          close() { clearTimeout(t); done(got); },
          error(_s, e) { clearTimeout(t); fail(e); },
        },
      }).catch(fail);
    });
    try {
      for (const tail of CLIMBS.filter(t => !/[\n\r ]|%00|%0A/.test(t))) {
        const answer = await raw(`/api/v1/package/1/files/${tail}`);
        expect(answer).not.toContain("k3y");
      }
      for (const c of calls) expect(c.path).toMatch(INSIDE);
      expect(calls.some(c => /^\/api\/v1\/(config|log)/.test(c.path))).toBe(false);
    } finally { server.stop(true); }
  });
});

describe("a package as blocks", () => {
  /** a request whose answer is bytes */
  const bytesOf = async (method: string, path: string, token: string | null, body?: string) => {
    const res = await app.fetch(new Request(`http://ahoy.test${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body }));
    return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
  };
  const D = "a".repeat(64);
  const pkg = (blocks: unknown) => ({ item: { id: 3, gameId: 1, jobId: 9, path: "/mnt/user/DEPOT/library/Hades-RUNE", name: "Hades", version: "1.0", size: 5, createdAt: 1, manifest: { files: [{ path: "g.exe", size: 5, sha256: "x" }], source: { title: "Hades-RUNE" }, notes: "the admin's" }, blocks } });

  test("the package says how it can be taken as blocks, as the engine does, or not at all", async () => {
    const a = await signup("yam");
    answers["GET /api/v1/package/3"] = () => ({ json: pkg({ size: 1048576, count: 7, digest: D, where: "/config/blocks/3.blk" }) });
    const r = await http("GET", "/api/v1/package/3", undefined, a.token);
    expect(r.json.item.blocks).toEqual({ size: 1048576, count: 7, digest: D });          // the three things a launcher acts on, nothing else
    expect(JSON.stringify(r.json)).not.toMatch(/DEPOT|RUNE|admin's|\.blk/);
    for (const odd of [undefined, null, "yes", {}, { size: 0, count: 7, digest: D }, { size: 1048576, count: -1, digest: D }, { size: 1048576, count: 7, digest: "zz" }, { size: "1048576", count: 7, digest: D }, { size: 1048576, count: 7.5, digest: D }]) {
      answers["GET /api/v1/package/3"] = () => ({ json: pkg(odd) });
      expect((await http("GET", "/api/v1/package/3", undefined, a.token)).json.item.blocks).toBeNull();
    }
  });

  test("the index and the blocks come through as the engine sends them; what goes to the engine is a digest and the list", async () => {
    const a = await signup("yam");
    const index = new Uint8Array(64 + 32).map((_, i) => i & 0xff), stream = new Uint8Array([0, 3, 0, 0, 0, 7, 8, 9, 1, 2, 0, 0, 0, 40, 181]);
    answers["GET /api/v1/package/3/blocks"] = () => ({ body: index, headers: { "content-type": "application/octet-stream", "content-length": String(index.byteLength), etag: `"${D}"` } });
    const got = await bytesOf("GET", "/api/v1/package/3/blocks", a.token);
    expect(got.status).toBe(200);
    expect(Buffer.from(got.bytes).equals(Buffer.from(index))).toBe(true);
    expect(got.headers.get("etag")).toBe(`"${D}"`);
    let asked: unknown = null;
    answers["POST /api/v1/package/3/blocks"] = body => { asked = body; return { body: stream, headers: { "content-type": "application/octet-stream", "x-blocks": "2" } }; };
    const sent = await bytesOf("POST", "/api/v1/package/3/blocks", a.token, JSON.stringify({ digest: D, want: [[0, 0, 2], [4, 1, 1]], path: "../../config", key: "please" }));
    expect(sent.status).toBe(200);
    expect(Buffer.from(sent.bytes).equals(Buffer.from(stream))).toBe(true);
    expect(asked).toEqual({ digest: D, want: [[0, 0, 2], [4, 1, 1]] });
    expect(calls.map(c => `${c.method} ${c.path} ${c.key}`)).toEqual(["GET /api/v1/package/3/blocks k3y", "POST /api/v1/package/3/blocks k3y"]);
  });

  test("a refusal is something the launcher acts on, never the engine's words", async () => {
    const a = await signup("yam");
    const ask = (body: string = JSON.stringify({ digest: D, want: [[0, 0, 1]] })) => http("POST", "/api/v1/package/3/blocks", undefined, a.token, {}, undefined).then(() => bytesOf("POST", "/api/v1/package/3/blocks", a.token, body));
    const said = async (r: { status: number; bytes: Uint8Array }) => ({ status: r.status, json: JSON.parse(new TextDecoder().decode(r.bytes)) });
    const B = "b".repeat(64);
    answers["POST /api/v1/package/3/blocks"] = () => ({ status: 409, json: { error: "this package's files are not the ones asked for", digest: B } });
    expect(await said(await bytesOf("POST", "/api/v1/package/3/blocks", a.token, JSON.stringify({ digest: D, want: [[0, 0, 1]] })))).toEqual({ status: 409, json: { error: "the game changed on the server", digest: B } });
    answers["POST /api/v1/package/3/blocks"] = () => ({ status: 404, json: { error: "this package has no block index" } });
    answers["GET /api/v1/package/3/blocks"] = () => ({ status: 404, json: { error: "this package has no block index" } });
    expect(await said(await bytesOf("POST", "/api/v1/package/3/blocks", a.token, JSON.stringify({ digest: D, want: [[0, 0, 1]] })))).toEqual({ status: 404, json: { error: "not available" } });
    expect(await said(await bytesOf("GET", "/api/v1/package/3/blocks", a.token))).toEqual({ status: 404, json: { error: "not available" } });
    answers["POST /api/v1/package/3/blocks"] = () => ({ status: 413, json: { error: "more than 256 MiB in one request" } });
    expect((await said(await bytesOf("POST", "/api/v1/package/3/blocks", a.token, JSON.stringify({ digest: D, want: [[0, 0, 1]] })))).status).toBe(413);
    answers["POST /api/v1/package/3/blocks"] = () => ({ status: 500, json: { error: "ENOSPC: /config/blocks" } });
    expect(await said(await bytesOf("POST", "/api/v1/package/3/blocks", a.token, JSON.stringify({ digest: D, want: [[0, 0, 1]] })))).toEqual({ status: 502, json: { error: "refused" } });
    // what is no request for blocks never reaches the engine
    calls = [];
    for (const body of ["", "not json", "[]", JSON.stringify({ want: [[0, 0, 1]] }), JSON.stringify({ digest: D }), JSON.stringify({ digest: 5, want: [] }), JSON.stringify({ digest: D, want: "all" })]) expect((await bytesOf("POST", "/api/v1/package/3/blocks", a.token, body)).status).toBe(400);
    expect((await bytesOf("POST", "/api/v1/package/3/blocks", a.token, JSON.stringify({ digest: D, want: [], pad: "x".repeat(1 << 20) }))).status).toBe(413);
    expect(calls).toEqual([]);
    void ask;
  });

  test("only that address of a package is reached, and only by someone signed in", async () => {
    const a = await signup("yam");
    answers["GET /api/v1/config/host"] = () => ({ json: { apiKey: "k3y" } });
    answers["GET /api/v1/package/3/blocks"] = () => ({ body: new Uint8Array([1]) });
    answers["POST /api/v1/package/3/blocks"] = () => ({ body: new Uint8Array([1]) });
    for (const id of ["1e3", "0x10", "-1", "0", "1.0", "%33", "3%2F..%2F..%2Fconfig%2Fhost", "..", "3.blk", "03"]) {
      for (const method of ["GET", "POST"]) {
        const r = await bytesOf(method, `/api/v1/package/${id}/blocks`, a.token, method === "POST" ? JSON.stringify({ digest: D, want: [[0, 0, 1]] }) : undefined);
        expect(new TextDecoder().decode(r.bytes)).not.toContain("k3y");
      }
    }
    for (const c of calls) expect(c.path).toBe("/api/v1/package/3/blocks");               // "%33" is 3 once the address is read; nothing else got through
    calls = [];
    expect((await bytesOf("GET", "/api/v1/package/3/blocks", null)).status).toBe(401);
    expect((await bytesOf("POST", "/api/v1/package/3/blocks", null, JSON.stringify({ digest: D, want: [[0, 0, 1]] }))).status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe("what a member is told about a game on the server", () => {
  test("not where its copy sits: no folder of the engine's, no file list", async () => {
    const a = await signup("yam"), admin = a;
    const file = { id: 3, path: "/mnt/user/DEPOT/library/Hades-RUNE", size: 5, version: "1.0", launch: null, files: 2, importer: null, release: null, group: null, format: "x", addedAt: 5 };
    const g = game(1, "Hades", { status: "available", path: "/mnt/user/DEPOT/library/Hades-RUNE", rootFolder: { id: 1, path: "/mnt/user/DEPOT/library" }, file });
    setLibrary([g]);
    answers["GET /api/v1/game/1"] = () => ({ json: { item: { ...g, history: [], jobs: [], routes: [], catalogTitle: null, files: [{ id: 3, path: "/mnt/user/DEPOT/library/Hades-RUNE/Hades.exe", size: 5, version: null, format: "x", createdAt: 1 }] } } });
    const m = await signup("mika");
    for (const token of [m.token, admin.token]) {
      const list = await http("GET", "/api/v1/game", undefined, token), one = await http("GET", "/api/v1/game/1", undefined, token);
      expect(one.status).toBe(200);
      expect(JSON.stringify([list.json, one.json])).not.toMatch(/DEPOT|\/mnt\/|RUNE/);
      expect(one.json.item.files).toEqual([]);
      expect(list.json.items[0]).toMatchObject({ path: null, rootFolder: null, hasFile: false, file: { id: 3, size: 5, version: "1.0" } });
    }
  });
});

describe("which version of a game is looked for", () => {
  const CHOICES = [{ id: "arcade", label: "Arcade" }, { id: "ps3", label: "PlayStation 3" }, { id: "x360", label: "Xbox 360" }];
  const mvc = (over: Partial<LudarrGame> = {}) => game(62, "Marvel vs. Capcom", { platforms: ["Arcade", "PS3", "X360"], platformChoices: CHOICES, wantPlatform: null, addedAt: nowS(), ...over });
  test("asked for with the game: the engine is told the version, and only something that reads as one", async () => {
    await signup("skipper"); const a = await signup("anne");
    const e = engine([]);
    e.adds(mvc());
    expect((await http("POST", "/api/v1/game", { source: "igdb", id: 8246, platform: "arcade" }, a.token)).status).toBe(201);
    expect(calls.find(c => c.method === "POST" && c.path === "/api/v1/game")!.body).toMatchObject({ source: "igdb", id: "8246", platform: "arcade", searchNow: true });
    calls = [];
    await http("POST", "/api/v1/game", { source: "igdb", id: 8246, platform: "../x" }, a.token);
    await http("POST", "/api/v1/game", { source: "igdb", id: 8246, platform: 7 }, a.token);
    await http("POST", "/api/v1/game", { source: "igdb", id: 8246 }, a.token);
    for (const c of calls.filter(x => x.method === "POST" && x.path === "/api/v1/game")) expect("platform" in c.body).toBe(false);
  });
  test("a game says who may choose: anyone while nothing was chosen and nothing looks, then whoever brought it or runs the search", async () => {
    const admin = await signup("skipper"), a = await signup("anne"), b = await signup("bart");
    const may = async (token: string) => (await http("GET", "/api/v1/game", undefined, token)).json.items.find((g: { id: number }) => g.id === 62).may.version;
    const e = engine([]);
    e.adds(mvc());
    await http("POST", "/api/v1/game", { source: "igdb", id: 8246, searchNow: false }, a.token);
    await ludarr.refreshLibrary();
    expect([await may(admin.token), await may(a.token), await may(b.token)]).toEqual([true, true, true]);
    // a version was chosen: it is the game's bringer's (and the admin's) to change
    e.shelf[0] = mvc({ wantPlatform: "arcade" });
    await ludarr.refreshLibrary();
    expect([await may(admin.token), await may(a.token), await may(b.token)]).toEqual([true, true, false]);
    // a copy is here: nothing left to choose
    e.shelf[0] = mvc({ wantPlatform: "arcade", hasFile: true, status: "available" });
    await ludarr.refreshLibrary();
    expect([await may(admin.token), await may(a.token)]).toEqual([false, false]);
    // one platform is no choice
    e.shelf[0] = mvc({ platformChoices: [CHOICES[0]!] });
    await ludarr.refreshLibrary();
    expect(await may(admin.token)).toBe(false);
  });
  test("another version: the engine is told, the new search is the chooser's, and only one of the game's versions is taken", async () => {
    await signup("skipper"); const a = await signup("anne"), b = await signup("bart");
    const e = engine([]);
    e.adds(mvc({ request: { ...request(70, 62), state: "requested" } as LudarrGame["request"] }));   // a search the engine is at work on
    await http("POST", "/api/v1/game", { source: "igdb", id: 8246 }, a.token);
    await ludarr.refreshLibrary();
    // the engine stops the old search and starts one for the new version
    answers["PUT /api/v1/game/62"] = body => { e.shelf[0] = mvc({ wantPlatform: body.platform, monitored: true, request: { ...request(71, 62), state: "requested" } as LudarrGame["request"] }); return { json: { item: e.shelf[0] } }; };
    expect((await http("PUT", "/api/v1/game/62/version", { platform: "psp" }, a.token)).status).toBe(400);
    expect((await http("PUT", "/api/v1/game/62/version", { platform: 7 }, a.token)).status).toBe(400);
    expect((await http("PUT", "/api/v1/game/62/version", { platform: "arcade" }, b.token)).status).toBe(403);     // Anne's search
    expect((await http("PUT", "/api/v1/game/99/version", { platform: "arcade" }, a.token)).status).toBe(404);
    expect(calls.filter(c => c.method === "PUT")).toEqual([]);
    const r = await http("PUT", "/api/v1/game/62/version", { platform: "arcade" }, a.token);
    expect(r.status).toBe(200);
    expect(calls.find(c => c.method === "PUT" && c.path === "/api/v1/game/62")!.body).toEqual({ platform: "arcade", monitored: true });
    expect(r.json.item).toMatchObject({ wantPlatform: "arcade", may: { cancel: true, version: true } });
    expect(starterOf(71)).toBe(a.user.id);
    expect(calls.some(c => c.path === "/api/v1/game/62/search")).toBe(false);                                     // the engine is looking already
  });
  test("the same version as before, with nothing looking: it is looked for", async () => {
    const admin = await signup("skipper");
    const e = engine([mvc({ wantPlatform: "arcade", status: "failed" })]);
    await ludarr.refreshLibrary();
    answers["PUT /api/v1/game/62"] = () => ({ json: { item: e.shelf[0] } });
    answers["POST /api/v1/game/62/search"] = () => ({ status: 201, json: { request: { id: 72, state: "requested" }, duplicate: false } });
    expect((await http("PUT", "/api/v1/game/62/version", { platform: "arcade" }, admin.token)).status).toBe(200);
    expect(calls.some(c => c.method === "POST" && c.path === "/api/v1/game/62/search")).toBe(true);
    expect(starterOf(72)).toBe(admin.user.id);
    // no choice at all is a version too
    expect((await http("PUT", "/api/v1/game/62/version", { platform: null }, admin.token)).status).toBe(200);
    expect(calls.filter(c => c.method === "PUT").at(-1)!.body).toEqual({ platform: null, monitored: true });
  });
});

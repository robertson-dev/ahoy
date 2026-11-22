/** a person's PCs, and what is to be installed on them: placed from anywhere, carried out by the PC, theirs alone. */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { game, http, setLibrary, signup, wipe } from "./helpers";
import { db, kv } from "../src/db";
import { events, type AhoyEvent } from "../src/events";
import * as ludarr from "../src/ludarr";
import type { LudarrGame } from "../src/ludarr";
import { dropOrphanOrders } from "../src/pcs";

/** a fake engine: a shelf of games; "add this game" and "look for it" answer from it */
let shelf: LudarrGame[] = [];
let adds: LudarrGame | null = null;
const realFetch = ludarr.pdeps.fetch, realLog = ludarr.pdeps.log;
afterAll(() => { ludarr.pdeps.fetch = realFetch; ludarr.pdeps.log = realLog; });
beforeEach(() => {
  wipe(); shelf = []; adds = null;
  kv.set("cfg.LUDARR_URL", "http://engine:7979"); kv.set("cfg.LUDARR_API_KEY", "k3y");
  ludarr.pdeps.log = () => {};
  ludarr.pdeps.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url instanceof Request ? url.url : url)).pathname, method = init?.method ?? "GET";
    const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
    const one = /^\/api\/v1\/game\/(\d+)(\/search)?$/.exec(path), i = one ? shelf.findIndex(g => g.id === Number(one[1])) : -1;
    if (method === "GET" && path === "/api/v1/game") return json({ items: shelf });
    if (method === "POST" && path === "/api/v1/game" && adds) { const have = shelf.find(g => g.id === adds!.id); if (!have) shelf.push(adds); return json({ item: have ?? adds }, 201); }
    if (method === "POST" && one?.[2] && i >= 0) return json({ request: { id: 900 + shelf[i]!.id, state: "requested" }, duplicate: false }, 201);
    if (method === "PUT" && one && i >= 0) { shelf[i] = { ...shelf[i]!, ...JSON.parse(String(init?.body ?? "{}")) }; return json({ item: shelf[i] }); }
    if (method === "DELETE" && one && i >= 0) { shelf.splice(i, 1); return json({ deleted: Number(one[1]) }); }
    if (method === "DELETE" && path.startsWith("/api/v1/queue/")) return json({ ok: true });
    return json({ error: "no such endpoint" }, 404);
  }) as typeof fetch;
});

const nowS = () => Math.floor(Date.now() / 1000);
const from = (pc: string) => ({ "x-ahoy-pc": encodeURIComponent(pc) });
/** this PC's launcher shows the page, signed in */
const here = (token: string, device: string, more: Record<string, unknown> = {}) => http("PUT", "/api/v1/me/pc", { device, version: "0.13.0", freeBytes: 500e9, ...more }, token);
const orders = async (token: string, device?: string) => (await http("GET", `/api/v1/me/orders${device ? `?device=${encodeURIComponent(device)}` : ""}`, undefined, token)).json.items as { id: number; device: string; gameId: number; origin: string; state: string; progress: number; error: string | null; from: string | null; name: string | null }[];
const pcs = async (token: string) => (await http("GET", "/api/v1/me/pcs", undefined, token)).json.items as { device: string; version: string | null; auto: boolean; freeBytes: number | null; on: boolean; games: number }[];
const available = (id: number, name: string) => game(id, name, { status: "available", hasFile: true, file: { id: id * 10, path: "", size: 1e9, version: "1.0", launch: null, files: 3, importer: null, release: null, group: null, format: "folder", addedAt: nowS() } as LudarrGame["file"] });

describe("your PCs", () => {
  test("a PC is known once its launcher says it is there: its name, version and room; a browser is no PC", async () => {
    const a = await signup("yam");
    expect(await pcs(a.token)).toEqual([]);
    const r = await here(a.token, "DESK");
    expect(r.status).toBe(200);
    expect(r.json.pc).toMatchObject({ device: "DESK", version: "0.13.0", auto: true, freeBytes: 500e9, on: true, games: 0 });
    expect(r.json.orders).toEqual([]);
    await http("POST", "/api/v1/me/heartbeat", { device: "browser" }, a.token);
    expect((await pcs(a.token)).map(p => p.device)).toEqual(["DESK"]);
    expect((await http("PUT", "/api/v1/me/pc", { device: "   " }, a.token)).status).toBe(400);
    expect((await http("PUT", "/api/v1/me/pc", {}, a.token)).status).toBe(400);
  });
  test("it is on while it keeps saying so, and counts the games on it", async () => {
    const a = await signup("yam");
    await here(a.token, "DESK"); await here(a.token, "COUCH");
    db.query("UPDATE pcs SET seen_at = unixepoch() - 600").run();
    expect((await pcs(a.token)).map(p => [p.device, p.on])).toEqual([["COUCH", false], ["DESK", false]]);
    await http("POST", "/api/v1/me/heartbeat", { device: "COUCH" }, a.token);
    expect((await pcs(a.token)).map(p => [p.device, p.on])).toEqual([["COUCH", true], ["DESK", false]]);
    await http("PUT", "/api/v1/me/installed", { device: "DESK", items: [{ slug: "hades", gameId: 7, packageId: 70, name: "Hades", sizeBytes: 100, installedAt: Date.now() }] }, a.token);
    expect((await pcs(a.token)).find(p => p.device === "DESK")!.games).toBe(1);
    // saying it again keeps what was not said again
    await http("PUT", "/api/v1/me/pc", { device: "DESK" }, a.token);
    expect((await pcs(a.token)).find(p => p.device === "DESK")).toMatchObject({ version: "0.13.0", freeBytes: 500e9 });
  });
  test("they are one person's own: nobody else sees, changes or orders onto them", async () => {
    const a = await signup("yam"), b = await signup("mika");
    setLibrary([available(7, "Hades")]);
    await here(a.token, "DESK");
    expect(await pcs(b.token)).toEqual([]);
    expect((await http("PUT", "/api/v1/me/pcs/DESK", { auto: false }, b.token)).status).toBe(404);
    expect((await http("POST", "/api/v1/me/orders", { device: "DESK", gameId: 7 }, b.token)).status).toBe(404);
    const mine = (await http("POST", "/api/v1/me/orders", { device: "DESK", gameId: 7 }, a.token)).json.item;
    expect(await orders(b.token)).toEqual([]);
    expect((await http("PUT", `/api/v1/me/orders/${mine.id}`, { state: "done" }, b.token, from("DESK"))).status).toBe(404);
    expect((await http("DELETE", `/api/v1/me/orders/${mine.id}`, undefined, b.token)).json.ok).toBe(false);
    expect((await orders(a.token)).map(o => o.state)).toEqual(["waiting"]);
    expect((await http("GET", "/api/v1/me/pcs")).status).toBe(401);
  });
  test("forgetting a PC takes what was on it and what waited for it", async () => {
    const a = await signup("yam");
    setLibrary([available(7, "Hades")]);
    await here(a.token, "DESK"); await here(a.token, "OLD");
    await http("PUT", "/api/v1/me/installed", { device: "OLD", items: [{ slug: "celeste", gameId: 8, packageId: 80, name: "Celeste", sizeBytes: 100, installedAt: Date.now() }] }, a.token);
    await http("POST", "/api/v1/me/orders", { device: "OLD", gameId: 7 }, a.token);
    expect((await http("DELETE", "/api/v1/me/pcs/OLD", undefined, a.token)).json.ok).toBe(true);
    expect((await pcs(a.token)).map(p => p.device)).toEqual(["DESK"]);
    expect(await orders(a.token)).toEqual([]);
    expect((await http("GET", "/api/v1/me/installed", undefined, a.token)).json.items).toEqual([]);
  });
});

describe("install on a PC", () => {
  test("placed from anywhere, it waits for that PC; placing it twice is one order", async () => {
    const a = await signup("yam");
    setLibrary([available(7, "Hades")]);
    await here(a.token, "DESK"); await here(a.token, "COUCH");
    const first = await http("POST", "/api/v1/me/orders", { device: "COUCH", gameId: 7 }, a.token, from("DESK"));
    expect(first.status).toBe(201);
    expect(first.json.item).toMatchObject({ device: "COUCH", gameId: 7, name: "Hades", origin: "asked", state: "waiting", from: "DESK" });
    const again = await http("POST", "/api/v1/me/orders", { device: "COUCH", gameId: 7 }, a.token);
    expect(again.json.item.id).toBe(first.json.item.id);
    expect(await orders(a.token)).toHaveLength(1);
    // the PC hears of it the moment its page says it is there, and by asking for its own
    expect((await here(a.token, "COUCH")).json.orders.map((o: { gameId: number }) => o.gameId)).toEqual([7]);
    expect(await orders(a.token, "DESK")).toEqual([]);
    expect((await http("POST", "/api/v1/me/orders", { device: "COUCH", gameId: 99 }, a.token)).status).toBe(404);   // no such game
    expect((await http("POST", "/api/v1/me/orders", { device: "NOPE", gameId: 7 }, a.token)).status).toBe(404);    // no such PC
  });
  test("the PC that carries it out says how it goes; no other PC does, and an ended order stays as it ended", async () => {
    const a = await signup("yam");
    setLibrary([available(7, "Hades")]);
    await here(a.token, "DESK"); await here(a.token, "COUCH");
    const o = (await http("POST", "/api/v1/me/orders", { device: "COUCH", gameId: 7 }, a.token)).json.item;
    expect((await http("PUT", `/api/v1/me/orders/${o.id}`, { state: "installing", progress: 0.2 }, a.token, from("DESK"))).status).toBe(403);
    expect((await http("PUT", `/api/v1/me/orders/${o.id}`, { state: "installing", progress: 0.2 }, a.token)).status).toBe(403);
    expect((await http("PUT", `/api/v1/me/orders/${o.id}`, { state: "installing", progress: 0.48 }, a.token, from("COUCH"))).json.item).toMatchObject({ state: "installing", progress: 0.48 });
    expect((await http("PUT", `/api/v1/me/orders/${o.id}`, { state: "installing", progress: 7 }, a.token, from("COUCH"))).json.item.progress).toBe(1);
    // stopped on that PC before it finished (the launcher was closed): it waits again
    expect((await http("PUT", `/api/v1/me/orders/${o.id}`, { state: "waiting" }, a.token, from("COUCH"))).json.item).toMatchObject({ state: "waiting", progress: 0 });
    expect((await http("PUT", `/api/v1/me/orders/${o.id}`, { state: "done" }, a.token, from("COUCH"))).json.item).toMatchObject({ state: "done", progress: 1, error: null });
    expect((await http("PUT", `/api/v1/me/orders/${o.id}`, { state: "failed", error: "late" }, a.token, from("COUCH"))).json.item.state).toBe("done");
    expect((await http("PUT", "/api/v1/me/orders/9999", { state: "done" }, a.token, from("COUCH"))).status).toBe(404);
  });
  test("one that failed says why, and asking again starts afresh", async () => {
    const a = await signup("yam");
    setLibrary([available(7, "Hades")]);
    await here(a.token, "COUCH");
    const o = (await http("POST", "/api/v1/me/orders", { device: "COUCH", gameId: 7 }, a.token)).json.item;
    const failed = (await http("PUT", `/api/v1/me/orders/${o.id}`, { state: "failed", error: "Not enough room\non COUCH" }, a.token, from("COUCH"))).json.item;
    expect(failed).toMatchObject({ state: "failed", error: "Not enough room on COUCH" });
    const again = (await http("POST", "/api/v1/me/orders", { device: "COUCH", gameId: 7 }, a.token)).json.item;
    expect(again.id).not.toBe(o.id);
    expect((await orders(a.token)).map(x => [x.id, x.state])).toEqual([[again.id, "waiting"]]);
  });
  test("cancelling takes it away; a finished one stays listed for a day, a failed one for a week", async () => {
    const a = await signup("yam");
    setLibrary([available(7, "Hades"), available(8, "Celeste"), available(9, "Tunic")]);
    await here(a.token, "COUCH");
    const place = async (gameId: number) => (await http("POST", "/api/v1/me/orders", { device: "COUCH", gameId }, a.token)).json.item.id as number;
    const [x, y, z] = [await place(7), await place(8), await place(9)];
    expect((await http("DELETE", `/api/v1/me/orders/${x}`, undefined, a.token)).json.ok).toBe(true);
    await http("PUT", `/api/v1/me/orders/${y}`, { state: "done" }, a.token, from("COUCH"));
    await http("PUT", `/api/v1/me/orders/${z}`, { state: "failed", error: "no" }, a.token, from("COUCH"));
    expect((await orders(a.token)).map(o => o.gameId)).toEqual([9, 8]);
    db.query("UPDATE orders SET updated_at = unixepoch() - 2 * 86400").run();
    expect((await orders(a.token)).map(o => o.gameId)).toEqual([9]);
    db.query("UPDATE orders SET updated_at = unixepoch() - 8 * 86400").run();
    expect(await orders(a.token)).toEqual([]);
  });
  test("an order is news for its person only", async () => {
    const a = await signup("yam"), b = await signup("mika");
    setLibrary([available(7, "Hades")]);
    await here(a.token, "COUCH");
    const seen: AhoyEvent[] = [];
    const off = events.subscribe(e => { if (e.event === "order" || e.event === "pc") seen.push(e); });
    try {
      await http("POST", "/api/v1/me/orders", { device: "COUCH", gameId: 7 }, a.token);
      await here(b.token, "LAPTOP");
    } finally { off(); }
    expect(seen.map(e => [e.event, e.to])).toEqual([["order", a.user.id], ["pc", b.user.id]]);
  });
});

describe("a game asked for is installed when it arrives", () => {
  test("asked from a PC: that PC installs it, not the others", async () => {
    const a = await signup("yam");
    await here(a.token, "DESK"); await here(a.token, "COUCH");
    adds = game(43, "Hades", { addedAt: nowS() });
    expect((await http("POST", "/api/v1/game", { source: "steam", id: 1145360 }, a.token, from("DESK"))).status).toBe(201);
    expect((await orders(a.token)).map(o => [o.device, o.gameId, o.origin, o.state, o.from])).toEqual([["DESK", 43, "wanted", "waiting", "DESK"]]);
  });
  test("asked from a phone: every PC of theirs that installs what they ask for", async () => {
    const a = await signup("yam"), b = await signup("mika");
    await here(a.token, "DESK"); await here(a.token, "COUCH"); await here(a.token, "LAPTOP"); await here(b.token, "MIKAS");
    expect((await http("PUT", "/api/v1/me/pcs/LAPTOP", { auto: false }, a.token)).json.pc.auto).toBe(false);
    adds = game(43, "Hades", { addedAt: nowS() });
    await http("POST", "/api/v1/game", { source: "steam", id: 1145360 }, a.token);
    expect((await orders(a.token)).map(o => o.device).sort()).toEqual(["COUCH", "DESK"]);
    expect(await orders(b.token)).toEqual([]);
  });
  test("not on a PC whose setting says no, not for Track, and not for a game that is there already", async () => {
    const a = await signup("yam");
    await here(a.token, "DESK");
    await http("PUT", "/api/v1/me/pcs/DESK", { auto: false }, a.token);
    adds = game(43, "Hades", { addedAt: nowS() });
    await http("POST", "/api/v1/game", { source: "steam", id: 1145360 }, a.token, from("DESK"));
    expect(await orders(a.token)).toEqual([]);
    await http("PUT", "/api/v1/me/pcs/DESK", { auto: true }, a.token);
    adds = game(44, "Silksong", { addedAt: nowS(), comingSoon: true });
    await http("POST", "/api/v1/game", { source: "steam", id: 1030300, searchNow: false }, a.token, from("DESK"));
    expect(await orders(a.token)).toEqual([]);
    // looking again for a game that has a copy is for a better copy: Install is the action for the one that is there
    shelf.push(available(7, "Celeste"));
    await ludarr.refreshLibrary();
    expect((await http("POST", "/api/v1/game/7/search", undefined, a.token, from("DESK"))).status).toBe(200);
    expect(await orders(a.token)).toEqual([]);
    // looking for one that has none is asking for it
    expect((await http("POST", "/api/v1/game/43/search", undefined, a.token, from("DESK"))).status).toBe(200);
    expect((await orders(a.token)).map(o => [o.device, o.gameId, o.origin])).toEqual([["DESK", 43, "wanted"]]);
  });
  test("not on a PC that has the game", async () => {
    const a = await signup("yam");
    await here(a.token, "DESK"); await here(a.token, "COUCH");
    shelf.push(game(43, "Hades", { addedAt: nowS() }));
    await ludarr.refreshLibrary();
    await http("PUT", "/api/v1/me/installed", { device: "DESK", items: [{ slug: "hades", gameId: 43, packageId: 3, name: "Hades", sizeBytes: 100, installedAt: Date.now() }] }, a.token);
    await http("POST", "/api/v1/game/43/search", undefined, a.token);
    expect((await orders(a.token)).map(o => o.device)).toEqual(["COUCH"]);
  });
  test("cancelling the search ends the waiting it started; an order placed by hand stays", async () => {
    const a = await signup("yam");
    await here(a.token, "DESK"); await here(a.token, "COUCH");
    adds = game(43, "Hades", { addedAt: nowS(), request: { id: 943, gameId: 43, state: "requested", stage: null, progress: 0, message: null, attempt: 1, candidates: 0, createdAt: nowS(), updatedAt: nowS(), doneAt: null, release: null } as LudarrGame["request"] });
    await http("POST", "/api/v1/game", { source: "steam", id: 1145360 }, a.token, from("DESK"));
    await http("POST", "/api/v1/me/orders", { device: "COUCH", gameId: 43 }, a.token);
    // the one that waited because the game was asked for is asked for by hand now: it is its own wish
    await http("POST", "/api/v1/me/orders", { device: "DESK", gameId: 43 }, a.token);
    expect((await orders(a.token)).map(o => [o.device, o.origin]).sort()).toEqual([["COUCH", "asked"], ["DESK", "asked"]]);
    await http("DELETE", `/api/v1/me/orders/${(await orders(a.token, "DESK"))[0]!.id}`, undefined, a.token);
    await http("POST", "/api/v1/game/43/search", undefined, a.token, from("DESK"));
    expect((await orders(a.token)).map(o => [o.device, o.origin]).sort()).toEqual([["COUCH", "asked"], ["DESK", "wanted"]]);
    // an admin (the first account) cancelling: the game leaves the server (they brought it), and nothing of it waits
    expect((await http("DELETE", "/api/v1/queue/943", undefined, a.token)).json).toMatchObject({ ok: true, removed: true });
    expect(await orders(a.token)).toEqual([]);
  });
  test("a member's cancel ends their own waiting, not someone else's", async () => {
    const admin = await signup("skipper"), a = await signup("anne"), b = await signup("bart");
    void admin;
    await here(a.token, "ANNES"); await here(b.token, "BARTS");
    adds = game(43, "Hades", { addedAt: nowS(), request: { id: 943, gameId: 43, state: "requested", stage: null, progress: 0, message: null, attempt: 1, candidates: 0, createdAt: nowS(), updatedAt: nowS(), doneAt: null, release: null } as LudarrGame["request"] });
    await http("POST", "/api/v1/game", { source: "steam", id: 1145360 }, a.token, from("ANNES"));
    await http("POST", "/api/v1/game", { source: "steam", id: 1145360 }, b.token, from("BARTS"));
    expect((await orders(a.token)).length + (await orders(b.token)).length).toBe(2);
    expect((await http("DELETE", "/api/v1/queue/943", undefined, a.token)).json).toMatchObject({ ok: true, removed: false });
    expect(await orders(a.token)).toEqual([]);
    expect((await orders(b.token)).map(o => o.device)).toEqual(["BARTS"]);
  });
  test("turning the setting off ends what waited because of it", async () => {
    const a = await signup("yam");
    await here(a.token, "DESK");
    adds = game(43, "Hades", { addedAt: nowS() });
    await http("POST", "/api/v1/game", { source: "steam", id: 1145360 }, a.token, from("DESK"));
    shelf.push(available(7, "Celeste"));
    await ludarr.refreshLibrary();
    await http("POST", "/api/v1/me/orders", { device: "DESK", gameId: 7 }, a.token);
    await http("PUT", "/api/v1/me/pcs/DESK", { auto: false }, a.token);
    expect((await orders(a.token)).map(o => [o.gameId, o.origin])).toEqual([[7, "asked"]]);
  });
});

describe("a game that left the server", () => {
  test("removed here: nothing of it waits; removed in the engine: the same, once the library was read", async () => {
    const a = await signup("yam");
    shelf.push(available(7, "Hades"), available(8, "Celeste"));
    await ludarr.refreshLibrary();
    await here(a.token, "DESK");
    await http("POST", "/api/v1/me/orders", { device: "DESK", gameId: 7 }, a.token);
    await http("POST", "/api/v1/me/orders", { device: "DESK", gameId: 8 }, a.token);
    expect((await http("DELETE", "/api/v1/game/7?deleteFiles=1", undefined, a.token)).status).toBe(200);
    expect((await orders(a.token)).map(o => o.gameId)).toEqual([8]);
    dropOrphanOrders(new Set([7]));
    expect(await orders(a.token)).toEqual([]);
  });
});

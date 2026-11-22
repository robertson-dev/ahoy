import { beforeEach, describe, expect, test } from "bun:test";
import { game, http, setLibrary, signup, wipe } from "./helpers";
import { Database } from "bun:sqlite";
import { platformDeps, platformRequest } from "../src/platform-catalog";
import { kv } from "../src/db";
import { recentLogs } from "../src/log";
import * as ludarr from "../src/ludarr";

/** a fake ludarr: records every call, answers from a table */
let calls: { method: string; path: string; body: any; headers: Record<string, string> }[] = [];
let answers: Record<string, (body: any) => { status?: number; json?: unknown; body?: BodyInit; headers?: Record<string, string> }> = {};
beforeEach(() => {
  wipe(); calls = []; answers = {};
  kv.set("cfg.LUDARR_URL", "http://engine:7979"); kv.set("cfg.LUDARR_API_KEY", "k3y");
  ludarr.pdeps.log = () => {};
  ludarr.pdeps.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    const path = u.replace("http://engine:7979", "");
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? "GET", path, body, headers });
    const a = answers[`${init?.method ?? "GET"} ${path.split("?")[0]}`];
    if (!a) return new Response(JSON.stringify({ error: "no such endpoint" }), { status: 404, headers: { "content-type": "application/json" } });
    const r = a(body);
    return new Response(r.body ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
});

describe("the library through ludarr", () => {
  test("Discover searches the whole platform before paging, including titles outside Ludarr", async () => {
    const { token } = await signup("player");
    const previous = platformDeps.catalog;
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE platforms(id, label); CREATE TABLE games(id INTEGER PRIMARY KEY, platform, name, year, summary, votes, steam, cover); CREATE TABLE names(game, text)");
      db.exec("INSERT INTO platforms VALUES('switch','Nintendo Switch'),('ps5','PlayStation 5')");
      for (let i = 1; i <= 52; i++) {
        const name = i > 49 ? "Zelda" : "Game " + i;
        db.query("INSERT INTO games VALUES(?,?,?,?,?,?,null,null)").run(i, i === 52 ? "ps5" : "switch", name, 2020, "", 100-i);
        db.query("INSERT INTO names VALUES(?,?)").run(i, name.toLowerCase());
      }
      platformDeps.catalog = async () => db;
      const get = (path: string) => http("GET", "/api/v1/discover/" + path, undefined, token);
      expect((await get("platforms")).json.items).toContainEqual({id: "switch", label: "Nintendo Switch", count: 51});
      expect((await get("platform/switch?page=2")).json.items).toHaveLength(3);
      const filtered = (await get("platform/switch?q=zelda")).json;
      expect(filtered.total).toBe(2);
      expect(filtered.items.map((x: ludarr.LookupHit) => x.platforms)).toEqual([["switch"], ["switch"]]);
      expect((await get("platform/all?q=zelda")).json.total).toBe(3);
      expect((await get("platform/switch?q=missing")).json.total).toBe(0);
      expect((await get("platform/switch?page=-1")).status).toBe(400);
      answers["GET /api/v1/game/lookup"] = () => ({json:{items:[]}});
      expect(await platformRequest("50", "switch")).toMatchObject({source:"manual", platform:"switch", game:{name:"Zelda", platforms:["switch"]}});
      await expect(platformRequest("50", "ps5")).rejects.toThrow();
    } finally { platformDeps.catalog = previous; db.close(); }
  });
  test("the snapshot answers at once; a refresh reads ludarr with the key and remembers it; an outage keeps the old copy", async () => {
    const a = await signup("yam");
    answers["GET /api/v1/game"] = () => ({ json: { items: [game(1, "Hades", { steamAppId: 1145360 }), game(2, "Celeste")] } });
    await ludarr.refreshLibrary();
    expect(calls[0].headers["X-Api-Key"]).toBe("k3y");
    const r = await http("GET", "/api/v1/game", undefined, a.token);
    expect(r.json.items.map((g: { name: string }) => g.name)).toEqual(["Hades", "Celeste"]);
    expect(r.json.items[0].people).toEqual({ requestedBy: [], owners: [], playing: [] });
    expect(r.json.status.stale).toBe(false);
    answers = {};
    await ludarr.refreshLibrary();
    expect((await http("GET", "/api/v1/game", undefined, a.token)).json.items.length).toBe(2);
    expect(ludarr.libraryStatus().error).toContain("no such endpoint");
  });
  test("Get it adds the game on ludarr and books who asked; Track passes searchNow=false", async () => {
    const a = await signup("yam");
    answers["POST /api/v1/game"] = body => ({ status: 201, json: { item: game(9, "Silksong", { steamAppId: 1030300, comingSoon: body.searchNow === false }) } });
    answers["GET /api/v1/game"] = () => ({ json: { items: [game(9, "Silksong", { steamAppId: 1030300 })] } });
    const r = await http("POST", "/api/v1/game", { source: "steam", id: 1030300, searchNow: true }, a.token);
    expect(r.status).toBe(201);
    expect(calls.find(c => c.method === "POST")!.body).toEqual({ source: "steam", id: "1030300", monitored: true, searchNow: true });
    expect(r.json.item.people.requestedBy[0]).toMatchObject({ user: { name: "yam" }, kind: "get" });
    const feed = (await http("GET", "/api/v1/activity?only=mine", undefined, a.token)).json.items as { kind: string; name: string }[];
    expect(feed[0]).toMatchObject({ kind: "requested", name: "Silksong" });
    calls = [];
    const t = await http("POST", "/api/v1/game", { source: "steam", id: 1030300, searchNow: false }, a.token);
    expect(calls[0].body.searchNow).toBe(false);
    expect(t.json.item.people.requestedBy[0].kind).toBe("track");
  });
  test("a failure reads in members' words: the engine's own text (its name, sources, HTTP codes) stays in the log", async () => {
    const a = await signup("yam");
    answers["POST /api/v1/game"] = () => ({ status: 404, json: { error: "Steam app 1 was not found" } });
    const r = await http("POST", "/api/v1/game", { source: "steam", id: 1 }, a.token);
    expect(r.status).toBe(404); expect(r.json.error).toBe("That game couldn't be found");
    answers["POST /api/v1/game/1/search"] = () => ({ status: 409, json: { error: 'Hades already has a copy and upgrades are off in the "Any" profile' } });
    const dup = await http("POST", "/api/v1/game/1/search", undefined, a.token);
    expect(dup.status).toBe(409); expect(dup.json.error).toBe("That's already on its way or on your server");
    answers["PUT /api/v1/game/1"] = () => ({ status: 500, body: "<html>oops</html>" });
    const down = await http("PUT", "/api/v1/game/1", { monitored: true }, a.token);
    expect(down.status).toBe(502); expect(down.json.error).toBe("Your server didn't answer. Try again in a moment");
    kv.del("cfg.LUDARR_URL");
    const n = await http("POST", "/api/v1/game/1/search", undefined, a.token);
    expect(n.status).toBe(503); expect(n.json.error).toBe("Your server isn't ready for that yet");
    for (const x of [r, dup, down, n]) expect(JSON.stringify(x.json)).not.toMatch(/ludarr|engine|HTTP \d|Steam app|profile/i);
  });
  test("tracking is each person's own: stopping drops only your want, and the engine stops once nobody wants the game", async () => {
    const k = await signup("kay"), p = await signup("pell");
    let monitored = true;
    const needle = () => game(38, "Find The Needle", { status: monitored ? "unreleased" : "unmonitored", comingSoon: true, monitored, tracked: monitored, request: null });
    answers["PUT /api/v1/game/38"] = body => { monitored = !!body.monitored; return { json: { item: needle() } }; };
    answers["GET /api/v1/game"] = () => ({ json: { items: [needle()] } });
    await ludarr.refreshLibrary();
    const names = (x: { json: { item: { people: { requestedBy: { user: { name: string } }[] } } } }) => x.json.item.people.requestedBy.map(w => w.user.name);
    expect(names(await http("PUT", "/api/v1/game/38", { monitored: true }, p.token))).toEqual(["pell"]);
    const both = await http("PUT", "/api/v1/game/38", { monitored: true }, k.token);
    expect(names(both)).toEqual(["pell", "kay"]);
    expect(both.json.item.people.requestedBy.map((w: { kind: string }) => w.kind)).toEqual(["track", "track"]);
    calls = [];
    // K stops: K's want goes; Pell still tracks it, so the engine keeps watching for its release
    const kOff = await http("PUT", "/api/v1/game/38", { monitored: false }, k.token);
    expect(kOff.status).toBe(200);
    expect(calls.filter(c => c.method === "PUT")).toEqual([]);
    expect(kOff.json.item.monitored).toBe(true);
    expect(names(kOff)).toEqual(["pell"]);
    // Pell stops too: nobody wants it now, and the engine stops
    const pOff = await http("PUT", "/api/v1/game/38", { monitored: false }, p.token);
    expect(calls.filter(c => c.method === "PUT").map(c => c.body)).toEqual([{ monitored: false }]);
    expect(pOff.json.item.monitored).toBe(false);
    expect(names(pOff)).toEqual([]);
  });
  test("removing: the one who asked may, another member may not, an admin always may", async () => {
    const admin = await signup("yam"), m = await signup("mika"), other = await signup("zed");
    const fresh = () => game(5, "Hades", { addedAt: Math.floor(Date.now() / 1000) });      // the engine added it just now
    let there = false;
    answers["POST /api/v1/game"] = () => { there = true; return { status: 201, json: { item: fresh() } }; };
    answers["GET /api/v1/game"] = () => ({ json: { items: there ? [fresh()] : [] } });
    answers["DELETE /api/v1/game/5"] = () => { there = false; return { json: { deleted: 5 } }; };
    await http("POST", "/api/v1/game", { source: "steam", id: 1145360 }, m.token);
    expect((await http("DELETE", "/api/v1/game/5", undefined, other.token)).status).toBe(403);
    expect((await http("DELETE", "/api/v1/game/5", undefined, m.token)).status).toBe(200);
    await http("POST", "/api/v1/game", { source: "steam", id: 1145360 }, m.token);
    expect((await http("DELETE", "/api/v1/game/5?deleteFiles=1", undefined, admin.token)).status).toBe(200);
    expect(calls.filter(c => c.method === "DELETE").map(c => c.path)).toEqual(["/api/v1/game/5?deleteFiles=0", "/api/v1/game/5?deleteFiles=1"]);
  });
  test("package files stream through with the Range header and without the key reaching the client", async () => {
    const a = await signup("yam");
    answers["GET /api/v1/package/3"] = () => ({ json: { item: { id: 3, manifest: { slug: "hades", files: [] } } } });
    answers["GET /api/v1/package/3/files/hades/game.exe"] = () => ({ status: 206, body: "bytes!", headers: { "content-type": "application/octet-stream", "content-range": "bytes 0-5/100", "content-length": "6" } });
    expect((await http("GET", "/api/v1/package/3", undefined, a.token)).json.item.manifest.slug).toBe("hades");
    const r = await http("GET", "/api/v1/package/3/files/hades/game.exe", undefined, a.token, { range: "bytes=0-5" });
    expect(r.status).toBe(206); expect(r.json).toBe("bytes!");
    expect(r.headers.get("content-range")).toBe("bytes 0-5/100");
    const up = calls.find(c => c.path.endsWith("game.exe"))!;
    expect(up.headers.range).toBe("bytes=0-5"); expect(up.headers["X-Api-Key"]).toBe("k3y");
    expect((await http("GET", "/api/v1/package/3/files/hades/game.exe")).status).toBe(401);
  });
  test("the setup page's shelf needs no session and names nothing but ids", async () => {
    setLibrary([game(1, "Hades", { status: "available", file: { id: 1, path: "", size: 1, version: null, launch: null, files: 1, importer: null, release: null, group: null, format: "x", addedAt: 5 } }), game(2, "Celeste")]);
    const r = await http("GET", "/api/v1/shelf");
    expect(r.status).toBe(200); expect(r.json.items).toEqual([{ id: 1 }]);
  });
});

describe("games the admin made, and what the launcher gets", () => {
  test("a game nobody asked for (added by hand, a way built for it) is the admin's to remove", async () => {
    const admin = await signup("yam"), m = await signup("mika");
    answers["GET /api/v1/game"] = () => ({ json: { items: [game(6, "Dinosaur Planet")] } });
    answers["DELETE /api/v1/game/6"] = () => ({ json: { deleted: 6 } });
    await ludarr.refreshLibrary();
    expect((await http("DELETE", "/api/v1/game/6?deleteFiles=1", undefined, m.token)).status).toBe(403);
    expect(calls.filter(c => c.method === "DELETE")).toEqual([]);
    expect((await http("DELETE", "/api/v1/game/6", undefined, admin.token)).status).toBe(200);
  });
  test("a package reaches the launcher without where it sits on the server, its release, how it was made or the admin's notes", async () => {
    const a = await signup("yam");
    answers["GET /api/v1/package/4"] = () => ({ json: { item: { id: 4, gameId: 6, jobId: 9, path: "/library/zelda-64", name: "Zelda", version: "1.2.2", size: 10, createdAt: 1,
      manifest: { schema: 1, slug: "zelda-64", files: [{ path: "z.exe", size: 1, sha256: "a" }], launch: { exe: "z.exe", args: "", cwd: "", argv: ["--rom", "{install}/rom.z64"] }, kind: "recomp", requires: { launcher: "0.10.0" }, keep: ["saves/**"], seed: [],
        source: { title: "Zelda", group: "TENOKE", protocol: "way", indexer: null }, notes: "the AI read main.cpp:353", tier: "agent", runtime: { repo: "Zelda64Recomp/Zelda64Recomp" } } } } });
    const item = (await http("GET", "/api/v1/package/4", undefined, a.token)).json.item;
    expect(item.path).toBe("");
    expect(item.manifest).toMatchObject({ slug: "zelda-64", kind: "recomp", requires: { launcher: "0.10.0" }, keep: ["saves/**"], launch: { argv: ["--rom", "{install}/rom.z64"] } });
    for (const k of ["source", "notes", "tier", "runtime"]) expect(k in item.manifest).toBe(false);
    expect(JSON.stringify(item)).not.toMatch(/Zelda64Recomp\/|TENOKE|main\.cpp|library\//);
  });
  test("how a package starts now reaches the launcher live, behind the session, with the start, its stamp, what it needs and its kind only", async () => {
    const a = await signup("yam");
    const start = { exe: "KytyLauncher.exe", args: "--play", cwd: "", argv: ["--play"], rev: 1731170000000 };
    let launch: Record<string, unknown> = start;
    answers["GET /api/v1/package/43/launch"] = () => ({ json: { launch, rev: launch.rev ?? null, requires: { launcher: "0.10.0" }, kind: "emulated", path: "/library/demons-souls", notes: "the AI read README.md:106", by: "hand" } });
    const r = await http("GET", "/api/v1/package/43/launch", undefined, a.token);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ launch: start, rev: 1731170000000, requires: { launcher: "0.10.0" }, kind: "emulated" });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/package/43/launch" });
    expect(calls[0].headers["X-Api-Key"]).toBe("k3y");
    expect(JSON.stringify(r.json)).not.toMatch(/k3y|library\/|README|hand/);
    // live: the admin's next change is what the next Play hears
    launch = { exe: "kyty_emulator.exe", args: "", cwd: "{install}", argv: ["--game", "{install}/game/x.zar"], rev: 1731170099999 };
    expect((await http("GET", "/api/v1/package/43/launch", undefined, a.token)).json).toMatchObject({ launch: { exe: "kyty_emulator.exe" }, rev: 1731170099999 });
    expect(calls).toHaveLength(2);
    // no session: refused before the engine is asked
    expect((await http("GET", "/api/v1/package/43/launch")).status).toBe(401);
    expect(calls).toHaveLength(2);
  });
  test("the start's answer reads ludarr either way (under item, the stamp only in the launch), and a package that is gone is a plain 404", async () => {
    const a = await signup("yam");
    answers["GET /api/v1/package/5/launch"] = () => ({ json: { item: { launch: { exe: "Game.exe", args: "", cwd: "", rev: 7 } } } });
    expect((await http("GET", "/api/v1/package/5/launch", undefined, a.token)).json).toEqual({ launch: { exe: "Game.exe", args: "", cwd: "", rev: 7 }, rev: 7, requires: null, kind: null });
    answers["GET /api/v1/package/6/launch"] = () => ({ json: { launch: "Game.exe" } });
    expect((await http("GET", "/api/v1/package/6/launch", undefined, a.token)).json).toEqual({ launch: null, rev: null, requires: null, kind: null });
    answers["GET /api/v1/package/8/launch"] = () => ({ status: 404, json: { error: "package 8 not found" } });
    const gone = await http("GET", "/api/v1/package/8/launch", undefined, a.token);
    expect(gone.status).toBe(404);
    expect(JSON.stringify(gone.json)).not.toMatch(/ludarr|engine|package 8/i);
    // a replaced copy is asked about at every Play: no log line for it; an engine that does not answer is logged
    const logged = (path: string) => recentLogs({ logger: "Library", level: "warn" }).some(l => l.message.includes(path));
    expect(logged("/api/v1/package/8/launch")).toBe(false);
    ludarr.pdeps.fetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
    expect((await http("GET", "/api/v1/package/9/launch", undefined, a.token)).status).toBe(502);
    expect(logged("/api/v1/package/9/launch")).toBe(true);
  });
});

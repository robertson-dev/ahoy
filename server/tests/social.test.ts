import { beforeEach, describe, expect, test } from "bun:test";
import { game, http, setLibrary, signup, wipe } from "./helpers";
import { db } from "../src/db";

beforeEach(() => wipe());

describe("friends", () => {
  test("ask → pending both ways → accept → friends; unfriend clears it", async () => {
    const a = await signup("yam"), b = await signup("mika");
    expect((await http("POST", `/api/v1/friends/${b.user.id}`, undefined, a.token)).json.state).toBe("pending_out");
    expect((await http("GET", "/api/v1/friends", undefined, a.token)).json.outgoing.map((x: { name: string }) => x.name)).toEqual(["mika"]);
    expect((await http("GET", "/api/v1/friends", undefined, b.token)).json.incoming.map((x: { name: string }) => x.name)).toEqual(["yam"]);
    expect((await http("POST", `/api/v1/friends/${b.user.id}`, undefined, a.token)).json.state).toBe("pending_out");   // asking twice changes nothing
    expect((await http("POST", `/api/v1/friends/${a.user.id}`, undefined, b.token)).json.state).toBe("friends");
    const people = (await http("GET", "/api/v1/people", undefined, a.token)).json.items as { name: string; friend: string }[];
    expect(people.find(p => p.name === "mika")!.friend).toBe("friends");
    expect(people.find(p => p.name === "yam")!.friend).toBe("none");
    await http("DELETE", `/api/v1/friends/${b.user.id}`, undefined, a.token);
    expect((await http("GET", "/api/v1/friends", undefined, b.token)).json.friends).toEqual([]);
    expect((await http("POST", `/api/v1/friends/${a.user.id}`, undefined, a.token)).status).toBe(400);   // not yourself
    expect((await http("POST", "/api/v1/friends/999", undefined, a.token)).status).toBe(404);
  });
});

describe("the feed", () => {
  test("joining, asking for a game and installing it show up; friends see each other's lines, strangers do not", async () => {
    const a = await signup("yam"), b = await signup("mika"), c = await signup("stranger");
    await http("POST", `/api/v1/friends/${b.user.id}`, undefined, a.token);
    await http("POST", `/api/v1/friends/${a.user.id}`, undefined, b.token);
    await http("PUT", "/api/v1/me/installed", { device: "DESK", items: [{ slug: "hades", gameId: 7, packageId: 3, appId: 1145360, name: "Hades", sizeBytes: 100, installedAt: Date.now() }] }, b.token);
    const mine = (await http("GET", "/api/v1/activity", undefined, a.token)).json.items as { user: { name: string }; kind: string; name: string | null }[];
    expect(mine.map(i => [i.user.name, i.kind])).toEqual([["mika", "installed"], ["yam", "friends"], ["mika", "friends"], ["mika", "joined"], ["yam", "joined"]]);
    expect(mine[0].name).toBe("Hades");
    const theirs = (await http("GET", "/api/v1/activity", undefined, c.token)).json.items as { user: { name: string } }[];
    expect(theirs.map(i => i.user.name)).toEqual(["stranger"]);
    expect(((await http("GET", "/api/v1/activity?only=all", undefined, c.token)).json.items as unknown[]).length).toBe(6);
  });
  test("the same thing twice in a row is one line; a second PC installing the same game is not news again", async () => {
    const a = await signup("yam");
    const item = { slug: "hades", gameId: 7, packageId: 3, appId: 1145360, name: "Hades", sizeBytes: 100, installedAt: Date.now() };
    await http("PUT", "/api/v1/me/installed", { device: "DESK", items: [item] }, a.token);
    await http("PUT", "/api/v1/me/installed", { device: "LAPTOP", items: [item] }, a.token);
    const items = (await http("GET", "/api/v1/activity?only=mine", undefined, a.token)).json.items as { kind: string }[];
    expect(items.map(i => i.kind)).toEqual(["installed", "joined"]);
    // the list is the whole truth for that PC: what it no longer sends is gone
    await http("PUT", "/api/v1/me/installed", { device: "DESK", items: [] }, a.token);
    const inst = (await http("GET", "/api/v1/me/installed", undefined, a.token)).json.items as { device: string }[];
    expect(inst.map(i => i.device)).toEqual(["LAPTOP"]);
  });
});

describe("presence and play time", () => {
  test("a heartbeat makes you online; playing shows the game to everyone; stopping books the minutes on the install", async () => {
    const a = await signup("yam"), b = await signup("mika");
    expect((await http("GET", "/api/v1/people", undefined, b.token)).json.items.find((p: { name: string }) => p.name === "yam").presence.state).toBe("offline");
    await http("POST", "/api/v1/me/heartbeat", { device: "DESK" }, a.token);
    expect((await http("GET", "/api/v1/people", undefined, b.token)).json.items.find((p: { name: string }) => p.name === "yam").presence.state).toBe("online");
    await http("PUT", "/api/v1/me/installed", { device: "DESK", items: [{ slug: "hades", gameId: 7, packageId: 3, appId: 1145360, name: "Hades", sizeBytes: 100, installedAt: Date.now() }] }, a.token);
    await http("POST", "/api/v1/me/playing", { running: true, gameId: 7, appId: 1145360, name: "Hades", slug: "hades", device: "DESK" }, a.token);
    const p = (await http("GET", "/api/v1/people/yam", undefined, b.token)).json;
    expect(p.presence).toMatchObject({ state: "playing", gameName: "Hades", gameId: 7 });
    expect(p.games[0]).toMatchObject({ name: "Hades", devices: ["DESK"] });
    db.query("UPDATE presence SET since=since-600 WHERE user_id=?").run(a.user.id);                  // ten minutes pass
    await http("POST", "/api/v1/me/playing", { running: false, slug: "hades", device: "DESK" }, a.token);
    const after = (await http("GET", "/api/v1/people/yam", undefined, b.token)).json;
    expect(after.presence.state).toBe("online");
    expect(after.games[0].playSeconds).toBeGreaterThanOrEqual(600);
    expect(after.activity.map((x: { kind: string }) => x.kind)).toEqual(["played", "installed", "joined"]);
    // the library view names who is playing / who has it
    setLibrary([game(7, "Hades", { steamAppId: 1145360, status: "available" })]);
    await http("POST", "/api/v1/me/playing", { running: true, gameId: 7, name: "Hades", slug: "hades", device: "DESK" }, a.token);
    const lib = (await http("GET", "/api/v1/game", undefined, b.token)).json.items[0];
    expect(lib.people.owners.map((u: { name: string }) => u.name)).toEqual(["yam"]);
    expect(lib.people.playing.map((u: { name: string }) => u.name)).toEqual(["yam"]);
  });
});

describe("install lines", () => {
  test("a list sent again after a wipe logs no lines for old copies; a copy installed now is one line", async () => {
    const a = await signup("yam"), now = Date.now(), DAY = 86_400_000;
    const old = [7, 8, 9, 10].map(id => ({ slug: `g${id}`, gameId: id, packageId: id, name: `G${id}`, sizeBytes: 1, installedAt: now - 3 * DAY }));
    const put = (items: unknown[]) => http("PUT", "/api/v1/me/installed", { device: "Den PC", items }, a.token);
    const lines = () => (db.query("SELECT COUNT(*) AS n FROM activity WHERE kind='installed'").get() as { n: number }).n;
    await put(old); db.exec("UPDATE activity SET created_at = created_at - 2 * 86400");
    await put([]); const base = lines();
    await put([...old, { slug: "new", gameId: 37, packageId: 33, name: "New", sizeBytes: 1, installedAt: now - 2000 }]);
    expect(lines() - base).toBe(1);
  });
});

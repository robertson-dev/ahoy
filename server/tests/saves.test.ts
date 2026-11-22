/** a person's saves on the server: where a game keeps them (saverules.ts), and the versions kept (saves.ts), theirs alone. */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { http, signup, wipe } from "./helpers";
import { db, kv } from "../src/db";
import { app } from "../src/server";
import { events, type AhoyEvent } from "../src/events";
import { EXCLUDE, MANIFEST_URL, _test as rules, indexManifest, rulePath, rulesFor, saveRulesTick, sdeps, standInPaths } from "../src/saverules";
import { KEEP, PART_MAX, fileOf, sweepSaves } from "../src/saves";

const realFetch = sdeps.fetch;
afterAll(() => { sdeps.fetch = realFetch; });
beforeEach(() => { wipe(); rules.set(new Map()); sdeps.fetch = realFetch; });

const hex = (n: number) => n.toString(16).padStart(64, "0");
/** a set of saves as a launcher sends it: any bytes, ending with its mark */
const pack = (text: string) => new TextEncoder().encode(text + "AHOYSAV1");
const meta = (n: number, over: Record<string, unknown> = {}) => ({ digest: hex(n), files: 3, bytes: 1200, newest: 1_700_000_000_000, device: "DESK", gameId: 7, name: "Hades", ...over });
let uploads = 0;
/** one part of a set of saves, as a launcher sends it */
async function part(token: string | null, key: string, m: unknown, body: Uint8Array | null, which: string | null, headers: Record<string, string> = {}) {
  const res = await app.fetch(new Request(`http://ahoy.test/api/v1/saves/${key}`, {
    method: "POST", body: body as BodyInit | null,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/octet-stream", ...(body ? { "content-length": String(body.byteLength) } : {}), ...(which ? { "x-ahoy-part": which } : {}),
      ...(m !== undefined ? { "x-ahoy-save": encodeURIComponent(JSON.stringify(m)) } : {}), ...headers },
  }));
  return { status: res.status, json: await res.json().catch(() => null) as any };
}
/** a whole set of saves, in parts of `size` bytes (one part unless it says otherwise); the answer is the last part's */
async function send(token: string | null, key: string, m: unknown, body: Uint8Array | null, headers: Record<string, string> = {}, size = PART_MAX) {
  const id = `upload${String(++uploads).padStart(4, "0")}`;
  if (!body) return part(token, key, m, null, `${id}:0:1`, headers);
  const count = Math.max(1, Math.ceil(body.byteLength / size));
  let last = { status: 0, json: null as any };
  for (let i = 0; i < count; i++) {
    last = await part(token, key, m, body.subarray(i * size, (i + 1) * size), `${id}:${i}:${count}`, headers);
    if (last.status !== 200) break;
  }
  return last;
}
const list = async (token: string, key: string) => (await http("GET", `/api/v1/saves/${key}`, undefined, token)).json as { items: { id: number; digest: string; device: string; files: number; bytes: number; size: number; name: string }[]; paths: string[] };
async function fetchFile(token: string, key: string, id: number) {
  const res = await app.fetch(new Request(`http://ahoy.test/api/v1/saves/${key}/${id}`, { headers: { authorization: `Bearer ${token}` } }));
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
}

describe("a rule for where saves are", () => {
  test("starts at a place of the PC and names something under it", () => {
    for (const ok of ["<winAppData>/StardewValley/Saves", "<base>/portal2/SAVE", "<home>/Saved Games/Hades", "<winDocuments>/The Witcher 3/gamesaves/*.sav", "<winProgramData>/Steam/*/413150", "<base>/**/413150/remote", "<winPublic>/Documents/Steam/CODEX/7", "<home>/x/<osUserName>/saves"])
      expect(rulePath(ok)).toBe(ok);
    expect(rulePath("<winAppData>\\EldenRing\\<storeUserId>/")).toBe("<winAppData>/EldenRing/*");
    expect(rulePath("<winLocalAppDataLow>/Team Cherry/Hollow Knight")).toBe("<home>/AppData/LocalLow/Team Cherry/Hollow Knight");
  });
  test("never a whole place, a step back up, another system's place, a drive, or a store client's own folder", () => {
    for (const bad of ["<home>", "<home>/", "<base>", "<base>/**", "<winAppData>/*", "<winDocuments>/*/**", "<home>/../Windows", "<home>/a/../../b", "<home>//x", "<home>/ . /x",
      "C:/Users/Public/Documents/Steam/RUNE/1202200", "$HOME/.config/x", "No save function available", "HKEY_CURRENT_USER/Software/x", "<winDir>/win.ini", "<xdgData>/x", "<xdgConfig>/x",
      "<root>/userdata/<storeUserId>/278440/remote", "<game>/saves", "<home>/x:y", "<home>/a|b", "<home>/[profile]/save.xml", "<home>/{a,b}", "<home>/x**/y", "<nope>/x", "", 7, null, "<home>/" + "a".repeat(400)])
      expect(rulePath(bad), String(bad)).toBeNull();
  });
});

describe("the manifest as an index", () => {
  const doc = {
    "Stardew Valley": { steam: { id: 413150 }, files: {
      "<winAppData>/StardewValley/Saves": { tags: ["save"], when: [{ os: "windows" }] },
      "<winAppData>/StardewValley/default_options": { tags: ["config"], when: [{ os: "windows" }] },
      "<xdgConfig>/StardewValley/Saves": { tags: ["save"], when: [{ os: "linux" }] },
      "<home>/.config/StardewValley/Saves": { tags: ["save"], when: [{ os: "mac" }] },
    } },
    "Hollow Knight": { steam: { id: 367520 }, files: {
      "<home>/AppData/LocalLow/Team Cherry/Hollow Knight/*.dat": { tags: ["save"], when: [{ os: "windows" }] },
      "<base>/hollow_knight_Data/Config.ini": { tags: ["config"], when: [{ os: "windows" }, { os: "linux" }] },
      "<winProgramData>/Packages/TeamCherry.x/SystemAppData/wgs": { tags: ["config", "save"], when: [{ os: "windows", store: "microsoft" }] },
    } },
    "0rbitalis": { steam: { id: 278440 }, files: { "<root>/userdata/<storeUserId>/278440/remote": { when: [{ store: "steam" }] }, "<winAppData>/0RBITALIS": {} } },
    "Elden Ring": { steam: { id: 1245620 }, files: { "<winAppData>/EldenRing/<storeUserId>": { tags: ["save"], when: [{ os: "windows" }] } } },
    "Elden": { alias: "Elden Ring", steam: { id: 999 }, files: { "<winAppData>/Other": { tags: ["save"] } } },
    "Twin A": { steam: { id: 5 }, files: { "<base>/a.sav": { tags: ["save"] } } },
    "Twin B": { steam: { id: 5 }, files: { "<base>/b.sav": { tags: ["save"] }, "C:/Users/x/saves": { tags: ["save"] } } },
    "No Steam": { gog: { id: 3 }, files: { "<winAppData>/NoSteam": { tags: ["save"] } } },
    "Nothing": { steam: { id: 6 } },
    "Only Settings": { steam: { id: 8 }, files: { "<base>/settings.ini": { tags: ["config"] } } },
  };
  test("keeps what a Windows PC has and a player would miss: saves, not settings alone, not another system's or store's", () => {
    const idx = indexManifest(doc);
    expect(Object.fromEntries(idx)).toEqual({
      413150: ["<winAppData>/StardewValley/Saves"],
      367520: ["<home>/AppData/LocalLow/Team Cherry/Hollow Knight/*.dat"],
      278440: ["<winAppData>/0RBITALIS"],
      1245620: ["<winAppData>/EldenRing/*"],
      5: ["<base>/a.sav", "<base>/b.sav"],
    });
    expect(indexManifest(null).size).toBe(0);
    expect(indexManifest("text").size).toBe(0);
  });
  test("a game's rules: the manifest's paths, the folders kept by app id, and what its player added", async () => {
    rules.set(indexManifest(doc));
    const r = await rulesFor(413150, ["<winDocuments>/My Saves", "<home>", "nonsense"]);
    expect(r.known).toBe(true);
    expect(r.paths.slice(0, 1)).toEqual(["<winAppData>/StardewValley/Saves"]);
    expect(r.paths).toContain("<winAppData>/Goldberg SteamEmu Saves/413150");
    expect(r.paths).toContain("<winAppData>/GSE Saves/413150");
    expect(r.paths).toContain("<winPublic>/Documents/Steam/CODEX/413150");
    expect(r.paths).toContain("<base>/**/413150/remote");
    expect(r.paths.at(-1)).toBe("<winDocuments>/My Saves");
    expect(r).toMatchObject({ exclude: EXCLUDE, made: false, appId: 413150 });   // its paths say where: nothing else of its folder is taken
    // every folder kept by app id is a rule the launcher takes
    for (const p of standInPaths(413150)) expect(rulePath(p), p).toBe(p);
    const unknown = await rulesFor(42);
    expect(unknown).toMatchObject({ known: false, made: true });                 // nobody has paths for it: what it made in its folder
    expect(unknown.paths).toEqual(standInPaths(42));
    // before the manifest was ever read nobody can say which games it knows: nothing is guessed for a game with an app id
    rules.set(new Map());
    expect(await rulesFor(42)).toMatchObject({ known: false, made: false });
    expect(await rulesFor(413150)).toMatchObject({ known: false, made: false });
    rules.set(indexManifest(doc));
    expect(await rulesFor(null, ["<winDocuments>/My Saves"])).toMatchObject({ paths: ["<winDocuments>/My Saves"], appId: null, known: false, made: true });
  });
  test("is read again only when it changed, and a broken answer keeps what there was", async () => {
    const yaml = `Hades:\n  steam:\n    id: 1145360\n  files:\n    "<winDocuments>/Saved Games/Hades":\n      tags:\n        - save\n      when:\n        - os: windows\n`;
    const seen: (string | null)[] = [];
    let answer: () => Response = () => new Response(yaml, { headers: { etag: 'W/"one"' } });
    sdeps.fetch = (async (url: string | URL | Request, init?: RequestInit) => { expect(String(url)).toBe(MANIFEST_URL); seen.push(new Headers(init?.headers).get("if-none-match")); return answer(); }) as typeof fetch;
    expect(await saveRulesTick()).toEqual({ games: 1, changed: true });
    expect((await rulesFor(1145360)).paths[0]).toBe("<winDocuments>/Saved Games/Hades");
    expect(kv.get("saves.rules.etag")).toBe('W/"one"');
    answer = () => new Response(null, { status: 304 });
    expect(await saveRulesTick()).toEqual({ games: 1, changed: false });
    expect(seen).toEqual([null, 'W/"one"']);
    answer = () => new Response("down", { status: 503 });
    await expect(saveRulesTick()).rejects.toThrow(/did not load/);
    answer = () => new Response("[]", { headers: { etag: 'W/"two"' } });
    await expect(saveRulesTick()).rejects.toThrow(/kept the 1/);
    expect((await rulesFor(1145360)).known).toBe(true);
    // what was kept on disk is what a fresh start reads
    rules.set(null);
    expect((await rulesFor(1145360)).paths[0]).toBe("<winDocuments>/Saved Games/Hades");
  });
});

describe("the rules a PC asks for", () => {
  test("by the game's key; a key that names no app id has only what its player added", async () => {
    const a = await signup("yam");
    rules.set(new Map([[413150, ["<winAppData>/StardewValley/Saves"]]]));
    const r = (await http("GET", "/api/v1/saves/a413150/rules", undefined, a.token)).json;
    expect(r.known).toBe(true);
    expect(r.paths[0]).toBe("<winAppData>/StardewValley/Saves");
    expect((await http("PUT", "/api/v1/saves/g31/paths", { paths: ["<winDocuments>/My Games/Thing/saves"] }, a.token)).json.paths).toEqual(["<winDocuments>/My Games/Thing/saves"]);
    expect((await http("GET", "/api/v1/saves/g31/rules", undefined, a.token)).json).toMatchObject({ paths: ["<winDocuments>/My Games/Thing/saves"], appId: null, known: false });
    for (const bad of ["x1", "a", "a1/../x", "g" + "1".repeat(20)]) expect((await http("GET", `/api/v1/saves/${encodeURIComponent(bad)}/rules`, undefined, a.token)).status).toBe(404);
    expect((await http("GET", "/api/v1/saves/a413150/rules")).status).toBe(401);
  });
  test("a folder added by hand must be a rule: a whole profile or a drive is refused, and nothing is saved", async () => {
    const a = await signup("yam"), b = await signup("mika");
    for (const bad of [{ paths: ["<home>"] }, { paths: ["C:/Users/x"] }, { paths: "x" }, { paths: Array.from({ length: 9 }, (_, i) => `<home>/s${i}`) }, {}])
      expect((await http("PUT", "/api/v1/saves/g31/paths", bad, a.token)).status).toBe(400);
    await http("PUT", "/api/v1/saves/g31/paths", { paths: ["<home>/Saved Games/Thing", "<home>/Saved Games/Thing"] }, a.token);
    expect((await list(a.token, "g31")).paths).toEqual(["<home>/Saved Games/Thing"]);
    expect((await list(b.token, "g31")).paths).toEqual([]);                    // one person's folders are theirs
  });
});

describe("versions of a game's saves", () => {
  test("a PC brings them, another takes them: the file comes back as it was sent", async () => {
    const a = await signup("yam");
    const body = pack("the saves of an evening");
    const r = await send(a.token, "a1145360", meta(1), body);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ same: false, item: { key: "a1145360", digest: hex(1), device: "DESK", files: 3, bytes: 1200, size: body.byteLength, name: "Hades", gameId: 7 } });
    const got = await fetchFile(a.token, "a1145360", r.json.item.id);
    expect(got.status).toBe(200);
    expect(Buffer.from(got.bytes).equals(Buffer.from(body))).toBe(true);
    expect((await list(a.token, "a1145360")).items.map(i => i.digest)).toEqual([hex(1)]);
    expect((await http("GET", "/api/v1/saves", undefined, a.token)).json.items.map((i: any) => [i.key, i.versions, i.device])).toEqual([["a1145360", 1, "DESK"]]);
  });
  test("the newest is the head; the same saves again add nothing; the versions before stay to go back to", async () => {
    const a = await signup("yam");
    const one = (await send(a.token, "g7", meta(1), pack("one"))).json.item.id;
    const two = (await send(a.token, "g7", meta(2, { device: "COUCH" }), pack("two"))).json.item.id;
    const again = await send(a.token, "g7", meta(2, { device: "DESK" }), pack("two, sent again"));
    expect(again.json).toMatchObject({ same: true, item: { id: two, device: "COUCH" } });
    expect((await list(a.token, "g7")).items.map(i => [i.id, i.device])).toEqual([[two, "COUCH"], [one, "DESK"]]);
    // going back: the older saves brought again are a new head
    const back = await send(a.token, "g7", meta(1), pack("one"));
    expect(back.json.same).toBe(false);
    expect((await list(a.token, "g7")).items.map(i => i.digest)).toEqual([hex(1), hex(2), hex(1)]);
    expect(new TextDecoder().decode((await fetchFile(a.token, "g7", one)).bytes)).toBe("oneAHOYSAV1");
  });
  test(`only the last ${KEEP} stay`, async () => {
    const a = await signup("yam");
    const ids: number[] = [];
    for (let i = 1; i <= KEEP + 3; i++) ids.push((await send(a.token, "g7", meta(i), pack(`v${i}`))).json.item.id);
    const kept = (await list(a.token, "g7")).items.map(i => i.id);
    expect(kept).toEqual(ids.slice(3).reverse());
    expect(existsSync(fileOf(a.user.id, "g7", ids[0]!))).toBe(false);
    expect(existsSync(fileOf(a.user.id, "g7", ids.at(-1)!))).toBe(true);
    expect((await fetchFile(a.token, "g7", ids[0]!)).status).toBe(404);
  });
  test("they are one person's own", async () => {
    const a = await signup("yam"), b = await signup("mika");
    const id = (await send(a.token, "g7", meta(1), pack("mine"))).json.item.id;
    expect((await list(b.token, "g7")).items).toEqual([]);
    expect((await fetchFile(b.token, "g7", id)).status).toBe(404);
    expect((await http("GET", "/api/v1/saves", undefined, b.token)).json.items).toEqual([]);
    expect((await send(null, "g7", meta(2), pack("x"))).status).toBe(401);
    expect((await fetchFile(a.token, "g8", id)).status).toBe(404);              // not under another game's key either
    const seen: AhoyEvent[] = [];
    const off = events.subscribe(e => { if (e.event === "save") seen.push(e); });
    try { await send(b.token, "g7", meta(3), pack("hers")); } finally { off(); }
    expect(seen.map(e => e.to)).toEqual([b.user.id]);
  });
  test("what is not a set of saves is refused, and nothing of it stays", async () => {
    const a = await signup("yam");
    expect((await send(a.token, "g7", undefined, pack("x"))).status).toBe(400);                                  // not said what it is
    for (const m of [{}, meta(1, { digest: "abc" }), meta(1, { files: 0 }), meta(1, { files: -1 }), meta(1, { bytes: "many" })]) expect((await send(a.token, "g7", m, pack("x"))).status).toBe(400);
    expect((await send(a.token, "g7", meta(1), new TextEncoder().encode("a page, not saves"))).status).toBe(400);   // no mark at its end
    expect((await send(a.token, "g7", meta(1), null)).status).toBe(400);
    expect((await part(a.token, "g7", meta(1), pack("x"), null)).status).toBe(400);                                 // not said which part
    for (const which of ["up:0:1", "upload0001:1:1", "upload0001:0:0", "upload0001:x:1", "UPLOAD0001:0:1"]) expect((await part(a.token, "g7", meta(1), pack("x"), which)).status).toBe(400);
    expect((await part(a.token, "g7", meta(1), pack("x"), "upload9000:0:1", { "content-length": String(PART_MAX + 1) })).status).toBe(413);
    expect((await part(a.token, "g7", meta(1), new Uint8Array(8), "upload9001:0:1")).status).toBe(400);              // nothing but where a mark would be
    expect((await send(a.token, "x7", meta(1), pack("x"))).status).toBe(404);
    expect((await list(a.token, "g7")).items).toEqual([]);
    const dir = join(fileOf(a.user.id, "g7", 1), "..");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
  test("what a version says of itself is kept short and clean", async () => {
    const a = await signup("yam");
    const r = await send(a.token, "g7", meta(1, { device: "DESK\nTOP" + "x".repeat(200), name: "  Hades\u0007 ", gameId: "seven", newest: -5 }), pack("x"));
    expect(r.json.item).toMatchObject({ name: "Hades", gameId: null, newest: null });
    expect(r.json.item.device.length).toBe(80);
    expect(r.json.item.device.startsWith("DESK TOP")).toBe(true);
  });
  test("files no version names any more are swept, once they are old", async () => {
    const a = await signup("yam");
    const id = (await send(a.token, "g7", meta(1), pack("x"))).json.item.id;
    const dir = join(fileOf(a.user.id, "g7", id), "..");
    const stray = join(dir, "999.sav"), young = join(dir, "in-1-abc.part");
    writeFileSync(stray, "old"); writeFileSync(young, "now");
    utimesSync(stray, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    expect(await sweepSaves()).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([`${id}.sav`, "in-1-abc.part"]);
    db.query("DELETE FROM saves").run();
    utimesSync(join(dir, `${id}.sav`), new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    expect(await sweepSaves()).toBe(1);
  });
});

describe("a version in parts", () => {
  const big = () => { const b = new Uint8Array(2500); for (let i = 0; i < b.length; i++) b[i] = (i * 7) % 251; b.set(new TextEncoder().encode("AHOYSAV1"), b.length - 8); return b; };
  test("arrives in order, a part a request, and is the same file at the end", async () => {
    const a = await signup("yam");
    const body = big();
    const r = await send(a.token, "g7", meta(1), body, {}, 1000);
    expect(r.status).toBe(201);
    expect(r.json.item.size).toBe(2500);
    expect(Buffer.from((await fetchFile(a.token, "g7", r.json.item.id)).bytes).equals(Buffer.from(body))).toBe(true);
    const mid = await part(a.token, "g7", meta(2), body.subarray(0, 1000), "upload7000:0:3");
    expect(mid).toMatchObject({ status: 200, json: { next: 1 } });
    expect((await list(a.token, "g7")).items.length).toBe(1);                   // not a version until its last part
  });
  test("a part out of turn, or of another set of saves, ends the upload: it starts again", async () => {
    const a = await signup("yam"), b = await signup("mika");
    const body = big();
    await part(a.token, "g7", meta(1), body.subarray(0, 1000), "upload7001:0:3");
    expect((await part(a.token, "g7", meta(1), body.subarray(2000), "upload7001:2:3")).status).toBe(409);            // the second never came
    expect((await part(a.token, "g7", meta(1), body.subarray(1000, 2000), "upload7001:1:3")).status).toBe(409);      // and the upload is over
    await part(a.token, "g7", meta(1), body.subarray(0, 1000), "upload7002:0:3");
    expect((await part(a.token, "g7", meta(2), body.subarray(1000, 2000), "upload7002:1:3")).status).toBe(409);      // other saves than it began with
    expect((await part(a.token, "g7", meta(1), body.subarray(1000, 2000), "upload7003:1:3")).status).toBe(409);      // no first part
    // nobody continues someone else's upload
    await part(a.token, "g7", meta(1), body.subarray(0, 1000), "upload7004:0:3");
    expect((await part(b.token, "g7", meta(1), body.subarray(1000, 2000), "upload7004:1:3")).status).toBe(409);
    expect((await list(a.token, "g7")).items).toEqual([]);
    // starting again from its first part works
    expect((await send(a.token, "g7", meta(1), body, {}, 1000)).status).toBe(201);
  });
  test("the first part of saves the server already has as its newest ends there", async () => {
    const a = await signup("yam");
    const body = big();
    const first = await send(a.token, "g7", meta(1), body, {}, 1000);
    const again = await part(a.token, "g7", meta(1, { device: "COUCH" }), body.subarray(0, 1000), "upload7005:0:3");
    expect(again).toMatchObject({ status: 201, json: { same: true, item: { id: first.json.item.id } } });
  });
});

describe("how much a request may bring", () => {
  test("a little JSON, or one part of a set of saves", async () => {
    const a = await signup("yam");
    const big = await app.fetch(new Request("http://ahoy.test/api/v1/me/heartbeat", { method: "POST", headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json", "content-length": String(3 * 1024 * 1024) }, body: "{}" }));
    expect(big.status).toBe(413);
    const pieces = await app.fetch(new Request("http://ahoy.test/api/v1/me/heartbeat", { method: "POST", headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json", "transfer-encoding": "chunked" }, body: "{}" }));
    expect(pieces.status).toBe(413);
    expect((await http("POST", "/api/v1/me/heartbeat", { device: "DESK" }, a.token)).status).toBe(200);
    expect((await http("DELETE", "/api/v1/me/orders/1", undefined, a.token)).status).toBe(200);    // no body at all is fine
  });
});

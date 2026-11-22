/** art that faces the internet: who may ask for what, what is kept, where a fetch may go, and what an art answer may do in a browser. */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { game, setLibrary, signup, wipe } from "./helpers";
import { app } from "../src/server";
import { kv } from "../src/db";
import { configDir } from "../src/config";
import * as ludarr from "../src/ludarr";
import { adeps, allowedUrl, artLimit, _test as artMemory, cachedImage } from "../src/art";
import { artGate } from "../src/who";

const CAPSULE = new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", "art", "3308870-library_capsule_2x.jpg")));
type Answer = { body?: Uint8Array<ArrayBuffer>; type?: string; status?: number; location?: string; length?: string };
let cdn: Record<string, Answer> = {};
let asked: string[] = [];
const real = { fetch: adeps.fetch, steamArt: adeps.steamArt, steamAssets: adeps.steamAssets, pfetch: ludarr.pdeps.fetch, plog: ludarr.pdeps.log };

beforeEach(() => {
  wipe();
  rmSync(join(configDir(), "art"), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  artMemory.forget();
  cdn = {}; asked = [];
  kv.set("cfg.LUDARR_URL", "http://engine:7979"); kv.set("cfg.LUDARR_API_KEY", "k3y");
  ludarr.pdeps.log = () => {};
  ludarr.pdeps.fetch = (async () => new Response(JSON.stringify({ error: "nothing" }), { status: 404, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  adeps.steamArt = async () => ({ portrait: null, hero: null, cardWide: null }) as never;
  adeps.steamAssets = async () => new Map();
  adeps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    const a = cdn[url];
    if (!a) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    // a real fetch follows a redirect itself unless told not to: the fake does the same, so following one shows as a second ask
    if (a.location && init?.redirect !== "manual") return adeps.fetch(new URL(a.location, url).toString(), init);
    const headers: Record<string, string> = { "content-type": a.type ?? "image/jpeg" };
    if (a.location) headers.location = a.location;
    if (a.length) headers["content-length"] = a.length;
    return new Response(a.location ? null : a.body ?? null, { status: a.status ?? (a.location ? 302 : 200), headers });
  }) as typeof fetch;
});
afterEach(() => { artGate.enabled = false; artLimit.bytes = 15 * 1024 * 1024; });
afterAll(() => { adeps.fetch = real.fetch; adeps.steamArt = real.steamArt; adeps.steamAssets = real.steamAssets; ludarr.pdeps.fetch = real.pfetch; ludarr.pdeps.log = real.plog; artMemory.forget(); });

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await app.fetch(new Request(`http://ahoy.test${path}`, { headers }));
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* an image */ }
  return { status: res.status, type: res.headers.get("content-type") ?? "", headers: res.headers, text, json };
}
const STEAM = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps";
const ready = (id: number, name: string, addedAt: number) => game(id, name, { status: "available", file: { id, path: "", size: 1, version: null, launch: null, files: 1, importer: null, release: null, group: null, format: "x", addedAt } });

describe("who may ask for art", () => {
  test("art of store apps and of any address makes the server fetch and keep files: members only", async () => {
    const m = await signup("mika");
    artGate.enabled = true;
    cdn[`${STEAM}/730/a.jpg`] = { body: CAPSULE };
    const paths = ["/api/v1/art/steam/730/poster", "/api/v1/art/steam/730/banner", "/api/v1/art/steam/730/hero", "/api/v1/art/steam/730/logo", "/api/v1/art/steam/730/meta",
      "/api/v1/art/steam/730/spotlight", `/api/v1/art/url?u=${encodeURIComponent(`${STEAM}/730/a.jpg`)}`];
    for (const p of paths) expect((await get(p)).status).toBe(401);
    expect((await get(`/api/v1/art/url?u=${encodeURIComponent(`${STEAM}/730/a.jpg`)}&token=${m.token}`)).status).toBe(401);   // no token in an address
    expect(asked).toEqual([]);
    // a member's page sends the cookie with an <img>, the launcher's a header
    expect((await get(paths[6]!, { cookie: `ahoy_session=${m.token}` })).status).toBe(200);
    expect((await get(paths[0]!, { authorization: `Bearer ${m.token}` })).status).toBe(200);
    expect((await get(paths[4]!, { cookie: `ahoy_session=${m.token}` })).status).toBe(200);
  });

  test("a search hit's cover makes the engine and the server fetch and keep one too: members only, whatever the id", async () => {
    const m = await signup("mika");
    artGate.enabled = true;
    const engineAsked: string[] = [];
    ludarr.pdeps.fetch = (async (input: string | URL | Request) => {
      engineAsked.push(new URL(String(input instanceof Request ? input.url : input)).pathname);
      return new Response(CAPSULE, { headers: { "content-type": "image/jpeg" } });
    }) as unknown as typeof fetch;
    for (const id of [7, 8, 9, 424242]) {
      for (const q of ["", "?w=120", "?n=Ico", `?token=${m.token}`]) expect((await get(`/api/v1/art/title/${id}/poster${q}`)).status).toBe(401);
    }
    expect(engineAsked).toEqual([]);
    // a member's search results still show their covers: the page's <img> sends the cookie, the launcher's a header
    const mine = await get("/api/v1/art/title/7/poster", { cookie: `ahoy_session=${m.token}` });
    expect(mine.status).toBe(200); expect(mine.type).toBe("image/jpeg");
    expect((await get("/api/v1/art/title/8/poster", { authorization: `Bearer ${m.token}` })).type).toBe("image/jpeg");
    expect(engineAsked).toEqual(["/api/v1/art/title/7/poster", "/api/v1/art/title/8/poster"]);
  });

  test("what names a library game is for members, and for anyone only for the front page's five", async () => {
    const m = await signup("mika");
    setLibrary([...[1, 2, 3, 4, 5].map(i => ready(i, `Front ${i}`, 100 + i)), ready(6, "Older Game", 1), game(7, "Secret Wishlist")]);
    artGate.enabled = true;
    // the doors draw the five newest before anyone signs in
    for (const id of [1, 5]) {
      const card = await get(`/api/v1/art/game/${id}/card`);
      expect(card.status).toBe(200); expect(card.json.title).toBe(`Front ${id}`);
      expect((await get(`/api/v1/art/game/${id}/spotlight`)).status).toBe(200);
    }
    // the rest of the library cannot be read off by walking the ids
    for (const id of [6, 7, 8, 424242]) {
      expect((await get(`/api/v1/art/game/${id}/card`)).status).toBe(401);
      expect((await get(`/api/v1/art/game/${id}/card?text=1&style=fade`)).status).toBe(401);
      expect((await get(`/api/v1/art/game/${id}/spotlight?w=1440`)).status).toBe(401);
    }
    const stand = await get("/api/v1/art/game/7/poster");
    expect(stand.headers.get("x-ahoy-art")).toBe("placeholder");
    expect(stand.text).not.toContain("Secret"); expect(stand.text).not.toContain("Wishlist");
    // a member reads all of it
    const mine = { cookie: `ahoy_session=${m.token}` };
    expect((await get("/api/v1/art/game/7/card", mine)).json.title).toBe("Secret Wishlist");
    expect((await get("/api/v1/art/game/6/spotlight", mine)).status).toBe(200);
    expect((await get("/api/v1/art/game/7/poster", mine)).text).toContain("Secret");
    expect((await get("/api/v1/art/game/424242/card", mine)).status).toBe(404);
  });
});

describe("what is kept and where a fetch may go", () => {
  const url = (u: string) => `/api/v1/art/url?u=${encodeURIComponent(u)}`;
  test("an SVG is a document, not a picture: it is not kept and not served", async () => {
    const svg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script>${"x".repeat(600)}</svg>`) as Uint8Array<ArrayBuffer>;
    cdn[`${STEAM}/1/evil.svg`] = { body: svg, type: "image/svg+xml" };
    const r = await get(url(`${STEAM}/1/evil.svg`));
    expect(r.status).toBe(404);
    expect(r.text).not.toContain("<script");
    expect(await cachedImage(`${STEAM}/1/evil.svg`)).toBeNull();
  });
  test("only Steam's own names on akamaihd.net are Steam", () => {
    expect(allowedUrl("https://steamcdn-a.akamaihd.net/steam/apps/730/header.jpg")).toBe(true);
    expect(allowedUrl("https://shared.akamai.steamstatic.com/x.jpg")).toBe(true);
    for (const u of ["https://attacker.akamaihd.net/a.svg", "https://x-a.akamaihd.net/a.png", "https://steamcdn-a.akamaihd.net.evil.example/a.png", "http://steamcdn-a.akamaihd.net/a.png"]) expect(allowedUrl(u)).toBe(false);
  });
  test("a redirect is followed only to another allowed address", async () => {
    cdn[`${STEAM}/2/out.jpg`] = { location: "http://192.168.1.1/admin.jpg" };
    cdn["http://192.168.1.1/admin.jpg"] = { body: CAPSULE };
    cdn[`${STEAM}/2/away.jpg`] = { location: "https://evil.example/a.jpg" };
    cdn["https://evil.example/a.jpg"] = { body: CAPSULE };
    cdn[`${STEAM}/2/moved.jpg`] = { location: "/store_item_assets/steam/apps/2/new.jpg" };
    cdn[`${STEAM}/2/new.jpg`] = { body: CAPSULE };
    expect((await get(url(`${STEAM}/2/out.jpg`))).status).toBe(404);
    expect((await get(url(`${STEAM}/2/away.jpg`))).status).toBe(404);
    expect(asked.filter(u => !u.startsWith(STEAM))).toEqual([]);
    const moved = await get(url(`${STEAM}/2/moved.jpg`));
    expect(moved.status).toBe(200); expect(moved.type).toBe("image/jpeg");
    expect(asked.slice(-2)).toEqual([`${STEAM}/2/moved.jpg`, `${STEAM}/2/new.jpg`]);
  });
  test("an answer longer than a picture can be is not kept, whether it says its length or not", async () => {
    artLimit.bytes = 2000;
    cdn[`${STEAM}/3/huge.jpg`] = { body: CAPSULE };                                               // no length given: read until it is too much
    cdn[`${STEAM}/3/says.jpg`] = { body: CAPSULE.slice(0, 1000), length: "99999999" };
    cdn[`${STEAM}/3/fits.jpg`] = { body: CAPSULE.slice(0, 1500) };
    expect(await cachedImage(`${STEAM}/3/huge.jpg`)).toBeNull();
    expect(await cachedImage(`${STEAM}/3/says.jpg`)).toBeNull();
    expect(await cachedImage(`${STEAM}/3/fits.jpg`)).not.toBeNull();
  });
  test("every art answer says its type is its type, and opened as a page may run and load nothing", async () => {
    setLibrary([game(1, "Hades")]);
    cdn[`${STEAM}/4/a.jpg`] = { body: CAPSULE };
    for (const p of [url(`${STEAM}/4/a.jpg`), "/api/v1/art/game/1/poster", "/api/v1/art/game/1/hero", "/api/v1/art/game/1/card", "/api/v1/art/game/1/meta", "/api/v1/art/steam/730/logo", "/api/v1/art/game/abc/poster"]) {
      const r = await get(p);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(r.headers.get("content-security-policy")).toContain("sandbox");
    }
  });
});

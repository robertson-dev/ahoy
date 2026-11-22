import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { game, setLibrary, wipe } from "./helpers";
import { app } from "../src/server";
import { kv } from "../src/db";
import { configDir } from "../src/config";
import * as ludarr from "../src/ludarr";
import { adeps, LOGO_TTL, _test as artMemory, logoNumbers, logoSources, meanLuma, memoLimit, placeholderSvg, steamUrl, webpCopy } from "../src/art";
import type { AppArt, SteamAssets } from "../src/steam";

/*
 * Fixtures: Steam app 3308870 ("and Roger"), copied from the boards' art. Its logo is dark line art made for a pink hero,
 * the real case of a logo that cannot be read on the dark page. Reference numbers were measured independently with
 * Chromium's own decoders (an Electron canvas): hero 3840x1240 mean 194.40, capsule 600x900 mean 161.83, logo 1280x720,
 * box of alpha >= 128 at (30, 275) 1220x204, of alpha >= 16 at (30, 275) 1220x205 (the boards' manifest says the same), readable 0.
 */
const FIX = join(import.meta.dir, "fixtures", "art");
const HERO = new Uint8Array(readFileSync(join(FIX, "3308870-library_hero_2x.jpg")));
const CAPSULE = new Uint8Array(readFileSync(join(FIX, "3308870-library_capsule_2x.jpg")));
const LOGO = new Uint8Array(readFileSync(join(FIX, "3308870-logo_2x.png")));
const ROGER = 3308870;

const ASSETS = "https://shared.akamai.steamstatic.com/store_item_assets/";
const heroUrl = (appId: number) => `${ASSETS}steam/apps/${appId}/0daf3933d392d7bb7c5a890917e20c917fcc458e/library_hero_2x.jpg?t=1776125684`;
const headerUrl = (appId: number) => `${ASSETS}steam/apps/${appId}/3c3489495136b26b34f8a9543c7f5645b99d388c/header.jpg?t=1776125684`;
const table = (appId: number, extra: Record<string, string> = {}): SteamAssets => ({ asset_url_format: `steam/apps/${appId}/\${FILENAME}?t=1776125684`, library_hero_2x: "0daf/library_hero_2x.jpg", ...extra });

type Bytes = Uint8Array<ArrayBuffer>;

/** a synthetic logo on a transparent 200x100 ground, every block's numbers known */
async function syntheticLogo(): Promise<Bytes> {
  const w = 200, h = 100, px = new Uint8Array(w * h * 4);
  const block = (x0: number, y0: number, bw: number, bh: number, rgb: number, a: number) => {
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) px.set([rgb, rgb, rgb, a], (y * w + x) * 4);
  };
  block(20, 30, 40, 20, 255, 255);   // 800 white: reads
  block(60, 30, 20, 20, 0x60, 255);  // 400 #606060: 3.03:1 against #101010, reads
  block(80, 30, 20, 20, 0x5f, 255);  // 400 #5f5f5f: 2.98:1, does not
  block(100, 60, 10, 10, 255, 128);  // 100 white at alpha 128: opaque, reads
  block(110, 20, 10, 10, 0, 255);    // 100 black: opaque, does not read
  block(150, 5, 40, 10, 255, 127);   // white at alpha 127: not opaque, outside the box and the share
  return new Uint8Array(await sharp(px, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer());   // stored, so it stays above the 400-byte floor for a real image
}
const SYNTH = { box: { x: 20, y: 20, w: 100, h: 50 }, readable: 0.722 };   // 1300 of 1800 opaque pixels read

/* ─────────── a fake Steam (CDN + store), a fake ludarr ─────────── */

type Answer = { body?: Bytes; type?: string; status?: number; down?: boolean; delay?: number };
let cdn: Record<string, Answer> = {};
let asked: { method: string; url: string }[] = [];
let tables: Record<number, SteamAssets> = {};
let tableCalls: number[][] = [];
let arts: Record<number, AppArt> = {};
let artCalls: number[] = [];
let banners: Record<number, Answer> = {};
let titles: Record<number, Answer> = {};
let now = Date.now();
const real = { fetch: adeps.fetch, steamArt: adeps.steamArt, steamAssets: adeps.steamAssets, now: adeps.now, pfetch: ludarr.pdeps.fetch };

beforeEach(() => {
  wipe();
  rmSync(join(configDir(), "art"), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  artMemory.forget();
  cdn = {}; asked = []; tables = {}; tableCalls = []; arts = {}; artCalls = []; banners = {}; titles = {}; now = Date.now();
  kv.set("cfg.LUDARR_URL", "http://engine:7979"); kv.set("cfg.LUDARR_API_KEY", "k3y");
  adeps.now = () => now;
  adeps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input), method = init?.method ?? "GET";
    asked.push({ method, url });
    const a = cdn[url];
    if (a?.delay) await new Promise(r => setTimeout(r, a.delay));
    if (a?.down) throw new Error("connect ECONNREFUSED");
    if (!a) return new Response("<html><body>404 Not Found</body></html>", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(method === "HEAD" ? null : a.body ?? null, { status: a.status ?? 200, headers: { "content-type": a.type ?? "image/png" } });
  }) as typeof fetch;
  adeps.steamAssets = async (ids: number[]) => { tableCalls.push(ids); return new Map(ids.filter(id => tables[id]).map(id => [id, tables[id]])); };
  adeps.steamArt = async (appId: number) => { artCalls.push(appId); return arts[appId] ?? { portrait: null, hero: headerUrl(appId), cardWide: headerUrl(appId) }; };
  ludarr.pdeps.fetch = (async (input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input).replace("http://engine:7979", "");
    const m = /^\/api\/v1\/art\/game\/(\d+)\/banner$/.exec(path), t = /^\/api\/v1\/art\/title\/(\d+)\/poster$/.exec(path);
    const a = m ? banners[Number(m[1])] : t ? titles[Number(t[1])] : undefined;
    if (!a) return new Response(JSON.stringify({ error: "no such endpoint" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(a.body ?? null, { status: a.status ?? 200, headers: { "content-type": a.type ?? "image/jpeg", ...(a.type === "image/svg+xml" ? { "x-ludarr-art": "placeholder" } : {}) } });
  }) as typeof fetch;
});
afterAll(() => {
  adeps.fetch = real.fetch; adeps.steamArt = real.steamArt; adeps.steamAssets = real.steamAssets; adeps.now = real.now; ludarr.pdeps.fetch = real.pfetch;
  artMemory.forget();
});

/** one request to the app, the body kept as bytes */
async function get(path: string) {
  const res = await app.fetch(new Request(`http://ahoy.test${path}`));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, type, headers: res.headers, bytes, json: type.includes("json") ? JSON.parse(new TextDecoder().decode(bytes)) : null };
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const gets = () => asked.filter(a => a.method === "GET").map(a => a.url);
const heads = () => asked.filter(a => a.method === "HEAD").map(a => a.url);
const logoFile = (appId: number) => join(configDir(), "art", `${createHash("sha1").update(`steam:logo:${appId}`).digest("hex").slice(0, 24)}.png`);

/* ─────────── logos ─────────── */

describe("logos", () => {
  test("the sources, best first, all on Steam's own hosts: a logo the store's table lists, the store's asset path, the legacy path on both CDN bases", () => {
    expect(logoSources(ROGER)).toEqual([
      `${ASSETS}steam/apps/${ROGER}/logo_2x.png`, `${ASSETS}steam/apps/${ROGER}/logo.png`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${ROGER}/logo_2x.png`, `https://shared.akamai.steamstatic.com/steam/apps/${ROGER}/logo_2x.png`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${ROGER}/logo.png`, `https://shared.akamai.steamstatic.com/steam/apps/${ROGER}/logo.png`,
    ]);
    const listed = logoSources(ROGER, table(ROGER, { library_logo_2x: "4a1b/logo_2x.png" }));
    expect(listed[0]).toBe(`${ASSETS}steam/apps/${ROGER}/4a1b/logo_2x.png?t=1776125684`);
    expect(listed.length).toBe(7);
    expect(logoSources(ROGER, table(ROGER)).length).toBe(6);                    // the table lists no logo today
    expect([...listed].every(steamUrl)).toBe(true);
    expect(steamUrl("https://evil.example/steam/apps/1/logo.png")).toBe(false);
    expect(steamUrl("http://shared.akamai.steamstatic.com/steam/apps/1/logo.png")).toBe(false);
  });

  test("found on the first source: served as a PNG, kept on disk, not asked again", async () => {
    tables[ROGER] = table(ROGER);
    cdn[`${ASSETS}steam/apps/${ROGER}/logo_2x.png`] = { body: LOGO };
    cdn[`${ASSETS}steam/apps/${ROGER}/logo.png`] = { body: await syntheticLogo() };
    const r = await get(`/api/v1/art/steam/${ROGER}/logo`);
    expect(r.status).toBe(200);
    expect(r.type).toBe("image/png");
    expect(same(r.bytes, LOGO)).toBe(true);
    expect(gets()).toEqual([`${ASSETS}steam/apps/${ROGER}/logo_2x.png`]);
    expect(heads().length).toBe(6);
    expect(tableCalls).toEqual([[ROGER]]);
    expect(existsSync(logoFile(ROGER))).toBe(true);
    asked = []; tableCalls = [];
    setLibrary([game(28, "and Roger", { steamAppId: ROGER })]);
    const again = await get("/api/v1/art/game/28/logo");                        // the game's own route: the same file
    expect(same(again.bytes, LOGO)).toBe(true);
    artMemory.forget();                                                          // as after a restart
    expect(same((await get(`/api/v1/art/steam/${ROGER}/logo`)).bytes, LOGO)).toBe(true);
    expect(asked).toEqual([]); expect(tableCalls).toEqual([]);
  });

  test("a logo the store's asset table lists comes before every guessed path", async () => {
    const synth = await syntheticLogo();
    tables[ROGER] = table(ROGER, { library_logo_2x: "4a1b/logo_2x.png" });
    cdn[`${ASSETS}steam/apps/${ROGER}/4a1b/logo_2x.png?t=1776125684`] = { body: synth };
    cdn[`${ASSETS}steam/apps/${ROGER}/logo_2x.png`] = { body: LOGO };
    const r = await get(`/api/v1/art/steam/${ROGER}/logo`);
    expect(same(r.bytes, synth)).toBe(true);
    expect(gets()).toEqual([`${ASSETS}steam/apps/${ROGER}/4a1b/logo_2x.png?t=1776125684`]);
  });

  test("a listed logo that does not come as a PNG is no logo: the next source answers", async () => {
    tables[ROGER] = table(ROGER, { library_logo_2x: "4a1b/logo_2x.png" });
    cdn[`${ASSETS}steam/apps/${ROGER}/4a1b/logo_2x.png?t=1776125684`] = { body: new Uint8Array(4000), type: "image/jpeg" };
    cdn[`${ASSETS}steam/apps/${ROGER}/logo_2x.png`] = { body: LOGO };
    const r = await get(`/api/v1/art/steam/${ROGER}/logo`);
    expect(r.status).toBe(200);
    expect(same(r.bytes, LOGO)).toBe(true);
    expect(gets()).toEqual([`${ASSETS}steam/apps/${ROGER}/4a1b/logo_2x.png?t=1776125684`, `${ASSETS}steam/apps/${ROGER}/logo_2x.png`]);
  });

  test("found on a fallback: the last legacy path, after every other source said no", async () => {
    const ds3 = 374320, last = `https://shared.akamai.steamstatic.com/steam/apps/${ds3}/logo.png`;
    tables[ds3] = table(ds3);
    cdn[last] = { body: LOGO };
    cdn[`${ASSETS}steam/apps/${ds3}/logo_2x.png`] = { body: new Uint8Array(2000), type: "image/jpeg" };   // not a PNG: no logo
    const r = await get(`/api/v1/art/steam/${ds3}/logo`);
    expect(r.status).toBe(200);
    expect(same(r.bytes, LOGO)).toBe(true);
    expect(heads()).toEqual(logoSources(ds3));
    expect(gets()).toEqual([last]);
  });

  test("the best source that has it answers: a worse one still asking (a slow host) is not waited for", async () => {
    tables[ROGER] = table(ROGER);
    cdn[`${ASSETS}steam/apps/${ROGER}/logo_2x.png`] = { body: LOGO };
    for (const u of logoSources(ROGER).slice(2)) cdn[u] = { body: LOGO, delay: 2_500 };     // the legacy hosts answer late
    const t0 = performance.now();
    const r = await get(`/api/v1/art/steam/${ROGER}/logo`);
    expect(r.status).toBe(200);
    expect(same(r.bytes, LOGO)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1_500);
    expect(gets()).toEqual([`${ASSETS}steam/apps/${ROGER}/logo_2x.png`]);
  });

  test("missing: 404, remembered on disk for a day, then asked again", async () => {
    const batomon = 4557380;                                                     // a real app whose logo Steam keeps at hashed paths only
    tables[batomon] = table(batomon);
    const r = await get(`/api/v1/art/steam/${batomon}/logo`);
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "no logo" });
    expect(heads().length).toBe(6); expect(gets()).toEqual([]);
    asked = []; tableCalls = [];
    expect((await get(`/api/v1/art/steam/${batomon}/logo`)).status).toBe(404);
    artMemory.forget();                                                          // a restart: the miss is on disk
    expect((await get(`/api/v1/art/steam/${batomon}/logo`)).status).toBe(404);
    expect(asked).toEqual([]); expect(tableCalls).toEqual([]);
    now += LOGO_TTL.missing + 1000;
    expect((await get(`/api/v1/art/steam/${batomon}/logo`)).status).toBe(404);
    expect(heads().length).toBe(6); expect(tableCalls).toEqual([[batomon]]);
  });

  test("Steam not answering is a short miss: asked again after a quarter of an hour", async () => {
    const appId = 3486530;
    for (const u of logoSources(appId)) cdn[u] = { down: true };
    expect((await get(`/api/v1/art/steam/${appId}/logo`)).status).toBe(404);
    asked = [];
    now += LOGO_TTL.unanswered - 60_000;
    expect((await get(`/api/v1/art/steam/${appId}/logo`)).status).toBe(404);
    expect(asked).toEqual([]);
    now += 120_000;
    cdn = { [`${ASSETS}steam/apps/${appId}/logo.png`]: { body: LOGO } };
    const back = await get(`/api/v1/art/steam/${appId}/logo`);
    expect(back.status).toBe(200); expect(same(back.bytes, LOGO)).toBe(true);
  });

  test("a logo is looked at again after a week; when Steam does not answer then, the one we have stays", async () => {
    cdn[`${ASSETS}steam/apps/${ROGER}/logo_2x.png`] = { body: LOGO };
    expect((await get(`/api/v1/art/steam/${ROGER}/logo`)).status).toBe(200);
    now += LOGO_TTL.found + 1000;
    for (const u of logoSources(ROGER)) cdn[u] = { down: true };
    asked = [];
    const r = await get(`/api/v1/art/steam/${ROGER}/logo`);
    expect(heads().length).toBe(6);
    expect(r.status).toBe(200); expect(same(r.bytes, LOGO)).toBe(true);
  });

  test("a game without a Steam app has no logo, and nobody is asked", async () => {
    setLibrary([game(20, "Bloodborne")]);
    expect((await get("/api/v1/art/game/20/logo")).status).toBe(404);
    expect((await get("/api/v1/art/game/999/logo")).status).toBe(404);          // not in the library
    expect((await get("/api/v1/art/steam/abc/logo")).status).toBe(404);
    expect(asked).toEqual([]);
  });
});

describe("what is held in memory is bounded (the ids come from session-free URLs)", () => {
  const was = memoLimit.max;
  afterAll(() => { memoLimit.max = was; });

  test("logo records: past the limit the oldest go, and only their copies on disk answer for them", async () => {
    memoLimit.max = 3;
    const lookFile = (appId: number) => logoFile(appId).replace(/\.png$/, ".look.json");
    const appOf = (u: string) => Number(/\/apps\/(\d+)\//.exec(u)![1]);
    for (const id of [9001, 9002, 9003, 9004, 9005]) expect((await get(`/api/v1/art/steam/${id}/logo`)).status).toBe(404);
    for (const id of [9001, 9002, 9003, 9004, 9005]) rmSync(lookFile(id));                     // from here only memory remembers the misses
    asked = []; tableCalls = [];
    for (const id of [9005, 9004, 9003]) expect((await get(`/api/v1/art/steam/${id}/logo`)).status).toBe(404);
    expect(asked).toEqual([]); expect(tableCalls).toEqual([]);                                  // the newest three are still held
    for (const id of [9002, 9001]) await get(`/api/v1/art/steam/${id}/logo`);
    expect([...new Set(heads().map(appOf))]).toEqual([9002, 9001]);                            // the oldest two were let go: Steam is asked again
  });

  test("failures: past the limit the oldest are let go, and only those are tried again", async () => {
    memoLimit.max = 3;
    const real = ludarr.pdeps.fetch, banners: number[] = [];
    ludarr.pdeps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const m = /\/art\/game\/(\d+)\/banner$/.exec(String(input instanceof Request ? input.url : input));
      if (m) banners.push(Number(m[1]));
      return real(input, init);
    }) as typeof fetch;
    try {
      for (const id of [801, 802, 803, 804, 805]) expect((await get(`/api/v1/art/game/${id}/hero`)).headers.get("x-ahoy-art")).toBe("placeholder");
      expect(banners).toEqual([801, 802, 803, 804, 805]);
      banners.length = 0;
      for (const id of [805, 804, 803, 802, 801]) await get(`/api/v1/art/game/${id}/hero`);
      expect(banners).toEqual([802, 801]);                                                        // 803-805 are still held for a day
    } finally { ludarr.pdeps.fetch = real; }
  });
});

/* ─────────── heroes ─────────── */

describe("the hero: logo-free key art", () => {
  test("a library game: Steam's library hero for its steamAppId", async () => {
    setLibrary([game(28, "and Roger", { steamAppId: ROGER })]);
    arts[ROGER] = { portrait: null, hero: heroUrl(ROGER), cardWide: headerUrl(ROGER) };
    cdn[heroUrl(ROGER)] = { body: HERO, type: "image/jpeg" };
    banners[28] = { body: CAPSULE };
    const r = await get("/api/v1/art/game/28/hero");
    expect(r.status).toBe(200); expect(r.type).toBe("image/jpeg");
    expect(same(r.bytes, HERO)).toBe(true);
    expect(gets()).toEqual([heroUrl(ROGER)]);
  });

  test("Steam has only the store header (it carries the logo): ludarr's banner instead, the header never fetched", async () => {
    setLibrary([game(28, "and Roger", { steamAppId: ROGER })]);
    banners[28] = { body: CAPSULE };
    const r = await get("/api/v1/art/game/28/hero");
    expect(same(r.bytes, CAPSULE)).toBe(true);
    expect(artCalls).toEqual([ROGER]);
    expect(asked).toEqual([]);
  });

  test("the library hero would not load: ludarr's banner", async () => {
    setLibrary([game(28, "and Roger", { steamAppId: ROGER })]);
    arts[ROGER] = { portrait: null, hero: heroUrl(ROGER), cardWide: headerUrl(ROGER) };
    banners[28] = { body: CAPSULE };
    expect(same((await get("/api/v1/art/game/28/hero")).bytes, CAPSULE)).toBe(true);
    expect(gets()).toEqual([heroUrl(ROGER)]);
  });

  test("a game that is not on Steam: ludarr's banner, Steam not asked", async () => {
    setLibrary([game(20, "Bloodborne")]);
    banners[20] = { body: CAPSULE };
    expect(same((await get("/api/v1/art/game/20/hero")).bytes, CAPSULE)).toBe(true);
    expect(artCalls).toEqual([]);
  });

  test("nothing anywhere (ludarr has only its placeholder): a blank dark placeholder without the title", async () => {
    setLibrary([game(20, "Bloodborne")]);
    banners[20] = { body: new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg">${"x".repeat(500)}</svg>`), type: "image/svg+xml" };
    const r = await get("/api/v1/art/game/20/hero");
    expect(r.status).toBe(200);
    expect(r.type).toBe("image/svg+xml");
    expect(r.headers.get("x-ahoy-art")).toBe("placeholder");
    const svg = new TextDecoder().decode(r.bytes);
    expect(svg).not.toContain("<text"); expect(svg).not.toContain("Bloodborne");
    expect((await get("/api/v1/art/game/abc/hero")).headers.get("x-ahoy-art")).toBe("placeholder");
    expect((await get("/api/v1/art/game/20/meta")).json).toEqual({ hero: null, logo: null });
  });

  test("a Steam app: its library hero; a header-only app gets the placeholder, unless it is a library game ludarr has a banner for", async () => {
    arts[ROGER] = { portrait: null, hero: heroUrl(ROGER), cardWide: headerUrl(ROGER) };
    cdn[heroUrl(ROGER)] = { body: HERO, type: "image/jpeg" };
    expect(same((await get(`/api/v1/art/steam/${ROGER}/hero`)).bytes, HERO)).toBe(true);
    const bare = await get("/api/v1/art/steam/1868140/hero");
    expect(bare.headers.get("x-ahoy-art")).toBe("placeholder");
    expect(gets()).not.toContain(headerUrl(1868140));
    setLibrary([game(8, "DAVE THE DIVER", { steamAppId: 1868140 })]);
    banners[8] = { body: CAPSULE };
    expect(same((await get("/api/v1/art/steam/1868140/hero")).bytes, CAPSULE)).toBe(true);
  });

  test("the placeholders are neutral greys, never the old navy", () => {
    for (const kind of ["poster", "banner", "hero"] as const) {
      const svg = placeholderSvg("Hollow Knight", kind);
      expect(svg).not.toMatch(/#(1a1e28|0b0d14|232835|7a8296)/i);
      for (const [, hex] of svg.matchAll(/#([0-9a-f]{6})/gi)) {
        const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
        expect(Math.max(r, g, b) - Math.min(r, g, b)).toBe(0);
      }
    }
    expect(placeholderSvg("Hollow Knight", "poster")).toContain("Hollow Knight");
  });
});

/* ─────────── meta ─────────── */

describe("meta: numbers measured from the files", () => {
  test("the real hero and logo of a Steam app (the logo is dark line art: it does not read, so the spotlight sets the title)", async () => {
    arts[ROGER] = { portrait: null, hero: heroUrl(ROGER), cardWide: headerUrl(ROGER) };
    cdn[heroUrl(ROGER)] = { body: HERO, type: "image/jpeg" };
    cdn[`${ASSETS}steam/apps/${ROGER}/logo_2x.png`] = { body: LOGO };
    const r = await get(`/api/v1/art/steam/${ROGER}/meta`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("max-age");
    const { hero, logo } = r.json;
    expect(hero.w).toBe(3840); expect(hero.h).toBe(1240);
    expect(Math.abs(hero.mean - 194.4)).toBeLessThan(0.3);
    expect(logo).toEqual({ w: 1280, h: 720, box: { x: 30, y: 275, w: 1220, h: 204 }, readable: 0 });
  });

  test("a library game's meta follows its hero chain: the capsule-sized banner from ludarr when Steam has only a header", async () => {
    setLibrary([game(28, "and Roger", { steamAppId: ROGER })]);
    banners[28] = { body: CAPSULE };
    cdn[`${ASSETS}steam/apps/${ROGER}/logo_2x.png`] = { body: LOGO };
    const { hero, logo } = (await get("/api/v1/art/game/28/meta")).json;
    expect(hero.w).toBe(600); expect(hero.h).toBe(900);
    expect(Math.abs(hero.mean - 161.83)).toBeLessThan(0.3);
    expect(logo.box).toEqual({ x: 30, y: 275, w: 1220, h: 204 });
    setLibrary([game(20, "Bloodborne")]);
    banners[20] = { body: HERO };
    expect((await get("/api/v1/art/game/20/meta")).json).toMatchObject({ hero: { w: 3840, h: 1240 }, logo: null });
    expect((await get("/api/v1/art/game/x/meta")).status).toBe(404);
    expect((await get("/api/v1/art/steam/0/meta")).status).toBe(404);
  });

  test("the logo numbers: the opaque box (alpha 128 and up) and the share that reaches 3:1 against #101010", async () => {
    const png = await syntheticLogo();
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(logoNumbers(new Uint8Array(data), info.width, info.height)).toEqual({ w: 200, h: 100, ...SYNTH });
    expect(logoNumbers(new Uint8Array(data), info.width, info.height, { minAlpha: 16 })!.box).toEqual({ x: 20, y: 5, w: 170, h: 65 });
    expect(logoNumbers(new Uint8Array(200 * 100 * 4), 200, 100)).toBeNull();     // nothing opaque: no logo to show
    const real = await sharp(LOGO).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(logoNumbers(new Uint8Array(real.data), 1280, 720, { minAlpha: 16, minLine: 1 })!.box).toEqual({ x: 30, y: 275, w: 1220, h: 205 });   // the plain box, as the boards' manifest has it
    cdn[`${ASSETS}steam/apps/1/logo_2x.png`] = { body: png };
    expect((await get("/api/v1/art/steam/1/meta")).json.logo).toEqual({ w: 200, h: 100, ...SYNTH });
  });

  test("a stray opaque pixel of a faded stroke does not move the box's edge; two in a line do", () => {
    // DARK SOULS III's logo, in small: a faded rule (alpha 100) across the whole width with three pixels of it over 128, one per column, well left of the D
    const w = 120, h = 40, px = new Uint8Array(w * h * 4);
    const dot = (x: number, y: number, a: number) => px.set([255, 255, 255, a], (y * w + x) * 4);
    for (let x = 0; x < w; x++) dot(x, 20, 100);
    for (const x of [14, 15, 16]) dot(x, 20, 150);
    for (let y = 8; y < 32; y++) for (let x = 31; x < 100; x++) dot(x, y, 255);       // the letters
    expect(logoNumbers(px, w, h)!.box).toEqual({ x: 31, y: 8, w: 69, h: 24 });
    expect(logoNumbers(px, w, h, { minLine: 1 })!.box).toEqual({ x: 14, y: 8, w: 86, h: 24 });
    dot(5, 10, 255); dot(5, 11, 255);                                                  // a 2-pixel mark is part of the logo
    expect(logoNumbers(px, w, h)!.box).toEqual({ x: 5, y: 8, w: 95, h: 24 });
    const lone = new Uint8Array(4 * 4 * 4); lone.set([255, 255, 255, 255], (2 * 4 + 1) * 4);
    expect(logoNumbers(lone, 4, 4)).toEqual({ w: 4, h: 4, box: { x: 1, y: 2, w: 1, h: 1 }, readable: 1 });   // a single pixel is still a box
  });

  test("the hero's mean is the Rec. 709 luma of every pixel, 0-255; a transparent ground counts as the page", async () => {
    const pink = (alpha: boolean) => {
      const px = new Uint8Array(64 * 32 * 4);
      for (let i = 0; i < 64 * 32; i++) px.set([255, 105, 180, alpha && i % 64 >= 32 ? 0 : 255], i * 4);
      return sharp(px, { raw: { width: 64, height: 32, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
    };
    expect(meanLuma(new Uint8Array([255, 105, 180, 0, 0, 0]))).toBeCloseTo((0.2126 * 255 + 0.7152 * 105 + 0.0722 * 180) / 2, 6);
    setLibrary([game(1, "Pink"), game(2, "Half pink")]);
    banners[1] = { body: new Uint8Array(await pink(false)), type: "image/png" };
    banners[2] = { body: new Uint8Array(await pink(true)), type: "image/png" };
    expect((await get("/api/v1/art/game/1/meta")).json.hero).toEqual({ w: 64, h: 32, mean: 142.3 });
    expect((await get("/api/v1/art/game/2/meta")).json.hero).toEqual({ w: 64, h: 32, mean: 79.2 });   // half pink, half #101010 (luma 16)
  });

  test("kept in memory and beside the file, and measured again when the file changes", async () => {
    cdn[`${ASSETS}steam/apps/${ROGER}/logo_2x.png`] = { body: LOGO };
    expect((await get(`/api/v1/art/steam/${ROGER}/meta`)).json.logo.readable).toBe(0);
    const side = `${logoFile(ROGER)}.meta.json`;
    expect(existsSync(side)).toBe(true);
    const kept = JSON.parse(readFileSync(side, "utf8"));
    expect(kept.value).toEqual({ w: 1280, h: 720, box: { x: 30, y: 275, w: 1220, h: 204 }, readable: 0 });
    writeFileSync(side, JSON.stringify({ ...kept, value: { ...kept.value, readable: 0.5 } }));
    expect((await get(`/api/v1/art/steam/${ROGER}/meta`)).json.logo.readable).toBe(0);   // memory first
    artMemory.forget();
    expect((await get(`/api/v1/art/steam/${ROGER}/meta`)).json.logo.readable).toBe(0.5); // then the copy beside the file
    writeFileSync(logoFile(ROGER), await syntheticLogo());                               // the source changes
    expect((await get(`/api/v1/art/steam/${ROGER}/meta`)).json.logo).toEqual({ w: 200, h: 100, ...SYNTH });
  });
});

describe("ids are plain positive integers", () => {
  test("1e3, 0x10, +5, 031, 12.0, 0, -4 and ids past 32 bits are no app: nothing is asked of Steam or ludarr", async () => {
    setLibrary([game(16, "Hollow Knight", { steamAppId: 367520 }), game(1000, "Thousand", { steamAppId: 1000 })]);
    for (const bad of ["1e3", "0x10", "+5", "031", "12.0", "0", "-4", "4294967296", "99999999999999999999", "16abc"]) {
      expect((await get(`/api/v1/art/steam/${bad}/logo`)).status).toBe(404);
      expect((await get(`/api/v1/art/steam/${bad}/meta`)).json).toEqual({ error: "no such app" });
      expect((await get(`/api/v1/art/steam/${bad}/hero`)).headers.get("x-ahoy-art")).toBe("placeholder");
      expect((await get(`/api/v1/art/steam/${bad}/poster`)).headers.get("x-ahoy-art")).toBe("placeholder");
      expect((await get(`/api/v1/art/steam/${bad}/spotlight`)).status).toBe(404);
    }
    // a library game's id is ludarr's, not Steam's: past 32 bits is still an id (an unknown game), the other spellings are not
    for (const bad of ["1e3", "0x10", "+5", "031", "12.0", "0", "-4", "99999999999999999999", "16abc"]) {
      expect((await get(`/api/v1/art/game/${bad}/meta`)).status).toBe(404);
      expect((await get(`/api/v1/art/game/${bad}/hero`)).headers.get("x-ahoy-art")).toBe("placeholder");
      expect((await get(`/api/v1/art/game/${bad}/poster`)).headers.get("x-ahoy-art")).toBe("placeholder");
      expect((await get(`/api/v1/art/game/${bad}/card`)).status).toBe(404);
      expect((await get(`/api/v1/art/game/${bad}/spotlight`)).status).toBe(404);
    }
    expect(asked).toEqual([]); expect(tableCalls).toEqual([]); expect(artCalls).toEqual([]);
    // the plain spelling of the same numbers is an id
    expect((await get("/api/v1/art/steam/1000/meta")).status).toBe(200);
    expect((await get("/api/v1/art/game/16/meta")).status).toBe(200);
  });
  test("a placeholder poster carries a real name or none, never \"app <id>\"", async () => {
    const { stmts } = await import("../src/db");
    stmts.catalogTouch.run(292030, "app 292030");
    const named = new TextDecoder().decode((await get("/api/v1/art/steam/292030/poster?n=The%20Witcher%203")).bytes);
    expect(named).toContain("Witcher"); expect(named).not.toContain("app 292030");
    const bare = new TextDecoder().decode((await get("/api/v1/art/steam/292030/poster")).bytes);
    expect(bare).not.toMatch(/app 292030|>292030</);
  });
});

describe("the older art routes keep their shape", () => {
  test("poster and banner still come through ludarr; any other word is not an art route", async () => {
    setLibrary([game(28, "and Roger", { steamAppId: ROGER })]);
    banners[28] = { body: CAPSULE };
    const b = await get("/api/v1/art/game/28/banner");
    expect(b.status).toBe(200); expect(same(b.bytes, CAPSULE)).toBe(true);
    const p = await get("/api/v1/art/game/28/poster");
    expect(p.headers.get("x-ahoy-art")).toBe("placeholder");                   // ludarr has no poster for it here
    const other = await get("/api/v1/art/game/28/nonsense");
    expect(other.status).not.toBe(200); expect(other.type).not.toMatch(/^image\//);
  });
});

describe("smaller copies for small slots, and catalog covers", () => {
  test("?w= serves a smaller WebP copy (rounded up to a fixed width, never enlarged), kept on disk and made again when the original changes", async () => {
    setLibrary([game(28, "and Roger", { steamAppId: ROGER })]);
    banners[28] = { body: CAPSULE };                                             // the 600 x 900 capsule stands in for the banner
    const full = await get("/api/v1/art/game/28/banner");
    const small = await get("/api/v1/art/game/28/banner?w=90");
    expect(small.status).toBe(200); expect(small.type).toBe("image/webp");
    expect(small.headers.get("cache-control")).toBe("public, max-age=86400");
    const meta = await sharp(small.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([96, 144]);                        // 90 asks for the next width, 96
    expect(small.bytes.length).toBeLessThan(full.bytes.length / 4);
    expect((await sharp((await get("/api/v1/art/game/28/banner?w=5000")).bytes).metadata()).width).toBe(600);
    for (const w of ["abc", "-5", "0", "1e3", ""]) expect(same((await get(`/api/v1/art/game/28/banner?w=${w}`)).bytes, full.bytes)).toBe(true);
    // the original changes (ludarr's banner is read again): the copy is made again from it
    const original = join(configDir(), "art", `${createHash("sha1").update("ludarr:game:28:banner").digest("hex").slice(0, 24)}.jpg`);
    expect(existsSync(original)).toBe(true);
    await new Promise(r => setTimeout(r, 20));
    writeFileSync(original, HERO);
    const again = await sharp((await get("/api/v1/art/game/28/banner?w=96")).bytes).metadata();
    expect([again.width, again.height]).toEqual([96, 31]);
    // a placeholder stays the SVG
    expect((await get("/api/v1/art/game/28/poster?w=96")).type).toBe("image/svg+xml");
  });
  test("a card's cut-out as WebP: the same size, its alpha exact (the cut edge does not move), kept beside the PNG", async () => {
    const png = await syntheticLogo(), dir = join(configDir(), "art"), p = join(dir, "cutout-test.png");
    mkdirSync(dir, { recursive: true }); writeFileSync(p, png);
    const w = await webpCopy({ path: p, type: "image/png" });
    expect(w).toEqual({ path: `${p}.webp`, type: "image/webp" });
    const a = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const b = await sharp(readFileSync(w.path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([b.info.width, b.info.height]).toEqual([a.info.width, a.info.height]);
    let differ = 0;
    for (let i = 3; i < a.data.length; i += 4) if (a.data[i] !== b.data[i]) differ++;
    expect(differ).toBe(0);
    expect(await webpCopy({ path: `${p}.webp`, type: "image/webp" })).toEqual({ path: `${p}.webp`, type: "image/webp" });   // already WebP: as it is
  });
  test("a catalog title's cover comes through ludarr, without a session; none is the placeholder with the name the page sends", async () => {
    titles[77] = { body: CAPSULE };
    const t = await get("/api/v1/art/title/77/poster");
    expect(t.status).toBe(200); expect(same(t.bytes, CAPSULE)).toBe(true);
    const none = await get("/api/v1/art/title/78/poster?n=Ico");
    expect(none.headers.get("x-ahoy-art")).toBe("placeholder");
    expect(new TextDecoder().decode(none.bytes)).toContain("Ico");
    expect((await get("/api/v1/art/title/0x4d/poster")).headers.get("x-ahoy-art")).toBe("placeholder");
  });
});

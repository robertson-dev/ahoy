/** steam: the store's asset call is shared — between parallel requests for one app, and between its hero and its logo lookup — and
 * art guessed while that call failed holds only a quarter of an hour; appdetails tells "no such app" from "no answer". */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ART_UNANSWERED_MS, _steamTest, sdeps, steamArt, steamArtMany, steamAssetsShared, steamDetails, type AppArt, type SteamAssets } from "../src/steam";

const real = { ...sdeps }, realFetch = globalThis.fetch;
const table = (appId: number): SteamAssets => ({ asset_url_format: `steam/apps/${appId}/\${FILENAME}?t=1`, library_hero_2x: "h/library_hero_2x.jpg", library_capsule_2x: "c/library_capsule_2x.jpg", header: "x/header.jpg" });
let calls: number[][] = [], legacy: number[] = [], now = 1_800_000_000_000, down = false, slow = 0;

beforeEach(() => {
  _steamTest.forget();
  calls = []; legacy = []; now = 1_800_000_000_000; down = false; slow = 0;
  sdeps.now = () => now;
  sdeps.assets = async ids => { calls.push([...ids]); if (slow) await new Promise(r => setTimeout(r, slow)); if (down) throw new Error("STEAM_HTTP_503"); return new Map(ids.map(id => [id, table(id)])); };
  sdeps.legacy = async (id, header) => { legacy.push(id); const h = header || `https://cdn/steam/apps/${id}/header.jpg`; return { portrait: null, hero: h, cardWide: h } satisfies AppArt; };
});
afterAll(() => { Object.assign(sdeps, real); globalThis.fetch = realFetch; _steamTest.forget(); });

describe("the store's asset call is shared", () => {
  test("ten requests for one app at once make one call; later ones are answered from memory", async () => {
    slow = 30;
    const arts = await Promise.all(Array.from({ length: 10 }, () => steamArt(42)));
    expect(calls).toEqual([[42]]);
    expect(new Set(arts.map(a => a.hero)).size).toBe(1);
    expect(arts[0].hero).toContain("/library_hero_2x.jpg");
    await steamArt(42);
    expect(calls.length).toBe(1);
    // an app the store does not list: one call, and one probe of the legacy paths, for all ten
    const unlisted = sdeps.assets;
    sdeps.assets = async ids => { calls.push([...ids]); await new Promise(r => setTimeout(r, 30)); return new Map(); };
    await Promise.all(Array.from({ length: 10 }, () => steamArt(43)));
    expect(calls.slice(1)).toEqual([[43]]);
    expect(legacy).toEqual([43]);
    sdeps.assets = unlisted;
  });
  test("a hero lookup and a logo lookup for one app share the call; a batch asks only for what nobody is asking about yet", async () => {
    slow = 30;
    const [art, assets] = await Promise.all([steamArt(7), steamAssetsShared([7])]);
    expect(calls).toEqual([[7]]);
    expect(assets.get(7)).toEqual(table(7));
    expect(art.portrait).toContain("library_capsule_2x");
    const many = steamArtMany([7, 8, 9]);
    const again = steamArtMany([9, 10]);
    await Promise.all([many, again]);
    expect(calls).toEqual([[7], [8, 9], [10]]);
  });
});

describe("a failed asset call is not remembered for long", () => {
  test("while the store does not answer, the legacy guess (the header as the hero) holds a quarter of an hour, then the store is asked again", async () => {
    down = true;
    const guess = await steamArt(5);
    expect(guess.hero).toContain("header.jpg");                         // what made /hero serve the banner until a restart
    expect(legacy).toEqual([5]);
    down = false;
    expect((await steamArt(5)).hero).toContain("header.jpg");            // still within the quarter hour: no call
    expect(calls.length).toBe(1);
    now += ART_UNANSWERED_MS + 1;
    expect((await steamArt(5)).hero).toContain("/library_hero_2x.jpg");  // asked again: the real library hero
    expect(calls.length).toBe(2);
    now += 30 * 86_400_000;
    await steamArt(5);
    expect(calls.length).toBe(2);                                        // an answered call is kept
  });
  test("the shared table call keeps nothing when it fails: the next lookup asks again", async () => {
    down = true;
    await expect(steamAssetsShared([11])).rejects.toThrow();
    down = false;
    expect((await steamAssetsShared([11])).get(11)).toEqual(table(11));
    expect(calls).toEqual([[11], [11]]);
  });
});

describe("appdetails", () => {
  const reply = (status: number, body: string) => { let n = 0; globalThis.fetch = (async () => { n++; return new Response(body, { status, headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch; return () => n; };
  test("the store's own no (success: false) is null; its details are the details", async () => {
    let asked = reply(200, JSON.stringify({ 99: { success: false } }));
    expect(await steamDetails(99)).toBeNull();
    expect(asked()).toBe(1);
    asked = reply(200, JSON.stringify({ 292030: { success: true, data: { type: "game", name: "The Witcher 3: Wild Hunt", steam_appid: 292030 } } }));
    expect((await steamDetails(292030))!.name).toBe("The Witcher 3: Wild Hunt");
  });
  test("no answer — throttled (429), or a body of \"null\" — throws after one retry: nothing may be remembered from it", async () => {
    let asked = reply(429, "Too Many Requests");
    await expect(steamDetails(292030)).rejects.toThrow(/429/);
    expect(asked()).toBe(2);
    asked = reply(200, "null");
    await expect(steamDetails(292030)).rejects.toThrow(/NO_ANSWER/);
    expect(asked()).toBe(2);
  });
});

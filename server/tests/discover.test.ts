import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { game, setLibrary, wipe } from "./helpers";
import { parseReleaseText, daysUntil, parseFeedHtml, feedRows, discover, discoverGenre, discoverList, enrichCatalog, ddeps, appDetail, reviewsOf, toItem, _reviewsTest, type Feed } from "../src/discover";
import { knownName } from "../src/names";
import { cdeps, checkApp, crackTick } from "../src/crack";
import { db, kv, stmts } from "../src/db";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "steam-search-rows.html"), "utf8");
const details = (appid: number, over: Record<string, unknown> = {}) => ({
  type: "game", name: `App ${appid}`, steam_appid: appid, short_description: "nice", genres: [{ id: "1", description: "Action" }],
  release_date: { coming_soon: true, date: "Oct 28, 2026" }, metacritic: { score: 80 }, header_image: "h.jpg", ...over,
}) as any;

let now = Date.parse("2026-10-14T12:00:00Z");
let feeds: Partial<Record<Feed, string>> = {};
let detailCalls: number[] = [];
let detailMap: Record<number, any> = {};

beforeEach(() => {
  wipe();
  now = Date.parse("2026-10-14T12:00:00Z"); feeds = {}; detailCalls = []; detailMap = {};
  ddeps.now = () => now; ddeps.log = () => {};
  ddeps.fetchFeed = async f => { if (feeds[f] == null) throw new Error("feed down"); return feeds[f]!; };
  ddeps.details = async id => { detailCalls.push(id); return detailMap[id] ?? null; };
  ddeps.art = async ids => new Map(ids.map(id => [id, { portrait: id % 2 ? `p${id}` : null, hero: "h", cardWide: "c" }]));
  cdeps.now = () => now; cdeps.log = () => {};
});

describe("release dates", () => {
  test("exact, monthly, quarterly, seasonal, yearly, unknown", () => {
    expect(parseReleaseText("Oct 15, 2026")).toEqual({ text: "Oct 15, 2026", iso: "2026-10-15", sort: "2026-10-15", precision: "day" });
    expect(parseReleaseText("15 Oct, 2026").iso).toBe("2026-10-15");
    expect(parseReleaseText("November 2026")).toMatchObject({ iso: null, sort: "2026-11-30", precision: "month" });
    expect(parseReleaseText("Q1 2027")).toMatchObject({ sort: "2027-03-31", precision: "quarter" });
    expect(parseReleaseText("2027")).toMatchObject({ sort: "2027-12-31", precision: "year" });
    expect(parseReleaseText("Coming soon")).toMatchObject({ iso: null, sort: null, precision: "tba" });
    expect(daysUntil("2026-10-28", now)).toBe(14);
  });
});

describe("feeds", () => {
  test("rows from the store's html; cached, served stale when Steam is down, refreshed when old", async () => {
    const rows = parseFeedHtml(fixture);
    expect(rows.length).toBe(3);
    expect(rows.find(r => r.appId === 730)!.name).toBe("Counter-Strike 2");
    feeds.popularnew = fixture;
    const a = await feedRows("popularnew", 50);
    expect(a.rows.length).toBe(3); expect(a.stale).toBe(false);
    feeds.popularnew = undefined;
    expect((await feedRows("popularnew", 50)).stale).toBe(false);
    now += 2 * 3600_000;
    expect((await feedRows("popularnew", 50)).stale).toBe(true);
    expect((await feedRows("topsellers", 50)).rows).toEqual([]);
  });
});

/** one row of the store's search results, the way parseFeedHtml reads it: the tags the store prints are the game's main ones */
const feedRow = (appId: number, name: string, tagIds: number[], reviews = 0) =>
  `<a href="https://store.steampowered.com/app/${appId}/" data-ds-appid="${appId}" data-ds-tagids="[${tagIds.join(",")}]"><span class="title">${name}</span><div class="search_released">Jan 1, 2020</div>` +
  (reviews ? `<span class="search_review_summary positive" data-tooltip-html="Very Positive&lt;br&gt;90% of the ${reviews.toLocaleString("en-US")} user reviews for this game are positive."></span>` : "") + `<img src="c${appId}.jpg"></a>`;

describe("browse by genre", () => {
  test("two rows per genre — loved by players (most reviewed first) and selling now — only games that carry the tag among their main ones; junk, the store's subscription and DLC fall away", async () => {
    const puzzle = 1664;
    const sellers = [feedRow(1, "Big Walk", [puzzle, 19], 500), feedRow(2, "HITMAN World of Assassination", [19, 21], 90_000), feedRow(3, "EA Play", [puzzle], 10),
      feedRow(4, "Teardown Soundtrack", [puzzle], 5), feedRow(5, "Teardown", [599, puzzle], 60_000), feedRow(6, "Some DLC", [puzzle], 1)].join("");
    const rated = [feedRow(7, "Poco", [puzzle], 7_293), feedRow(8, "Portal 2", [1685, puzzle], 174_844), feedRow(9, "Vampire Survivors", [19], 128_537), feedRow(10, "Portal", [puzzle], 85_169)].join("");
    const asked: string[] = [];
    ddeps.fetchFeed = async (f, count, tags) => { asked.push(`${f}:${count}:${tags}`); if (tags !== puzzle) throw new Error("feed down"); return f === "topsellers" ? sellers : f === "toprated" ? rated : ""; };
    const names = ["Big Walk", "HITMAN World of Assassination", "EA Play", "Teardown Soundtrack", "Teardown", "Some DLC", "Poco", "Portal 2", "Vampire Survivors", "Portal"];
    for (let id = 1; id <= 10; id++) detailMap[id] = details(id, { name: names[id - 1], type: id === 6 ? "dlc" : "game", release_date: { coming_soon: false, date: "Jan 1, 2020" } });
    await enrichCatalog(Array.from({ length: 10 }, (_, i) => i + 1), 10, 0);
    const g = await discoverGenre(puzzle);
    expect(asked).toEqual(["topsellers:100:1664", "toprated:100:1664"]);
    expect(g.rated.map(i => i.name)).toEqual(["Portal 2", "Portal", "Poco"]);                       // by review count; Vampire Survivors only carries the tag far down
    expect(g.sellers.map(i => i.name)).toEqual(["Big Walk", "Teardown"]);                           // in the store's order; HITMAN is no puzzle game, the rest is not a game
    expect(g.rated[0]).toMatchObject({ appId: 8, reviewCount: 174_844, reviewPct: 90, reviewSummary: "Very Positive", portrait: null, releaseIso: "2020-01-01" });
    expect(g.sellers[0]).toMatchObject({ appId: 1, portrait: "p1", img: "h.jpg" });
    expect(g.stale).toBe(false);
    await discoverGenre(puzzle);
    expect(asked.length).toBe(2);                                                                    // both feeds are cached
    const rows = await discoverGenre(701);                                                           // a genre whose feeds are down: empty rows, marked stale, no throw
    expect(rows.rated).toEqual([]); expect(rows.sellers).toEqual([]); expect(rows.stale).toBe(true);
    await expect(discoverGenre(1)).rejects.toThrow(/not one of the genre rows/);
  });
});

describe("a whole row, page by page", () => {
  test("a row's list reads the feed from a start offset, 50 a page, and says whether a next page may exist; genre lists and the playable list page too", async () => {
    const asked: string[] = [];
    const page = (from: number, n: number, tagIds: number[] = []) => Array.from({ length: n }, (_, k) => feedRow(from + k, `Game ${from + k}`, tagIds, 100 + k)).join("");
    ddeps.fetchFeed = async (f, count, tags, start = 0) => { asked.push(`${f}:${count}:${tags}:${start}`); if (f === "topsellers" && !tags) return start === 0 ? page(1, 50) : page(51, 20); if (f === "toprated" && tags === 1664) return start === 0 ? page(1000, 100, [1664]) : page(1100, 10, [1664]); throw new Error("feed down"); };
    const p0 = await discoverList("top", 0);
    expect(p0).toMatchObject({ key: "top", title: "Top sellers", page: 0, more: true });
    expect(p0.items.length).toBe(50); expect(p0.items[0].name).toBe("Game 1");
    const p1 = await discoverList("top", 1);
    expect(p1.items.map(i => i.name).slice(0, 2)).toEqual(["Game 51", "Game 52"]); expect(p1.more).toBe(false);
    expect(asked).toEqual(["topsellers:50:undefined:0", "topsellers:50:undefined:50"]);
    const g0 = await discoverList("genre:1664:rated", 0);
    expect(g0.title).toBe("Puzzle · loved by players"); expect(g0.items.length).toBe(100); expect(g0.more).toBe(true);
    expect(g0.items[0].name).toBe("Game 1099");                                                  // most reviewed first
    const g1 = await discoverList("genre:1664:rated", 1);
    expect(g1.items.length).toBe(10); expect(g1.more).toBe(false);
    expect(asked.slice(2)).toEqual(["toprated:100:1664:0", "toprated:100:1664:100"]);
    expect((await discoverList("new", 0)).items).toEqual([]);                                     // a feed that is down: an empty page, no throw
    await expect(discoverList("genre:1:rated", 0)).rejects.toThrow(/not one of the genre rows/);
    await expect(discoverList("whatever", 0)).rejects.toThrow(/not one of the rows/);
    // the playable list comes from the catalog, newest verdict first, 50 a page
    for (let i = 1; i <= 60; i++) { detailMap[5000 + i] = details(5000 + i, { name: `Cracked ${i}`, release_date: { coming_soon: false, date: "Jan 1, 2020" } }); }
    await enrichCatalog(Array.from({ length: 60 }, (_, i) => 5001 + i), 60, 0);
    for (let i = 1; i <= 60; i++) stmts.catalogCrack.run("Denuvo", "cracked", `2026-01-${String(Math.min(28, i)).padStart(2, "0")}`, "RUNE", 5000 + i);
    const c0 = await discoverList("playable", 0);
    expect(c0.items.length).toBe(50); expect(c0.more).toBe(true); expect(c0.items[0].crackDate).toBe("2026-01-28");
    const c1 = await discoverList("playable", 1);
    expect(c1.items.length).toBe(10); expect(c1.more).toBe(false);
  });
});

describe("discover + catalog + library", () => {
  test("sections merge feed rows with catalog details and the ludarr library (verdict from the library game when it is there)", async () => {
    feeds.popularcomingsoon = fixture; feeds.popularnew = fixture; feeds.topsellers = fixture;
    detailMap[730] = details(730, { name: "Counter-Strike 2", release_date: { coming_soon: false, date: "Sep 27, 2023" } });
    expect(await enrichCatalog([730, 999], 5, 0)).toBe(2);
    expect(await enrichCatalog([730], 5, 0)).toBe(0);
    setLibrary([game(3, "Counter-Strike 2", { steamAppId: 730, tracked: true, drm: "Steam", crackStatus: "cracked", request: { id: 1, gameId: 3, state: "ready", stage: "", progress: 1, message: null, attempt: 0, candidates: 1, createdAt: 0, updatedAt: 0, doneAt: null, release: null } })]);
    const { sections } = await discover();
    expect(sections.map(s => s.key)).toEqual(["coming_soon", "new", "top"]);
    const cs = sections[2].items.find(i => i.appId === 730)!;
    expect(cs).toMatchObject({ name: "Counter-Strike 2", inLibrary: true, gameId: 3, followed: true, requestState: "ready", comingSoon: false, metacritic: 80, genres: ["Action"], releaseIso: "2023-09-27", crackStatus: "cracked", drm: null, crackGroup: null, img: "h.jpg" });   // the verdict only: no protection or group names for players
    expect(sections[2].items.find(i => i.appId !== 730)).toMatchObject({ inLibrary: false, followed: false, metacritic: null, crackStatus: null });
    expect(sections[1].items.some(i => i.appId === 730)).toBe(false);
  });
});

describe("verdicts from ludarr", () => {
  test("a storefront game's crack status is asked once, kept on the catalog row, re-asked after the TTL; library games are not asked", async () => {
    kv.set("cfg.LUDARR_URL", "http://engine"); kv.set("cfg.LUDARR_API_KEY", "k");
    let asked: string[] = [];
    cdeps.find = async title => { asked.push(title); return title === "App 10" ? { slug: "app-10", title, status: "cracked", crackDate: "2026-10-01", drm: "Denuvo", group: "RUNE" } : null; };
    stmts.catalogUpsert.run(10, "App 10", "game", 0, null, null, null, "[]", null, null, null);
    stmts.catalogUpsert.run(11, "App 11", "game", 0, null, null, null, "[]", null, null, null);
    stmts.catalogUpsert.run(12, "Pack", "dlc", 0, null, null, null, "[]", null, null, null);
    feeds.popularcomingsoon = fixture; feeds.popularnew = fixture; feeds.topsellers = fixture;
    const r = await crackTick();
    expect(r.checked).toBe(2);
    expect(asked.sort()).toEqual(["App 10", "App 11"]);
    expect(stmts.catalogGet.get(10)).toMatchObject({ crack_status: "cracked", drm: "Denuvo", crack_group: "RUNE", crack_date: "2026-10-01" });
    expect(stmts.catalogGet.get(11)).toMatchObject({ crack_status: null });
    asked = [];
    expect(await checkApp(10)).toBe(false);                          // settled, nothing to ask
    expect(await checkApp(11)).toBe(false);                          // asked lately
    now += 7 * 3600_000;
    expect(await checkApp(11)).toBe(true); expect(await checkApp(10)).toBe(false);
    now += 8 * 86_400_000;
    expect(await checkApp(10)).toBe(true);
  });
});

describe("names and review words", () => {
  test("a lookup the store did not answer leaves nothing behind; its own no leaves a placeholder that is never shown and is asked again within the hour; three unanswered in a row end the pass", async () => {
    const asked: number[] = [];
    ddeps.details = async id => { asked.push(id); if (id === 1 || id >= 10) throw new Error("STEAM_HTTP_429"); return detailMap[id] ?? null; };
    expect(await enrichCatalog([1, 2], 5, 0)).toBe(2);
    expect(stmts.catalogGet.get(1)).toBeNull();                                         // throttled: no row, a later pass asks again
    expect((stmts.catalogGet.get(2) as any).name).toBe("app 2");                         // the store's own no: remembered
    expect([knownName("app 2"), knownName("App 2"), knownName(""), knownName(null), knownName("Portal 2")]).toEqual([null, null, null, null, "Portal 2"]);
    feeds.topsellers = feedRow(2, "Portal 2", [], 100);
    const top = (await discover()).sections.find(s => s.key === "top")!;
    expect(top.items.map(i => i.name)).toEqual(["Portal 2"]);                           // the feed's name, never the placeholder
    // the catalog stamps rows with the database's clock; set their age against this test's clock
    const age = (id: number, s: number) => db.query("UPDATE catalog SET updated_at=? WHERE steam_appid=?").run(Math.floor(now / 1000) - s, id);
    detailMap[3] = details(3, { name: "Portal" });
    await enrichCatalog([3], 5, 0);
    asked.length = 0;
    age(2, 600); age(3, 3601);
    await enrichCatalog([2, 3], 5, 0);
    expect(asked).toEqual([]);                                                           // both fresh: a placeholder for an hour, a name for a day
    age(2, 3601);
    await enrichCatalog([2, 3], 5, 0);
    expect(asked).toEqual([2]);                                                          // the placeholder is asked again after an hour
    asked.length = 0;
    expect(await enrichCatalog([10, 11, 12, 13, 14, 15], 12, 0)).toBe(3);
    expect(asked).toEqual([10, 11, 12]);                                                 // the store is throttling: the pass ends
  });
  test("review words a store row carried follow the game to rows that are not the store's (a month), including feeds cached before", async () => {
    ddeps.fetchFeed = async f => (f === "toprated" ? feedRow(8, "Portal 2", [], 174_844) : "");
    await feedRows("toprated", 100);
    expect(reviewsOf(8)).toEqual({ reviewSummary: "Very Positive", reviewPct: 90, reviewCount: 174_844 });
    const bare = { appId: 8, name: "Portal 2", releaseText: "", reviewSummary: null, reviewPct: null, reviewCount: null, capsule: null, tagIds: [], free: false };
    expect(toItem(bare, undefined, new Map(), new Set(), new Map())).toMatchObject({ reviewSummary: "Very Positive", reviewPct: 90, reviewCount: 174_844 });
    const own = { ...bare, reviewSummary: "Mixed", reviewPct: 55, reviewCount: 10 };
    expect(toItem(own, undefined, new Map(), new Set(), new Map())).toMatchObject({ reviewSummary: "Mixed", reviewPct: 55 });   // a row's own words win
    now += 31 * 86_400_000;
    expect(reviewsOf(8)).toBeNull();
    kv.set("discover.feed.popularnew", JSON.stringify({ at: now, rows: parseFeedHtml(feedRow(9, "Vampire Survivors", [], 128_537)) }));   // cached by an older server
    _reviewsTest.rereadFeeds();
    expect(reviewsOf(9)).toMatchObject({ reviewSummary: "Very Positive", reviewCount: 128_537 });
  });
  test("the game page does not keep a lookup the store did not answer: the next visit asks again", async () => {
    let n = 0;
    ddeps.details = async id => { n++; if (n === 1) throw new Error("STEAM_HTTP_429"); return details(id, { name: "Hades" }); };
    expect(await appDetail(1145360)).toBeNull();                                        // nothing known yet: not found, for now
    expect((await appDetail(1145360))!.name).toBe("Hades");
    expect(n).toBe(2);
  });
});

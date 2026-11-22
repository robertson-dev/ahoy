import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { game, http, setLibrary, signup, wipe } from "./helpers";
import { stmts } from "../src/db";
import { bestOf, browseUrl, isList, listRows, lists, mdeps, metacriticTick, parseBrowseHtml, pickSteamHit, resolveRows, resolvedApp, searchTerms, type McRow } from "../src/metacritic";
import { catalogUpsertFromDetails, ddeps, feedRows, parseSimilarHtml, similarTo } from "../src/discover";
import type { SteamSearchHit } from "../src/steam";

const metaHtml = readFileSync(join(import.meta.dir, "fixtures", "metacritic-browse-metascore.html"), "utf8");
const userHtml = readFileSync(join(import.meta.dir, "fixtures", "metacritic-browse-userscore.html"), "utf8");

const hit = (appId: number, name: string, metascore: string | null = null): SteamSearchHit => ({ appId, name, tinyImage: "", metascore, priceUsd: null });
const row = (title: string, metascore: number | null = 90, slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-")): McRow =>
  ({ rank: 1, title, slug, releaseText: "Jan 1, 2020", metascore, userscore: null, summary: null, image: null });
const details = (appid: number, over: Record<string, unknown> = {}) => ({
  type: "game", name: `App ${appid}`, steam_appid: appid, short_description: "nice", genres: [{ id: "1", description: "RPG" }],
  release_date: { coming_soon: false, date: "Mar 30, 2021" }, metacritic: { score: 80 }, header_image: `h${appid}.jpg`, ...over,
}) as any;

let now = Date.parse("2026-11-04T12:00:00Z");
let pages: Record<string, string | null> = {};
let fetched: string[] = [];
let searches: string[] = [];
let answers: Record<string, SteamSearchHit[]> = {};

beforeEach(() => {
  wipe();
  now = Date.parse("2026-11-04T12:00:00Z"); pages = {}; fetched = []; searches = []; answers = {};
  mdeps.now = () => now; mdeps.log = () => {}; mdeps.resolveDelayMs = 0;
  mdeps.fetchPage = async url => { fetched.push(url); const p = pages[url]; if (p == null) throw new Error("down"); return p; };
  mdeps.search = async term => { searches.push(term); return answers[term] ?? []; };
  ddeps.now = () => now; ddeps.log = () => {};
  ddeps.details = async () => null;
  ddeps.art = async ids => new Map(ids.map(id => [id, { portrait: `p${id}`, hero: "h", cardWide: "c" }]));
});

describe("browse pages", () => {
  test("cards: rank, title, slug, date, Metascore, blurb, box art", () => {
    const rows = parseBrowseHtml(metaHtml);
    expect(rows.map(r => r.title)).toEqual(["Disco Elysium: The Final Cut", "Half-Life 2", "Grand Theft Auto V"]);
    expect(rows[0]).toMatchObject({ rank: 1, slug: "disco-elysium-the-final-cut", releaseText: "Mar 30, 2021", metascore: 97, userscore: null });
    expect(rows[0].summary).toStartWith("Disco Elysium - The Final Cut is the definitive edition");
    expect(rows[2]).toMatchObject({ rank: 3, metascore: 96, releaseText: "Apr 13, 2015" });
  });
  test("the user-score pages carry the user score and no Metascore", () => {
    const rows = parseBrowseHtml(userHtml);
    expect(rows[0]).toMatchObject({ title: "Clair Obscur: Expedition 33", userscore: 9.6, metascore: null });
  });
  test("urls and list keys", () => {
    expect(browseUrl("all", 2)).toBe("https://www.metacritic.com/browse/game/pc/all/all-time/metascore/?platform=pc&page=2");
    expect(browseUrl("players")).toContain("/all-time/userscore/");
    expect(lists().slice(0, 3).map(l => l.key)).toEqual(["all", "players", "2026"]);
    expect(isList("2026")).toBe(true); expect(isList("2027")).toBe(false); expect(isList("top")).toBe(false);
  });
  test("lists are cached for a day; when the site is down the old copy is served, marked stale", async () => {
    pages[browseUrl("2024")] = metaHtml;
    const a = await listRows("2024");
    expect(a.rows.length).toBe(3); expect(a.stale).toBe(false); expect(fetched.length).toBe(1);
    await listRows("2024");
    expect(fetched.length).toBe(1);
    now += 25 * 3600_000; pages = {};
    const b = await listRows("2024");
    expect(b.stale).toBe(true); expect(b.rows.length).toBe(3); expect(b.at).toBe(a.at);
  });
  test("all time reads on past a full page and keeps counting", async () => {
    pages[browseUrl("all", 1)] = browsePage(50, 1); pages[browseUrl("all", 2)] = userHtml;
    expect((await listRows("all")).rows.map(r => r.rank).slice(48)).toEqual([49, 50, 51, 52]);
  });
});

describe("matching a Metacritic title to the store", () => {
  test("the same name, punctuation aside, wins; soundtracks and demos never do", () => {
    const r = row("Disco Elysium: The Final Cut", 97);
    expect(pickSteamHit(r, [hit(1233220, "Disco Elysium - The Final Cut Soundtrack", "91"), hit(632470, "Disco Elysium - The Final Cut", "97")])?.appId).toBe(632470);
    expect(pickSteamHit(r, [hit(1233220, "Disco Elysium - The Final Cut Soundtrack", "97")])).toBeNull();
  });
  test("Metacritic's year suffix is dropped; among exact names the one scored the same wins", () => {
    expect(pickSteamHit(row("Cart Life (2013)", 79), [hit(2324660, "Cart Life", "")])?.appId).toBe(2324660);
    expect(pickSteamHit(row("Half-Life 2", 96), [hit(2477290, "Half-Life 2", ""), hit(220, "Half-Life 2", "96")])?.appId).toBe(220);
  });
  test("a longer store name is accepted only when the store confirms the very same Metascore, and only one does", () => {
    const r = row("Sid Meier's Pirates!", 88);
    expect(pickSteamHit(r, [hit(3920, "Sid Meier's Pirates! Gold Plus (Classic)", "88")])?.appId).toBe(3920);
    expect(pickSteamHit(r, [hit(3920, "Sid Meier's Pirates! Gold Plus (Classic)", "85")])).toBeNull();
    expect(pickSteamHit(r, [hit(1, "Sid Meier's Pirates! A", "88"), hit(2, "Sid Meier's Pirates! B", "88")])).toBeNull();
    expect(pickSteamHit(row("Half-Life", 96), [hit(220, "Half-Life 2", "96")])).toBeNull();
  });
  test("a newer edition of the same game counts; an expansion, upgrade or sequel does not", () => {
    expect(pickSteamHit(row("The Elder Scrolls V: Skyrim", 94), [hit(489830, "The Elder Scrolls V: Skyrim Special Edition", "0"), hit(1746860, "The Elder Scrolls V: Skyrim Anniversary Upgrade", "")])?.appId).toBe(489830);
    expect(pickSteamHit(row("Mass Effect 2", 94), [hit(1328670, "Mass Effect™ Legendary Edition", "86"), hit(24980, "Mass Effect 2 (2010) Edition", "")])?.appId).toBe(24980);
    expect(pickSteamHit(row("Half-Life 2", 96), [hit(380, "Half-Life 2: Episode One", "87")])).toBeNull();
  });
  test("the store drops the author credit the critics keep — accepted when the rest is the same game and the score agrees (or the store has none)", () => {
    expect(pickSteamHit(row("Sid Meier's Civilization IV: Beyond the Sword", 86), [hit(8800, "Civilization IV: Beyond the Sword", "86"), hit(1, "Xuan-Yuan Sword: Mists Beyond the Mountains", "")])?.appId).toBe(8800);
    expect(pickSteamHit(row("Sid Meier's Civilization IV: Beyond the Sword", 86), [hit(8800, "Civilization IV: Beyond the Sword", "70")])).toBeNull();
    expect(pickSteamHit(row("Sid Meier's Pirates!", 88), [hit(3920, "Pirates!", "")])?.appId).toBe(3920);
    expect(pickSteamHit(row("Beyond the Sword", 86), [hit(8800, "Civilization IV: Beyond the Sword", "86")])).toBeNull();   // the other way round stays a longer name: the prefix rule decides
  });
  test("a title is asked a few ways in turn — as is, without punctuation, then the part after the colon — until a hit is accepted", async () => {
    expect(searchTerms("Vampire: The Masquerade - Bloodlines")).toEqual(["Vampire: The Masquerade - Bloodlines", "Vampire The Masquerade Bloodlines"]);
    expect(searchTerms("Sid Meier's Civilization IV: Beyond the Sword")).toEqual(["Sid Meier's Civilization IV: Beyond the Sword", "Sid Meiers Civilization IV Beyond the Sword", "Beyond the Sword"]);
    expect(searchTerms("Half-Life 2")).toEqual(["Half-Life 2", "Half Life 2"]);
    expect(searchTerms("Cart Life (2013)")).toEqual(["Cart Life"]);
    answers["Vampire The Masquerade Bloodlines"] = [hit(2600, "Vampire: The Masquerade - Bloodlines", "80")];
    answers["Beyond the Sword"] = [hit(8800, "Civilization IV: Beyond the Sword", "86"), hit(1, "Xuan-Yuan Sword: Mists Beyond the Mountains", "")];
    const rows = [row("Vampire: The Masquerade - Bloodlines", 80), row("Sid Meier's Civilization IV: Beyond the Sword", 86), row("Medieval II: Total War", 88)];
    expect(await resolveRows(rows)).toBe(3);
    expect(resolvedApp(rows[0].slug)?.appId).toBe(2600);
    expect(resolvedApp(rows[1].slug)?.appId).toBe(8800);
    expect(resolvedApp(rows[2].slug)?.appId).toBeNull();
    expect(searches).toEqual(["Vampire: The Masquerade - Bloodlines", "Vampire The Masquerade Bloodlines", "Sid Meier's Civilization IV: Beyond the Sword", "Sid Meiers Civilization IV Beyond the Sword", "Beyond the Sword", "Medieval II: Total War", "Medieval II Total War", "Total War"]);
  });
  test("answers are kept, misses are retried after a week, nothing is asked twice", async () => {
    answers["Half-Life 2"] = [hit(220, "Half-Life 2", "96")];
    const rows = [row("Half-Life 2", 96), row("Unknown Thing", 70)];
    expect(await resolveRows(rows)).toBe(2);
    expect(resolvedApp(rows[0].slug)).toMatchObject({ appId: 220 });
    expect(await resolveRows(rows)).toBe(0);
    now += 8 * 86_400_000;
    expect(await resolveRows(rows)).toBe(1);
    expect(searches).toEqual(["Half-Life 2", "Unknown Thing", "Unknown Thing"]);
  });
});

/** a browse page of synthetic cards, the shape parseBrowseHtml reads */
const card = (i: number) => `<div data-testid="filter-results"><a href="/game/game-${i}/"><h3 data-testid="product-title"><span>${i}.</span><span>Game ${i}</span></h3><div class="uppercase mb-1"><span>Jan 1, 2024</span></div><div title="Metascore 90 out of 100"></div></a></div>`;
const browsePage = (n: number, from: number) => Array.from({ length: n }, (_, k) => card(from + k)).join("\n");

describe("the lists run deep", () => {
  test("a year runs to four pages and stops at a short one; all-time stops at four; the tick walks every list, the ones people open first ahead", async () => {
    pages[browseUrl("2024", 1)] = browsePage(50, 1); pages[browseUrl("2024", 2)] = browsePage(50, 51); pages[browseUrl("2024", 3)] = browsePage(20, 101); pages[browseUrl("2024", 4)] = browsePage(50, 121);
    const year = await listRows("2024");
    expect(year.rows.length).toBe(120); expect(year.rows[119]).toMatchObject({ rank: 120, title: "Game 120", slug: "game-120" });
    expect(fetched.filter(u => u.includes("/2024/")).length).toBe(3);                            // the short third page ends it
    for (let p = 1; p <= 5; p++) pages[browseUrl("all", p)] = browsePage(50, 1000 * p);
    const all = await listRows("all");
    expect(all.rows.length).toBe(200); expect(fetched.filter(u => u.includes("/all-time/metascore/")).length).toBe(4);
    now += 25 * 3600_000; fetched = [];                                                          // a day on: every list is stale, so the tick's order shows in what it fetches
    await metacriticTick();
    const listsAsked = fetched.map(u => /\/pc\/all\/([^/]+)\/(\w+)\//.exec(u)!.slice(1).join("/")).filter((v, i, a) => a.indexOf(v) === i);
    expect(listsAsked.slice(0, 4)).toEqual(["all-time/metascore", "all-time/userscore", "2026/metascore", "2025/metascore"]);
    expect(listsAsked.length).toBe(lists().length); expect(listsAsked.at(-1)).toBe("2008/metascore");
  });
});

describe("the best-of rows", () => {
  test("matched titles become items in Metacritic's order with its score; unmatched ones count as pending; expansions fall away; the library is known", async () => {
    pages[browseUrl("all", 1)] = metaHtml;
    answers["Disco Elysium: The Final Cut"] = [hit(632470, "Disco Elysium - The Final Cut", "97")];
    answers["Half-Life 2"] = [hit(220, "Half-Life 2", "96")];
    answers["Grand Theft Auto V"] = [hit(271590, "Grand Theft Auto V", "96")];
    const first = await bestOf("all");
    expect(first.total).toBe(3); expect(first.pending).toBe(3); expect(first.items).toEqual([]);
    await new Promise(r => setTimeout(r, 30));
    catalogUpsertFromDetails(details(632470, { name: "Disco Elysium - The Final Cut", metacritic: { score: 91 } }));
    catalogUpsertFromDetails(details(220, { type: "dlc", name: "Half-Life 2: Episode" }));
    setLibrary([game(4, "Grand Theft Auto V", { steamAppId: 271590, tracked: true, request: { id: 1, gameId: 4, state: "fetching", stage: "", progress: 0.4, message: null, attempt: 0, candidates: 1, createdAt: 0, updatedAt: 0, doneAt: null, release: null } })]);
    const done = await bestOf("all");
    expect(done.pending).toBe(0);
    expect(done.items.map(i => [i.appId, i.rank, i.metacritic])).toEqual([[632470, 1, 97], [271590, 3, 96]]);
    expect(done.items[0]).toMatchObject({ name: "Disco Elysium - The Final Cut", releaseIso: "2021-03-30", portrait: "p632470", inLibrary: false, mcSlug: "disco-elysium-the-final-cut" });
    expect(done.items[1]).toMatchObject({ inLibrary: true, gameId: 4, followed: true, requestState: "fetching", releaseText: "Apr 13, 2015", userScore: null });
  });
  test("the players' list carries user scores; the tick warms the lists within its budget", async () => {
    pages[browseUrl("players")] = userHtml;
    answers["Clair Obscur: Expedition 33"] = [hit(1903340, "Clair Obscur: Expedition 33", "92")];
    await resolveRows((await listRows("players")).rows);
    expect((await bestOf("players")).items.map(i => [i.appId, i.userScore])).toEqual([[1903340, 9.6]]);
    await expect(bestOf("1990" as any)).rejects.toThrow();
    pages[browseUrl("all", 1)] = metaHtml; pages[browseUrl("2026")] = metaHtml; pages[browseUrl("2025")] = userHtml;
    searches = [];
    await metacriticTick();
    // only the all-time titles were new (the year lists repeat them); a title nothing answers is asked its other ways too
    expect(searches).toEqual(["Disco Elysium: The Final Cut", "Disco Elysium The Final Cut", "The Final Cut", "Half-Life 2", "Half Life 2", "Grand Theft Auto V"]);
  });
});

describe("more like this", () => {
  const similar = `<div id="similar"><a role="button" class="similar_grid_capsule" data-ds-appid="374320" data-ds-tagids="[29482,122]" href="https://store.steampowered.com/app/374320/DARK_SOULS_III/?snr=1_300"> <img src="https://cdn/374320/capsule_616x353.jpg"> </a>
<a role="button" class="similar_grid_capsule" data-ds-appid="1245620" href="https://store.steampowered.com/app/1245620/ELDEN_RING/"><img src="https://cdn/1245620/capsule.jpg"></a>
<a role="button" class="similar_grid_capsule" data-ds-appid="2000" href="https://store.steampowered.com/app/2000/Some_Game_Soundtrack/"><img src="s.jpg"></a></div>`;
  test("capsules give the app, a name from the link, the art and the tags", () => {
    const rows = parseSimilarHtml(similar);
    expect(rows.map(r => [r.appId, r.name])).toEqual([[374320, "DARK SOULS III"], [1245620, "ELDEN RING"], [2000, "Some Game Soundtrack"]]);
    expect(rows[0]).toMatchObject({ capsule: "https://cdn/374320/capsule_616x353.jpg", tagIds: [29482, 122] });
  });
  test("the row leaves out the game itself and junk, uses the catalog's names, and is cached a week", async () => {
    let calls = 0;
    ddeps.fetchSimilar = async () => { calls++; return similar; };
    catalogUpsertFromDetails(details(374320, { name: "DARK SOULS™ III", release_date: { coming_soon: false, date: "Apr 11, 2016" } }));
    const a = await similarTo(1245620);
    expect(a.items.map(i => [i.appId, i.name])).toEqual([[374320, "DARK SOULS™ III"]]);
    expect(a.items[0]).toMatchObject({ releaseIso: "2016-04-11", portrait: "p374320" });
    await similarTo(1245620);
    expect(calls).toBe(1);
    now += 8 * 86_400_000;
    ddeps.fetchSimilar = async () => { calls++; throw new Error("down"); };
    const c = await similarTo(1245620);
    expect(calls).toBe(2); expect(c.stale).toBe(true); expect(c.items.length).toBe(1);
  });
});

describe("what players read on the best-of rows", () => {
  const reviewed = (appId: number, name: string, count: number) =>
    `<a href="https://store.steampowered.com/app/${appId}/" data-ds-appid="${appId}" data-ds-tagids="[]"><span class="title">${name}</span><div class="search_released">Nov 16, 2004</div>` +
    `<span class="search_review_summary positive" data-tooltip-html="Overwhelmingly Positive&lt;br&gt;97% of the ${count.toLocaleString("en-US")} user reviews for this game are positive."></span><img src="c.jpg"></a>`;
  test("the lists are labels: no line explains them, on the lists or on a list's page", async () => {
    expect(lists().every(l => l.sub === "")).toBe(true);
    expect(lists().slice(0, 3).map(l => l.label)).toEqual(["All time", "Players' favourites", "2026"]);
    pages[browseUrl("all", 1)] = metaHtml;
    const { token } = await signup("kay");
    const page = await http("GET", "/api/v1/discover/list/best:all", undefined, token);
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({ title: "Highest rated · all time", sub: "" });
    expect((await http("GET", "/api/v1/discover/best/all", undefined, token)).json.sub).toBe("");
  });
  test("a name is the store's, its search's or Metacritic's, never a placeholder; review words come from the store's own rows", async () => {
    pages[browseUrl("all", 1)] = metaHtml;
    answers["Disco Elysium: The Final Cut"] = [hit(632470, "Disco Elysium - The Final Cut", "97")];
    answers["Half-Life 2"] = [hit(220, "Half-Life 2", "96")];
    answers["Grand Theft Auto V"] = [hit(271590, "Grand Theft Auto V", "96")];
    await resolveRows((await listRows("all")).rows);
    stmts.catalogTouch.run(271590, "app 271590");                                       // left by a day the store throttled
    ddeps.fetchFeed = async f => (f === "toprated" ? reviewed(220, "Half-Life 2", 157_000) : "");
    await feedRows("toprated", 100);
    const list = await bestOf("all");
    expect(list.items.map(i => i.name)).toEqual(["Disco Elysium - The Final Cut", "Half-Life 2", "Grand Theft Auto V"]);
    expect(list.items[1]).toMatchObject({ reviewSummary: "Overwhelmingly Positive", reviewPct: 97, reviewCount: 157_000, metacritic: 96 });
    expect(list.items[0].reviewSummary).toBeNull();                                      // no store row carried it: nothing is made up
    stmts.catalogTouch.run(632470, "app 632470"); stmts.catalogTouch.run(220, "app 220"); // every catalog row a placeholder
    expect((await bestOf("all")).items.map(i => i.name)).toEqual(["Disco Elysium - The Final Cut", "Half-Life 2", "Grand Theft Auto V"]);
  });
  test("more like this: the link's name over a placeholder; a capsule with no name waits for the catalog", async () => {
    ddeps.fetchSimilar = async () => `<a class="similar_grid_capsule" data-ds-appid="374320" href="https://store.steampowered.com/app/374320/DARK_SOULS_III/"><img src="a.jpg"></a>` +
      `<a class="similar_grid_capsule" data-ds-appid="1245620" href="https://store.steampowered.com/app/1245620/"><img src="b.jpg"></a>`;
    stmts.catalogTouch.run(374320, "app 374320");
    expect(parseSimilarHtml(await ddeps.fetchSimilar(1)).map(r => r.name)).toEqual(["DARK SOULS III", ""]);
    const a = await similarTo(814380);
    expect(a.items.map(i => [i.appId, i.name])).toEqual([[374320, "DARK SOULS III"]]);
    catalogUpsertFromDetails(details(1245620, { name: "ELDEN RING" }));
    now += 8 * 86_400_000;
    expect((await similarTo(814380)).items.map(i => i.name)).toEqual(["DARK SOULS III", "ELDEN RING"]);
  });
});

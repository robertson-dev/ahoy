/**
 * Ahoy — discovery: what is coming, what is new, what sells — from Steam's keyless store feeds.
 *
 *   feeds    GET store.steampowered.com/search/results/?filter=<f>&json=1   → HTML rows inside JSON
 *            popularcomingsoon = the store's "Popular Upcoming" tab (wishlist-weighted), popularnew =
 *            "New & Trending", topsellers = "Top Sellers"; toprated = the same search sorted by user reviews
 *            (sort_by=Reviews_DESC). category1=998 keeps it to games; tags=<id> narrows any of them to a tag.
 *   catalog  per-app details (appdetails) cached in the `catalog` table and refreshed slowly in the
 *            background, so the API answers instantly and Steam is never hammered.
 *   library  every item says whether the game is already on the server (ludarr's library snapshot).
 */
import { db, kv, stmts, type CatalogRow } from "./db";
import { cfgNum } from "./config";
import { steamArtMany, steamDetails, type AppArt, type SteamAppDetails } from "./steam";
import { knownName } from "./names";
import { libraryContext } from "./library";
import type { LudarrGame } from "./ludarr";
import { logger } from "./log";
const dlog = logger("Discover");

/* ─────────────────────── release dates ─────────────────────── */

export type DatePrecision = "day" | "month" | "quarter" | "year" | "tba";
export interface ReleaseInfo { text: string; iso: string | null; sort: string | null; precision: DatePrecision }

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** "Oct 15, 2026" · "15 Oct, 2026" · "October 2026" · "Q4 2026" · "2026" · "Coming soon" → when, and how precisely */
export function parseReleaseText(raw: string | null | undefined): ReleaseInfo {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  const t = text.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  let m: RegExpExecArray | null;
  if ((m = /^([a-z]{3})[a-z]* (\d{1,2}),? (\d{4})$/.exec(t)) || (m = /^(\d{1,2}) ([a-z]{3})[a-z]*,? (\d{4})$/.exec(t))) {
    const monthStr = /^\d/.test(m[1]) ? m[2] : m[1];
    const day = Number(/^\d/.test(m[1]) ? m[1] : m[2]);
    const mi = MONTHS.indexOf(monthStr.slice(0, 3));
    const y = Number(m[3]);
    if (mi >= 0 && day >= 1 && day <= 31) { const iso = `${y}-${pad(mi + 1)}-${pad(day)}`; return { text, iso, sort: iso, precision: "day" }; }
  }
  if ((m = /^([a-z]{3})[a-z]* (\d{4})$/.exec(t))) {
    const mi = MONTHS.indexOf(m[1]); const y = Number(m[2]);
    if (mi >= 0) return { text, iso: null, sort: `${y}-${pad(mi + 1)}-${pad(lastDay(y, mi + 1))}`, precision: "month" };
  }
  if ((m = /^q([1-4]) (\d{4})$/.exec(t))) {
    const q = Number(m[1]), y = Number(m[2]); const mm = q * 3;
    return { text, iso: null, sort: `${y}-${pad(mm)}-${pad(lastDay(y, mm))}`, precision: "quarter" };
  }
  if ((m = /^(early|spring|mid|summer|fall|autumn|late|winter|holiday) (\d{4})$/.exec(t))) {
    const y = Number(m[2]); const mm = { early: 4, spring: 5, mid: 7, summer: 8, fall: 11, autumn: 11, late: 12, winter: 12, holiday: 12 }[m[1]] ?? 12;
    return { text, iso: null, sort: `${y}-${pad(mm)}-${pad(lastDay(y, mm))}`, precision: "quarter" };
  }
  if ((m = /^(\d{4})$/.exec(t))) return { text, iso: null, sort: `${m[1]}-12-31`, precision: "year" };
  return { text, iso: null, sort: null, precision: "tba" };
}

export const daysUntil = (iso: string | null, now = Date.now()) =>
  iso ? Math.ceil((Date.parse(iso + "T00:00:00Z") - now) / 86_400_000) : null;

/* ─────────────────────── feed parsing ─────────────────────── */

export type Feed = "popularcomingsoon" | "popularnew" | "topsellers" | "toprated";
export interface FeedRow {
  appId: number; name: string; releaseText: string; reviewSummary: string | null; reviewPct: number | null; reviewCount: number | null;
  capsule: string | null; tagIds: number[]; free: boolean;
}

const unescapeHtml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export function parseFeedHtml(html: string): FeedRow[] {
  const out: FeedRow[] = [];
  const seen = new Set<number>();
  for (const m of html.matchAll(/<a href="[^"]*"[^>]*data-ds-appid="(\d+)"([^>]*)>([\s\S]*?)<\/a>/g)) {
    const appId = Number(m[1]);
    if (seen.has(appId)) continue;
    seen.add(appId);
    const attrs = m[2], body = m[3];
    const name = unescapeHtml(/<span class="title">([^<]*)<\/span>/.exec(body)?.[1] ?? "").trim();
    if (!name) continue;
    const releaseText = (/search_released[^>]*>\s*([^<]*?)\s*</.exec(body)?.[1] ?? "").trim();
    const tip = /search_review_summary[^>]*data-tooltip-html="([^"]*)"/.exec(body)?.[1];
    let reviewSummary: string | null = null, reviewPct: number | null = null, reviewCount: number | null = null;
    if (tip) {
      const plain = unescapeHtml(tip).replace(/<br\s*\/?>/gi, "\n");
      reviewSummary = plain.split("\n")[0].trim() || null;
      const pm = /(\d+)% of the ([\d,]+) user reviews/.exec(plain);
      if (pm) { reviewPct = Number(pm[1]); reviewCount = Number(pm[2].replace(/,/g, "")); }
    }
    const capsule = /<img[^>]+src="([^"]+)"/.exec(body)?.[1] ?? null;
    let tagIds: number[] = [];
    try { tagIds = JSON.parse(/data-ds-tagids="(\[[^"]*\])"/.exec(attrs)?.[1] ?? "[]"); } catch { /* ignore */ }
    const free = /data-price-final="0"/.test(body);
    out.push({ appId, name, releaseText, reviewSummary, reviewPct, reviewCount, capsule, tagIds, free });
  }
  return out;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const SIMILAR_URL = (appId: number) => `https://store.steampowered.com/recommended/morelike/app/${appId}/?cc=us&l=en`;
const FEED_URL = (f: Feed, count: number, tags?: number, start = 0) =>
  `https://store.steampowered.com/search/results/?${f === "toprated" ? "sort_by=Reviews_DESC" : `filter=${f}`}&infinite=1&start=${start}&count=${count}&json=1&cc=us&l=en&category1=998&os=win&ndl=1${tags ? `&tags=${tags}` : ""}`;

export const ddeps = {
  fetchFeed: async (f: Feed, count: number, tags?: number, start = 0): Promise<string> => {
    const res = await fetch(FEED_URL(f, count, tags, start), { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`STEAM_FEED_${res.status}`);
    return ((await res.json()) as { results_html?: string }).results_html ?? "";
  },
  fetchSimilar: async (appId: number): Promise<string> => {
    const res = await fetch(SIMILAR_URL(appId), { headers: { "User-Agent": UA, Accept: "text/html", Cookie: "birthtime=0; wants_mature_content=1" }, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`STEAM_SIMILAR_${res.status}`);
    return res.text();
  },
  details: steamDetails,
  art: steamArtMany as (ids: number[]) => Promise<Map<number, AppArt>>,
  now: () => Date.now(),
  log: (...a: unknown[]) => dlog.log(...a),
};

const FEED_TTL_MS = () => cfgNum("DISCOVER_REFRESH_MIN", 60) * 60_000;
const feedKey = (f: Feed, tags?: number, count = 50, start = 0) => `discover.feed.${f}${tags ? `.tag${tags}` : ""}${count !== 50 ? `.${count}` : ""}${start ? `.s${start}` : ""}`;

/** cached feed rows (one page of `count` from `start`); refreshed when stale (or forced). Never throws when a stale copy exists. */
export async function feedRows(f: Feed, count = 50, force = false, tags?: number, start = 0): Promise<{ rows: FeedRow[]; at: number; stale: boolean }> {
  let cached: { at: number; rows: FeedRow[] } | null = null;
  try { cached = JSON.parse(kv.get(feedKey(f, tags, count, start)) ?? "null"); } catch { /* ignore */ }
  const fresh = cached && ddeps.now() - cached.at < FEED_TTL_MS();
  if (fresh && !force) return { rows: cached!.rows, at: cached!.at, stale: false };
  try {
    const rows = parseFeedHtml(await ddeps.fetchFeed(f, count, tags, start));
    if (rows.length) { kv.set(feedKey(f, tags, count, start), JSON.stringify({ at: ddeps.now(), rows })); rememberReviews(rows); return { rows, at: ddeps.now(), stale: false }; }
  } catch (e: any) { ddeps.log(`feed ${f} failed: ${e?.message ?? e}`); }
  return cached ? { rows: cached.rows, at: cached.at, stale: true } : { rows: [], at: 0, stale: true };
}

/* ─────────────────────── review words, remembered from every store row that carried them ─────────────────────── */

/**
 * The store prints a game's review words ("Overwhelmingly Positive", 97% of 12,345) on its search rows, and nowhere keyless
 * per app. Every feed row that carries them is remembered (kv steam.reviews.<appId>, a month), so a game shown anywhere else —
 * a Metacritic list, "more like this", the playable list, the game page — says the same words the rows said.
 */
export interface Reviews { reviewSummary: string; reviewPct: number | null; reviewCount: number | null }
const REVIEW_TTL_MS = 30 * 86_400_000;
const reviewKey = (appId: number) => `steam.reviews.${appId}`;
export function rememberReviews(rows: FeedRow[]) {
  const at = ddeps.now(), keep = rows.filter(r => r.reviewSummary);
  if (keep.length) db.transaction(() => { for (const r of keep) kv.set(reviewKey(r.appId), JSON.stringify({ s: r.reviewSummary, p: r.reviewPct, n: r.reviewCount, at })); })();
}
/** what the feeds cached before this memory existed: read once per process, newest first, never over words already kept */
let backfilled = false;
function backfillReviews() {
  backfilled = true;
  try {
    for (const { value } of db.query("SELECT value FROM kv WHERE key LIKE 'discover.feed.%' ORDER BY updated_at DESC").all() as { value: string }[]) {
      const j = JSON.parse(value) as { at?: number; rows?: FeedRow[] };
      const rows = (j.rows ?? []).filter(r => r.reviewSummary && !kv.get(reviewKey(r.appId)));
      if (rows.length) db.transaction(() => { for (const r of rows) kv.set(reviewKey(r.appId), JSON.stringify({ s: r.reviewSummary, p: r.reviewPct, n: r.reviewCount, at: j.at ?? ddeps.now() })); })();
    }
  } catch (e: any) { ddeps.log(`review words from the cached feeds: ${e?.message ?? e}`); }
}
/** tests: read the cached feeds again on the next lookup, as a fresh process does */
export const _reviewsTest = { rereadFeeds() { backfilled = false; } };
/** an app's review words, when a store row carried them in the last month */
export function reviewsOf(appId: number): Reviews | null {
  if (!backfilled) backfillReviews();
  const v = kv.json<{ s?: string; p?: number | null; n?: number | null; at?: number } | null>(reviewKey(appId), null);
  return v?.s && ddeps.now() - (v.at ?? 0) < REVIEW_TTL_MS ? { reviewSummary: v.s, reviewPct: v.p ?? null, reviewCount: v.n ?? null } : null;
}

/* ─────────────────────── catalog (per-app details cache) ─────────────────────── */

export type { CatalogRow };

export function catalogUpsertFromDetails(d: SteamAppDetails): CatalogRow {
  const rel = parseReleaseText(d.release_date?.date);
  const comingSoon = d.release_date?.coming_soon ? 1 : 0;
  stmts.catalogUpsert.run(
    d.steam_appid, d.name, d.type ?? null, comingSoon, rel.text || null, rel.iso, rel.sort,
    JSON.stringify((d.genres ?? []).map(g => g.description)), d.short_description ?? null, d.metacritic?.score ?? null, d.header_image ?? null,
  );
  return stmts.catalogGet.get(d.steam_appid) as CatalogRow;
}

const CATALOG_TTL_SEC = 24 * 3600;
/** a row that only says "we looked" (the store had no details) is asked again sooner: older servers also wrote one when the
 *  store was merely throttling */
const PLACEHOLDER_TTL_SEC = 3600;
/** this many lookups in a row that the store did not answer end the pass (it is throttling); the next pass goes on */
const GIVE_UP_AFTER = 3;

/** refresh details for apps whose cache is missing or old — sequential and polite, a handful per call */
export async function enrichCatalog(appIds: number[], max = 12, delayMs = 350): Promise<number> {
  const now = Math.floor(ddeps.now() / 1000);
  let done = 0, unanswered = 0;
  for (const id of appIds) {
    if (done >= max) break;
    const row = stmts.catalogGet.get(id) as CatalogRow | undefined;
    if (row && now - row.updated_at < (knownName(row.name) ? CATALOG_TTL_SEC : PLACEHOLDER_TTL_SEC)) continue;
    try {
      const d = await ddeps.details(id);
      if (d) catalogUpsertFromDetails(d);
      else stmts.catalogTouch.run(id, `app ${id}`);            // the store has no such app: remember we looked (the name is never shown)
      unanswered = 0;
    } catch (e: any) {                                          // the store did not answer: nothing is remembered, a later pass asks again
      ddeps.log(`details ${id}: ${e?.message ?? e}`);
      if (++unanswered >= GIVE_UP_AFTER) { done++; break; }
    }
    done++;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return done;
}

/* ─────────────────────── the discovery view ─────────────────────── */

export interface DiscoverItem {
  appId: number; name: string; img: string; portrait: string | null;   // img: the wide header (cards); portrait: the 600x900 library capsule, when Steam has one
  drm: string | null; crackStatus: string | null; crackDate: string | null; crackGroup: string | null;   // from CrackWatch (through ludarr), when the game is tracked there; members get the verdict and its date only (drm and crackGroup are always null: names players never read)
  releaseText: string | null; releaseIso: string | null; releaseSort: string | null; daysUntil: number | null; comingSoon: boolean;
  reviewSummary: string | null; reviewPct: number | null; reviewCount: number | null; metacritic: number | null;
  genres: string[]; summary: string | null; free: boolean;
  inLibrary: boolean; gameId: number | null; followed: boolean; requestState: string | null;
}
export interface DiscoverSection { key: string; title: string; sub: string; items: DiscoverItem[]; updatedAt: number; stale: boolean }

/** the header from appdetails (hashed path, exists for every app) beats the feed's small capsule; never guess CDN paths */
const bestArt = (r: FeedRow, cat: CatalogRow | undefined) => cat?.header_image ?? r.capsule ?? "";

export function toItem(r: FeedRow, cat: CatalogRow | undefined, lib: Map<number, LudarrGame>, follows: Set<number>, reqState: Map<number, string>): DiscoverItem {
  const rel = cat?.release_text != null ? { text: cat.release_text, iso: cat.release_iso, sort: cat.release_sort } : (() => { const p = parseReleaseText(r.releaseText); return { text: p.text || null, iso: p.iso, sort: p.sort }; })();
  const game = lib.get(r.appId);
  const comingSoon = cat ? cat.coming_soon === 1 : !!(rel.sort && rel.sort >= new Date(ddeps.now()).toISOString().slice(0, 10)) || /coming soon|tba|to be announced/i.test(rel.text ?? "");
  const rv = r.reviewSummary ? null : reviewsOf(r.appId);                          // rows that are not the store's own: the words a store row said
  // the library game carries ludarr's own verdict (kept fresh by its CrackWatch sync); the catalog's copy serves the rest
  const crack = game ? { drm: game.drm, status: game.crackStatus, date: game.crackDate, group: game.crackGroup } : { drm: cat?.drm ?? null, status: cat?.crack_status ?? null, date: cat?.crack_date ?? null, group: cat?.crack_group ?? null };
  return {
    appId: r.appId, name: knownName(cat?.name) ?? r.name,
    img: bestArt(r, cat), portrait: null,
    drm: null, crackStatus: crack.status, crackDate: crack.date, crackGroup: null,
    releaseText: rel.text, releaseIso: rel.iso, releaseSort: rel.sort, daysUntil: daysUntil(rel.iso, ddeps.now()), comingSoon,
    reviewSummary: r.reviewSummary ?? rv?.reviewSummary ?? null, reviewPct: rv ? rv.reviewPct : r.reviewPct, reviewCount: rv ? rv.reviewCount : r.reviewCount, metacritic: cat?.metacritic ?? null,
    genres: cat ? JSON.parse(cat.genres_json || "[]") : [], summary: cat?.short_description ?? null, free: r.free,
    inLibrary: !!game, gameId: game?.id ?? null, followed: game ? follows.has(game.id) : false, requestState: game ? reqState.get(game.id) ?? null : null,
  };
}

const isoDaysAgo = (days: number) => new Date(ddeps.now() - days * 86_400_000).toISOString().slice(0, 10);

// `sub` stays empty: players get the title alone, never a line explaining the row (quiet copy)
const SECTIONS: { key: string; feed: Feed; title: string; sub: string; limit: number; keep?: (i: DiscoverItem) => boolean }[] = [
  { key: "coming_soon", feed: "popularcomingsoon", title: "Coming soon", sub: "", limit: 24,          // the store's most wanted
    keep: i => i.releaseSort == null || i.releaseSort >= isoDaysAgo(1) },                 // released yesterday still counts as "out now"
  { key: "new", feed: "popularnew", title: "New & trending", sub: "", limit: 24,          // out in the last three months and climbing
    keep: i => i.releaseSort != null && i.releaseSort >= isoDaysAgo(90) && i.releaseSort <= isoDaysAgo(-1) },
  { key: "top", feed: "topsellers", title: "Top sellers", sub: "", limit: 24 },
];

export const JUNK = /\b(demo|playtest|soundtrack|dlc|server|dedicated)\b/i;
let lastEagerEnrich = 0;

export async function withPortraits<T extends DiscoverItem>(items: T[]): Promise<T[]> {
  try {
    const arts = await ddeps.art([...new Set(items.map(i => i.appId))]);
    for (const i of items) i.portrait = arts.get(i.appId)?.portrait ?? null;
  } catch (e: any) { ddeps.log(`posters: ${e?.message ?? e}`); }
  return items;
}

export async function discover(): Promise<{ sections: DiscoverSection[] }> {
  const ctx = libraryContext();
  const sections: DiscoverSection[] = [];
  for (const s of SECTIONS) {
    const { rows, at, stale } = await feedRows(s.feed, 50);
    const items = rows
      .map(r => toItem(r, stmts.catalogGet.get(r.appId) as CatalogRow | undefined, ctx.lib, ctx.follows, ctx.reqState))
      .filter(i => !JUNK.test(i.name))
      .filter(i => !s.keep || s.keep(i))
      .slice(0, s.limit);
    if (s.key === "coming_soon") items.sort((a, b) => (a.releaseSort ?? "9999").localeCompare(b.releaseSort ?? "9999"));
    sections.push({ key: s.key, title: s.title, sub: s.sub, items, updatedAt: at, stale });
  }
  await withPortraits(sections.flatMap(s => s.items));
  const missing = sections.flatMap(s => s.items).filter(i => !stmts.catalogGet.get(i.appId)).map(i => i.appId);
  if (missing.length && ddeps.now() - lastEagerEnrich > 120_000) {
    lastEagerEnrich = ddeps.now();
    void enrichCatalog([...new Set(missing)], 40).catch(() => {});
  }
  return { sections };
}

/** the app ids the rows show right now (what the background workers keep fresh) */
export async function onScreen(): Promise<number[]> {
  const ids: number[] = [];
  for (const s of SECTIONS) ids.push(...(await feedRows(s.feed, 50)).rows.slice(0, s.limit).map(r => r.appId));
  return [...new Set(ids)];
}

/** background: keep feeds warm and details filled for what the rows show */
let ticks = 0;
export async function discoverTick(): Promise<void> {
  const ids = await onScreen();
  const n = await enrichCatalog(ids, ticks++ === 0 ? 60 : 12);     // first pass fills the rows, later passes keep them fresh
  if (n) ddeps.log(`catalog: refreshed ${n} app(s)`);
  await ddeps.art(ids).catch(() => {});                              // warm the posters the rows will ask for
}

/* ─────────────────────── one app, for the game page ─────────────────────── */

/** Steam now serves trailers as HLS / DASH manifests; older apps still carry plain mp4 / webm files */
export interface Trailer { name: string; thumb: string; hls: string | null; mp4: string | null; webm: string | null }
export interface AppDetail extends DiscoverItem {
  developers: string[]; publishers: string[]; about: string | null; screenshots: string[]; trailers: Trailer[];
  hero: string | null; header: string | null; platforms: string[];
}
const https = (u: string | undefined | null) => (u ? u.replace(/^http:/, "https:") : null);
const trailersOf = (d: SteamAppDetails | null | undefined): Trailer[] =>
  (d?.movies ?? []).map(m => ({ name: m.name, thumb: https(m.thumbnail) ?? "", hls: https(m.hls_h264), mp4: https(m.mp4?.max ?? m.mp4?.["480"]), webm: https(m.webm?.max ?? m.webm?.["480"]), highlight: !!m.highlight }))
    .filter(t => t.hls || t.mp4 || t.webm).sort((a, b) => Number(b.highlight) - Number(a.highlight)).map(({ highlight: _h, ...t }) => t);
const detailMemo = new Map<number, { at: number; d: SteamAppDetails | null }>();
const FEEDS_FOR_REVIEWS: Feed[] = ["popularnew", "topsellers", "popularcomingsoon"];

/** everything the game page shows for a Steam app that may not be in the library yet: details, art, verdict, library state */
export async function appDetail(appId: number): Promise<AppDetail | null> {
  const memo = detailMemo.get(appId);
  let d = memo && ddeps.now() - memo.at < 6 * 3600_000 ? memo.d : undefined;
  if (d === undefined) {
    d = await ddeps.details(appId).catch(() => undefined);                        // the store did not answer: the catalog serves, nothing is kept
    if (d !== undefined) detailMemo.set(appId, { at: ddeps.now(), d });
    else d = null;
  }
  const cat = d ? catalogUpsertFromDetails(d) : (stmts.catalogGet.get(appId) as CatalogRow | undefined);
  if (!d && !cat) return null;
  let feed: FeedRow | undefined;                                                   // review numbers come from the cached feeds, when one lists it
  for (const f of FEEDS_FOR_REVIEWS) { feed = (await feedRows(f, 50).catch(() => ({ rows: [] as FeedRow[] }))).rows.find(r => r.appId === appId); if (feed) break; }
  const ctx = libraryContext();
  const row: FeedRow = feed ?? { appId, name: d?.name ?? knownName(cat?.name) ?? ctx.lib.get(appId)?.name ?? "", releaseText: d?.release_date?.date ?? cat?.release_text ?? "", reviewSummary: null, reviewPct: null, reviewCount: null, capsule: d?.header_image ?? cat?.header_image ?? null, tagIds: [], free: !!d?.is_free };
  const item = toItem(row, cat, ctx.lib, ctx.follows, ctx.reqState);
  const art = (await ddeps.art([appId]).catch(() => new Map<number, AppArt>())).get(appId);
  return {
    ...item, portrait: art?.portrait ?? item.portrait, free: !!(d?.is_free ?? row.free),
    hero: art?.hero ?? d?.header_image ?? cat?.header_image ?? null, header: d?.header_image ?? cat?.header_image ?? null,
    developers: d?.developers ?? [], publishers: d?.publishers ?? [], about: d?.about_the_game ?? null,
    screenshots: (d?.screenshots ?? []).map(s => https(s.path_full)!), trailers: trailersOf(d), platforms: d?.platforms ? Object.entries(d.platforms).filter(([, v]) => v).map(([k]) => k) : [],
  };
}

/* ─────────────────────── more rows: genres, and what just became playable ─────────────────────── */

/** Steam tag ids for the genre rows (the store's own "top sellers" filtered by one tag) */
export const GENRES: { tag: number; label: string }[] = [
  { tag: 19, label: "Action" }, { tag: 21, label: "Adventure" }, { tag: 122, label: "RPG" }, { tag: 9, label: "Strategy" },
  { tag: 599, label: "Simulation" }, { tag: 1695, label: "Open world" }, { tag: 1667, label: "Horror" }, { tag: 1685, label: "Co-op" },
  { tag: 699, label: "Racing" }, { tag: 701, label: "Sports" }, { tag: 1664, label: "Puzzle" }, { tag: 492, label: "Indie" },
];

export interface GenreRows { sellers: DiscoverItem[]; rated: DiscoverItem[]; updatedAt: number; stale: boolean }
/** the store lists its own subscription among the games */
const STOREFRONT = /^EA Play\b/i;
let lastGenreEnrich = 0;

/**
 * One genre, two rows: what players rate highest (the search sorted by reviews — the "Overwhelmingly positive"
 * tier — most reviewed first, so the well-known ones lead) and what sells now (its top sellers, in the store's
 * order). A tag search also returns games that carry the tag far down their list (HITMAN as a puzzle game, a
 * horse-riding sim as sports), so only games with the tag among their main ones — the handful the store prints
 * on the row — are kept; subscriptions, soundtracks and DLC fall away, the latter once the catalog knows the type.
 */
type Ctx = ReturnType<typeof libraryContext>;
/** the games of a tag's feed rows that really belong to the genre, as items; the ids the catalog does not know yet go to `missing` */
function genreItems(rows: FeedRow[], tag: number, ctx: Ctx, missing: number[]): DiscoverItem[] {
  return rows.filter(r => r.tagIds.includes(tag)).flatMap(r => {
    const cat = stmts.catalogGet.get(r.appId) as CatalogRow | undefined;
    if (!cat) missing.push(r.appId);
    else if (cat.type && cat.type !== "game") return [];
    const it = toItem(r, cat, ctx.lib, ctx.follows, ctx.reqState);
    return JUNK.test(it.name) || STOREFRONT.test(it.name) ? [] : [it];
  });
}
const byReviews = (a: DiscoverItem, b: DiscoverItem) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
const learn = (missing: number[], max: number) => { if (missing.length && ddeps.now() - lastGenreEnrich > 60_000) { lastGenreEnrich = ddeps.now(); void enrichCatalog([...new Set(missing)], max).catch(() => {}); } };

export async function discoverGenre(tag: number, limit = 24): Promise<GenreRows> {
  if (!GENRES.some(g => g.tag === tag)) throw new Error("not one of the genre rows");
  const ctx = libraryContext();
  const [sellers, rated] = await Promise.all([feedRows("topsellers", 100, false, tag), feedRows("toprated", 100, false, tag)]);
  const missing: number[] = [];
  const loved = genreItems(rated.rows, tag, ctx, missing).sort(byReviews).slice(0, limit);
  const selling = genreItems(sellers.rows, tag, ctx, missing).slice(0, limit);
  learn(missing, 24);
  await withPortraits([...loved, ...selling]);
  return { sellers: selling, rated: loved, updatedAt: Math.max(sellers.at, rated.at), stale: sellers.stale || rated.stale };
}

/* ─────────────────────── a whole row, page by page ─────────────────────── */

export interface ListPage { key: string; title: string; sub: string; items: DiscoverItem[]; page: number; more: boolean }
const PAGE = 50;
const MAX_PAGES = 10;                                                                   // 500 games of one kind is a long way down

/**
 * Every row on the storefront page goes on: the same feed read `PAGE` further each time (the store pages its search
 * with start/count), the genre lists likewise, the "became playable" list from the catalog. `more` says whether the
 * source had a full page, so one more may exist.
 */
export async function discoverList(key: string, page = 0): Promise<ListPage> {
  const ctx = libraryContext();
  page = Math.max(0, Math.min(MAX_PAGES - 1, Math.floor(page)));
  const next = (rows: unknown[], per = PAGE) => rows.length >= per && page < MAX_PAGES - 1;
  const section = SECTIONS.find(s => s.key === key);
  if (section) {
    const { rows } = await feedRows(section.feed, PAGE, false, undefined, page * PAGE);
    const items = rows.map(r => toItem(r, stmts.catalogGet.get(r.appId) as CatalogRow | undefined, ctx.lib, ctx.follows, ctx.reqState)).filter(i => !JUNK.test(i.name)).filter(i => !section.keep || section.keep(i));
    if (key === "coming_soon") items.sort((a, b) => (a.releaseSort ?? "9999").localeCompare(b.releaseSort ?? "9999"));
    learn(items.filter(i => !stmts.catalogGet.get(i.appId)).map(i => i.appId), 40);
    return { key, title: section.title, sub: section.sub, items: await withPortraits(items), page, more: next(rows) };
  }
  if (key === "playable") {
    const { items } = await recentlyPlayable(PAGE, page * PAGE);
    return { key, title: "Just became playable", sub: "", items, page, more: next(items) };            // newest first
  }
  const g = /^genre:(\d+):(rated|sellers)$/.exec(key);
  if (g) {
    const tag = Number(g[1]), genre = GENRES.find(x => x.tag === tag);
    if (!genre) throw new Error("not one of the genre rows");
    const { rows } = await feedRows(g[2] === "rated" ? "toprated" : "topsellers", 100, false, tag, page * 100);
    const missing: number[] = [];
    const items = genreItems(rows, tag, ctx, missing);
    if (g[2] === "rated") items.sort(byReviews);
    learn(missing, 40);
    return { key, title: `${genre.label} · ${g[2] === "rated" ? "loved by players" : "selling now"}`, sub: "", items: await withPortraits(items), page, more: next(rows, 100) };
  }
  throw new Error("not one of the rows");
}

/** games whose protection was broken lately (CrackWatch verdicts, through ludarr): the moment a wished-for game becomes gettable */
export async function recentlyPlayable(limit = 16, offset = 0): Promise<{ items: DiscoverItem[] }> {
  const ctx = libraryContext();
  const rows = db.query("SELECT * FROM catalog WHERE crack_status='cracked' AND crack_date IS NOT NULL AND (type IS NULL OR type='game') ORDER BY crack_date DESC, updated_at DESC LIMIT ? OFFSET ?").all(limit, offset) as CatalogRow[];
  const items = rows.map(cat => toItem({ appId: cat.steam_appid, name: knownName(cat.name) ?? ctx.lib.get(cat.steam_appid)?.name ?? "", releaseText: cat.release_text ?? "", reviewSummary: null, reviewPct: null, reviewCount: null, capsule: cat.header_image, tagIds: [], free: false }, cat, ctx.lib, ctx.follows, ctx.reqState))
    .filter(i => i.name && !JUNK.test(i.name));                                    // a row the store had no details for has no name to show
  return { items: await withPortraits(items) };
}

/* ─────────────────────── more like this (the store's own "More like this" page, keyless) ─────────────────────── */

/** the capsules of store.steampowered.com/recommended/morelike/app/<id>/ — the name comes from the link until the catalog knows better */
export function parseSimilarHtml(html: string): FeedRow[] {
  const out: FeedRow[] = [];
  const seen = new Set<number>();
  for (const m of html.matchAll(/<a[^>]*class="similar_grid_capsule"([^>]*)>([\s\S]*?)<\/a>/g)) {
    const attrs = m[1], body = m[2];
    const appId = Number(/data-ds-appid="(\d+)"/.exec(attrs)?.[1]);
    if (!appId || seen.has(appId)) continue;
    seen.add(appId);
    let name = "";                                                                 // no slug: unnamed until the catalog knows it
    try { name = decodeURIComponent(/\/app\/\d+\/([^/?"]+)/.exec(attrs)?.[1] ?? "").replace(/_/g, " ").trim(); } catch { /* a broken escape */ }
    const capsule = /<img[^>]+src="([^"]+)"/.exec(body)?.[1] ?? null;
    let tagIds: number[] = [];
    try { tagIds = JSON.parse(/data-ds-tagids="(\[[^"]*\])"/.exec(attrs)?.[1] ?? "[]"); } catch { /* ignore */ }
    out.push({ appId, name, releaseText: "", reviewSummary: null, reviewPct: null, reviewCount: null, capsule, tagIds, free: false });
  }
  return out;
}

const SIMILAR_TTL_MS = 7 * 86_400_000;
let lastSimilarEnrich = 0;

/** games the store puts next to this one; cached a week, the catalog fills names and dates as it learns them */
export async function similarTo(appId: number, limit = 12): Promise<{ items: DiscoverItem[]; updatedAt: number; stale: boolean }> {
  const key = `discover.similar.${appId}`;
  let cached: { at: number; rows: FeedRow[] } | null = null;
  try { cached = JSON.parse(kv.get(key) ?? "null"); } catch { /* ignore */ }
  let rows = cached?.rows ?? [], at = cached?.at ?? 0, stale = false;
  if (!cached || ddeps.now() - cached.at > SIMILAR_TTL_MS) {
    try {
      const got = parseSimilarHtml(await ddeps.fetchSimilar(appId));
      if (got.length) { rows = got; at = ddeps.now(); kv.set(key, JSON.stringify({ at, rows })); }
      else stale = true;
    } catch (e: any) { ddeps.log(`similar ${appId}: ${e?.message ?? e}`); stale = true; }
  }
  const ctx = libraryContext();
  const items: DiscoverItem[] = [];
  const missing: number[] = [];
  for (const r of rows) {
    if (r.appId === appId) continue;
    const cat = stmts.catalogGet.get(r.appId) as CatalogRow | undefined;
    if (!cat || !knownName(cat.name)) missing.push(r.appId);
    if (cat?.type && cat.type !== "game") continue;
    const it = toItem(r, cat, ctx.lib, ctx.follows, ctx.reqState);
    if (!it.name || JUNK.test(it.name)) continue;                                   // nameless: shown once the catalog has its name
    items.push(it);
    if (items.length >= limit) break;
  }
  if (missing.length && ddeps.now() - lastSimilarEnrich > 60_000) { lastSimilarEnrich = ddeps.now(); void enrichCatalog(missing, 12).catch(() => {}); }
  return { items: await withPortraits(items), updatedAt: at, stale };
}

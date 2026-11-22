/**
 * Dev only: sample data for /__gallery, shaped like the boards' data (M/lfs/scenario.json, M/disc/data.json).
 * Art comes from ?art=<base url> (a static server over the boards' art files, e.g. http://localhost:8894/) or, without it,
 * from the server's art endpoints (the harness seeds the same games under the same ids).
 */
import type { ActivityItem, Game, Person, Presence, UserRef } from "../api";
import type { InstallProgress, InstalledGame } from "../launcher";
import { art, type ArtMeta } from "./art";

const ART = new URLSearchParams(location.search).get("art");
/** a board art file name → a URL */
export function A(file: string): string {
  if (ART) return ART.replace(/\/?$/, "/") + file;
  let m: RegExpExecArray | null;
  if ((m = /^poster-(\d+)\.jpg$/.exec(file))) return art.poster(+m[1]);
  if ((m = /^banner-(\d+)\.jpg$/.exec(file))) return art.banner(+m[1]);
  if ((m = /^logo-(\d+)\.png$/.exec(file))) return art.logo(+m[1]);
  if ((m = /^(?:cap|poster-steam)-(\d+)\.jpg$/.exec(file))) return art.steam(m[1]);
  if ((m = /^hero-(\d+)\.jpg$/.exec(file))) return art.steamBanner(m[1]);
  return file;
}

/** seconds ago, from now (so the product's words read the same on any day) */
const now = () => Math.floor(Date.now() / 1000);
export const ago = (h: number) => now() - Math.round(h * 3600);

/* ─────────── people (scenario.json) ─────────── */

const user = (id: number, name: string, displayName: string, hue: number, role: "admin" | "member" = "member"): UserRef => ({ id, name, displayName, hue, role });
export const U = {
  k: user(1, "k", "K", 160, "admin"), jonas: user(2, "jonas", "Jonas", 12), pell: user(3, "pell", "Pell", 280), mika: user(4, "mika", "Mika", 330),
  sasha: user(5, "sasha", "Sasha", 190), theo: user(6, "theo", "Theo", 95), rin: user(7, "rin", "Rin", 55),
};
const presence = (u: UserRef, p: Partial<Presence>): Presence => ({ user: u, state: "offline", gameId: null, appId: null, gameName: null, since: null, device: null, lastSeen: null, ...p });
export const PEOPLE: Person[] = [
  { ...U.jonas, presence: presence(U.jonas, { state: "playing", gameId: 29, gameName: "Balatro", since: ago(40 / 60) }), friend: "friends", joinedAt: ago(96 * 24) },
  { ...U.pell, presence: presence(U.pell, { state: "playing", gameId: 8, gameName: "DAVE THE DIVER", since: ago(1.1) }), friend: "friends", joinedAt: ago(95 * 24) },
  { ...U.mika, presence: presence(U.mika, { state: "online" }), friend: "friends", joinedAt: ago(89 * 24) },
  { ...U.sasha, presence: presence(U.sasha, { lastSeen: ago(26) }), friend: "friends", joinedAt: ago(53 * 24) },
  { ...U.theo, presence: presence(U.theo, { lastSeen: ago(2) }), friend: "pending_in", joinedAt: ago(4 * 24) },
  { ...U.rin, presence: presence(U.rin, { lastSeen: ago(72) }), friend: "pending_out", joinedAt: ago(32 * 24) },
];

/* ─────────── library games (the Game shape the server sends) ─────────── */

export function game(p: Partial<Game> & { id: number; name: string }): Game {
  return {
    igdbId: null, steamAppId: null, slug: null, summary: null, releaseYear: null, rating: null, drm: null, crackStatus: null, crackDate: null, crackGroup: null, crackwatchUrl: null,
    coverUrl: null, bannerUrl: null, screenshots: [], genres: [], themes: [], platforms: [], gameModes: [], developer: null, publisher: null, comingSoon: false, releaseText: null, releaseIso: null,
    monitored: true, path: null, tags: [], addedAt: ago(24 * 30), titleId: null, status: "available", statusDetail: "", hasFile: true, file: null, cutoffUnmet: false, request: null, tracked: false,
    people: { requestedBy: [], owners: [], playing: [] }, ...p,
  };
}
export const file = (id: number, size: number, hoursAgo: number, version: string | null = null): NonNullable<Game["file"]> =>
  ({ id, path: "", size, version, launch: null, files: null, importer: null, release: null, group: null, format: "folder", addedAt: ago(hoursAgo) });
export const request = (gameId: number, state: string, progress: number): NonNullable<Game["request"]> =>
  ({ id: gameId * 10, gameId, state, stage: null, progress, message: null, release: null, attempt: 1, candidates: 1, createdAt: ago(3), updatedAt: ago(0.1), doneAt: null });
export const installed = (g: Game): InstalledGame => ({ slug: `g${g.id}`, gameId: g.id, packageId: g.file?.id ?? 0, name: g.name, version: null, path: `D:/Games/Ahoy/${g.name}`, launch: { exe: "", args: "", cwd: "" }, kind: "native", platform: null, sizeBytes: g.file?.size ?? 0, installedAt: ago(48), serverUrl: "" });
export const installing = (g: Game, progress: number): InstallProgress => ({ type: "install", packageId: g.file?.id ?? 0, gameId: g.id, slug: `g${g.id}`, name: g.name, phase: "downloading", progress, bytes: progress * (g.file?.size ?? 1), total: g.file?.size ?? 1, rate: 6.2e6 });

export const G = {
  hollow: game({ id: 16, name: "Hollow Knight", steamAppId: 367520, file: file(160, 9.2e9, 24 * 84, "1.5.78") }),
  balatro: game({ id: 29, name: "Balatro", file: file(290, 1.8e8, 24 * 96, "1.0.1o") }),
  outer: game({ id: 25, name: "Outer Wilds", file: file(250, 7.6e9, 24 * 78) }),
  gunn: game({ id: 36, name: "Samurai GUNN 2", file: file(360, 1.1e9, 24 * 39) }),
  konbini: game({ id: 30, name: "inKONBINI: One Store. Many Stories", file: file(300, 6.4e9, 24 * 26) }),
  ds3: game({ id: 31, name: "DARK SOULS III", file: file(310, 2e10, 22.9), people: { requestedBy: [{ user: U.jonas, kind: "get", at: ago(30) }], owners: [], playing: [] } }),
  dave: game({ id: 8, name: "DAVE THE DIVER", file: file(80, 1.04e10, 78) }),
  batomon: game({ id: 24, name: "Batomon Showdown", file: file(240, 2.4e9, 105.5) }),
  bloodborne: game({ id: 20, name: "Bloodborne", file: file(200, 3.1e10, 24 * 9) }),
  endacopia: game({ id: 26, name: "Endacopia", status: "downloading", hasFile: false, request: request(26, "downloading", 0.48), people: { requestedBy: [{ user: U.k, kind: "get", at: ago(3) }], owners: [], playing: [] } }),
  nightreign: game({ id: 40, name: "ELDEN RING NIGHTREIGN", status: "searching", hasFile: false, request: request(40, "searching", 0), people: { requestedBy: [{ user: U.mika, kind: "get", at: ago(2) }], owners: [], playing: [] } }),
  preparing: game({ id: 41, name: "Frosthaven", status: "importing", hasFile: false, request: request(41, "importing", 0.3) }),
  failed: game({ id: 42, name: "Sektori", status: "failed", hasFile: false, statusDetail: "nothing usable" }),
  missing: game({ id: 43, name: "Potato Please", status: "missing", hasFile: false, monitored: false }),
  needle: game({ id: 44, name: "Find The Needle", steamAppId: 5160800, status: "unreleased", hasFile: false, releaseIso: "2026-11-06", comingSoon: true, tracked: true, people: { requestedBy: [{ user: U.pell, kind: "track", at: ago(30) }], owners: [], playing: [] } }),
  worst: game({ id: 45, name: "Worst Class Ever", steamAppId: 5175310, status: "unreleased", hasFile: false, releaseIso: "2026-11-09", comingSoon: true, tracked: true, people: { requestedBy: [{ user: U.k, kind: "track", at: ago(20) }], owners: [], playing: [] } }),
};

/* ─────────── art meta (what GET …/meta returns), from the boards' measurements ─────────── */

export const META_DS3: ArtMeta = { hero: { w: 1920, h: 620, mean: 112.7 }, logo: { w: 579, h: 58, box: { x: 31, y: 2, w: 531, h: 56 }, readable: 1 } };
/** the boards' 640 × 360 copy of Hollow Knight's logo (the server's is 1280 × 720 with the same proportions) */
export const META_HOLLOW: ArtMeta = { hero: { w: 3840, h: 1240, mean: 65 }, logo: { w: 640, h: 360, box: { x: 26, y: 92, w: 591, h: 219 }, readable: 0.833 } };
export const META_ROGER: ArtMeta = { hero: { w: 3840, h: 1240, mean: 194.4 }, logo: { w: 1280, h: 720, box: { x: 30, y: 275, w: 1220, h: 204 }, readable: 0 } };

/* ─────────── the store: Discover's feeds on the board (M/disc/picked) ─────────── */

export const NEW_TRENDING = [
  { appId: 4115450, name: "Phantom Blade Zero", line: "Very Positive" },
  { appId: 4435490, name: "Call of Duty: Modern Warfare 4", line: "Mostly Positive" },
  { appId: 3393110, name: "AION 2", line: "Mixed" },
  { appId: 4348910, name: "Probably Stolen - Cyberpunk Shopkeeper Sim", line: "Overwhelmingly Positive" },
  { appId: 4126040, name: "Aniimo", line: "Mostly Positive" },
  { appId: 5335510, name: "Moon Sweepers", line: "Mostly Positive" },
];

/** Coming soon in the store's most-wanted order; who tracks it from the server's people */
export const COMING: { appId: number; name: string; iso: string | null; text?: string; tracker?: UserRef | "me" }[] = [
  { appId: 5160800, name: "Find The Needle", iso: "2026-11-06", tracker: U.pell },
  { appId: 4834760, name: "Pool of Radiance: Ruins of Myth Drannor", iso: "2026-11-06" },
  { appId: 4612650, name: "Metro Anomaly", iso: "2026-11-06" },
  { appId: 3629430, name: "DREADMOOR", iso: "2026-11-09", tracker: U.jonas },
  { appId: 5175310, name: "Worst Class Ever", iso: "2026-11-09", tracker: "me" },
  { appId: 4576490, name: "Casualties: Unknown", iso: "2026-11-09" },
  { appId: 5086460, name: "PeeVPee", iso: "2026-11-09" },
  { appId: 5118500, name: "Safari-TV", iso: "2026-11-09" },
  { appId: 4559930, name: "Oboro no Ichi", iso: "2026-11-09" },
  { appId: 4530370, name: "Football Manager 27", iso: "2026-11-10" },
  { appId: 2523740, name: "DreamWorks Shrek 2 Remastered", iso: "2026-11-10" },
  { appId: 3669620, name: "Warhammer Survivors", iso: "2026-11-10" },
  { appId: 2638080, name: "Annihilated", iso: "2026-11-10" },
  { appId: 3499790, name: "Ashes of the Singularity II", iso: "2026-11-10" },
  { appId: 4876650, name: "Never Sort By Color", iso: "2026-11-10" },
  { appId: 4218360, name: "Wall World Strategy", iso: "2026-11-11" },
  { appId: 2487190, name: "Main Sequence", iso: "2026-11-12" },
  { appId: 5378110, name: "One More Lawn", iso: "2026-11-12" },
  { appId: 4045480, name: "Drawquarium", iso: "2026-11-13" },
  { appId: 4661070, name: "HANDS OVER", iso: "2026-11-13" },
  { appId: 5200620, name: "Dungeonbound", iso: "2026-11-15" },
  { appId: 5037200, name: "just volleyball", iso: null, text: "November 2026" },
  { appId: 4776500, name: "Carry On Together", iso: null, text: "November 2026" },
  { appId: 2870790, name: "Dumpster Gang", iso: "2026-12-03" },
];

export const TOP_SELLERS = [
  ["Call of Duty: Modern Warfare 4", 4435490, "Mostly Positive"], ["Counter-Strike 2", 730, "Very Positive"], ["AION 2", 3393110, "Mixed"],
  ["Phantom Blade Zero", 4115450, "Very Positive"], ["Call of Duty", 1938090, "Mixed"],
] as const;
export const HIGHEST = [
  [92, "The Witcher 3: Wild Hunt — Remastered", 292030, "Overwhelmingly Positive"], [92, "Resident Evil Requiem", 3764200, "Overwhelmingly Positive"],
  [92, "Trails in the Sky 2nd Chapter", 4225980, "Overwhelmingly Positive"], [91, "Big Walk", 1478500, "Overwhelmingly Positive"], [89, "Desktop Explorer", 2527160, null],
] as const;

/* ─────────── the feed ─────────── */

let seq = 0;
const item = (u: UserRef, kind: ActivityItem["kind"], hoursAgo: number, x: Partial<ActivityItem> = {}): ActivityItem => ({ id: ++seq, user: u, kind, gameId: null, appId: null, name: null, data: null, at: ago(hoursAgo), ...x });
export const FEED: ActivityItem[] = [
  item(U.pell, "tracked", 1.05, { appId: 5160800, name: "Find The Needle" }),
  item(U.mika, "requested", 2.4, { appId: 2622380, name: "ELDEN RING NIGHTREIGN" }),
  item(U.k, "requested", 3.8, { gameId: 26, name: "Endacopia" }),
  item(U.jonas, "arrived", 22.9, { gameId: 31, name: "DARK SOULS III" }),
  item(U.sasha, "played", 24.6, { gameId: 16, name: "Hollow Knight" }),
  item(U.pell, "installed", 71.4, { gameId: 8, name: "DAVE THE DIVER", data: { device: "PELL-LAPTOP" } }),
  item(U.pell, "friends", 125.6, { name: "Sasha", data: { userName: "sasha" } }),
];

/** Steam capsule file for an app (the boards' art names) */
export const cap = (appId: number) => `cap-${appId}.jpg`;

/** Ahoy web — the API client: types and a typed fetch. A browser is known by its cookie, the launcher by the token it keeps. */

declare global {
  interface Window { ahoy?: { version: string } }
}
export const runtime = window.ahoy ?? { version: "dev" };
export const urlBase = "";

let bearer: string | null = null;
/** the launcher hands the page its token (a browser relies on the httpOnly cookie) */
export const setToken = (t: string | null) => { bearer = t; };
export const token = () => bearer;

let pc: string | null = null;
/** the launcher's page names its PC on every request (x-ahoy-pc): asking for a game says where it was asked from, and an
 *  install carried out there says it is that PC reporting (server: api/pcs.ts). A browser names none */
export const setPc = (name: string | null) => { pc = name; };

const unauthorized = new Set<() => void>();
/** called when the server answers 401: the session is gone */
export const onUnauthorized = (fn: () => void) => { unauthorized.add(fn); return () => { unauthorized.delete(fn); }; };

/**
 * What the page keeps between screens about whoever is signed in (their friends, the store's rows, a game's details): whoever
 * keeps something says here how to forget it, and it all goes when that person leaves (signed out, or the session ended), so the
 * next person on this PC starts from nothing. An answer still on its way then belongs to the one who left: `personNow` counts
 * the people this page has had, and a keeper drops an answer asked for under an earlier count.
 */
const kept = new Set<() => void>();
let person = 0;
export const keptForPerson = (forget: () => void) => { kept.add(forget); };
export const forgetPerson = () => { person++; for (const f of kept) f(); };
export const personNow = () => person;

export class ApiError extends Error {
  constructor(msg: string, public status: number, public data: any = null) { super(msg); }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string> ?? {}) };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (pc) headers["x-ahoy-pc"] = encodeURIComponent(pc);
  if (json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${urlBase}${path}`, { ...rest, headers, credentials: "include", body: json !== undefined ? JSON.stringify(json) : rest.body });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { throw new ApiError(res.ok ? "Ahoy answered with something that is not JSON (is it restarting?)" : `HTTP ${res.status}`, res.status || 502); }
  if (res.status === 401 && !path.startsWith("/api/v1/auth/")) for (const f of unauthorized) f();
  if (!res.ok) throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status, data);
  return data as T;
}
export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, json?: unknown) => api<T>(path, { method: "POST", json: json ?? {} });
export const put = <T,>(path: string, json?: unknown) => api<T>(path, { method: "PUT", json: json ?? {} });
export const del = <T,>(path: string) => api<T>(path, { method: "DELETE" });

/* ─────────── people ─────────── */

export interface UserRef { id: number; name: string; displayName: string; hue: number; role: "admin" | "member" }
export interface Presence { user: UserRef; state: "online" | "playing" | "offline"; gameId: number | null; appId: number | null; gameName: string | null; since: number | null; device: string | null; lastSeen: number | null }
export type FriendState = "none" | "pending_out" | "pending_in" | "friends";
export interface Person extends UserRef { presence: Presence; friend: FriendState; joinedAt: number }
export type ActivityKind = "joined" | "requested" | "tracked" | "installed" | "played" | "friends" | "arrived";
export interface ActivityItem { id: number; user: UserRef; kind: ActivityKind; gameId: number | null; appId: number | null; name: string | null; data: Record<string, unknown> | null; at: number }
export interface Profile {
  user: UserRef; bio: string | null; joinedAt: number; presence: Presence; friend: FriendState; friends: UserRef[];
  games: { gameId: number | null; appId: number | null; name: string; devices: string[]; lastPlayedAt: number | null; playSeconds: number }[];
  activity: ActivityItem[];
}
export interface People { requestedBy: { user: UserRef; kind: string; at: number }[]; owners: UserRef[]; playing: UserRef[] }

/* ─────────── games (mirrors of the server's serializers) ─────────── */

export type GameStatus = "unreleased" | "missing" | "searching" | "downloading" | "importing" | "available" | "unmonitored" | "failed";
export interface RequestView {
  id: number; gameId: number; state: string; stage: string | null; progress: number; message: string | null;
  release: { title: string; protocol: string; indexer: string | null; size: number | null; group: string | null } | null;
  attempt: number; candidates: number; createdAt: number; updatedAt: number; doneAt: number | null;
  /** how long until it is on the server, while it downloads (the server works it out; absent from older servers) */
  etaSeconds?: number | null;
}
export interface Game {
  /** Changes whenever artwork is replaced. */
  artRev?: number;
  id: number; igdbId: number | null; steamAppId: number | null; name: string; slug: string | null; summary: string | null; releaseYear: number | null; rating: number | null;
  drm: string | null; crackStatus: string | null; crackDate: string | null; crackGroup: string | null; crackwatchUrl: string | null;
  coverUrl: string | null; bannerUrl: string | null; screenshots: string[]; genres: string[]; themes: string[]; platforms: string[]; gameModes: string[];
  developer: string | null; publisher: string | null; comingSoon: boolean; releaseText: string | null; releaseIso: string | null;
  monitored: boolean; path: string | null; tags: string[]; addedAt: number; titleId: number | null;
  /** the game's other names (a search matches them too; absent from older servers) */
  aliases?: string[];
  status: GameStatus; statusDetail: string; hasFile: boolean;
  /** kind: the copy's ('native' | 'rom' — a console dump, nothing a PC starts — | 'recomp' | 'port' | 'emulated'); requiresLauncher:
   *  the oldest launcher that can install it; launchRev: the stamp of the last change to how the copy starts, made in place
   *  (the same as its launch.rev; null or absent: never changed) */
  file: { id: number; path: string; size: number | null; version: string | null; launch: string | null; files: number | null; importer: string | null; release: string | null; group: string | null; format: string; addedAt: number; kind?: string; requiresLauncher?: string | null; launchRev?: number | string | null } | null;
  cutoffUnmet: boolean; request: RequestView | null; tracked: boolean;
  people: People;
  /** what whoever is signed in may do about it: cancel the search or download running for it (absent from older servers, which
   *  let any member); version: say which version of it is looked for */
  may?: { cancel: boolean; version?: boolean };
  /** the versions it can be asked for (the platforms it is on; a choice only when there are several), and the one that was */
  platformChoices?: PlatformChoice[]; wantPlatform?: string | null;
}
export interface GameDetail extends Game {
  history: { id: number; event: string; release: string | null; source: string | null; message: string | null; at: number }[];
  files: { id: number; path: string; size: number | null; version: string | null; format: string; createdAt: number }[];
  routes: Route[];
  activity: ActivityItem[];
}
export interface Route {
  id: number; kind: string; platform: string; provenance: string; label: string | null; status: string | null; statusNote: string | null; statusAt: number | null;
  runtime: { id: string; name: string; kind: string | null; latest: { tag: string; date: string | null; asset: { name: string; url: string; size: number } | null; page: string | null } | null } | null;
  content: any; needs: any[]; features: string[]; launch: any; link: string | null; source: string; updatedAt: number;
}
/** a version a game can be asked for: a platform it is on, with its name ("arcade", "Arcade") */
export interface PlatformChoice { id: string; label: string }
export interface LookupHit {
  id: { scheme: string; value: string }; name: string; year: number | null; platforms: string[]; cover: string | null; summary: string | null; releaseIso?: string | null;
  source: string; gameId: number | null; status: GameStatus | null; kinds?: string[];
  /** the versions it can be asked for, when the server says them */
  choices?: PlatformChoice[];
}
export interface DiscoverItem { appId: number; name: string; img: string | null; portrait: string | null; drm: string | null; crackStatus: string | null; crackDate: string | null; crackGroup: string | null; releaseText: string | null; releaseIso: string | null; releaseSort?: string | null; daysUntil: number | null; comingSoon: boolean; reviewSummary: string | null; reviewPct: number | null; reviewCount: number | null; metacritic: number | null; genres: string[]; summary: string | null; free: boolean; inLibrary: boolean; gameId: number | null; followed: boolean; requestState: string | null }
export interface DiscoverSection { key: string; title: string; sub: string; items: DiscoverItem[]; updatedAt: number; stale: boolean }
export interface BestItem extends DiscoverItem { rank: number; userScore: number | null; mcSlug: string }
/** one page of a whole row (50 at a time); `more` while the source may have another page */
export interface ListPage { key: string; title: string; sub: string; items: DiscoverItem[]; page: number; more: boolean; pending?: number }
export interface BestListInfo { key: string; label: string; sub: string }
export interface BestList extends BestListInfo { items: BestItem[]; updatedAt: number; stale: boolean; pending: number; total: number }

/* ─────────── formatting ─────────── */

export const fmtSize = (b: number | null | undefined) => b == null || !Number.isFinite(b) ? "—" : b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.round(b / 1e3)} KB`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** a day in the product's words: "Aug 2", or "Aug 2, 2025" in another year */
export const fmtDay = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === new Date().getFullYear() ? "" : `, ${d.getFullYear()}`}`;
/** "just now", "12 min ago", "3 h ago", "2 d ago"; past 30 days the day itself ("Aug 2") */
export function timeAgo(sec: number | null | undefined, ms = false): string {
  if (!sec) return "—";
  const t = ms ? sec : sec * 1000;
  const d = Math.max(0, Date.now() - t);
  if (d < 60_000) return "just now";
  if (d < 3600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3600_000)} h ago`;
  if (d < 30 * 86_400_000) return `${Math.floor(d / 86_400_000)} d ago`;
  return fmtDay(new Date(t));
}
export const fmtPlay = (sec: number) => (sec < 60 ? "under a minute" : sec < 3600 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(sec < 10 * 3600 ? 1 : 0)} h`);
export const sentence = (s: string | null | undefined) => !s ? "" : s.charAt(0).toUpperCase() + s.slice(1);

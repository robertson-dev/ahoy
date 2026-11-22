/**
 * Ahoy — the player's view of the library: ludarr's games with the people around them (who asked for it, who has
 * it installed, who is playing it now), and the one-verb actions the UI offers (get, track, cancel, remove).
 */
import * as ludarr from "./ludarr";
import { platformRequest } from "./platform-catalog";
import { forPlayers } from "./words";
import type { LudarrGame, LudarrGameDetail } from "./ludarr";
import { events } from "./events";
import { NEW_GAME_S, activityOfGame, askerOf, dropAsked, dropWant, dropWants, everyone, noteAsked, noteRestarted, noteStarted, othersWant, ownersMap, seconds, starterOf, want, wantCount, wantsMap, type ActivityItem } from "./social";
import type { UserRef, UserRow } from "./auth";
import { dropOrdersOfGame, dropWantedOrders, ordersForWant } from "./pcs";

export interface People { requestedBy: { user: UserRef; kind: string; at: number }[]; owners: UserRef[]; playing: UserRef[] }
/** what whoever asks may do about a game: the pages offer Cancel only then (the route asks the same question, mayCancel);
 *  version: say which version of it is looked for (mayVersion) */
export interface Rights { cancel: boolean; version: boolean }
export type AhoyGame = LudarrGame & { people: People; may: Rights };
export type AhoyGameDetail = LudarrGameDetail & { people: People; may: Rights; activity: ActivityItem[] };

function peopleMaps() {
  const playing = new Map<number, UserRef[]>();
  for (const p of everyone()) if (p.state === "playing" && p.gameId != null) { const l = playing.get(p.gameId) ?? []; l.push(p.user); playing.set(p.gameId, l); }
  return { wants: wantsMap(), owners: ownersMap(), playing };
}
/** a game as `viewer` sees it: the people around it, and what is theirs to do about it */
const decorate = (g: LudarrGame, m: ReturnType<typeof peopleMaps>, viewer: UserRow): AhoyGame => ({
  ...forPlayers(g),
  people: { requestedBy: m.wants.get(g.id) ?? [], owners: m.owners.get(g.id) ?? [], playing: m.playing.get(g.id) ?? [] },
  may: { cancel: !!g.request && mayCancel(viewer, g.request.id, g), version: mayVersion(viewer, g) },
});

export function listGames(viewer: UserRow): AhoyGame[] {
  const m = peopleMaps();
  return ludarr.library().map(g => decorate(g, m, viewer));
}
export async function gameDetail(id: number, viewer: UserRow): Promise<AhoyGameDetail> {
  const g = await ludarr.get<{ item: LudarrGameDetail }>(`/api/v1/game/${id}`);
  return { ...decorate(g.item, peopleMaps(), viewer), activity: activityOfGame(id) } as AhoyGameDetail;
}
/** the library's shape for discovery: by Steam app id, which games are tracked, and each game's request state */
export function libraryContext() {
  const lib = ludarr.libraryByApp();
  const follows = new Set(ludarr.library().filter(g => g.tracked).map(g => g.id));
  const reqState = new Map<number, string>();
  for (const g of ludarr.library()) if (g.request) reqState.set(g.id, g.request.state);
  return { lib, follows, reqState };
}

/* ─────────────────────── actions ─────────────────────── */

/** after an action: the engine's library read again, and "library" announced even when the engine's copy is the same (who wants
 *  a game is Ahoy's own, and every page shows it) */
const after = async () => { await ludarr.refreshLibrary(); events.emit("library", { games: ludarr.library().length }); };

/**
 * Whose game, whose search (social.ts asked / request_starts). The engine answers "add this game" the same way for a game it
 * already has, so a game is this person's only when it was not in the library before they asked and the engine says it was
 * added just now; a search is theirs when it was not running before their action.
 */
const addedSecondsAgo = (g: LudarrGame) => Date.now() / 1000 - seconds(g.addedAt);
/** the states in which the engine is still at work on a search (anything else: it ended, or stopped waiting) */
const RUNNING = new Set(["requested", "matching", "fetching", "processing"]);
function noteAdd(user: UserRow, item: LudarrGame, known: LudarrGame | undefined) {
  if (!known && addedSecondsAgo(item) < NEW_GAME_S) noteAsked(user.id, item.id);
  const now = item.request?.id ?? null;
  if (now != null && now !== (known?.request?.id ?? null)) noteStarted(user.id, item.id, now);
}
/** may this person take the game off the server? An admin; or the member who brought it, while nobody else wants it */
export function mayRemove(user: UserRow, gameId: number): { ok: boolean; others: boolean } {
  if (user.role === "admin") return { ok: true, others: false };
  const asker = askerOf(gameId), others = othersWant(user.id, gameId);
  return { ok: asker === user.id && !others, others: others || (asker != null && asker !== user.id) };
}
/** may this person cancel that search? An admin; or the member who started it or who brought its game (`of`: the game it
 *  runs for, when the caller has it at hand) */
export function mayCancel(user: UserRow, requestId: number, of?: LudarrGame): boolean {
  if (user.role === "admin") return true;
  const g = of ?? ludarr.library().find(x => x.request?.id === requestId);
  return starterOf(requestId) === user.id || (!!g && askerOf(g.id) === user.id);
}

/**
 * May this person say which version of the game is looked for (the arcade's, a console's)? Only a game on several platforms
 * that has no copy yet. While a search runs it is whoever may cancel that search (another version stops it and starts one
 * for the new version); with none running, anyone while no version was chosen, and after that the member who brought the
 * game. An admin always.
 */
export function mayVersion(user: UserRow, g: LudarrGame): boolean {
  if ((g.platformChoices?.length ?? 0) < 2 || g.hasFile) return false;
  if (user.role === "admin") return true;
  if (g.request && RUNNING.has(g.request.state)) return mayCancel(user, g.request.id, g);
  return g.wantPlatform == null || askerOf(g.id) === user.id;
}

/** "Get it" on a storefront app: ludarr onboards it and starts looking (searchNow=false: just watch / track it). `from`: the
 *  PC it was asked from, when it was one (a game asked for is installed by the PCs that say so: pcs.ts ordersForWant) */
export async function getSteam(user: UserRow, appId: number, searchNow: boolean, from: string | null = null): Promise<AhoyGame> {
  const r = await ludarr.post<{ item: LudarrGame }>("/api/v1/game", { source: "steam", id: String(appId), monitored: true, searchNow });
  noteAdd(user, r.item, ludarr.libraryById().get(r.item.id));
  want(user, r.item.id, searchNow ? "get" : r.item.comingSoon ? "track" : "watch", r.item.name, r.item.steamAppId);
  if (searchNow) ordersForWant(user, r.item, from);
  await after();
  return decorate(r.item, peopleMaps(), user);
}
/** `platform`: the version that was asked for, when the hit is on several (the engine looks for that one only) */
export async function getHit(user: UserRow, hit: { scheme: string; value: string }, searchNow: boolean, from: string | null = null, platform?: string): Promise<AhoyGame> {
  const edition = hit.scheme === "launchbox" ? await platformRequest(hit.value, platform)
    : { source: hit.scheme, id: hit.value, ...(platform ? { platform } : {}) };
  const r = await ludarr.post<{ item: LudarrGame }>("/api/v1/game", { ...edition, monitored: true, searchNow });
  noteAdd(user, r.item, ludarr.libraryById().get(r.item.id));
  want(user, r.item.id, searchNow ? "get" : "watch", r.item.name, r.item.steamAppId);
  if (searchNow) ordersForWant(user, r.item, from);
  await after();
  return decorate(r.item, peopleMaps(), user);
}
/** a library game: look (again) for a copy. The answer says only whether a search was already running: the engine's request
 *  carries its own words (stages, releases), which members never read */
export async function search(user: UserRow, gameId: number, from: string | null = null): Promise<{ duplicate: boolean }> {
  const g = ludarr.libraryById().get(gameId);
  if (g && !g.monitored) await ludarr.put(`/api/v1/game/${gameId}`, { monitored: true });
  const r = await ludarr.post<{ request?: { id?: number; state?: string } | null; duplicate?: boolean }>(`/api/v1/game/${gameId}/search`);
  if (g) { want(user, gameId, "get", g.name, g.steamAppId); ordersForWant(user, g, from); }
  // whose search it is comes from the engine's own answer: which search this press got, and whether it was there already. The
  // library read again below cannot say: a re-read that was already on its way is handed back as it was asked, without it
  const id = r?.request?.id, was = g?.request ?? null;
  if (typeof id === "number") {
    if (!r.duplicate) noteStarted(user.id, gameId, id);
    // "already there", but it had stopped (it gave up waiting for its download) and runs again now: this press set it going
    else if (was?.id === id && !RUNNING.has(was.state) && RUNNING.has(String(r.request?.state))) noteRestarted(user.id, gameId, id, was.updatedAt);
  }
  await after();
  return { duplicate: !!r?.duplicate };
}
/**
 * Which version of a game is looked for (`platform`: one of its platformChoices' ids, or null for no choice). The engine
 * stops a search that runs for another version and looks again for this one; asking for a version is asking for the game,
 * so this person wants it from now (and their PCs that install what they ask for get it), and the search it starts is
 * theirs. A game nobody was looking for is looked for.
 */
export async function setVersion(user: UserRow, gameId: number, platform: string | null, from: string | null = null): Promise<{ item: AhoyGame }> {
  const g = ludarr.libraryById().get(gameId);
  if (!g) throw new ludarr.LudarrError("no such game", 404);
  const was = g.request ?? null;
  let item = (await ludarr.put<{ item: LudarrGame }>(`/api/v1/game/${gameId}`, { platform, monitored: true })).item;
  want(user, gameId, "get", g.name, g.steamAppId);
  ordersForWant(user, g, from);
  let now = item.request && RUNNING.has(item.request.state) ? item.request : null;
  if (now && now.id !== was?.id) noteStarted(user.id, gameId, now.id);
  // the same version as before, and nothing looking: look
  if (!now && !item.hasFile) {
    const r = await ludarr.post<{ request?: { id?: number } | null; duplicate?: boolean }>(`/api/v1/game/${gameId}/search`);
    if (typeof r?.request?.id === "number" && !r.duplicate) noteStarted(user.id, gameId, r.request.id);
  }
  await after();
  item = ludarr.libraryById().get(gameId) ?? item;
  return { item: decorate(item, peopleMaps(), user) };
}

/**
 * Track / stop tracking, for one person. Tracking is each person's own: Track books this person's want and has the engine keep
 * an eye on the game (monitored, so it arrives on release day); stopping drops only this person's want, and the engine stops
 * only once nobody else wants the game (asked for it, tracks it or watches it). One person never untracks a game for the others.
 */
export async function monitor(user: UserRow, gameId: number, on: boolean): Promise<{ item: AhoyGame }> {
  let item: LudarrGame | undefined;
  if (on) {
    item = (await ludarr.put<{ item: LudarrGame }>(`/api/v1/game/${gameId}`, { monitored: true })).item;
    want(user, gameId, item.comingSoon ? "track" : "watch", item.name, item.steamAppId);
  } else {
    dropWant(user.id, gameId);
    dropWantedOrders(user.id, gameId);
    if (wantCount(gameId) === 0) item = (await ludarr.put<{ item: LudarrGame }>(`/api/v1/game/${gameId}`, { monitored: false })).item;
  }
  await after();
  item = ludarr.libraryById().get(gameId) ?? item;
  if (!item) throw new ludarr.LudarrError("no such game", 404);
  return { item: decorate(item, peopleMaps(), user) };
}
/**
 * Cancel: the search (or the download) stops, and stays stopped. The engine looks again by itself for every game it still
 * watches and has no copy of (every few hours, and each time it starts), so stopping the running search alone brought the
 * game back. For a game that has no copy on the server, what ends with the search:
 *  - whoever cancels no longer wants the game; an admin's cancel ends everyone's wish for it
 *  - once nobody wants it: a game that is on the server because someone here asked for it leaves the server, when it is
 *    the canceller's to remove (mayRemove; nothing of it is on disk); any other game (one whoever runs the server put
 *    there by hand, or someone else's) stays and is no longer looked for
 *  - while someone else still wants it, it stays wanted, and the engine looks again for them
 *  - what waited on a PC because the game was asked for no longer waits (an order placed by hand, Install on a PC, stays:
 *    it is its own wish, and waits for whoever still looks for the game)
 * A game that has a copy keeps it and stays as it is: the search cancelled was for a better copy.
 * `removed`: the game left the server.
 */
export async function cancel(user: UserRow, requestId: number): Promise<{ ok: true; removed: boolean }> {
  const g = ludarr.library().find(x => x.request?.id === requestId);
  await ludarr.del(`/api/v1/queue/${requestId}`);
  let removed = false;
  if (g && !g.hasFile) {
    if (user.role === "admin") dropWants(g.id); else dropWant(user.id, g.id);
    dropWantedOrders(user.role === "admin" ? null : user.id, g.id);
    if (wantCount(g.id) === 0) {
      // the search is stopped by now, whatever happens next: a game that cannot be removed is at least not looked for again
      const quiet = () => ludarr.put(`/api/v1/game/${g.id}`, { monitored: false });
      if (askerOf(g.id) != null && mayRemove(user, g.id).ok) {
        try { await ludarr.del(`/api/v1/game/${g.id}?deleteFiles=0`); dropWants(g.id); dropAsked(g.id); dropOrdersOfGame(g.id); removed = true; }
        catch (e) { await quiet().catch(() => { throw e; }); }
      } else await quiet();
    }
  }
  await after();
  return { ok: true, removed };
}
export async function remove(gameId: number, files: boolean) { await ludarr.del(`/api/v1/game/${gameId}?deleteFiles=${files ? 1 : 0}`); dropWants(gameId); dropAsked(gameId); dropOrdersOfGame(gameId); await after(); return { ok: true }; }
export const lookup = (term: string) => ludarr.get<{ items: ludarr.LookupHit[] }>(`/api/v1/game/lookup?term=${encodeURIComponent(term)}`);

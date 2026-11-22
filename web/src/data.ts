/** Ahoy — the data every page shares: the library (live), the storefront feeds, one app, one search. */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, del, get, keptForPerson, personNow, post, put, type ActivityItem, type BestList, type BestListInfo, type DiscoverItem, type DiscoverSection, type Game, type GameDetail, type LookupHit, type Person, type Presence, type Profile, type UserRef } from "./api";
import { useEvents } from "./events";
import { useSession } from "./session";
import { rememberArtRevisions } from "./art-revisions";

/* ─────────── the library, live ─────────── */

export interface Lib { games: Game[]; loaded: boolean; error: string | null; reload: () => Promise<void>; byApp: Map<number, Game>; byId: Map<number, Game> }
export const LibCtx = createContext<Lib>({ games: [], loaded: false, error: null, reload: async () => {}, byApp: new Map(), byId: new Map() });
export const useLib = () => useContext(LibCtx);

export function useLibrarySource(): Lib {
  const [games, setGames] = useState<Game[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // every event asks again, and answers can come back out of order: only the one asked for last is shown
  const asked = useRef(0);
  const reload = async () => {
    const mine = ++asked.current;
    try { const items = (await get<{ items: Game[] }>("/api/v1/game")).items; if (mine === asked.current) { rememberArtRevisions(items); setGames(items); setError(null); } }
    catch (e: any) { if (mine === asked.current) setError(String(e?.message ?? e)); }
    finally { setLoaded(true); }
  };
  useEffect(() => { void reload(); }, []);
  // "hello": the stream is back (the server restarted, this PC woke up). What happened meanwhile was never told, so ask
  useEvents(["library", "engine", "presence", "install", "hello"], () => void reload());
  const byApp = useMemo(() => new Map(games.filter(g => g.steamAppId != null).map(g => [g.steamAppId!, g])), [games]);
  const byId = useMemo(() => new Map(games.map(g => [g.id, g])), [games]);
  return { games, loaded, error, reload, byApp, byId };
}

/* ─────────── the storefront feeds (cached across pages) ─────────── */

let feedCache: { at: number; sections: DiscoverSection[] } | null = null;
keptForPerson(() => { feedCache = null; });
/** the store's rows, kept five minutes across pages; `reload` asks again whatever is kept (an empty answer, an error) */
export function useDiscover(enabled = true) {
  const [sections, setSections] = useState<DiscoverSection[] | null>(feedCache?.sections ?? null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    if (!asked && feedCache && Date.now() - feedCache.at < 5 * 60_000) { setSections(feedCache.sections); return; }
    get<{ sections: DiscoverSection[] }>("/api/v1/discover").then(r => { feedCache = { at: Date.now(), sections: r.sections }; setSections(r.sections); setError(null); }).catch(e => setError(String(e?.message ?? e)));
  }, [asked, enabled]);
  const section = (key: string) => sections?.find(s => s.key === key)?.items ?? [];
  const reload = () => { feedCache = null; setSections(null); setError(null); setAsked(n => n + 1); };
  return { sections, error, section, reload };
}

/* ─────────── one game / one app ─────────── */

export function useGame(id: number) {
  const [item, setItem] = useState<GameDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // an answer is used only when nothing was asked since: never another game's (the id changed while it was on its way)
  const asked = useRef(0);
  // id < 0: no game (the big screen's store pages ask with -1); nothing to fetch, and no 404 on every library event
  const load = () => {
    const mine = ++asked.current;
    if (id < 0) return Promise.resolve();
    return get<{ item: GameDetail }>(`/api/v1/game/${id}`).then(r => { if (mine === asked.current) { rememberArtRevisions([r.item]); setItem(r.item); setError(null); } }).catch(e => { if (mine === asked.current) setError(String(e?.message ?? e)); });
  };
  useEffect(() => { setItem(null); setError(null); void load(); }, [id]);
  useEvents(["library", "engine", "presence", "install", "activity", "hello"], () => void load(), [id]);
  return { item, error, reload: load };
}

export interface Trailer { name: string; thumb: string; hls: string | null; mp4: string | null; webm: string | null }
export interface AppDetail extends DiscoverItem { developers: string[]; publishers: string[]; about: string | null; screenshots: string[]; trailers: Trailer[]; hero: string | null; header: string | null; platforms: string[] }
/** how long a store app's answer is taken as it is: it also says how the app stands on this server (its game, whether it can be
 *  played yet), and the launcher's page lives for days */
export const APP_FRESH_MS = 10 * 60_000;
const appCache = new Map<number, { at: number; item: AppDetail }>();
keptForPerson(() => appCache.clear());
/**
 * One store app's page facts; `status` is the answer's HTTP status when it failed (404: Steam does not know it; else an outage).
 * The answer is kept: a fresh one is shown as it is, an older one is shown while it is asked again. An answer that arrives after
 * the page moved on to another app is kept for that app and not shown.
 */
export function useApp(appId: number | null | undefined) {
  const [item, setItem] = useState<AppDetail | null>(appId ? appCache.get(appId)?.item ?? null : null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  useEffect(() => {
    if (!appId) { setItem(null); return; }
    const hit = appCache.get(appId);
    setItem(hit?.item ?? null); setError(null); setStatus(null);
    if (hit && Date.now() - hit.at < APP_FRESH_MS) return;
    let live = true;
    get<{ item: AppDetail }>(`/api/v1/discover/app/${appId}`).then(r => { appCache.set(appId, { at: Date.now(), item: r.item }); if (live) setItem(r.item); })
      .catch(e => { if (!live || hit) return; setError(String(e?.message ?? e)); setStatus(e instanceof ApiError ? e.status : 0); });   // an older answer stays up
    return () => { live = false; };
  }, [appId]);
  return { item, error, status };
}
/**
 * The library game a store app's page belongs to, or null. The app's answer names one (`gameId`), but it may have been kept
 * since before that game left the server: it counts only while the library has that game (or has not been read yet). The
 * library's own game for the app counts always.
 */
export function gameOfApp(lib: Pick<Lib, "loaded" | "byId" | "byApp">, appId: number, app: Pick<DiscoverItem, "gameId"> | null | undefined): number | null {
  const named = app?.gameId ?? null;
  if (named != null && (!lib.loaded || lib.byId.has(named))) return named;
  return lib.byApp.get(appId)?.id ?? null;
}

/* ─────────── more rows: genres, and what just became playable ─────────── */

export interface Genre { tag: number; label: string }
/** one genre: the games players rate highest, and what sells now */
export interface GenreRows { sellers: DiscoverItem[]; rated: DiscoverItem[] }
const rowCache = new Map<string, { at: number; items: unknown }>();
keptForPerson(() => rowCache.clear());
/** a row kept ten minutes under `key`. What is shown is always this key's: nothing for no key, and an answer that arrives after
 *  the key changed is kept for its own key, not shown under the new one (one game's "More like this" under the next) */
function useCachedRow<T>(key: string, path: string, pick: (r: any) => T, enabled = true) {
  const [items, setItems] = useState<T | null>(enabled ? (rowCache.get(key)?.items as T | undefined) ?? null : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (!enabled) { setItems(null); return; }
    const c = rowCache.get(key);
    setItems((c?.items as T | undefined) ?? null);
    if (c && Date.now() - c.at < 10 * 60_000) return;
    let live = true;
    get(path).then(r => { const it = pick(r); rowCache.set(key, { at: Date.now(), items: it }); if (live) { setItems(it); setError(null); } }).catch(e => { if (live) setError(String(e?.message ?? e)); });
    return () => { live = false; };
  }, [key, enabled]);
  return { items, error };
}
export const usePlayable = () => useCachedRow("playable", "/api/v1/discover/playable", (r: { items: DiscoverItem[] }) => r.items);
export const useDiscoverPlatforms = (attempt: number) => useCachedRow(`discover.platforms.${attempt}`, "/api/v1/discover/platforms",
  (r: { items: { id: string; label: string; count: number }[] }) => r.items);
export const useGenre = (tag: number | null) => useCachedRow(`genre.${tag}`, `/api/v1/discover/genre/${tag}`, (r: GenreRows) => ({ sellers: r.sellers, rated: r.rated }), tag != null);
let genreCache: Genre[] | null = null;
export function useGenres() {
  const [items, setItems] = useState<Genre[]>(genreCache ?? []);
  useEffect(() => { if (genreCache) return; get<{ items: Genre[] }>("/api/v1/discover/genres").then(r => { genreCache = r.items; setItems(r.items); }).catch(() => {}); }, []);
  return items;
}

export const useSimilar = (appId: number | null | undefined) => useCachedRow(`similar.${appId}`, `/api/v1/discover/app/${appId}/similar`, (r: { items: DiscoverItem[] }) => r.items, !!appId);

/* ─────────── the best, by Metacritic ─────────── */

let bestListsCache: BestListInfo[] | null = null;
export function useBestLists() {
  const [items, setItems] = useState<BestListInfo[]>(bestListsCache ?? []);
  useEffect(() => { if (bestListsCache) return; get<{ items: BestListInfo[] }>("/api/v1/discover/best").then(r => { bestListsCache = r.items; setItems(r.items); }).catch(() => {}); }, []);
  return items;
}
const bestCache = new Map<string, { at: number; list: BestList }>();
keptForPerson(() => bestCache.clear());
/** one list; while the server is still matching titles to the store it is asked again every few seconds */
export function useBest(key: string | null) {
  const [list, setList] = useState<BestList | null>(key ? bestCache.get(key)?.list ?? null : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!key) { setList(null); return; }
    const c = bestCache.get(key);
    setList(c?.list ?? null); setError(null);
    if (c && Date.now() - c.at < 10 * 60_000 && !c.list.pending) return;
    let dead = false, tries = 0, t: ReturnType<typeof setTimeout> | null = null;
    const load = () => get<BestList>(`/api/v1/discover/best/${key}`).then(r => {
      if (dead) return;
      bestCache.set(key, { at: Date.now(), list: r }); setList(r); setError(null);
      if (r.pending > 0 && tries++ < 15) t = setTimeout(load, 4000);
    }).catch(e => { if (!dead) setError(String(e?.message ?? e)); });
    load();
    return () => { dead = true; if (t) clearTimeout(t); };
  }, [key]);
  return { list, error };
}

/* ─────────── search ─────────── */

export function useLookup(term: string) {
  const [hits, setHits] = useState<LookupHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gen = useRef(0);
  useEffect(() => {
    const q = term.trim();
    if (!q) { setHits(null); return; }
    const g = ++gen.current;
    setBusy(true);
    const t = setTimeout(() => get<{ items: LookupHit[] }>(`/api/v1/game/lookup?term=${encodeURIComponent(q)}`)
      .then(r => { if (g === gen.current) { setHits(r.items); setError(null); } })
      .catch(e => { if (g === gen.current) setError(String(e?.message ?? e)); })
      .finally(() => { if (g === gen.current) setBusy(false); }), 250);
    return () => clearTimeout(t);
  }, [term]);
  return { hits, error, busy };
}

/* ─────────── actions: one verb each ─────────── */

/* ─────────── people ─────────── */

/**
 * A load that failed (the server restarting, the network gone) is tried again with growing pauses, and once more when
 * the event stream reconnects ("hello") — a panel that is open through a restart must not sit on "Reading…" for good.
 */
function useRetry(error: string | null, load: () => void) {
  const tries = useRef(0);
  useEffect(() => {
    if (!error) { tries.current = 0; return; }
    const t = setTimeout(() => { tries.current++; load(); }, Math.min(30_000, 3000 * 2 ** tries.current));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);
}
/**
 * Everyone on this server, one copy for the whole page: the bell, the Home's chips, Friends and Settings' People read the same
 * answer, and one request serves them all (a load already on its way is shared). It belongs to whoever is signed in: another
 * person signing in starts from nothing.
 */
let peopleOf: { owner: number | null; items: Person[] | null; error: string | null } = { owner: null, items: null, error: null };
let peopleFlight: Promise<void> | null = null;
const peopleSubs = new Set<() => void>();
function loadPeople(owner: number | null): Promise<void> {
  if (peopleOf.owner !== owner) { peopleOf = { owner, items: null, error: null }; peopleFlight = null; }
  peopleFlight ??= get<{ items: Person[] }>("/api/v1/people")
    .then(r => { if (peopleOf.owner === owner) peopleOf = { owner, items: r.items, error: null }; },
      e => { if (peopleOf.owner === owner) peopleOf = { ...peopleOf, error: String(e?.message ?? e) }; })
    .finally(() => { peopleFlight = null; for (const f of peopleSubs) f(); });
  return peopleFlight;
}
export function usePeople() {
  const owner = useSession().me?.id ?? null;
  const [, bump] = useState(0);
  const load = () => loadPeople(owner);
  useEffect(() => {
    const on = () => bump(n => n + 1);
    peopleSubs.add(on);
    // the first reader on the page asks (a second one reads the copy); so does any reader that finds another person's copy
    if (peopleSubs.size === 1 || peopleOf.owner !== owner || (!peopleOf.items && !peopleFlight)) void load();
    return () => { peopleSubs.delete(on); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);
  useEvents(["presence", "friend", "user", "hello"], () => void load(), [owner]);
  const mine = peopleOf.owner === owner ? peopleOf : { items: null, error: null };
  useRetry(mine.error, () => void load());
  return { items: mine.items, error: mine.error, reload: load };
}
export interface Friends { friends: (UserRef & { presence: Presence })[]; incoming: (UserRef & { presence: Presence })[]; outgoing: (UserRef & { presence: Presence })[] }
/** my friends, kept so the menu and the bell open with them: mine only (forgotten when I leave; an answer that comes after is
 *  not kept for the next person) */
let friendsCache: Friends | null = null;
keptForPerson(() => { friendsCache = null; });
export function useFriends() {
  const [data, setData] = useState<Friends | null>(friendsCache);
  const [error, setError] = useState<string | null>(null);
  const load = () => { const who = personNow(); return get<Friends>("/api/v1/friends").then(r => { if (who === personNow()) friendsCache = r; setData(r); setError(null); }).catch(e => setError(String(e?.message ?? e))); };
  useEffect(() => { void load(); }, []);
  useEvents(["presence", "friend", "user", "hello"], () => void load());
  useRetry(error, load);
  return { data, error, reload: load };
}
export function useActivity(only: "friends" | "mine" | "all" = "friends", limit = 30) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => get<{ items: ActivityItem[] }>(`/api/v1/activity?only=${only}&limit=${limit}`).then(r => { setItems(r.items); setError(null); }).catch(e => setError(String(e?.message ?? e)));
  useEffect(() => { void load(); }, [only, limit]);
  useEvents(["activity", "friend", "hello"], () => void load(), [only, limit]);
  useRetry(error, load);
  return { items, error, reload: load };
}
export function useProfile(name: string | undefined) {
  const [item, setItem] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  // an answer is used only when nothing was asked since: never another person's (the name changed while it was on its way)
  const asked = useRef(0);
  const load = () => {
    const mine = ++asked.current;
    if (!name) return;
    get<Profile>(`/api/v1/people/${encodeURIComponent(name)}`).then(p => { if (mine === asked.current) { setItem(p); setError(null); } }).catch(e => { if (mine === asked.current) setError(String(e?.message ?? e)); });
  };
  useEffect(() => { setItem(null); setError(null); load(); }, [name]);
  useEvents(["presence", "friend", "activity", "install", "user"], () => load(), [name]);
  return { item, error, reload: load };
}

export const act = {
  befriend: (userId: number) => post<{ state: string }>(`/api/v1/friends/${userId}`),
  unfriend: (userId: number) => del<{ state: string }>(`/api/v1/friends/${userId}`),
  /** add a Steam app to the server and start looking for it (or just watch it when it cannot be had yet) */
  getSteam: (appId: number, searchNow = true) => post<{ item: Game }>("/api/v1/game", { source: "steam", id: String(appId), monitored: true, searchNow }),
  /** platform: the version asked for, when the hit is on several */
  getHit: (h: LookupHit, searchNow = true, platform?: string) => post<{ item: Game }>("/api/v1/game", { source: h.id.scheme, id: h.id.value, monitored: true, searchNow, ...(platform ? { platform } : {}) }),
  /** which version of a library game is looked for (it is looked for at once) */
  setVersion: (gameId: number, platform: string | null) => put<{ item: Game }>(`/api/v1/game/${gameId}/version`, { platform }),
  /** a game already on the server: look again (also what "Get it" means for a library game without a copy) */
  search: (gameId: number) => post(`/api/v1/game/${gameId}/search`),
  monitor: (gameId: number, on: boolean) => put(`/api/v1/game/${gameId}`, { monitored: on }),
  cancel: (requestId: number) => del(`/api/v1/queue/${requestId}`),
  remove: (gameId: number, files: boolean) => del(`/api/v1/game/${gameId}?deleteFiles=${files ? 1 : 0}`),
};

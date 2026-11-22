/**
 * Ahoy — the Library as a list in the picked game's room (reworked 2026-11-07 after "the list view in the library is bad": three
 * prototypes judged side by side; the room from one, the density, the filter's place and the walk from another).
 *   the room      the picked game's key art fills the window as on the Home (the Spotlight, bare: the server lays the art out
 *                 for the window), under the top bar; a band keeps the controls calm on bright art, a shade keeps the floor.
 *                 Where its art cannot stand (none, too small for the window, or it would not come) its poster's colours do
 *   the controls  the wall's own control row in the wall's place (the shelves, the filter, the sort, the view switch): switching
 *                 views moves none of them; under 1200 px the filter heads the list instead
 *   the list      a frosted pane from under the controls to the window's bottom: every game grouped by where it is (On this PC,
 *                 On the way, Ready to install, Coming, then the games that are none of those), each shelf in the chosen sort
 *                 (Coming by date unless the sort is Name); a 48 px row per game: its cover, its name, one quiet line; under
 *                 the pointer its one action. It comes to rest on a row's edge (the row above out of sight); rows leave at
 *                 the bottom through a soft edge
 *   the game      beside the pane, on the room's floor: its logo or name in a fixed slot, one facts line, the one thing to do and
 *                 Details, a strip of its facts (the journey first while it moves, Lately last). Nothing moves between picks.
 * A click picks a game (its words come into focus, its art cross-fades in); a double click, Enter or Details opens its page, and
 * Back comes back to the list as it was (its filter, its place, the keys' walk). Up, Down, Page Up, Page Down, Home and End walk
 * the list while it has the focus: the words change at once, the art follows once the walk rests (the old art dims meanwhile).
 * Typing there goes to the filter (Escape clears it, Down comes back). A filter that matches nothing lets the room recede behind
 * "Nothing called …". A window too narrow for the two keeps the list alone: a click opens the page, the first key marks a row.
 */
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactNode, type SyntheticEvent, type UIEvent,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { fmtPlay, get, keptForPerson, personNow, timeAgo, urlBase, type ActivityItem, type Game, type GameDetail } from "../api";
import { useLib } from "../data";
import { useEvents } from "../events";
import { useLauncher } from "../launcher-state";
import { journeyOf } from "../model";
import { useUnderBar } from "../shell";
import { art, useArtMeta } from "../ui/art";
import { Avatar } from "../ui/avatar";
import { Button, ButtonLink } from "../ui/button";
import { GameAction, GameActionView, useGameAction } from "../ui/game-action";
import { Icon } from "../ui/icons";
import { JourneyLine } from "../ui/journey";
import { useSwapFocus } from "../ui/motion";
import { FEED_VERB } from "../ui/people";
import { Spotlight, cachedLayout, decodeArt, isDecoded, prefetchSpotlight, useSpotlightLayout, widthBucket, type SpotLayout } from "../ui/spotlight";
import { artProgress, libraryLine, spoken, type Line, type LineCtx, type Played } from "../ui/status";
import { cleanName } from "../ui/words";
import { factsLine, libraryFacts, releaseOut } from "./game-parts";
import { SHELF_TITLE, type Shelf, type Sort, type useShelves } from "./library-parts";
import "./library-list.css";

type Shelves = ReturnType<typeof useShelves>;
type Key = Exclude<Shelf, "all"> | "none";
interface Group { key: Key; title: string; games: Game[] }
type Env = { w: number; bar: number; left: number };
/** how a pick was made: a click, or a step of the keys */
type How = "key" | "pointer";

/** too narrow for the pane and the room: the list alone, and a click opens the game's page */
const NARROW = "(max-width: 899px)";
/** too narrow for the filter beside the shelves and the sort: it heads the list (the control row is then the wall's exactly) */
const COMPACT = "(max-width: 1199px)";
const SEL_KEY = "ahoy.libsel";
/** a walk with the keys: the art waits for the pick to rest this long */
const ROOM_SETTLE_MS = 140;
/** typing in the filter: the art waits for the typing to rest this long (a word's first letters match other games on the way) */
const TYPE_SETTLE_MS = 260;
/** the longest the art waits for a game's stage and art before it changes anyway (a first ask of the server's stage can take a
 *  second; meanwhile the old art stays, dimmed; then the game's poster colours stand in until its art comes) */
const STAGE_WAIT_MS = 2500;
/** the games beside the pick are warmed once it has rested this long (a walk warms nothing on the way) */
const NEAR_SETTLE_MS = 300;
const ROW_H = 48;
/** the list's soft edges: a row comes to rest where the top one ends (library-list.css scroll-padding: where its first group's
 *  name stands at its top, so the row above is out of sight), and a walk keeps the picked row clear of the bottom one */
const EDGE_TOP = 8, EDGE_BOTTOM = 44;
/** the list's own room after its last row (library-list.css); more is added so that its end rests on a row's edge too */
const LIST_END = 40;
/** key art drawn above twice its own size is too soft to fill the window: the poster's colours stand in */
const WEAK_SCALE = 2;
/** the poster's copy the room's field is made from: the wall's (204 × 2), so a switch from the wall finds it in */
const FIELD_W = 408;
const WALK = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", "Enter"]);
const EMPTY_SHELF: Record<Exclude<Shelf, "all">, string> = { here: "Nothing on this PC yet", ready: "Nothing ready to install", way: "Nothing on the way", soon: "Nothing coming" };

const byName = (a: Game, b: Game) => cleanName(a.name).localeCompare(cleanName(b.name), undefined, { sensitivity: "base" });
/** a calendar day as a number to sort by (no date: last) */
const releaseKey = (g: Game) => { const t = g.releaseIso ? Date.parse(g.releaseIso) : NaN; return Number.isNaN(t) ? Infinity : t; };
const rememberedPick = (): number | null => { try { const v = Number(localStorage.getItem(SEL_KEY)); return v > 0 ? v : null; } catch { return null; } };
const remember = (id: number) => { try { localStorage.setItem(SEL_KEY, String(id)); } catch { /* storage off */ } };
/** the room draws this stage's key art; else (no art, too soft for the window, no stage) the poster's field */
const artStands = (l: SpotLayout | null): l is SpotLayout => !!l && !l.art.placeholder && l.art.scale < WEAK_SCALE;

/** the list as it was left (its filter, its place, the keys' walk), kept in the list's own entry of the history as it changes:
 *  Back or Forward to that entry gives it back, however the list was left; a page loaded afresh has none */
interface Back { q: string; top: number; keys: boolean }
type EntryState = { key?: string; ahoyList?: Back } | null;
function readBack(): Back | null {
  const b = (window.history.state as EntryState)?.ahoyList;
  return b && typeof b.q === "string" && typeof b.top === "number" ? b : null;
}
/** written only while the history is still at the list's entry (react-router keeps the entry's key in it; the first has none) */
function keepBack(key: string, b: Back) {
  const h = window.history.state as EntryState;
  if ((h?.key ?? "default") !== key) return;
  const o = h?.ahoyList;
  if (o && o.q === b.q && o.top === b.top && o.keys === b.keys) return;
  try { window.history.replaceState({ ...h, ahoyList: b }, ""); } catch { /* refused (too many at once): the next change writes it */ }
}

/** a click that opened a page: the second click of a double click would land on the new page (its main button may well be under
 *  the pointer), so for a moment a click that continues a double click is dropped */
function swallowDoubleClick() {
  const kinds = ["mousedown", "mouseup", "click", "dblclick"] as const;
  const stop = (e: MouseEvent) => { if (e.detail > 1 || e.type === "dblclick") { e.preventDefault(); e.stopPropagation(); } };
  for (const k of kinds) window.addEventListener(k, stop, true);
  setTimeout(() => { for (const k of kinds) window.removeEventListener(k, stop, true); }, 600);
}

/** the list's groups in the wall's order, each in the chosen sort (useShelves sorts them; On the way runs furthest along first;
 *  Coming by its date unless the sort is Name), kept to the games whose name has the filter's words */
export function listGroups(sh: Shelves, shelf: Shelf, sort: Sort, filter: string, inLauncher: boolean): Group[] {
  const term = filter.toLowerCase();
  const keep = (g: Game) => !term || cleanName(g.name).toLowerCase().includes(term) || (g.aliases ?? []).some(a => a.toLowerCase().includes(term));
  const on = (k: Exclude<Shelf, "all">) => shelf === "all" || shelf === k;
  const out: Group[] = [];
  const add = (key: Key, title: string, games: Game[]) => { const kept = games.filter(keep); if (kept.length) out.push({ key, title, games: kept }); };
  if (on("here") && inLauncher) add("here", SHELF_TITLE.here, sh.here);
  if (on("way")) add("way", SHELF_TITLE.way, sh.way.filter(m => m.game && !m.loose).map(m => m.game!));
  if (on("ready")) add("ready", SHELF_TITLE.ready, sh.ready);
  if (on("soon")) add("soon", SHELF_TITLE.soon, sort === "name" ? sh.soon : [...sh.soon].sort((a, b) => releaseKey(a) - releaseKey(b) || byName(a, b)));
  if (shelf === "all") add("none", "Not on your server", sh.none);
  return out;
}

const held: HTMLImageElement[] = [];
/** an image asked for ahead, kept a moment (so the request runs on into the cache) */
function preload(url: string) { const i = new Image(); i.decoding = "async"; i.src = url; held.push(i); if (held.length > 48) held.shift(); }

/**
 * The list's room warmed from the wall (the List button under the pointer, or the focus): the game the list opens on has its
 * stage asked for and what the room draws first decoded, and the first rows' covers are asked for, so the switch opens on the art
 * rather than on the bare ground.
 */
export function warmListRoom(sh: Shelves, shelf: Shelf, sort: Sort, inLauncher: boolean) {
  if (typeof matchMedia === "function" && matchMedia(NARROW).matches) return;
  const flat = listGroups(sh, shelf, sort, "", inLauncher).flatMap(gr => gr.games);
  const id = rememberedPick(), g = flat.find(x => x.id === id) ?? flat[0];
  if (!g) return;
  for (const x of flat.slice(0, 20)) preload(art.poster(x.id, 96));
  // the list's page does not scroll, so its stage is the whole window (the wall's page may lose a scrollbar's width)
  void prefetchSpotlight({ gameId: g.id }, undefined, window.innerWidth).then(j => {
    const lay = j?.layout ?? cachedLayout({ gameId: g.id });
    void decodeArt(artStands(lay) ? urlBase + lay.art.url : art.poster(g.id, FIELD_W));
  });
}

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(query), f = () => setOn(m.matches);
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return on;
}

/** the stage the Spotlight asks the server for (its own rule: the window's width, the bar's and the margin's steps), so the room's
 *  identity reads the very answer the art is drawn from */
function stageEnv(): Env {
  const css = getComputedStyle(document.documentElement);
  const bar = parseFloat(css.getPropertyValue("--bar-h")) || 148, left = parseFloat(css.getPropertyValue("--page-x")) || 48;
  return { w: Math.round(document.documentElement.clientWidth), bar: bar <= 126 ? 104 : 148, left: left < 44 ? 40 : 48 };
}
function useStageEnv(): Env {
  const [env, setEnv] = useState(stageEnv);
  useEffect(() => {
    const on = () => setEnv(o => { const e = stageEnv(); return o.w === e.w && o.bar === e.bar && o.left === e.left ? o : e; });
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  return env;
}

/** the value once it has held still for `ms` (the first one at once) */
function useSettled<T>(v: T, ms: number): T {
  const [s, setS] = useState(v);
  useEffect(() => {
    if (Object.is(v, s)) return;
    const t = setTimeout(() => setS(v), ms);
    return () => clearTimeout(t);
  }, [v, s, ms]);
  return s;
}

/** some of the row is in the list's view */
function rowSeen(root: HTMLElement | null, id: number | undefined): boolean {
  const row = root && id != null ? root.querySelector<HTMLElement>(`#ll-${id}`) : null;
  if (!root || !row) return false;
  const b = root.getBoundingClientRect(), r = row.getBoundingClientRect();
  return r.bottom > b.top + EDGE_TOP && r.top < b.bottom;
}
/** where the list comes to rest at or past `s`: a row's (or a group name's) top at the end of the soft top edge */
function restAt(root: HTMLElement, s: number): number {
  const y0 = root.getBoundingClientRect().top - root.scrollTop;
  let best = Infinity;
  root.querySelectorAll<HTMLElement>(".ll-row, .ll-group > h2").forEach(e => {
    const p = e.getBoundingClientRect().top - y0 - EDGE_TOP;
    if (p >= s - 0.5 && p < best) best = p;
  });
  return best === Infinity ? s : Math.round(best);
}
/** the list's end rests on a row's edge too (the room after its last row makes the farthest scroll one of the resting places),
 *  and its scrollbar's gutter is measured, so the rows stand as far from either side of the pane */
function fitList(root: HTMLElement) {
  const gutter = `${Math.max(0, root.offsetWidth - root.clientWidth)}px`;
  if (root.style.getPropertyValue("--ll-gutter") !== gutter) root.style.setProperty("--ll-gutter", gutter);
  const extra = (parseFloat(root.style.paddingBottom) || LIST_END) - LIST_END;
  const max = root.scrollHeight - root.clientHeight - extra;
  const end = `${LIST_END + (max > 0 ? Math.max(0, restAt(root, max) - max) : 0)}px`;
  if (root.style.paddingBottom !== end) root.style.paddingBottom = end;
}

/* ─────────── a game's detail (Lately): asked once a pick has rested, kept ─────────── */

const details = new Map<number, GameDetail>();
keptForPerson(() => details.clear());   // a detail says what is its reader's to do about the game: the next person's is asked anew
const keepDetail = (id: number, d: GameDetail) => {
  details.delete(id);
  details.set(id, d);
  if (details.size > 120) { const first = details.keys().next(); if (!first.done) details.delete(first.value); }
};
/** the game's detail: asked 280 ms after it is picked (a walk asks nothing on the way), kept, so a game picked again shows it at
 *  once (and asks again quietly a moment later, and whenever the server says something changed) */
function useDetail(id: number): GameDetail | null {
  const [, bump] = useState(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const ask = (gid: number, who = personNow()) => get<{ item: GameDetail }>(`/api/v1/game/${gid}`)
    .then(r => { if (who === personNow()) keepDetail(gid, r.item); if (live.current) bump(n => n + 1); })
    .catch(() => { /* Lately stays out */ });
  useEffect(() => {
    const t = setTimeout(() => void ask(id), details.has(id) ? 900 : 280);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // "hello": the stream is back, and what happened meanwhile was never told
  useEvents(["library", "engine", "install", "activity", "hello"], () => void ask(id), [id]);
  return details.get(id) ?? null;
}

/* ─────────── the list view ─────────── */

export function LibraryList({ sh, c, shelf, setShelf, sort, controls }: {
  sh: Shelves; c: LineCtx; shelf: Shelf; setShelf: (s: Shelf) => void; sort: Sort;
  /** the wall's control row, given the filter to put before the sort (null: the filter heads the list instead) */
  controls: (filter: ReactNode) => ReactNode;
}) {
  const L = useLauncher();
  const lib = useLib();
  const nav = useNavigate();
  const loc = useLocation();
  const narrow = useMedia(NARROW);
  const compact = useMedia(COMPACT);
  useUnderBar(!narrow);                                    // the room's art runs under the top bar, as on the Home
  const env = useStageEnv();
  const envRef = useRef(env);
  envRef.current = env;
  // Back (or Forward) to the list: the list as it was left (its filter, its place, the keys' walk)
  const [back] = useState(() => readBack());
  const [q, setQ] = useState(back?.q ?? "");
  // walking the list with the keys draws the focus ring on the picked row (a pointer, or leaving the list, ends it)
  const [keys, setKeys] = useState(!!back?.keys);
  const keysNow = useRef(keys);
  keysNow.current = keys;
  const filter = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const t = q.trim();
  // how the pick last changed: a click, a step of the keys, or typing in the filter (the art follows each at its own pace)
  const by = useRef<How | "type">("pointer");
  const typed = (v: string) => { by.current = "type"; setQ(v); };
  // a letter typed in the list moves into the filter: the caret goes after it, so the next letters follow it
  const caretEnd = useRef(false);
  useLayoutEffect(() => {
    const el = filter.current;
    if (!caretEnd.current || !el) return;
    caretEnd.current = false;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [q]);
  // the filter keeps the focus and its caret when the window crosses 1200 px (it moves between the control row and the list)
  const compactWas = useRef(compact), caret = useRef<[number, number] | null>(null);
  if (compactWas.current !== compact) {
    compactWas.current = compact;
    const el = filter.current;
    caret.current = el && document.activeElement === el ? [el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length] : null;
  }
  useLayoutEffect(() => {
    const at = caret.current, el = filter.current;
    caret.current = null;
    if (at && el) { el.focus({ preventScroll: true }); el.setSelectionRange(at[0], at[1]); }
  }, [compact]);

  const groups = useMemo(() => listGroups(sh, shelf, sort, t, L.inLauncher),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sh.here, sh.ready, sh.way, sh.soon, sh.none, shelf, sort, t, L.inLauncher]);
  const flat = useMemo(() => groups.flatMap(gr => gr.games), [groups]);

  // the picked game: the one you picked while it is in the list, else the first (remembered in this browser)
  const [picked, setPicked] = useState<number | null>(rememberedPick);
  const sel = flat.find(g => g.id === picked) ?? flat[0] ?? null;
  const pick = (g: Game, h: How) => { by.current = h; setPicked(g.id); remember(g.id); };
  // the list's place kept in its entry of the history: a moment after it changes, and at once when a press may leave the list
  // (a link, the bar's Back, the mouse's back button: a pointer leaves the keys' walk behind)
  const qNow = useRef(q), keyNow = useRef(loc.key), backTm = useRef<ReturnType<typeof setTimeout>>();
  qNow.current = q;
  keyNow.current = loc.key;
  const saveBack = (withKeys: boolean) => {
    clearTimeout(backTm.current);
    backTm.current = undefined;
    keepBack(keyNow.current, { q: qNow.current, top: Math.round(list.current?.scrollTop ?? 0), keys: withKeys });
  };
  const keysHeld = () => keysNow.current && document.activeElement === list.current;
  const saveSoon = () => { clearTimeout(backTm.current); backTm.current = setTimeout(() => saveBack(keysHeld()), 200); };
  useEffect(() => {
    const down = () => saveBack(false);
    const key = (e: globalThis.KeyboardEvent) => {
      if (backTm.current === undefined) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.key === "Enter" || e.key === " " || /^F\d{1,2}$/.test(e.key)) saveBack(keysHeld());
    };
    addEventListener("pointerdown", down, true);
    addEventListener("keydown", key, true);
    return () => { removeEventListener("pointerdown", down, true); removeEventListener("keydown", key, true); clearTimeout(backTm.current); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(saveSoon, [q, keys]);   // eslint-disable-line react-hooks/exhaustive-deps
  // leaving for a game's page (a double click, Enter, Details): it becomes the pick, and the list's place is kept for Back
  const leave = (g: Game, h: How) => {
    pick(g, h);
    saveBack(h === "key");
    if (h === "pointer") swallowDoubleClick();
  };
  const open = (g: Game, h: How) => { leave(g, h); nav(`/game/${g.id}`); };
  // the pick a click just made: the list does not move under the pointer between the two clicks of a double click
  const clicked = useRef<number | null>(null);
  // the rows' handlers keep their identity, so a pick draws the two rows it changes, not the whole list
  const live = useRef({ narrow, open, pick, sel });
  live.current = { narrow, open, pick, sel };
  const onRowPick = useCallback((g: Game) => {
    const l = live.current;
    if (l.narrow) { l.open(g, "pointer"); return; }
    if (g.id !== l.sel?.id) clicked.current = g.id;
    l.pick(g, "pointer");
  }, []);
  const onRowOpen = useCallback((g: Game) => live.current.open(g, "pointer"), []);

  // the art follows the pick: at once for a click, once the keys rest for a walk, once the typing rests for a filter; it changes
  // once what the room will draw for the game is known and decoded (so it cross-fades in place, never through an empty room),
  // STAGE_WAIT_MS at most. Nothing matching keeps the art.
  const [target, setTarget] = useState<number | null>(sel?.id ?? (picked != null && lib.byId.has(picked) ? picked : null));
  useEffect(() => {
    if (!sel || sel.id === target) return;
    const wait = by.current === "key" ? ROOM_SETTLE_MS : by.current === "type" ? TYPE_SETTLE_MS : 0;
    if (!wait) { setTarget(sel.id); return; }
    const tm = setTimeout(() => setTarget(sel.id), wait);
    return () => clearTimeout(tm);
  }, [sel?.id, target]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [artId, setArtId] = useState<number | null>(target);
  useEffect(() => {
    if (target == null || target === artId) return;
    const tm = setTimeout(() => setArtId(target), STAGE_WAIT_MS);
    return () => clearTimeout(tm);
  }, [target, artId]);
  const artGame = (artId != null ? lib.byId.get(artId) : undefined) ?? sel;
  const artLayout = useSpotlightLayout(!narrow && artGame ? { gameId: artGame.id } : null, env).json?.layout ?? null;
  // games whose key art would not load in this visit: the room shows their poster's colours
  const [broken, setBroken] = useState<ReadonlySet<number>>(() => new Set());
  const onBroken = useCallback((id: number) => setBroken(s => (s.has(id) ? s : new Set(s).add(id))), []);
  // ... until its art decodes after all (a blip): the next pick of it draws its art again
  const onMended = useCallback((id: number) => setBroken(s => { if (!s.has(id)) return s; const n = new Set(s); n.delete(id); return n; }), []);
  const stands = !!artGame && artStands(artLayout) && !broken.has(artGame.id);
  // the room draws the key art once it has decoded (until then the game's field stands in: an image still on its way, after the
  // wait for it, never leaves the room bare or keeps the last game's art up)
  const artUrl = stands && artLayout ? urlBase + artLayout.art.url : null;
  const [okUrl, setOkUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!artUrl || !artGame) return;
    if (isDecoded(artUrl)) { setOkUrl(artUrl); return; }
    let alive = true;
    const gid = artGame.id;
    void decodeArt(artUrl).then(ok => { if (!alive) return; if (ok) setOkUrl(artUrl); else onBroken(gid); });
    return () => { alive = false; };
  }, [artUrl]);   // eslint-disable-line react-hooks/exhaustive-deps
  const roomUrl = artUrl && (artUrl === okUrl || isDecoded(artUrl)) ? artUrl : null;
  // what the room is showing right now (its art drawn, or its field in): until it shows the pick, the art is dimmed as stale
  const [shown, setShown] = useState<number | null>(null);
  const onShown = useCallback((id: number) => setShown(s => (s === id ? s : id)), []);
  // the band under the controls: as strong as the server's top scrim says the art's top is bright (1 to 1.3)
  const band = stands && artLayout ? Math.min(1, Math.max(0, (artLayout.scrim.top - 1) / 0.3)) : 0.5;

  // the games beside the pick are warmed (their stage and their art decoded) once it rests, so the next step cross-fades at once
  const rested = useSettled(sel?.id ?? null, NEAR_SETTLE_MS);
  const at = rested == null ? -1 : flat.findIndex(g => g.id === rested);
  const near = narrow || at < 0 ? [] : [flat[at - 1], flat[at + 1]].filter((g): g is Game => !!g && g.id !== artId && g.id !== target);

  // the picked row kept in view inside the soft edges (a group's first row brings its group's name along), resting on a row's
  // edge; in a narrow window only once the keys have marked it
  const bring = () => {
    const root = list.current;
    if (!root || !sel || (narrow && !keysNow.current)) return;
    const row = root.querySelector<HTMLElement>(`#ll-${sel.id}`);
    if (!row) return;
    const box = root.getBoundingClientRect(), r = row.getBoundingClientRect();
    const top = (row.previousElementSibling ? r : (row.closest(".ll-group") ?? row).getBoundingClientRect()).top;
    if (top < box.top + EDGE_TOP) root.scrollTop += top - (box.top + EDGE_TOP);
    else if (r.bottom > box.bottom - EDGE_BOTTOM) root.scrollTop = restAt(root, root.scrollTop + r.bottom - (box.bottom - EDGE_BOTTOM));
  };
  // the list's end and its gutter, whenever its rows or its height change (before Back puts the list back: its end must be in)
  useLayoutEffect(() => { if (list.current) fitList(list.current); }, [groups]);
  // another shelf or filter starts the list from its top; Back puts it where it was
  const listFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const root = list.current, k = `${shelf}\n${t}`;
    if (!root) return;
    if (listFor.current == null) { listFor.current = k; if (back) root.scrollTop = back.top; return; }
    if (listFor.current === k) return;
    listFor.current = k;
    root.scrollTop = 0;
  }, [shelf, t]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Back to the list left with the keys: the list has the focus again, the ring on the pick
  useLayoutEffect(() => { if (back?.keys) list.current?.focus({ preventScroll: true }); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  // the list follows the pick (not a click's: that row is where the pointer is) and the window widening; a pick that moves to
  // another group (found, downloading, installed) only when its row was in view a moment before (measured in the list as it
  // still is, before this render's rows are in). The place Back gave holds until one of these changes.
  const selGroup = sel ? groups.find(gr => gr.games.includes(sel))?.key : undefined;
  const moved = useRef({ id: sel?.id, group: selGroup, seen: true });
  if (sel?.id !== moved.current.id) moved.current = { id: sel?.id, group: selGroup, seen: true };
  else if (selGroup !== moved.current.group) moved.current = { id: sel?.id, group: selGroup, seen: rowSeen(list.current, sel?.id) };
  const follow = `${sel?.id}|${selGroup}|${shelf}|${t}|${narrow}`, rest = `${sel?.id}|${shelf}|${t}|${narrow}`;
  const kept = useRef(back ? follow : "");
  const restWas = useRef(rest);
  useEffect(() => {
    const same = restWas.current === rest;
    restWas.current = rest;
    if (kept.current) { if (kept.current === follow) return; kept.current = ""; }
    if (sel && clicked.current === sel.id) { clicked.current = null; return; }
    if (same && !moved.current.seen) return;
    bring();
  }, [follow]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the keys arriving (a key, or the focus coming from the keyboard) bring the pick into view
  const keysWere = useRef(keys);
  useEffect(() => {
    if (keysWere.current === keys) return;
    keysWere.current = keys;
    if (keys) { kept.current = ""; bring(); }
  }, [keys]);   // eslint-disable-line react-hooks/exhaustive-deps
  // a new sort keeps the picked row where it stands (the others move around it), or brings it into view
  const sortWas = useRef(sort), sortHold = useRef<number | null | undefined>(undefined);
  if (sortWas.current !== sort) {
    sortWas.current = sort;
    const root = list.current, row = sel ? root?.querySelector<HTMLElement>(`#ll-${sel.id}`) : null;
    if (root && row) { const b = root.getBoundingClientRect(), r = row.getBoundingClientRect(); sortHold.current = r.bottom > b.top && r.top < b.bottom ? r.top - b.top : null; }
    else sortHold.current = null;
  }
  useLayoutEffect(() => {
    const hold = sortHold.current;
    sortHold.current = undefined;
    const root = list.current, row = sel ? root?.querySelector<HTMLElement>(`#ll-${sel.id}`) : null;
    if (hold === undefined || !root || !row || (narrow && !keysNow.current)) return;
    if (hold == null) { bring(); return; }
    root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top - hold;
  }, [sort]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const root = list.current;
    if (!root || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => fitList(root));
    ro.observe(root, { box: "border-box" });
    return () => ro.disconnect();
  }, []);
  // the soft top edge comes in as the list leaves its top (at rest there, its first group's name is not faded)
  const onListScroll = (e: UIEvent<HTMLDivElement>) => { const el = e.currentTarget; el.style.setProperty("--ll-up", `${Math.min(EDGE_TOP, Math.max(0, el.scrollTop))}px`); saveSoon(); };

  // the rows in view have their stage asked for once the list rests (a library of hundreds asks only for what is seen), once
  // per row and window width
  const ids = useMemo(() => flat.map(g => g.id).join(","), [flat]);
  const bucket = widthBucket(env.w);
  const asked = useRef({ w: 0, ids: new Set<number>() });
  useEffect(() => {
    const root = list.current;
    if (!root || narrow || typeof IntersectionObserver !== "function") return;
    if (asked.current.w !== bucket) asked.current = { w: bucket, ids: new Set() };
    const done = asked.current.ids, queue = new Set<number>();
    let tm: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(es => {
      for (const e of es) { const id = Number((e.target as HTMLElement).dataset.id); if (e.isIntersecting && !done.has(id)) queue.add(id); else queue.delete(id); }
      clearTimeout(tm);
      tm = setTimeout(() => { for (const id of queue) { done.add(id); void prefetchSpotlight({ gameId: id }, undefined, envRef.current.w); } queue.clear(); }, 400);
    }, { root });
    root.querySelectorAll<HTMLElement>(".ll-row").forEach(r => io.observe(r));
    return () => { io.disconnect(); clearTimeout(tm); };
  }, [ids, narrow, bucket]);

  // the keys mark a row, and it is the pick (in a filtered list its first match: clearing the filter keeps the ring on it). In a
  // narrow window no row is marked until the keys come: the first key marks one (the pick when it is in the list's view, else
  // the first row clear of its edges), the next ones walk and open. An empty list marks nothing.
  const mark = () => {
    const root = list.current;
    if (!root || !sel) return;
    let g: Game | undefined = sel;
    if (narrow) {
      const b = root.getBoundingClientRect();
      const inBox = (el: Element | null) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.top >= b.top + EDGE_TOP - 2 && r.bottom <= b.bottom + 0.5; };
      const clear = (el: Element) => { const r = el.getBoundingClientRect(); return r.top >= b.top + EDGE_TOP - 2 && r.bottom <= b.bottom - EDGE_BOTTOM + 4; };
      if (!inBox(root.querySelector(`#ll-${sel.id}`))) {
        const rows = Array.from(root.querySelectorAll<HTMLElement>(".ll-row")), first = rows.find(clear) ?? rows.find(inBox);
        g = first ? flat.find(x => x.id === Number(first.dataset.id)) : undefined;
      }
    }
    if (!g) return;
    if (g.id !== picked) pick(g, "key");
    setKeys(true);
  };
  // after Escape cleared the filter in a narrow list, the keys mark a row of the full list once it is drawn (at its top)
  const remark = useRef(false);
  useLayoutEffect(() => { if (remark.current) { remark.current = false; mark(); } }, [t]);   // eslint-disable-line react-hooks/exhaustive-deps
  const onKey = (e: KeyboardEvent) => {
    // typing filters ("/" stays the bar's search)
    if (e.key.length === 1 && e.key !== " " && e.key !== "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      caretEnd.current = true;
      by.current = "type";
      setQ(v => v + e.key);
      return;
    }
    if (e.key === "Escape" && q) { e.preventDefault(); e.stopPropagation(); if (narrow && !keys) remark.current = true; typed(""); return; }
    if (!sel || !flat.length || !WALK.has(e.key)) return;
    e.preventDefault();
    if (narrow && !keys) { mark(); return; }
    if (e.key === "Enter") { open(sel, "key"); return; }
    const i = flat.indexOf(sel), page = Math.max(1, Math.floor((list.current?.clientHeight ?? 480) / ROW_H) - 1);
    const n = e.key === "ArrowDown" ? flat[Math.min(flat.length - 1, i + 1)]
      : e.key === "ArrowUp" ? flat[Math.max(0, i - 1)]
      : e.key === "PageDown" ? flat[Math.min(flat.length - 1, i + page)]
      : e.key === "PageUp" ? flat[Math.max(0, i - page)]
      : e.key === "Home" ? flat[0] : flat[flat.length - 1];
    const to = n ?? sel;
    if (to.id !== picked) pick(to, "key");
    setKeys(true);
  };
  // the focus coming to the list from the keyboard marks the pick, as a key would
  const onListFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || keysNow.current || !e.currentTarget.matches(":focus-visible")) return;
    mark();
  };
  // in the filter: Escape clears it (then leaves it), Down or Enter goes into the list
  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (q) typed(""); else list.current?.focus(); return; }
    if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); list.current?.focus(); mark(); }
  };
  const clear = () => { typed(""); filter.current?.focus(); };
  const showAll = () => { setShelf("all"); list.current?.focus({ preventScroll: true }); };

  const field = (
    <label className={`tf lead ll-filter${q ? " has" : ""}`}>
      <Icon name="filter" size={16} className="tf-lead" />
      <input ref={filter} type="search" value={q} placeholder="Filter" aria-label="Filter your games" aria-controls="lib-shelves"
        autoComplete="off" spellCheck={false} onChange={e => typed(e.target.value)} onKeyDown={onFilterKey} />
      {q && <button type="button" className="ll-clear" aria-label="Clear the filter" onClick={clear}><Icon name="x" size={14} strokeWidth={2.4} /></button>}
    </label>
  );

  const none = t
    ? {
        title: <>Nothing called “{t}”</>, quiet: "No matches",
        acts: <><Button size={44} onClick={clear}>Clear the filter</Button><ButtonLink size={44} kind="quiet" icon="search" to={`/search?q=${encodeURIComponent(t)}`}>Search all games</ButtonLink></>,
      }
    : {
        title: <>{shelf === "all" ? "Nothing here yet" : EMPTY_SHELF[shelf]}</>, quiet: "Nothing here",
        acts: shelf === "all" ? null : <Button size={44} onClick={showAll}>Show all</Button>,
      };
  // what a filter leaves, said to a screen reader (the region is always there, so its first answer is heard)
  const said = t ? (flat.length ? `${flat.length} ${flat.length === 1 ? "game" : "games"}` : `Nothing called “${t}”`) : "";

  return (
    <div className={`ll${narrow ? " narrow" : ""}`}>
      <h1 className="sr-only">Library</h1>
      {!narrow && (
        <div className={`ll-art${!sel ? " recede" : artId !== sel.id || shown !== sel.id ? " stale" : ""}`} aria-hidden="true">
          {artGame && <RoomArt id={artGame.id} name={cleanName(artGame.name)} url={roomUrl} onBroken={onBroken} onShown={onShown} />}
          <div className="ll-band" style={{ opacity: 0.5 + band * 0.5 }} />
          <div className="ll-shade" />
          <div className="ll-veil" />
        </div>
      )}
      {near.map(g => <Warm key={g.id} id={g.id} env={env} onBroken={onBroken} onMended={onMended} />)}
      {!narrow && target != null && target !== artId && <Warm key={`w${target}`} id={target} env={env} onBroken={onBroken} onMended={onMended} onReady={() => setArtId(target)} />}
      <div className="ll-top">{controls(compact ? null : field)}</div>
      <div className="ll-body">
        <aside className="ll-pane" aria-label="Your games">
          {compact && <div className="ll-head">{field}</div>}
          <p className="sr-only" aria-live="polite">{said}</p>
          <div className={`ll-list${keys ? " keys" : ""}`} id="lib-shelves" ref={list} role="listbox" aria-label="Games" tabIndex={0}
            aria-activedescendant={sel && (!narrow || keys) ? `ll-${sel.id}` : undefined}
            onKeyDown={onKey} onFocus={onListFocus} onPointerDown={() => setKeys(false)} onBlur={() => setKeys(false)} onScroll={onListScroll}>
            {groups.length ? groups.map(gr => (
              <div className="ll-group" role="group" aria-labelledby={`ll-h-${gr.key}`} key={gr.key}>
                <h2 id={`ll-h-${gr.key}`}>{gr.title}<i>{gr.games.length}</i></h2>
                <ul className="ll-rows" role="presentation">
                  {gr.games.map(g => {
                    const { progress, grey } = artProgress(g, c);
                    return <Row key={g.id} g={g} line={rowLine(g, c, gr.key)} progress={progress} grey={grey} on={(!narrow || keys) && g.id === sel?.id} mark={t} envW={env.w} onPick={onRowPick} onOpen={onRowOpen} />;
                  })}
                </ul>
              </div>
            )) : narrow
              ? <div className="ll-empty"><p>{none.title}</p>{none.acts && <div className="ll-empty-acts">{none.acts}</div>}</div>
              : <p className="ll-quiet">{none.quiet}</p>}
          </div>
        </aside>
        {!narrow && (sel
          ? <Room g={sel} c={c} play={sh.play} env={env} still={by.current !== "pointer"} onLeave={h => leave(sel, h)} />
          : (
            <section className="ll-room" aria-label={none.quiet}>
              <div className="ll-who" key={t ? "none-filter" : `none-${shelf}`}>
                <div className="ll-id"><h2 className="ll-title t40 two">{none.title}</h2></div>
                {none.acts && <div className="ll-acts">{none.acts}</div>}
              </div>
            </section>
          ))}
      </div>
    </div>
  );
}

/** the list's frame while the library loads: the control row where it stays (with the filter's place), the pane with grey rows
 *  (it shows only if the load takes a moment) */
export function ListSkeleton({ controls }: { controls: (filter: ReactNode) => ReactNode }) {
  const narrow = useMedia(NARROW), compact = useMedia(COMPACT);
  useUnderBar(!narrow);
  const ghost = (
    <label className="tf lead ll-filter" aria-hidden="true">
      <Icon name="filter" size={16} className="tf-lead" />
      <input type="search" placeholder="Filter" readOnly tabIndex={-1} />
    </label>
  );
  return (
    <div className={`ll ll-loading${narrow ? " narrow" : ""}`} aria-busy="true">
      <h1 className="sr-only">Library</h1>
      <div className="ll-top">{controls(compact ? null : ghost)}</div>
      <div className="ll-body">
        <div className="ll-pane" aria-hidden="true">
          {compact && <div className="ll-head">{ghost}</div>}
          <div className="ll-list">
            <div className="ll-group">
              <span className="ll-ph-h" />
              <ul className="ll-rows">
                {Array.from({ length: 16 }, (_, i) => <li key={i} className="ll-row ll-ph"><span className="ll-th" /><span className="ll-what"><span className="ll-ph-name" /><span className="ll-ph-line" /></span></li>)}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── a row ─────────── */

const pct = (p: number) => `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
/** a row's line, in one quiet grey: the shelf's fact (ui/status libraryLine); a moving game says how far and how long ("Downloading
 *  31% · about 1 min left": its small cover cannot carry the number), else who asked and where it is ("Asked for by Mika ·
 *  Looking"); a coming one its day and who waits ("Nov 9 · in 2 days · Tracked") */
function rowLine(g: Game, c: LineCtx, k: Key): Line {
  const j = journeyOf(g, c.inst(g), c.prog(g));
  if (k === "way") {
    if (j.active && j.progress != null && j.progress > 0) {
      const s = `${j.label} ${pct(j.progress)}${j.eta ? ` · ${j.eta}` : ""}`;
      return { node: s, text: s };
    }
    return libraryLine(g, c);
  }
  if (k === "soon") {
    const out = releaseOut(g), who = libraryLine(g, c, { shelf: "soon" }).text;
    return { node: factsLine(g, j, c.meId ?? undefined, null), text: [out, who].filter(Boolean).join(" · ") };
  }
  return libraryLine(g, c, { shelf: k });
}

/** the name with what the filter matched lit */
function lit(name: string, term: string): ReactNode {
  if (!term) return name;
  const i = name.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return name;
  return <>{name.slice(0, i)}<mark>{name.slice(i, i + term.length)}</mark>{name.slice(i + term.length)}</>;
}

/** all that is left of the row is its foot, in the list's top edge (where the row above a resting one ends): it is out of sight */
const underEdge = (el: HTMLElement) => {
  const l = el.closest(".ll-list");
  if (!l) return false;
  const b = el.getBoundingClientRect().bottom, t = l.getBoundingClientRect().top;
  return b > t && b <= t + EDGE_TOP + 0.5;
};

interface RowProps { g: Game; line: Line; progress: number | null; grey: boolean; on: boolean; mark: string; envW: number; onPick: (g: Game) => void; onOpen: (g: Game) => void }
/** one game in the list: its cover, its name, its line; under the pointer its one action at the end (not on the picked one, whose
 *  action is in the room; the words make way only for an action there is). A row draws again only when what it shows changes. */
const Row = memo(function Row({ g, line, progress, grey, on, mark, envW, onPick, onOpen }: RowProps) {
  const [hot, setHot] = useState(false);
  const rest = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(rest.current), []);
  const name = cleanName(g.name);
  // a row the pointer rests on is likely the next pick: its stage is asked for after a moment (a sweep asks nothing)
  const enter = () => { setHot(true); clearTimeout(rest.current); rest.current = setTimeout(() => void prefetchSpotlight({ gameId: g.id }, undefined, envW), 160); };
  const leave = () => { setHot(false); clearTimeout(rest.current); };
  return (
    <li id={`ll-${g.id}`} data-id={g.id} className={`ll-row${on ? " on" : ""}${hot ? " hot" : ""}`} role="option" aria-selected={on} aria-label={spoken(name, line)}
      onClick={e => { if (!underEdge(e.currentTarget)) onPick(g); }} onDoubleClick={e => { if (!underEdge(e.currentTarget)) onOpen(g); }}
      onMouseEnter={enter} onMouseLeave={leave}>
      <Thumb id={g.id} name={name} progress={progress} grey={grey} />
      <span className="ll-what"><b>{lit(name, mark)}</b><span className="ll-line">{line.node}</span></span>
      {hot && !on && (
        // the row's own action does its thing, not the row's (pick, open)
        <span className="ll-act" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
          <GameAction game={g} variant="row" label={name} />
        </span>
      )}
    </li>
  );
}, (a, b) => a.g === b.g && a.on === b.on && a.mark === b.mark && a.progress === b.progress && a.grey === b.grey && a.line.text === b.line.text
  && a.envW === b.envW && a.onPick === b.onPick && a.onOpen === b.onOpen);

/**
 * The row's cover, 28 × 42: the poster; where the server has none (it answers with its 600 × 900 placeholder) a slice of the key
 * art around its subject, unless that art is dark (a sliver of night says nothing); else the name's first letter on the quiet
 * ground. While the game moves, what has arrived is in colour over grey, with a 2 px bar. (A row is its game's for good, so the
 * cover never starts over.)
 */
function Thumb({ id, name, progress, grey }: { id: number; name: string; progress: number | null; grey: boolean }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  // the key art's brightness decides whether a slice of it can stand in (asked only for a game with no poster)
  const meta = useArtMeta("game", step === 1 ? id : null);
  const mean = meta?.hero?.mean;
  const dark = step === 1 && (meta == null || mean == null || mean < 40);   // INSIDE's night (29) says nothing at 28 px; Dota 2 (52) does
  const src = step === 0 ? art.poster(id, 96) : step === 1 && !dark ? art.hero(id, 320) : null;
  // the server's placeholders are SVGs of a fixed size (600 × 900 for a poster, 1920 × 620 for key art): a copy asked for at 96
  // or 320 px never is
  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const i = e.currentTarget;
    if ((i.naturalWidth === 600 && i.naturalHeight === 900) || (i.naturalWidth === 1920 && i.naturalHeight === 620)) setStep(s => (s === 0 ? 1 : 2));
  };
  const onError = () => setStep(s => (s === 0 ? 1 : 2));
  const moving = progress != null || grey;
  const p = progress == null ? null : Math.max(0, Math.min(1, progress));
  const letter = (name.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  // a slice of the key art is taken where its subject stands (the server's focus, when this page has its answer)
  const slice: CSSProperties | undefined = step === 1 ? { objectPosition: `${Math.round((cachedLayout({ gameId: id })?.art.focus ?? 0.5) * 100)}% 40%` } : undefined;
  return (
    <span className={`ll-th${src ? "" : " mono"}${step === 1 ? " slice" : ""}`} aria-hidden="true">
      {src ? <>
        <img className={moving ? "grey" : undefined} src={src} alt="" loading="lazy" decoding="async" draggable={false} onLoad={onLoad} onError={onError} style={slice} />
        {p != null && p > 0 && <span className="ll-th-fill" style={{ clipPath: `inset(0 ${(100 - p * 100).toFixed(2)}% 0 0)` }}><img src={src} alt="" loading="lazy" draggable={false} style={slice} /></span>}
      </> : <span className="ll-th-l">{letter}</span>}
      {p != null && <span className="ll-th-bar" style={{ ["--p" as string]: `${(p * 100).toFixed(1)}%` } as CSSProperties} />}
    </span>
  );
}

/* ─────────── the room ─────────── */

/** a game warmed: its stage asked for and what the room would draw for it decoded (its key art, else its poster's field); `onReady`
 *  once that is in; key art that would not decode is reported (the room then draws the field), and so is key art that decodes
 *  after all */
function Warm({ id, env, onReady, onBroken, onMended }: { id: number; env: Env; onReady?: () => void; onBroken: (id: number) => void; onMended: (id: number) => void }) {
  const { json, failed } = useSpotlightLayout({ gameId: id }, env);
  const lay = json?.layout ?? null;
  const keyArt = artStands(lay);
  const url = artStands(lay) ? urlBase + lay.art.url : lay || failed ? art.poster(id, FIELD_W) : null;
  const cb = useRef({ onReady, onBroken, onMended });
  cb.current = { onReady, onBroken, onMended };
  useEffect(() => {
    if (!url) return;
    let alive = true;
    void decodeArt(url).then(ok => {
      if (!alive) return;
      if (keyArt) (ok ? cb.current.onMended : cb.current.onBroken)(id);
      cb.current.onReady?.();
    });
    return () => { alive = false; };
  }, [url]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (keyArt && onReady) void decodeArt(art.poster(id, FIELD_W)); }, [keyArt]);   // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

type Field = { key: number; id: number; ready: boolean; now: boolean };
/** a key art in the room: `drawn` once its image is in ("now": decoded before the list opened, there in the first frame), `out`
 *  while it fades out (over the field that stands in for it, or under the next key art coming in) */
type Spot = { gen: number; id: number; name: string; drawn: "no" | "fade" | "now"; out: boolean };
/**
 * The room's art: the game's key art over the whole window (the Spotlight, which cross-fades from game to game itself), or where
 * that cannot stand (`url` null: no key art, art too soft for the window, a stage or an image that has not come or would not) its
 * poster blurred into a field of its colours. Key art stands on the ground (its layer is opaque, its fading foot too), so a change
 * between key art and a field is one cross-fade of the whole room, its floor with it; the one going out stays until the one
 * coming in has drawn, so the room never shows its bare ground nor the last game again. Key art this page had decoded when the
 * list opened is there in its first frame.
 */
function RoomArt({ id, name, url, onBroken, onShown }: { id: number; name: string; url: string | null; onBroken: (id: number) => void; onShown: (id: number) => void }) {
  const stands = url != null;
  const [spots, setSpots] = useState<Spot[]>(() => (url ? [{ gen: 0, id, name, drawn: isDecoded(url) ? "now" : "no", out: false }] : []));
  const last = spots.length ? spots[spots.length - 1] : null;
  const cur = last && !last.out ? last : null;
  // every key art has a gen of its own for the room's life (the one in front is known by it, never by one dropped before)
  const gens = useRef(1);
  // the key art in front has faded in: it covers the room (what is under it can come and go unseen)
  const [settledGen, setSettledGen] = useState<number | null>(cur?.drawn === "now" ? cur.gen : null);
  const covered = !!cur && cur.drawn !== "no" && settledGen === cur.gen;
  // key art that has not drawn in a moment has the game's field under it all the same
  const [late, setLate] = useState(false);
  const fieldKeys = useRef(1);
  const [fields, setFields] = useState<Field[]>(() => (stands ? [] : [{ key: 0, id, ready: false, now: false }]));
  const top = fields.length ? fields[fields.length - 1] : null;
  const fieldIn = !!top && top.id === id && top.ready;

  // the key art follows the game while it stands (the Spotlight cross-fades); after a field, new key art comes in over it
  useEffect(() => {
    if (!stands) return;
    const g = gens.current++;
    setSpots(ss => {
      const l = ss.length ? ss[ss.length - 1] : null;
      if (l && !l.out) return l.id === id && l.name === name ? ss : [...ss.slice(0, -1), { ...l, id, name }];
      return [...ss, { gen: g, id, name, drawn: "no", out: false }];
    });
  }, [stands, id, name]);
  // where it cannot stand, it goes out once the game's field under it has drawn (8 s at most: a poster that never answers)
  useEffect(() => {
    if (stands || !cur) return;
    const g = cur.gen, go = () => setSpots(ss => ss.map(s => (s.gen === g ? { ...s, out: true } : s)));
    if (fieldIn || cur.drawn === "no") { go(); return; }
    const tm = setTimeout(go, 8000);
    return () => clearTimeout(tm);
  }, [stands, cur?.gen, cur?.drawn, fieldIn]);   // eslint-disable-line react-hooks/exhaustive-deps
  // one gone out drops itself once its own fade is over (SpotLayer)
  const gone = useCallback((g: number) => setSpots(ss => ss.filter(s => s.gen !== g)), []);
  // the room shows the game once its key art has drawn, or its field is in (said once per game)
  const toldShown = useRef<number | null>(null);
  useEffect(() => {
    const showing = (stands && !!cur && cur.id === id && cur.drawn !== "no") || (!stands && fieldIn);
    if (showing && toldShown.current !== id) { toldShown.current = id; onShown(id); }
  });
  // the one in front has faded in (.5 s) 520 ms after it drew
  useEffect(() => {
    if (!cur || cur.drawn === "no") return;
    const g = cur.gen;
    if (cur.drawn === "now") { setSettledGen(g); return; }
    const tm = setTimeout(() => setSettledGen(g), 520);
    return () => clearTimeout(tm);
  }, [cur?.gen, cur?.drawn]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLate(false);
    if (!stands || !cur || cur.drawn !== "no") return;
    const tm = setTimeout(() => setLate(true), 800);
    return () => clearTimeout(tm);
  }, [stands, cur?.gen, cur?.drawn]);   // eslint-disable-line react-hooks/exhaustive-deps
  // a field for the game while its key art cannot stand, the newest on top: under key art that covers the room it is there at
  // once, else it fades in over the last; the ones under it go once it has faded in, and all of them once key art covers them
  const needField = !stands || late;
  useEffect(() => {
    if (!needField) return;
    setFields(fs => (fs.length && fs[fs.length - 1].id === id ? fs : [...fs.filter(f => f.ready && f.id !== id).slice(-1), { key: fieldKeys.current++, id, ready: false, now: false }]));
  }, [needField, id]);
  useEffect(() => {
    if (stands && covered) { if (fields.length) setFields([]); return; }
    if (fields.length < 2 || !top?.ready) return;
    const tm = setTimeout(() => setFields(fs => fs.slice(-1)), top.now ? 0 : 520);
    return () => clearTimeout(tm);
  }, [stands, covered, fields, top]);
  // a field's copy is in: reported once per field (FieldLayer); under key art that covers the room, or as the bottom field when its
  // copy was already cached, it is there at once
  const coveredNow = useRef(covered);
  coveredNow.current = covered;
  const fieldsNow = useRef(fields);
  fieldsNow.current = fields;
  const ready = useCallback((key: number, cached: boolean) => {
    const now = coveredNow.current || (cached && fieldsNow.current[0]?.key === key);
    setFields(fs => (fs.some(f => f.key === key && !f.ready) ? fs.map(f => (f.key === key ? { ...f, ready: true, now } : f)) : fs));
  }, []);

  // a key art has drawn once an image of it has loaded (an image that will not load makes the game's room a field)
  const box = useRef<HTMLDivElement>(null);
  const live = useRef({ spots, onBroken });
  live.current = { spots, onBroken };
  const drew = (gen: number) => setSpots(ss => (ss.some(s => s.gen === gen && s.drawn === "no") ? ss.map(s => (s.gen === gen ? { ...s, drawn: "fade" as const } : s)) : ss));
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const isArt = (x: EventTarget | null): x is HTMLImageElement => x instanceof HTMLImageElement && x.classList.contains("spot-a-img");
    const genOf = (x: Element) => Number(x.closest<HTMLElement>("[data-gen]")?.dataset.gen ?? NaN);
    const load = (e: Event) => {
      if (!isArt(e.target)) return;
      drew(genOf(e.target));
      const src = e.target.getAttribute("src");
      if (src) void decodeArt(src);                         // noted as decoded: a list opened again draws it at once
    };
    const fail = (e: Event) => {
      if (!isArt(e.target)) return;
      const g = genOf(e.target), s = live.current.spots.find(x => x.gen === g);
      if (s && !s.out) live.current.onBroken(s.id);
    };
    el.addEventListener("load", load, true);
    el.addEventListener("error", fail, true);
    return () => { el.removeEventListener("load", load, true); el.removeEventListener("error", fail, true); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    for (const s of spots) {
      if (s.drawn !== "no" || s.out) continue;
      const img = box.current?.querySelector<HTMLImageElement>(`[data-gen="${s.gen}"] img.spot-a-img`);
      if (img?.complete && img.naturalWidth > 0) drew(s.gen);
    }
  });

  return (
    <>
      {fields.map(f => <FieldLayer key={f.key} f={f} onReady={ready} />)}
      <div className="ll-spots" ref={box}>
        {spots.map(s => <SpotLayer key={s.gen} s={s} onGone={gone} />)}
      </div>
    </>
  );
}

/** one poster field: it says once that its copy is in (cached at mount, or when it loads or fails) */
function FieldLayer({ f, onReady }: { f: Field; onReady: (key: number, cached: boolean) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const told = useRef(false);
  const tell = (cached: boolean) => { if (told.current) return; told.current = true; onReady(f.key, cached); };
  useLayoutEffect(() => { const el = img.current; if (el && el.complete && el.naturalWidth > 0) tell(true); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`ll-field${f.ready ? " ready" : ""}${f.now ? " now" : ""}`}>
      <img ref={img} src={art.poster(f.id, FIELD_W)} alt="" draggable={false} onLoad={() => tell(false)} onError={() => tell(false)} />
    </div>
  );
}

/** one key-art layer of the room; gone out, it is dropped once its own fade (.3 s) is over */
function SpotLayer({ s, onGone }: { s: Spot; onGone: (gen: number) => void }) {
  useEffect(() => {
    if (!s.out) return;
    const tm = setTimeout(() => onGone(s.gen), 340);
    return () => clearTimeout(tm);
  }, [s.out, s.gen, onGone]);
  return (
    <div data-gen={s.gen} className={`ll-spot${s.drawn !== "no" && !s.out ? " in" : ""}${s.drawn === "now" ? " now" : ""}${s.out ? " out" : ""}`}>
      <Spotlight source={{ gameId: s.id }} name={s.name} height="100vh" bare scrimFor={0} />
    </div>
  );
}

/**
 * The picked game in its room, standing on the room's floor: its identity in an 88 px slot (the logo the server chose, or the
 * name), the facts line, the action and Details, then the strip of its facts. Every part keeps its place from one game to the
 * next. A click brings the words into focus; a step of a walk with the keys (or typing) changes them at once (`still`).
 */
function Room({ g, c, play, env, still, onLeave }: { g: Game; c: LineCtx; play: Map<number, Played> | null; env: Env; still: boolean; onLeave: (h: How) => void }) {
  const j = journeyOf(g, c.inst(g), c.prog(g));
  const name = cleanName(g.name);
  const box = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(560);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const m = () => setWidth(w => (Math.abs(w - el.clientWidth) < 1 ? w : el.clientWidth));
    m();
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const detail = useDetail(g.id);
  const facts = factsLine(g, j, c.meId ?? undefined, play?.get(g.id)?.s ?? null);
  return (
    <section className={`ll-room${still ? " still" : ""}`} ref={box} aria-label={name}>
      <div className="ll-who" key={g.id}>
        <Identity g={g} name={name} env={env} max={Math.min(560, width)} walking={still} />
        <p className="ll-facts">{facts}</p>
        <Acts g={g} name={name} onLeave={onLeave} />
      </div>
      <Strip key={`s${g.id}`} g={g} c={c} play={play} lately={detail && detail.id === g.id ? detail.activity : null} />
    </section>
  );
}

/** the one thing to do and Details, its own per game (inside the block that changes with the game, so a press still working on one
 *  game never shows on the next); it cross-fades when the thing to do changes (Request → Cancel → Install → Play), and the focus,
 *  when it was there, stays in its place */
function Acts({ g, name, onLeave }: { g: Game; name: string; onLeave: (h: How) => void }) {
  const ga = useGameAction({ game: g });
  const m = ga.plan.main;
  const k = m ? `${m.kind}:${m.label}` : "none";
  const box = useSwapFocus<HTMLDivElement>(k);
  return (
    <div className="ll-acts act-swap" key={k} ref={box}>
      <GameActionView ga={ga} variant="button" size={44} label={name} />
      <ButtonLink to={`/game/${g.id}`} size={44} onClick={e => onLeave(e.detail === 0 ? "key" : "pointer")}>Details</ButtonLink>
    </div>
  );
}

/** the identity: the logo the server's stage uses (recoloured as it says), fitted to the slot; else the name at the room's sizes.
 *  While the stage has not answered the slot stays empty a moment (the logo would replace the name: a jump), except on a walk,
 *  whose steps read only what this page has (they ask the server nothing; the pick asks once it rests) */
function Identity({ g, name, env, max, walking }: { g: Game; name: string; env: Env; max: number; walking: boolean }) {
  const [asking, setAsking] = useState(!walking);
  useEffect(() => { if (asking) return; const tm = setTimeout(() => setAsking(true), ROOM_SETTLE_MS); return () => clearTimeout(tm); }, [asking]);
  const { json } = useSpotlightLayout(asking ? { gameId: g.id } : null, env);
  const lay = json?.layout ?? cachedLayout({ gameId: g.id });
  const [waited, setWaited] = useState(false);
  useEffect(() => { if (lay) return; const tm = setTimeout(() => setWaited(true), 600); return () => clearTimeout(tm); }, [!!lay]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [bad, setBad] = useState(false);
  const id = lay?.identity;
  const logo = id && id.kind === "logo" && !bad ? id : null;
  const want = logo ? "logo" : !lay && !waited && !walking ? "none" : "name";
  // the slot's first form is there at once; a later one (the logo the stage brought once a walk rested, the name after a wait)
  // comes into focus in its place — a later logo once its image has decoded, the slot keeping what it shows until then
  const first = useRef(want), was = useRef(want);
  const later = logo && first.current !== "logo" ? urlBase + logo.url : null;
  const [inUrl, setInUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!later) return;
    let live = true;
    const im = new Image();
    im.src = later;
    im.decode().then(() => { if (live) setInUrl(later); }, () => { if (live) setBad(true); });
    return () => { live = false; };
  }, [later]);
  const shows = later && inUrl !== later ? was.current : want;
  was.current = shows;
  return (
    <div className={`ll-id${shows !== first.current ? " swap-in" : ""}`} key={shows}>
      {shows === "logo" && logo ? <Logo id={logo} name={name} max={max} onBad={() => setBad(true)} /> : shows === "name" ? <Title name={name} max={max} /> : null}
    </div>
  );
}

type LogoId = Extract<SpotLayout["identity"], { kind: "logo" }>;
/** the logo's ink (its opaque box) at 16,000 px², within 400 × 64 and the room; its optical hang kept */
const LOGO_AREA = 16000, LOGO_W = 400, LOGO_H = 64;
function Logo({ id, name, max, onBad }: { id: LogoId; name: string; max: number; onBad: () => void }) {
  const cr = id.crop, ratio = cr.w / cr.h;
  let w = Math.sqrt(LOGO_AREA * ratio), h = w / ratio;
  const k = Math.min(1, Math.min(LOGO_W, max) / w, LOGO_H / h);
  w *= k; h *= k;
  const s = w / cr.w;
  const hang = (id.hang || 0) * (id.scale ? s / id.scale : 1);
  return (
    <h2 className="ll-logo" style={{ width: w, height: h, marginLeft: -hang }}>
      <img src={urlBase + id.url} alt={name} draggable={false} onError={onBad}
        style={{ left: -cr.x * s, top: -cr.y * s, width: id.file.w * s, height: id.file.h * s, filter: id.filter ?? undefined }} />
    </h2>
  );
}

/** the name at the room's sizes, by its width at 40 px (a hidden copy, measured once the fonts are in): 40 on one line, 40 on two,
 *  32 on two */
function Title({ name, max }: { name: string; max: number }) {
  const probe = useRef<HTMLSpanElement>(null);
  const [w40, setW40] = useState<number | null>(null);
  useLayoutEffect(() => {
    let alive = true;
    const m = () => { if (alive && probe.current) setW40(probe.current.getBoundingClientRect().width); };
    m();
    void document.fonts?.ready.then(m);
    return () => { alive = false; };
  }, [name]);
  const tier = w40 == null || w40 <= max ? "t40" : w40 <= max * 1.8 ? "t40 two" : "t32 two";
  return (
    <>
      <span className="ll-probe" ref={probe} aria-hidden="true">{name}</span>
      <h2 className={`ll-title ${tier}`} style={{ visibility: w40 == null ? "hidden" : undefined }}>{name}</h2>
    </>
  );
}

/* ─────────── the strip: the game's facts on one line ─────────── */

/** "Sasha played it for 2.3 h", "You asked for it" (the game page's Lately verbs) */
function latelyWords(a: ActivityItem, meId: number | null): ReactNode {
  const you = a.user.id === meId;
  const verb = you && a.kind === "tracked" ? "are tracking" : FEED_VERB[a.kind];
  const secs = a.kind === "played" && typeof a.data?.playSeconds === "number" ? a.data.playSeconds : 0;
  const tail = a.kind === "installed" && a.data?.device ? ` on ${String(a.data.device)}` : secs ? ` for ${fmtPlay(secs)}` : "";
  return <><b>{you ? "You" : a.user.displayName}</b> {verb} it{tail}</>;
}

/** a fact the strip's width cuts says all of itself under the pointer (one that fits says nothing more) */
const sayAll = (e: { currentTarget: HTMLElement }) => {
  const el = e.currentTarget;
  if (el.scrollWidth > el.clientWidth + 0.5) el.title = el.textContent ?? "";
  else el.removeAttribute("title");
};

/**
 * The facts the game page's table has for where the game is (screens/game-parts libraryFacts), side by side on one line, label
 * over value; while it moves, its journey comes first; the newest line of Lately comes last, as wide as the room lets it. What
 * does not fit the room's width is left out (the line never wraps), so the strip keeps its height.
 */
function Strip({ g, c, play, lately }: { g: Game; c: LineCtx; play: Map<number, Played> | null; lately: ActivityItem[] | null }) {
  const inst = c.inst(g), prog = c.prog(g);
  const j = journeyOf(g, inst, prog);
  // the page's facts but the folder (a path does not fit a strip: it is on the game's page)
  const rows = libraryFacts({ g, j, inst, prog, meId: c.meId ?? undefined, lastPlayed: play?.get(g.id)?.at ?? null }).filter(r => r.key !== "folder");
  // the newest line about the game that the facts do not already say (an ask beside "Asked for by", a track beside "Tracked by",
  // an install beside "Installed by" naming that person, my own play beside "Last played")
  const said = new Set(rows.map(r => r.key));
  const owners = new Set(g.people.owners.map(u => u.id));
  const last = lately?.find(a => a.kind !== "joined" && a.kind !== "friends" && !(a.kind === "requested" && said.has("asked")) && !(a.kind === "tracked" && said.has("tracked"))
    && !(a.kind === "installed" && said.has("installed") && owners.has(a.user.id))
    && !(a.kind === "played" && a.user.id === c.meId && said.has("played"))) ?? null;
  return (
    <dl className="ll-strip" aria-label={`${g.name}: facts`}>
      {j.active && <div className="ll-fact ll-jl"><dt className="sr-only">On its way</dt><dd><JourneyLine j={j} size="lg" /></dd></div>}
      {rows.map(r => (
        <div key={r.key} className={`ll-fact k-${r.key}`}>
          <dt>{r.label}</dt>
          <dd className={r.quiet ? "quiet" : undefined} title={r.title}>
            {typeof r.value === "string" ? <span className="ll-fact-t" onPointerEnter={sayAll}>{r.value}</span> : r.value}
          </dd>
        </div>
      ))}
      {last && (
        <div className="ll-fact ll-lately">
          <dt>Lately</dt>
          <dd><Avatar u={last.user} size={20} /><span className="ll-lately-t">{latelyWords(last, c.meId)}<span className="ll-ago"> · {timeAgo(last.at)}</span></span></dd>
        </div>
      )}
    </dl>
  );
}

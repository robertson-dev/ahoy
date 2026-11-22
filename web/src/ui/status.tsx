/**
 * Status lines: the one line under a card or a row, in the product's words, for every screen (Library, Search, Discover
 * and its lists, the game page's More like this, Friends and profiles). One rule per kind of thing, the same everywhere:
 *   libraryLine   a library game (M/lfs/library-wall gen.mjs lineFor): a friend playing it wins over the rest; on this PC
 *                 its play time ("41 h played"), ready "Arrived 22 h ago · 20 GB" (bright for three days), not out yet who
 *                 tracks it ("✓ Tracked", "Pell tracks it"); moving "Asked for by Mika · Looking", "Installing 48%"
 *   storeLine     a store item (M/disc/picked gen.mjs statusLine), told by the library game when the server has it: who
 *                 tracks it, what moves, "On this PC", "On the server"; else its date, "Not yet" when protected, the
 *                 store's review words ("97% positive" under the small cards), else its genre and year
 *   stateLine     where a game stands for you, short ("On this PC", "Ready · 1.8 GB", "Installing 48%"): a friend's game
 *                 on Friends and profiles (M/lfs/friends-roster)
 *   artProgress   the arrival on the art while it moves (PosterCard's progress / grey)
 * and the cards that carry them: LibraryCard, StoreCard (shelf cards, GameAction on hover) and StoreRow (a chart row).
 * Every line is a node (with its bright parts in <b>) plus its words, for what a screen reader hears.
 */
import { useMemo, type ReactNode } from "react";
import { fmtPlay, fmtSize, timeAgo, type DiscoverItem, type Game, type UserRef } from "../api";
import { useLib, useProfile, type Lib } from "../data";
import type { InstallProgress, InstalledGame } from "../launcher";
import { useLauncher } from "../launcher-state";
import { isActive, journeyOf, notOutYet, type Journey } from "../model";
import { useSession } from "../session";
import { art } from "./art";
import { releaseWords } from "./calendar";
import { ChartRow } from "./chart";
import { GameAction } from "./game-action";
import { POSTER, PosterCard, StatusLine, type PosterSize } from "./poster";
import { cleanName } from "./words";

/* ─────────── what a line knows: me, this PC, my play time ─────────── */

/** my play time and last session on a game (my profile: every PC) */
export interface Played { s: number; at: number | null }
export interface LineCtx {
  meId: number | null;
  /** this PC's copy and the install in flight (launcher only) */
  inst: (g: Game) => InstalledGame | undefined;
  prog: (g: Game) => InstallProgress | undefined;
  /** my play time per game; null while it is not known yet (a game on this PC then says nothing rather than "Installed") */
  play: Map<number, Played> | null;
  /** seconds */
  now: number;
}

const NONE = new Map<number, Played>();

/** my play time per game from my profile (null until it answers; an answer that failed counts as none) */
export function usePlayed(on = true): Map<number, Played> | null {
  const { me } = useSession();
  const { item, error } = useProfile(on ? me?.name : undefined);
  return useMemo(() => {
    if (!on) return NONE;
    if (!item && !error) return null;
    const m = new Map<number, Played>();
    for (const x of item?.games ?? []) if (x.gameId != null) m.set(x.gameId, { s: x.playSeconds, at: x.lastPlayedAt });
    return m;
  }, [on, item, error]);
}

/**
 * Me and this PC, for the lines. `play`: "mine" reads my profile for the play time (a screen that shows it on cards of games
 * on this PC); a map hands one over (the Library reads it already); left out, lines never show play time.
 */
export function useLineCtx({ play }: { play?: "mine" | Map<number, Played> | null } = {}): LineCtx {
  const { me } = useSession();
  const L = useLauncher();
  const mine = usePlayed(play === "mine");
  return {
    meId: me?.id ?? null,
    inst: g => (g.file ? L.installedFor(g.id, g.file.id) : undefined),
    prog: g => (g.file ? L.installs[g.file.id] : undefined),
    play: play === "mine" ? mine : play === undefined ? NONE : play,
    now: Date.now() / 1000,
  };
}

/* ─────────── the words ─────────── */

/** what a line draws, and what a screen reader hears */
export interface Line { node: ReactNode; text: string }
const plain = (s: string): Line => ({ node: s, text: s });
const pct = (p: number | null | undefined) => `${Math.round((p ?? 0) * 100)}%`;
/** "Hollow Knight — 41 h played" */
export const spoken = (name: string, l: Line) => (l.text ? `${name} — ${l.text}` : name);
/** the product's "lately": the last three days */
export const LATELY_S = 3 * 86_400;

/** the library game a store item is (by its game id, then its Steam app) */
export const gameOf = (lib: Lib, i: Pick<DiscoverItem, "appId" | "gameId">): Game | undefined =>
  (i.gameId != null ? lib.byId.get(i.gameId) : undefined) ?? lib.byApp.get(i.appId);
/** where a store item's card goes: the game page when the server has it, else the store page */
export const hrefOf = (i: Pick<DiscoverItem, "appId">, g: Game | undefined) => (g ? `/game/${g.id}` : `/steam/${i.appId}`);

/**
 * Who is waiting for a game that is not out yet: me (any ask of mine: "✓ Tracked"), else the first person who tracks it, then who
 * watches it or asked for it ("Pell tracks it"). Asks count only while the server keeps an eye on the game: once nobody tracks it,
 * old asks stay in the data but say nothing. A game that is out (on the server, on its way) has nobody waiting.
 */
export function tracker(g: Game | undefined, meId: number | null): { me: boolean; name: string; user: UserRef | null; verb: string } | null {
  if (!g || !notOutYet(g) || !g.monitored) return null;
  const asks = g.people.requestedBy;
  if (meId != null && asks.some(r => r.user.id === meId)) return { me: true, name: "", user: null, verb: "" };
  const r = asks.find(x => x.kind === "track") ?? asks.find(x => x.kind === "watch") ?? asks[0];
  return r ? { me: false, name: r.user.displayName, user: r.user, verb: r.kind === "get" ? "asked for it" : r.kind === "track" ? "tracks it" : "watches it" } : null;
}

/** a game the server is fetching: "Asked for by Mika · Looking", else "Downloading 48%" (the art carries the progress) */
function askedLine(g: Game, meId: number | null, j: Journey): Line {
  const ask = g.people.requestedBy.find(r => r.kind === "get");
  if (!ask) return plain(j.progress != null && j.progress > 0 ? `${j.label} ${pct(j.progress)}` : `${j.label}…`);
  const mine = ask.user.id === meId;
  return {
    node: <StatusLine>Asked for by {mine ? "you" : <b>{ask.user.displayName}</b>} · {j.label}</StatusLine>,
    text: `Asked for by ${mine ? "you" : ask.user.displayName} · ${j.label}`,
  };
}

/** everyone but me who plays it now: "Jonas is playing", "Jonas and Pell are playing", "Jonas and 2 more are playing" */
function playingLine(us: UserRef[]): Line {
  const [a, b] = us;
  if (us.length === 1) return { node: <StatusLine avatar={a}><b>{a.displayName}</b> is playing</StatusLine>, text: `${a.displayName} is playing` };
  if (us.length === 2) return { node: <StatusLine avatar={a}><b>{a.displayName}</b> and <b>{b.displayName}</b> are playing</StatusLine>, text: `${a.displayName} and ${b.displayName} are playing` };
  return { node: <StatusLine avatar={a}><b>{a.displayName}</b> and {us.length - 1} more are playing</StatusLine>, text: `${a.displayName} and ${us.length - 1} more are playing` };
}

/** who is waiting for a game that is not out yet: you ("✓ Tracked"), someone else with their face ("Pell tracks it"), or nobody */
function waitingLine(g: Game, meId: number | null): Line {
  const t = tracker(g, meId);
  if (t?.me) return { node: <StatusLine check bright>Tracked</StatusLine>, text: "Tracked" };
  if (t) return { node: <StatusLine avatar={t.user}><b>{t.name}</b> {t.verb}</StatusLine>, text: `${t.name} ${t.verb}` };
  return plain("Not out yet");
}

/** "Arrived 22 h ago · 20 GB", the arrival bright for the last three days */
function arrivedLine(g: Game, now: number): Line {
  const at = g.file?.addedAt ?? g.addedAt;
  const when = `Arrived ${timeAgo(at)}`, size = fmtSize(g.file?.size);
  return now - at < LATELY_S ? { node: <StatusLine><b>{when}</b> · {size}</StatusLine>, text: `${when} · ${size}` } : plain(`${when} · ${size}`);
}

/** the Library's shelves: a card on one says the shelf's fact (On this PC, Ready to install, Coming, Not on your server) */
export type Shelf = "here" | "ready" | "soon" | "none";
const SHELF_OF: Partial<Record<Journey["stage"], Shelf>> = { installed: "here", ready: "ready", waiting: "soon", none: "none" };

/**
 * A library game's line (M/lfs/library-wall gen.mjs lineFor). A friend playing it now wins over the game's own fact.
 * `shelf` is the Library shelf the card stands on (it says the shelf's fact, and a game that is on no shelf says "Not
 * tracked" under the "Not on your server" heading); elsewhere the game's journey decides.
 */
export function libraryLine(g: Game, c: LineCtx, { shelf }: { shelf?: Shelf } = {}): Line {
  const j = journeyOf(g, c.inst(g), c.prog(g));
  const kind = shelf ?? SHELF_OF[j.stage];
  const others = g.people.playing.filter(u => u.id !== c.meId);
  if (others.length && kind !== "soon") return playingLine(others);
  switch (kind) {
    case "here": {
      if (!c.play) return plain("");   // my play time is on its way: say nothing (the card keeps the line's place) rather than "Installed"
      const s = c.play.get(g.id)?.s ?? 0;
      return plain(s > 0 ? `${fmtPlay(s)} played` : "Installed");
    }
    case "ready": return arrivedLine(g, c.now);
    case "soon": return waitingLine(g, c.meId);
    case "none": return plain(shelf ? (g.monitored ? "Not found yet" : "Not tracked") : j.label);
  }
  // on its way (Search; the Library draws these as tickets) or didn't make it
  if (j.stage === "installing") return plain(`${j.label} ${pct(j.progress)}`);
  if (j.stage === "finding" || j.stage === "downloading" || j.stage === "preparing") return askedLine(g, c.meId, j);
  return plain(j.label);
}

/**
 * A store item's line (M/disc/picked gen.mjs statusLine), told by the library game when the server has it: tracked by me
 * ("✓ Tracked") or someone ("Pell tracks it"), installing here, on this PC, asked for and on its way, "On the server",
 * didn't make it. Else, from the store: an upcoming game's date ("Nov 9 · in 3 days"; nothing in a calendar, where the
 * date is its column), "Not yet" when it is protected, the review words ("Very Positive", or "97% positive" under the
 * small cards), else the genre and, on lists that are not one year's, the year (not in a calendar).
 */
export function storeLine(i: DiscoverItem, g: Game | undefined, c: LineCtx, { small = false, calendar = false, year = true }: { small?: boolean; calendar?: boolean; year?: boolean } = {}): Line {
  if (g) {
    const t = tracker(g, c.meId);
    if (t?.me) return { node: <StatusLine check bright>Tracked</StatusLine>, text: "Tracked" };
    if (t) return { node: <StatusLine><b>{t.name}</b> {t.verb}</StatusLine>, text: `${t.name} ${t.verb}` };
    const prog = c.prog(g);
    if (prog) { const j = journeyOf(g, c.inst(g), prog); return plain(`${j.label} ${pct(j.progress)}`); }
    if (c.inst(g)) return plain("On this PC");
    if (isActive(g)) return askedLine(g, c.meId, journeyOf(g));
    if (g.status === "available") return { node: <StatusLine dot>On the server</StatusLine>, text: "On the server" };
    if (g.status === "failed") return plain(journeyOf(g).label);
  }
  if (i.comingSoon) {
    if (calendar) return plain("");
    const w = releaseWords({ iso: i.releaseIso, text: i.releaseText });
    return plain(w.rel ? `${w.date} · ${w.rel.toLowerCase()}` : w.date);
  }
  if (i.crackStatus === "uncracked" || i.crackStatus === "hypervisor") return plain("Not yet");
  if (small && i.reviewPct != null) return plain(`${i.reviewPct}% positive`);
  if (i.reviewSummary) return plain(i.reviewSummary);
  if (i.reviewPct != null) return plain(`${i.reviewPct}% positive`);
  // no review words from the store (Metacritic's lists): the genre, and the year where the list is not a year's; a calendar's
  // column already says when, so a cell there says nothing
  if (calendar) return plain("");
  return plain([i.genres[0], year ? i.releaseIso?.slice(0, 4) : null].filter(Boolean).join(" · "));
}

/** where a library game stands for you on this PC, short (the profile board's words; Friends' tiles and profile cards) */
export function stateLine(g: Game | undefined, inst?: InstalledGame, prog?: InstallProgress, meId?: number | null): string {
  if (!g) return "";
  if (prog) { const j = journeyOf(g, inst, prog); return `${j.label} ${pct(j.progress)}`; }
  if (inst) return "On this PC";
  if (g.status === "available" && g.file) return `Ready · ${fmtSize(g.file.size)}`;
  const j = journeyOf(g);
  if (j.active) return j.progress != null ? `${j.label} ${pct(j.progress)}` : j.label;
  const t = tracker(g, meId ?? null);
  if (t?.me) return "Tracked";
  if (t) return `${t.name} ${t.verb}`;
  return notOutYet(g) ? "Not out yet" : j.label;
}

/** the arrival on the art while the game moves: what has arrived in colour (an install here, or the server's download), all grey while it is looked for */
export function artProgress(g: Game | undefined, c: LineCtx): { progress: number | null; grey: boolean } {
  if (!g) return { progress: null, grey: false };
  const prog = c.prog(g);
  if (prog) return { progress: prog.progress, grey: false };
  if (!isActive(g)) return { progress: null, grey: false };
  const p = g.request?.progress ?? 0;
  return p > 0 ? { progress: p, grey: false } : { progress: null, grey: true };
}

/* ─────────── the cards and rows that carry them ─────────── */

/** a library game as a shelf card: its poster, its line, its progress while it moves, its action on hover */
export function LibraryCard({ g, c, size = 204, shelf }: { g: Game; c: LineCtx; size?: PosterSize; shelf?: Shelf }) {
  const line = libraryLine(g, c, { shelf });
  const { progress, grey } = artProgress(g, c);
  return <PosterCard size={size} to={`/game/${g.id}`} art={art.poster(g.id, POSTER[size].w * 2)} title={g.name} line={line.node} label={spoken(g.name, line)}
    progress={progress} grey={grey} action={<GameAction game={g} variant="pill" label={g.name} />} />;
}

/** a Steam capsule at 600 × 900 ("library_capsule_2x.jpg", or the older "library_600x900_2x.jpg"); Steam keeps its 300 × 450 copy
 *  in the same folder under the same name without "_2x" */
const STEAM_2X = /^(https:\/\/[a-z0-9.-]+\.steamstatic\.com\/.+\/library_(?:capsule|600x900))_2x(\.jpg)(\?.*)?$/;
/** a store item's capsule for a slot `w` px wide: the 300 × 450 copy for the small slots (a 40 × 60 thumb, the calendar's 104, the
 *  genre rows' 128: up to 2.9 device px per px), the 600 × 900 one for the big cards */
export function capsuleFor(i: Pick<DiscoverItem, "portrait">, w: number): string | null {
  if (!i.portrait || w > 150) return i.portrait;
  const m = STEAM_2X.exec(i.portrait);
  return m ? m[1] + m[2] + (m[3] ?? "") : i.portrait;
}
/** a store item's art for a slot `w` px wide: its capsule, else the header centred on a blurred copy of itself, else the server's
 *  poster (at twice the slot's width) */
export const storeArt = (i: DiscoverItem, w = 204) => ({ art: capsuleFor(i, w) ?? (i.img ? null : art.steam(i.appId, i.name, w * 2)), wide: i.img });

/** a store item as a shelf card (204, the genre rows' 128, or a calendar's bare 104 capsule: `calendar`) */
export function StoreCard({ i, c, size = 204, calendar = false }: { i: DiscoverItem; c: LineCtx; size?: PosterSize; calendar?: boolean }) {
  const lib = useLib();
  const g = gameOf(lib, i);
  const name = cleanName(i.name);
  const line = storeLine(i, g, c, { small: POSTER[size].small, calendar });
  const { progress, grey } = artProgress(g, c);
  return <PosterCard size={size} bare={calendar} to={hrefOf(i, g)} {...storeArt(i, POSTER[size].w)} title={name} line={line.node} label={spoken(name, line)}
    progress={progress} grey={grey} action={<GameAction app={i} variant="pill" label={name} />} />;
}

/** a store item as a chart row: the rank or the score, the capsule, the name over its line, the action at the end */
export function StoreRow({ i, c, lead, score, leadWords, year = true }: { i: DiscoverItem; c: LineCtx; lead: ReactNode; score?: boolean; leadWords: string; year?: boolean }) {
  const lib = useLib();
  const g = gameOf(lib, i);
  const name = cleanName(i.name);
  const line = storeLine(i, g, c, { year });
  return <ChartRow lead={lead} score={score} {...storeArt(i, 40)} title={name} to={hrefOf(i, g)} line={line.node}
    label={`${leadWords} — ${spoken(name, line)}`} action={<GameAction app={i} variant="row" label={name} />} />;
}

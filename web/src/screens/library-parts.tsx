/**
 * The Library's own pieces (board: M/lfs/library-wall/Library-Wall.dc.html, rules in its gen.mjs).
 *   useShelves   every library game on exactly one shelf, sorted: On this PC, On the way (server requests, launcher installs,
 *                failed last), Ready to install, Coming, and the games that are none of those (not on your server)
 *   Wall         a shelf's cards (ui/status LibraryCard: the shelf's line, the state's action on hover)
 *   Ticket       a moving game: its art filling in as it arrives, the state line, the five stops, who asked, Cancel / Try again
 * Shared pieces come from ui/; nothing here is per game or per person.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { timeAgo, type Game } from "../api";
import { useLib } from "../data";
import type { InstallProgress } from "../launcher";
import { useLauncher } from "../launcher-state";
import { isActive, journeyOf, type Journey } from "../model";
import { art } from "../ui/art";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { GameActionView, useGameAction } from "../ui/game-action";
import { JourneyLine } from "../ui/journey";
import { PosterArt } from "../ui/poster";
import { LATELY_S, LibraryCard, usePlayed, type Line, type LineCtx, type Played, type Shelf as CardShelf } from "../ui/status";

/* ─────────── shelves and sorts ─────────── */

export type Shelf = "all" | "here" | "ready" | "way" | "soon";
export type Sort = "added" | "name" | "played";
export const SHELF_TITLE: Record<Exclude<Shelf, "all">, string> = { here: "On this PC", ready: "Ready to install", way: "On the way", soon: "Coming" };
export const SORT_LABEL: Record<Sort, string> = { added: "Recently added", name: "Name", played: "Last played" };

/** the product's "Arrived lately": the last three days */
export const LATELY = LATELY_S;

/** a moving game: a server request, a launcher install, or one that didn't make it */
export interface Moving {
  key: string;
  game: Game | undefined;
  name: string;
  gameId: number | null;
  j: Journey;
  /** the launcher install in flight, when it is one */
  prog: InstallProgress | undefined;
  /** an install of a package that is not the game's current file: its Cancel goes to the launcher directly */
  loose: boolean;
}

export interface Shelves {
  here: Game[]; ready: Game[]; way: Moving[]; soon: Game[];
  /** in the library, not on the server and not moving (looked for and not found, or no longer tracked) */
  none: Game[];
  counts: Record<Shelf, number>;
  /** my play time per game; null until my profile has answered */
  play: Map<number, Played> | null;
}

const addedAt = (g: Game) => g.file?.addedAt ?? g.addedAt ?? 0;
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
/** the chosen sort: Recently added (when it arrived on the server, else joined the library), Name, Last played (never played: as Recently added) */
export function sorter(sort: Sort, play: Map<number, Played> | null) {
  const added = (a: Game, b: Game) => addedAt(b) - addedAt(a) || byName(a, b);
  if (sort === "name") return (a: Game, b: Game) => byName(a, b) || added(a, b);
  if (sort === "played") return (a: Game, b: Game) => (play?.get(b.id)?.at ?? 0) - (play?.get(a.id)?.at ?? 0) || added(a, b);
  return added;
}
/** On the way runs in the order things will arrive: the furthest along first (stops done plus the progress); failed last */
const along = (m: Moving) => (m.j.stage === "failed" ? -1 : m.j.done + (m.j.progress ?? 0));

export function useShelves(sort: Sort): Shelves & { loaded: boolean; error: string | null; reload: () => Promise<void>; total: number } {
  const lib = useLib();
  const L = useLauncher();
  const play = usePlayed();
  const model = useMemo(() => {
    const here: Game[] = [], ready: Game[] = [], soon: Game[] = [], none: Game[] = [], way: Moving[] = [];
    for (const g of lib.games) {
      const inst = g.file ? L.installedFor(g.id, g.file.id) : undefined;
      const prog = g.file ? L.installs[g.file.id] : undefined;
      if (prog) way.push({ key: `i${g.file!.id}`, game: g, name: g.name, gameId: g.id, j: journeyOf(g, inst, prog), prog, loose: false });
      else if (inst) here.push(g);
      else if (isActive(g) || g.status === "failed") way.push({ key: `g${g.id}`, game: g, name: g.name, gameId: g.id, j: journeyOf(g), prog: undefined, loose: false });
      else if (g.status === "available" && g.file) ready.push(g);
      else if (g.status === "unreleased") soon.push(g);
      else none.push(g);
    }
    // a launcher install whose package is not a library game's current file (an older copy, a game since removed)
    const files = new Set(lib.games.map(g => g.file?.id).filter((x): x is number => x != null));
    for (const p of Object.values(L.installs)) {
      if (files.has(p.packageId)) continue;
      const g = p.gameId != null ? lib.byId.get(p.gameId) : undefined;
      way.push({ key: `i${p.packageId}`, game: g, name: p.name || g?.name || "", gameId: p.gameId ?? g?.id ?? null, j: journeyOf(g ?? null, undefined, p), prog: p, loose: true });
    }
    const cmp = sorter(sort, play);
    for (const list of [here, ready, soon, none]) list.sort(cmp);
    way.sort((a, b) => along(b) - along(a) || (a.game && b.game ? cmp(a.game, b.game) : byName(a, b)));
    return { here, ready, way, soon, none };
  }, [lib.games, lib.byId, L.installedFor, L.installs, sort, play]);
  const counts: Record<Shelf, number> = { all: lib.games.length, here: model.here.length, ready: model.ready.length, way: model.way.length, soon: model.soon.length };
  // the shelves wait for this PC's list too (the launcher's first answer; always there in a plain browser): before it,
  // every game on this PC would stand on Ready to install for a moment and jump
  return { ...model, counts, play, loaded: lib.loaded && L.loaded, error: lib.error, reload: lib.reload, total: lib.games.length };
}

/* ─────────── a shelf's cards ─────────── */

/** a wall of cards (On this PC, Ready to install, Arrived lately, the rest), each saying its shelf's fact */
export function Wall({ games, shelf, c }: { games: Game[]; shelf: CardShelf; c: LineCtx }) {
  return <ol className="lib-wall">{games.map(g => <li key={g.id}><LibraryCard g={g} c={c} shelf={shelf} /></li>)}</ol>;
}

/* ─────────── a ticket (On the way) ─────────── */

const pctOf = (p: number | null | undefined) => (p != null && p > 0 ? `${Math.round(p * 100)}%` : null);

/**
 * The state line, in the product's words: "<label> · <detail>" as model.ts writes every surface ("Downloading 48% · 6.2 MB/s
 * · about 13 min left", "Looking", "Preparing", "Didn't make it · Nothing usable turned up"); the percent is bright while
 * bytes move. An install keeps the board's form, "Installing 48% · about 3 min left". `short` is what a ticket too narrow for
 * the whole line says: the label, the percent and the time left ("Downloading 48% · about 13 min left").
 */
export function stateOf(m: Moving, short = false): Line {
  const j = m.j;
  const pct = j.stage === "downloading" || j.stage === "installing" ? pctOf(j.progress) : null;
  const rest = j.stage === "installing" || short ? (j.eta ? [j.eta] : []) : j.detail ? [j.detail] : [];
  return {
    node: <>{j.label}{pct && <> <b>{pct}</b></>}{rest.map(r => <span key={r}> · {r}</span>)}</>,
    text: [pct ? `${j.label} ${pct}` : j.label, ...rest].join(" · "),
  };
}

/**
 * The ticket's state line. A ticket narrower than the board's (two to a row in a smaller window) says the short form when the
 * whole line would not fit, rather than cutting the time left off the end: the rate goes first. The whole line is measured
 * in a hidden copy, again whenever the ticket or the type changes size.
 */
function StateText({ m }: { m: Moving }) {
  const full = stateOf(m), short = stateOf(m, true);
  const box = useRef<HTMLParagraphElement>(null);
  const whole = useRef<HTMLSpanElement>(null);
  const [tight, setTight] = useState(false);
  useLayoutEffect(() => {
    const p = box.current, w = whole.current;
    if (!p || !w || full.text === short.text) { setTight(false); return; }
    const fit = () => setTight(w.offsetWidth > p.clientWidth + 0.5);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(p); ro.observe(w);
    return () => ro.disconnect();
  }, [full.text, short.text]);
  return <p ref={box} className="tk-state">{(tight ? short : full).node}<span ref={whole} className="tk-whole" aria-hidden="true">{full.node}</span></p>;
}

/** who asked for it: the first ask, else the first track or watch, with the product's verb */
function askOf(g: Game | undefined) {
  const asks = g?.people.requestedBy ?? [];
  const r = asks.find(x => x.kind === "get") ?? asks[0];
  return r ? { r, verb: r.kind === "get" ? "Asked for by" : r.kind === "track" ? "Tracked by" : "Watched by" } : null;
}
/** "Asked for by you · 3 h ago", "Asked for by [M] Mika · 2 h ago" */
function Asked({ g, meId }: { g: Game | undefined; meId: number | null }) {
  const a = askOf(g);
  if (!a) return <span className="tk-asked" />;
  const { r, verb } = a;
  if (r.user.id === meId) return <span className="tk-asked"><span>{verb} you · {timeAgo(r.at)}</span></span>;
  const to = `/u/${r.user.name}`;
  return (
    <span className="tk-asked">
      <span>{verb}</span>
      <Link to={to} className="tk-face" tabIndex={-1} aria-hidden="true"><Avatar u={r.user} size={20} /></Link>
      <span className="tk-by"><Link to={to} className="tk-who">{r.user.displayName}</Link> · {timeAgo(r.at)}</span>
    </span>
  );
}
const askedText = (g: Game | undefined, meId: number | null) => {
  const a = askOf(g);
  return a ? `, ${a.verb.toLowerCase()} ${a.r.user.id === meId ? "you" : a.r.user.displayName}` : "";
};

/** the ticket's one action, drawn as the board's 36 px secondary button: Cancel, or Try again when it didn't make it */
function TicketAction({ m }: { m: Moving }) {
  const L = useLauncher();
  const ga = useGameAction({ game: m.loose ? null : m.game });
  if (m.loose) return <Button size={36} icon="cancel" className="tk-act" onClick={() => void L.cancelInstall(m.prog!.packageId)} aria-label={`Cancel ${m.name}`}>Cancel</Button>;
  return <GameActionView ga={ga} variant="button" size={36} kind="secondary" className="tk-act" label={m.name} />;
}

export function Ticket({ m, meId }: { m: Moving; meId: number | null }) {
  const st = stateOf(m);
  const to = m.gameId != null ? `/game/${m.gameId}` : null;
  const p = m.j.progress;
  const artBox = <PosterArt src={m.gameId != null ? art.poster(m.gameId, 256) : null} title={m.name} w={128} h={192} r={12} eager
    progress={m.j.stage === "failed" ? null : p} grey={m.j.stage === "failed" || p == null} />;
  const said = `${m.name} — ${st.text}${askedText(m.game, meId)}`;
  return (
    <li className="tk">
      {to ? <Link to={to} className="tk-art" aria-label={said}>{artBox}</Link> : <span className="tk-art" role="img" aria-label={said}>{artBox}</span>}
      <div className="tk-info">
        {to ? <Link to={to} className="tk-name" tabIndex={-1}>{m.name}</Link> : <span className="tk-name">{m.name}</span>}
        <StateText m={m} />
        <JourneyLine j={m.j} />
        <div className="tk-foot"><Asked g={m.game} meId={meId} /><TicketAction m={m} /></div>
      </div>
    </li>
  );
}

export function Tickets({ items, meId }: { items: Moving[]; meId: number | null }) {
  return <ol className="tk-list">{items.map(m => <Ticket key={m.key} m={m} meId={meId} />)}</ol>;
}

/* ─────────── a section: the shelf's name in the rail, its games beside it ─────────── */

export function Sec({ id, title, children, className, as: H = "h2" }: { id: string; title: string; children: ReactNode; className?: string; as?: "h1" | "h2" }) {
  return (
    <section className={`lib-sec${className ? " " + className : ""}`} aria-labelledby={id}>
      <H className="lib-rail" id={id}>{title}</H>
      <div className="lib-body">{children}</div>
    </section>
  );
}

/** On the way's shape while the library loads: two grey tickets */
export function TicketSkeleton() {
  return (
    <section className="lib-sec lib-skel" aria-busy="true" aria-label="Loading">
      <span className="lib-rail-ph" />
      <ol className="tk-list">{[0, 1].map(i => <li key={i} className="tk tk-ph"><span className="lib-ph-tk-art" /><span className="tk-info"><span className="lib-ph-name" /><span className="lib-ph-line" /></span></li>)}</ol>
    </section>
  );
}

/** the wall's shape while the library loads: grey cards, nothing moving */
export function WallSkeleton({ n = 5 }: { n?: number }) {
  return (
    <section className="lib-sec lib-skel" aria-busy="true" aria-label="Loading">
      <span className="lib-rail-ph" />
      <ol className="lib-wall">{Array.from({ length: n }, (_, i) => <li key={i}><span className="lib-ph-art" /><span className="lib-ph-name" /><span className="lib-ph-line" /></li>)}</ol>
    </section>
  );
}

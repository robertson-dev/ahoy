/**
 * Ahoy — Library (/library) and On the way (/downloads). Board: M/lfs/library-wall/Library-Wall.dc.html (rules: its gen.mjs).
 * One control row (the shelves as chips with counts, and the sort; both remembered), then the shelves as sections, the
 * shelf's name in a rail on the left and its games on the wall beside it: On this PC, On the way (tickets), Ready to
 * install, Coming (the release calendar). An empty shelf leaves no section. Games that are none of those (looked for and
 * not found, or no longer tracked) close the All view, so every game in the count has a place.
 * /downloads is the On the way section on its own, plus what arrived in the last three days.
 * Two views, switched at the end of the controls and remembered (ahoy.libview): this wall, and the list in the picked game's room
 * (screens/library-list.tsx), which keeps this control row in its place and puts its filter in it.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { Game } from "../api";
import { useLib } from "../data";
import { useLauncher } from "../launcher-state";
import { isOpen, orderLine, type Order } from "../orders";
import { usePcs } from "../pcs";
import { art } from "../ui/art";
import { hasCopy } from "../ui/install-on";
import { useUi } from "../ui/kit";
import { PosterArt } from "../ui/poster";
import { Link } from "react-router-dom";
import { Button, ButtonLink, IconButton } from "../ui/button";
import { ReleaseCalendar } from "../ui/calendar";
import { Chips, EmptyState, Select, type ChipItem } from "../ui/controls";
import { LibraryCard, useLineCtx } from "../ui/status";
import {
  LATELY, SHELF_TITLE, SORT_LABEL, Sec, TicketSkeleton, Tickets, Wall, WallSkeleton, useShelves,
  type Shelf, type Sort,
} from "./library-parts";
import { LibraryList, ListSkeleton, warmListRoom } from "./library-list";
import "./library.css";

const SHELVES: readonly Shelf[] = ["all", "here", "ready", "way", "soon"];
const SORTS: readonly Sort[] = ["added", "name", "played"];
type View = "wall" | "list";
const VIEWS: readonly View[] = ["wall", "list"];
const SORT_OPTIONS = SORTS.map(value => ({ value, label: SORT_LABEL[value] }));
const EMPTY_SHELF: Record<Exclude<Shelf, "all">, string> = { here: "Nothing on this PC yet", ready: "Nothing ready to install", way: "Nothing on the way", soon: "Nothing coming" };
const releaseOf = (g: Game) => ({ iso: g.releaseIso, text: g.releaseText });

/** a choice kept in this browser (ahoy.shelf, ahoy.sort, as before the redesign); storage may be off */
function useStored<T extends string>(key: string, ok: readonly T[], fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(key); return s && (ok as readonly string[]).includes(s) ? (s as T) : fallback; } catch { return fallback; }
  });
  const set = useCallback((x: T) => { setV(x); try { localStorage.setItem(key, x); } catch { /* private window, blocked storage */ } }, [key]);
  return [v, set];
}

/** the two views, a pair of round buttons (the one you are in is lit); the List button under the pointer (or the focus) warms
 *  the list's room, so the switch opens on its art */
function ViewSwitch({ view, onChange, onWarm }: { view: View; onChange: (v: View) => void; onWarm?: () => void }) {
  const warm = view === "wall" ? onWarm : undefined;
  return (
    <div className="lib-view" role="radiogroup" aria-label="View">
      <IconButton icon="grid" label="Shelves" size={36} kind={view === "wall" ? "primary" : "quiet"} role="radio" aria-checked={view === "wall"} onClick={() => onChange("wall")} />
      <IconButton icon="list" label="List" size={36} kind={view === "list" ? "primary" : "quiet"} role="radio" aria-checked={view === "list"} onClick={() => onChange("list")}
        onPointerEnter={warm} onFocus={warm} />
    </div>
  );
}

export function Library() {
  const L = useLauncher();
  const [view, setView] = useStored<View>("ahoy.libview", VIEWS, "wall");
  const [saved, setShelf] = useStored<Shelf>("ahoy.shelf", SHELVES, "all");
  const [sort, setSort] = useStored<Sort>("ahoy.sort", SORTS, "added");
  const sh = useShelves(sort);
  const c = useLineCtx({ play: sh.play });
  const meId = c.meId;
  // On this PC is the launcher's: a plain browser keeps the choice but shows All
  const shelf: Shelf = saved === "here" && !L.inLauncher ? "all" : saved;
  const chips: ChipItem<Shelf>[] = [
    { id: "all", label: "All", count: sh.loaded ? sh.counts.all : null },
    ...(L.inLauncher ? [{ id: "here" as const, label: "On this PC", count: sh.loaded ? sh.counts.here : null }] : []),
    { id: "ready", label: "Ready to install", count: sh.loaded ? sh.counts.ready : null },
    { id: "way", label: "On the way", count: sh.loaded ? sh.counts.way : null },
    { id: "soon", label: "Coming", count: sh.loaded ? sh.counts.soon : null },
  ];
  // the one control row of both views (the list puts its filter before the sort)
  const controls = (filter?: ReactNode) => (
    <div className="lib-controls">
      <Chips label="Shelves" value={shelf} onChange={setShelf} items={chips} controls="lib-shelves" />
      <div className="lib-controls-end">
        {filter}
        <Select label="Sort" icon="sort" value={sort} onChange={setSort} options={SORT_OPTIONS} />
        <ViewSwitch view={view} onChange={setView} onWarm={() => warmListRoom(sh, shelf, sort, L.inLauncher)} />
      </div>
    </div>
  );

  // the tab needs no visible title; the hidden one names the page for screen readers
  const title = <h1 className="sr-only">Library</h1>;
  // loading: the chosen view's shape in grey where it will be (the chips control it): the list's frame, or the shelf's (tickets
  // for On the way)
  if (!sh.loaded) {
    if (view === "list") return <ListSkeleton controls={controls} />;
    return <div className="lib">{title}{controls()}<div id="lib-shelves" className="lib-shelves">{shelf === "way" ? <TicketSkeleton /> : <WallSkeleton />}</div></div>;
  }
  if (!sh.total) {
    return (
      <div className="lib">
        {title}
        {sh.error
          ? <EmptyState title="The library didn't load" action={<Button kind="primary" size={44} icon="retry" onClick={() => void sh.reload()}>Try again</Button>} />
          : <EmptyState title="Nothing on your server yet" action={<ButtonLink kind="primary" size={44} to="/discover">Open Discover</ButtonLink>} />}
      </div>
    );
  }

  if (view === "list") return <LibraryList sh={sh} c={c} shelf={shelf} setShelf={setShelf} sort={sort} controls={controls} />;

  const on = (k: Exclude<Shelf, "all">) => shelf === "all" || shelf === k;
  const here = on("here") && L.inLauncher && sh.here.length > 0;
  const way = on("way") && sh.way.length > 0;
  const ready = on("ready") && sh.ready.length > 0;
  const soon = on("soon") && sh.soon.length > 0;
  const none = shelf === "all" && sh.none.length > 0;
  const nothing = !here && !way && !ready && !soon && !none;
  return (
    <div className="lib">
      {title}
      {controls()}
      <div id="lib-shelves" className="lib-shelves">
        {here && <Sec id="lib-here" title={SHELF_TITLE.here}><Wall games={sh.here} shelf="here" c={c} /></Sec>}
        {way && <Sec id="lib-way" title={SHELF_TITLE.way}><Tickets items={sh.way} meId={meId} /></Sec>}
        {ready && <Sec id="lib-ready" title={SHELF_TITLE.ready}><Wall games={sh.ready} shelf="ready" c={c} /></Sec>}
        {soon && (
          <Sec id="lib-soon" title={SHELF_TITLE.soon} className="lib-soon">
            <ReleaseCalendar items={sh.soon} keyOf={g => g.id} release={releaseOf} wrap flush col={204} gap={24} rowGap={40} ruleGap={20} label="Coming"
              renderCell={g => <LibraryCard g={g} c={c} shelf="soon" />} />
          </Sec>
        )}
        {none && <Sec id="lib-none" title="Not on your server"><Wall games={sh.none} shelf="none" c={c} /></Sec>}
        {nothing && shelf !== "all" && (
          <EmptyState title={EMPTY_SHELF[shelf]} action={<Button size={44} onClick={() => setShelf("all")}>Show all</Button>} />
        )}
      </div>
    </div>
  );
}

/** what is to be installed on my other PCs (and what could not be): the game, how it stands there, Cancel or Try again */
function OtherPcs({ orders }: { orders: Order[] }) {
  const lib = useLib();
  const P = usePcs();
  const { toast } = useUi();
  const run = (fn: () => Promise<unknown>) => { void fn().catch(e => toast(String(e?.message ?? e), "danger")); };
  return (
    <ol className="od-list">
      {orders.map(o => {
        const g = lib.byId.get(o.gameId), name = g?.name ?? o.name ?? "A game";
        const line = orderLine(o, !!P.pcs.find(p => p.device === o.device)?.on, !!g && hasCopy(g));
        return (
          <li key={o.id} className="od-row">
            <Link to={`/game/${o.gameId}`} className="od-hit" aria-label={`${name} — ${line}`}>
              <PosterArt src={art.poster(o.gameId, 96)} title={name} w={40} h={60} r={8} />
              <span className="od-tx"><b>{name}</b><small>{line}</small></span>
            </Link>
            {isOpen(o)
              ? <Button size={36} icon="cancel" aria-label={`Cancel ${name} on ${o.device}`} onClick={() => run(() => P.cancel(o.id))}>Cancel</Button>
              : <Button size={36} icon="retry" aria-label={`Try ${name} again on ${o.device}`} onClick={() => run(() => P.place(o.device, o.gameId))}>Try again</Button>}
          </li>
        );
      })}
    </ol>
  );
}

/** On the way on its own (the top bar's downloads pill opens it), plus what arrived in the last three days */
export function Downloads() {
  const lib = useLib();
  const P = usePcs();
  // my other PCs' installs: those waiting or running, and those that could not be done (this PC's own are tickets above)
  const RANK: Record<string, number> = { installing: 0, waiting: 1, failed: 2 };
  const elsewhere = P.orders.filter(o => o.device !== P.here && (isOpen(o) || o.state === "failed")).sort((a, b) => (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3) || b.progress - a.progress || b.id - a.id);
  const sh = useShelves("added");
  const c = useLineCtx({ play: sh.play });
  const meId = c.meId;
  // what reached the server in the last three days, newest first; a game being installed here is a ticket above instead
  const lately = useMemo(() => {
    const t = Date.now() / 1000, moving = new Set(sh.way.map(m => m.gameId));
    return lib.games.filter(g => g.status === "available" && g.file && t - g.file.addedAt < LATELY && !moving.has(g.id))
      .sort((a, b) => (b.file?.addedAt ?? 0) - (a.file?.addedAt ?? 0));
  }, [lib.games, sh.way]);
  if (!sh.loaded) return <div className="lib lib-top"><h1 className="sr-only">{SHELF_TITLE.way}</h1><TicketSkeleton /></div>;
  if (sh.error && !sh.total) {
    return <div className="lib"><h1 className="sr-only">{SHELF_TITLE.way}</h1><EmptyState title="The library didn't load" action={<Button kind="primary" size={44} icon="retry" onClick={() => void sh.reload()}>Try again</Button>} /></div>;
  }
  if (!sh.way.length && !lately.length && !elsewhere.length) {
    return <div className="lib"><h1 className="sr-only">{SHELF_TITLE.way}</h1><EmptyState title="Nothing on the way" action={<ButtonLink size={44} to="/library">Library</ButtonLink>} /></div>;
  }
  return (
    <div className="lib">
      <div className="lib-shelves lib-top">
        <Sec id="dl-way" title={SHELF_TITLE.way} as="h1">
          {sh.way.length ? <Tickets items={sh.way} meId={meId} /> : <p className="lib-quiet">Nothing on the way</p>}
        </Sec>
        {elsewhere.length > 0 && <Sec id="dl-pcs" title="Your other PCs"><OtherPcs orders={elsewhere} /></Sec>}
        {lately.length > 0 && <Sec id="dl-lately" title="Arrived lately"><Wall games={lately} shelf="ready" c={c} /></Sec>}
      </div>
    </div>
  );
}

/**
 * Ahoy — Discover (/discover). Board: M/disc/picked/Discover.dc.html (generator M/disc/picked/tools/gen.mjs).
 *   1. The spotlight of the featured pick (the server lays it out: ui/spotlight's automatic mode): the most-wanted upcoming
 *      game dated 0 to 14 days out with a real hero, else the first New & trending game not on the server with one. One
 *      facts line ("Nov 9 · in 3 days · Jonas tracks it"), its real action and Details.
 *   2. New & trending: 204 × 304 cards, the action on hover. (Just became playable follows when the server has any.)
 *   3. Coming soon: the release calendar of the store's most-wanted upcoming games, who tracks each one under it.
 *   4. Top sellers beside Highest rated (Metacritic's lists: All time, Players, a year).
 *   5. Browse by genre: the genre menu, then the open genre's Loved by players and Selling now.
 * Every row's All goes to its list page. Rows keep their card size and show the cards that fit; the charts stack under
 * 1280; the spotlight covers the full width.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBest, useBestLists, useDiscover, useGenre, useGenres, useLib, usePlayable } from "../data";
import type { BestListInfo, DiscoverItem } from "../api";
import { Button, ButtonLink } from "../ui/button";
import { ReleaseCalendar, releaseWords } from "../ui/calendar";
import { ChartList } from "../ui/chart";
import { Chip, EmptyState, Select, Spinner } from "../ui/controls";
import { SectionHead, SubHead } from "../ui/section";
import { Spotlight, prefetchSpotlight } from "../ui/spotlight";
import { GameAction } from "../ui/game-action";
import { StoreCard, StoreRow, gameOf, hrefOf, tracker, useLineCtx, type LineCtx } from "../ui/status";
import { cleanName, listPath } from "../ui/words";
import { featuredCandidates, releaseOf, uniq, useFeatured, useFit } from "./discover-parts";
import { useSearchParams } from "react-router-dom";
import { useUnderBar } from "../shell/context";
import { useHands } from "../big";
import { PlatformBrowser } from "./platforms";
import "./discover.css";

export function Discover() {
  const [params] = useSearchParams();
  const platform = params.get("platform") || "all";
  const filtered = platform !== "all" || !!params.get("q");
  const wasFiltered = useRef(filtered);
  useLayoutEffect(() => {
    if (wasFiltered.current !== filtered) window.scrollTo(0, 0);
    wasFiltered.current = filtered;
  }, [filtered]);
  const { sections, error, section, reload } = useDiscover(!filtered);
  const c = useLineCtx();
  const soon = useMemo(() => uniq(section("coming_soon")), [sections]);
  const fresh = useMemo(() => uniq(section("new")), [sections]);
  const top = useMemo(() => uniq(section("top")).slice(0, 10), [sections]);
  const calendar = soon;
  const cands = useMemo(() => (!filtered && sections ? featuredCandidates(soon, fresh) : null), [filtered, sections]);
  // the first candidate is most likely the pick: warm its layout while its hero is being checked
  const first = cands?.[0];
  useEffect(() => { if (first) prefetchSpotlight({ appId: first.appId }, cleanName(first.name)); }, [first?.appId]);
  const { item: featured, settled } = useFeatured(cands);
  const empty = !!sections && sections.every(s => !s.items.length);
  const holding = !filtered && !error && !empty && (!sections || !settled);
  useUnderBar(holding);
  return (
    <div className="dsc">
      {featured ? <Featured item={featured} c={c} /> : holding ? <section className="dsc-hold" aria-busy={!sections}>{!sections && <Spinner label="Loading" />}</section> : null}
      <PlatformBrowser filtered={filtered} belowHero={!!featured || holding} />
      {!filtered && <div className="dsc-body">
        {error && !sections && <EmptyState icon="alert" title="Store feeds didn’t load" action={<Button kind="primary" size={44} icon="retry" onClick={reload}>Try again</Button>} />}
        {empty && <EmptyState icon="compass" title="No storefront games right now" action={<Button size={44} icon="retry" onClick={reload}>Try again</Button>} />}
        {sections && !empty && <>
          <Shelf id="new" title="New & trending" all={listPath("new")} allLabel="All new and trending games" items={fresh.filter(i => !i.inLibrary)} c={c} />
          <Playable c={c} />
          {soon.length > 0 && (
            <section className="dsc-sec" aria-labelledby="dsc-soon-h">
              <SectionHead id="dsc-soon-h" title="Coming soon" all={listPath("coming_soon")} allLabel="All upcoming games" />
              <div className="dsc-cal">
                <ReleaseCalendar items={calendar} keyOf={keyOf} release={releaseOf} rows={3} label="Coming soon"
                  renderCell={i => <StoreCard i={i} c={c} size={104} calendar />} />
              </div>
            </section>
          )}
          <Charts top={top} c={c} />
          <Genres c={c} />
        </>}
      </div>}
    </div>
  );
}
const keyOf = (i: DiscoverItem) => i.appId;

/* ─────────── the spotlight ─────────── */

function Featured({ item, c }: { item: DiscoverItem; c: LineCtx }) {
  const lib = useLib();
  const g = gameOf(lib, item);
  const name = cleanName(item.name);
  return (
    <Spotlight source={{ appId: item.appId }} name={name} facts={factsOf(item, tracker(g, c.meId))}
      actions={<><GameAction app={item} variant="button" size={48} label={name} /><ButtonLink to={hrefOf(item, g)} size={48} aria-label={`Details: ${name}`}>Details</ButtonLink></>} />
  );
}

/** the one facts line: the release ("Nov 9 · in 3 days") or the store's review words, then who tracks it */
function factsOf(i: DiscoverItem, t: ReturnType<typeof tracker>): ReactNode {
  let when: string | null = null;
  if (i.comingSoon) {
    const w = releaseWords(releaseOf(i));
    when = w.rel ? `${w.date} · ${w.rel.toLowerCase()}` : w.date;
  } else when = i.reviewSummary ?? (i.reviewPct != null ? `${i.reviewPct}% positive` : null);
  const who: ReactNode = t ? (t.me ? "Tracked" : <><b>{t.name}</b> {t.verb}</>) : null;
  if (!when && !who) return null;
  return <>{when}{when && who ? " · " : ""}{who}</>;
}

/* ─────────── shelves ─────────── */

/** the least a card is wide where the cards share the row (a handheld's big screen): five across its 971 */
const HAND_CARD = 170;

function Shelf({ id, title, all, allLabel, items, c }: { id: string; title: string; all: string; allLabel: string; items: DiscoverItem[]; c: LineCtx }) {
  // (in the hands the cards share the row's width, five across: big.css)
  const [fit, n] = useFit(useHands() ? HAND_CARD : 204, Math.min(12, items.length));
  if (!items.length) return null;
  return (
    <section className="dsc-sec" aria-labelledby={`dsc-${id}-h`} ref={fit}>
      <SectionHead id={`dsc-${id}-h`} title={title} all={all} allLabel={allLabel} />
      <ol className="dsc-row">{items.slice(0, n).map(i => <li key={i.appId}><StoreCard i={i} c={c} /></li>)}</ol>
    </section>
  );
}

/** what just became playable (the server's row; empty unless the engine knows of any) */
function Playable({ c }: { c: LineCtx }) {
  const { items } = usePlayable();
  const list = useMemo(() => uniq(items ?? []), [items]);
  return <Shelf id="playable" title="Just became playable" all={listPath("playable")} allLabel="All games that just became playable" items={list} c={c} />;
}

/* ─────────── Top sellers | Highest rated ─────────── */

const YEAR = /^\d{4}$/;
const readBest = () => { try { return localStorage.getItem("ahoy.best"); } catch { return null; } };

function Charts({ top, c }: { top: DiscoverItem[]; c: LineCtx }) {
  const lists = useBestLists();
  const hasTop = top.length > 0, hasBest = lists.length > 0;
  if (!hasTop && !hasBest) return null;
  // Top sellers keeps its eight columns while Metacritic's lists load (or if there are none), so nothing reflows
  return (
    <div className={`dsc-sec dsc-charts${hasTop ? "" : " solo"}`}>
      {hasTop && (
        <section className="dsc-chart" aria-labelledby="dsc-top-h">
          <SectionHead id="dsc-top-h" title="Top sellers" all={listPath("top")} allLabel="All top sellers" />
          <ChartList label="Top sellers">{top.map((i, n) => <StoreRow key={i.appId} i={i} c={c} lead={n + 1} leadWords={`Number ${n + 1}`} />)}</ChartList>
        </section>
      )}
      {hasBest && <Best lists={lists} c={c} />}
    </div>
  );
}

function Best({ lists, c }: { lists: BestListInfo[]; c: LineCtx }) {
  const years = lists.filter(l => YEAR.test(l.key)), others = lists.filter(l => !YEAR.test(l.key));
  const fallback = years[0]?.key ?? lists[0].key;
  const [want, setWant] = useState<string>(() => readBest() ?? fallback);
  const [nonce, setNonce] = useState(0);
  const key = lists.some(l => l.key === want) ? want : fallback;
  const isYear = YEAR.test(key);
  const info = lists.find(l => l.key === key)!;
  const pick = (k: string) => { if (!k) return; setWant(k); try { localStorage.setItem("ahoy.best", k); } catch { /* private window */ } };
  const words = key === "players" ? "the players' favourites" : isYear ? `the highest rated in ${key}` : `the highest rated, ${info.label.toLowerCase()}`;
  const right = (
    <div className="dsc-pick" role="group" aria-label="Which Metacritic list">
      {others.map(l => <Chip key={l.key} on={l.key === key} aria-controls="dsc-best-list" onClick={() => pick(l.key)}>{l.key === "players" ? "Players" : l.label}</Chip>)}
      {years.length > 0 && <Select label="Year" chosen={isYear} value={isYear ? key : ""} onChange={pick}
        options={[...(isYear ? [] : [{ value: "", label: "Year" }]), ...years.map(y => ({ value: y.key, label: y.label }))]} />}
      <span className="dsc-mc">Metacritic</span>
    </div>
  );
  return (
    <section className="dsc-chart" aria-labelledby="dsc-best-h">
      <SectionHead id="dsc-best-h" title="Highest rated" right={right} all={listPath(`best:${key}`)} allLabel={`All of ${words}`} />
      <BestRows key={`${key}#${nonce}`} listKey={key} players={key === "players"} c={c} onRetry={() => setNonce(n => n + 1)} />
    </section>
  );
}

function BestRows({ listKey, players, c, onRetry }: { listKey: string; players: boolean; c: LineCtx; onRetry: () => void }) {
  const { list, error } = useBest(listKey);
  const items = useMemo(() => uniq(list?.items ?? []).slice(0, 10), [list]);
  let body: ReactNode;
  if (error && !list) body = <EmptyState icon="alert" title="This list didn't load" action={<Button size={36} icon="retry" onClick={onRetry}>Try again</Button>} />;
  else if (!list || (!items.length && list.pending > 0)) body = <Spinner block label="Loading" />;
  else if (!items.length) body = <EmptyState title="Nothing in this list yet" />;
  else body = <>
    <ChartList id="dsc-best-list" label="Highest rated">
      {items.map(i => {
        const lead = players ? (i.userScore != null ? i.userScore.toFixed(1) : "–") : (i.metacritic ?? "–");
        return <StoreRow key={i.appId} i={i} c={c} lead={lead} score year={!YEAR.test(listKey)} leadWords={players ? `User score ${lead}` : `Metascore ${lead}`} />;
      })}
    </ChartList>
    {list.pending > 0 && items.length < 10 && <div className="dsc-more"><Spinner size={16} label="Loading more" /></div>}
  </>;
  return <div className="dsc-best">{body}</div>;
}

/* ─────────── Browse by genre ─────────── */

const readGenre = () => { try { return Number(localStorage.getItem("ahoy.genre")) || null; } catch { return null; } };

function Genres({ c }: { c: LineCtx }) {
  const genres = useGenres();
  const [want, setWant] = useState<number | null>(readGenre);
  const [nonce, setNonce] = useState(0);
  if (!genres.length) return null;
  const tag = genres.some(g => g.tag === want) ? want! : genres[0].tag;
  const label = genres.find(g => g.tag === tag)!.label;
  const open = (t: number) => { setWant(t); try { localStorage.setItem("ahoy.genre", String(t)); } catch { /* private window */ } };
  return (
    <section className="dsc-sec dsc-genres" aria-labelledby="dsc-genre-h">
      <SectionHead id="dsc-genre-h" title="Browse by genre" />
      <div className="dsc-genres-in">
        <ul className="dsc-gmenu" aria-label="Genres">
          {genres.map(g => <li key={g.tag}><button type="button" className="dsc-gbtn" aria-pressed={g.tag === tag} aria-controls="dsc-genre-rows" onClick={() => open(g.tag)}>{g.label}</button></li>)}
        </ul>
        <GenreRows key={`${tag}#${nonce}`} tag={tag} label={label} c={c} onRetry={() => setNonce(n => n + 1)} />
      </div>
    </section>
  );
}

function GenreRows({ tag, label, c, onRetry }: { tag: number; label: string; c: LineCtx; onRetry: () => void }) {
  const { items: rows, error } = useGenre(tag);
  const rated = useMemo(() => uniq(rows?.rated ?? []), [rows]), sellers = useMemo(() => uniq(rows?.sellers ?? []), [rows]);
  // one count for both rows, so their cards stand in the same columns
  const [fit, n] = useFit(128, Math.min(12, Math.max(rated.length, sellers.length, 1)));
  let body: ReactNode;
  if (error && !rows) body = <EmptyState icon="alert" title="This genre didn't load" action={<Button size={36} icon="retry" onClick={onRetry}>Try again</Button>} />;
  else if (!rows) body = <Spinner block label="Loading" />;
  else if (!rated.length && !sellers.length) body = <EmptyState title={`Nothing in ${label} right now`} />;
  else body = <>
    {rated.length > 0 && <GenreRow id="dsc-loved-h" title="Loved by players" all={listPath(`genre:${tag}:rated`)} allLabel={`All loved by players in ${label}`} items={rated.slice(0, n)} c={c} />}
    {sellers.length > 0 && <GenreRow id="dsc-selling-h" title="Selling now" all={listPath(`genre:${tag}:sellers`)} allLabel={`All selling now in ${label}`} items={sellers.slice(0, n)} c={c} />}
  </>;
  return <div className="dsc-grows" id="dsc-genre-rows" ref={fit} role="group" aria-label={label}>{body}</div>;
}

function GenreRow({ id, title, all, allLabel, items, c }: { id: string; title: string; all: string; allLabel: string; items: DiscoverItem[]; c: LineCtx }) {
  return (
    <div className="dsc-grow">
      <SubHead id={id} title={title} all={all} allLabel={allLabel} />
      <ol className="dsc-row sm" aria-labelledby={id}>{items.map(i => <li key={i.appId}><StoreCard i={i} c={c} size={128} /></li>)}</ol>
    </div>
  );
}

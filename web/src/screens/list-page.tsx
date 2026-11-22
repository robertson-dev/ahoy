/**
 * Ahoy — the whole of one Discover row (/discover/list/:key), 50 at a time with "Show more" until the source runs dry.
 * Discover's language (M/disc/picked) carried to the full list:
 *   coming_soon                     the release calendar, wrapped into bands: every date, who tracks each game, Track on hover
 *   top, best:<list>                chart rows in two columns (the rank, or the score for Highest rated), the action at the end
 *   new, playable, genre:<tag>:…    a wall of shelf cards, the action on hover
 * Highest rated keeps its chips (All time, Players, the year) and a genre keeps Loved by players | Selling now: real
 * switches between the server's lists. No explaining copy: the server's sub-lines stay out.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { get, type BestItem, type DiscoverItem, type ListPage as ListPageData } from "../api";
import { useBestLists, useGenres } from "../data";
import { Button, ButtonLink } from "../ui/button";
import { ReleaseCalendar, type Release } from "../ui/calendar";
import { Chips, EmptyState, Select, Spinner } from "../ui/controls";
import { StoreCard, StoreRow, useLineCtx, type LineCtx } from "../ui/status";
import { listPath } from "../ui/words";
import "./search.css";

type Shape = "calendar" | "chart" | "wall";
const shapeOf = (key: string): Shape => (key === "coming_soon" ? "calendar" : key === "top" || key.startsWith("best:") ? "chart" : "wall");
/** the rows' own names; the server's title for anything else */
const TITLES: Record<string, string> = { new: "New & trending", coming_soon: "Coming soon", top: "Top sellers", playable: "Just became playable" };
const GENRE = /^genre:(\d+):(rated|sellers)$/;
/** the rows the server has (server/src/api/discover.ts); anything else is a stale or mistyped address */
const KNOWN = /^(new|coming_soon|top|playable|best:.+|genre:\d+:(rated|sellers))$/;
const release = (i: DiscoverItem): Release => ({ iso: i.releaseIso, text: i.releaseText });

export function ListPage() {
  const { key = "" } = useParams();
  const shape = shapeOf(key);
  const c = useLineCtx();
  const [head, setHead] = useState<ListPageData | null>(null);
  /** one array per page loaded, each game once across them all */
  const [pages, setPages] = useState<DiscoverItem[][]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  const load = (n: number) => {
    const g = gen.current;
    setBusy(true); setError(null);
    get<ListPageData>(`/api/v1/discover/list/${encodeURIComponent(key)}?page=${n}`)
      .then(r => {
        if (g !== gen.current) return;
        setHead(r);
        setPages(prev => {
          const base = n === 0 ? [] : prev;
          const seen = new Set(base.flat().map(i => i.appId));
          const add = r.items.filter(i => !seen.has(i.appId) && !!seen.add(i.appId));
          return [...base, add];
        });
      })
      .catch(e => { if (g === gen.current) setError(String(e?.message ?? e)); })
      .finally(() => { if (g === gen.current) setBusy(false); });
  };
  useEffect(() => { gen.current++; setHead(null); setPages([]); void load(0); }, [key]);
  const items = useMemo(() => pages.flat(), [pages]);

  const known = KNOWN.test(key);
  const discover = <ButtonLink to="/discover" size={44}>Open Discover</ButtonLink>;
  let body: ReactNode;
  if (!head) body = !error ? <Spinner block /> : known ? <Failed onRetry={() => load(0)} /> : <EmptyState icon="compass" title="Nothing here" action={discover} />;
  else if (!items.length) body = head.pending ? <Spinner block /> : <EmptyState icon="compass" title="Nothing here right now" action={discover} />;
  else if (shape === "calendar") body = (
    <ReleaseCalendar className="sx-cal" items={items} keyOf={i => i.appId} release={release} rows={3} wrap label="All upcoming games"
      renderCell={i => <StoreCard i={i} c={c} size={104} calendar />} />
  );
  else if (shape === "chart") body = <Chart pages={pages} c={c} listKey={key} />;
  else body = <ol className="sx-wall">{items.map(i => <li key={i.appId}><StoreCard i={i} c={c} /></li>)}</ol>;

  return (
    <div className="sx sx-list">
      {(known || head) && (
        <header className="sx-head">
          <h1 className="sx-title">{titleOf(key, head)}</h1>
          <Switches listKey={key} />
        </header>
      )}
      <div className="sx-body" aria-busy={busy}>{body}</div>
      {head && items.length > 0 && (head.more || error) && (
        <div className="sx-more">
          {error ? <Failed inline onRetry={() => load(head.page + 1)} />
            : <Button size={44} icon="chevDown" busy={busy} onClick={() => load(head.page + 1)}>Show more</Button>}
        </div>
      )}
    </div>
  );
}

function titleOf(key: string, head: ListPageData | null) {
  if (TITLES[key]) return TITLES[key];
  if (key.startsWith("best:")) return "Highest rated";
  return <GenreTitle listKey={key} fallback={head?.title ?? ""} />;
}

/** a genre's name (the server's title before its " · " while the genres load) */
function GenreTitle({ listKey, fallback }: { listKey: string; fallback: string }) {
  const genres = useGenres();
  const m = GENRE.exec(listKey);
  const label = m ? genres.find(x => x.tag === Number(m[1]))?.label : null;
  return <>{label ?? (m ? fallback.split(" · ")[0] : fallback)}</>;
}

/** the list's own switches: Highest rated's lists, a genre's two rows (each replaces the address: Back still leaves the list) */
function Switches({ listKey }: { listKey: string }) {
  const nav = useNavigate();
  const go = (k: string) => { if (k !== listKey) nav(listPath(k), { replace: true }); };
  const best = /^best:(.+)$/.exec(listKey)?.[1];
  if (best) return <BestSwitches current={best} go={go} />;
  const g = GENRE.exec(listKey);
  if (g) return (
    <div className="sx-switch">
      <Chips label="Rows" value={g[2]} onChange={k => go(`genre:${g[1]}:${k}`)} items={[{ id: "rated", label: "Loved by players" }, { id: "sellers", label: "Selling now" }]} />
    </div>
  );
  return null;
}

/** Highest rated's head, as on Discover: All time, Players, the year (a select drawn as the chosen chip), and the source */
function BestSwitches({ current, go }: { current: string; go: (key: string) => void }) {
  const lists = useBestLists();
  const years = lists.filter(l => /^\d{4}$/.test(l.key));
  const year = years.some(y => y.key === current) ? current : years[0]?.key;
  return (
    <div className="sx-switch">
      <Chips label="Highest rated" value={current} onChange={k => go(`best:${k}`)} items={[{ id: "all", label: "All time" }, { id: "players", label: "Players" }]} />
      {year && <Select label="Year" chosen={year === current} value={year} onChange={y => go(`best:${y}`)} options={years.map(y => ({ value: y.key, label: y.label }))} />}
      <span className="sx-src">Metacritic</span>
    </div>
  );
}

/**
 * Top sellers and Highest rated as chart rows: each page of 50 is its own block of two columns, read down the left column
 * then the right (1-25 | 26-50), so "Show more" adds a block below instead of reflowing the ones you have read.
 */
function Chart({ pages, c, listKey }: { pages: DiscoverItem[][]; c: LineCtx; listKey: string }) {
  const best = listKey.startsWith("best:");
  const players = listKey === "best:players";
  let n = 0;
  return <>{pages.map((page, pi) => page.length > 0 && (
    <ol key={pi} className="sx-chart" style={{ ["--rows" as string]: Math.ceil(page.length / 2) }} start={n + 1}>
      {page.map(i => {
        n++;
        if (!best) return <StoreRow key={i.appId} i={i} c={c} lead={n} leadWords={`Number ${n}`} />;
        const b = i as BestItem;
        const s = players ? (b.userScore != null ? b.userScore.toFixed(1) : null) : b.metacritic != null ? String(b.metacritic) : null;
        return <StoreRow key={i.appId} i={i} c={c} score lead={s ?? "–"} year={!/^best:\d{4}$/.test(listKey)} leadWords={s ? `${players ? "Players' score" : "Metascore"} ${s}` : `Number ${n}`} />;
      })}
    </ol>
  ))}</>;
}

function Failed({ onRetry, inline }: { onRetry: () => void; inline?: boolean }) {
  const retry = <Button size={44} icon="retry" onClick={onRetry}>Try again</Button>;
  if (inline) return <div className="sx-failed"><span>This page didn't load</span>{retry}</div>;
  return <EmptyState icon="alert" title="This list didn't load" action={retry} />;
}

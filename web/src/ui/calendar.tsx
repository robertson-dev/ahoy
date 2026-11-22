/**
 * The release calendar (M/disc/picked "Coming soon", M/lfs/library-wall "Coming"; generator rules in M/disc/picked/tools/gen.mjs).
 *   - Games are grouped under their release date; a month-only date sorts after the last day it could be, anything vaguer last.
 *   - One column per date; a busy date widens to ⌈n / rows⌉ columns (`rows` capsules per column, most wanted first, left to
 *     right then down). Without `rows` a date takes one column per game (the Library's wall).
 *   - Each date: the date (17/600) and "Today" / "in 3 days" (up to 14 days) under it; today gets a light panel and a white bar.
 *   - Under the dates, one hairline rule per stretch of time (this week, next week, then each month); a faint lane before each date.
 *   - Too many dates for the width: scroll sideways (Discover), or `wrap` into bands (the Library). Wrapping without `rows`,
 *     a date with a band's worth of games or more takes the room left in the band (two columns or more) and wraps its games
 *     into rows there, rather than leaving the dates before it alone in a short band (Today stranded).
 *   - `flush`: the first dates stand on the calendar's top edge, so they line up with a heading beside it (the Library's
 *     rail); today's panel reaches past the edges. Only with `wrap` (a scrolling calendar clips what reaches past it).
 * What goes in each cell is up to the caller: renderCell (usually a PosterCard of `col` width).
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
/** local today as yyyy-mm-dd */
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dayNo = (iso: string) => Math.round(Date.parse(iso.slice(0, 10) + "T00:00:00Z") / DAY);

/** a release as the store gives it: an exact day (iso), or only words ("November 2026", "Q1 2027", "Coming soon") */
export interface Release { iso: string | null | undefined; text?: string | null }

export interface CalendarDay<T> {
  key: string; sort: string; date: string; rel: string | null; today: boolean; bucket: string; items: T[];
}

/** the product's words for a release: "Nov 9" / "Nov 9, 2027"; "November" / "Nov 2027"; else the store's words */
export function releaseWords(r: Release, today = todayIso()): { key: string; sort: string; date: string; rel: string | null; isToday: boolean; bucket: string } {
  const y0 = today.slice(0, 4);
  const week0 = dayNo(today) - ((new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7);   // Monday of this week
  if (r.iso && /^\d{4}-\d{2}-\d{2}/.test(r.iso)) {
    const iso = r.iso.slice(0, 10);
    const [y, m, d] = iso.split("-").map(Number);
    const n = dayNo(iso) - dayNo(today);
    const dn = dayNo(iso);
    const bucket = dn >= week0 && dn < week0 + 7 ? "this-week" : dn >= week0 + 7 && dn < week0 + 14 ? "next-week" : `m:${iso.slice(0, 7)}`;
    return { key: iso, sort: iso, date: `${MONTHS[m - 1]} ${d}${String(y) === y0 ? "" : `, ${y}`}`, rel: n === 0 ? "Today" : n > 0 && n <= 14 ? `in ${n} day${n === 1 ? "" : "s"}` : null, isToday: n === 0, bucket };
  }
  const t = (r.text ?? "").trim();
  const mm = /^([A-Za-z]+)\s+(\d{4})$/.exec(t);
  const mi = mm ? MONTHS_LONG.findIndex(x => x.toLowerCase() === mm[1].toLowerCase()) : -1;
  if (mm && mi >= 0) {
    const last = new Date(Date.UTC(+mm[2], mi + 1, 0)).getUTCDate();
    return { key: `text:${t}`, sort: `${mm[2]}-${pad(mi + 1)}-${pad(last)}`, date: mm[2] === y0 ? MONTHS_LONG[mi] : `${MONTHS[mi]} ${mm[2]}`, rel: null, isToday: false, bucket: `m:${mm[2]}-${pad(mi + 1)}` };
  }
  return { key: `text:${t || "soon"}`, sort: `9999:${t}`, date: t || "Coming soon", rel: null, isToday: false, bucket: `t:${t}` };
}

/** the dates and their games, in calendar order (the items keep their given order inside a date) */
export function calendarDays<T>(items: T[], release: (t: T) => Release, today = todayIso()): CalendarDay<T>[] {
  const days = new Map<string, CalendarDay<T>>();
  for (const it of items) {
    const w = releaseWords(release(it), today);
    let d = days.get(w.key);
    if (!d) days.set(w.key, d = { key: w.key, sort: w.sort, date: w.date, rel: w.rel, today: w.isToday, bucket: w.bucket, items: [] });
    d.items.push(it);
  }
  return [...days.values()].sort((a, b) => a.sort.localeCompare(b.sort));
}

export function ReleaseCalendar<T>({ items, release, renderCell, keyOf, rows, col = 104, gap = 20, rowGap = 20, ruleGap = 16, wrap, flush, today, label = "Release calendar", className }: {
  items: T[];
  release: (t: T) => Release;
  renderCell: (t: T, index: number, day: CalendarDay<T>) => ReactNode;
  keyOf: (t: T) => string | number;
  /** capsules per column before a date widens (Discover: 3); none = one column per game */
  rows?: number;
  /** column width, gutter, gap between rows of cells, gap from the rule to the first cells (px) */
  col?: number; gap?: number; rowGap?: number; ruleGap?: number;
  /** start a new band when a date does not fit the width (the Library); otherwise scroll sideways */
  wrap?: boolean;
  /** the first band starts on the top edge and the last ends on the bottom one (beside a heading); with `wrap` */
  flush?: boolean;
  /** yyyy-mm-dd; local today by default */
  today?: string;
  label?: string;
  className?: string;
}) {
  const t0 = today ?? todayIso();
  const days = useMemo(() => calendarDays(items, release, t0), [items, release, t0]);
  const root = useRef<HTMLDivElement>(null);
  const [cap, setCap] = useState(Infinity);
  useLayoutEffect(() => {
    if (!wrap || !root.current) return;
    const el = root.current;
    const on = () => setCap(Math.max(1, Math.floor((el.clientWidth + gap) / (col + gap))));
    on();
    const ro = new ResizeObserver(on); ro.observe(el);
    return () => ro.disconnect();
  }, [wrap, col, gap]);
  if (!days.length) return null;
  // columns per date, then bands (one band when scrolling)
  const laid = days.map(d => ({ d, cols: Math.min(rows ? Math.ceil(d.items.length / rows) : d.items.length, wrap ? cap : Infinity) }));
  const bands: (typeof laid)[] = [];
  let used = 0;
  for (const x of laid) {
    const room = cap - used;
    if (wrap && !rows && used > 0 && x.cols >= cap && room >= 2) x.cols = room;   // a date that would fill a band takes the room left, in rows
    if (!bands.length || (wrap && used > 0 && used + x.cols > cap)) { bands.push([]); used = 0; }
    bands[bands.length - 1].push(x); used += x.cols;
  }
  const vars = { ["--col" as string]: `${col}px`, ["--gap" as string]: `${gap}px`, ["--row-gap" as string]: `${rowGap}px`, ["--rule-gap" as string]: `${ruleGap}px` } as CSSProperties;
  return (
    <div ref={root} className={`cal${wrap ? " wrap" : " scroll"}${wrap && flush ? " flush" : ""}${className ? " " + className : ""}`} style={vars} role="group" aria-label={label}>
      {bands.map((band, bi) => (
        <div className="cal-band" key={bi}>
          {band.map(({ d, cols }, i) => {
            const prev = band[i - 1]?.d, next = band[i + 1]?.d;
            const lane = i > 0 && !prev?.today;
            const join = !!next && next.bucket === d.bucket;
            return (
              <section key={d.key} className={`cal-day${d.today ? " today" : ""}${lane ? " lane" : ""}`} style={{ ["--cols" as string]: cols } as CSSProperties} aria-label={d.rel ? `${d.date}, ${d.rel}` : d.date}>
                <h3 className="cal-date"><span>{d.date}</span>{d.rel && <span className="cal-rel">{d.rel}</span>}</h3>
                <span className={`cal-rule${join ? " join" : ""}`} aria-hidden>{d.today && <i className="cal-bar" />}</span>
                <ol className="cal-cells">{d.items.map((it, k) => <li key={keyOf(it)}>{renderCell(it, k, d)}</li>)}</ol>
              </section>
            );
          })}
        </div>
      ))}
    </div>
  );
}

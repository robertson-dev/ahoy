/**
 * Ahoy — Discover's own pieces (private to screens/discover.tsx), in the language of M/disc/picked/Discover.dc.html:
 *   useFit        how many whole cards fit a row (a shelf keeps its card size and shows what fits; All has the rest)
 *   useFeatured   the featured pick: the first candidate whose Steam library hero is real (meta hero width >= 1920)
 * The cards, rows and their lines are the shared ones (ui/status.tsx); nothing is set per game.
 */
import { useEffect, useLayoutEffect, useState } from "react";
import type { DiscoverItem } from "../api";
import { metaUrl, type ArtMeta } from "../ui/art";
import { releaseWords, type Release } from "../ui/calendar";

/** each game once (the store's lists can repeat an app) */
export function uniq<T extends { appId: number }>(xs: readonly T[]): T[] {
  const seen = new Set<number>();
  return xs.filter(x => !seen.has(x.appId) && !!seen.add(x.appId));
}
/** a store item's release, for the calendar and the date words */
export const releaseOf = (i: DiscoverItem): Release => ({ iso: i.releaseIso, text: i.releaseText });

/* ─────────── whole cards per row ─────────── */

/**
 * How many whole `w` px cards, 24 apart, fit the element's width (six 204 cards in the boards' 1344; the page scrollbar
 * lives in the right margin, ahoy.css --page-r). At least one card, at most `max`. Attach the ref to the row's container.
 */
export function useFit(w: number, max: number, gap = 24): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(() => document.documentElement.clientWidth - 96);
  useLayoutEffect(() => {
    if (!el) return;
    const on = () => setWidth(el.clientWidth);
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, Math.max(1, Math.min(max, Math.floor((width + gap) / (w + gap))))];
}

/* ─────────── the featured pick ─────────── */

/** a real hero: Steam's library heroes are 1920 × 620 or 3840 × 1240 */
const REAL_HERO = 1920;
const heroWidth = new Map<number, number | null>();
const heroAsk = new Map<number, Promise<number | null>>();
/** the width of a store app's logo-free hero, from the server's art meta (null when the hero route serves the blank). Only
 *  an answer is remembered: a request that failed counts as no hero this time and is asked again on the next visit. */
function askHero(appId: number): Promise<number | null> {
  if (heroWidth.has(appId)) return Promise.resolve(heroWidth.get(appId) ?? null);
  let p = heroAsk.get(appId);
  if (!p) {
    p = fetch(metaUrl("steam", appId), { credentials: "include" })
      .then(async r => {
        if (!r.ok) return null;
        const w = ((await r.json()) as ArtMeta).hero?.w ?? null;
        heroWidth.set(appId, w);
        return w;
      })
      .catch(() => null)
      .finally(() => heroAsk.delete(appId));
    heroAsk.set(appId, p);
  }
  return p;
}
/** the pick from what this page already knows: the first candidate with a real hero, if every one before it is known */
function pickKnown(cands: DiscoverItem[]): { item: DiscoverItem | null; settled: boolean } | null {
  for (const i of cands) {
    if (!heroWidth.has(i.appId)) return null;
    if ((heroWidth.get(i.appId) ?? 0) >= REAL_HERO) return { item: i, settled: true };
  }
  return { item: null, settled: true };
}

/**
 * The featured game, by the board's rule (SCREENS.md, gen.mjs pickFeatured): the most-wanted upcoming game (the Coming
 * soon feed's order) with an exact date 0 to 14 days away and a real hero; else the first New & trending game that is
 * not on the server and has a real hero. `cands` is that order; the heroes are asked one at a time, first to last.
 */
export function useFeatured(cands: DiscoverItem[] | null): { item: DiscoverItem | null; settled: boolean } {
  const ids = cands ? cands.map(i => i.appId).join(",") : null;
  const [state, setState] = useState<{ ids: string | null; item: DiscoverItem | null; settled: boolean }>(() => ({ ids, ...(cands ? pickKnown(cands) ?? { item: null, settled: false } : { item: null, settled: false }) }));
  useEffect(() => {
    if (!cands) return;
    const known = pickKnown(cands);
    if (known) { setState({ ids, ...known }); return; }
    setState(s => (s.ids === ids ? s : { ids, item: null, settled: false }));
    let live = true;
    void (async () => {
      for (const i of cands) {
        const w = await askHero(i.appId);
        if (!live) return;
        if (w != null && w >= REAL_HERO) { setState({ ids, item: i, settled: true }); return; }
      }
      if (live) setState({ ids, item: null, settled: true });
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  return state.ids === ids ? { item: state.item, settled: state.settled } : { item: null, settled: false };
}

/** the candidates in the rule's order: upcoming games dated 0 to 14 days out, then New & trending games not on the server */
export function featuredCandidates(soon: DiscoverItem[], fresh: DiscoverItem[]): DiscoverItem[] {
  const dated = soon.filter(i => {
    if (!i.comingSoon || !i.releaseIso) return false;
    const w = releaseWords(releaseOf(i));
    return w.isToday || (w.rel != null && w.rel.startsWith("in "));
  });
  return uniq([...dated.slice(0, 8), ...fresh.filter(i => !i.inLibrary).slice(0, 8)]);
}

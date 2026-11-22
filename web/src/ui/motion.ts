/**
 * Ahoy's motion: things come into focus as they arrive and go out of focus as they leave (a blur, a fade, a few px of
 * travel), all on the one curve (--ease). The keyframes are in ahoy.css ("motion"); this file holds what needs script:
 *   - settlePage(main): a change of page brings the content into focus (a blur, a fade, a few px of travel) while the top bar
 *     never moves, and what the new page's parts would play to arrive is finished at once, so a page you come back to shows
 *     as it was instead of being built again. (A whole-window blur out and in, top bar included, read as the app reloading;
 *     then a plain fade lost the blur the app is made of: "the blur fx is gone", 2026-11-07.)
 *   - usePresence(open): keeps a closing panel, dialog or toast mounted while it leaves (its out-animation runs on
 *     `leaving`).
 */
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type RefObject } from "react";

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** the content coming into focus on a change of page */
export const PAGE_IN_MS = 340;
/** what a part plays when it arrives (ahoy.css, fan.css, spotlight.css): a change of page finishes these at once */
const ARRIVALS = new Set(["focus-in", "rise-in", "hf-rise", "hf-in", "spot-a-arrive", "spot-a-in", "swap-in"]);

/**
 * Settle the page that just came in (call it once the new page is in the DOM): the content comes into focus over 340 ms, from
 * a 10 px blur, 35% and 6 px lower (`blur: false`, a fade alone: the big screen, a fixed layer that a filter on the page would
 * take as its frame); every arrival animation started within `ms` is finished, so sections, the spotlight and the fan show as
 * they are. Loops (spinners), the skeleton's delayed entrance and anything that arrives after `ms` (data that was not in hand
 * yet) play as usual. Returns a stop for an early unmount.
 */
export function settlePage(main: HTMLElement, { blur = true, ms = 300 }: { blur?: boolean; ms?: number } = {}): () => void {
  if (reducedMotion()) return () => {};
  main.animate(blur
    ? [{ opacity: 0.35, filter: "blur(10px)", transform: "translateY(6px)" }, { opacity: 1, filter: "blur(0px)", transform: "none" }]
    : [{ opacity: 0.4 }, { opacity: 1 }],
  { duration: blur ? PAGE_IN_MS : 160, easing: "cubic-bezier(.22, 1, .36, 1)" });
  const finish = () => {
    for (const a of main.getAnimations({ subtree: true })) {
      if (typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation && ARRIVALS.has(a.animationName)) a.finish();
    }
  };
  finish();
  const end = performance.now() + ms;
  let raf = 0;
  const tick = () => { finish(); if (performance.now() < end) raf = requestAnimationFrame(tick); };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/**
 * A block drawn anew when `k` changes (a keyed swap: the action row going Request, Cancel, Install, Play) keeps the focus in its
 * place: the button or link that had it, by its place among the block's, has it in the new block. Give the ref to the keyed
 * element.
 */
export function useSwapFocus<T extends HTMLElement>(k: string): RefObject<T> {
  const box = useRef<T>(null);
  const was = useRef(k), keep = useRef(-1);
  if (was.current !== k) {
    // read in the block still on the page, before the new one replaces it
    was.current = k;
    const all = box.current ? Array.from(box.current.querySelectorAll<HTMLElement>("button, a[href]")) : [];
    keep.current = all.indexOf(document.activeElement as HTMLElement);
  }
  useLayoutEffect(() => {
    const i = keep.current;
    keep.current = -1;
    if (i < 0 || !box.current) return;
    const all = box.current.querySelectorAll<HTMLElement>("button, a[href]");
    all[Math.min(i, all.length - 1)]?.focus({ preventScroll: true });
  }, [k]);
  return box;
}

/** how long an exit takes (ahoy.css: fall, veil-out) */
export const LEAVE_MS = 200;

/** `mounted` stays true for `ms` after `open` goes false, with `leaving` set, so the element can animate out */
export function usePresence(open: boolean, ms = LEAVE_MS): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    if (!mounted) return;
    if (reducedMotion()) { setMounted(false); return; }
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return { mounted: open || mounted, leaving: !open && mounted };
}

/** the attributes of an element on its way out: it takes no clicks and no focus while it fades */
export const leavingProps = (leaving: boolean): HTMLAttributes<HTMLElement> => (leaving ? ({ "data-leaving": "", inert: "", "aria-hidden": true } as unknown as HTMLAttributes<HTMLElement>) : {});

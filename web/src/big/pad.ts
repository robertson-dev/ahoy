/**
 * Big screen — the pad over the app as it is. The focus engine (nav.ts) moves one focus spatially; here it is taught the
 * normal pages: anything a mouse could click can take the focus, the topmost dialog or panel is what is in play, the
 * focus is the page's real focus (so a card shows its action the way it does for the Tab key) and counts as hovering
 * (hover.ts), and the focused thing is kept in view.
 *
 *   what can take the focus   links, buttons, fields, anything with a tab stop: whatever is on the page, enabled, visible
 *                             and not kept out of the Tab order (tabindex -1, aria-hidden, inert, [data-pad-skip])
 *   what is in play           the last of: one of the mode's own sheets (.bs-layer), a dialog, a media viewer, an open
 *                             panel of the top bar; else the whole page
 *   a thing with its own      the element says so (aria-keyshortcuts="ArrowLeft ArrowRight", a listbox's Up and Down, a
 *   arrow keys                radio's and a slider's Left and Right): the pad's direction is sent to it as that key instead
 *                             of moving on; when the key changes nothing (it was at its end) the pad moves on after all
 */
import { Nav, type Dir } from "./nav";
import { hoverOn, twinHoverRules } from "./hover";

// (a listbox's options are not here: the listbox takes the focus and walks them with its own Up and Down)
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [role="button"], [role="menuitem"], [role="tab"], [role="listbox"], [tabindex]';
const OUT = '[disabled], [aria-disabled="true"], [aria-hidden="true"], [inert], [data-pad-skip], input[type="hidden"]';
/** the mode's own sheets (the keyboard, a choice list): their keys take the pad's focus but never the page's, so the field
 *  they write into keeps it */
const VIRTUAL = "[data-pad-virtual]";
const LAYERS = ".bs-layer, .viewer, .overlay .modal, .tb-panel";
const TEXT_TYPES = new Set(["text", "search", "password", "email", "url", "tel", "number", ""]);
const ARROW: Record<Dir, string> = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** can the pad land on it: on the page with a size, enabled, in the Tab order, and not see-through (a card's action until its card is hovered) */
export function usable(el: HTMLElement, tabStops = true): boolean {
  if (el.matches(OUT) || el.closest('[aria-hidden="true"], [inert], [data-pad-skip]')) return false;
  // (tabStops false: the page itself put the focus there, as a group of choices does with the one just chosen)
  if (tabStops && el.matches('[tabindex="-1"]') && !el.closest(VIRTUAL)) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.pointerEvents === "none") return false;
  // see-through means hidden, unless it is only arriving (a sheet or a dialog fades in from nothing)
  for (let p: HTMLElement | null = el; p && p !== document.body; p = p.parentElement) if (seeThrough(p)) return false;
  return true;
}

/** is this element itself see-through and staying so? Asked of the same elements again and again in one look at the page
 *  (every poster of a row shares its row and its page), so one look keeps what it found (looking) */
let looking: Map<HTMLElement, boolean> | null = null;
function seeThrough(p: HTMLElement): boolean {
  const known = looking?.get(p);
  if (known !== undefined) return known;
  const v = getComputedStyle(p).opacity === "0" && !p.getAnimations().some(a => a.playState === "running");
  looking?.set(p, v);
  return v;
}

/** a field the person types into */
export const isTextField = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  !!el && ((el instanceof HTMLInputElement && TEXT_TYPES.has(el.type) && !el.readOnly && !el.disabled) || (el instanceof HTMLTextAreaElement && !el.readOnly && !el.disabled));

/** does the element take this arrow itself? */
export function ownsArrow(el: HTMLElement, dir: Dir): boolean {
  if ((el.getAttribute("aria-keyshortcuts") ?? "").split(/\s+/).includes(ARROW[dir])) return true;
  if (el.getAttribute("role") === "listbox") return dir === "up" || dir === "down";
  // a choice of one among a few (the only one of them with a tab stop): Left and Right change the choice
  if (el.getAttribute("role") === "radio") return dir === "left" || dir === "right";
  return el instanceof HTMLInputElement && el.type === "range" && (dir === "left" || dir === "right");
}

/** set a field's value the way typing does: the page's own change handlers run */
export function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** the nearest thing that scrolls by itself around `el` (not the page) */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if ((/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) || (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1)) return p;
  }
  return null;
}

/**
 * Keep the focused thing in view: in the middle of the screen for a move up or down (the couch reads the middle), only as far
 * as needed for a move along a line. Near the page's top the page itself goes to its top, so a hero is whole, not cut by a
 * centring. The top bar and the mode's own sheets are fixed: nothing to do.
 */
export function reveal(el: HTMLElement, how: boolean | "x" | "y" = true) {
  if (el.closest(".tb, .bs-layer")) return;
  const behavior: ScrollBehavior = reduced() ? "auto" : "smooth";
  const r = el.getBoundingClientRect();
  if (!scroller(el) && r.bottom + scrollY < innerHeight * 0.92) { if (scrollY > 0) scrollTo({ top: 0, behavior }); return; }
  el.scrollIntoView({ block: how === "x" ? "nearest" : "center", inline: how === "y" ? "nearest" : "center", behavior });
}

export class PadNav extends Nav {
  /** true while this engine itself moves the page's focus (the page's focus events are then its own echo) */
  moving = false;

  layer(): HTMLElement | Document {
    const open = [...document.querySelectorAll<HTMLElement>(LAYERS)].filter(e => !e.closest("[data-leaving]") && e.getBoundingClientRect().height > 0);
    return open.length ? open[open.length - 1]! : document;
  }
  candidates(): HTMLElement[] {
    looking = new Map();
    try { return [...this.layer().querySelectorAll<HTMLElement>(FOCUSABLE)].filter(e => usable(e)); }
    finally { looking = null; }
  }
  focus(el: HTMLElement | null, scroll: boolean | "x" | "y" = true) {
    if (this.current === el) return;
    super.focus(el, false);                                  // the engine's own books: what is current, where it was
    this.mark(el);
    if (el && document.activeElement !== el && !el.closest(VIRTUAL)) {
      this.moving = true;
      try { el.focus({ preventScroll: true }); } finally { this.moving = false; }
    }
    if (el && scroll) reveal(el, scroll);
  }
  /** show the focus on `el` (data-pf) and hover it; null clears both */
  mark(el: HTMLElement | null) {
    document.querySelectorAll("[data-pf]").forEach(x => { if (x !== el) x.removeAttribute("data-pf"); });
    el?.setAttribute("data-pf", "");
    twinHoverRules();
    hoverOn(el);
  }
  /** the page's own focus moved (a dialog took it, a click, a control that moves it itself): the pad's focus follows */
  adopt(target: EventTarget | null) {
    if (this.moving || !(target instanceof HTMLElement) || target === this.current) return;
    const layer = this.layer();
    if (layer !== document && (layer as HTMLElement).matches(VIRTUAL)) return;      // a sheet of the mode is open: the field under it keeps the page's focus
    if (!layer.contains(target) || !target.matches(FOCUSABLE) || !usable(target, false)) return;
    super.focus(target, false);
    this.mark(target);
  }
  /** nothing is focused, or what was is gone: start on what asks for it, else the page's main action, else its first thing */
  land(preferred?: HTMLElement | null) {
    const c = this.candidates();
    if (preferred && c.includes(preferred)) { this.focus(preferred); return; }
    const layer = this.layer();
    const within = layer === document ? (document.querySelector("main") ?? document) : layer;
    // as the page reads: from the top, then from the left (the page's own order in the document can differ)
    const at = new Map(c.map(e => [e, e.getBoundingClientRect()] as const));
    const mine = c.filter(e => within.contains(e)).sort((a, b) => { const ra = at.get(a)!, rb = at.get(b)!; return Math.abs(ra.top - rb.top) > 12 ? ra.top - rb.top : ra.left - rb.left; });
    const first = mine.find(e => e.dataset.autofocus != null)
      // a page that is a list to walk (the Library's list): the list itself
      ?? (layer === document ? mine.find(e => e.getAttribute("role") === "listbox") : undefined)
      // a page's main action: its big white button (Install, Play), when it is on the first screen
      ?? (layer === document ? mine.find(e => e.matches(".btn.primary.s48, .btn.primary.s44") && at.get(e)!.top < innerHeight) : undefined)
      ?? mine[0] ?? c[0] ?? null;
    this.current?.classList.remove("f");
    this.current = null;
    this.focus(first);
  }
  /** put the focus on `el` even when the engine thinks it is there already (a sheet closed over it) */
  refocus(el: HTMLElement | null, scroll: boolean | "x" | "y" = false) {
    this.current?.classList.remove("f");
    this.current = null;
    this.focus(el, scroll);
  }
}

/** what a control that takes the arrows itself shows of where it is: when a key leaves this unchanged, the control was at
 *  its end, and the pad moves on past it */
export function whereIn(el: HTMLElement): string {
  const marked = el.querySelector('[aria-selected="true"], [aria-current="true"], .on, .sel');
  return [el.getAttribute("aria-activedescendant") ?? "", (el as HTMLInputElement).value ?? "", el.scrollTop, el.scrollLeft, marked ? (marked.id || marked.textContent || "").slice(0, 60) : "", document.activeElement === el ? "" : describeShort(document.activeElement)].join("|");
}
const describeShort = (e: Element | null) => (e ? `${e.tagName}:${(e.getAttribute("aria-label") ?? e.textContent ?? "").slice(0, 40)}` : "");

/** send the element a key, as if it were pressed on it */
export function sendKey(el: HTMLElement, key: string) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
}
export const arrowKey = (dir: Dir) => ARROW[dir];

/** one step of a slider */
export function stepRange(el: HTMLInputElement, dir: "left" | "right") {
  const min = Number(el.min || 0), max = Number(el.max || 100), step = Number(el.step) || 1;
  const span = Math.max(step, Math.round((max - min) / 40 / step) * step);
  const v = Math.min(max, Math.max(min, Number(el.value) + (dir === "right" ? span : -span)));
  setValue(el, String(v));
}

/** how a link, a button or a named thing is found again on its page (Back comes back to what was opened) */
export function describe(el: HTMLElement): { href: string | null; label: string; x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { href: el.getAttribute("href"), label: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 80), x: r.left + r.width / 2 + scrollX, y: r.top + r.height / 2 + scrollY };
}
export function findAgain(d: { href: string | null; label: string; x: number; y: number }, among: HTMLElement[]): HTMLElement | null {
  const same = among.filter(e => (d.href != null ? e.getAttribute("href") === d.href : (e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 80) === d.label && d.label !== ""));
  const pool = same.length ? same : [];
  let best: HTMLElement | null = null, bd = Infinity;
  for (const e of pool) { const r = e.getBoundingClientRect(); const dist = Math.hypot(r.left + r.width / 2 + scrollX - d.x, r.top + r.height / 2 + scrollY - d.y); if (dist < bd) { bd = dist; best = e; } }
  return best;
}

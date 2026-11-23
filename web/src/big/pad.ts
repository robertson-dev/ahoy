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
 *   the top bar               stays in the window while the page scrolls under it: a strip of its own, reached from the
 *                             page's first row and left downwards to what is on screen (PadNav.move)
 *   a card's own action       the pill that appears on a hovered card (Install on a poster) is no stop of its own: every row
 *                             of a wall would take two steps. It is marked [data-pad-skip], and X presses it (cardAction)
 */
import { Nav, type Dir } from "./nav";
import { hoverOn, twinHoverRules } from "./hover";
import { bigMode } from "./mode";

// (a listbox's options are not here: the listbox takes the focus and walks them with its own Up and Down)
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [role="button"], [role="menuitem"], [role="tab"], [role="listbox"], [tabindex]';
const OUT = '[disabled], [aria-disabled="true"], [aria-hidden="true"], [inert], [data-pad-skip], input[type="hidden"]';
/** the mode's own sheets (the keyboard, a choice list): their keys take the pad's focus but never the page's, so the field
 *  they write into keeps it */
const VIRTUAL = "[data-pad-virtual]";
const LAYERS = ".bs-layer, .viewer, .overlay .modal, .tb-panel";
const TEXT_TYPES = new Set(["text", "search", "password", "email", "url", "tel", "number", ""]);
const ARROW: Record<Dir, string> = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };
const OPPOSITE: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };
/** what stays put in the window while the page scrolls under it */
const FIXED = ".tb";
/** a form (Settings: lines of a name, a field or a switch, buttons at the far end): Up and Down go line by line in it (PadNav.formStep) */
const FORM = ".st-main, [data-pad-form]";
/** a group that walks its own members with the arrows (the Home's fan, a choice of one among a few): its members stand for one another */
const OWN_GROUP = '[role="group"], [role="radiogroup"], [role="listbox"], [role="tablist"]';

/** where the window ends on the screen: its own edge, less what hangs over the display's (mode.ts overhang) */
const sightBottom = () => innerHeight - bigMode.cut.bottom;
const sightRight = () => innerWidth - bigMode.cut.right;
/** where the page begins in the window: under the top bar */
const pageTop = () => document.querySelector(FIXED)?.getBoundingClientRect().bottom ?? 0;
/** nothing of it is on screen (the page was scrolled away from it by the stick, the wheel or a finger) */
export function outOfSight(el: HTMLElement): boolean {
  if (el.closest(FIXED + ", .bs-layer")) return false;
  const r = el.getBoundingClientRect();
  return r.bottom <= pageTop() + 4 || r.top >= sightBottom() - 4 || r.right <= 4 || r.left >= sightRight() - 4;
}
/** the pill a card shows on hover for its one action (ui/poster.tsx): what X presses while the card has the focus */
export function cardAction(el: HTMLElement | null): HTMLElement | null {
  const act = el?.closest(".pc")?.querySelector<HTMLElement>(".pc-act button, .pc-act a") ?? null;
  return act && !act.matches('[disabled], [aria-disabled="true"]') ? act : null;
}

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
  // see-through means hidden, unless it is only arriving (a sheet or a dialog fades in from nothing). [data-pad-solid]: drawn
  // see-through on purpose, with something else showing in its place (the search folded to its icon in a narrow window)
  for (let p: HTMLElement | null = el.hasAttribute("data-pad-solid") ? el.parentElement : el; p && p !== document.body; p = p.parentElement) if (seeThrough(p)) return false;
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
  if (!scroller(el) && r.bottom + scrollY < sightBottom() * 0.92) { if (scrollY > 0) scrollTo({ top: 0, behavior }); return; }
  el.scrollIntoView({ block: how === "x" ? "nearest" : "center", inline: how === "y" ? "nearest" : "center", behavior });
}

export class PadNav extends Nav {
  /** true while this engine itself moves the page's focus (the page's focus events are then its own echo) */
  moving = false;
  /** what a step may land on, while one is being taken (move) */
  private only: ((e: HTMLElement) => boolean) | null = null;
  /** the last step taken: one straight back returns to where it started (Down from Play to the fan, Up again: Play) */
  private trail: { from: HTMLElement; to: HTMLElement; dir: Dir } | null = null;

  layer(): HTMLElement | Document {
    const open = [...document.querySelectorAll<HTMLElement>(LAYERS)].filter(e => !e.closest("[data-leaving]") && e.getBoundingClientRect().height > 0);
    return open.length ? open[open.length - 1]! : document;
  }
  candidates(): HTMLElement[] {
    looking = new Map();
    try {
      const all = [...this.layer().querySelectorAll<HTMLElement>(FOCUSABLE)].filter(e => usable(e));
      return this.only ? all.filter(this.only) : all;
    } finally { looking = null; }
  }

  /**
   * One step. The engine (nav.ts) picks the nearest thing in the direction pressed, by where things are in the window. On a
   * page that is not enough: the top bar stays in the window while the page scrolls under it, so it is always the nearest
   * thing "above" what is in view. A step up from deep in a page went into the bar instead of to the row above, and the next
   * one from the bar to a row scrolled out of sight. So, while no dialog or panel is open:
   *   in the page   a step stays in the page; only where the page has nothing further up does Up reach the bar
   *   in the bar    Left and Right walk the bar; Down goes to what is on screen under it; Up is its edge
   * A step straight back the way the last one came returns to where that one started. And when what has the focus is out of
   * sight (the page was scrolled by the stick, the wheel or a finger), the step lands on what is in view instead of
   * dragging the page back.
   */
  move(dir: Dir) {
    const cur = this.current, layer = this.layer();
    if (!cur || !cur.isConnected || !layer.contains(cur) || !usable(cur, false)) { this.heal(); return; }
    const t = this.trail;
    if (t && t.to === cur && OPPOSITE[t.dir] === dir && t.from.isConnected && layer.contains(t.from) && usable(t.from, false)) { this.step(t.from, dir); return; }
    if (layer !== document) { this.take(dir, null); return; }
    const inBar = !!cur.closest(FIXED);
    if (!inBar && outOfSight(cur)) { const seen = this.inSight(); if (seen) { this.step(seen, dir); return; } }
    if (inBar && dir === "up") return;
    const line = !inBar && (dir === "up" || dir === "down") ? this.formStep(cur, dir) : null;
    if (line) { this.step(line, dir); return; }
    if (this.take(dir, e => !!e.closest(FIXED) === inBar)) return;
    if (!inBar && dir === "up") this.take(dir, e => !!e.closest(FIXED));
    else if (inBar && dir === "down") { const top = pageTop(); this.take(dir, e => !e.closest(FIXED) && e.getBoundingClientRect().bottom > top + 8); }
  }
  /**
   * A step up or down a form. Its lines hold things in different places (a field in the middle, a switch at its start, a
   * button at the far end), and the engine prefers what lines up: from a button it went down the buttons and passed every
   * switch on the way. In a form the step is to the next line that has anything, and on it to what is nearest sideways.
   * Null where the next thing that way is no line of a form (the engine's own step then).
   */
  private formStep(cur: HTMLElement, dir: "up" | "down"): HTMLElement | null {
    const form = cur.closest(FORM);
    if (!form) return null;
    const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2;
    const gap = (r: DOMRect) => (dir === "down" ? r.top - a.bottom : a.top - r.bottom);
    // what lies that way in the form: past this line (its middle beyond this thing's edge)
    const that = this.candidates().filter(e => e !== cur && form.contains(e)).map(e => [e, e.getBoundingClientRect()] as const)
      .filter(([, r]) => (dir === "down" ? r.top + r.height / 2 > a.bottom - 2 : r.top + r.height / 2 < a.top + 2));
    if (!that.length) return null;
    // the next line: the nearest of them, and whatever stands beside it
    const near = that.reduce((m, x) => (gap(x[1]) < gap(m[1]) ? x : m))[1];
    let best: HTMLElement | null = null, bs = Infinity;
    for (const [e, r] of that) {
      if (!(r.top < near.bottom - 2 && r.bottom > near.top + 2)) continue;
      const lined = r.left < a.right && r.right > a.left;
      const s = Math.abs(r.left + r.width / 2 - ax) * (lined ? 0.3 : 1) + (lined ? 0 : 200);
      if (s < bs) { bs = s; best = e; }
    }
    return best;
  }
  /** the engine's own step among the candidates `only` lets through; did the focus move? */
  private take(dir: Dir, only: ((e: HTMLElement) => boolean) | null): boolean {
    const from = this.current;
    this.only = only;
    try { super.move(dir); } finally { this.only = null; }
    if (!from || !this.current || this.current === from) return false;
    // nothing lines up with where the step started (the fan under a page's head, the Library's list under its view switch):
    // it goes to the main thing that way, not to whichever happens to be nearest. A list to walk; else, of a line of
    // actions, its main one
    if (dir === "up" || dir === "down") {
      const to = this.current, a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
      if (!(b.left < a.right && b.right > a.left)) {
        const beyond = (e: HTMLElement) => { const r = e.getBoundingClientRect(); return dir === "down" ? r.top >= a.bottom - 4 : r.bottom <= a.top + 4; };
        this.only = only;
        const list = this.candidates().find(e => e.getAttribute("role") === "listbox" && beyond(e));
        this.only = null;
        // (a line's main action is its white button; where it has none, a download's Cancel, the one it starts with)
        const line = to.matches(".btn") ? to.parentElement : null;
        const main = list ?? line?.querySelector<HTMLElement>(":scope > .btn.primary") ?? line?.querySelector<HTMLElement>(":scope > .btn");
        if (main && main !== to && usable(main)) this.focus(main, "y");
      }
    }
    this.trail = { from, to: this.current, dir };
    return true;
  }
  private step(to: HTMLElement, dir: Dir) {
    const from = this.current;
    this.focus(to, dir === "left" || dir === "right" ? "x" : "y");
    this.trail = from ? { from, to, dir } : null;
  }
  /** the first thing of the page that is wholly on screen, as the page reads; else the first that shows at all */
  inSight(): HTMLElement | null {
    const top = pageTop();
    const page = this.candidates().filter(e => !e.closest(FIXED)).map(e => [e, e.getBoundingClientRect()] as const).filter(([, r]) => r.bottom > top + 4 && r.top < sightBottom() - 4);
    const whole = page.filter(([, r]) => r.top >= top - 2 && r.bottom <= sightBottom() + 2);
    const read = (a: readonly [HTMLElement, DOMRect], b: readonly [HTMLElement, DOMRect]) => (Math.abs(a[1].top - b[1].top) > 12 ? a[1].top - b[1].top : a[1].left - b[1].left);
    return ((whole.length ? whole : page).sort(read)[0]?.[0]) ?? null;
  }
  /** show where the focus is (the pad was picked up again): on what has it when that is on screen, else on what is */
  show() {
    const cur = this.current;
    if (!cur || !cur.isConnected || !this.layer().contains(cur) || !usable(cur, false)) { this.land(); return; }
    if (this.layer() === document && outOfSight(cur)) { const seen = this.inSight(); if (seen) { this.refocus(seen, false); return; } }
    this.mark(cur);
  }
  /** what had the focus before what has it now (a panel that takes the focus as it opens is closed back onto this) */
  before: HTMLElement | null = null;
  /** where the focus last stood in its page (not in the window): a thing that goes away hands the focus to what is nearest there */
  private stood: { x: number; y: number; fixed: boolean } | null = null;
  private note(el: HTMLElement | null) {
    if (!el) return;
    const r = el.getBoundingClientRect(), fixed = !!el.closest(FIXED + ", .bs-layer, .overlay, .tb-panel");
    this.stood = { x: r.left + r.width / 2 + (fixed ? 0 : scrollX), y: r.top + r.height / 2 + (fixed ? 0 : scrollY), fixed };
  }
  /** what had the focus is gone (Accept, once pressed; a row that left its list): the focus goes to what is nearest to where it
   *  stood, so the next press starts from there and A is never pressed on nothing. True when it had to */
  heal(): boolean {
    const cur = this.current, layer = this.layer();
    if (cur && cur.isConnected && layer.contains(cur) && usable(cur, false)) return false;
    const c = this.candidates(), at = this.stood;
    if (!c.length || !at) { this.land(); return true; }
    let best: HTMLElement | null = null, bd = Infinity;
    for (const e of c) {
      const r = e.getBoundingClientRect(), fixed = !!e.closest(FIXED + ", .bs-layer, .overlay, .tb-panel");
      const d = Math.hypot(r.left + r.width / 2 + (fixed ? 0 : scrollX) - at.x, r.top + r.height / 2 + (fixed ? 0 : scrollY) - at.y) + (fixed === at.fixed ? 0 : 2000);
      if (d < bd) { bd = d; best = e; }
    }
    this.current?.classList.remove("f");
    if (this.current) this.before = this.current;
    this.current = null;
    this.focus(best, true);
    return true;
  }
  focus(el: HTMLElement | null, scroll: boolean | "x" | "y" = true) {
    if (this.current === el) return;
    if (this.current) this.before = this.current;
    super.focus(el, false);                                  // the engine's own books: what is current, where it was
    this.note(el);
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
    // the page put the focus on a heading (Settings, on the section just chosen: for whoever listens to the page): the pad
    // goes on to the first thing under that heading it can press
    if (/^H[1-6]$/.test(target.tagName)) {
      const part = target.closest("section, [role='region']");
      const first = part ? this.candidates().filter(e => part.contains(e)).map(e => [e, e.getBoundingClientRect()] as const)
        .sort((a, b) => (Math.abs(a[1].top - b[1].top) > 12 ? a[1].top - b[1].top : a[1].left - b[1].left))[0]?.[0] : null;
      if (first) { this.trail = null; this.refocus(first, true); }
      return;
    }
    // a group that walks itself handed the focus to another of its members (the fan turned): the way back out of it stays
    const t = this.trail, was = this.current;
    const group = was?.closest(OWN_GROUP);
    this.trail = t && was && t.to === was && group && group === target.closest(OWN_GROUP) ? { ...t, to: target } : null;
    if (was) this.before = was;
    super.focus(target, false);
    this.note(target);
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
      ?? (layer === document ? mine.find(e => e.matches(".btn.primary.s48, .btn.primary.s44") && at.get(e)!.top < sightBottom()) : undefined)
      ?? mine[0] ?? c[0] ?? null;
    this.current?.classList.remove("f");
    if (this.current) this.before = this.current;
    this.current = null;
    this.focus(first);
  }
  /** put the focus on `el` even when the engine thinks it is there already (a sheet closed over it) */
  refocus(el: HTMLElement | null, scroll: boolean | "x" | "y" = false) {
    this.current?.classList.remove("f");
    if (this.current) this.before = this.current;
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

/**
 * Big screen — the mode. It is the app itself, as it is: the same top bar, the same pages, the same buttons. What the
 * mode adds is the couch: the whole display, everything larger, and a pad (or the arrow keys) moving a focus over the page
 * as a mouse would hover and click it (pad.ts, index.tsx).
 *
 *   the whole display   natively in the launcher (so Esc stays the page's key); the page's own fullscreen in a browser,
 *                       where leaving fullscreen leaves the mode
 *   larger              the launcher zooms the page (feature "zoom") so the window is ZOOM_LINES lines tall, whatever the
 *                       display: a 1080p television shows the app as a 1280 × 720 window does, at 1.5 times the size. It is
 *                       the browser's own zoom: the page lays itself out for the smaller window, and nothing is scaled by
 *                       CSS (a CSS zoom leaves every viewport unit and media query measuring the unzoomed window)
 *   in the hands        a handheld PC's screen (inHands) shows HAND_LINES lines instead: the same app a fifth larger again,
 *                       for a 7 inch display read at arm's length and touched. The person can pick either size themselves
 *                       (Settings → This PC, kept for this device), and such a device opens in the big screen by itself.
 *                       The launcher says what a page cannot see (feature "display", 0.14): the display's real size and
 *                       whether it is the PC's own panel, so a handheld is known at any scale of Windows, and is not
 *                       taken for one in its dock; an older launcher leaves the page to what it sees itself
 *   smaller             a display with fewer points than the lines to show (1080 lines at 200% are 540) gets the page
 *                       zoomed out, where the launcher can (feature "zoom-out", 0.14); else the page stays at its own size
 *   on or off          one switch for the whole app, kept for the window's session (a reload stays big); /big turns it on
 *                       (the launcher's pad button and its --big start go there), F11 and the account menu flip it
 */
import { launcher } from "../launcher";

/** the height, in the page's own pixels, the zoomed window has: across the room (a television, a monitor), and in the hands */
export const ZOOM_LINES = 720;
export const HAND_LINES = 600;
/** how far the page is ever zoomed (a display of 2160 lines gives 3), and how far out where the launcher can zoom out */
const ZOOM_MAX = 4;
export const ZOOM_OUT = 0.5;
const KEY = "ahoy.big";
/** kept for this device (the launcher's own profile): the size the person picked, and whether Ahoy opens in the big screen */
const SIZE_KEY = "ahoy.big.size", START_KEY = "ahoy.big.start";
/** kept for the window's session: the big screen was already opened by itself once (leaving it is then the person's word) */
const AUTO_KEY = "ahoy.big.auto";

/** the zoom that makes a display `height` pixels tall (unzoomed) show `lines` of them; never under `min`: the page's own size,
 *  unless the launcher zooms out too (ZOOM_OUT) */
export const zoomFor = (height: number, lines = ZOOM_LINES, min = 1): number => (Number.isFinite(height) && height > 0 ? Math.round(Math.min(ZOOM_MAX, Math.max(min, height / lines)) * 100) / 100 : 1);

/** how large the big screen is: by the display it is on, as across the room, or as in the hands */
export type BigSize = "auto" | "standard" | "large";
export const BIG_SIZES: readonly BigSize[] = ["auto", "standard", "large"];
/** what is known of the display the window is on: its height in Windows' own scaled points, whether the PC has a touch
 *  screen, and whether the display is built into the PC (null: nobody says; a page can only ask over https). The launcher
 *  knows more (Known): the display's real size, `inches` across its diagonal, and the size of the PC's own panel whichever
 *  display the window is on (`panel`); absent or null where no launcher says */
export interface Display { lines: number; touch: boolean; internal: boolean | null; inches?: number | null; panel?: number | null }
/** what the launcher says of the display (its display(), its event "display"; launcher/src/display.ts) */
export interface Known { internal: boolean | null; inches: number | null; panel: number | null }
/** the launcher's word, as far as it can be taken at it: anything that is not a size is no size (null: it said nothing) */
export function knownDisplay(raw: unknown): Known | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const size = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);
  return { internal: typeof r.internal === "boolean" ? r.internal : null, inches: size(r.inches), panel: size(r.panel) };
}
/** under this diagonal a built-in display is held in the hands (handhelds are 7 to 8.8 inches; the smallest laptops 10.1,
 *  which a monitor that rounds its size down to whole centimetres gives as 9.7). The launcher's setup page has the same */
export const HAND_INCHES = 9.5;
/** the tallest a display held in the hands is, in Windows' scaled points (7 to 9 inches: 1080 lines at 150%, 1200 at 150%,
 *  1600 at 200%, 800 at 100%) */
const HAND_MAX = 800;
/**
 * Is this a screen held in the hands (a handheld PC)? Windows scales so small a display far less than its size asks for: a 7
 * inch 1920 × 1080 one at 150% has 1280 × 720 points across 15 cm, each half the size a laptop's are. The app as a 1280 × 720
 * window reads there about as it does on a television from across the room, but it is held at arm's length and touched: text
 * of 13 comes out 1.6 mm tall, a 44 button 5 mm.
 *   measured     the launcher says the display is built in and how large it is: under HAND_INCHES it is in the hands, at any
 *                scale of Windows (150% is only what a handheld ships with), touch screen or not
 *   plugged in   a display known to be an external one never is (the handheld in its dock, on a television)
 *   else         a PC with a touch screen whose display is at most 800 points tall (all a page can see by itself)
 */
export const inHands = (d: Display): boolean => {
  if (d.internal === false) return false;
  if (d.internal === true && d.inches != null && d.inches > 0) return d.inches < HAND_INCHES;
  return d.touch && d.lines > 0 && d.lines <= HAND_MAX;
};
/** the lines the big screen shows: the person's own pick when they made one, else by the display */
export const linesFor = (size: BigSize, d: Display): number => (size === "large" ? HAND_LINES : size === "standard" ? ZOOM_LINES : inHands(d) ? HAND_LINES : ZOOM_LINES);
/** does Ahoy open in the big screen by itself? The person's own choice for this device when they made one; else on a handheld,
 *  whatever it is plugged into (in its dock it is still driven by its pad): a PC whose own panel the launcher measured as one
 *  held in the hands; where no launcher says, a PC with a touch screen and a short display */
export const startsBig = (choice: boolean | null, d: Display): boolean => choice ?? (d.panel != null && d.panel > 0 ? d.panel < HAND_INCHES : inHands({ ...d, internal: null, inches: null }));

/**
 * How far the window hangs over its display's right and bottom edges, in the page's own pixels. The launcher's window is
 * never smaller than its own minimum (980 × 640 of Windows' points, up to launcher 0.13), not even when it takes the whole
 * display: on a display smaller than that (1080 lines at Windows' 175% are 617 points, at 200% 540) the window stays 646
 * tall, and what the page puts along its bottom edge is cut off by the screen's (the hint line, 2026-11-23, on the handheld
 * the 600 lines were for). Nothing while the window is not on the whole display, or fits it.
 *   outer    the window in Windows' points (a page's zoom does not change it; on the whole display it has no frame)
 *   inner    the same window in the page's pixels
 *   screen   its display in Windows' points
 */
export function overhang(w: { outer: readonly [number, number]; inner: readonly [number, number]; screen: readonly [number, number] }): { right: number; bottom: number } {
  const [ow, oh] = w.outer, [iw, ih] = w.inner, [sw, sh] = w.screen;
  if (!(ow > 0 && oh > 0 && iw > 0 && ih > 0 && sw > 0 && sh > 0) || ow < sw - 1 || oh < sh - 1) return { right: 0, bottom: 0 };
  // (under two points is a rounding of the display's scale, not a window too large)
  const px = (over: number, outer: number, inner: number) => (over >= 2 ? Math.ceil(over * inner / outer) : 0);
  return { right: px(ow - sw, ow, iw), bottom: px(oh - sh, oh, ih) };
}

const nativeFull = !!launcher?.features?.includes("fullscreen");
const nativeZoom = !!launcher?.features?.includes("zoom") && !!launcher?.zoom;
/** the smallest zoom to ask for: a launcher before 0.14 answers a zoom under 1 with 1, and the page would keep asking */
const zoomMin = nativeZoom && launcher?.features?.includes("zoom-out") ? ZOOM_OUT : 1;
const nativeDisplay = !!launcher?.features?.includes("display") && !!launcher?.display;

/**
 * The page's zoom, kept in step with what the mode wants. The launcher keeps a page's zoom across a reload, and the page
 * does not know it afterwards (it starts again from nothing): so until this page has set a zoom itself, it does not know
 * the zoom (`null`), and never takes it to be 1. That was the fault of 2026-11-11: a page reloaded while big (F5, or the
 * launcher reloading for a new build of the server) believed its zoom was 1, so leaving the big screen set nothing, and
 * the app stayed at the television's size in its window.
 *   leaving   always sets 1, whatever this page believes
 *   big       not known yet: first 1 (only at its own size does the window's height say what the display is; the resize
 *             that follows fits again); known: the zoom that makes the window ZOOM_LINES tall
 */
export class Zoomer {
  private zoom: number | null = null;
  /** `lines`: how many of the page's lines the display is to show (asked each time: the person may change the size, the
   *  window its display). `min`: the smallest zoom the launcher grants (1 before 0.14) */
  constructor(private set: (factor: number) => unknown, private height: () => number, private lines: () => number = () => ZOOM_LINES, private min = 1) {}
  /** what one of the display's pixels is in the page's, as far as this page knows (1 until it has set one) */
  get factor() { return this.zoom ?? 1; }
  fit(on: boolean) {
    if (!on) { this.zoom = 1; this.set(1); return; }
    if (this.zoom == null) { this.zoom = 1; this.set(1); return; }
    const want = zoomFor(this.height() * this.zoom, this.lines(), this.min);
    // (a hundredth is not worth another turn: the page's height is whole pixels, and two zooms a hundredth apart could
    // hand it back and forth for ever)
    if (Math.abs(want - this.zoom) < 0.015) return;
    this.zoom = want;
    this.set(want);
  }
}

const read = () => { try { return sessionStorage.getItem(KEY) === "1"; } catch { return false; } };
let on = typeof sessionStorage === "undefined" ? false : read();
const kept = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const keep = (key: string, value: string | null) => { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode: for this page only */ } };
let size: BigSize = BIG_SIZES.find(s => s === kept(SIZE_KEY)) ?? "auto";
let startChoice: boolean | null = kept(START_KEY) === "1" ? true : kept(START_KEY) === "0" ? false : null;
/** is the window's display built into the PC? Not known until the browser says (learnDisplay), and never over plain http */
let internal: boolean | null = null;
/** what the launcher says of the display (null: not yet, or a launcher that does not) */
let known: Known | null = null;
/** the display the window is on (window.screen follows the window; its height is not changed by the page's zoom). The
 *  launcher's word of where it is wired comes before the browser's */
const display = (): Display => ({ lines: typeof screen === "undefined" ? 0 : screen.height, touch: typeof navigator !== "undefined" && navigator.maxTouchPoints > 0, internal: known?.internal ?? internal, inches: known?.inches ?? null, panel: known?.panel ?? null });
/** how far the window hangs over its display (overhang), kept for the page's styles as --cut-r and --cut-b on <html> */
let cut = { right: 0, bottom: 0 };
// (the lines are counted in what the display shows of the window, not in what hangs over its edge)
const zoomer = new Zoomer(f => { void launcher!.zoom!(f).catch(() => {}); }, () => innerHeight - cut.bottom, () => linesFor(size, display()), zoomMin);
const subs = new Set<() => void>();
const tell = () => { for (const f of subs) f(); };
/** measure the overhang again (the window changed, or the mode did): only the big screen in the launcher has one to mind */
function measure() {
  const now = on && nativeFull && typeof screen !== "undefined"
    ? overhang({ outer: [outerWidth, outerHeight], inner: [innerWidth, innerHeight], screen: [screen.width, screen.height] }) : { right: 0, bottom: 0 };
  if (now.right === cut.right && now.bottom === cut.bottom) return;
  cut = now;
  const style = document.documentElement.style;
  if (cut.right) style.setProperty("--cut-r", `${cut.right}px`); else style.removeProperty("--cut-r");
  if (cut.bottom) style.setProperty("--cut-b", `${cut.bottom}px`); else style.removeProperty("--cut-b");
}

/**
 * Learn which display the window is on, and again when the window moves to another.
 *   the launcher   (feature "display") says it for certain: the answer comes at once, and an event when it changes. The
 *                  promise is its first answer (settled at once where no launcher says): what the page decides by the display
 *                  when it loads waits for it
 *   the browser    can say whether the display is built in. Only in the launcher (a browser would ask the person for a
 *                  permission), and only where a page may ask (https, or the PC's own address): the fallback of older launchers
 */
function learnDisplay(): Promise<void> {
  let first: Promise<void> = Promise.resolve();
  if (nativeDisplay) {
    const take = (raw: unknown) => { const next = knownDisplay(raw); if (JSON.stringify(next) === JSON.stringify(known)) return; known = next; fit(); tell(); };
    launcher!.onEvent(e => { if (e.type === "display") take(e.display); });
    first = launcher!.display!().then(take, () => { /* it does not say: by what the page sees */ });
  }
  learnFromBrowser();
  return first;
}
function learnFromBrowser() {
  const ask = (globalThis as { getScreenDetails?: () => Promise<{ currentScreen: { isInternal?: boolean }; addEventListener(type: string, f: () => void): void }> }).getScreenDetails;
  if (!launcher || typeof ask !== "function") return;
  void ask.call(globalThis).then(details => {
    const take = () => { const now = details.currentScreen?.isInternal; const was = internal; internal = typeof now === "boolean" ? now : null; if (internal !== was) { fit(); tell(); } };
    take();
    details.addEventListener("currentscreenchange", take);
  }).catch(() => { /* not allowed, or not there: by the touch screen and the size alone */ });
}

/** is the big screen at the handheld's size right now (HAND_LINES of the page on the display: the launcher zooms it)? */
const inHandsNow = () => on && nativeZoom && linesFor(size, display()) === HAND_LINES;
/** the page zoomed so the window is ZOOM_LINES tall; again whenever the window's real size changes (another display) */
function fit() {
  measure();
  if (nativeZoom) zoomer.fit(on);
  // the pages lay their walls out for a handheld's width under this mark (big.css)
  if (typeof document !== "undefined") { if (inHandsNow()) document.documentElement.dataset.hands = ""; else delete document.documentElement.dataset.hands; }
}
let fitTimer = 0;
const onResize = () => { clearTimeout(fitTimer); fitTimer = window.setTimeout(fit, 150); };
/** a browser's own way out of fullscreen (Esc) leaves the mode with it */
const onFullscreenChange = () => { if (on && !nativeFull && !document.fullscreenElement) bigMode.leave(); };

function apply() {
  const html = document.documentElement;
  if (on) html.dataset.big = ""; else delete html.dataset.big;
  if (nativeFull) void launcher!.fullscreen!(on).catch(() => {});
  else if (on && !document.fullscreenElement) html.requestFullscreen?.().catch(() => { /* no gesture (a reload): big, in the window */ });
  else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (on) { addEventListener("resize", onResize); document.addEventListener("fullscreenchange", onFullscreenChange); }
  else { removeEventListener("resize", onResize); document.removeEventListener("fullscreenchange", onFullscreenChange); }
  // the launcher's fullscreen changes the window's size a moment later: the zoom follows the resize, and is set at once too
  fit(); onResize();
}

export const bigMode = {
  get on() { return on; },
  /** the page's zoom in the launcher (1 elsewhere): what one of the display's pixels is in the page's */
  get zoom() { return nativeZoom ? zoomer.factor : 1; },
  /** how much of the window's right and bottom the display does not show, in the page's pixels (overhang) */
  get cut() { return cut; },
  /** can the size be chosen here (the launcher zooms the page), and can Ahoy open in the big screen by itself (the launcher
   *  takes the whole display without a gesture)? */
  get sizable() { return nativeZoom; },
  get startable() { return nativeFull; },
  /** the size the person picked for this device ("auto": by the display), and the lines that comes to on this display */
  get size() { return size; },
  get lines() { return linesFor(size, display()); },
  /** is it at the handheld's size (the pages' walls are laid out for that width)? */
  get hands() { return inHandsNow(); },
  /** is the window on a handheld's own display (whatever size was picked for it)? Its only controls are its pad and its screen */
  get inHands() { return inHands(display()); },
  setSize(next: BigSize) { if (!BIG_SIZES.includes(next) || next === size) return; size = next; keep(SIZE_KEY, next === "auto" ? null : next); fit(); tell(); },
  /** does Ahoy open in the big screen on this device (the person's choice, else by the display)? */
  get startsBig() { return startsBig(startChoice, display()); },
  setStartsBig(next: boolean) { startChoice = !!next; keep(START_KEY, next ? "1" : "0"); tell(); },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  enter() { if (on) return; on = true; try { sessionStorage.setItem(KEY, "1"); } catch { /* private mode */ } apply(); tell(); },
  leave() { if (!on) return; on = false; try { sessionStorage.removeItem(KEY); } catch { /* private mode */ } apply(); tell(); },
  toggle() { if (on) bigMode.leave(); else bigMode.enter(); },
  /** the page loaded: a window that was big is big again; one that was not is at its own size (the launcher keeps a page's
   *  zoom, and this page does not know it: Zoomer) */
  start() {
    const learnt = learnDisplay();
    // a device that opens in the big screen does so once per run of the launcher: after that, leaving it is the person's
    // word, and a reload (F5, a new build of the server) keeps what they left it at
    let first = false;
    try { first = nativeFull && sessionStorage.getItem(AUTO_KEY) == null; if (first) sessionStorage.setItem(AUTO_KEY, "1"); } catch { /* private mode: never by itself */ }
    if (on) { apply(); return; }
    if (!first) { fit(); return; }
    // decided once the launcher has said which display this is (by the page's own eyes a television can pass for a
    // handheld); an older launcher is not asked, and the page decides at once, as it did
    void learnt.then(() => { if (!on && startsBig(startChoice, display())) bigMode.enter(); else fit(); });
  },
};

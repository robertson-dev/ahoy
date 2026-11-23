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
 *                       (Settings → This PC, kept for this device), and such a device opens in the big screen by itself
 *   on or off          one switch for the whole app, kept for the window's session (a reload stays big); /big turns it on
 *                       (the launcher's pad button and its --big start go there), F11 and the account menu flip it
 */
import { launcher } from "../launcher";

/** the height, in the page's own pixels, the zoomed window has: across the room (a television, a monitor), and in the hands */
export const ZOOM_LINES = 720;
export const HAND_LINES = 600;
/** how far the page is ever zoomed (a display of 2160 lines gives 3) */
const ZOOM_MAX = 4;
const KEY = "ahoy.big";
/** kept for this device (the launcher's own profile): the size the person picked, and whether Ahoy opens in the big screen */
const SIZE_KEY = "ahoy.big.size", START_KEY = "ahoy.big.start";
/** kept for the window's session: the big screen was already opened by itself once (leaving it is then the person's word) */
const AUTO_KEY = "ahoy.big.auto";

/** the zoom that makes a display `height` pixels tall (unzoomed) show `lines` of them; never smaller than the page is */
export const zoomFor = (height: number, lines = ZOOM_LINES): number => (Number.isFinite(height) && height > 0 ? Math.round(Math.min(ZOOM_MAX, Math.max(1, height / lines)) * 100) / 100 : 1);

/** how large the big screen is: by the display it is on, as across the room, or as in the hands */
export type BigSize = "auto" | "standard" | "large";
export const BIG_SIZES: readonly BigSize[] = ["auto", "standard", "large"];
/** what a page can tell of the display its window is on: its height in Windows' own scaled points, whether the PC has a touch
 *  screen, and whether the display is built into the PC (null: the page cannot tell; only a page served over https can) */
export interface Display { lines: number; touch: boolean; internal: boolean | null }
/** the tallest a display held in the hands is, in Windows' scaled points (7 to 9 inches: 1080 lines at 150%, 1200 at 150%,
 *  1600 at 200%, 800 at 100%) */
const HAND_MAX = 800;
/**
 * Is this a screen held in the hands (a handheld PC)? Windows scales so small a display far less than its size asks for: a 7
 * inch 1920 × 1080 one at 150% has 1280 × 720 points across 15 cm, each half the size a laptop's are. The app as a 1280 × 720
 * window reads there about as it does on a television from across the room, but it is held at arm's length and touched: text
 * of 13 comes out 1.6 mm tall, a 44 button 5 mm. A PC with a touch screen whose display is at most 800 points tall counts,
 * unless that display is known to be an external one (the handheld in its dock, on a television).
 */
export const inHands = (d: Display): boolean => d.touch && d.internal !== false && d.lines > 0 && d.lines <= HAND_MAX;
/** the lines the big screen shows: the person's own pick when they made one, else by the display */
export const linesFor = (size: BigSize, d: Display): number => (size === "large" ? HAND_LINES : size === "standard" ? ZOOM_LINES : inHands(d) ? HAND_LINES : ZOOM_LINES);
/** does Ahoy open in the big screen by itself? The person's own choice for this device when they made one; else on a PC with
 *  a touch screen and a small display, whatever it is plugged into (the handheld in its dock is still driven by its pad) */
export const startsBig = (choice: boolean | null, d: Display): boolean => choice ?? inHands({ ...d, internal: null });

const nativeFull = !!launcher?.features?.includes("fullscreen");
const nativeZoom = !!launcher?.features?.includes("zoom") && !!launcher?.zoom;

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
   *  window its display) */
  constructor(private set: (factor: number) => unknown, private height: () => number, private lines: () => number = () => ZOOM_LINES) {}
  /** what one of the display's pixels is in the page's, as far as this page knows (1 until it has set one) */
  get factor() { return this.zoom ?? 1; }
  fit(on: boolean) {
    if (!on) { this.zoom = 1; this.set(1); return; }
    if (this.zoom == null) { this.zoom = 1; this.set(1); return; }
    const want = zoomFor(this.height() * this.zoom, this.lines());
    if (want === this.zoom) return;
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
/** the display the window is on (window.screen follows the window; its height is not changed by the page's zoom) */
const display = (): Display => ({ lines: typeof screen === "undefined" ? 0 : screen.height, touch: typeof navigator !== "undefined" && navigator.maxTouchPoints > 0, internal });
const zoomer = new Zoomer(f => { void launcher!.zoom!(f).catch(() => {}); }, () => innerHeight, () => linesFor(size, display()));
const subs = new Set<() => void>();
const tell = () => { for (const f of subs) f(); };

/** ask the browser which display the window is on, and again when the window moves to another. Only in the launcher (a
 *  browser would ask the person for a permission), and only where a page may ask (https, or the PC's own address) */
function learnDisplay() {
  const ask = (globalThis as { getScreenDetails?: () => Promise<{ currentScreen: { isInternal?: boolean }; addEventListener(type: string, f: () => void): void }> }).getScreenDetails;
  if (!launcher || typeof ask !== "function") return;
  void ask.call(globalThis).then(details => {
    const take = () => { const now = details.currentScreen?.isInternal; const was = internal; internal = typeof now === "boolean" ? now : null; if (internal !== was) { fit(); tell(); } };
    take();
    details.addEventListener("currentscreenchange", take);
  }).catch(() => { /* not allowed, or not there: by the touch screen and the size alone */ });
}

/** the page zoomed so the window is ZOOM_LINES tall; again whenever the window's real size changes (another display) */
function fit() {
  if (nativeZoom) zoomer.fit(on);
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
  /** can the size be chosen here (the launcher zooms the page), and can Ahoy open in the big screen by itself (the launcher
   *  takes the whole display without a gesture)? */
  get sizable() { return nativeZoom; },
  get startable() { return nativeFull; },
  /** the size the person picked for this device ("auto": by the display), and the lines that comes to on this display */
  get size() { return size; },
  get lines() { return linesFor(size, display()); },
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
    learnDisplay();
    // a device that opens in the big screen does so once per run of the launcher: after that, leaving it is the person's
    // word, and a reload (F5, a new build of the server) keeps what they left it at
    let first = false;
    try { first = nativeFull && sessionStorage.getItem(AUTO_KEY) == null; if (first) sessionStorage.setItem(AUTO_KEY, "1"); } catch { /* private mode: never by itself */ }
    if (first && !on && startsBig(startChoice, display())) { on = true; try { sessionStorage.setItem(KEY, "1"); } catch { /* private mode */ } apply(); tell(); return; }
    if (on) apply();
    else fit();
  },
};

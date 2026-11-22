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
 *   on or off           one switch for the whole app, kept for the window's session (a reload stays big); /big turns it on
 *                       (the launcher's pad button and its --big start go there), F11 and the account menu flip it
 */
import { launcher } from "../launcher";

/** the height, in the page's own pixels, the zoomed window has */
export const ZOOM_LINES = 720;
/** how far the page is ever zoomed (a display of 2160 lines gives 3) */
const ZOOM_MAX = 4;
const KEY = "ahoy.big";

/** the zoom that makes a display `height` pixels tall (unzoomed) show ZOOM_LINES of them; never smaller than the page is */
export const zoomFor = (height: number): number => (Number.isFinite(height) && height > 0 ? Math.round(Math.min(ZOOM_MAX, Math.max(1, height / ZOOM_LINES)) * 100) / 100 : 1);

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
  constructor(private set: (factor: number) => unknown, private height: () => number) {}
  /** what one of the display's pixels is in the page's, as far as this page knows (1 until it has set one) */
  get factor() { return this.zoom ?? 1; }
  fit(on: boolean) {
    if (!on) { this.zoom = 1; this.set(1); return; }
    if (this.zoom == null) { this.zoom = 1; this.set(1); return; }
    const want = zoomFor(this.height() * this.zoom);
    if (want === this.zoom) return;
    this.zoom = want;
    this.set(want);
  }
}

const read = () => { try { return sessionStorage.getItem(KEY) === "1"; } catch { return false; } };
let on = typeof sessionStorage === "undefined" ? false : read();
const zoomer = new Zoomer(f => { void launcher!.zoom!(f).catch(() => {}); }, () => innerHeight);
const subs = new Set<() => void>();
const tell = () => { for (const f of subs) f(); };

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
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  enter() { if (on) return; on = true; try { sessionStorage.setItem(KEY, "1"); } catch { /* private mode */ } apply(); tell(); },
  leave() { if (!on) return; on = false; try { sessionStorage.removeItem(KEY); } catch { /* private mode */ } apply(); tell(); },
  toggle() { if (on) bigMode.leave(); else bigMode.enter(); },
  /** the page loaded: a window that was big is big again; one that was not is at its own size (the launcher keeps a page's
   *  zoom, and this page does not know it: Zoomer) */
  start() {
    if (on) apply();
    else fit();
  },
};

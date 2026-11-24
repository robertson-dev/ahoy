/**
 * The big screen's own rules (bun test, in web/). It is the app as it is, larger and driven by a pad: what is tested here is
 * what the mode decides by itself. How far the page is zoomed for a display; which tab LB and RB go to; what a key of the
 * on-screen keyboard does to the text; and how a style rule that speaks of a hovering pointer is given a twin for the pad.
 * (How the focus moves over the real pages is toured in a window, with real keys: nothing here draws a page.)
 */
import { describe, expect, test } from "bun:test";
import "./harness";
import { HAND_INCHES, HAND_LINES, ZOOM_LINES, ZOOM_OUT, Zoomer, inHands, knownDisplay, linesFor, overhang, startsBig, zoomFor, type Display } from "../src/big/mode";
import { BIG_TABS, tabOf, tabStep, typeKey } from "../src/big/index";
import { hoverTwin, withoutHoverQuery } from "../src/big/hover";

describe("how far the page is zoomed", () => {
  test("so that the display shows 720 of the page's lines, whatever it is", () => {
    expect(ZOOM_LINES).toBe(720);
    expect(zoomFor(1080)).toBe(1.5);               // a 1080p television: the app as a 1280 x 720 window, half again as large
    expect(zoomFor(1440)).toBe(2);
    expect(zoomFor(2160)).toBe(3);
    expect(zoomFor(1200)).toBe(1.67);
  });
  test("never smaller than the page is, never past four times", () => {
    expect(zoomFor(720)).toBe(1);
    expect(zoomFor(600)).toBe(1);
    expect(zoomFor(4320)).toBe(4);
    for (const odd of [0, -5, NaN, Infinity]) expect(zoomFor(odd)).toBe(1);
  });
  test("smaller than the page is only where the launcher can zoom out (0.14): down to a half", () => {
    expect(ZOOM_OUT).toBe(0.5);
    expect(zoomFor(540, 720, ZOOM_OUT)).toBe(0.75);          // 1080 lines at Windows' 200%: the app as a 1280 x 720 window again
    expect(zoomFor(540, HAND_LINES, ZOOM_OUT)).toBe(0.9);    // the handheld at 200%: 1067 x 600, as at any other scale
    expect(zoomFor(617, HAND_LINES, ZOOM_OUT)).toBe(1.03);   // at 175%
    expect(zoomFor(300, 720, ZOOM_OUT)).toBe(0.5);           // never under a half
    expect(zoomFor(1080, 720, ZOOM_OUT)).toBe(1.5);          // a television is as it was
    expect(zoomFor(540, 720)).toBe(1);                       // an older launcher: the page's own size, as before
    for (const odd of [0, -5, NaN, Infinity]) expect(zoomFor(odd, 720, ZOOM_OUT)).toBe(1);
  });
});

describe("a screen held in the hands", () => {
  /** a display as the page sees it: its height in Windows' scaled points, a touch screen or not, built in or not (null: cannot tell) */
  const d = (lines: number, touch: boolean, internal: boolean | null = null): Display => ({ lines, touch, internal });
  test("is a touch screen at most 800 of Windows' points tall: the handhelds at the scale they ship with", () => {
    expect(inHands(d(720, true))).toBe(true);                // 7 inches, 1920 x 1080 at 150%
    expect(inHands(d(800, true))).toBe(true);                // 1920 x 1200 at 150%, 2560 x 1600 at 200%, 1280 x 800 at 100%
    expect(inHands(d(720, true, true))).toBe(true);          // and the browser says it is the PC's own display
  });
  test("not a television or a monitor, whatever the PC: no touch screen, a taller display, or one known to be plugged in", () => {
    expect(inHands(d(720, false))).toBe(false);              // a 1080p television at 150%
    expect(inHands(d(1080, true))).toBe(false);              // a touch laptop or monitor; the handheld at 100% too (Settings has the size)
    expect(inHands(d(864, true))).toBe(false);               // 1080 lines at 125%: an ordinary laptop's scale
    expect(inHands(d(720, true, false))).toBe(false);        // the handheld in its dock: this display is the television
    expect(inHands(d(0, true))).toBe(false);
  });
  test("shows 600 of the page's lines instead of 720: the same app, a fifth larger again", () => {
    expect(HAND_LINES).toBe(600);
    expect(linesFor("auto", d(720, true))).toBe(600);
    expect(linesFor("auto", d(720, false))).toBe(720);
    expect(zoomFor(720, linesFor("auto", d(720, true)))).toBe(1.2);    // 1920 x 1080 at 150%: the page lays out 1067 x 600
    expect(zoomFor(800, HAND_LINES)).toBe(1.33);
    expect(zoomFor(1080, HAND_LINES)).toBe(1.8);
    expect(zoomFor(540, HAND_LINES)).toBe(1);                // never smaller than the page is (200% on 1080 lines)
  });
  test("the person's own pick of a size wins over the display, either way", () => {
    expect(linesFor("large", d(1080, false))).toBe(600);     // a television, wanted larger
    expect(linesFor("standard", d(720, true))).toBe(720);    // a handheld, wanted as a television has it
    expect(linesFor("large", d(1080, true))).toBe(600);      // the handheld at 100%, which the display alone does not give away
  });
  test("opens in the big screen by itself, docked or not; the person's own choice wins", () => {
    expect(startsBig(null, d(720, true))).toBe(true);
    expect(startsBig(null, d(720, true, false))).toBe(true); // in its dock it is still driven by its pad
    expect(startsBig(null, d(720, false))).toBe(false);
    expect(startsBig(null, d(1080, true))).toBe(false);
    expect(startsBig(false, d(720, true))).toBe(false);
    expect(startsBig(true, d(1440, false))).toBe(true);
  });
});

describe("a display the launcher has measured (0.14)", () => {
  /** as above, with the launcher's word: built in or plugged in, the display's diagonal, the PC's own panel's */
  const m = (lines: number, touch: boolean, internal: boolean | null, inches: number | null, panel: number | null = internal ? inches : null): Display => ({ lines, touch, internal, inches, panel });
  test("a built-in display under about ten inches is in the hands at any scale of Windows, touch screen or not", () => {
    expect(HAND_INCHES).toBe(9.5);
    for (const lines of [540, 617, 720, 864, 1080]) expect(inHands(m(lines, true, true, 6.9))).toBe(true);   // 200%, 175%, 150%, 125%, 100%
    expect(inHands(m(1080, false, true, 6.9))).toBe(true);
    expect(inHands(m(1067, true, true, 8.8))).toBe(true);    // 2560 x 1600 on 8.8 inches at 150%: taller than 800 points
    expect(linesFor("auto", m(1080, true, true, 6.9))).toBe(600);
    expect(zoomFor(1080, linesFor("auto", m(1080, true, true, 6.9)))).toBe(1.8);   // at 100%: the same 1067 x 600
  });
  test("a larger built-in display is not, however short and touched", () => {
    expect(inHands(m(768, true, true, 13.9))).toBe(false);   // a small touch laptop: the page alone took it for a handheld
    expect(inHands(m(800, true, true, 9.7))).toBe(false);    // 10.1 inches, as its monitor rounds it down
    expect(linesFor("auto", m(768, true, true, 13.9))).toBe(720);
  });
  test("a display that is plugged in is not: the handheld in its dock, over plain http too", () => {
    expect(inHands(m(720, true, false, 72.3, 6.9))).toBe(false);
    expect(inHands(m(720, true, false, null, 6.9))).toBe(false);
    expect(linesFor("auto", m(720, true, false, 72.3, 6.9))).toBe(720);
  });
  test("where the launcher could not measure it, the page's own rule stands", () => {
    expect(inHands(m(720, true, true, null))).toBe(true);
    expect(inHands(m(720, true, null, null))).toBe(true);
    expect(inHands(m(1080, true, true, null))).toBe(false);
    expect(inHands(m(720, false, null, null))).toBe(false);
  });
  test("opens in the big screen where the PC's own panel is a handheld's, whichever display the window is on", () => {
    expect(startsBig(null, m(1080, true, true, 6.9))).toBe(true);            // the handheld at 100%
    expect(startsBig(null, m(1440, false, false, 72.3, 6.9))).toBe(true);    // in its dock, on a television of any size and scale
    expect(startsBig(null, m(768, true, true, 13.9))).toBe(false);           // the touch laptop
    expect(startsBig(null, m(720, true, false, 72.3, null))).toBe(true);     // no panel known: the page's own rule, as before
    expect(startsBig(null, m(1440, false, false, 31.5, null))).toBe(false);
    expect(startsBig(false, m(720, true, true, 6.9))).toBe(false);           // the person's own choice still wins
  });
  test("the launcher's word is taken only as far as it is one", () => {
    expect(knownDisplay({ internal: true, mm: { width: 150, height: 90 }, inches: 6.9, panel: 6.9, points: { width: 1280, height: 720 }, scale: 1.5 })).toEqual({ internal: true, inches: 6.9, panel: 6.9 });
    expect(knownDisplay({ internal: false, inches: null, panel: null })).toEqual({ internal: false, inches: null, panel: null });
    expect(knownDisplay({ internal: "yes", inches: "7", panel: -1 })).toEqual({ internal: null, inches: null, panel: null });
    expect(knownDisplay({ inches: 0, panel: NaN })).toEqual({ internal: null, inches: null, panel: null });
    for (const none of [null, undefined, "display", 7]) expect(knownDisplay(none)).toBeNull();
  });
});

describe("a display smaller than the launcher's smallest window", () => {
  // the launcher's window is at least 980 x 640 of Windows' points, also on the whole display (measured: 646 tall there)
  test("the window hangs over the display's bottom edge, and the page is told by how much of its own pixels", () => {
    // 1080 lines at Windows' 175%: a display of 1098 x 618 points, the window 1098 x 646
    expect(overhang({ outer: [1098, 646], inner: [1098, 646], screen: [1098, 618] })).toEqual({ right: 0, bottom: 28 });
    // the same window with the page zoomed 1.03: 28 points are 28 of 627 pixels
    expect(overhang({ outer: [1098, 646], inner: [1066, 627], screen: [1098, 618] })).toEqual({ right: 0, bottom: 28 });
    // at 200%: 960 x 540 points, the window 990 x 645
    expect(overhang({ outer: [990, 645], inner: [990, 645], screen: [960, 540] })).toEqual({ right: 30, bottom: 105 });
  });
  test("nothing while the window fits its display, or is a window on it", () => {
    expect(overhang({ outer: [1280, 720], inner: [1067, 600], screen: [1280, 720] })).toEqual({ right: 0, bottom: 0 });   // 150%: the whole display, exactly
    expect(overhang({ outer: [1281, 721], inner: [1067, 600], screen: [1280, 720] })).toEqual({ right: 0, bottom: 0 });   // a point of rounding is no overhang
    expect(overhang({ outer: [1292, 678], inner: [1280, 672], screen: [1280, 720] })).toEqual({ right: 0, bottom: 0 });   // a window above the taskbar
    expect(overhang({ outer: [1360, 860], inner: [1360, 860], screen: [1920, 1080] })).toEqual({ right: 0, bottom: 0 });
    expect(overhang({ outer: [0, 0], inner: [0, 0], screen: [0, 0] })).toEqual({ right: 0, bottom: 0 });
  });
  test("the lines are counted in what the display shows: 600 of them in 618 points, not in the window's 646", () => {
    const w = { zoom: 1 };
    const inner = () => Math.round(646 / w.zoom);            // the window stays 646 points tall, whatever the zoom
    const cut = () => overhang({ outer: [1098, 646], inner: [Math.round(1098 / w.zoom), inner()], screen: [1098, 618] }).bottom;
    const page = new Zoomer(f => { w.zoom = f; }, () => inner() - cut(), () => 600);
    page.fit(true); page.fit(true);
    expect(w.zoom).toBe(1.03);                               // (by the window's own height it was 1.08, and 46 pixels of the page were off the screen)
    page.fit(true); page.fit(true);
    expect(w.zoom).toBe(1.03);                               // and it rests there
    expect(inner() - cut()).toBeGreaterThanOrEqual(597);     // the display shows the page's 600 lines, give or take the rounding
  });
});

describe("the page's zoom follows the mode", () => {
  /** a launcher window on a 1080p display: its zoom stays across a reload, and the page's height is the window's over the zoom */
  function display(zoomNow = 1, lines = 1080) {
    const w = { zoom: zoomNow, set: [] as number[] };
    const z = () => new Zoomer(f => { w.zoom = f; w.set.push(f); }, () => Math.round(lines / w.zoom));
    return { w, z };
  }
  test("big: the display shows 720 of the page's lines; leaving puts the page back at its own size", () => {
    const { w, z } = display();
    const page = z();
    page.fit(true);                                  // not known yet: its own size first
    page.fit(true);                                  // the resize that follows: now the display's height is known
    expect(w.zoom).toBe(1.5);
    page.fit(true);                                  // and it stays there
    expect(w.set).toEqual([1, 1.5]);
    expect(page.factor).toBe(1.5);
    page.fit(false);
    expect(w.zoom).toBe(1);
  });
  test("a page reloaded while big knows nothing of the zoom the launcher kept: it is big again, and leaving still puts it back", () => {
    const { w, z } = display(1.5);                   // the launcher kept 1.5 from the page before the reload
    const page = z();
    expect(page.factor).toBe(1);                     // this page has set nothing yet
    page.fit(true); page.fit(true);
    expect(w.zoom).toBe(1.5);                        // big again, measured from the page's own size, not 1.5 on top of 1.5
    page.fit(false);
    expect(w.zoom).toBe(1);                          // (it stayed at 1.5 in the window, 2026-11-11)
  });
  test("a page that loads when the mode is off is put at its own size, whatever the launcher kept", () => {
    const { w, z } = display(2);
    z().fit(false);
    expect(w.zoom).toBe(1);
  });
  test("leaving sets the page's own size even when this page believes it is there already", () => {
    const { w, z } = display();
    const page = z();
    page.fit(false);
    w.zoom = 1.5;                                    // changed behind the page's back
    page.fit(false);
    expect(w.zoom).toBe(1);
  });
  test("the lines it shows are asked each time: a size picked while big takes effect at the next fit, and leaving is still 1", () => {
    const w = { zoom: 1, lines: 720 };                       // a handheld: 1080 lines at 150%
    let want = 720;
    const page = new Zoomer(f => { w.zoom = f; }, () => Math.round(w.lines / w.zoom), () => want);
    page.fit(true); page.fit(true);
    expect(w.zoom).toBe(1);                                  // 720 lines of a display 720 points tall
    want = 600; page.fit(true);
    expect(w.zoom).toBe(1.2);                                // the page now lays out 600 lines
    page.fit(true);
    expect(w.zoom).toBe(1.2);                                // and stays (600 x 1.2 is the same 720 points)
    want = 720; page.fit(true);
    expect(w.zoom).toBe(1);
    page.fit(false);
    expect(w.zoom).toBe(1);
  });
  test("a display with fewer points than the lines to show: zoomed out where the launcher can, at its own size where it cannot", () => {
    const w = { zoom: 1, lines: 540 };                       // 1080 lines at Windows' 200%
    const page = new Zoomer(f => { w.zoom = f; }, () => Math.round(w.lines / w.zoom), () => 600, ZOOM_OUT);
    page.fit(true); page.fit(true);
    expect(w.zoom).toBe(0.9);                                // the page lays out 600 lines
    page.fit(true);
    expect(w.zoom).toBe(0.9);                                // and stays
    page.fit(false);
    expect(w.zoom).toBe(1);
    const old = new Zoomer(f => { w.zoom = f; }, () => Math.round(w.lines / w.zoom), () => 600);
    old.fit(true); old.fit(true);
    expect(w.zoom).toBe(1);                                  // a launcher before 0.14 is never asked for less
  });
  test("another display: the zoom follows its height", () => {
    const w = { zoom: 1, lines: 1080 };
    const page = new Zoomer(f => { w.zoom = f; }, () => Math.round(w.lines / w.zoom));
    page.fit(true); page.fit(true);
    expect(w.zoom).toBe(1.5);
    w.lines = 2160; page.fit(true);
    expect(w.zoom).toBe(3);
    w.lines = 720; page.fit(true);
    expect(w.zoom).toBe(1);
  });
});

describe("the tabs LB and RB walk", () => {
  test("are the top bar's four, in its order, and every page belongs to one as the bar says", () => {
    expect([...BIG_TABS]).toEqual(["/", "/discover", "/library", "/people"]);
    expect(["/", "/discover", "/discover/list/top", "/steam/620", "/search", "/library", "/downloads", "/game/31", "/people", "/u/kay"].map(tabOf)).toEqual([0, 1, 1, 1, 1, 2, 2, 2, 3, 3]);
    expect(tabOf("/settings")).toBe(-1);
  });
  test("one step from the page's own tab, round the ends; from a page of no tab, to the first or the last", () => {
    expect(tabStep("/", 1)).toBe("/discover");
    expect(tabStep("/game/31", 1)).toBe("/people");
    expect(tabStep("/game/31", -1)).toBe("/discover");
    expect(tabStep("/people", 1)).toBe("/");
    expect(tabStep("/", -1)).toBe("/people");
    expect(tabStep("/settings", 1)).toBe("/");
    expect(tabStep("/settings", -1)).toBe("/people");
  });
});

describe("a key of the on-screen keyboard", () => {
  test("adds its letter, a space, takes the last one away, or clears", () => {
    expect(typeKey("hol", "l")).toBe("holl");
    expect(typeKey("hollow", "space")).toBe("hollow ");
    expect(typeKey("hollow", "back")).toBe("hollo");
    expect(typeKey("", "back")).toBe("");
    expect(typeKey("hollow knight", "clear")).toBe("");
    expect(typeKey("a", "'")).toBe("a'");
  });
});

describe("hovering without a mouse", () => {
  test("a rule that names :hover gets a twin that names the pad's mark, wherever in the selector", () => {
    expect(hoverTwin(".btn:hover")).toBe(".btn[data-hv]");
    expect(hoverTwin(".pc:hover .pc-act, .pc:focus-within .pc-act, .pc-act.shown")).toBe(".pc[data-hv] .pc-act, .pc:focus-within .pc-act, .pc-act.shown");
    expect(hoverTwin("a.fpill:hover, button.fpill:hover")).toBe("a.fpill[data-hv], button.fpill[data-hv]");
    expect(hoverTwin(".sel:hover select")).toBe(".sel[data-hv] select");
  });
  test("a rule without :hover has none, and a twin is not twinned again", () => {
    expect(hoverTwin(".btn")).toBeNull();
    expect(hoverTwin(".btn[data-hv]")).toBeNull();
    expect(hoverTwin(".a:hover .b[data-hv]")).toBeNull();
  });
  test("a rule kept for devices whose pointer hovers applies to the pad too", () => {
    expect(withoutHoverQuery("(hover: hover)")).toBe("all");
    expect(withoutHoverQuery("(min-width: 900px) and (hover:hover)")).toBe("(min-width: 900px) and all");
    expect(withoutHoverQuery("(any-hover: hover) and (pointer: fine)")).toBe("all and (pointer: fine)");
    expect(withoutHoverQuery("(max-width: 1279px)")).toBe("(max-width: 1279px)");
  });
});

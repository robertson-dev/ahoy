/**
 * The big screen's own rules (bun test, in web/). It is the app as it is, larger and driven by a pad: what is tested here is
 * what the mode decides by itself. How far the page is zoomed for a display; which tab LB and RB go to; what a key of the
 * on-screen keyboard does to the text; and how a style rule that speaks of a hovering pointer is given a twin for the pad.
 * (How the focus moves over the real pages is toured in a window, with real keys: nothing here draws a page.)
 */
import { describe, expect, test } from "bun:test";
import "./harness";
import { HAND_LINES, ZOOM_LINES, Zoomer, inHands, linesFor, startsBig, zoomFor, type Display } from "../src/big/mode";
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

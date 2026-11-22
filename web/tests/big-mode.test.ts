/**
 * The big screen's own rules (bun test, in web/). It is the app as it is, larger and driven by a pad: what is tested here is
 * what the mode decides by itself. How far the page is zoomed for a display; which tab LB and RB go to; what a key of the
 * on-screen keyboard does to the text; and how a style rule that speaks of a hovering pointer is given a twin for the pad.
 * (How the focus moves over the real pages is toured in a window, with real keys: nothing here draws a page.)
 */
import { describe, expect, test } from "bun:test";
import "./harness";
import { ZOOM_LINES, Zoomer, zoomFor } from "../src/big/mode";
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

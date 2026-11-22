/**
 * The Home fan's card switch (bun test, in web/): which cards are drawn as box art (boxOf), the device's own choice (?cards=boxart,
 * ?cards=cover or ?cards=fade, remembered until ?cards=recipe) and what a card request asks the server for, what the fan shows of a
 * side card (the room beside the next card, the span the
 * arrival crosses, the frame's bottom edge), and where a side card's tag goes (planTag: off the poster's lettering when it can).
 * The modules read the page's `window`, `location` and `localStorage` as they run, which bun has not: small stand-ins first.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { CardJson, PosterJson } from "../src/ui/fan";

let fan: typeof import("../src/ui/fan");
const store = new Map<string, string>();
const page = { search: "" };
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.location = page;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  fan = await import("../src/ui/fan");
});

const colour = { top: "#eb8a37", bottom: "#ea822a", base: "#eb8833", title: "#141414", status: "rgba(20,20,20,0.9)", ink: "ink", hue: 27.7, s: 0.82, l: 0.56, grey: false } as const;
const poster: PosterJson = { url: "/api/v1/art/game/24/poster?v=232807053834", w: 600, h: 900, colour };
const card = (kind: CardJson["art"]["kind"], p: PosterJson | null | undefined) =>
  ({ v: 1, id: 24, key: "k", status: "ready", retryAfter: null, title: "Batomon Showdown", card: { w: 384, h: 560, radius: 36 }, colour, alternates: [],
    art: { kind, url: null, w: 0, h: 0, source: null }, fan: [], ...(p === undefined ? {} : { poster: p }) }) as CardJson;

describe("which cards are box art", () => {
  test("a box-art server's cards always; the recipe's only when this device asks; never without a poster", () => {
    expect(fan.boxOf(card("poster", poster), false)).toBe(poster);
    expect(fan.boxOf(card("cut", poster), false)).toBeNull();
    expect(fan.boxOf(card("dissolve", poster), true)).toBe(poster);
    expect(fan.boxOf(card("cut", null), true)).toBeNull();            // no poster read (yet): the recipe's face
    expect(fan.boxOf(card("cut", undefined), true)).toBeNull();       // an older server: no poster block at all
    expect(fan.boxOf(null, true)).toBeNull();
  });
  test("the poster where the cut-out stood (cover, fade) is the recipe's face; box art only when this device asks for it", () => {
    expect(fan.boxOf(card("cover", poster), false)).toBeNull();
    expect(fan.boxOf(card("cover", poster), true)).toBe(poster);
  });
  test("?cards=cover and ?cards=fade ask the server for that card (?style=), remembered like box art; box art asks for the lettering", () => {
    store.clear();
    page.search = "";
    expect(fan.cardsWanted()).toBeNull();
    expect(fan.cardQuery()).toBe("");
    page.search = "?cards=cover";
    expect(fan.cardsWanted()).toBe("cover");
    expect(fan.cardQuery()).toBe("?style=cover");
    page.search = "";                                                  // another page of the app, no query
    expect(fan.cardQuery()).toBe("?style=cover");
    expect(fan.boxArtWanted()).toBe(false);
    page.search = "?cards=fade";
    expect(fan.cardQuery()).toBe("?style=fade");
    page.search = "?cards=boxart";
    expect(fan.cardQuery()).toBe("?text=1");
    expect(fan.boxArtWanted()).toBe(true);
    page.search = "?cards=sparkles";                                   // anything else changes nothing
    expect(fan.cardsWanted()).toBe("boxart");
    page.search = "?cards=recipe";                                     // the server's own cards again
    expect(fan.cardsWanted()).toBeNull();
    page.search = "";
    expect(fan.cardQuery()).toBe("");
  });
  test("the cover draws the poster inside its frame where the server put it: moved up and zoomed in the frame's own pixels", () => {
    const frame = { x: 32, y: 151, w: 320 };
    expect(fan.coverInner(frame, 600)).toBe("translate(0.00px, 0.00px) scale(1.00000)");          // an older server: the whole poster
    expect(fan.coverInner({ ...frame, img: { x: 32, y: 151, w: 320 } }, 600)).toBe("translate(0.00px, 0.00px) scale(1.00000)");
    // cut 234 units above the frame at 1.093x, centred: in the frame's pixels (600 / 320 a unit)
    expect(fan.coverInner({ ...frame, img: { x: 17.1, y: -83, w: 349.8 } }, 600)).toBe("translate(-27.94px, -438.75px) scale(1.09313)");
  });
  test("the fade's tint over a dark band: the card's colour at 30 % over the ramp, then smoothly to nothing", () => {
    const g = fan.tintOf("#8a6259", 0.5);
    expect(g.startsWith("linear-gradient(180deg, #8a62594d 0%, #8a62594d 50.00%, ")).toBe(true);
    expect(g.endsWith("#8a625900 100%)")).toBe(true);
    const alphas = [...g.matchAll(/#8a6259([0-9a-f]{2})/g)].map(m => parseInt(m[1], 16));
    expect(alphas).toEqual([...alphas].sort((a, b) => b - a));                                    // never darker further down
  });
  test("?cards=boxart turns it on and is remembered on this device; ?cards=recipe forgets it", () => {
    store.clear();
    page.search = "";
    expect(fan.boxArtWanted()).toBe(false);
    page.search = "?cards=boxart";
    expect(fan.boxArtWanted()).toBe(true);
    page.search = "";                                                  // another page of the app, no query
    expect(fan.boxArtWanted()).toBe(true);
    page.search = "?cards=recipe";
    expect(fan.boxArtWanted()).toBe(false);
    page.search = "";
    expect(fan.boxArtWanted()).toBe(false);
  });
});

describe("what the fan shows of a side card", () => {
  const room = (slot: number) => fan.tagRoom(slot, fan.TAG.inset, fan.TAG.inset + 36, fan.TAG.inset);
  test("the room beside the next card: mirrored left and right; the outer cards show more than the inner ones; never past the card", () => {
    const inset = fan.TAG.inset;
    expect(room(1)).toBe(room(3));
    expect(room(0)).toBe(room(4));
    expect(room(0)).toBeGreaterThan(room(1));
    for (const s of [0, 1, 3, 4]) {
      expect(room(s)).toBeGreaterThan(180);                            // a full status ("Arrived Tuesday · 2.4 GB") fits
      expect(room(s)).toBeLessThan(384 - 2 * inset);                   // the next card covers the rest
    }
  });
  test("the span a moving game's arrival crosses: from the outer edge to the next card, mirrored; all of the centre card", () => {
    expect(fan.shownSpan(2)).toEqual([0, 384]);
    for (const [l, r] of [[1, 3], [0, 4]]) {
      const [a0, a1] = fan.shownSpan(l), [b0, b1] = fan.shownSpan(r);
      expect(a0).toBe(0);
      expect(b1).toBe(384);
      expect(a1).toBe(384 - b0);
      expect(a1).toBeGreaterThan(200);                                 // the next card covers the inner 35-45 %
      expect(a1).toBeLessThan(260);
    }
  });
  test("the frame's bottom edge: an outer card shows less of its height than an inner one, mirrored", () => {
    expect(fan.foldAt(0, 18)).toBeCloseTo(256.9, 0);
    expect(fan.foldAt(1, 18)).toBeCloseTo(334.6, 0);
    expect(fan.foldAt(4, 366)).toBeCloseTo(fan.foldAt(0, 18), 6);
    expect(fan.foldAt(2, 0)).toBeCloseTo(415, 6);                      // the centre card: 960 - 545
  });
});

describe("the tag on a side card", () => {
  const W = (s: string, _weight: number, size: number) => s.length * size * 0.5;
  const moving = { name: "Endacopia", status: "Downloading · 48% · about 13 min left", short: "48% · about 13 min left", verb: "Cancel", bar: true };
  test("at the outer top corner when the poster has no lettering there", () => {
    const p = fan.planTag(3, moving, [], W);
    expect(p.top).toBe(fan.TAG.inset);
    expect(p.lines).toEqual(["Endacopia"]);
    expect(p.text).toBe(moving.short);                                  // the full state does not fit beside the next card
    expect(p.row).toBe(false);                                         // so the pill goes under it
    expect(p.h).toBe(2 * 10 + 20 + 2 + 18 + 8 + 8 + 36);
  });
  test("under the logo when it shows there, laid out for the room it has; at the top when nothing under the logo shows", () => {
    const logo = [12, 80, 371, 170];                                   // the Endacopia poster's, in card units
    const p = fan.planTag(3, moving, [logo], W);
    expect(p.top).toBe(172);                                           // the block's own padding is its clearance
    expect(p.top + p.h).toBeLessThanOrEqual(fan.foldAt(3, 366) - fan.TAG.foldGap);
    expect(p.room).toBeLessThan(fan.planTag(3, moving, [], W).room);   // lower down the next card leaves less room
    const big = [0, 24, 384, 259];                                     // DAVE THE DIVER: nothing under it shows on an outer card
    expect(fan.planTag(4, moving, [big], W).top).toBe(fan.TAG.inset);
    expect(fan.planTag(1, moving, [[300, 30, 384, 200]], W).top).toBe(fan.TAG.inset);   // lettering beside the tag is no reason to move
  });
  test("a long name takes two lines, broken after its colon when both fit, else where the longer line is shortest", () => {
    const w = (s: string) => s.length * 8;
    expect(fan.nameLines("Dispatch", 100, w)).toEqual(["Dispatch"]);
    expect(fan.nameLines("Hollow Knight: Silksong", 120, w)).toEqual(["Hollow Knight:", "Silksong"]);
    expect(fan.nameLines("Probably Stolen - Cyberpunk Heist", 150, w)).toEqual(["Probably Stolen -", "Cyberpunk Heist"]);
    expect(fan.nameLines("Probably Stolen Cyberpunk Heist", 150, w)).toEqual(["Probably Stolen", "Cyberpunk Heist"]);
    expect(fan.nameLines("MARVEL vs. CAPCOM Fighting Collection: Arcade Classics", 220, w)).toEqual(["MARVEL vs. CAPCOM Fighting", "Collection: Arcade Classics"]);
    // never before a number or a numeral, never next to an ampersand
    expect(fan.nameLines("DreamWorks Shrek 2 Remastered", 150, w)).toEqual(["DreamWorks", "Shrek 2 Remastered"]);
    expect(fan.nameLines("Command & Conquer Red Alert 3", 150, w)).toEqual(["Command & Conquer", "Red Alert 3"]);
    expect(fan.planTag(1, { ...moving, name: "Hollow Knight: Silksong Collector Edition Deluxe" }, [], W).lines).toHaveLength(2);
  });
});

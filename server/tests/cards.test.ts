/** cards: the Home fan's generated cards — the colour and ink rules, the recipe on real posters, the route contract with
 * and without the segmentation model, box art, the poster where the cut-out stood (cover, fade), a queue that never holds a
 * request up, a cache that follows the art, and the model's resumable download. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import * as C from "../src/cards/colour";
import { analyseArt, type ArtInput } from "../src/cards/recipe";
import { cardOptions, cardsInternals, getCard, stopCards } from "../src/cards";
import { FAN, FRAME, displayName, fanGeometry } from "../src/cards/layout";
import * as G from "../src/cards/geom";
import { jobStage, queueLength } from "../src/cards/queue";
import { fadeColours, keptLettering, posterColours, posterText } from "../src/cards/poster";
import { withLogo, type LogoMatch } from "../src/cards/lettering";
import { colourJson, layoutsJson, layoutsOf } from "../src/cards/build";
import { alphaAt, hiddenTo, letteringSeen, placeCover, placeFade, showGrid } from "../src/cards/place";
import { logoBox, sourceDeps } from "../src/cards/sources";
import { _modelTest, downloadResumable, ensureModel, modelDeps, modelPath, modelState, onModelReady } from "../src/cards/model";
import { game, http, setLibrary } from "./helpers";

// Most of these tests are the recipe's own card (the cut-out or the dissolve of the key art), which a server makes under
// CARD_STYLE=recipe since fade became the default; the describes for the other looks set theirs and put this one back.
process.env.CARD_STYLE ??= "recipe";

const FX = join(import.meta.dir, "fixtures", "cards");
const fx = (f: string) => join(FX, f);
const mask = (file: string) => async () => new Uint8Array(await sharp(fx(file)).greyscale().raw().toBuffer());
const sw = (hue: number, share: number, sat: number, chroma: number): C.Swatch => ({ hue, share, sat, chroma, light: 0.5 });
const legible = (c: C.CardColour) => c.contrast.title >= C.MIN_TEXT && c.contrast.status >= C.MIN_TEXT;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const original = { ...sourceDeps };
const image = (f: string, type = "image/jpeg") => ({ path: fx(f), type });

/** poll a card until `done` holds (the worker builds it in the background) */
async function until(id: number, done: (j: any) => boolean, ms: number) {
  const t0 = Date.now();
  for (;;) {
    const r = await http("GET", `/api/v1/art/game/${id}/card`);
    if (r.status === 200 && done(r.json)) return r;
    if (Date.now() - t0 > ms) throw new Error(`card ${id} not done in ${ms} ms: ${JSON.stringify(r.json).slice(0, 300)}`);
    await sleep(300);
  }
}

describe("the colour rule", () => {
  test("a vivid swatch: S follows its saturation, white text at the lightest legible L", () => {
    const c = C.cardColour({ swatches: [sw(217, 1, 0.9, 0.7)], meanChroma: 0.5 }, null, 0);
    expect(c.h).toBe(217);
    expect(c.s).toBe(0.82);                                  // 0.45 + 0.6 x 0.9, clamped to 0.82
    expect(c.ink).toBe("white");
    expect(c.l).toBeLessThanOrEqual(0.58);
    expect(c.l).toBeGreaterThanOrEqual(0.47);
    expect(legible(c)).toBe(true);
    expect(C.cardColour({ swatches: [sw(217, 1, 0.1, 0.4)], meanChroma: 0.5 }, null, 0).s).toBe(0.55);   // clamped up
  });
  test("a light hue: white cannot reach 4.7:1, so near-black ink near L 0.56", () => {
    const c = C.cardColour({ swatches: [sw(48, 1, 0.9, 0.7)], meanChroma: 0.5 }, null, 0);
    expect(c.ink).toBe("ink");
    expect(c.text).toBe("#141414");
    expect(c.status).toBe("rgba(20,20,20,0.9)");
    expect(c.l).toBe(0.56);
    expect(legible(c)).toBe(true);
  });
  test("every hue lands legible, its gradient inside L 0.45-0.65", () => {
    for (let h = 0; h < 360; h += 7.5) for (const sat of [0.2, 0.6, 1]) {
      const c = C.cardColour({ swatches: [sw(h, 1, sat, 0.5)], meanChroma: 0.4 }, null, 0);
      expect(legible(c)).toBe(true);
      for (const v of [c.top, c.bottom]) { const l = C.rgb2hsl(v[0], v[1], v[2])[2]; expect(l).toBeGreaterThanOrEqual(0.44); expect(l).toBeLessThanOrEqual(0.66); }
    }
  });
  test("grey art takes its strongest tint outside taupe and olive, at S 0.22", () => {
    const c = C.cardColour({ swatches: [sw(40, 0.6, 0.1, 0.05), sw(205, 0.4, 0.1, 0.05)], meanChroma: 0.04 }, null, 0);
    expect(c.grey).toBe(true);
    expect(c.s).toBe(0.22);
    expect(c.h).toBe(205);
    expect(legible(c)).toBe(true);
    // nothing outside 15-100 deg: the opposite of the strongest hue
    expect(C.cardColour({ swatches: [sw(60, 1, 0.1, 0.05)], meanChroma: 0.04 }, null, 0).h).toBe(240);
  });
  test("a greyish olive swatch steps aside", () => {
    const c = C.cardColour({ swatches: [sw(70, 0.7, 0.3, 0.1), sw(200, 0.3, 0.6, 0.3)], meanChroma: 0.2 }, null, 0);
    expect(c.h).toBe(200);
    expect(C.cardColour({ swatches: [sw(70, 0.7, 0.6, 0.3), sw(200, 0.3, 0.6, 0.3)], meanChroma: 0.2 }, null, 0).h).toBe(70);   // a vivid one stays
  });
  test("over a dark dissolve band, orange and gold yield to a cool or red swatch with >= 15 % of their weight", () => {
    const set = { swatches: [sw(40, 0.8, 0.7, 0.4), sw(210, 0.2, 0.7, 0.4)], meanChroma: 0.3 };
    expect(C.cardColour(set, 0.2, 0).h).toBe(210);
    expect(C.cardColour(set, 0.5, 0).h).toBe(40);            // a light band keeps the gold
    expect(C.cardColour({ swatches: [sw(40, 0.9, 0.7, 0.4), sw(210, 0.1, 0.7, 0.4)], meanChroma: 0.3 }, 0.2, 0).h).toBe(40);   // too weak to take over
  });
  test("alternates are the next swatches, in order", () => {
    const set = { swatches: [sw(10, 0.5, 0.7, 0.4), sw(120, 0.3, 0.7, 0.4), sw(250, 0.2, 0.7, 0.4)], meanChroma: 0.3 };
    expect([0, 1, 2].map(p => C.cardColour(set, null, p).h)).toEqual([10, 120, 250]);
    expect(C.cardColour(set, null, 0).options).toBe(3);
  });
  test("ink loses contrast under a neighbour's shadow; white does not", () => {
    const ink = C.cardColour({ swatches: [sw(48, 1, 0.9, 0.7)], meanChroma: 0.5 }, null, 0);
    expect(C.shadedContrast(ink, 0.3).title).toBeLessThan(ink.contrast.title);
    const white = C.cardColour({ swatches: [sw(217, 1, 0.9, 0.7)], meanChroma: 0.5 }, null, 0);
    expect(C.shadedContrast(white, 0.3).title).toBe(white.contrast.title);
  });
});

describe("the recipe on real posters (the boards' results)", () => {
  test("Batomon Showdown's poster: a dissolve in #eb5c33 with ink text", async () => {
    const an = await analyseArt({ poster: { kind: "poster", file: fx("batomon-poster.jpg") }, banner: null, logo: null, mask: null });
    expect(an.mode).toBe("dissolve");
    expect(C.hex(an.colour.base)).toBe("#eb5c33");
    expect(an.colour.h).toBe(13.5);
    expect(an.colour.ink).toBe("ink");
    expect(an.dissolve!.refPlace.score).toBeGreaterThan(0);
  }, 30_000);
  test("Balatro's poster with its mask: a cut-out on its backdrop's #3390eb, ink text", async () => {
    const an = await analyseArt({ poster: { kind: "poster", file: fx("balatro-poster.jpg") }, banner: null, logo: null, mask: mask("balatro-poster.mask.png") });
    expect(an.mode).toBe("cut");
    expect(an.colourPool).toBe("backdrop");
    expect(C.hex(an.colour.base)).toBe("#3390eb");
    expect(an.colour.ink).toBe("ink");
    expect(an.cut!.rings.length).toBeGreaterThan(0);
  }, 30_000);
  test("Hollow Knight's poster: the logo is found and the knight is cut above it; white text on #1766e6", async () => {
    const box = { x: 25, y: 91, w: 593, h: 222 };           // the logo's opaque pixels (alpha >= 16)
    const an = await analyseArt({ poster: { kind: "poster", file: fx("hollow-knight-poster.jpg") }, banner: null, logo: { file: fx("hollow-knight-logo.png"), box }, mask: mask("hollow-knight-poster.mask.png") });
    expect(an.mode).toBe("cut");
    expect(an.ranked[0].logo?.used).toBe(true);
    expect(an.ranked[0].letterCut).toBe(620);
    expect(C.hex(an.colour.base)).toBe("#1766e6");
    expect(an.colour.ink).toBe("white");
  }, 30_000);
  test("the poster wins a tie with the key art; untrusted key art is read for lettering", async () => {
    const poster: ArtInput = { kind: "poster", file: fx("batomon-poster.jpg") };
    const banner: ArtInput = { kind: "banner", file: fx("balatro-poster.jpg") };       // portrait, but enough to see the rule
    const an = await analyseArt({ poster, banner, logo: null, mask: null });
    expect(an.ranked.map(r => r.k)).toEqual(["poster", "banner"]);
    const read = an.ranked.find(r => r.k === "banner")!;
    expect(read.logoFree).toBe(read.letteringBlocks === 0);
  }, 30_000);
});

describe("the card route, model absent (the dissolve)", () => {
  const id = 9101, model = process.env.AHOY_CARD_MODEL;
  beforeAll(() => {
    delete process.env.AHOY_CARD_MODEL;                                    // <config>/models is empty and is never fetched in tests
    setLibrary([game(id, "Batomon Showdown")]);
    sourceDeps.poster = async (g) => (g.id === id ? image("batomon-poster.jpg") : null);
    sourceDeps.keyArt = async () => null;
    sourceDeps.logo = async () => null;
  });
  afterAll(() => { stopCards(); Object.assign(sourceDeps, original); if (model !== undefined) process.env.AHOY_CARD_MODEL = model; });

  test("answers at once with a pending card, then the built dissolve", async () => {
    expect(modelState()).toBe("missing");
    const t0 = Date.now();
    const first = await http("GET", `/api/v1/art/game/${id}/card`);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(first.status).toBe(200);
    expect(first.json.status).toBe("pending");
    expect(first.json.retryAfter).toBeGreaterThan(0);
    expect(first.json.art.kind).toBe("none");                              // a colour-only card until the art is made
    expect(first.json.colour.top).toMatch(/^#[0-9a-f]{6}$/);
    const r = await until(id, j => j.status === "ready", 60_000);
    const j = r.json;
    expect(j.v).toBe(1);
    expect(j.title).toBe("Batomon Showdown");
    expect(j.card).toEqual({ w: 384, h: 560, radius: 36 });
    expect(j.colour).toMatchObject({ base: "#eb5c33", title: "#141414", ink: "ink" });
    expect(j.art.kind).toBe("dissolve");
    expect(j.art.source).toBe("poster");
    expect(j.art.url).toBe(`/api/v1/art/game/${id}/card/art?v=${j.key}`);
    expect([j.art.w, j.art.h]).toEqual([600, 900]);
    // the free card (both pill widths) and the five fan slots, each with labels and the art under them
    for (const lay of [j.free, j.freeWide, ...j.fan.flatMap((f: any) => [f.row, f.under])]) {
      expect(lay.labels.title.lines.join(" ")).toBe("Batomon Showdown");
      expect(lay.art.kind).toBe("dissolve");
      expect(lay.art.fade.from).toBeGreaterThanOrEqual(lay.labels.bottom);
      expect(lay.art.fade.to).toBeGreaterThan(lay.art.fade.from);
      expect(lay.art.x).toBeLessThanOrEqual(0.1);
      expect(lay.art.x + lay.art.w).toBeGreaterThanOrEqual(383.9);      // the image covers the card
      expect(lay.art.y + lay.art.h).toBeGreaterThanOrEqual(559);
    }
    expect(j.fan.map((f: any) => [f.slot, f.rot, f.z])).toEqual([[-2, -10.5, 3], [-1, -5.5, 4], [0, 0, 5], [1, 5.5, 4], [2, 10.5, 3]]);
    expect(j.fan[2].row.labels.kind).toBe("top");
    expect(j.fan[0].row.labels.kind).toBe("side");
    expect(j.fan[0].row.labels.room.row).toBeGreaterThan(0);
    expect(j.fan[3].row.labels.align).toBe("right");
    // the box art rides along: the poster route (the one Discover and the Library use), its size, the colour of that art
    expect(j.poster.url).toMatch(new RegExp(`^/api/v1/art/game/${id}/poster\\?v=[0-9a-f]{12}$`));
    expect([j.poster.w, j.poster.h]).toEqual([600, 900]);
    expect(j.poster.colour.base).toMatch(/^#[0-9a-f]{6}$/);
    expect(j.poster.text).toBeUndefined();                                 // its lettering only for a client that draws box art
  }, 70_000);

  test("a client that draws box art (?text=1) gets the poster's lettering, read once and kept by the poster's hash", async () => {
    let j: any = null;
    for (let i = 0; i < 40 && !j?.poster?.text; i++) { j = (await http("GET", `/api/v1/art/game/${id}/card?text=1`)).json; if (!j.poster?.text) await sleep(250); }
    const text = j.poster.text as number[][];
    expect(text.length).toBeGreaterThan(0);
    for (const b of text) {
      expect(b).toHaveLength(4);
      expect(b[0]).toBeLessThan(b[2]);
      expect(b[1]).toBeLessThan(b[3]);
      for (const v of b) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    }
    expect(text.some(b => b[1] < 0.15 && b[3] > 0.3 && b[2] - b[0] > 0.8)).toBe(true);   // the logo across the top
    const hash = j.poster.url.split("v=")[1];
    expect(readdirSync(join(process.env.AHOY_CONFIG!, "cache", "cards", "text")).filter(f => f.startsWith(hash))).toHaveLength(1);
    expect(j.art.kind).toBe("dissolve");                                   // the recipe's card itself is as it was
    expect(j.colour.base).toBe("#eb5c33");
  }, 20_000);

  test("the JSON and the art are cached by their ETags; a dissolve has no cut-out", async () => {
    const r = await http("GET", `/api/v1/art/game/${id}/card`);
    expect(r.headers.get("cache-control")).toBe("no-cache");
    const etag = r.headers.get("etag")!;
    expect((await http("GET", `/api/v1/art/game/${id}/card`, undefined, null, { "if-none-match": etag })).status).toBe(304);
    const art = await http("GET", r.json.art.url);
    expect(art.status).toBe(200);
    expect(art.headers.get("content-type")).toBe("image/jpeg");
    expect(art.headers.get("cache-control")).toContain("immutable");
    expect((await http("GET", r.json.art.url, undefined, null, { "if-none-match": art.headers.get("etag")! })).status).toBe(304);
    expect((await http("GET", `/api/v1/art/game/${id}/card/art`)).headers.get("cache-control")).toBe("public, max-age=60");   // no ?v: short
    expect((await http("GET", `/api/v1/art/game/${id}/card/cutout.png`)).status).toBe(404);
  });

  test("no session needed; unknown games and bad ids are 404", async () => {
    expect((await http("GET", "/api/v1/art/game/424242/card")).status).toBe(404);
    expect((await http("GET", "/api/v1/art/game/abc/card")).status).toBe(404);
    expect((await http("GET", "/api/v1/art/game/424242/card/cutout.png")).status).toBe(404);
  });
});

describe("the queue never holds a request up", () => {
  const busy = 9201, slow = 9202;
  beforeAll(() => {
    setLibrary([game(busy, "Batomon Showdown"), game(slow, "Balatro")]);
    sourceDeps.poster = async (g) => {
      if (g.id === slow) { await sleep(4000); return image("balatro-poster.jpg"); }    // a slow engine
      return image("batomon-poster.jpg");
    };
    sourceDeps.keyArt = async () => null;
    sourceDeps.logo = async () => null;
  });
  afterAll(() => { stopCards(); Object.assign(sourceDeps, original); });

  test("while the worker builds one card, every request returns in a moment", async () => {
    await http("GET", `/api/v1/art/game/${busy}/card`);
    const t0 = Date.now();
    while (!jobStage(busy) && Date.now() - t0 < 5000) await sleep(20);
    expect(jobStage(busy)).not.toBeNull();                                 // the worker is on it
    let lag = 0, last = Date.now();
    const tick = setInterval(() => { const now = Date.now(); lag = Math.max(lag, now - last - 10); last = now; }, 10);
    const times: number[] = [];
    for (let i = 0; i < 10 && jobStage(busy); i++) {
      const t = Date.now();
      const r = await http("GET", `/api/v1/art/game/${busy}/card`);
      times.push(Date.now() - t);
      expect(r.status).toBe(200);
      expect(r.json.status).toBe("pending");
      await sleep(50);
    }
    clearInterval(tick);
    expect(times.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...times)).toBeLessThan(300);
    expect(lag).toBeLessThan(250);                                         // the server's own loop stays free
  }, 30_000);

  test("a source that is slow to arrive still gets a card within the quick wait", async () => {
    const t = Date.now();
    const r = await http("GET", `/api/v1/art/game/${slow}/card`);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("pending");
    expect(r.json.art.kind).toBe("none");
    expect(r.json.fan).toHaveLength(5);
  }, 10_000);
});

describe("the default look", () => {
  test("no CARD_STYLE: fade (the poster melting into the colour) — no cut-outs, so the model is never fetched", async () => {
    const { cardStyle, cutoutsOn, posterOnly } = await import("../src/cards/model");
    const was = process.env.CARD_STYLE;
    try {
      delete process.env.CARD_STYLE;
      expect(cardStyle()).toBe("fade");
      expect(posterOnly()).toBe(true);
      expect(cutoutsOn()).toBe(false);
      process.env.CARD_STYLE = "recipe";
      expect(cardStyle()).toBe("recipe");
      expect(cutoutsOn()).toBe(true);
      process.env.CARD_STYLE = "nonsense";
      expect(cardStyle()).toBe("fade");
    } finally { process.env.CARD_STYLE = was; }
  });
});

describe("box art (CARD_STYLE=boxart)", () => {
  const id = 9501, bare = 9502, style = process.env.CARD_STYLE;
  let otherReads = 0;
  beforeAll(() => {
    process.env.CARD_STYLE = "boxart";
    setLibrary([game(id, "Batomon Showdown"), game(bare, "No Art Here")]);
    sourceDeps.poster = async (g) => (g.id === id ? image("batomon-poster.jpg") : null);
    sourceDeps.keyArt = async () => { otherReads++; return null; };
    sourceDeps.logo = async () => null;                                     // asked for: the lettering's second opinion
  });
  afterAll(() => { stopCards(); Object.assign(sourceDeps, original); if (style === undefined) delete process.env.CARD_STYLE; else process.env.CARD_STYLE = style; });

  test("the poster is the card: its route, size and colour; no key art read, nothing queued, no model", async () => {
    expect(modelState()).toBe("off");                                       // never fetched, never loaded
    expect(ensureModel()).toBe("off");
    const j = (await until(id, x => x.status === "ready", 10_000)).json;
    expect(j.art.kind).toBe("poster");
    expect(j.art.url).toMatch(new RegExp(`^/api/v1/art/game/${id}/poster\\?v=[0-9a-f]{12}$`));
    expect([j.art.w, j.art.h, j.art.source]).toEqual([600, 900, "poster"]);
    expect(j.poster).toEqual({ url: j.art.url, w: 600, h: 900, colour: j.colour, text: [[0.013, 0.083, 1, 0.366]] });   // its lettering: the logo
    // the colour is the poster's own (the quick card's rule)
    const own = await posterColours(fx("batomon-poster.jpg"));
    expect(j.colour).toEqual(colourJson(own.colour));
    expect(j.alternates).toEqual(own.alternates.map(colourJson));
    expect(j.key).toMatch(/^b[0-9a-f]{19}$/);
    // labels are laid out as on a card with no art (for clients that draw them); no art placement
    expect(j.fan).toHaveLength(5);
    expect(j.fan[0].row.art).toBeNull();
    expect(j.fan[0].row.labels.title.lines.join(" ")).toBe("Batomon Showdown");
    expect(otherReads).toBe(0);
    expect(jobStage(id)).toBeNull();
    expect(queueLength()).toBe(0);
    // the address is the poster route itself (here without an engine it answers its placeholder)
    expect((await http("GET", j.art.url)).status).toBe(200);
  }, 20_000);

  test("a game without a poster keeps the colour-only card with its title, ready", async () => {
    const j = (await until(bare, x => x.status === "ready", 10_000)).json;
    expect(j.art.kind).toBe("none");
    expect(j.poster).toBeNull();
    expect(j.title).toBe("No Art Here");
    expect(queueLength()).toBe(0);
  }, 20_000);
});

describe("the poster where the cut-out stood: its places", () => {
  const win = (x0: number, x1: number, y0: number) => ({ cardW: 384, cardH: 560, x0, x1, cx: (x0 + x1) / 2, y0, y1: 415, bleedY: 421, visibleAt: (_x: number, y: number) => y <= 415 });
  const geom = { w: 384, h: 560, m0: 102, m1: 194, minTextPx: 8 };
  const fill = { bottom: () => 431 };                                         // the centre card: its frame edge at 415, 16 more
  test("the cover: as wide as the window less the labels' padding, centred under the labels, in the poster's own shape; never a sliver", () => {
    const p = placeCover(600, 900, win(0, 384, 108), 32);
    expect([p.x, p.y, p.w]).toEqual([32, 108, 320]);
    expect(p.h).toBeCloseTo(480, 6);
    expect(p.r).toBeCloseTo(0.045 * 320, 6);
    expect(p.img).toEqual({ x: p.x, y: p.y, w: p.w, h: p.h });              // no lettering: the whole poster fills its frame
    const q = placeCover(528, 704, win(60, 226, 254), 30);              // an outer card under a long title: the window is a sliver
    expect(q.w).toBeCloseTo(0.44 * 384, 6);
    expect(q.x + q.w / 2).toBeCloseTo(143, 6);
  });
  test("the cover keeps the poster's lettering out of its frame: a logo across the top is cut off above it, at the least zoom", () => {
    const top = [0, 0.041, 1, 0.45, 0.2];                                     // Dave the Diver's
    const p = placeCover(600, 900, win(0, 384, 151), 32, [top], fill);
    expect(p.seen).toBe(0);
    expect(p.img.y + top[3] * p.img.h).toBeLessThanOrEqual(p.y + 1e-6);     // the logo ends above the frame
    expect(p.img.y + p.img.h).toBeGreaterThanOrEqual(431 - 1e-6);           // the poster still fills the frame down to what shows
    expect(p.img.w / p.w).toBeGreaterThan(1);                                // cut that far at 1x, it would not reach that far...
    expect(p.img.w / p.w).toBeLessThan(1.2);                                 // ...so it takes the least zoom that does
    expect(p.img.x + p.img.w / 2).toBeCloseTo(p.x + p.w / 2, 6);            // centred
    // a logo across the bottom that the frame's bottom edge hides leaves the poster whole, at 1x
    const low = placeCover(600, 900, win(0, 384, 108), 32, [[0, 0.7, 1, 0.9, 0.08]], fill);
    expect(low.img).toEqual({ x: low.x, y: low.y, w: low.w, h: low.h });
    // lettering too small to read on the card does not count
    expect(placeCover(600, 900, win(0, 384, 108), 32, [[0.1, 0.1, 0.4, 0.15, 0.005]], fill).img.y).toBe(108);
  });
  test("the cover: lettering that cannot leave the frame shows as little of itself as it can", () => {
    const mid = [0, 0.29, 0.99, 0.72, 0.15];                                  // Queen's Domain's: across the middle
    const p = placeCover(600, 900, win(0, 384, 108), 32, [mid], fill);
    const plain = letteringSeen([mid], 600, 900, 320 / 600, 32, 108, showGrid(384, 560, (x, y) => (x >= 32 && x <= 352 && y >= 108 && y <= 415 ? 1 : 0)), 8);
    expect(plain).toBeGreaterThan(0);
    expect(p.seen).toBeGreaterThan(0);
    expect(p.seen).toBeLessThan(plain);
  });
  test("the fade: just covering the art area, bottom-aligned and centred, when the poster has no lettering", () => {
    const p = placeFade(600, 900, geom, []);
    expect(p.s).toBeCloseTo(0.64, 9);
    expect(p.dx).toBeCloseTo(0, 6);
    expect(p.dy).toBeCloseTo(-16, 6);
    expect(p.ih).toBeCloseTo(576, 6);
    // a 3:4 cover is scaled to the card's width too
    expect(placeFade(528, 704, geom, []).dy).toBeCloseTo(48, 6);
  });
  test("the fade keeps lettering out of sight: a logo across the top goes above the ramp, at the least zoom that does it", () => {
    const top = [0.013, 0.083, 1, 0.366, 0.05];                           // Batomon Showdown's logo
    const p = placeFade(600, 900, geom, [top]);
    expect(p.s).toBeGreaterThan(0.64);
    expect(p.s).toBeLessThanOrEqual(0.64 * 1.75);
    expect(p.dy + top[3] * p.ih).toBeLessThanOrEqual(hiddenTo(geom.m0, geom.m1));
    expect(p.dx + p.iw / 2).toBeCloseTo(192, 6);                            // centred
    expect(p.dy + p.ih).toBeGreaterThanOrEqual(560 - 1e-6);                 // and still covering the card
    const less = placeFade(600, 900, { ...geom, m1: geom.m0 + 92 }, [top.map((v, i) => (i === 3 ? v - 0.1 : v))]);
    expect(less.s).toBeLessThan(p.s);                                       // a lower edge higher up takes less zoom
    // a logo across the bottom goes under the card's bottom edge instead, at cover scale
    const low = placeFade(600, 900, geom, [[0.05, 0.8, 0.95, 0.95, 0.05]]);
    expect(low.s).toBeCloseTo(0.64, 9);
    expect(low.dy + 0.8 * low.ih).toBeGreaterThanOrEqual(560);
    // lettering too small to read on the card does not count
    expect(placeFade(600, 900, geom, [[0.1, 0.3, 0.9, 0.4, 0.005]]).dy).toBeCloseTo(-16, 6);
  });
  test("the fade on a side card: the poster's middle on the middle of what shows, zoomed just enough to still cover the card", () => {
    const side = { ...geom, m0: 152, m1: 231, cx: 113, y1: 342, vis: (x: number, y: number) => (x <= 230 && y <= 342 ? 1 : 0) };
    const p = placeFade(600, 900, side, []);
    expect(p.dx + p.iw / 2).toBeCloseTo(113, 6);
    expect(p.dx).toBeLessThanOrEqual(1e-9);
    expect(p.dx + p.iw).toBeGreaterThanOrEqual(384 - 1e-6);
    expect(p.iw).toBeCloseTo(2 * (384 - 113), 6);
    expect(p.dy).toBeLessThanOrEqual(152);
    expect(p.dy + p.ih).toBeGreaterThanOrEqual(560 - 1e-6);
    // the poster row in the middle of what shows is the one bottom-aligned at cover scale puts there
    const mid = (152 + 342) / 2, f0 = (mid - (560 - 0.64 * 900)) / (0.64 * 900);
    expect((mid - p.dy) / p.ih).toBeCloseTo(f0, 6);
  });
  test("the fade: lettering that cannot leave the card goes where the fan hides it; failing that, where the least of it shows", () => {
    const mid = [0.083, 0.426, 0.92, 0.846, 0.05];                        // Castlevania's: across the middle
    const fan = placeFade(600, 900, { ...geom, y1: 415, vis: (_x: number, y: number) => (y <= 415 ? 1 : 0) }, [mid]);
    expect(fan.dy + mid[1] * fan.ih).toBeGreaterThanOrEqual(415);          // under the frame's bottom edge
    expect(fan.score).toBe(0);
    // with nothing to hide it under, the least of it shows (weighted by the ramp's opacity): less than bottom-aligned at cover scale
    const free = placeFade(600, 900, geom, [mid]);
    const grid = showGrid(384, 560, (_x, y) => { const a = alphaAt(y, 102, 194); return a > 0.03 ? a : 0; });
    const seen = (q: { s: number; dx: number; dy: number }) => letteringSeen([mid], 600, 900, q.s, q.dx, q.dy, grid, 8);
    expect(free.score).toBeLessThan(0);
    expect(-free.score).toBeCloseTo(seen(free), 6);
    expect(seen(free)).toBeLessThan(seen({ s: 0.64, dx: 0, dy: -16 }));
  });
  test("the fade under a wordmark at the top: the art right under it at the top of what shows, not under the colour", () => {
    const top = [0.055, 0.035, 0.958, 0.249, 0.06];                       // Hellraiser: Revival's logo, Pinhead's head right under it
    const three = { ...geom, m0: 180, m1: 272 };                            // a three-line title: bottom-aligned, the logo hides with room to spare
    const p = placeFade(600, 900, three, [top]);
    expect(p.s).toBeCloseTo(0.64, 9);                                       // no zoom...
    expect(p.dy + top[3] * p.ih).toBeCloseTo(hiddenTo(180, 272), 6);        // ...the logo's foot on the last row the ramp keeps out of sight
    expect(p.dy).toBeGreaterThan(-16 + 50);                                 // bottom-aligned, its head stayed under the colour
    expect(p.dy + p.ih).toBeGreaterThanOrEqual(560 - 1e-6);                 // still covering the card
    // on a side card too, at the zoom that centres it on what shows
    const side = { ...geom, m0: 152, m1: 231, cx: 113, y1: 342, vis: (x: number, y: number) => (x <= 230 && y <= 342 ? 1 : 0) };
    const q = placeFade(600, 900, side, [top]);
    expect(q.iw).toBeCloseTo(2 * (384 - 113), 6);
    expect(q.dy + top[3] * q.ih).toBeCloseTo(hiddenTo(152, 231), 6);
    // a wordmark at the foot leaves the place to the middle row (the side card's own test above), lettering too small to read too
    const plain = placeFade(600, 900, side, []);
    expect(placeFade(600, 900, side, [[0.05, 0.8, 0.95, 0.95, 0.05]]).dy).toBeGreaterThanOrEqual(plain.dy);
    expect(placeFade(600, 900, side, [[0.1, 0.05, 0.9, 0.25, 0.005]]).dy).toBeCloseTo(plain.dy, 6);
  });
  test("the fade on a side card keeps lettering 16 units under the frame's edge: a card under the pointer rises 10 and shows none", () => {
    const mid = [0, 0.29, 0.99, 0.72, 0.15];                                // Queen's Domain's: across the middle, hidden under the frame
    const colour = C.cardColour({ swatches: [sw(165, 1, 0.6, 0.5)], meanChroma: 0.4 }, 0.2, 0);
    const lay = layoutsOf("Queen's Domain", { mode: "fade", w: 600, h: 900, bandL: 0.2, text: [mid] }, colour);
    const fan = fanGeometry();
    for (const i of [0, 1, 3, 4]) for (const o of [lay.fan[i].row, lay.fan[i].under]) {
      const pl = o.pl as any;
      expect(pl.score).toBe(0);                                             // all of it out of sight at rest
      const lifted = G.makeCard({ left: FAN[i].left, top: FAN[i].top - 10, w: 384, h: 560, rot: FAN[i].rot, z: FAN[i].z, radius: 36 });
      const cards = fan.map((c, k) => (k === i ? lifted : c));
      let shows = 0;
      for (let y = Math.ceil(pl.dy + mid[1] * pl.ih); y <= Math.min(560, pl.dy + mid[3] * pl.ih); y += 2) {
        if (alphaAt(y, pl.m0, pl.m1) <= 0.03) continue;
        for (let x = Math.max(0, Math.ceil(pl.dx + mid[0] * pl.iw)); x <= Math.min(384, pl.dx + mid[2] * pl.iw); x += 2) if (lifted.insideLocal(x, y) && G.visible(lifted, cards, x, y, FRAME)) shows++;
      }
      expect(shows).toBe(0);
    }
  });
});

describe("the poster where the cut-out stood (CARD_STYLE=cover and fade, ?style=)", () => {
  const id = 9601, bare = 9602, style = process.env.CARD_STYLE, model = process.env.AHOY_CARD_MODEL;
  let otherReads = 0, logoReads = 0;
  const layouts = (j: any): any[] => [j.free, j.freeWide, ...j.fan.flatMap((f: any) => [f.row, f.under])];
  beforeAll(() => {
    delete process.env.AHOY_CARD_MODEL;
    setLibrary([game(id, "Batomon Showdown"), game(bare, "No Art Here")]);
    sourceDeps.poster = async (g) => (g.id === id ? image("batomon-poster.jpg") : null);
    sourceDeps.keyArt = async () => { otherReads++; return null; };
    sourceDeps.logo = async () => { logoReads++; return null; };
  });
  afterEach(() => { stopCards(); otherReads = 0; logoReads = 0; if (style === undefined) delete process.env.CARD_STYLE; else process.env.CARD_STYLE = style; });
  afterAll(() => { Object.assign(sourceDeps, original); if (model !== undefined) process.env.AHOY_CARD_MODEL = model; });

  test("CARD_STYLE=cover: the recipe's card, its labels and colour by the recipe's rules, the poster as an object under the labels; no key art read, nothing queued, no model", async () => {
    process.env.CARD_STYLE = "cover";
    expect(modelState()).toBe("off");
    expect(ensureModel()).toBe("off");
    const j = (await until(id, x => x.status === "ready", 10_000)).json;
    expect(j.art).toEqual({ kind: "cover", url: j.poster.url, w: 600, h: 900, source: "poster" });
    expect(j.art.url).toMatch(new RegExp(`^/api/v1/art/game/${id}/poster\\?v=[0-9a-f]{12}$`));
    expect(j.key).toMatch(/^c[0-9a-f]{19}$/);
    // the colour: the whole poster's without its lettering (the cut-out's own fallback pool), through the recipe's rule
    const text = await posterText({ file: fx("batomon-poster.jpg"), hash: "x", w: 600, h: 900 }, null);
    const own = await posterColours(fx("batomon-poster.jpg"), text);
    expect(j.colour).toEqual(colourJson(own.colour));
    expect(j.alternates).toEqual(own.alternates.map(colourJson));
    // the labels: the recipe's for this title and colour
    const plain = layoutsJson(layoutsOf("Batomon Showdown", { mode: "none" }, own.colour), 0, null);
    expect(j.fan.map((f: any) => [f.row.labels, f.under.labels])).toEqual(plain.fan.map(f => [f.row.labels, f.under.labels]));
    expect([j.free.labels, j.freeWide.labels]).toEqual([plain.free.labels, plain.freeWide.labels]);
    const [logo] = text;                                                    // the logo across the poster's top
    for (const lay of layouts(j)) {
      const a = lay.art;
      expect(a.kind).toBe("cover");
      expect(a.y).toBeGreaterThan(lay.labels.bottom);
      expect(a.h / a.w).toBeCloseTo(1.5, 1);
      expect(a.radius).toBeCloseTo(0.045 * a.w, 0);
      // inside the frame the poster is cut off above its logo, zoomed no more than 1.75x, still filling the frame across
      expect(a.img.y + logo[3] * a.img.h).toBeLessThanOrEqual(a.y + 0.5);
      expect(a.img.w / a.w).toBeGreaterThanOrEqual(1);
      expect(a.img.w / a.w).toBeLessThanOrEqual(1.75 + 1e-3);
      expect(a.img.x).toBeLessThanOrEqual(a.x + 0.1);
      expect(a.img.x + a.img.w).toBeGreaterThanOrEqual(a.x + a.w - 0.1);
    }
    const centre = j.fan[2].row;
    expect(centre.art.x).toBeCloseTo(centre.labels.pad, 0);
    expect(centre.art.x + centre.art.w).toBeCloseTo(384 - centre.labels.pad, 0);
    expect(centre.art.y + centre.art.h).toBeGreaterThan(415);              // on past the frame's bottom edge, like a cut-out
    expect(otherReads).toBe(0);
    expect(logoReads).toBeGreaterThan(0);                                   // the logo: the lettering's second opinion
    expect(jobStage(id)).toBeNull();
    expect(queueLength()).toBe(0);
  }, 20_000);

  test("CARD_STYLE=fade: a dissolve of the poster under the labels, its logo out of sight, its colour from where it melts in", async () => {
    process.env.CARD_STYLE = "fade";
    const j = (await until(id, x => x.status === "ready", 10_000)).json;
    expect(j.art).toEqual({ kind: "dissolve", url: j.poster.url, w: 600, h: 900, source: "poster" });
    expect(j.key).toMatch(/^f[0-9a-f]{19}$/);
    const text = await posterText({ file: fx("batomon-poster.jpg"), hash: "x", w: 600, h: 900 }, null);
    expect(text[0]).toHaveLength(5);                                        // each block keeps its letter height
    expect(j.poster.text).toEqual(text.map(b => b.slice(0, 4)));            // read once, its boxes in the JSON as before
    const fade = await fadeColours(fx("batomon-poster.jpg"), text);
    expect(j.colour).toEqual(colourJson(fade.colour));
    expect(j.alternates).toEqual(fade.alternates.map(colourJson));
    const [logo] = text;                                                    // the logo across the poster's top
    for (const lay of layouts(j)) {
      const a = lay.art;
      expect(a.kind).toBe("dissolve");
      expect(a.fade.from).toBeGreaterThanOrEqual(lay.labels.bottom);
      expect(a.x).toBeLessThanOrEqual(0.1);
      expect(a.x + a.w).toBeGreaterThanOrEqual(383.9);                     // the poster covers the card
      expect(a.y + a.h).toBeGreaterThanOrEqual(559.9);
      expect(a.y + logo[3] * a.h).toBeLessThanOrEqual(a.fade.from + 0.11 * (a.fade.to - a.fade.from) + 0.5);
      expect(a.wash > 0).toBe(fade.bandL >= 0.3);
      expect((a.tint ?? 0) > 0).toBe(fade.bandL < 0.3);                    // over a dark band, the tint instead of the wash
    }
    // a side card centres the poster on what the fan shows of it: left of the card's middle on the left, right of it on the right
    expect(j.fan[1].row.art.x + j.fan[1].row.art.w / 2).toBeLessThan(192 - 40);
    expect(j.fan[3].row.art.x + j.fan[3].row.art.w / 2).toBeGreaterThan(192 + 40);
    expect(j.fan[2].row.art.x + j.fan[2].row.art.w / 2).toBeCloseTo(192, 0);
    expect(otherReads).toBe(0);
    expect(logoReads).toBeGreaterThan(0);
    expect(queueLength()).toBe(0);
  }, 20_000);

  test("a client asks ?style=cover or fade of a server that makes today's cards: that card at once, today's card as it was", async () => {
    expect(cardsInternals.modelState()).toBe("missing");
    let cover: any = null, fade: any = null;
    for (let i = 0; i < 40 && (cover?.status !== "ready" || fade?.status !== "ready"); i++) {
      cover = (await http("GET", `/api/v1/art/game/${id}/card?style=cover`)).json;
      fade = (await http("GET", `/api/v1/art/game/${id}/card?style=fade`)).json;
      if (cover.status !== "ready" || fade.status !== "ready") await sleep(250);
    }
    expect(cover.art.kind).toBe("cover");
    expect(fade.art).toMatchObject({ kind: "dissolve", url: fade.poster.url, source: "poster" });
    const today = (await http("GET", `/api/v1/art/game/${id}/card`)).json;
    expect(["none", "dissolve"]).toContain(today.art.kind);                 // the recipe's: a colour-only card, then its dissolve
    expect(today.art.url).not.toBe(today.poster?.url);
    expect((await http("GET", `/api/v1/art/game/${id}/card?style=nonsense`)).json.art.kind).not.toBe("cover");
    expect(otherReads).toBeGreaterThan(0);                                  // today's card reads the key art (and the logo)
    expect(logoReads).toBeGreaterThan(0);
  }, 20_000);

  test("a game without a poster keeps the colour-only card with its title, ready", async () => {
    process.env.CARD_STYLE = "fade";
    const j = (await until(bare, x => x.status === "ready", 10_000)).json;
    expect(j.art.kind).toBe("none");
    expect(j.poster).toBeNull();
    expect(j.title).toBe("No Art Here");
    expect(queueLength()).toBe(0);
  }, 20_000);
});

describe("the poster's lettering, the game's logo its second opinion (cover, fade, box art)", () => {
  /** a template match as matchLogo gives it, counting by the recipe's rule unless told otherwise */
  const match = (box: number[], { ncc = 0.6, cz = 20 } = {}) => ({ ncc, z: 40, coarse: ncc, cz, pieces: [], alpha: null, box }) as unknown as LogoMatch;
  const logoAt = [0, 0.75, 1, 1, 0.21];
  /** every place a fade card has (the free card, both pill variants of each fan slot) */
  const places = (lay: ReturnType<typeof layoutsOf>) => [lay.free, lay.freeWide, ...lay.fan.flatMap(f => [f.row, f.under])].map(o => o.pl as any);

  test("a match that does not count (weak, or off every block of big letters the glyph rules read) changes nothing", () => {
    const blocks = [[0.05, 0.1, 0.95, 0.3, 0.08], [0.3, 0.9, 0.7, 0.95, 0.02]];
    expect(withLogo(blocks, null)).toEqual(blocks);
    expect(withLogo(blocks, match(logoAt, { ncc: 0.2 }))).toEqual(blocks);
    expect(withLogo(blocks, match(logoAt, { cz: 5 }))).toEqual(blocks);
    expect(withLogo(blocks, match(logoAt))).toEqual(blocks);                 // a poster carries one wordmark: it is up there
  });

  test("the logo is the wordmark: no block on it, its box; a block of big letters running into it from the art goes; the rest stays", () => {
    expect(withLogo([], match(logoAt))).toEqual([logoAt]);                   // the glyph rules read nothing
    const tagline = [0.3, 0.1, 0.7, 0.14, 0.02], misread = [0.05, 0.4, 0.95, 0.8, 0.15], away = [0.1, 0.05, 0.9, 0.3, 0.12];
    expect(withLogo([tagline], match(logoAt))).toEqual([tagline, logoAt]);   // small letters: a tagline, not the wordmark
    expect(withLogo([misread, tagline], match(logoAt))).toEqual([tagline, logoAt]);   // the art beside the logo, read as letters
    const read = [0.02, 0.72, 0.98, 0.99, 0.18];                             // the glyph rules' own box of the logo
    expect(withLogo([read, away, tagline], match(logoAt))).toEqual([read, away, tagline]);
  });

  test("a logo the glyph rules cannot read (The Drifter's condensed letters): found on the poster, read once, kept by both hashes", async () => {
    const file = fx("the-drifter-poster.jpg"), ref = { file, hash: "drifter", w: 600, h: 900 };
    const logo = { file: fx("the-drifter-logo.png"), hash: "drifterlogo", box: (await logoBox(fx("the-drifter-logo.png")))! };
    expect(await posterText(ref, null)).toEqual([]);
    const keep = mkdtempSync(join(tmpdir(), "ahoy-text-"));
    const text = await posterText(ref, keep, logo);
    expect(text).toHaveLength(1);
    const [b] = text;                                                        // "The DRIFTER" across the poster's foot
    expect(b[0]).toBeLessThan(0.05); expect(b[2]).toBeGreaterThan(0.95);
    expect(b[1]).toBeGreaterThan(0.7); expect(b[1]).toBeLessThan(0.78); expect(b[3]).toBeGreaterThan(0.97);
    expect(readdirSync(keep)).toEqual(["drifter-drifterlogo.json"]);
    expect(await posterText(ref, keep, logo)).toEqual(text);                 // read once
    // the fade keeps it out of sight everywhere: off the card, or where the fan hides it (a place that shows any has a score < 0)
    const colour = C.cardColour({ swatches: [sw(215, 1, 0.8, 0.6)], meanChroma: 0.5 }, 0.2, 0);
    for (const pl of places(layoutsOf("The Drifter", { mode: "fade", w: 600, h: 900, bandL: 0.2, text }, colour))) expect(pl.score).toBe(0);
  }, 30_000);

  test("a close match adds the pieces the glyph rules' blocks do not hold; a looser one leaves their blocks as they are", () => {
    const read = [0.046, 0.786, 0.683, 0.911, 0.056];                        // Mouthwashing's: the glyph rules stop before "ING"
    const pieces = [[0.027, 0.808, 0.568, 0.896, 0.093], [0.547, 0.808, 0.973, 0.902, 0.093]];
    const at = [0.01, 0.8, 0.99, 0.91, 0.09];
    const close = { ...match(at, { ncc: 0.85 }), pieces } as unknown as LogoMatch;
    expect(withLogo([read], close)).toEqual([read, pieces[1]]);              // "MOUTHWASH" is in their block already, "ING" is not
    expect(withLogo([read], { ...close, ncc: 0.38 } as unknown as LogoMatch)).toEqual([read]);   // a logo drawn another way: a line off
  });

  test("a wordmark the glyph rules read in part (Samurai GUNN 2's brush letters): the smaller reading on the logo completes it", async () => {
    const ref = { file: fx("samurai-gunn-2-poster.jpg"), hash: "x", w: 600, h: 900 };
    const logo = { file: fx("samurai-gunn-2-logo.png"), hash: "l", box: (await logoBox(fx("samurai-gunn-2-logo.png")))! };
    const plain = await posterText(ref, null);
    expect(plain).toHaveLength(1);
    expect(plain[0][3]).toBeLessThan(0.22);                                  // "SAMURAI" only: "GUNN 2" runs on to 0.30
    const text = await posterText(ref, null, logo);
    expect(text).toHaveLength(2);
    expect(text[0]).toEqual(plain[0]);
    const [b] = text.slice(1);                                               // read at 200 px, on the logo
    expect(b[0]).toBeLessThan(0.05); expect(b[2]).toBeGreaterThan(0.95);
    expect(b[1]).toBeLessThan(0.05); expect(b[3]).toBeGreaterThan(0.3); expect(b[3]).toBeLessThan(0.36);
    // the fade keeps it all out of sight, and shows the face under it: the poster's row 0.37 (the eyes) shows on every fan card
    const colour = C.cardColour({ swatches: [sw(0, 1, 0.9, 0.8)], meanChroma: 0.6 }, 0.5, 0);
    const lay = layoutsOf("Samurai GUNN 2", { mode: "fade", w: 600, h: 900, bandL: 0.5, text: keptLettering(text) }, colour);
    for (const pl of places(lay)) expect(pl.score).toBe(0);
    for (const f of lay.fan) { const pl = f.row.pl as any; expect(alphaAt(pl.dy + 0.37 * pl.ih, pl.m0, pl.m1)).toBeGreaterThan(0.2); }
  }, 30_000);

  test("nothing read and no logo: the glyph rules' last resort reads a wordmark whose swashes join its letters (Demon's Souls)", async () => {
    const text = await posterText({ file: fx("demons-souls-poster.jpg"), hash: "x", w: 528, h: 704 }, null);
    expect(text).toHaveLength(1);
    const [b] = text;                                                        // the gothic logo across the poster's top
    expect(b[0]).toBeLessThan(0.1); expect(b[2]).toBeGreaterThan(0.9);
    expect(b[1]).toBeLessThan(0.05); expect(b[3]).toBeGreaterThan(0.25); expect(b[3]).toBeLessThan(0.4);
  }, 30_000);
});

describe("CARD_STYLE=fade with the game's logo", () => {
  const id = 9621, style = process.env.CARD_STYLE;
  let withLogoFile = true;
  beforeAll(() => {
    process.env.CARD_STYLE = "fade";
    setLibrary([game(id, "The Drifter")]);
    sourceDeps.poster = async (g) => (g.id === id ? image("the-drifter-poster.jpg") : null);
    sourceDeps.keyArt = async () => null;
    sourceDeps.logo = async (g) => (g.id === id && withLogoFile ? image("the-drifter-logo.png", "image/png") : null);
  });
  afterAll(() => { stopCards(); Object.assign(sourceDeps, original); if (style === undefined) delete process.env.CARD_STYLE; else process.env.CARD_STYLE = style; });

  test("the card's lettering is read with the logo: its places and colour follow it, and a new logo makes a new card", async () => {
    const j = (await until(id, x => x.status === "ready" && x.art.kind === "dissolve", 30_000)).json;
    const file = fx("the-drifter-poster.jpg"), logo = { file: fx("the-drifter-logo.png"), hash: "l", box: (await logoBox(fx("the-drifter-logo.png")))! };
    const text = await posterText({ file, hash: "x", w: 600, h: 900 }, null, logo);
    expect(text).toHaveLength(1);
    expect(j.poster.text).toEqual(text.map(b => b.slice(0, 4)));
    const fade = await fadeColours(file, text);
    expect(j.colour).toEqual(colourJson(fade.colour));
    const lay = layoutsJson(layoutsOf("The Drifter", { mode: "fade", w: 600, h: 900, bandL: fade.bandL, text: keptLettering(text) }, fade.colour), 600, null);
    expect(j.fan).toEqual(lay.fan);
    stopCards(); withLogoFile = false;                                       // the same poster without its logo: nothing read
    const k = (await until(id, x => x.status === "ready" && x.art.kind === "dissolve", 30_000)).json;
    expect(k.poster.text).toEqual([]);
    expect(k.key).not.toBe(j.key);
  }, 70_000);
});

describe("the cache follows the art", () => {
  const id = 9401, revalidate = cardOptions.revalidateMs;
  let poster = "balatro-poster.jpg", delay = 0;
  beforeAll(() => {
    setLibrary([game(id, "Balatro")]);
    sourceDeps.poster = async (g) => { if (g.id !== id) return null; if (delay) await sleep(delay); return image(poster); };
    sourceDeps.keyArt = async () => null;
    sourceDeps.logo = async () => null;
  });
  afterAll(() => { stopCards(); Object.assign(sourceDeps, original); cardOptions.revalidateMs = revalidate; });

  test("new art: the old card says pending while the art is read, then a new card under a new key", async () => {
    const first = (await until(id, j => j.status === "ready" && j.art.kind !== "none", 60_000)).json;
    cardOptions.revalidateMs = 0; poster = "batomon-poster.jpg"; delay = 1000;    // new art, and the engine is slow this time
    const reading = (await http("GET", `/api/v1/art/game/${id}/card`)).json;
    cardOptions.revalidateMs = revalidate;                                       // no further reads in this test
    expect(reading.key).toBe(first.key);                                         // the old card stays drawable...
    expect(reading.status).toBe("pending");                                      // ...but a client must look again
    expect(reading.retryAfter).toBeGreaterThan(0);
    const next = (await until(id, j => j.status === "ready" && j.key !== first.key, 60_000)).json;
    expect(next.colour.base).toBe("#eb5c33");                                    // Batomon's colour, from the new bytes
  }, 130_000);

  test("ids that are not library games hold no state (the routes are session-free)", async () => {
    const before = cardsInternals.states.size;
    for (let i = 0; i < 50; i++) expect((await http("GET", `/api/v1/art/game/${700_000 + i}/card${i % 2 ? "/cutout.png" : ""}`)).status).toBe(404);
    expect(cardsInternals.states.size).toBe(before);
  });
});

describe.skipIf(!process.env.AHOY_CARD_MODEL)("the card route, model present (the cut-out)", () => {
  const id = 9301;
  beforeAll(() => {
    setLibrary([game(id, "Balatro")]);
    sourceDeps.poster = async (g) => (g.id === id ? image("balatro-poster.jpg") : null);
    sourceDeps.keyArt = async () => null;
    sourceDeps.logo = async () => null;
  });
  afterAll(() => { stopCards(); Object.assign(sourceDeps, original); });

  test("the dissolve first, then the cut-out PNG with its placement", async () => {
    expect(modelState()).toBe("ready");
    const r = await until(id, j => j.status === "ready" && j.art.kind === "cut", 240_000);
    const j = r.json;
    expect(j.colour).toMatchObject({ base: "#3390eb", ink: "ink" });
    expect(j.art.url).toBe(`/api/v1/art/game/${id}/card/cutout.png?v=${j.key}`);
    for (const lay of [j.free, ...j.fan.map((f: any) => f.row)]) {
      expect(lay.art.kind).toBe("cut");
      expect(lay.art.y).toBeGreaterThanOrEqual(lay.labels.bottom);          // under the labels
      expect(lay.art.w / lay.art.h).toBeCloseTo(j.art.w / j.art.h, 1);      // the PNG's own aspect
    }
    const png = await app("GET", j.art.url);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("cache-control")).toContain("immutable");
    const buf = Buffer.from(await png.arrayBuffer());
    const meta = await sharp(buf).metadata();
    expect(meta.channels).toBe(4);
    expect([meta.width, meta.height]).toEqual([j.art.w, j.art.h]);
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    let clear = 0, solid = 0;
    for (let i = 3; i < data.length; i += 4) { if (data[i] === 0) clear++; else if (data[i] === 255) solid++; }
    expect(clear / (info.width * info.height)).toBeGreaterThan(0.05);      // the backdrop is gone
    expect(solid / (info.width * info.height)).toBeGreaterThan(0.15);      // the subject is there (four scattered cards)
  }, 260_000);
});

/** a raw response through the app (for binary bodies) */
async function app(method: string, path: string) {
  const { app } = await import("../src/server");
  return app.fetch(new Request(`http://ahoy.test${path}`, { method }));
}

describe("the model download", () => {
  const env = { model: process.env.AHOY_CARD_MODEL, cutouts: process.env.CARD_CUTOUTS, config: process.env.AHOY_CONFIG };
  const deps = { ...modelDeps };
  const body = new Uint8Array(256 * 1024).map((_, i) => (i * 31) & 255);
  let ranges: (string | null)[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let rangeOk = true;
  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch(req) {
      const r = req.headers.get("range"); ranges.push(r);
      const m = r && /bytes=(\d+)-/.exec(r);
      if (m && rangeOk) { const from = Number(m[1]); return new Response(body.slice(from), { status: 206, headers: { "content-range": `bytes ${from}-${body.length - 1}/${body.length}`, "content-length": String(body.length - from) } }); }
      return new Response(body, { headers: { "content-length": String(body.length) } });
    } });
  });
  afterEach(() => {
    Object.assign(modelDeps, deps); _modelTest.reset(); ranges = []; rangeOk = true;
    for (const [k, v] of [["AHOY_CARD_MODEL", env.model], ["CARD_CUTOUTS", env.cutouts], ["AHOY_CONFIG", env.config]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  afterAll(() => server.stop(true));
  const url = () => `http://127.0.0.1:${server.port}/model.onnx`;

  test("continues a partial file with a Range request", async () => {
    const part = join(mkdtempSync(join(tmpdir(), "ahoy-model-")), "m.part");
    writeFileSync(part, body.slice(0, 100_000));
    await downloadResumable(url(), part, body.length);
    expect(ranges).toEqual(["bytes=100000-"]);
    expect(Buffer.compare(readFileSync(part), Buffer.from(body))).toBe(0);
  });
  test("starts over when the server ignores the range", async () => {
    rangeOk = false;
    const part = join(mkdtempSync(join(tmpdir(), "ahoy-model-")), "m.part");
    writeFileSync(part, new Uint8Array(5000).fill(7));
    await downloadResumable(url(), part, body.length);
    expect(Buffer.compare(readFileSync(part), Buffer.from(body))).toBe(0);
  });
  test("refuses a file of another size, for good", async () => {
    const part = join(mkdtempSync(join(tmpdir(), "ahoy-model-")), "m.part");
    let err: any = null;
    try { await downloadResumable(url(), part, body.length + 1); } catch (e) { err = e; }
    expect(err?.fatal).toBe(true);
  });
  test("fetched once into <config>/models when missing; a ready model wakes the queue", async () => {
    delete process.env.AHOY_CARD_MODEL; delete process.env.CARD_CUTOUTS;
    process.env.AHOY_CONFIG = mkdtempSync(join(tmpdir(), "ahoy-models-"));
    Object.assign(modelDeps, { allowDownload: () => true, url: url(), bytes: body.length });
    let woke = 0; const off = onModelReady(() => woke++);
    expect(modelState()).toBe("missing");
    expect(ensureModel()).toBe("downloading");
    expect(ensureModel()).toBe("downloading");                             // one download at a time
    await _modelTest.pending();
    off();
    expect(modelState()).toBe("ready");
    expect(existsSync(modelPath())).toBe(true);
    expect(existsSync(modelPath() + ".part")).toBe(false);
    expect(woke).toBe(1);
    expect(ranges).toEqual([null]);
  });
  test("not with cut-outs off, nor under AHOY_WORKERS=0, nor for a model path set by hand", async () => {
    delete process.env.AHOY_CARD_MODEL;
    process.env.AHOY_CONFIG = mkdtempSync(join(tmpdir(), "ahoy-models-"));
    Object.assign(modelDeps, { allowDownload: () => true, url: url(), bytes: body.length });
    process.env.CARD_CUTOUTS = "off";
    expect(ensureModel()).toBe("off");
    delete process.env.CARD_CUTOUTS;
    modelDeps.allowDownload = deps.allowDownload;                          // the tests run with AHOY_WORKERS=0
    expect(ensureModel()).toBe("missing");
    process.env.AHOY_CARD_MODEL = join(process.env.AHOY_CONFIG, "elsewhere.onnx");
    modelDeps.allowDownload = () => true;
    expect(ensureModel()).toBe("missing");
    expect(ranges).toEqual([]);
  });
});

describe("a card's title", () => {
  test("drops the store's trademark signs, then title-cases a name typed in capitals (roman numerals stay)", () => {
    expect(displayName("DARK SOULS™ III")).toBe("Dark Souls III");
    expect(displayName("Call of Duty®: Modern Warfare® 4")).toBe("Call of Duty: Modern Warfare 4");
    expect(displayName("ELDEN RING NIGHTREIGN")).toBe("Elden Ring Nightreign");
    expect(displayName("Hollow Knight")).toBe("Hollow Knight");
  });
});

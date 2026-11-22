/** spotlight: the boards' spotlight rule on the server — the boards' own decisions (M/spot/gen/decisions.json) reproduced from the
 * same art, the per-width answer the endpoint gives (facts-line steps, logos whose readable strengths have a gap), the stage
 * geometry at other widths, and the route: pending at once, then the layout from the worker, cached, 404s, ETags. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { decide } from "../src/spotlight/decide";
import { decodeRgba } from "../src/spotlight/decode";
import { NOMINAL_STAGE, fitTitle, textWidth } from "../src/spotlight/layout";
import { RULE, geometryFor } from "../src/spotlight/rule";
import { bucketOf } from "../src/spotlight/contract";
import { askedOf, spotDeps, stopSpotlight } from "../src/spotlight";
import { jobState } from "../src/spotlight/queue";
import { game, http, setLibrary } from "./helpers";

const FX = join(import.meta.dir, "fixtures");
const fx = (f: string) => join(FX, "spotlight", f);
const art = (f: string) => join(FX, "art", f);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** five of the boards' games, with the board's facts line and action, and what M/spot/gen/decisions.json says about them */
const BOARD = [
  { id: 31, name: "DARK SOULS III", hero: fx("ds3-hero.jpg"), logo: fx("ds3-logo.png"), steam: true, facts: "Arrived last night · 20 GB", action: "Install",
    want: { ox: 674, oy: 0, k: 0.9, top: 1, identity: "logo", scale: 1.42, blur: 0, textRight: 637.67, textTop: 298, crop: { box: { x: 0, y: 0, w: 579, h: 58 }, inkX: 0, hang: 0 } } },
  { id: 26, name: "Endacopia", hero: fx("endacopia-banner.jpg"), logo: null, steam: false, facts: "On the way · 48% · about 20 min", action: "Pause",
    want: { ox: 945, oy: 9, k: 0, top: 1, identity: "title", scale: 2.39, blur: 3, title: { size: 115, lines: 1, bearing: 7 } } },
  { id: 20, name: "Bloodborne", hero: fx("bloodborne-banner.jpg"), logo: null, steam: false, facts: "Ready", action: "Install",
    want: { ox: 2, oy: 0, k: 0.82, top: 1, identity: "title", scale: 1.36, blur: 0, title: { size: 103, lines: 1, bearing: 6 } } },
  { id: 28, name: "and Roger", hero: art("3308870-library_hero_2x.jpg"), logo: art("3308870-logo_2x.png"), steam: true, facts: "Ready", action: "Install",
    want: { ox: 1110, oy: 0, k: 0.9, top: 1.1, identity: "logo, recoloured", scale: 0.71, blur: 0 } },
  // its red "2" reads over the bright art at a weak scrim, not in between, and again from 0.94-0.96 (the boards' canvas read the
  // PNG premultiplied, the server reads the file: one strength step apart)
  { id: 36, name: "Samurai GUNN 2", hero: fx("samurai-gunn-2-hero.jpg"), logo: fx("samurai-gunn-2-logo.png"), steam: true, facts: "Arrived today · 0.5 GB", action: "Install",
    want: { ox: 600, oy: 0, k: 0.96, top: 1, identity: "logo", scale: 0.71, blur: 0 } },
];
const kindOf = (d: ReturnType<typeof decide>) => (d.identity.kind === "logo" ? (d.identity.recolour ? "logo, recoloured" : "logo") : "title");

describe("the rule reproduces the boards' decisions", () => {
  for (const g of BOARD) {
    test(`${g.name}: pan, strength, identity`, async () => {
      const hero = await decodeRgba(g.hero), logo = g.logo ? await decodeRgba(g.logo) : null;
      const d = decide({ hero, fromSteam: g.steam, logo, name: g.name, geo: geometryFor(1440), mode: "board", stage: { factsWidth: textWidth(g.facts, "text400", 17), primaries: [g.action] } });
      const w = g.want;
      expect(Math.abs(d.ox - w.ox)).toBeLessThanOrEqual(2);                 // the pan, in 2 px steps
      expect(d.oy).toBe(w.oy);
      expect(Math.abs(d.k - w.k)).toBeLessThanOrEqual(0.02 + 1e-9);         // the side scrim, in 0.02 steps
      expect(d.topK).toBe(w.top);
      expect(kindOf(d)).toBe(w.identity);
      expect(Math.round(d.placement.s * 100) / 100).toBe(w.scale);
      expect(d.placement.blur).toBe(w.blur);
      if ("textRight" in w) { expect(d.text.right).toBeCloseTo(w.textRight!, 1); expect(d.text.top).toBeCloseTo(w.textTop!, 1); }
      if ("title" in w && d.identity.kind === "title") expect({ size: d.identity.title.size, lines: d.identity.title.lines.length, bearing: d.identity.title.bearing }).toEqual(w.title!);
      if ("crop" in w && d.identity.kind === "logo") expect({ box: d.identity.fit.box, inkX: d.identity.fit.inkX, hang: d.identity.fit.hang }).toEqual(w.crop!);
      for (const c of d.checks) if (!c.reportOnly) expect(c.cr).toBeGreaterThanOrEqual(c.need);   // every text reads at the chosen strength
    }, 30_000);
  }
});

describe("the title and the stage", () => {
  test("titles take the largest size that fits 580 x 140 in two balanced lines, kerned, shifted by their bearing", () => {
    expect(fitTitle("Bloodborne")).toMatchObject({ size: 103, lines: ["Bloodborne"], bearing: 6 });
    expect(fitTitle("Endacopia")).toMatchObject({ size: 115, bearing: 7 });                // 114 without kerning
    expect(fitTitle("Castlevania: Belmont's Curse")).toMatchObject({ size: 66, lines: ["Castlevania:", "Belmont's Curse"], bearing: 2 });
    expect(fitTitle("Batomon Showdown")).toMatchObject({ size: 66, lines: ["Batomon", "Showdown"], bearing: 2 });
    expect(fitTitle("Demon's Souls")).toMatchObject({ size: 83, bearing: 5 });
    expect(fitTitle("Stupid Never Dies").size).toBe(68);
  });
  test("the stage scales with the width: 880 tall at 1440, clamped between 1100 and 1800 wide", () => {
    expect(geometryFor(1440)).toEqual({ W: 1440, boxH: 880, fadeFrom: 460, fadeTo: 880, left: 48, bar: 148, dy: 0 });
    expect(geometryFor(1100, 104, 40)).toMatchObject({ boxH: 672, fadeFrom: 351, dy: -44 });
    expect(geometryFor(980, 104, 40).boxH).toBe(672);
    expect(geometryFor(2560).boxH).toBe(1100);
    expect([bucketOf(1361), bucketOf(979), bucketOf(500), bucketOf(5000)]).toEqual([1360, 960, 960, 2560]);
    expect(askedOf(1366, null, null)).toEqual({ w: 1360, bar: 148, left: 48 });
    expect(askedOf(1100, 104, 40)).toEqual({ w: 1120, bar: 104, left: 40 });   // 40 px steps: 1100 is drawn from 1120's layout
    expect(askedOf(null, 999, 7)).toEqual({ w: 1440, bar: 148, left: 48 });
    expect(RULE.scrimH(1440)).toEqual([[0, 0.9], [560, 0.84], [740, 0.56], [940, 0.16], [1100, 0.1], [1440, 0.5]]);
  });
});

describe("what the endpoint serves (page mode)", () => {
  test("the strength per facts width reproduces each board facts line, and a logo's gap is never chosen", async () => {
    for (const g of BOARD.filter(b => [31, 28, 36].includes(b.id))) {
      const hero = await decodeRgba(g.hero), logo = g.logo ? await decodeRgba(g.logo) : null;
      const d = decide({ hero, fromSteam: g.steam, logo, name: g.name, geo: geometryFor(1440) });
      const kFor = (w: number) => d.steps.reduce((k, [x, v], i) => (i === 0 || w > x ? v : k), 0);
      for (let i = 1; i < d.steps.length; i++) { expect(d.steps[i][0]).toBeGreaterThan(d.steps[i - 1][0]); expect(d.steps[i][1]).toBeGreaterThan(d.steps[i - 1][1]); }
      const board = kFor(textWidth(g.facts, "text400", 17));
      expect(Math.abs(board - g.want.k)).toBeLessThanOrEqual(0.02 + 1e-9);
      if (g.id === 36) expect(d.steps[0][1]).toBeGreaterThanOrEqual(0.94);   // never in the logo's gap, whatever the facts line
      expect(d.k).toBe(kFor(NOMINAL_STAGE.factsWidth));
      expect(d.ox).toBe(g.want.ox);
    }
  }, 60_000);
  test("on a narrow stage the art still covers it and the subject's room stays right of the text", async () => {
    const hero = await decodeRgba(fx("ds3-hero.jpg")), logo = await decodeRgba(fx("ds3-logo.png"));
    for (const [W, bar, left] of [[980, 104, 40], [1100, 104, 40], [1920, 148, 48]]) {
      const geo = geometryFor(W, bar, left), d = decide({ hero, fromSteam: true, logo, name: "DARK SOULS III", geo });
      const pl = d.placement;
      expect(d.ox).toBeGreaterThanOrEqual(pl.oxMin - 1e-9);
      expect(d.ox).toBeLessThanOrEqual(pl.oxMax + 1e-9);
      expect(pl.dispW - d.ox).toBeGreaterThanOrEqual(W);                    // covers the stage's width
      expect(pl.dispH).toBeGreaterThanOrEqual(geo.boxH);                    // and the art box's height
      expect(d.text.right).toBeLessThan(W - RULE.anchor.clearRight);       // there is room beside the text
      if (d.identity.kind === "logo") expect(d.identity.fit.top).toBeCloseTo(RULE.id.bottom + geo.dy - d.identity.fit.dh, 5);
    }
  }, 60_000);
});

describe("every stage keeps the board's subject", () => {
  test("from 960 up the subject the 1440 stage shows beside the text stands at its place in every room; 1440 is the board's own pan", async () => {
    const cases = [
      { name: "DARK SOULS III", hero: fx("ds3-hero.jpg"), logo: fx("ds3-logo.png"), steam: true, ox1440: 674 },   // panned to 0 at 960 and 1000 before
      { name: "Endacopia", hero: fx("endacopia-banner.jpg"), logo: null, steam: false, ox1440: 945 },              // showed its sign instead of its hero below 1440
    ];
    for (const g of cases) {
      const hero = await decodeRgba(g.hero), logo = g.logo ? await decodeRgba(g.logo) : null;
      const board = decide({ hero, fromSteam: g.steam, logo, name: g.name, geo: geometryFor(1440) });
      expect(board.ox).toBe(g.ox1440);
      const s = board.anchor.subject!;
      expect(s.at).toBeGreaterThan(0); expect(s.at).toBeLessThan(1);
      let last: number | null = null;
      for (const W of [960, 1000, 1040, 1080, 1120, 1280, 1360, 1920, 2560]) {
        const bar = W >= 1280 ? 148 : 104, left = W >= 1280 ? 48 : 40;
        const d = decide({ hero, fromSteam: g.steam, logo, name: g.name, geo: geometryFor(W, bar, left), map: board.map });
        const room = W - RULE.anchor.clearRight - d.text.right, X = s.x * d.placement.dispW - d.ox;     // the board's subject on this stage
        expect(X).toBeGreaterThan(d.text.right);                                         // beside the text
        expect(X).toBeLessThan(W - RULE.anchor.clearRight);                              // and well inside the frame
        const clamped = d.ox <= d.placement.oxMin + 2 || d.ox >= d.placement.oxMax - 2;
        if (!clamped) expect(Math.abs((X - d.text.right) / room - s.at)).toBeLessThan(2 / room);   // at the board's place, to the 2 px grid
        if (last != null && W <= 1440) expect(Math.abs(X - d.text.right - last)).toBeLessThan(0.3 * room);   // no jump between stages
        last = X - d.text.right;
        for (const c of d.checks) if (!c.reportOnly) expect(c.cr).toBeGreaterThanOrEqual(c.need);   // every text still reads
      }
    }
  }, 120_000);
});

describe("the spotlight route", () => {
  const id = 9501, app = 3308870, original = { ...spotDeps };
  beforeAll(() => {
    setLibrary([game(id, "DARK SOULS III", { steamAppId: 374320 })]);
    spotDeps.steamHero = async a => (a === 374320 ? { path: fx("ds3-hero.jpg"), type: "image/jpeg" } : a === app ? { path: art("3308870-library_hero_2x.jpg"), type: "image/jpeg" } : null);
    spotDeps.logo = async a => (a === 374320 ? { path: fx("ds3-logo.png"), type: "image/png" } : a === app ? { path: art("3308870-logo_2x.png"), type: "image/png" } : null);
    spotDeps.banner = async () => null;
  });
  afterAll(() => { stopSpotlight(); Object.assign(spotDeps, original); });

  async function until(path: string, ms: number) {
    const t0 = Date.now();
    for (;;) {
      const r = await http("GET", path);
      if (r.status === 200 && r.json.status === "ready") return r;
      if (Date.now() - t0 > ms) throw new Error(`${path} not ready in ${ms} ms: ${JSON.stringify(r.json).slice(0, 300)}`);
      await sleep(250);
    }
  }

  test("answers at once with pending, then the layout the worker made", async () => {
    const path = `/api/v1/art/game/${id}/spotlight?w=1440&bar=148&x=48`;
    const t0 = Date.now();
    const first = await http("GET", path);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ v: 1, status: "pending", asked: { w: 1440, bar: 148, left: 48 }, layout: null });
    expect(first.json.retryAfter).toBeGreaterThan(0);
    expect(first.headers.get("retry-after")).toBe(String(first.json.retryAfter));
    const j = (await until(path, 60_000)).json, l = j.layout;
    expect(j.key).toMatch(/^[0-9a-f]{20}$/);
    expect(l.stage).toMatchObject({ w: 1440, bar: 148, left: 48, boxH: 880, fade: { from: 460, to: 880, step: 15 }, idBottom: 380, factsGap: 24, actionsGap: 28 });
    expect(l.art).toMatchObject({ w: 1920, h: 620, windowH: 620, fromSteam: true, placeholder: false, x: -674, y: 0, blur: 0, reach: 0 });
    expect(l.art.url).toMatch(new RegExp(`^/api/v1/art/game/${id}/hero\\?v=[0-9a-f]{12}$`));
    expect(l.art.scale).toBeCloseTo(880 / 620, 4);
    expect(l.scrim.top).toBe(1);
    expect(l.scrim.k).toBe(0.9);
    expect(l.scrim.steps[0]).toEqual([0, 0.9]);
    expect(l.scrim.side).toEqual([[0, 0.9], [560, 0.84], [740, 0.56], [940, 0.16], [1100, 0.1], [1440, 0.5]]);
    expect(l.identity).toMatchObject({ kind: "logo", recolour: false, filter: null, file: { w: 579, h: 58 }, crop: { x: 0, y: 0, w: 579, h: 58 }, scale: 1, width: 579, height: 58, hang: 0, inkWidth: 579, bottom: 380 });
    expect(l.identity.url).toMatch(new RegExp(`^/api/v1/art/game/${id}/logo\\?v=[0-9a-f]{12}$`));
    expect(l.text.clear).toBe(1340);
  }, 70_000);

  test("another width: pending with the nearest layout of the same art, then its own", async () => {
    const path = `/api/v1/art/game/${id}/spotlight?w=1120&bar=104&x=40`;
    const r = await http("GET", path);
    expect(r.json.status).toBe("pending");
    expect(r.json.layout.stage.w).toBe(1440);                              // drawable meanwhile (the client adapts it)
    const l = (await until(path, 60_000)).json.layout;
    expect(l.stage).toMatchObject({ w: 1120, bar: 104, left: 40, boxH: 684, idBottom: 336 });
    expect(l.art.x).toBeLessThanOrEqual(0);
    expect(l.art.x + l.art.width).toBeGreaterThanOrEqual(1120);
    expect(l.art.height).toBeGreaterThanOrEqual(684);
  }, 70_000);

  test("a store app: its name from the page when the server has none; recoloured logo, raised top scrim", async () => {
    const path = `/api/v1/art/steam/${app}/spotlight?w=1440&n=${encodeURIComponent("and Roger")}`;
    await http("GET", path);
    const l = (await until(path, 60_000)).json.layout;
    expect(l.identity).toMatchObject({ kind: "logo", recolour: true, filter: "brightness(0) invert(0.949)" });
    expect(l.identity.url).toMatch(new RegExp(`^/api/v1/art/steam/${app}/logo\\?v=`));
    expect(l.scrim.top).toBe(1.1);
    expect(l.art.x).toBe(-1110);
  }, 70_000);

  test("revalidates by ETag; no session needed; unknown games and bad ids are 404", async () => {
    const r = await http("GET", `/api/v1/art/game/${id}/spotlight?w=1440`);
    expect(r.headers.get("cache-control")).toBe("no-cache");
    const etag = r.headers.get("etag")!;
    expect((await http("GET", `/api/v1/art/game/${id}/spotlight?w=1440`, undefined, null, { "if-none-match": etag })).status).toBe(304);
    expect((await http("GET", "/api/v1/art/game/424242/spotlight")).status).toBe(404);
    expect((await http("GET", "/api/v1/art/game/abc/spotlight")).status).toBe(404);
    expect((await http("GET", "/api/v1/art/steam/0/spotlight")).status).toBe(404);
  });

  test("while the worker lays a stage out, requests return in a moment", async () => {
    const path = `/api/v1/art/game/${id}/spotlight?w=1920&bar=148&x=48`;
    await http("GET", path);
    const key = (await http("GET", path)).json.key;
    const times: number[] = [];
    for (let i = 0; i < 8 && jobState(`${key}/1920-148-48`); i++) {
      const t = Date.now();
      const r = await http("GET", path);
      times.push(Date.now() - t);
      expect(r.status).toBe(200);
      await sleep(40);
    }
    expect(Math.max(0, ...times)).toBeLessThan(300);
    await until(path, 60_000);
  }, 70_000);
});

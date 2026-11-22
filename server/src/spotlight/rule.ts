/**
 * Spotlight — the rule (the boards' generator, M/spot/gen/rule.js, ported line for line). Every number the rule uses is in
 * RULE; every decision is a function of measured pixels, image sizes and whether the art came from Steam. Nothing here knows
 * which game it is looking at.
 *
 * The one generalisation: the boards draw the stage at 1440 x 960 under a 148 px top bar with the content edge at 48. Here the
 * stage takes a geometry (geometryFor): its width W, the art box's height (880 at 1440, scaling with the width), the bar's
 * height (the stage and the presence chips move with it, the bar's own items by half) and the content edge. At W 1440, bar 148,
 * edge 48 every number below is the board's.
 *
 * Not ported: the OCR (Chromium's TextDetector, no server equivalent). It only ever moved Desktop Explorer's pan.
 */
import * as P from "./pixels";
import type { Plane, Rgba } from "./pixels";

export const RULE = {
  board: { w: 1440, h: 960, boxH: 880, bar: 148, left: 48 },
  /** the art box scales with the stage width between these widths (880 tall at 1440), and stays put outside them */
  scaleWidths: [1100, 1800] as const,
  fade: { from: 460 / 880, step: 15 },          // opaque to 460 of 880, 1 - smoothstep to nothing at the box's bottom; a mask stop every 15 px
  upscaleMax: 1.5,                              // CSS px per file px drawn sharp; above this the art is blurred
  blur: { perExcess: 4, reach: 3 },             // blur = ceil(4 x (scale / 1.5 - 1)) CSS px; the art reaches 3 blur radii past the frame
  nonSteamKeep: 0.9,                            // art that is not a Steam library hero: only its top 90% is used
  anchor: {
    textGap: 24, textBottom: 528,               // behind the text = left of the text's right edge + 24, from 24 above the identity to 24 below the actions (504)
    clearRight: 100,                            // beside the text = from there to 100 px short of the right edge; the last 100 px are the frame edge
    behindText: -2, beside: 1, edge: -1,        // weights of subject mass (off-frame and elsewhere: 0)
    step: 2, pillsBottom: 96, subjectTopGap: 24, subjectTopShare: 0.1,
  },
  map: { width: 480, fine: [2, 24] as const, coarse: [6, 48] as const, meanBlur: 3 },
  scrimTop: [[0, 0.72], [120, 0.5], [240, 0]] as [number, number][],                        // fixed, the Home's
  /** the Home's horizontal profile = strength 1. The .1 stop sits at max(1100, W - 340) and the .5 at the right edge, so at 1440
   *  it is the board's (1100, 1440) and on other widths the right edge keeps its darkening */
  scrimH: (W: number): [number, number][] => { const a = Math.max(1100, W - 340); return [[0, 0.9], [560, 0.84], [740, 0.56], [940, 0.16], [a, 0.1], [Math.max(W, a), 0.5]]; },
  strengthStep: 0.02,
  id: { width: 580, height: 140, bottom: 380 },  // the identity box; facts 404-428, actions 456-504 (on the 148 bar)
  logo: {
    boxAlpha: 16, inkAlpha: 128, opaque: 0.9, share: 1 / 3,
    visibleLevels: 3,                            // a logo pixel is visible where it changes the backdrop by 3 or more levels (of 255)
    legible: 1.5,                                // ink = pixels that reach 1.5:1 against the backdrop behind them; glow and shadow stay below
    loudLevels: 24,                              // a pixel that changes the backdrop by 24+ levels (or reaches 1.5:1) stands out: it is ink, it never hangs
    edgeGuard: 0.67,                             // with glow hanging before it, the ink edge sits one device px (at 1.5x) inside the content edge
    faceDE: 20, faceMinShare: 0.01, faceStroke: 8, faceStrokeRel: 0.5, faceQuantile: 0.5,
    monoSpread: 0.1, recolour: "brightness(0) invert(0.949)", recolourRgb: [242, 242, 242] as [number, number, number],
  },
  title: { lineHeight: 1.06, letterSpacing: -0.02, maxLines: 2, min: 16, max: 160, color: "#f2f2f2" },
  target: { text: 4.5, identity: 3, icon: 3, margin: 1.03 },
  topStrengths: [1, 1.1, 1.2, 1.3],
  dpr: 1.5,                                      // device px per CSS px for every pixel measurement (the renders are 1.5x)
  frameRgb: [16, 16, 16] as [number, number, number],
};

/** where the stage is drawn: its width, the art box, the content edge and how far the bar moved everything */
export interface Geometry { W: number; boxH: number; fadeFrom: number; fadeTo: number; left: number; bar: number; dy: number }
export function geometryFor(W: number, bar = 148, left = 48): Geometry {
  const [lo, hi] = RULE.scaleWidths, b = RULE.board;
  const boxH = Math.round(b.boxH * Math.min(hi, Math.max(lo, W)) / b.w);
  return { W, boxH, fadeFrom: Math.round(boxH * RULE.fade.from), fadeTo: boxH, left, bar, dy: bar - b.bar };
}

export const smoothstep = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
export const round2 = (v: number) => Math.round(v * 100) / 100;

// ---------- 1. backdrop placement ----------
export interface Placement {
  fromSteam: boolean; winH: number; s: number; boxH: number; blur: number; reach: number; fadeFrom: number; fadeTo: number;
  dispW: number; dispH: number; oxMin: number; oxMax: number; oyMin: number; oyMax: number; W: number;
}
/** cover the W x boxH box; above 1.5 CSS px per file px the art is still drawn covering, blurred, and reaching 3 blur radii past
 *  the frame on the left, right and top so the blur's soft border never shows */
export function placement(banner: { w: number; h: number }, fromSteam: boolean, geo: Geometry): Placement {
  const winH = fromSteam ? banner.h : Math.round(banner.h * RULE.nonSteamKeep), W = banner.w, BW = geo.W, BH = geo.boxH;
  let s = Math.max(BW / W, BH / winH), blur = 0, reach = 0;
  if (s > RULE.upscaleMax) {
    blur = Math.ceil(RULE.blur.perExcess * (s / RULE.upscaleMax - 1));
    reach = RULE.blur.reach * blur;
    s = Math.max((BW + 2 * reach) / W, (BH + reach) / winH);
  }
  return { fromSteam, winH, s, boxH: BH, blur, reach, fadeFrom: geo.fadeFrom, fadeTo: geo.fadeTo, dispW: W * s, dispH: banner.h * s,
    oxMin: reach, oxMax: W * s - BW - reach, oyMin: reach, oyMax: winH * s - BH, W: BW };
}
export const maskAt = (pl: { fadeFrom: number; fadeTo: number }, Y: number) => (Y < pl.fadeFrom ? 1 : Y >= pl.fadeTo ? 0 : 1 - smoothstep((Y - pl.fadeFrom) / (pl.fadeTo - pl.fadeFrom)));

// ---------- 2. subject map + anchor ----------
export interface SubjectMap { w: number; h: number; S: Float32Array }
/** mean of three normalised contrast maps of a 480-px-wide copy of the used window: fine centre-surround colour contrast (Lab,
 *  Gaussian sigma 2 vs 24 px), coarse centre-surround (6 vs 48 px), distance from the mean colour (sigma 3) */
export function subjectMap(win: Rgba): SubjectMap {
  const sm = P.shrink(win, RULE.map.width), w = sm.w, h = sm.h, n = w * h;
  const L = P.labPlane(sm), comps: Float32Array[] = [];
  for (const [a, b] of [RULE.map.fine, RULE.map.coarse]) {
    const c = P.gauss(L, w, h, 3, a), su = P.gauss(L, w, h, 3, b), S = new Float32Array(n);
    for (let i = 0; i < n; i++) S[i] = Math.hypot(c[i * 3] - su[i * 3], c[i * 3 + 1] - su[i * 3 + 1], c[i * 3 + 2] - su[i * 3 + 2]);
    comps.push(S);
  }
  const c = P.gauss(L, w, h, 3, RULE.map.meanBlur), m = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) m[k] += L[i * 3 + k] / n;
  const F = new Float32Array(n); for (let i = 0; i < n; i++) F[i] = Math.hypot(c[i * 3] - m[0], c[i * 3 + 1] - m[1], c[i * 3 + 2] - m[2]);
  comps.push(F);
  const S = new Float32Array(n);
  for (const C of comps) { let mean = 0; for (let i = 0; i < n; i++) mean += C[i] / n; for (let i = 0; i < n; i++) S[i] += C[i] / (mean || 1) / comps.length; }
  return { w, h, S };
}

/** the text the pan keeps the subject beside: its right edge (+24) and its top (the identity's top - 24) */
export interface TextArea { right: number; top: number }

/** weight of subject mass at stage position (X, Y): behind the text (identity, facts, actions) -2, beside it +1, against the
 *  right frame edge -1, else 0 (rule.js anchorWeight, on a stage of width geo.W) */
export function anchorWeight(X: number, Y: number, text: TextArea, geo: Geometry) {
  const A = RULE.anchor;
  if (X < 0 || X >= geo.W) return 0;
  if (X < text.right) return Y >= text.top && Y <= A.textBottom + geo.dy ? A.behindText : 0;
  return X < geo.W - A.clearRight ? A.beside : A.edge;
}

export interface Anchor { ox: number; oy: number; subjectTop: number | null; score: number; textSeen: number; centre: number; subject: Subject | null }
/** what the room beside the text shows: the centre of its subject mass as a fraction of the art's width (x), and where that point
 *  stands in the room (at: 0 on the text's edge, 1 on the clear edge, 100 px short of the frame's right edge) */
export interface Subject { x: number; at: number }
/**
 * every pan in 2 px steps scored by summing the map over the visible art, rows weighted by the fade (anchorWeight); the best score
 * wins, a tie goes to the centred pan. The sum is the generator's, regrouped: per map column, the fade-weighted mass of every
 * visible row and of the rows in the text band, as prefix sums, so each pan costs a few lookups instead of a pass over the map.
 *
 * keep (every stage but the board's, decide.ts): the board's stage has chosen the subject, so this one keeps it where the board
 * has it: the pan puts that point of the art (keep.x) at the same place in this room (keep.at), on the 2 px grid, as near as the
 * art's edges allow. Scored alone, a narrow stage's small room would rather push the subject off the frame (nothing there counts)
 * than let any of it stand behind the text (DARK SOULS III and Find The Needle panned to 0 at 1000 px), and stages either side of
 * a width could pick different subjects (Endacopia: its sign below 1440, its hero at 1440).
 */
export function anchor(map: SubjectMap, pl: Placement, text: TextArea, geo: Geometry, keep: Subject | null = null): Anchor {
  const { w, h, S } = map, A = RULE.anchor, textBottom = A.textBottom + geo.dy;
  const kx = pl.dispW / w, ky = (pl.winH * pl.s) / h;   // CSS px per map px (the map covers the used window)
  const oxLo = Math.ceil(pl.oxMin), oxHi = Math.floor(pl.oxMax), oyBase = Math.ceil(pl.oyMin), centre = (pl.oxMin + pl.oxMax) / 2;
  const all = new Float64Array(w), band = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    const Y = (y + 0.5) * ky - oyBase; if (Y < 0 || Y >= pl.boxH) continue;
    const m = maskAt(pl, Y); if (!m) continue;
    const inBand = Y >= text.top && Y <= textBottom;
    for (let x = 0; x < w; x++) { const v = m * S[y * w + x]; all[x] += v; if (inBand) band[x] += v; }
  }
  const PA = new Float64Array(w + 1), PB = new Float64Array(w + 1);
  for (let x = 0; x < w; x++) { PA[x + 1] = PA[x] + all[x]; PB[x + 1] = PB[x] + band[x]; }
  // the first map column whose centre lands at or right of stage x t (the generator's own expression decides the edge)
  const first = (t: number, ox: number) => {
    let x = Math.max(0, Math.min(w, Math.ceil((t + ox) / kx - 0.5)));
    while (x > 0 && (x - 1 + 0.5) * kx - ox >= t) x--;
    while (x < w && (x + 0.5) * kx - ox < t) x++;
    return x;
  };
  const clear = geo.W - A.clearRight;
  const scoreX = (ox: number) => {
    const c0 = first(0, ox), c1 = Math.max(c0, first(text.right, ox)), c3 = first(geo.W, ox), c2 = Math.min(c3, Math.max(c1, first(clear, ox)));
    const c1c = Math.min(c1, c3);
    return A.behindText * (PB[c1c] - PB[c0]) + A.beside * (PA[c2] - PA[c1c]) + A.edge * (PA[c3] - PA[c2]);
  };
  let best: { ox: number; sc: number; cen: number } | null = null;
  const room = clear - text.right;
  if (keep && room > 0 && oxHi >= oxLo) {
    const t = Math.max(oxLo, Math.min(oxHi, keep.x * pl.dispW - text.right - keep.at * room));
    let ox = oxLo + Math.round((t - oxLo) / A.step) * A.step;
    if (ox > oxHi) ox -= A.step;
    best = { ox, sc: scoreX(ox), cen: Math.abs(ox - centre) };
  } else for (let ox = oxLo; ox <= oxHi; ox += A.step) {
    const sc = scoreX(ox), cen = Math.abs(ox - centre);
    if (!best || sc > best.sc + 1e-9 || (Math.abs(sc - best.sc) <= 1e-9 && cen < best.cen)) best = { ox, sc, cen };
  }
  if (!best) best = { ox: Math.round(Math.max(pl.oxMin, Math.min(pl.oxMax, centre))), sc: 0, cen: 0 };
  // vertical (only art taller than its box): the subject's top is the row where the mass beside the text, counted from the top of
  // the art, reaches 10% of its total; the art moves up just far enough to put that row 24 px below the pills
  let oy = oyBase, subjectTop: number | null = null;
  const roomY = Math.floor(pl.oyMax - oyBase);
  if (roomY > 0) {
    const rows = new Float64Array(h); let tot = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const X = (x + 0.5) * kx - best.ox; if (X >= text.right && X < geo.W) { rows[y] += S[y * w + x]; tot += S[y * w + x]; } }
    let acc = 0, yTop = 0; for (let y = 0; y < h; y++) { acc += rows[y]; if (acc >= A.subjectTopShare * tot) { yTop = y; break; } }
    subjectTop = (yTop + 0.5) * ky;
    oy = Math.round(Math.max(oyBase, Math.min(pl.oyMax, subjectTop - (A.pillsBottom + geo.dy / 2 + A.subjectTopGap))));
  }
  let tot = 0; for (let i = 0; i < S.length; i++) tot += S[i];
  // the subject the chosen pan shows beside the text: the centre of the room's mass (map columns, fade-weighted rows)
  let subject: Subject | null = null;
  if (room > 0) {
    const c1 = Math.min(w, first(text.right, best.ox)), c2 = Math.max(c1, Math.min(first(geo.W, best.ox), first(clear, best.ox)));
    let m = 0, mx = 0;
    for (let x = c1; x < c2; x++) { m += all[x]; mx += all[x] * (x + 0.5); }
    if (m > 0) subject = { x: mx / m / w, at: ((mx / m) * kx - best.ox - text.right) / room };
  }
  return { ox: best.ox, oy, subjectTop, score: best.sc / (tot || 1), textSeen: 0, centre, subject };
}

// ---------- 3. the stage as it will be painted (model) ----------
export const lerpStops = (stops: [number, number][], v: number) => {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) { const [x0, a0] = stops[i - 1], [x1, a1] = stops[i]; return x1 === x0 ? a1 : a0 + (a1 - a0) * (v - x0) / (x1 - x0); }
  return stops[stops.length - 1][1];
};

/** the art as drawn, sampled at RULE.dpr over the art box: row(j) gives device row j (gamma RGB floats) */
export interface ArtLayer { w: number; h: number; row: (j: number) => Float32Array }
/** the art drawn at its placement (blurred when the rule blurs it) */
export function artLayer(banner: Rgba, pl: Placement, ox: number, oy: number): ArtLayer {
  if (!pl.blur) return P.placeLazy(banner, pl.s, -ox, -oy, 0, 0, pl.W, pl.boxH, RULE.dpr);
  const R = pl.reach, D = RULE.dpr;
  const big: Plane = P.place(banner, pl.s, -ox, -oy, -R, -R, pl.W + 2 * R, pl.boxH + 2 * R, D);
  const bl = P.gauss(big.d, big.w, big.h, 3, pl.blur * D);
  const W = Math.round(pl.W * D), H = Math.round(pl.boxH * D), o = Math.round(R * D);
  const rows = new Map<number, Float32Array>();
  return { w: W, h: H, row: (j: number) => { let r = rows.get(j); if (!r) { r = bl.slice(((j + o) * big.w + o) * 3, ((j + o) * big.w + o + W) * 3); rows.set(j, r); } return r; } };
}
/** the same layer converted to Display P3 (row by row, when asked) */
export function artLayerP3(layer: ArtLayer): ArtLayer {
  const rows = new Map<number, Float32Array>();
  return { w: layer.w, h: layer.h, row: (j: number) => {
    let r = rows.get(j); if (r) return r;
    const s = layer.row(j); r = new Float32Array(s.length);
    for (let i = 0; i < s.length; i += 3) P.toP3(s[i], s[i + 1], s[i + 2], r, i);
    rows.set(j, r); return r;
  } };
}

/** bd(i, j, out): the sRGB of device pixel (i, j) blended in sRGB; bd.p3: the sRGB of the same pixel blended in P3 */
export interface Backdrop { (i: number, j: number, out: number[]): number[]; p3: ((i: number, j: number, out: number[]) => number[]) | null; k: number; topK: number }
/** The model blends exactly as CSS does (in gamma-encoded values) and evaluates it twice: blended in sRGB (an sRGB display) and
 *  blended in Display P3 (what Chromium does on a P3 display); every check keeps the worse of the two. */
export function makeBackdrop(layer: ArtLayer, pl: Placement, k: number, topK = 1, layerP3: ArtLayer | null = null): Backdrop {
  const D = RULE.dpr, W = Math.round(pl.W * D), H = Math.round(Math.max(RULE.board.h, pl.boxH) * D), f = RULE.frameRgb, stops = RULE.scrimH(pl.W);
  const hA = new Float32Array(W); for (let i = 0; i < W; i++) hA[i] = Math.min(1, k * lerpStops(stops, (i + 0.5) / D));
  const tA = new Float32Array(H), mA = new Float32Array(H);
  for (let j = 0; j < H; j++) { const Y = (j + 0.5) / D; tA[j] = Math.min(1, topK * lerpStops(RULE.scrimTop, Y)); mA[j] = maskAt(pl, Y); }
  const blend = (L: ArtLayer, i: number, j: number, out: number[]) => {
    if (i < 0) i = 0; else if (i >= L.w) i = L.w - 1;
    if (j < 0) j = 0;
    if (j >= L.h || j >= H) { out[0] = f[0]; out[1] = f[1]; out[2] = f[2]; return out; }
    const row = L.row(j), p = i * 3, t = tA[j], h = hA[Math.min(i, W - 1)], m = mA[j];
    for (let c = 0; c < 3; c++) { const c1 = t * f[c] + (1 - t) * row[p + c]; const c2 = h * f[c] + (1 - h) * c1; out[c] = m * c2 + (1 - m) * f[c]; }
    return out;
  };
  const bd = ((i: number, j: number, out: number[]) => blend(layer, i, j, out)) as Backdrop;
  const tmp = [0, 0, 0];
  bd.p3 = layerP3 ? (i: number, j: number, out: number[]) => { blend(layerP3, i, j, tmp); return P.fromP3(tmp[0], tmp[1], tmp[2], out) as number[]; } : null;
  bd.k = k; bd.topK = topK;
  return bd;
}

// ---------- 4. contrast checks against the model ----------
export interface Rect { l: number; t: number; r: number; b: number }
export type Ground = { kind: "direct" } | { kind: "glass"; rgb: number[]; alpha: number; rect: Rect } | { kind: "tint"; rgb: number[]; alpha: number };
export interface Run { who: string; text?: string; rgb: number[]; rects: Rect[]; ground: Ground; need: number; reportOnly?: boolean; title?: boolean }

/** the worst contrast of a run against the model (worse blend). A glass pill's ground is bounded by the brightest backdrop pixel
 *  under the pill under 60% #101010; a tint is mixed over each backdrop pixel. `glassMemo` shares a pill's ground between its runs. */
export function runContrast(bd: Backdrop, run: Run, glassMemo?: Map<string, number>): number {
  const one = (get: (i: number, j: number, out: number[]) => number[], tag: string) => {
    const D = RULE.dpr, px = [0, 0, 0];
    const fgL = P.lum(run.rgb[0], run.rgb[1], run.rgb[2]);
    const g = run.ground;
    if (g.kind === "glass") {
      const r = g.rect, key = `${tag}:${r.l},${r.t},${r.r},${r.b}`;
      let groundL = glassMemo?.get(key);
      if (groundL === undefined) {
        let best = -1, bestPx = [0, 0, 0];
        for (let j = Math.floor(r.t * D); j < Math.ceil(r.b * D); j++) for (let i = Math.floor(r.l * D); i < Math.ceil(r.r * D); i++) { get(i, j, px); const L = P.lum(px[0], px[1], px[2]); if (L > best) { best = L; bestPx = px.slice(); } }
        const a = g.alpha, f = g.rgb;
        groundL = P.lum(a * f[0] + (1 - a) * bestPx[0], a * f[1] + (1 - a) * bestPx[1], a * f[2] + (1 - a) * bestPx[2]);
        glassMemo?.set(key, groundL);
      }
      return P.ratio(fgL, groundL);
    }
    let worst = Infinity;
    for (const r of run.rects) {
      for (let j = Math.floor(r.t * D); j < Math.ceil(r.b * D); j++) for (let i = Math.floor(r.l * D); i < Math.ceil(r.r * D); i++) {
        get(i, j, px);
        let L: number;
        if (g.kind === "tint") { const a = g.alpha, f = g.rgb; L = P.lum(a * f[0] + (1 - a) * px[0], a * f[1] + (1 - a) * px[1], a * f[2] + (1 - a) * px[2]); }
        else L = P.lum(px[0], px[1], px[2]);
        const cr = P.ratio(fgL, L); if (cr < worst) worst = cr;
      }
    }
    return worst;
  };
  return Math.min(one(bd, "s"), bd.p3 ? one(bd.p3, "p") : Infinity);
}

/**
 * The strength a run needs, as an index into the 0.02 grid (0..50; 51 when not even strength 1 reads): the smallest strength from
 * which every stronger one reads too. Light text over art that only ever darkens toward #101010 gains contrast with every step, so
 * this is the generator's search for one run; the strength several runs need together is the largest of theirs.
 * `cols` (for the facts line): also report each device column's own index, so a line of any length can be read off.
 */
export interface StrengthCtx { layer: ArtLayer; layerP3: ArtLayer; pl: Placement; topK: number }
const STEPS = Math.round(1 / RULE.strengthStep);
export const strengthOf = (idx: number) => Math.round(idx * RULE.strengthStep * 1000) / 1000;
export function runThreshold(run: Run, cx: StrengthCtx, cols?: Map<number, number>): number {
  const D = RULE.dpr, f = RULE.frameRgb, pl = cx.pl, stops = RULE.scrimH(pl.W), Wd = Math.round(pl.W * D);
  const need = run.need * RULE.target.margin, fgL = P.lum(run.rgb[0], run.rgb[1], run.rgb[2]);
  const H = Math.round(Math.max(RULE.board.h, pl.boxH) * D);
  const tAt = (j: number) => Math.min(1, cx.topK * lerpStops(RULE.scrimTop, (j + 0.5) / D)), mAt = (j: number) => maskAt(pl, (j + 0.5) / D);
  const g = run.ground, px = [0, 0, 0];
  // the backdrop of device pixel (i, j) at strength index n, both blends, into s (sRGB blend) and p (P3 blend seen in sRGB)
  const s = [0, 0, 0], p = [0, 0, 0], q = [0, 0, 0];
  const backdrop = (i: number, j: number, n: number, t: number, m: number, prof: number) => {
    const h = Math.min(1, strengthOf(n) * prof);
    if (i < 0) i = 0; else if (i >= cx.layer.w) i = cx.layer.w - 1;
    if (j < 0) j = 0;
    if (j >= cx.layer.h || j >= H) { s[0] = f[0]; s[1] = f[1]; s[2] = f[2]; P.fromP3(f[0], f[1], f[2], p); return; }
    const a = cx.layer.row(j), b = cx.layerP3.row(j), o = i * 3;
    for (let c = 0; c < 3; c++) {
      const s1 = t * f[c] + (1 - t) * a[o + c], s2 = h * f[c] + (1 - h) * s1; s[c] = m * s2 + (1 - m) * f[c];
      const p1 = t * f[c] + (1 - t) * b[o + c], p2 = h * f[c] + (1 - h) * p1; q[c] = m * p2 + (1 - m) * f[c];
    }
    P.fromP3(q[0], q[1], q[2], p);
  };
  if (g.kind === "glass") {
    // the pill's ground is its brightest backdrop pixel under 60% #101010; it only darkens as the strength grows
    const r = g.rect, a = g.alpha, fr = g.rgb;
    const reads = (n: number) => {
      let best = -1; const bp = [0, 0, 0], bq = [0, 0, 0]; let bestP = -1;
      for (let j = Math.floor(r.t * D); j < Math.ceil(r.b * D); j++) {
        const t = tAt(j), m = mAt(j);
        for (let i = Math.floor(r.l * D); i < Math.ceil(r.r * D); i++) {
          backdrop(i, j, n, t, m, lerpStops(stops, (Math.min(i, Wd - 1) + 0.5) / D));
          const Ls = P.lum(s[0], s[1], s[2]); if (Ls > best) { best = Ls; bp[0] = s[0]; bp[1] = s[1]; bp[2] = s[2]; }
          const Lp = P.lum(p[0], p[1], p[2]); if (Lp > bestP) { bestP = Lp; bq[0] = p[0]; bq[1] = p[1]; bq[2] = p[2]; }
        }
      }
      const gs = P.lum(a * fr[0] + (1 - a) * bp[0], a * fr[1] + (1 - a) * bp[1], a * fr[2] + (1 - a) * bp[2]);
      const gp = P.lum(a * fr[0] + (1 - a) * bq[0], a * fr[1] + (1 - a) * bq[1], a * fr[2] + (1 - a) * bq[2]);
      return Math.min(P.ratio(fgL, gs), P.ratio(fgL, gp)) >= need;
    };
    if (!reads(STEPS)) return STEPS + 1;
    let lo = 0, hi = STEPS;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (reads(mid)) hi = mid; else lo = mid + 1; }
    return lo;
  }
  const pxReads = (i: number, j: number, n: number, t: number, m: number, prof: number) => {
    backdrop(i, j, n, t, m, prof);
    if (g.kind === "tint") {
      const a = g.alpha, fr = g.rgb;
      for (let c = 0; c < 3; c++) { px[c] = a * fr[c] + (1 - a) * s[c]; q[c] = a * fr[c] + (1 - a) * p[c]; }
      return Math.min(P.ratio(fgL, P.lum(px[0], px[1], px[2])), P.ratio(fgL, P.lum(q[0], q[1], q[2]))) >= need;
    }
    return Math.min(P.ratio(fgL, P.lum(s[0], s[1], s[2])), P.ratio(fgL, P.lum(p[0], p[1], p[2]))) >= need;
  };
  let worst = 0;
  for (const r of run.rects) {
    const i0 = Math.floor(r.l * D), i1 = Math.ceil(r.r * D);
    for (let i = i0; i < i1; i++) {
      const prof = lerpStops(stops, (Math.min(Math.max(i, 0), Wd - 1) + 0.5) / D);
      let col = cols ? 0 : worst;
      for (let j = Math.floor(r.t * D); j < Math.ceil(r.b * D) && col <= STEPS; j++) {
        const t = tAt(j), m = mAt(j);
        if (pxReads(i, j, col, t, m, prof)) continue;                          // reads at what is needed already: nothing new
        if (!pxReads(i, j, STEPS, t, m, prof)) { col = STEPS + 1; break; }
        let lo = col + 1, hi = STEPS;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (pxReads(i, j, mid, t, m, prof)) hi = mid; else lo = mid + 1; }
        col = lo;
      }
      if (cols) cols.set(i, Math.max(cols.get(i) ?? 0, col));
      if (col > worst) worst = col;
    }
  }
  return worst;
}

// ---------- 5. identity ----------
export interface Box { x: number; y: number; w: number; h: number }
export const bboxAlpha = (logo: Rgba, thr: number): Box | null => {
  let x0 = logo.w, y0 = logo.h, x1 = -1, y1 = -1;
  for (let y = 0; y < logo.h; y++) for (let x = 0; x < logo.w; x++) if (logo.d[(y * logo.w + x) * 4 + 3] >= thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};

export interface LogoFacts { visibleBox: Box; inkBox: Box; coverage: number; spread: number; mono: boolean; opaque: boolean }
/** what the file says before any backdrop: the 6%-opaque box, ink coverage of it, one colour or several */
export function logoFacts(logo: Rgba): LogoFacts | null {
  const vis = bboxAlpha(logo, RULE.logo.boxAlpha), ink = bboxAlpha(logo, RULE.logo.inkAlpha);
  if (!vis || !ink) return null;
  let cov = 0; const inkL: number[] = [];
  for (let y = vis.y; y < vis.y + vis.h; y++) for (let x = vis.x; x < vis.x + vis.w; x++) { const p = (y * logo.w + x) * 4; if (logo.d[p + 3] >= RULE.logo.inkAlpha) { cov++; inkL.push(P.lum(logo.d[p], logo.d[p + 1], logo.d[p + 2])); } }
  if (!inkL.length) return null;
  inkL.sort((a, b) => a - b);
  const q = (f: number) => inkL[Math.min(inkL.length - 1, Math.floor(f * inkL.length))];
  const coverage = cov / (vis.w * vis.h), spread = q(0.9) - q(0.1);
  return { visibleBox: vis, inkBox: ink, coverage, spread, mono: spread <= RULE.logo.monoSpread, opaque: coverage >= RULE.logo.opaque };
}

export interface Fit { box: Box; inkX: number; k: number; dw: number; dh: number; hang: number; inkW: number; left: number; top: number; iterations?: number }
/** size and place a crop: the ink (from column inkX to the crop's right edge) is contain-fitted into 580 x 140, never above the
 *  file's pixels; the ink starts at the content edge and the crop's columns left of inkX (glow, shadow) hang into the margin.
 *  When glow hangs before the ink, the ink edge sits one device pixel (0.67 CSS px) inside the content edge. */
export function fitCrop(box: Box, inkX: number, geo: Geometry): Fit {
  const guard = inkX > box.x ? RULE.logo.edgeGuard : 0;
  const k = Math.min((RULE.id.width - guard) / (box.x + box.w - inkX), RULE.id.height / box.h, 1);
  const dw = Math.round(box.w * k * 100) / 100, dh = Math.round(box.h * k * 100) / 100;
  const hang = Math.round(Math.max(0, (inkX - box.x) * k - guard) * 100) / 100;
  return { box, inkX, k, dw, dh, hang, inkW: Math.round((dw - hang) * 100) / 100, left: geo.left - hang, top: RULE.id.bottom + geo.dy - dh };
}

/** the crop, measured against the backdrop it will sit on (the text's strength and 1; blended in sRGB): the visible box holds every
 *  pixel that changes the backdrop by 3+ levels; ink is every pixel that reaches 1.5:1. Placement and crop depend on each other:
 *  iterate from the 6%-opaque box until they agree. */
export function logoCrop(logo: Rgba, bds: Backdrop[], recolour: boolean, geo: Geometry): Fit {
  const L = RULE.logo, D = RULE.dpr, all = bboxAlpha(logo, 1)!, px = [0, 0, 0], rc = L.recolourRgb;
  const box = bboxAlpha(logo, L.boxAlpha)!, ink = bboxAlpha(logo, L.inkAlpha)!;
  let fit = fitCrop(box, ink.x, geo), it = 0;
  for (; it < 8; it++) {
    let x0 = logo.w, y0 = logo.h, x1 = -1, y1 = -1, inkX = logo.w;
    for (let y = all.y; y < all.y + all.h; y++) for (let x = all.x; x < all.x + all.w; x++) {
      const p = (y * logo.w + x) * 4, a = logo.d[p + 3]; if (!a) continue;
      const al = a / 255, X = fit.left + (x - fit.box.x + 0.5) * fit.k, Y = fit.top + (y - fit.box.y + 0.5) * fit.k;
      const i0 = recolour ? rc[0] : logo.d[p], i1 = recolour ? rc[1] : logo.d[p + 1], i2 = recolour ? rc[2] : logo.d[p + 2];
      let dmax = 0, cmax = 1;
      for (const bd of bds) {
        bd(Math.floor(X * D), Math.floor(Y * D), px);
        const e0 = al * i0 + (1 - al) * px[0], e1 = al * i1 + (1 - al) * px[1], e2 = al * i2 + (1 - al) * px[2];
        const d = Math.max(Math.abs(e0 - px[0]), Math.abs(e1 - px[1]), Math.abs(e2 - px[2])); if (d > dmax) dmax = d;
        const c = P.ratio(P.lum(e0, e1, e2), P.lum(px[0], px[1], px[2])); if (c > cmax) cmax = c;
      }
      if (dmax >= L.visibleLevels) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (cmax >= L.legible && x < inkX) inkX = x;
    }
    if (x1 < 0) break;
    const nb = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, ni = inkX > x1 ? x0 : Math.max(x0, inkX);
    const same = nb.x === fit.box.x && nb.y === fit.box.y && nb.w === fit.box.w && nb.h === fit.box.h && ni === fit.inkX;
    fit = fitCrop(nb, ni, geo);
    if (same) break;
  }
  return { ...fit, iterations: it + 1 };
}

/** where the logo first stands out at a given strength: the first column (file px) holding a pixel that changes the backdrop
 *  behind it by 24 levels or more or reaches 1.5:1, either blend; and the loudest change among the columns before the lettering */
export function logoEdge(logo: Rgba, fit: Fit, bd: Backdrop, recolour: boolean) {
  const L = RULE.logo, D = RULE.dpr, b = fit.box, px = [0, 0, 0], q = [0, 0, 0], i3 = [0, 0, 0], e = [0, 0, 0], rc = L.recolourRgb;
  let loud = b.x + b.w, quietMax = 0;
  for (let x = b.x; x < b.x + b.w && x < loud; x++) for (let y = b.y; y < b.y + b.h; y++) {
    const p = (y * logo.w + x) * 4, a = logo.d[p + 3]; if (!a) continue;
    const al = a / 255, X = fit.left + (x - b.x + 0.5) * fit.k, Y = fit.top + (y - b.y + 0.5) * fit.k, I = Math.floor(X * D), J = Math.floor(Y * D);
    const ink = recolour ? rc : [logo.d[p], logo.d[p + 1], logo.d[p + 2]];
    bd(I, J, px);
    for (let k = 0; k < 3; k++) e[k] = al * ink[k] + (1 - al) * px[k];
    let d = Math.max(Math.abs(e[0] - px[0]), Math.abs(e[1] - px[1]), Math.abs(e[2] - px[2])), c = P.ratio(P.lum(e[0], e[1], e[2]), P.lum(px[0], px[1], px[2]));
    if (bd.p3) {
      bd.p3(I, J, px); P.toP3(ink[0], ink[1], ink[2], i3); P.toP3(px[0], px[1], px[2], q);
      P.fromP3(al * i3[0] + (1 - al) * q[0], al * i3[1] + (1 - al) * q[1], al * i3[2] + (1 - al) * q[2], e);
      d = Math.max(d, Math.abs(e[0] - px[0]), Math.abs(e[1] - px[1]), Math.abs(e[2] - px[2])); c = Math.max(c, P.ratio(P.lum(e[0], e[1], e[2]), P.lum(px[0], px[1], px[2])));
    }
    if (d >= L.loudLevels || c >= L.legible) { loud = x; break; }
    if (x < fit.inkX && d > quietMax) quietMax = d;
  }
  return { loud, quietMax };
}

/** logo pixels placed on the stage: the contrast of each composite against its backdrop pixel, worse blend (cr) and sRGB (crS).
 *  Backdrop pixels are converted once per device pixel (many logo pixels share one when the logo is drawn smaller than its file). */
export interface LogoPx { cr: Float32Array; crS: Float32Array; alpha: Uint8Array }
export function logoPixels(logo: Rgba, fit: Fit, bd: Backdrop, recolour: boolean): LogoPx {
  const D = RULE.dpr, b = fit.box, px = [0, 0, 0], e = [0, 0, 0], i3 = [0, 0, 0], rc = RULE.logo.recolourRgb;
  const n = b.w * b.h, cr = new Float32Array(n), crS = new Float32Array(n), alpha = new Uint8Array(n);
  // the device pixels the crop covers, each with its backdrop (sRGB blend), its P3-blend seen in sRGB, and that one back in P3
  const I0 = Math.floor((fit.left + 0.5 * fit.k) * D), J0 = Math.floor((fit.top + 0.5 * fit.k) * D);
  const I1 = Math.floor((fit.left + (b.w - 0.5) * fit.k) * D), J1 = Math.floor((fit.top + (b.h - 0.5) * fit.k) * D);
  const cw = I1 - I0 + 1, ch = J1 - J0 + 1, cache = new Float32Array(cw * ch * 10);   // [done, sR, sG, sB, sL, pR, pG, pB, qR..qB] packed below
  const got = new Uint8Array(cw * ch), qv = new Float32Array(cw * ch * 3), pl = new Float32Array(cw * ch);
  const cell = (I: number, J: number) => {
    const c = (J - J0) * cw + (I - I0);
    if (!got[c]) {
      bd(I, J, px); cache[c * 10] = px[0]; cache[c * 10 + 1] = px[1]; cache[c * 10 + 2] = px[2]; cache[c * 10 + 3] = P.lum(px[0], px[1], px[2]);
      if (bd.p3) { bd.p3(I, J, px); cache[c * 10 + 4] = px[0]; cache[c * 10 + 5] = px[1]; cache[c * 10 + 6] = px[2]; pl[c] = P.lum(px[0], px[1], px[2]); P.toP3(px[0], px[1], px[2], qv, c * 3); }
      got[c] = 1;
    }
    return c;
  };
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
    const p = ((y + b.y) * logo.w + x + b.x) * 4, a = logo.d[p + 3], i = y * b.w + x; alpha[i] = a; if (!a) continue;
    const al = a / 255, X = fit.left + (x + 0.5) * fit.k, Y = fit.top + (y + 0.5) * fit.k, I = Math.floor(X * D), J = Math.floor(Y * D);
    const r = recolour ? rc[0] : logo.d[p], g = recolour ? rc[1] : logo.d[p + 1], bl = recolour ? rc[2] : logo.d[p + 2];
    const c = cell(I, J), o = c * 10;
    const s = P.ratio(P.lum(al * r + (1 - al) * cache[o], al * g + (1 - al) * cache[o + 1], al * bl + (1 - al) * cache[o + 2]), cache[o + 3]);
    let v = s;
    if (bd.p3) {
      P.toP3(r, g, bl, i3);
      P.fromP3(al * i3[0] + (1 - al) * qv[c * 3], al * i3[1] + (1 - al) * qv[c * 3 + 1], al * i3[2] + (1 - al) * qv[c * 3 + 2], e);
      v = Math.min(s, P.ratio(P.lum(e[0], e[1], e[2]), pl[c]));
    }
    cr[i] = v; crS[i] = s;
  }
  return { cr, crS, alpha };
}

/** share of the ink (alpha >= 128 inside the crop) that reaches 3:1 against the backdrop pixel behind it, worse blend */
export function logoShare(lp: LogoPx) {
  const { cr, alpha } = lp, need = RULE.target.identity * RULE.target.margin, crs: number[] = [];
  let n = 0, ok = 0;
  for (let i = 0; i < cr.length; i++) { if (alpha[i] < RULE.logo.inkAlpha) continue; n++; if (cr[i] >= need) ok++; crs.push(cr[i]); }
  crs.sort((a, c) => a - c);
  return { share: n ? ok / n : 0, n, p25: crs[Math.floor(crs.length * 0.25)] || 0, p50: crs[Math.floor(crs.length * 0.5)] || 0, p75: crs[Math.floor(crs.length * 0.75)] || 0 };
}

export interface Face { share: number; stroke: number; x: number; y: number; w: number; h: number; lab: number[]; q: number; p50: number }
/** faces: the legible ink (1.5:1 or more against the backdrop) split into colour regions (8-neighbours join while their own colours
 *  differ by less than dE 20); a region holding 1% or more of the legible ink whose stroke (twice its largest inscribed radius,
 *  CSS px) is at least min(8, half the widest stroke) is a face. Every face must reach 3:1 at its median (worse blend, 3% margin). */
export function logoFaces(logo: Rgba, fit: Fit, lp: LogoPx, recolour: boolean) {
  const L = RULE.logo, b = fit.box, W = b.w, H = b.h, n = W * H, { cr, crS, alpha } = lp;
  const leg = new Uint8Array(n), lb = new Float32Array(n * 3); let nLeg = 0;
  const rcLab = P.lab(...L.recolourRgb);
  for (let i = 0; i < n; i++) {
    if (!alpha[i] || crS[i] < L.legible) continue; leg[i] = 1; nLeg++;
    const x = i % W, y = (i - x) / W, p = ((y + b.y) * logo.w + x + b.x) * 4;
    const v = recolour ? rcLab : P.lab(logo.d[p], logo.d[p + 1], logo.d[p + 2]); lb[i * 3] = v[0]; lb[i * 3 + 1] = v[1]; lb[i * 3 + 2] = v[2];
  }
  if (!nLeg) return { pass: false, faces: [] as Face[], legible: 0, minStroke: 0, worst: null as Face | null };
  const par = new Int32Array(n); for (let i = 0; i < n; i++) par[i] = i;
  const find = (i: number) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const NB = [[1, 0], [0, 1], [1, 1], [-1, 1]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!leg[i]) continue;
    for (const [dx, dy] of NB) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || xx >= W || yy >= H) continue; const j = yy * W + xx; if (!leg[j]) continue;
      if (Math.hypot(lb[i * 3] - lb[j * 3], lb[i * 3 + 1] - lb[j * 3 + 1], lb[i * 3 + 2] - lb[j * 3 + 2]) < L.faceDE) { const a = find(i), c = find(j); if (a !== c) par[a < c ? c : a] = a < c ? a : c; }
    }
  }
  const groups = new Map<number, number[]>(); for (let i = 0; i < n; i++) if (leg[i]) { const r = find(i); let g = groups.get(r); if (!g) { g = []; groups.set(r, g); } g.push(i); }
  const regions: Face[] = [];
  for (const mem of groups.values()) {
    if (mem.length < L.faceMinShare * nLeg) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0; for (const i of mem) { const x = i % W, y = (i - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const bw = x1 - x0 + 3, bh = y1 - y0 + 3, Dd = new Float32Array(bw * bh);
    for (const i of mem) { const x = i % W, y = (i - x) / W; Dd[(y - y0 + 1) * bw + x - x0 + 1] = 1e9; }
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const i = y * bw + x; if (!Dd[i]) continue; Dd[i] = Math.min(Dd[i], Dd[i - 1] + 1, Dd[i - bw] + 1, Dd[i - bw - 1] + 1.4142, Dd[i - bw + 1] + 1.4142); }
    let mx = 0;
    for (let y = bh - 1; y >= 0; y--) for (let x = bw - 1; x >= 0; x--) { const i = y * bw + x; if (!Dd[i]) continue; Dd[i] = Math.min(Dd[i], Dd[i + 1] + 1, Dd[i + bw] + 1, Dd[i + bw + 1] + 1.4142, Dd[i + bw - 1] + 1.4142); if (Dd[i] > mx) mx = Dd[i]; }
    const vals = mem.map((i) => cr[i]).sort((a, c) => a - c);
    let l = 0, aa = 0, bb = 0; for (const i of mem) { l += lb[i * 3]; aa += lb[i * 3 + 1]; bb += lb[i * 3 + 2]; }
    regions.push({ share: mem.length / nLeg, stroke: 2 * mx * fit.k, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, lab: [l, aa, bb].map((v) => Math.round(v / mem.length)),
      q: vals[Math.min(vals.length - 1, Math.floor(vals.length * L.faceQuantile))], p50: vals[Math.floor(vals.length / 2)] });
  }
  const widest = Math.max(0, ...regions.map((r) => r.stroke)), minStroke = Math.min(L.faceStroke, L.faceStrokeRel * widest);
  const faces = regions.filter((r) => r.stroke >= minStroke), need = RULE.target.identity * RULE.target.margin;
  return { pass: faces.length > 0 && faces.every((f) => f.q >= need), faces, minStroke, legible: nLeg, worst: faces.reduce<Face | null>((m, f) => (!m || f.q < m.q ? f : m), null) };
}

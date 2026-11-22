/**
 * Cards — colour: HSL <-> RGB, WCAG contrast, the art's swatches and the card colour rule (the recipe's colour.cjs).
 *
 * THE CARD COLOUR (one function of a game's art, computed once per game; every view uses it)
 *   pool      the pixels the colour must sit next to: for a cut-out, the backdrop the cut removed (the whole image when
 *             that backdrop is near-grey); for a dissolve, the art on the reference card with the band it melts into
 *             counted 2.5x (recipe.ts builds the pool).
 *   swatches  for a cut-out, hue peaks of the backdrop's chroma^2-weighted, 72-bin (5 deg) hue histogram (gaussian
 *             smoothing); for a dissolve, the chroma-weighted 36-bin histogram of the reference card art (band x2.5).
 *             Each peak keeps its share, saturation and mean chroma.
 *   choice    the strongest swatch, except: a greyish swatch (mean chroma < 0.16) in the olive band 45-100 deg steps
 *             aside (it turns pea or mustard); over a dark dissolve band (median L < 0.3) an orange or gold swatch
 *             (15-70 deg) yields to a cool or red one with >= 15 % of its weight (orange darkens into brown).
 *   S         0.45 + 0.6 x the swatch's median saturation, clamped to 0.55-0.82.
 *   L         solved as drawn (grain and gradient included): the lightest L <= 0.58 (>= 0.47) at which the white
 *             title and status reach 4.7:1 on the lightest pixel behind them; otherwise near-black ink (#141414,
 *             status at 90 %) at the L nearest 0.56 (0.47-0.64) where both reach 4.7:1 on the darkest one. The
 *             card gradient (L+0.01 to L-0.02) then stays inside 0.45-0.65.
 *   grey art  (pool mean chroma < 0.07): its strongest tint outside 15-100 deg (taupe and olive read as mud; the
 *             opposite of its strongest hue when none) at S 0.22, L solved the same way in 0.42-0.59.
 */

export type RGB = [number, number, number];
export interface Swatch { hue: number; share: number; sat: number; chroma: number; light: number; strong?: number; opposite?: boolean }
export interface SwatchSet { swatches: Swatch[]; meanChroma: number; medianL?: number }
export type Ink = "white" | "ink";
export interface CardColour {
  h: number; s: number; l: number; grey: boolean; pick: number; options: number; ink: Ink;
  base: RGB; top: RGB; bottom: RGB; text: string; status: string;
  contrast: { title: number; status: number };
  swatch: { hue: number; share: number; sat: number; chroma: number };
}

export function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
export function hsl2rgb(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
export function luminance([r, g, b]: readonly number[]): number { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
export function contrast(a: readonly number[], b: readonly number[]): number { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
export function mix(a: readonly number[], b: readonly number[], t: number): RGB { return [0, 1, 2].map(i => Math.round(a[i] * (1 - t) + b[i] * t)) as RGB; }
export const hex = (c: readonly number[]) => "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");
export const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** Swatches of an image region: pixels (r,g,b) with weights; each pixel weighted by chroma^2 within a lightness
 * window, hue histogram of 72 bins (5 deg), circular gaussian smoothing (sigma 2 bins), local maxima are the swatches. */
export function swatches(pixels: ArrayLike<number>, weights: ArrayLike<number> | null): SwatchSet {
  const B = 72, hist = new Float64Array(B);
  const hs: number[] = [], ss: number[] = [], ws: number[] = [], cs: number[] = [], ls: number[] = [], strongH: number[] = [], strongW: number[] = [];
  let total = 0, chromaSum = 0, wsum = 0;
  const Ls: [number, number][] = [];
  for (let i = 0; i < pixels.length; i += 3) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const pw = weights ? weights[i / 3] : 1;
    if (pw <= 0) continue;
    const [h, s, l] = rgb2hsl(r, g, b);
    const c = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    chromaSum += c * pw; wsum += pw; Ls.push([l, pw]);
    if (c >= 0.2) { strongH.push(h); strongW.push(pw); }
    if (l < 0.1 || l > 0.94) continue;
    const w = c * c * pw;
    if (w <= 0) continue;
    hist[Math.floor(h / 5) % B] += w; total += w;
    hs.push(h); ss.push(s); ws.push(w); cs.push(c); ls.push(l);
  }
  const sm = new Float64Array(B);
  for (let i = 0; i < B; i++) for (let k = -6; k <= 6; k++) sm[i] += hist[(i + k + B) % B] * Math.exp(-(k * k) / 8);
  const peaks: number[] = [];
  for (let i = 0; i < B; i++) if (sm[i] > 0 && sm[i] >= sm[(i + 1) % B] && sm[i] > sm[(i - 1 + B) % B]) peaks.push(i);
  const out: Swatch[] = peaks.map(p => {
    const ph = p * 5 + 2.5; let sx = 0, sy = 0, w = 0, cw = 0, csum = 0, lsum = 0; const sat: [number, number][] = [];
    for (let j = 0; j < hs.length; j++) if (hueDist(hs[j], ph) <= 20) {
      sx += Math.cos(hs[j] * Math.PI / 180) * ws[j]; sy += Math.sin(hs[j] * Math.PI / 180) * ws[j]; w += ws[j]; sat.push([ss[j], ws[j]]);
      const pw = ws[j] / (cs[j] * cs[j]); cw += pw; csum += pw * cs[j]; lsum += ws[j] * ls[j];
    }
    sat.sort((a, b) => a[0] - b[0]); let acc = 0, med = 0; for (const [s, ww] of sat) { acc += ww; if (acc >= w / 2) { med = s; break; } }
    const hue = ((Math.atan2(sy, sx) * 180 / Math.PI) + 360) % 360;
    let st = 0; for (let j = 0; j < strongH.length; j++) if (hueDist(strongH[j], hue) <= 20) st += strongW[j];
    return { hue: +hue.toFixed(1), share: total ? w / total : 0, sat: med, strong: wsum ? st / wsum : 0, chroma: cw ? csum / cw : 0, light: w ? lsum / w : 0.5 };
  }).sort((a, b) => b.share - a.share || a.hue - b.hue);
  const merged: Swatch[] = [];
  for (const s of out) if (!merged.some(m => hueDist(m.hue, s.hue) < 12)) merged.push(s);
  Ls.sort((a, b) => a[0] - b[0]); let half = wsum / 2, medL = 0.5; for (const [l, pw] of Ls) { half -= pw; if (half <= 0) { medL = l; break; } }
  return { swatches: merged, meanChroma: wsum ? chromaSum / wsum : 0, medianL: medL };
}

/** Swatches of a dissolve's reference art: samples { rgb, w } on an 8 px grid of the reference card, w = mask opacity x
 * visibility (x2.5 in the band the art melts into); 36 bins of 10 deg weighted by chroma, smoothed [1 2 3 2 1]; each
 * peak keeps its circular mean hue, weight share, mean saturation and mean chroma. */
export function swatchesBand(samples: { rgb: RGB; w: number }[]): SwatchSet {
  const N = 36, cw = new Array(N).fill(0), aw = new Array(N).fill(0), sx = new Array(N).fill(0), sy = new Array(N).fill(0), ssum = new Array(N).fill(0), lsum = new Array(N).fill(0);
  let tot = 0, chromaSum = 0;
  for (const q of samples) {
    const [r, g, b] = q.rgb, [h, s, l] = rgb2hsl(r, g, b), c = (Math.max(r, g, b) - Math.min(r, g, b)) / 255, w = q.w;
    tot += w; chromaSum += w * c;
    const k = Math.floor(h / 10) % N, wc = w * c;
    cw[k] += wc; aw[k] += w; sx[k] += wc * Math.cos(h * Math.PI / 180); sy[k] += wc * Math.sin(h * Math.PI / 180); ssum[k] += wc * s; lsum[k] += wc * l;
  }
  const sm = cw.map((_, k) => [-2, -1, 0, 1, 2].reduce((acc, o, j) => acc + [1, 2, 3, 2, 1][j] * cw[(k + o + N) % N], 0) / 9);
  const peaks: Swatch[] = [];
  for (let k = 0; k < N; k++) if (sm[k] > 0 && sm[k] >= sm[(k + N - 1) % N] && sm[k] > sm[(k + 1) % N]) {
    let X = 0, Y = 0, S = 0, L = 0, Cs = 0, A = 0;
    for (let o = -2; o <= 2; o++) { const j = (k + o + N) % N; X += sx[j]; Y += sy[j]; S += ssum[j]; L += lsum[j]; Cs += cw[j]; A += aw[j]; }
    if (Cs <= 0) continue;
    peaks.push({ hue: +(((Math.atan2(Y, X) * 180 / Math.PI) + 360) % 360).toFixed(1), share: sm[k] / tot, sat: S / Cs, light: L / Cs, chroma: Cs / A });
  }
  peaks.sort((a, b) => b.share - a.share || a.hue - b.hue);
  return { swatches: peaks, meanChroma: tot ? chromaSum / tot : 0 };
}

/** The card is drawn as a vertical gradient (top L+0.01 to bottom L-0.02) under a 3 % white diagonal grain; labels
 * sit in the top fifth. The colour rule checks contrast against what is really behind the labels. */
export const GRAD = { top: 0.01, bottom: -0.02 }, GRAIN = 0.03;
const WHITE: RGB = [255, 255, 255], INK: RGB = [20, 20, 20];
export const STATUS_A: Record<Ink, number> = { white: 1, ink: 0.9 };
export function drawn(h: number, S: number, L: number) {
  const top = hsl2rgb(h, S, Math.min(0.99, L + GRAD.top)), bottom = hsl2rgb(h, S, Math.max(0.01, L + GRAD.bottom)), base = hsl2rgb(h, S, L);
  return { top, bottom, base, lightest: mix(top, WHITE, GRAIN), darkest: base };
}
export function labelContrast(h: number, S: number, L: number, ink: Ink) {
  const d = drawn(h, S, L), fg = ink === "white" ? WHITE : INK, bg = ink === "white" ? d.lightest : d.darkest;
  const status = mix(bg, fg, STATUS_A[ink]);
  return { title: contrast(fg, bg), status: contrast(status, bg) };
}
/** 4.7:1 on the computed worst pixel leaves room for the renderer's gradient dithering (views must measure >= 4.5) */
export const MIN_TEXT = 4.7;
const legible = (h: number, S: number, L: number, ink: Ink) => { const c = labelContrast(h, S, L, ink); return c.title >= MIN_TEXT && c.status >= MIN_TEXT; };

/** the choice list of a swatch set (exceptions applied), for pick 0, 1, ... */
export function choiceList(sw: SwatchSet, bandL: number | null): { grey: boolean; list: Swatch[] } {
  const peaks = sw.swatches;
  const grey = sw.meanChroma < 0.07 || !peaks.length;
  if (grey) {
    const list = peaks.filter(p => !(p.hue >= 15 && p.hue <= 100));
    return { grey, list: list.length ? list : [{ hue: ((peaks[0] ? peaks[0].hue : 30) + 180) % 360, share: 0, sat: 0, chroma: 0, light: 0.5, opposite: true }] };
  }
  const vivid = peaks.filter(p => p.chroma >= 0.16 || p.hue < 45 || p.hue > 100);
  let list = vivid.length ? vivid : peaks.slice();
  if (bandL != null && bandL < 0.3 && list[0] && list[0].hue >= 15 && list[0].hue <= 70) {
    const alt = list.filter(p => (p.hue < 15 || p.hue > 70) && p.share >= 0.15 * list[0].share);
    if (alt.length) list = alt.concat(list.filter(p => !alt.includes(p)));
  }
  return { grey, list };
}

export function cardColour(sw: SwatchSet, bandL: number | null = null, pick = 0): CardColour {
  const { grey, list } = choiceList(sw, bandL);
  const p = list[Math.min(pick, list.length - 1)];
  const h = Math.round(p.hue * 10) / 10 % 360;
  const S = grey ? 0.22 : Math.min(0.82, Math.max(0.55, 0.45 + 0.6 * p.sat));
  // the whole gradient stays inside 0.45-0.65 (grey 0.40-0.60): the base L inside [0.47, 0.64] (grey [0.42, 0.59])
  const Lmin = grey ? 0.42 : 0.47, Lmax = grey ? 0.59 : 0.64;
  let L: number | null = null, ink: Ink | null = null;
  for (let k = 0; ; k++) { const l = +(Math.min(0.58, Lmax) - k * 0.005).toFixed(3); if (l < Lmin - 1e-9) break; if (legible(h, S, l, "white")) { L = l; ink = "white"; break; } }
  if (L == null) for (let k = 0; k <= 40 && L == null; k++) for (const sg of [1, -1]) {
    const l = +(0.56 + sg * k * 0.005).toFixed(3); if (l < Lmin - 1e-9 || l > Lmax + 1e-9 || L != null) continue;
    if (legible(h, S, l, "ink")) { L = l; ink = "ink"; }
  }
  if (L == null || ink == null) { L = Lmax; ink = "ink"; }        // unreachable for these ranges (kept so it never throws)
  const d = drawn(h, S, L), c = labelContrast(h, S, L, ink);
  return { h, s: +S.toFixed(3), l: L, grey, pick, options: list.length, ink, base: d.base, top: d.top, bottom: d.bottom,
    text: ink === "white" ? "#ffffff" : "#141414", status: ink === "white" ? `rgba(255,255,255,${STATUS_A.white})` : `rgba(20,20,20,${STATUS_A.ink})`,
    contrast: { title: +c.title.toFixed(2), status: +c.status.toFixed(2) }, swatch: { hue: p.hue, share: +(p.share || 0).toFixed(3), sat: +(p.sat || 0).toFixed(3), chroma: +(p.chroma || 0).toFixed(3) } };
}

/** Label contrast where a neighbouring card's shadow (black at `alpha`, composited over the card) darkens the card
 * under the labels: near-black ink loses contrast on the darkest (shadowed) pixel; white ink only gains, its worst
 * pixel stays the lightest unshadowed one. */
export function shadedContrast(c: CardColour, alpha: number) {
  if (c.ink === "white" || alpha <= 0) return { title: c.contrast.title, status: c.contrast.status };
  const bg = c.base.map(v => v * (1 - alpha));
  return { title: contrast(INK, bg), status: contrast(mix(bg, INK, STATUS_A.ink), bg) };
}

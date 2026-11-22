/**
 * Cards — per-game art analysis (the recipe's art.cjs): load the poster and the key art, read their lettering, take the
 * segmentation model's mask (when there is one), score both cut-out candidates and pick the cut-out or the dissolve;
 * for a cut-out, trace its outline; for a dissolve, build both images' saliency maps and choose between them on the
 * reference card; and derive the game's one colour.
 *
 * Server rules that replace the boards' hand-kept manifest (nothing per game):
 *   - key art the source guarantees logo-free (Steam's library hero) is trusted: its lettering is not read (scene
 *     signage and interface text are part of the picture);
 *   - any other key art is read like a poster (at 360 and 540 px tall); when the reading finds no lettering at all it
 *     counts as logo-free too (the x1.25 bonus a logo-free banner gets in the score);
 *   - the logo template match runs on the poster when the game has a logo (its box is the logo's opaque pixels).
 * Without a mask (no model yet, or cut-outs off) every candidate scores 0 and the card is the dissolve.
 */
import sharp from "sharp";
import { subjectOf, type EmptySubject, type Subject } from "./analyse";
import { score, CUTOUT_THRESHOLD } from "./score";
import * as MK from "./mask";
import * as C from "./colour";
import { letteringOf, loadPixels, rgb2lab, type Block, type Lettering, type LogoBox } from "./lettering";
import { saliencyMap, horizontalChange, HX_MIN, type Saliency } from "./saliency";
import { placeImage, placeMiddle, alphaAt, type CutSubject, type DissolveArt, type DissolvePlace } from "./place";

/** The reference card the colour of a dissolve is read on (and the poster/banner choice made on): a 384 x 560 card
 * whose art is transparent down to 120 px and opaque from 212 px, its lower rows and side columns weighted less (they
 * are the first to be covered in the fan). Lettering 8 px tall or more on this card must stay hidden. A fixed
 * geometry, so the colour depends on the art alone. */
export const REF = { w: 384, h: 560, m0: 120, m1: 212, minTextPx: 8, vis: (cx: number, cy: number) => (cy <= 400 ? 1 : 1 - 0.55 * (cy - 400) / 160) * (1 - 0.3 * Math.pow((cx - 384 / 2) / (384 / 2), 2)) };
export const POSTER_BONUS = 0.12;            // posters are composed for a portrait frame: a banner must win by this

export type ArtKind = "poster" | "banner";
export interface ArtInput { kind: ArtKind; file: string; trusted?: boolean }
export interface AnalyseInput {
  poster: ArtInput | null;
  banner: ArtInput | null;
  logo: { file: string; box: LogoBox } | null;
  /** the model's soft mask of an image (W x H, 0..255), or null when there is none (no model, cut-outs off) */
  mask: ((art: ArtInput, W: number, H: number) => Promise<Uint8Array | null>) | null;
}
interface Cand {
  k: ArtKind; file: string; W: number; H: number; rgb: Buffer; raw: Uint8Array | null; soft: Uint8Array | null; subj: Subject | EmptySubject | null;
  q: number; factors: Record<string, number>; logoFree: boolean; trusted: boolean; lett: Lettering & { trusted: boolean }; hx: number; trimmed: number; skip?: string;
}
export interface Analysis {
  mode: "cut" | "dissolve";
  src: { k: ArtKind; file: string; W: number; H: number };
  /** cut: the subject (for placement) and its outline (rings in source px, pixel-centre coordinates) */
  cut: { subject: CutSubject; rings: MK.Ring[]; erode: number; openHoles: number } | null;
  /** dissolve: the image as the placement search needs it */
  dissolve: { an: DissolveArt; refPlace: DissolvePlace; middle: boolean; scores: { k: ArtKind; score: number | null }[] } | null;
  swatches: C.SwatchSet; bandL: number | null; colourPool: string; colour: C.CardColour;
  ranked: { k: ArtKind; q: number; hx: number; letteringBlocks: number; trimmed: number; letterCut: number | null; logo: { ncc: number; used: boolean } | null; vetoed: number; logoFree: boolean; f: Record<string, number> }[];
}

/** binary dilation by r (square), via running sums */
function dilate(bin: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { let acc = 0; const row = y * W;
    for (let x = -r; x <= r; x++) if (x >= 0 && x < W) acc += bin[row + x];
    for (let x = 0; x < W; x++) { tmp[row + x] = acc > 0 ? 1 : 0; const a = x + r + 1, b = x - r; if (a < W) acc += bin[row + a]; if (b >= 0) acc -= bin[row + b]; } }
  for (let x = 0; x < W; x++) { let acc = 0;
    for (let y = -r; y <= r; y++) if (y >= 0 && y < H) acc += tmp[y * W + x];
    for (let y = 0; y < H; y++) { out[y * W + x] = acc > 0 ? 1 : 0; const a = y + r + 1, b = y - r; if (a < H) acc += tmp[a * W + x]; if (b >= 0) acc -= tmp[b * W + x]; } }
  return out;
}

// Background the model is sure of: its own (untrimmed) mask under 10 %. A hole the mask leans background on: the
// traced (trimmed) mask's mean over the hole under 50 %.
const SURE_BG = 26, LEAN_BG = 0.5;
/** Does a small hole of the traced subject (its pixels `pix`) show background through the subject? Yes when it holds
 * a pixel the model is sure is background; or when the traced mask leans background over it and its colour (its pixels
 * weighted by how much the mask calls them background) is nearer, in Lab, the backdrop around the subject (pixels the
 * model is sure of within 4 % of the image diagonal) than the subject around the hole (within 3 px). Otherwise the
 * mask is only unsure there and the hole is filled. */
function holeStays(pix: number[], raw: Uint8Array, field: Float32Array, rgb: Buffer | null, bin: Uint8Array, W: number, H: number): boolean {
  let mn = 255, sum = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (const p of pix) { if (raw[p] < mn) mn = raw[p]; sum += field[p]; const x = p % W, y = (p - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (mn < SURE_BG) return true;
  if (!rgb || sum / pix.length >= LEAN_BG) return false;
  const hole = [0, 0, 0]; let hw = 0;
  for (const p of pix) { const w = 1 - field[p]; for (let k = 0; k < 3; k++) hole[k] += w * rgb[3 * p + k]; hw += w; }
  const r = 3, bw = x1 - x0 + 1 + 2 * r, bh = y1 - y0 + 1 + 2 * r, local = new Uint8Array(bw * bh);
  for (const p of pix) { const x = p % W, y = (p - x) / W; local[(y - y0 + r) * bw + (x - x0 + r)] = 1; }
  const near = dilate(local, bw, bh, r), ring = [0, 0, 0]; let rn = 0;
  for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
    if (!near[yy * bw + xx] || local[yy * bw + xx]) continue;
    const x = x0 - r + xx, y = y0 - r + yy; if (x < 0 || y < 0 || x >= W || y >= H || !bin[y * W + x]) continue;
    for (let k = 0; k < 3; k++) ring[k] += rgb[3 * (y * W + x) + k]; rn++;
  }
  const R = Math.round(0.04 * Math.hypot(W, H)), back = [0, 0, 0]; let bn = 0;
  for (let y = Math.max(0, y0 - R); y <= Math.min(H - 1, y1 + R); y++) for (let x = Math.max(0, x0 - R); x <= Math.min(W - 1, x1 + R); x++) {
    const i = y * W + x; if (raw[i] >= SURE_BG) continue;
    for (let k = 0; k < 3; k++) back[k] += rgb[3 * i + k]; bn++;
  }
  if (!rn || !bn) return false;
  const lab = (c: number[], n: number) => rgb2lab(c[0] / n, c[1] / n, c[2] / n), dE = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const h = lab(hole, hw);
  return dE(h, lab(back, bn)) < dE(h, lab(ring, rn));
}
/** Does a ring enclose a pixel flagged in `flag`? (ring coords: pixel (i, j) is the point (i, j)) */
function ringHolds(ring: MK.Ring, flag: Uint8Array, W: number, H: number): boolean {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  for (let y = Math.max(0, Math.ceil(y0)); y <= Math.min(H - 1, Math.floor(y1)); y++) for (let x = Math.max(0, Math.ceil(x0)); x <= Math.min(W - 1, Math.floor(x1)); x++) {
    if (!flag[y * W + x]) continue;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; }
    if (inside) return true;
  }
  return false;
}
/** Outline of the kept subject: the model's soft mask restricted to the kept components (grown by 3 px so their soft
 * edge survives); small holes (<= 0.4 % of the subject) filled unless they show background through the subject
 * (holeStays), which stay open whatever their size; eroded by r px (r = max(1, round(diagonal / 2000))), traced at iso
 * level 0.55 with marching squares (sub-pixel). Islands under 0.15 % of the subject are dropped; a hole's ring only when
 * it is that small and is not an open hole (so no backdrop is painted back inside the outline). */
export function subjectRings(soft: Uint8Array, subj: Subject, W: number, H: number, raw: Uint8Array | null = null, rgb: Buffer | null = null, iso = 0.55) {
  const grow = dilate(subj.sub, W, H, 3);
  let f: Float32Array = new Float32Array(W * H);
  const yEnd = subj.cutY != null ? subj.cutY * W : W * H;
  for (let i = 0; i < yEnd; i++) f[i] = grow[i] ? soft[i] / 255 : 0;
  const bin = new Uint8Array(W * H);
  let area = 0;
  for (let i = 0; i < W * H; i++) if (f[i] >= iso) { bin[i] = 1; area++; }
  const filled = MK.fillHoles(bin, W, H, Math.round(area * 0.004), raw ? (pix) => holeStays(pix, raw, f, rgb, bin, W, H) : null);
  for (let i = 0; i < W * H; i++) if (filled.mask[i] && !bin[i]) f[i] = 1;
  const erode = Math.max(1, Math.round(Math.hypot(W, H) / 2000));
  f = MK.minFilter(f, W, H, erode);
  const minRing = area * 0.0015;
  const rings = MK.contours(f, W, H, iso).filter(r => {
    const a = MK.ringArea(r);                              // islands trace negative, holes positive
    return Math.abs(a) >= minRing || (a > 0 && filled.nOpen > 0 && ringHolds(r, filled.open, W, H));
  });
  return { rings, area, erode, openHoles: filled.nOpen };
}

/** The model's soft mask, trimmed to what it is sure of: a pixel farther than r px (r = max(1, diagonal / 1200)) from
 * the model's confident core (soft >= 254) belongs to a half-certain region; such regions are dropped where they are
 * thick (they survive an opening of radius max(2, diagonal / 600)): an object behind the subject that the model
 * half-includes goes, while thin soft details (edges, strands, tips) stay. The subject's top fifth (its head) is never
 * trimmed. */
function trimPlateaus(soft: Uint8Array, W: number, H: number, protectY = 0) {
  const N = W * H, r = Math.max(1, Math.round(Math.hypot(W, H) / 1200)), ro = Math.max(2, Math.round(Math.hypot(W, H) / 600));
  const dist = new Int32Array(N).fill(1 << 30), q = new Int32Array(N); let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (soft[i] >= 254) { dist[i] = 0; q[qt++] = i; }
  while (qh < qt) { const p = q[qh++], x = p % W, y = (p - x) / W, d = dist[p] + 1; if (d > r) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const j = yy * W + xx; if (soft[j] >= 26 && dist[j] > d) { dist[j] = d; q[qt++] = j; } } }
  const far = new Float32Array(N);
  for (let i = protectY * W; i < N; i++) if (soft[i] >= 128 && dist[i] > r) far[i] = 1;
  const thick = MK.maxFilter(MK.minFilter0(far, W, H, ro), W, H, ro);
  const out = new Uint8Array(N); let cut = 0, kept = 0;
  for (let i = 0; i < N; i++) { if (far[i] && thick[i]) { if (soft[i] >= 128) cut++; continue; } out[i] = soft[i]; if (out[i] >= 128) kept++; }
  return { soft: out, r, trimmed: kept ? cut / (kept + cut) : 0 };
}
/** The letters on an image as a per-pixel mask: the glyph boxes of the detected lines (1 px padding) and the matched
 * logo's own alpha (> 25 %, grown 2 px). */
function letterMaskOf(lett: Lettering, W: number, H: number): Uint8Array {
  const m = new Uint8Array(W * H);
  for (const b of lett.main.letters) for (let y = Math.max(0, Math.floor(b[1] * H) - 1); y < Math.min(H, Math.ceil(b[3] * H) + 1); y++) for (let x = Math.max(0, Math.floor(b[0] * W) - 1); x < Math.min(W, Math.ceil(b[2] * W) + 1); x++) m[y * W + x] = 1;
  const lg = lett.logo;
  if (lg && lg.used && lg.alpha) {
    const a = lg.alpha;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const fx = Math.floor(x * a.pw / W) - a.X0, fy = Math.floor(y * a.ph / H) - a.Y0;
      let on = false;
      for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1 && !on; dx++) { const u = fx + dx, v = fy + dy; if (u >= 0 && v >= 0 && u < a.tw && v < a.th && a.Al[v * a.tw + u] > 64) on = true; }
      if (on) m[y * W + x] = 1;
    }
  }
  return m;
}

/** Where the subject's head is: centroid x of the subject pixels in the top 30 % of its height. */
function headAnchor(subj: Subject): number {
  const { sub, W, bbox } = subj;
  const yEnd = bbox.y0 + Math.max(1, Math.round(bbox.h * 0.3));
  let sx = 0, n = 0;
  for (let y = bbox.y0; y < yEnd; y++) for (let x = bbox.x0; x <= bbox.x1; x++) if (sub[y * W + x]) { sx += x; n++; }
  return n ? sx / n : (bbox.x0 + bbox.x1) / 2;
}

/** Swatches from a set of pixels; weightFn(x, y) in 0..1 restricts them (e.g. to the backdrop the cut removed). */
export function swatchesOf(rgb: ArrayLike<number>, W: number, H: number, weightFn: ((x: number, y: number) => number) | null): C.SwatchSet {
  const step = Math.max(1, Math.floor(Math.max(W, H) / 200));
  const px: number[] = [], wt: number[] = [];
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
    const i = (y * W + x) * 3; const w = weightFn ? weightFn(x, y) : 1;
    px.push(rgb[i], rgb[i + 1], rgb[i + 2]); wt.push(w);
  }
  return C.swatches(px, wt);
}

/** Lettering of one image: posters read 300, 240 and 450 px wide (a size the stability test misses at one scale is
 * caught at another) plus the logo template; trusted key art is not read; any other key art is read 360 and 540 tall. */
async function letteringFor(art: ArtInput, W: number, H: number, logo: AnalyseInput["logo"]): Promise<Lettering & { trusted: boolean }> {
  if (art.kind === "banner" && art.trusted) return { blocks: [], lines: [], letters: [], main: { blocks: [], letters: [] }, logo: null, trusted: true };
  const a = await letteringOf(art.file, W, H, art.kind, art.kind === "poster" ? logo : null, art.kind === "poster" ? [300, 240, 450] : [360, 540]);
  return { ...a, trusted: false };
}

/** The dissolve's colour pool: the art the reference card shows through its ramp (8 px samples weighted by the ramp's opacity and
 * the card's visibility), the band it melts into counted 2.5x; and the median lightness of that band. `rgb` is the image read at
 * W x H pixels; on the reference card it is natW x natH source pixels placed at `place` (scale s, offset dx, dy). `skip`
 * (fractions of the image) leaves pixels out, e.g. the poster's lettering for the box-art styles. */
export function dissolvePool(rgb: ArrayLike<number>, W: number, H: number, natW: number, natH: number, place: { s: number; dx: number; dy: number }, skip?: (fx: number, fy: number) => boolean): { swatches: C.SwatchSet; bandL: number } {
  const kx = W / natW, ky = H / natH;
  const samples: { rgb: C.RGB; w: number }[] = [], bandLs: number[] = [];
  for (let cy = 4; cy < REF.h; cy += 8) {
    const a = alphaAt(cy, REF.m0, REF.m1); if (a <= 0) continue;
    const band = cy <= REF.m1 + 60 ? 2.5 : 1, inBand = cy >= REF.m0 && cy <= REF.m1 + 30;
    for (let cx = 4; cx < REF.w; cx += 8) {
      const ix = Math.floor((cx - place.dx) / place.s * kx), iy = Math.floor((cy - place.dy) / place.s * ky);
      if (ix < 0 || iy < 0 || ix >= W || iy >= H || (skip && skip((ix + 0.5) / W, (iy + 0.5) / H))) continue;
      const i = iy * W + ix, r = rgb[3 * i], gg = rgb[3 * i + 1], b = rgb[3 * i + 2];
      samples.push({ rgb: [r, gg, b], w: a * REF.vis(cx, cy) * band });
      if (inBand) bandLs.push(C.rgb2hsl(r, gg, b)[2]);
    }
  }
  bandLs.sort((a, b) => a - b);
  return { swatches: C.swatchesBand(samples), bandL: bandLs.length ? bandLs[bandLs.length >> 1] : 0.5 };
}

export async function analyseArt(input: AnalyseInput): Promise<Analysis> {
  const cands: Cand[] = [];
  for (const art of [input.poster, input.banner]) {
    if (!art) continue;
    const { data: rgb, info } = await sharp(art.file).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    const lett = await letteringFor(art, W, H, input.logo);
    const logoFree = art.kind === "banner" && (!!art.trusted || lett.blocks.length === 0);
    const hx = horizontalChange(rgb, W, H);
    const m = input.mask ? await input.mask(art, W, H) : null;
    if (!m) { cands.push({ k: art.kind, file: art.file, W, H, rgb, raw: null, soft: null, subj: null, q: 0, factors: {}, logoFree, trusted: !!art.trusted, lett, hx, trimmed: 0 }); continue; }
    if (m.length !== W * H) throw new Error(`mask size mismatch for ${art.kind}`);
    const textRects = lett.main.blocks.map(b => [b[0] * W, b[1] * H, b[2] * W, b[3] * H]);
    const letters = lett.trusted ? null : letterMaskOf(lett, W, H);
    // the subject is found on the model's mask, the mask is trimmed (its head protected), the subject found again
    const raw = new Uint8Array(m), subj0 = subjectOf(raw, W, H, textRects, letters);
    const trim = trimPlateaus(raw, W, H, subj0.empty ? 0 : Math.round(subj0.bbox.y0 + 0.2 * subj0.bbox.h)), soft = trim.soft;
    const subj = subjectOf(soft, W, H, textRects, letters);
    const sc = score(subj, { logoFree });
    cands.push({ k: art.kind, file: art.file, W, H, rgb, raw, soft, subj, q: sc.q, factors: sc.f, logoFree, trusted: !!art.trusted, lett, hx, trimmed: trim.trimmed });
  }
  if (!cands.length) throw new Error("no art to analyse");
  // ties go to the poster (composed for a portrait frame like the card)
  const ranked = cands.slice().sort((a, b) => b.q - a.q || (a.k === "poster" ? -1 : 1));
  const best = ranked[0];
  const report = ranked.map(c => ({ k: c.k, q: +c.q.toFixed(3), hx: +c.hx.toFixed(3), letteringBlocks: c.lett.blocks.length, trimmed: +c.trimmed.toFixed(4), letterCut: c.subj && !c.subj.empty ? c.subj.cutY : null, logo: c.lett.logo ? { ncc: +c.lett.logo.ncc.toFixed(3), used: !!c.lett.logo.used } : null, vetoed: c.subj ? c.subj.vetoed : 0, logoFree: c.logoFree, f: Object.fromEntries(Object.entries(c.factors).map(([a, b]) => [a, +b.toFixed(2)])) }));
  if (best.q >= CUTOUT_THRESHOLD && best.subj && !best.subj.empty && best.soft) {
    const subj = best.subj;
    const { rings, erode, openHoles } = subjectRings(best.soft, subj, best.W, best.H, best.raw, best.rgb);
    // colour pool: the backdrop the cut removed; when that backdrop is near-grey, the whole image
    let sw = swatchesOf(best.rgb, best.W, best.H, (x, y) => (subj.sub[y * best.W + x] ? 0 : 1));
    let colourPool = "backdrop";
    if (!sw.swatches.length || (sw.swatches[0].strong ?? 0) < 0.006) { sw = swatchesOf(best.rgb, best.W, best.H, null); colourPool = "whole image"; }
    return {
      mode: "cut", src: { k: best.k, file: best.file, W: best.W, H: best.H },
      cut: { subject: { W: best.W, H: best.H, bbox: subj.bbox, contact: subj.contact, headX: headAnchor(subj) }, rings, erode, openHoles },
      dissolve: null, swatches: sw, bandL: null, colourPool, colour: C.cardColour(sw, null, 0), ranked: report,
    };
  }
  // the dissolve. Options: the poster (its lettering kept out of sight) and the key art (when it is trusted or read,
  // and has a subject: mean horizontal change >= HX_MIN; a banner of horizontal stripes has none)
  const opts: { c: Cand; an: DissolveArt; ref?: DissolvePlace | null; middle?: boolean }[] = [];
  for (const c of cands) {
    if (c.k === "banner" && c.hx < HX_MIN) { c.skip = `no subject (horizontal change ${c.hx.toFixed(3)} < ${HX_MIN})`; continue; }
    // lettering blocks for placement: the glyph finder's plus what the mask shows as text (padded by a quarter of its height)
    const textComps = c.subj ? c.subj.textComps : [];
    const extra: Block[] = textComps.filter(t => t.n >= 0.0004 * c.W * c.H).map(t => { const ph = 0.25 * (t.y1 - t.y0); return [Math.max(0, (t.x0 - ph) / c.W), Math.max(0, (t.y0 - ph) / c.H), Math.min(1, (t.x1 + ph) / c.W), Math.min(1, (t.y1 + ph) / c.H), (t.y1 - t.y0) / c.H]; });
    const blocks = c.lett.blocks.concat(c.k === "banner" && c.logoFree ? [] : extra);
    const sCover = Math.max(REF.w / c.W, (REF.h - 110) / c.H);
    const aw = Math.max(24, Math.round(c.W * sCover / 4)), ah = Math.max(24, Math.round(c.H * sCover / 4));
    const sal = saliencyMap(await loadPixels(c.file, aw, ah), blocks);
    opts.push({ c, an: { natW: c.W, natH: c.H, blocks, sal } });
  }
  for (const o of opts) o.ref = placeImage(o.an, { ...REF });
  const pp = opts.find(o => o.c.k === "poster" && o.ref), pb = opts.find(o => o.c.k === "banner" && o.ref);
  let use = !pp ? pb : !pb ? pp : pb.ref!.score > pp.ref!.score + POSTER_BONUS ? pb : pp;
  if (!use) {
    // never throws: the poster's middle band at cover scale
    const c = cands.find(q => q.k === "poster") || cands[0];
    const o = opts.find(q => q.c === c) || { c, an: { natW: c.W, natH: c.H, blocks: [], sal: saliencyMap(await loadPixels(c.file, 96, Math.round(96 * c.H / c.W)), []) } };
    o.ref = placeMiddle(o.an, REF); o.middle = true; use = o;
  }
  const ref = use.ref!;
  // colour pool: the art the reference card shows, the band it melts into counted 2.5x
  const sal: Saliency = use.an.sal;
  const { swatches: sw, bandL } = dissolvePool(sal.rgb, sal.W, sal.H, use.c.W, use.c.H, ref);
  return {
    mode: "dissolve", src: { k: use.c.k, file: use.c.file, W: use.c.W, H: use.c.H }, cut: null,
    dissolve: { an: use.an, refPlace: ref, middle: !!use.middle, scores: opts.map(o => ({ k: o.c.k, score: o.ref ? +o.ref.score.toFixed(3) : null })) },
    swatches: sw, bandL, colourPool: "reference card art, dissolve band x2.5", colour: C.cardColour(sw, bandL, 0), ranked: report,
  };
}

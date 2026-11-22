/**
 * Cards — burned-in lettering on the art (the recipe's lettering.cjs): posters carry logos and taglines, some banners
 * carry UI text. The stable-glyph line finder and the logo edge-template match. Every number is a rule constant.
 *
 *  detectText(px)   components that keep the same box over three consecutive thresholds (step 16) of luminance,
 *                   chroma and the Lab a and b axes (MSER-style), sized like glyphs (1.3-32 % of the height, fill
 *                   8-90 %), grouped into lines of >= 4 glyph columns (3 when the letters are >= 8 % of the height, or
 *                   next to a 4-column line) whose letters share a top or bottom edge, grown sideways over glyphs in
 *                   their row and over same-size glyphs within 0.8 letters, merged with a tagline that sits within 1.2x
 *                   the smaller line's height, padded by 0.35-0.6 of a letter.
 *  matchLogo(...)   the game's logo PNG found in the art by zero-mean NCC of edge maps (coarse 80 px over 10 widths x
 *                   5 aspects ranked by significance, the best 4 refined at 200 px); a significant match (coarse z >= 9,
 *                   fine ncc >= 0.28) adds the wordmark's own pieces (connected parts of its alpha).
 *  withLogo(...)    the box-art styles' reading of a poster: a match that counts is the poster's wordmark (a poster carries
 *                   one): a big-letter block that runs into it from the art is dropped, and when no block lies on it, its box
 *                   is the lettering; a close match (ncc >= 0.6) adds its pieces too.
 * Blocks are [x0, y0, x1, y1, mh] as fractions of the image (mh = tallest line height / image height).
 */
import sharp from "sharp";

const LOGO_NCC = 0.28, LOGO_Z = 9;
/** a match this close (fine ncc) is the poster's own drawing of the logo, piece for piece; a looser one (a poster that draws its
 *  wordmark another way: Samurai GUNN 2's brush letters, ncc 0.38) says where the wordmark is, but its pieces fall a line off */
const LOGO_CLOSE = 0.6;
/** a block whose letters are this tall (a fraction of the image height) or taller is a wordmark's, not a tagline's */
const BIG_LETTERS = 0.05;

export interface Pixels { w: number; h: number; data: Buffer }
export type Block = number[];                // [x0, y0, x1, y1, mh] as fractions
export interface LogoAlpha { Al: Float32Array; tw: number; th: number; X0: number; Y0: number; pw: number; ph: number }
export interface LogoMatch { ncc: number; z: number; coarse: number; cz: number; pieces: Block[]; alpha: LogoAlpha; box: Block; used?: boolean }
export interface Lettering { blocks: Block[]; lines: Block[]; letters: Block[]; main: { blocks: Block[]; letters: Block[] }; logo: LogoMatch | null }

export async function loadPixels(file: string | Buffer, w: number, h: number): Promise<Pixels> {
  const { data } = await sharp(file).removeAlpha().toColourspace("srgb").resize(w, h, { fit: "fill", kernel: "lanczos3" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { w, h, data };
}
export function rgb2lab(r: number, g: number, b: number): [number, number, number] {
  const f = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const R = f(r), G = f(g), B = f(b);
  const h = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = h((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), Y = h(0.2126 * R + 0.7152 * G + 0.0722 * B), Z = h((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
/** two passes of a (2r+1) box blur with edge renormalisation */
export function boxBlur2(src: Float32Array, W: number, H: number, r: number): Float32Array {
  let a = src, out = src;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(W * H); out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) { let s = 0, c = 0; for (let x = -r; x < W; x++) { if (x + r < W) { s += a[y * W + x + r]; c++; } if (x - r - 1 >= 0) { s -= a[y * W + x - r - 1]; c--; } if (x >= 0) tmp[y * W + x] = s / c; } }
    for (let x = 0; x < W; x++) { let s = 0, c = 0; for (let y = -r; y < H; y++) { if (y + r < H) { s += tmp[(y + r) * W + x]; c++; } if (y - r - 1 >= 0) { s -= tmp[(y - r - 1) * W + x]; c--; } if (y >= 0) out[y * W + x] = s / c; } }
    a = out;
  }
  return out;
}

interface Glyph { x0: number; y0: number; x1: number; y1: number; h: number; w: number }
interface LineBox { x0: number; y0: number; x1: number; y1: number; mh: number; cols?: number }

/** Extra glyph rules for a poster nothing else read lettering on (poster.ts posterText's last resort; every one off by default):
 *   nested    a glyph that holds two or more of its group's other glyphs (a word's outline, letters one threshold joins) is no
 *             column, so letters a swash or a second line runs across still count one by one (Demon's Souls' gothic wordmark);
 *   slanted   a line whose tops (or bottoms) lie on a straight line up to 20 degrees off the level counts too, with at least this
 *             many columns (a stamp set at an angle);
 *   bounded   a block grows only over glyphs at most 1.6x its letters' height (never over the art's big shapes beside it). */
export interface GlyphRules { nested?: boolean; slanted?: number; bounded?: boolean }

export function detectText(px: Pixels, rules: GlyphRules = {}): { blocks: Block[]; lines: Block[]; letters: Block[] } {
  const W = px.w, H = px.h, n = W * H, d = px.data;
  const Lc = new Uint8Array(n), Cc = new Uint8Array(n), Ac = new Uint8Array(n), Bc = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2];
    Lc[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
    Cc[i] = Math.max(r, g, b) - Math.min(r, g, b);
    const lab = rgb2lab(r, g, b);
    Ac[i] = Math.max(0, Math.min(255, 128 + 1.6 * lab[1])) | 0;
    Bc[i] = Math.max(0, Math.min(255, 128 + 1.6 * lab[2])) | 0;
  }
  const chans: [string, Uint8Array, number][] = [["L", Lc, 1], ["L", Lc, -1], ["C", Cc, 1], ["A", Ac, 1], ["A", Ac, -1], ["B", Bc, 1], ["B", Bc, -1]];
  // glyph size limits follow the image height (posters and banners alike)
  const minH = Math.max(6, Math.round(0.013 * H)), maxH = Math.round(0.32 * H);
  const lab = new Int32Array(n), stack = new Int32Array(n);
  const passes: { cn: string; pol: number; t: number; comps: Glyph[] }[] = [];
  for (const [cn, ch, pol] of chans) {
    for (let t = 16; t <= 248; t += 16) {
      lab.fill(-1);
      const comps: Glyph[] = [];
      let id = 0;
      for (let i = 0; i < n; i++) {
        if (lab[i] >= 0) continue;
        const v0 = ch[i]; if (!(pol > 0 ? v0 > t : v0 < t)) continue;
        id++; let sp = 0; stack[sp++] = i; lab[i] = id;
        let x0 = W, y0 = H, x1 = -1, y1 = -1, area = 0;
        while (sp) {
          const p = stack[--sp], x = p % W, y = (p - x) / W; area++;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const xx = x + dx; if (xx < 0 || xx >= W) continue;
              const q = yy * W + xx; if (lab[q] >= 0) continue; const v = ch[q];
              if (pol > 0 ? v > t : v < t) { lab[q] = id; stack[sp++] = q; } } }
        }
        const h = y1 - y0 + 1, w = x1 - x0 + 1;
        if (h < minH || h > maxH || w < 2 || w > 3.5 * h || w < 0.06 * h || w > 0.9 * W) continue;
        const fill = area / (w * h); if (fill < 0.08 || fill > 0.9) continue;
        comps.push({ x0, y0, x1, y1, h, w });
      }
      passes.push({ cn, pol, t, comps });
    }
  }
  const same = (a: Glyph, b: Glyph) => { const tol = Math.max(1, Math.round(0.08 * a.h)); return Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.y1 - b.y1) <= tol; };
  const stable: Glyph[] = [];
  for (let k = 0; k < passes.length; k++) {
    const P = passes[k], N = [passes[k + 1], passes[k + 2]].filter((q) => q && q.cn === P.cn && q.pol === P.pol);
    if (!N.length || (N.length < 2 && P.t + 32 <= 248)) continue;
    for (const g of P.comps) if (N.every((q) => q.comps.some((b) => same(g, b)))) stable.push(g);
  }
  const glyphs: Glyph[] = [];
  for (const g of stable) {
    const dup = glyphs.find((o) => { const ix = Math.min(o.x1, g.x1) - Math.max(o.x0, g.x0) + 1, iy = Math.min(o.y1, g.y1) - Math.max(o.y0, g.y0) + 1;
      if (ix <= 0 || iy <= 0) return false; const inter = ix * iy, u = o.w * o.h + g.w * g.h - inter; return inter / u > 0.6; });
    if (!dup) glyphs.push(g);
  }
  const par = glyphs.map((_, i) => i); const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
  for (let i = 0; i < glyphs.length; i++) for (let j = i + 1; j < glyphs.length; j++) {
    const a = glyphs[i], b = glyphs[j];
    if (Math.max(a.h, b.h) / Math.min(a.h, b.h) > 1.8) continue;
    const vo = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1; if (vo < 0.5 * Math.min(a.h, b.h)) continue;
    const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1); if (gap > 1.1 * Math.max(a.h, b.h)) continue;
    par[find(i)] = find(j);
  }
  const groups = new Map<number, Glyph[]>();
  glyphs.forEach((g, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(g); });
  const med = (arr: number[]) => arr.slice().sort((p, q) => p - q)[arr.length >> 1];
  const cand: LineBox[] = [];
  const holds = (o: Glyph, g: Glyph) => o !== g && g.x0 >= o.x0 && g.x1 <= o.x1 && g.y0 >= o.y0 && g.y1 <= o.y1;
  for (const gs of groups.values()) {
    const colGlyphs = rules.nested ? gs.filter((o) => gs.filter((g) => holds(o, g)).length < 2) : gs;
    const xs = colGlyphs.map((g) => [g.x0, g.x1, g] as [number, number, Glyph]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cols: Glyph[][] = []; let end = -1;
    for (const [a, b, g] of xs) { if (a > end - 1) { cols.push([g]); end = b; } else { cols[cols.length - 1].push(g); end = Math.max(end, b); } }
    if (cols.length < 3) continue;
    const cb = cols.map((c) => { const y0 = Math.min(...c.map((g) => g.y0)), y1 = Math.max(...c.map((g) => g.y1)); return { y0, y1, h: y1 - y0 + 1, cx: (Math.min(...c.map((g) => g.x0)) + Math.max(...c.map((g) => g.x1))) / 2 }; });
    const mh = med(cb.map((c) => c.h)), my0 = med(cb.map((c) => c.y0)), my1 = med(cb.map((c) => c.y1));
    const tol = Math.max(1.5, 0.16 * mh);
    let al = Math.max(cb.filter((c) => Math.abs(c.y0 - my0) <= tol).length, cb.filter((c) => Math.abs(c.y1 - my1) <= tol).length) / cb.length;
    if (al < 0.6 && rules.slanted && cb.length >= rules.slanted) {
      // the tops (or the bottoms) along their least-squares line, if it slants at most 20 degrees
      const n = cb.length, mx = cb.reduce((a, c) => a + c.cx, 0) / n;
      const along = (ys: number[]) => {
        const my = ys.reduce((a, v) => a + v, 0) / n; let sxy = 0, sxx = 0;
        cb.forEach((c, i) => { sxy += (c.cx - mx) * (ys[i] - my); sxx += (c.cx - mx) ** 2; });
        const k = sxx > 0 ? sxy / sxx : 0;
        return Math.abs(k) > 0.36 ? 0 : ys.filter((v, i) => Math.abs(v - (my + k * (cb[i].cx - mx))) <= tol).length / n;
      };
      al = Math.max(al, along(cb.map((c) => c.y0)), along(cb.map((c) => c.y1)));
    }
    if (al < 0.6) continue;
    const x0 = Math.min(...gs.map((g) => g.x0)), x1 = Math.max(...gs.map((g) => g.x1)), y0 = Math.min(...gs.map((g) => g.y0)), y1 = Math.max(...gs.map((g) => g.y1));
    if (x1 - x0 + 1 < 2.2 * mh) continue;
    cand.push({ x0, y0, x1, y1, mh, cols: cols.length });
  }
  const near = (a: LineBox, b: LineBox, k: number) => { const m = k * Math.min(a.mh, b.mh); return a.y0 - b.y1 < m && b.y0 - a.y1 < m && a.x0 - b.x1 < m && b.x0 - a.x1 < m; };
  const strong = cand.filter((c) => (c.cols ?? 0) >= 4 || c.mh >= 0.08 * H);
  const lines = cand.filter((c) => strong.includes(c) || strong.some((s) => s !== c && near(c, s, 1.6)));
  const big = (b: LineBox) => b.mh >= 0.024 * H;
  const blocks: LineBox[] = lines.map((l) => ({ x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, mh: l.mh }));
  for (const b of blocks) for (let it = 0; it < 3; it++) for (const g of glyphs) {
    if (g.h < 0.5 * b.mh || (rules.bounded && g.h > 1.6 * b.mh)) continue;
    const vo = Math.min(g.y1, b.y1) - Math.max(g.y0, b.y0) + 1; if (vo < 0.6 * Math.min(g.h, b.y1 - b.y0 + 1)) continue;
    if (g.x1 < b.x0 - 0.6 * b.mh || g.x0 > b.x1 + 0.6 * b.mh) continue;
    b.x0 = Math.min(b.x0, g.x0); b.x1 = Math.max(b.x1, g.x1); b.y0 = Math.min(b.y0, g.y0); b.y1 = Math.max(b.y1, g.y1);
  }
  for (const b of blocks) {
    if (!big(b)) continue;
    const add = glyphs.filter((g) => g.h >= 0.6 * b.mh && g.h <= 1.6 * b.mh && g.x1 >= b.x0 - 0.8 * b.mh && g.x0 <= b.x1 + 0.8 * b.mh && g.y1 >= b.y0 - 0.8 * b.mh && g.y0 <= b.y1 + 0.8 * b.mh);
    const gm = Math.min(1.5 * b.mh, 0.08 * H), lim = { x0: b.x0 - gm, x1: b.x1 + gm, y0: b.y0 - gm, y1: b.y1 + gm };
    for (const g of add) { if (g.x0 < lim.x0 || g.x1 > lim.x1 || g.y0 < lim.y0 || g.y1 > lim.y1) continue; b.x0 = Math.min(b.x0, g.x0); b.x1 = Math.max(b.x1, g.x1); b.y0 = Math.min(b.y0, g.y0); b.y1 = Math.max(b.y1, g.y1); }
  }
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i], b = blocks[j];
      const similar = Math.max(a.mh, b.mh) / Math.min(a.mh, b.mh) <= 1.5;
      if (((big(a) || big(b)) && near(a, b, 1.2)) || (similar && near(a, b, 0.8))) { blocks[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), mh: Math.max(a.mh, b.mh) }; blocks.splice(j, 1); merged = true; break outer; }
    }
  }
  const pv = (b: LineBox) => Math.max(0.35 * b.mh, Math.min(0.6 * b.mh, 0.05 * H)), ph = (b: LineBox) => Math.max(0.35 * b.mh, Math.min(0.5 * b.mh, 0.05 * W));
  const pad = (b: LineBox): Block => [Math.max(0, (b.x0 - ph(b)) / W), Math.max(0, (b.y0 - pv(b)) / H), Math.min(1, (b.x1 + 1 + ph(b)) / W), Math.min(1, (b.y1 + 1 + pv(b)) / H), b.mh / H];
  // the letters themselves: glyph boxes inside a block (a finer lettering mask than the padded block)
  const inBlock = (g: Glyph) => blocks.some((b) => g.x0 >= b.x0 - 1 && g.x1 <= b.x1 + 1 && g.y0 >= b.y0 - 1 && g.y1 <= b.y1 + 1);
  const letters = glyphs.filter(inBlock).map((g) => [g.x0 / W, g.y0 / H, (g.x1 + 1) / W, (g.y1 + 1) / H]);
  return { blocks: blocks.map(pad), lines: lines.map((l) => [l.x0 / W, l.y0 / H, (l.x1 + 1) / W, (l.y1 + 1) / H, l.mh / H]), letters };
}

/** colour-agnostic edge strength (gradient of the Lab vector), lightly blurred */
function edgeLab(px: Pixels): Float32Array {
  const W = px.w, H = px.h, n = W * H, d = px.data;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) { const q = rgb2lab(d[4 * i], d[4 * i + 1], d[4 * i + 2]); L[i] = q[0]; A[i] = q[1]; B[i] = q[2]; }
  const E = new Float32Array(n);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; let m = 0;
    for (const C of [L, A, B]) {
      const gx = C[i - W + 1] + 2 * C[i + 1] + C[i + W + 1] - C[i - W - 1] - 2 * C[i - 1] - C[i + W - 1];
      const gy = C[i + W - 1] + 2 * C[i + W] + C[i + W + 1] - C[i - W - 1] - 2 * C[i - W] - C[i - W + 1];
      m += gx * gx + gy * gy;
    }
    E[i] = Math.sqrt(m);
  }
  return boxBlur2(E, W, H, 1);
}
interface EdgeField { E: Float32Array; I1: Float64Array; I2: Float64Array; W: number; H: number; P: number; pw: number; ph: number }
async function edgeField(src: string | Buffer, pw: number, ph: number): Promise<EdgeField> {
  const E0 = edgeLab(await loadPixels(src, pw, ph)), P = Math.round(0.1 * pw), W = pw + 2 * P, H = ph + 2 * P;
  const E = new Float32Array(W * H); for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) E[(y + P) * W + x + P] = E0[y * pw + x];
  const I1 = new Float64Array((W + 1) * (H + 1)), I2 = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let r1 = 0, r2 = 0; for (let x = 0; x < W; x++) { const v = E[y * W + x]; r1 += v; r2 += v * v; I1[(y + 1) * (W + 1) + x + 1] = I1[y * (W + 1) + x + 1] + r1; I2[(y + 1) * (W + 1) + x + 1] = I2[y * (W + 1) + x + 1] + r2; } }
  return { E, I1, I2, W, H, P, pw, ph };
}
export interface LogoBox { x: number; y: number; w: number; h: number }
/** the logo's alpha at tw x th (the logo box cropped out of the logo PNG first) */
async function logoAlpha(logoFile: string | Buffer, box: LogoBox, tw: number, th: number): Promise<Float32Array> {
  const { data, info } = await sharp(logoFile).toColourspace("srgb").ensureAlpha().extract({ left: box.x, top: box.y, width: box.w, height: box.h }).resize(tw, th, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error("logo alpha: " + info.channels + " channels");
  const Al = new Float32Array(tw * th); for (let i = 0; i < tw * th; i++) Al[i] = data[4 * i + 3];
  return Al;
}
interface Template { T: Float32Array; sT: number; tw: number; th: number; Al: Float32Array }
function templateOf(Al: Float32Array, tw: number, th: number): Template {
  const T0 = new Float32Array(tw * th);
  for (let y = 1; y < th - 1; y++) for (let x = 1; x < tw - 1; x++) {
    const i = y * tw + x;
    const gx = Al[i - tw + 1] + 2 * Al[i + 1] + Al[i + tw + 1] - Al[i - tw - 1] - 2 * Al[i - 1] - Al[i + tw - 1];
    const gy = Al[i + tw - 1] + 2 * Al[i + tw] + Al[i + tw + 1] - Al[i - tw - 1] - 2 * Al[i - tw] - Al[i - tw + 1];
    T0[i] = Math.hypot(gx, gy);
  }
  const T = boxBlur2(T0, tw, th, 1);
  let mean = 0; for (const v of T) mean += v; mean /= T.length;
  let sT = 0; for (let i = 0; i < T.length; i++) { T[i] -= mean; sT += T[i] * T[i]; }
  return { T, sT: Math.sqrt(sT), tw, th, Al };
}
function nccAt(F: EdgeField, t: Template, x: number, y: number): number {
  const { E, I1, I2, W } = F, { T, sT, tw, th } = t;
  let num = 0;
  for (let j = 0; j < th; j++) { const row = (y + j) * W + x, tr = j * tw; for (let i = 0; i < tw; i++) num += T[tr + i] * E[row + i]; }
  const rect = (I: Float64Array) => I[(y + th) * (W + 1) + x + tw] - I[y * (W + 1) + x + tw] - I[(y + th) * (W + 1) + x] + I[y * (W + 1) + x];
  const s1 = rect(I1), s2 = rect(I2), v = s2 - s1 * s1 / (tw * th);
  return v <= 1e-9 || sT < 1e-6 ? -1 : num / (sT * Math.sqrt(v));
}
export async function matchLogo(posterSrc: string | Buffer, natW: number, natH: number, logoFile: string | Buffer, box: LogoBox): Promise<LogoMatch | null> {
  const C = await edgeField(posterSrc, 80, Math.round(natH * 80 / natW));
  const tcache = new Map<string, Template>();
  const tmpl = async (tw: number, th: number) => { const k = tw + "x" + th; if (!tcache.has(k)) tcache.set(k, templateOf(await logoAlpha(logoFile, box, tw, th), tw, th)); return tcache.get(k)!; };
  const cands: { ncc: number; x: number; y: number; f: number; asp: number; tw: number; th: number; z?: number }[] = [];
  for (const f of [0.34, 0.42, 0.5, 0.58, 0.66, 0.74, 0.82, 0.9, 0.98, 1.06]) for (const asp of [0.8, 0.9, 1, 1.1, 1.2]) {
    const tw = Math.round(f * C.pw), th = Math.max(5, Math.round(tw * asp * box.h / box.w));
    if (th >= 0.7 * C.ph || tw > C.W || th > C.H) continue;
    const t = await tmpl(tw, th);
    let b: { ncc: number; x: number; y: number; f: number; asp: number; tw: number; th: number } | null = null;
    for (let y = 0; y + th <= C.H; y++) for (let x = 0; x + tw <= C.W; x++) { const v = nccAt(C, t, x, y); if (!b || v > b.ncc) b = { ncc: v, x, y, f, asp, tw, th }; }
    if (b) cands.push(b);
  }
  for (const c of cands) c.z = Math.atanh(Math.min(0.999, Math.max(-0.999, c.ncc))) * Math.sqrt(c.tw * c.th / 4);
  cands.sort((p, q) => q.z! - p.z! || p.f - q.f || p.asp - q.asp);
  const Fz = await edgeField(posterSrc, 200, Math.round(natH * 200 / natW)), k = 200 / 80;
  let best: { ncc: number; z: number; x: number; y: number; tw: number; th: number; coarse: number; cz: number } | null = null;
  for (const c of cands.slice(0, 4)) for (const df of [-0.04, 0, 0.04]) for (const da of [-0.05, 0, 0.05]) {
    const f = c.f + df, asp = c.asp + da;
    const tw = Math.round(f * Fz.pw), th = Math.max(8, Math.round(tw * asp * box.h / box.w));
    if (tw > Fz.W || th > Fz.H) continue;
    const t = await tmpl(tw, th);
    const cx = Math.round((c.x - C.P) * k + Fz.P), cy = Math.round((c.y - C.P) * k + Fz.P);
    for (let y = cy - 8; y <= cy + 8; y += 2) for (let x = cx - 8; x <= cx + 8; x += 2) {
      if (x < 0 || y < 0 || x + tw > Fz.W || y + th > Fz.H) continue;
      const v = nccAt(Fz, t, x, y);
      const z = Math.atanh(Math.min(0.999, Math.max(-0.999, v))) * Math.sqrt(tw * th / 4);
      if (!best || z > best.z) best = { ncc: v, z, x, y, tw, th, coarse: c.ncc, cz: c.z! };
    }
  }
  if (!best) return null;
  const p = 0.12 * best.th, X0 = best.x - Fz.P, Y0 = best.y - Fz.P, pw = Fz.pw, ph = Fz.ph;
  const tw = best.tw, th = best.th, Al = (await tmpl(tw, th)).Al;
  // eroded by one pixel so letters that just touch come apart; every piece is padded back below
  const A = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { let m = 255; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; m = Math.min(m, xx < 0 || yy < 0 || xx >= tw || yy >= th ? 0 : Al[yy * tw + xx]); } A[y * tw + x] = m; }
  const lab = new Int32Array(tw * th).fill(-1), stack = new Int32Array(tw * th), parts: { x0: number; y0: number; x1: number; y1: number; area: number }[] = [];
  for (let i = 0; i < tw * th; i++) {
    if (lab[i] >= 0 || A[i] <= 64) continue;
    let sp = 0, x0 = tw, y0 = th, x1 = -1, y1 = -1, area = 0; stack[sp++] = i; lab[i] = parts.length;
    while (sp) { const q = stack[--sp], x = q % tw, y = (q - x) / tw; area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= tw || yy >= th) continue; const r = yy * tw + xx; if (lab[r] < 0 && A[r] > 64) { lab[r] = parts.length; stack[sp++] = r; } } }
    parts.push({ x0, y0, x1, y1, area });
  }
  const pp = Math.max(1.5, 0.06 * th) + 1;
  const pieces = parts.filter((c) => c.area >= 0.002 * tw * th).map((c) => [Math.max(0, (X0 + c.x0 - pp) / pw), Math.max(0, (Y0 + c.y0 - pp) / ph), Math.min(1, (X0 + c.x1 + 1 + pp) / pw), Math.min(1, (Y0 + c.y1 + 1 + pp) / ph), th / ph]);
  return { ncc: best.ncc, z: best.z, coarse: best.coarse, cz: best.cz, pieces, alpha: { Al, tw, th, X0, Y0, pw, ph }, box: [Math.max(0, (X0 - p) / pw), Math.max(0, (Y0 - p) / ph), Math.min(1, (X0 + best.tw + p) / pw), Math.min(1, (Y0 + best.th + p) / ph), best.th / ph] };
}

/** All lettering of one image. kind: "poster" | "banner". The glyph stability test is scale-sensitive: the art is read
 * at several sizes (posters by width, banners by height) and every reading's blocks, lines and letters are kept; the
 * first size is the main reading (its blocks and letters veto and cut cut-outs, where a false block would cost a good
 * figure); the union of all readings keeps a dissolve's lettering out of sight. */
export async function letteringOf(file: string | Buffer, natW: number, natH: number, kind: "poster" | "banner", logo: { file: string | Buffer; box: LogoBox } | null, sizes = [300]): Promise<Lettering> {
  let blocks: Block[] = [], lines: Block[] = [], letters: Block[] = [], main: { blocks: Block[]; letters: Block[] } | null = null, logoMatch: LogoMatch | null = null;
  for (const z of sizes) {
    const w = kind === "poster" ? z : Math.round(natW * z / natH), h = kind === "poster" ? Math.round(natH * z / natW) : z;
    const tx = detectText(await loadPixels(file, w, h));
    if (!main) main = { blocks: tx.blocks.slice(), letters: tx.letters };
    blocks = blocks.concat(tx.blocks); lines = lines.concat(tx.lines); letters = letters.concat(tx.letters);
  }
  if (!main) main = { blocks: [], letters: [] };
  if (logo) {
    logoMatch = await matchLogo(file, natW, natH, logo.file, logo.box);
    if (logoMatch) logoMatch.used = logoCounts(logoMatch, blocks);
    if (logoMatch && logoMatch.used) { const add = logoPieces(logoMatch); blocks = blocks.concat(add); main.blocks = main.blocks.concat(add); }
  }
  return { blocks, lines, letters, main, logo: logoMatch };
}

/** Whether a logo match counts: significant (coarse z >= LOGO_Z, fine ncc >= LOGO_NCC) and, a poster carrying one wordmark, when
 * the glyph rules already found a big text block (letters >= 5 % of the height) in `blocks`, overlapping one. */
export function logoCounts(match: LogoMatch, blocks: readonly Block[]): boolean {
  const bigs = blocks.filter((b) => b[4] >= BIG_LETTERS), ov = (a: readonly number[], b: readonly number[]) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  return match.cz >= LOGO_Z && match.ncc >= LOGO_NCC && (!bigs.length || bigs.some((b) => ov(b, match.box)));
}
/** the lettering a match marks: the wordmark's own pieces (connected parts of its alpha), else its box */
const logoPieces = (match: LogoMatch): Block[] => (match.pieces.length ? match.pieces : [match.box]).map((b) => b.slice());

/** The box-art styles' lettering of a poster (poster.ts posterText): the glyph finder's blocks, with the game's logo found on the
 * poster (`match`, when it counts: logoCounts) as the second opinion. A poster carries one wordmark, and the logo is it:
 *   - a block of big letters (>= 5 % of the height) that runs into the logo's box but lies mostly off it (its middle off the box)
 *     is no wordmark of its own: the glyph rules boxed the art beside the logo; it is dropped;
 *   - when no block of big letters lies on the logo (the glyph rules could not read it: drawn, metallic or condensed letters, or
 *     only that art beside it), the logo's box (its opaque pixels where the match put them, padded) is the wordmark;
 *   - when one does, a close match (ncc >= LOGO_CLOSE) adds the pieces their blocks do not hold, as the recipe's reading adds its
 *     pieces (letteringOf): letters the glyph rules left out (Mouthwashing's "ING"); a looser match leaves their blocks as they are;
 *   - every other block stays as the glyph rules read it (their box of the wordmark, lettering away from the logo, and smaller
 *     blocks: a tagline, a sticker, credits). */
export function withLogo(blocks: readonly Block[], match: LogoMatch | null): Block[] {
  const out = blocks.map((b) => b.slice());
  if (!match || !logoCounts(match, blocks)) return out;
  const [x0, y0, x1, y1] = match.box, big = (b: readonly number[]) => b[4] >= BIG_LETTERS;
  const onLogo = (b: readonly number[]) => { const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2; return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1; };
  const touches = (b: readonly number[]) => b[0] < x1 && x0 < b[2] && b[1] < y1 && y0 < b[3];
  const kept = out.filter((b) => !big(b) || onLogo(b) || !touches(b));
  if (!kept.some((b) => big(b) && onLogo(b))) return kept.concat([match.box.slice()]);
  if (match.ncc < LOGO_CLOSE) return kept;
  // the pieces the glyph rules' blocks do not hold already (most of a piece inside one)
  const area = (b: readonly number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const inside = (k: readonly number[], p: readonly number[]) => Math.max(0, Math.min(k[2], p[2]) - Math.max(k[0], p[0])) * Math.max(0, Math.min(k[3], p[3]) - Math.max(k[1], p[1])) >= 0.6 * area(p);
  return kept.concat(logoPieces(match).filter((p) => !kept.some((k) => inside(k, p))));
}

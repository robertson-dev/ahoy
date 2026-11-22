/**
 * Spotlight — deterministic pixel work (the boards' generator, M/spot/gen/pixels.js, ported line for line): WCAG luminance
 * and contrast, CIELAB, area-average / linear resampling, Gaussian blur, and the sRGB <-> Display P3 conversions the
 * contrast model blends in. Images are RGBA bytes; every derived plane is plain floats. No I/O here: the worker decodes.
 */

/** an RGBA image (8 bits per channel) */
export interface Rgba { w: number; h: number; d: Uint8Array | Uint8ClampedArray }
/** gamma-encoded RGB floats (3 per pixel) */
export interface Plane { w: number; h: number; d: Float32Array }

// ---- colour science (WCAG 2.x relative luminance, contrast ratio, CIELAB) ----
const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const LIN = new Float64Array(4096);
for (let i = 0; i < 4096; i++) LIN[i] = lin(i / 16);                                // 1/16 steps of an 8-bit value
export const linF = (v: number) => LIN[Math.max(0, Math.min(4095, Math.round(v * 16)))];
export const lum = (r: number, g: number, b: number) => 0.2126 * linF(r) + 0.7152 * linF(g) + 0.0722 * linF(b);
export const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
export function lab(r: number, g: number, b: number): [number, number, number] {
  const R = linF(r), G = linF(g), B = linF(b);
  let X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  X = f(X); Y = f(Y); Z = f(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

// ---- resampling ----
/** per-axis weights: output pixel i covers source [start + i*step, start + (i+1)*step); step >= 1 (downscale): area average;
 *  step < 1 (upscale): linear interpolation at the pixel centre. Returned flat: idx[] and wt[] per output pixel. */
export interface Axis { idx: Int32Array[]; wt: Float64Array[] }
export function axisWeights(nOut: number, nSrc: number, start: number, step: number): Axis {
  const idx: Int32Array[] = new Array(nOut), wt: Float64Array[] = new Array(nOut);
  for (let i = 0; i < nOut; i++) {
    const a = start + i * step, b = a + step;
    if (step >= 1) {
      const ks: number[] = [], ws: number[] = [];
      let tot = 0;
      for (let k = Math.floor(a); k < Math.ceil(b); k++) {
        const w = Math.min(b, k + 1) - Math.max(a, k); if (w <= 0) continue;
        ks.push(Math.min(nSrc - 1, Math.max(0, k))); ws.push(w); tot += w;
      }
      idx[i] = Int32Array.from(ks); wt[i] = Float64Array.from(ws.map(w => w / tot));
    } else {
      const c = (a + b) / 2 - 0.5, k = Math.floor(c), f = c - k;
      idx[i] = Int32Array.of(Math.min(nSrc - 1, Math.max(0, k)), Math.min(nSrc - 1, Math.max(0, k + 1)));
      wt[i] = Float64Array.of(1 - f, f);
    }
  }
  return { idx, wt };
}

/**
 * the image drawn at CSS (ox, oy) with scale s (CSS px per file px), sampled over the CSS region [X0, X0+W) x [Y0, Y0+H) at dpr
 * device px per CSS px; rows are made when first asked for (row(j)), since the contrast model reads only where text sits.
 */
export interface LazyLayer { w: number; h: number; row: (j: number) => Float32Array }
export function placeLazy(img: Rgba, s: number, ox: number, oy: number, X0: number, Y0: number, W: number, H: number, dpr: number): LazyLayer {
  const outW = Math.round(W * dpr), outH = Math.round(H * dpr), step = 1 / (dpr * s);
  const xw = axisWeights(outW, img.w, (X0 - ox) / s, step);
  const yw = axisWeights(outH, img.h, (Y0 - oy) / s, step);
  const src = new Map<number, Float32Array>(), out = new Map<number, Float32Array>(), d = img.d;
  const srcRow = (k: number) => {
    let row = src.get(k); if (row) return row;
    row = new Float32Array(outW * 3); const base = k * img.w * 4;
    for (let i = 0; i < outW; i++) {
      const ks = xw.idx[i], ws = xw.wt[i];
      let r = 0, g = 0, b = 0;
      for (let q = 0; q < ks.length; q++) { const p = base + ks[q] * 4, w = ws[q]; r += d[p] * w; g += d[p + 1] * w; b += d[p + 2] * w; }
      row[i * 3] = r; row[i * 3 + 1] = g; row[i * 3 + 2] = b;
    }
    src.set(k, row); return row;
  };
  const row = (j: number) => {
    let o = out.get(j); if (o) return o;
    o = new Float32Array(outW * 3);
    const ks = yw.idx[j], ws = yw.wt[j];
    for (let q = 0; q < ks.length; q++) { const r = srcRow(ks[q]), w = ws[q]; for (let i = 0; i < outW * 3; i++) o[i] += r[i] * w; }
    out.set(j, o); return o;
  };
  return { w: outW, h: outH, row };
}
/** the same, every row at once (the blurred case needs the whole plane) */
export function place(img: Rgba, s: number, ox: number, oy: number, X0: number, Y0: number, W: number, H: number, dpr: number): Plane {
  const L = placeLazy(img, s, ox, oy, X0, Y0, W, H, dpr), d = new Float32Array(L.w * L.h * 3);
  for (let j = 0; j < L.h; j++) d.set(L.row(j), j * L.w * 3);
  return { w: L.w, h: L.h, d };
}

/** area-average downscale of a whole RGBA image to W x H (alpha-weighted colour, so transparent pixels do not darken edges) */
export function shrink(img: Rgba, W: number, H?: number): Rgba {
  const HH = H || Math.max(1, Math.round(img.h * W / img.w));
  const xw = axisWeights(W, img.w, 0, img.w / W), yw = axisWeights(HH, img.h, 0, img.h / HH);
  const tmp = new Float64Array(W * img.h * 4), d = img.d;
  for (let y = 0; y < img.h; y++) for (let i = 0; i < W; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    const ks = xw.idx[i], ws = xw.wt[i];
    for (let q = 0; q < ks.length; q++) { const p = (y * img.w + ks[q]) * 4, al = d[p + 3] * ws[q]; r += d[p] * al; g += d[p + 1] * al; b += d[p + 2] * al; a += al; }
    const t = (y * W + i) * 4; tmp[t] = r; tmp[t + 1] = g; tmp[t + 2] = b; tmp[t + 3] = a;
  }
  const out = new Uint8ClampedArray(W * HH * 4);
  for (let j = 0; j < HH; j++) for (let i = 0; i < W; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    const ks = yw.idx[j], ws = yw.wt[j];
    for (let q = 0; q < ks.length; q++) { const t = (ks[q] * W + i) * 4, w = ws[q]; r += tmp[t] * w; g += tmp[t + 1] * w; b += tmp[t + 2] * w; a += tmp[t + 3] * w; }
    const p = (j * W + i) * 4;
    if (a > 0) { out[p] = Math.round(r / a); out[p + 1] = Math.round(g / a); out[p + 2] = Math.round(b / a); }
    out[p + 3] = Math.round(a);
  }
  return { w: W, h: HH, d: out };
}

/** rows [y0, y1) of an RGBA image (a copy) */
export function cropRows(img: Rgba, y0: number, y1: number): Rgba {
  const d = new Uint8ClampedArray(img.w * (y1 - y0) * 4);
  d.set(img.d.subarray(y0 * img.w * 4, y1 * img.w * 4));
  return { w: img.w, h: y1 - y0, d };
}

/** separable Gaussian blur of a float plane (w x h, nc channels interleaved), edges clamped */
export function gauss(src: Float32Array, w: number, h: number, nc: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float64Array(2 * r + 1);
  let t = 0; for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); t += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= t;
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < nc; c++) {
    let s = 0; for (let i = -r; i <= r; i++) { const xx = Math.min(w - 1, Math.max(0, x + i)); s += src[(y * w + xx) * nc + c] * k[i + r]; }
    tmp[(y * w + x) * nc + c] = s;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < nc; c++) {
    let s = 0; for (let i = -r; i <= r; i++) { const yy = Math.min(h - 1, Math.max(0, y + i)); s += tmp[(yy * w + x) * nc + c] * k[i + r]; }
    out[(y * w + x) * nc + c] = s;
  }
  return out;
}

/** RGBA bytes -> CIELAB float plane */
export function labPlane(img: Rgba): Float32Array {
  const n = img.w * img.h, L = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const v = lab(img.d[i * 4], img.d[i * 4 + 1], img.d[i * 4 + 2]); L[i * 3] = v[0]; L[i * 3 + 1] = v[1]; L[i * 3 + 2] = v[2]; }
  return L;
}

// Display P3 (same transfer curve as sRGB): Chromium composites in the display's colour space, which on the boards' machine is
// P3, so a blend of a saturated colour with grey lands elsewhere than the same blend done in sRGB. toP3/fromP3 convert
// gamma-encoded 0..255 values between the two encodings (through linear light).
const enc = (v: number) => { v = Math.max(0, Math.min(1, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };
const M_S2P = [[0.822462, 0.177538, 0], [0.033194, 0.966806, 0], [0.017083, 0.072397, 0.910520]];
const M_P2S = [[1.224940, -0.224940, 0], [-0.042057, 1.042057, 0], [-0.019638, -0.078636, 1.098274]];
function mat(M: number[][], r: number, g: number, b: number, out: number[] | Float32Array, o = 0) {
  const R = linF(r), G = linF(g), B = linF(b);
  out[o] = enc(M[0][0] * R + M[0][1] * G + M[0][2] * B); out[o + 1] = enc(M[1][0] * R + M[1][1] * G + M[1][2] * B); out[o + 2] = enc(M[2][0] * R + M[2][1] * G + M[2][2] * B);
  return out;
}
export const toP3 = (r: number, g: number, b: number, out: number[] | Float32Array = [0, 0, 0], o = 0) => mat(M_S2P, r, g, b, out, o);
export const fromP3 = (r: number, g: number, b: number, out: number[] | Float32Array = [0, 0, 0], o = 0) => mat(M_P2S, r, g, b, out, o);

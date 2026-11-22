/**
 * Cards — saliency for the dissolve and the "has a subject" test (the recipe's saliency.cjs).
 *
 *  saliencyMap(px, blocks)  per pixel 0.55 x distance from the image's own background colours (k-means of its top and
 *                           side bands) + 0.45 x centre-surround contrast (vs. the image blurred at a tenth of its size)
 *                           + 0.25 x local detail; lettering blocks score zero. Computed at one common scale (about
 *                           4 card px per analysis px) so posters and banners compare.
 *  horizontalChange(...)    mean horizontal Lab change of the lightly blurred image on a ~240-row grid: a banner made of
 *                           horizontal stripes (no subject) measures under HX_MIN.
 */
import { boxBlur2, rgb2lab, type Block, type Pixels } from "./lettering";

export const HX_MIN = 0.25;
export interface Saliency { W: number; H: number; S: Float32Array; rgb: Uint8Array }

export function saliencyMap(px: Pixels, blocks: Block[]): Saliency {
  const W = px.w, H = px.h, n = W * H, d = px.data;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) { const q = rgb2lab(d[4 * i], d[4 * i + 1], d[4 * i + 2]); L[i] = q[0]; A[i] = q[1]; B[i] = q[2]; }
  const Lb = boxBlur2(L, W, H, 1), Ab = boxBlur2(A, W, H, 1), Bb = boxBlur2(B, W, H, 1);
  const inText = new Uint8Array(n);
  for (const b of blocks) for (let y = Math.floor(b[1] * H); y < Math.ceil(b[3] * H); y++) for (let x = Math.floor(b[0] * W); x < Math.ceil(b[2] * W); x++) if (x >= 0 && y >= 0 && x < W && y < H) inText[y * W + x] = 1;
  const bw = Math.max(2, Math.round(0.05 * W)), bh = Math.max(2, Math.round(0.05 * H));
  const samples: number[][] = [];
  const inBand = (x: number, y: number) => y < bh || x < bw || x >= W - bw;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (inBand(x, y) && !inText[i]) samples.push([Lb[i], Ab[i], Bb[i]]); }
  if (samples.length < 24) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (inBand(x, y)) samples.push([Lb[i], Ab[i], Bb[i]]); }
  samples.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  const K = 6; let C: number[][] = []; for (let k = 0; k < K; k++) C.push(samples[Math.min(samples.length - 1, Math.floor((k + 0.5) * samples.length / K))].slice());
  let wts = new Array(K).fill(0);
  for (let it = 0; it < 10; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    for (const s of samples) { let bi = 0, bd = Infinity; for (let k = 0; k < K; k++) { const dd = (s[0] - C[k][0]) ** 2 + (s[1] - C[k][1]) ** 2 + (s[2] - C[k][2]) ** 2; if (dd < bd) { bd = dd; bi = k; } } const a = acc[bi]; a[0] += s[0]; a[1] += s[1]; a[2] += s[2]; a[3]++; }
    C = acc.map((a, k) => (a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : C[k])); wts = acc.map((a) => a[3] / samples.length);
  }
  const bg = C.filter((_, k) => wts[k] >= 0.04);
  const det = new Float32Array(n);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = Lb[i - W + 1] + 2 * Lb[i + 1] + Lb[i + W + 1] - Lb[i - W - 1] - 2 * Lb[i - 1] - Lb[i + W - 1];
    const gy = Lb[i + W - 1] + 2 * Lb[i + W] + Lb[i + W + 1] - Lb[i - W - 1] - 2 * Lb[i - W] - Lb[i - W + 1];
    det[i] = Math.min(1, Math.hypot(gx, gy) / 96);
  }
  const detB = boxBlur2(det, W, H, 2);
  const sbg = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = Infinity; for (const c of bg) { const dd = Math.sqrt((Lb[i] - c[0]) ** 2 + (Ab[i] - c[1]) ** 2 + (Bb[i] - c[2]) ** 2); if (dd < m) m = dd; } sbg[i] = Math.min(1, m / 45); }
  const sbgB = boxBlur2(sbg, W, H, 1);
  const R = Math.max(4, Math.round(0.1 * Math.min(W, H)));
  const Lc2 = boxBlur2(L, W, H, 2), Ac2 = boxBlur2(A, W, H, 2), Bc2 = boxBlur2(B, W, H, 2), Lr = boxBlur2(L, W, H, R), Ar = boxBlur2(A, W, H, R), Br = boxBlur2(B, W, H, R);
  const cs = new Float32Array(n); for (let i = 0; i < n; i++) cs[i] = Math.min(1, Math.sqrt((Lc2[i] - Lr[i]) ** 2 + (Ac2[i] - Ar[i]) ** 2 + (Bc2[i] - Br[i]) ** 2) / 35);
  const S = new Float32Array(n);
  for (let i = 0; i < n; i++) S[i] = inText[i] ? 0 : Math.round(Math.min(1, 0.55 * sbgB[i] + 0.45 * cs[i] + 0.25 * detB[i]) * 1000) / 1000;
  const rgb = new Uint8Array(3 * n); for (let i = 0; i < n; i++) { rgb[3 * i] = d[4 * i]; rgb[3 * i + 1] = d[4 * i + 1]; rgb[3 * i + 2] = d[4 * i + 2]; }
  return { W, H, S, rgb };
}

/** mean horizontal change of the lightly blurred Lab image, on a ~240-row box-averaged grid (Lab units) */
export function horizontalChange(rgb: Uint8Array | Buffer, W: number, H: number): number {
  const b = Math.max(1, Math.round(H / 240)), gw = Math.floor(W / b), gh = Math.floor(H / b), n = gw * gh;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let r = 0, g = 0, bb = 0;
    for (let y = gy * b; y < gy * b + b; y++) for (let x = gx * b; x < gx * b + b; x++) { const i = (y * W + x) * 3; r += rgb[i]; g += rgb[i + 1]; bb += rgb[i + 2]; }
    const k = gy * gw + gx, q = rgb2lab(r / (b * b), g / (b * b), bb / (b * b));
    L[k] = q[0]; A[k] = q[1]; B[k] = q[2];
  }
  const r1 = Math.max(1, Math.round(gh / 120));
  const fL = boxBlur2(L, gw, gh, r1), fA = boxBlur2(A, gw, gh, r1), fB = boxBlur2(B, gw, gh, r1);
  let hx = 0;
  for (let y = 0; y < gh; y++) for (let x = 1; x < gw; x++) { const k = y * gw + x; hx += Math.hypot(fL[k] - fL[k - 1], fA[k] - fA[k - 1], fB[k] - fB[k - 1]); }
  return hx / (gh * (gw - 1));
}

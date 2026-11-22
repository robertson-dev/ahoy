/**
 * Cards — mask utilities for the cut-out recipe (the recipe's mask.cjs): connected components, hole filling, grey
 * min/max filters, marching-squares contours, Ramer–Douglas–Peucker simplification. Pure JS on typed arrays.
 */

export type Point = [number, number];
export type Ring = Point[];
export interface Comp { id: number; n: number; x0: number; y0: number; x1: number; y1: number; cx: number; cy: number }

/** 8-connected components of a binary mask (1 = on). Labels (-1 = off) and per-component stats. */
export function components(bin: Uint8Array, W: number, H: number): { lab: Int32Array; comps: Comp[] } {
  const lab = new Int32Array(W * H).fill(-1);
  const stack = new Int32Array(W * H);
  const comps: Comp[] = [];
  for (let i = 0; i < W * H; i++) {
    if (!bin[i] || lab[i] >= 0) continue;
    const id = comps.length;
    let sp = 0, n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, sx = 0, sy = 0;
    stack[sp++] = i; lab[i] = id;
    while (sp) {
      const p = stack[--sp]; n++;
      const x = p % W, y = (p - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; sx += x; sy += y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          const q = yy * W + xx;
          if (bin[q] && lab[q] < 0) { lab[q] = id; stack[sp++] = q; }
        }
      }
    }
    comps.push({ id, n, x0, y0, x1, y1, cx: sx / n, cy: sy / n });
  }
  return { lab, comps };
}

/** Fill holes (4-connected background regions not touching the border) of at most maxHole pixels. `stays(pix)`, when
 * given, decides for each such hole whether it is real background seen through the subject and stays open. */
export function fillHoles(bin: Uint8Array, W: number, H: number, maxHole: number, stays: ((pix: number[]) => boolean) | null = null) {
  const inv = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) inv[i] = bin[i] ? 0 : 1;
  const lab = new Int32Array(W * H).fill(-1);
  const stack = new Int32Array(W * H);
  const out = bin.slice(), open = new Uint8Array(W * H);
  let id = 0, nOpen = 0;
  for (let i = 0; i < W * H; i++) {
    if (!inv[i] || lab[i] >= 0) continue;
    let sp = 0; const pix: number[] = []; let border = false;
    stack[sp++] = i; lab[i] = id;
    while (sp) {
      const p = stack[--sp]; pix.push(p);
      const x = p % W, y = (p - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
      const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const q of nb) if (q >= 0 && inv[q] && lab[q] < 0) { lab[q] = id; stack[sp++] = q; }
    }
    if (!border && pix.length <= maxHole) {
      if (stays && stays(pix)) { nOpen++; for (const p of pix) open[p] = 1; }
      else for (const p of pix) out[p] = 1;
    }
    id++;
  }
  return { mask: out, open, nOpen };
}

/** Marching squares on a scalar field f (W×H) at iso level t. The field is padded with 0 outside the image so every
 * contour closes. Closed rings [[x,y],...] in pixel-centre coordinates. */
export function contours(f: Float32Array, W: number, H: number, t: number): Ring[] {
  const get = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : f[y * W + x];
  const lerp = (a: number, b: number) => (t - a) / (b - a);
  const next = new Map<string, string>();
  const pts = new Map<string, Point>();
  const edgeKey = (x: number, y: number, e: number) => { // e: 0 top, 1 right, 2 bottom, 3 left
    if (e === 0) return "h" + x + "," + y;
    if (e === 2) return "h" + x + "," + (y + 1);
    if (e === 3) return "v" + x + "," + y;
    return "v" + (x + 1) + "," + y;
  };
  const edgePoint = (x: number, y: number, e: number, a: number, b: number, c: number, d: number): Point => {
    if (e === 0) return [x + lerp(a, b), y];
    if (e === 1) return [x + 1, y + lerp(b, c)];
    if (e === 2) return [x + lerp(d, c), y + 1];
    return [x, y + lerp(a, d)];
  };
  for (let y = -1; y < H; y++) {
    for (let x = -1; x < W; x++) {
      const a = get(x, y), b = get(x + 1, y), c = get(x + 1, y + 1), d = get(x, y + 1);
      const idx = (a >= t ? 8 : 0) | (b >= t ? 4 : 0) | (c >= t ? 2 : 0) | (d >= t ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      let list: [number, number][];
      switch (idx) {
        case 1: list = [[3, 2]]; break;
        case 2: list = [[2, 1]]; break;
        case 3: list = [[3, 1]]; break;
        case 4: list = [[1, 0]]; break;
        case 5: { const m = (a + b + c + d) / 4; list = m >= t ? [[3, 0], [1, 2]] : [[3, 2], [1, 0]]; break; }
        case 6: list = [[2, 0]]; break;
        case 7: list = [[3, 0]]; break;
        case 8: list = [[0, 3]]; break;
        case 9: list = [[0, 2]]; break;
        case 10: { const m = (a + b + c + d) / 4; list = m >= t ? [[0, 1], [2, 3]] : [[0, 3], [2, 1]]; break; }
        case 11: list = [[0, 1]]; break;
        case 12: list = [[1, 3]]; break;
        case 13: list = [[1, 2]]; break;
        default: list = [[2, 3]]; break;            // 14
      }
      for (const [e1, e2] of list) {
        const k1 = edgeKey(x, y, e1), k2 = edgeKey(x, y, e2);
        if (!pts.has(k1)) pts.set(k1, edgePoint(x, y, e1, a, b, c, d));
        if (!pts.has(k2)) pts.set(k2, edgePoint(x, y, e2, a, b, c, d));
        next.set(k1, k2);
      }
    }
  }
  const rings: Ring[] = [];
  const seen = new Set<string>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const ring: Ring = [];
    let k: string | undefined = start;
    while (k !== undefined && !seen.has(k)) { seen.add(k); const p = pts.get(k)!; ring.push([Math.min(W - 1, Math.max(0, p[0])), Math.min(H - 1, Math.max(0, p[1]))]); k = next.get(k); }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Grey erosion (running minimum over a (2r+1) square) of a float field; outside the image repeats the pixel itself. */
export function minFilter(f: Float32Array, W: number, H: number, r: number): Float32Array {
  if (r <= 0) return f;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let m = Infinity; for (let k = -r; k <= r; k++) { const xx = x + k; const v = xx < 0 || xx >= W ? f[y * W + x] : f[y * W + xx]; if (v < m) m = v; } tmp[y * W + x] = m; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let m = Infinity; for (let k = -r; k <= r; k++) { const yy = y + k; const v = yy < 0 || yy >= H ? tmp[y * W + x] : tmp[yy * W + x]; if (v < m) m = v; } out[y * W + x] = m; }
  return out;
}

/** Grey erosion where outside the image counts as 0 (for openings of binary sets). */
export function minFilter0(f: Float32Array, W: number, H: number, r: number): Float32Array {
  if (r <= 0) return f;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let m = Infinity; for (let k = -r; k <= r; k++) { const xx = x + k; const v = xx < 0 || xx >= W ? 0 : f[y * W + xx]; if (v < m) m = v; } tmp[y * W + x] = m; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let m = Infinity; for (let k = -r; k <= r; k++) { const yy = y + k; const v = yy < 0 || yy >= H ? 0 : tmp[yy * W + x]; if (v < m) m = v; } out[y * W + x] = m; }
  return out;
}

/** Grey dilation (running maximum over a (2r+1) square); outside the image counts as 0. */
export function maxFilter(f: Float32Array, W: number, H: number, r: number): Float32Array {
  if (r <= 0) return f;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let m = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W && f[y * W + xx] > m) m = f[y * W + xx]; } tmp[y * W + x] = m; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let m = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H && tmp[yy * W + x] > m) m = tmp[yy * W + x]; } out[y * W + x] = m; }
  return out;
}

export function ringArea(r: Ring): number { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return s / 2; }

function rdpOpen(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st: [number, number][] = [[0, pts.length - 1]];
  while (st.length) {
    const [i0, i1] = st.pop()!;
    const [x1, y1] = pts[i0], [x2, y2] = pts[i1];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-9;
    let dmax = 0, idx = -1;
    for (let i = i0 + 1; i < i1; i++) { const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len; if (d > dmax) { dmax = d; idx = i; } }
    if (dmax > eps && idx > 0) { keep[idx] = 1; st.push([i0, idx], [idx, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** RDP on a closed ring: split at the two farthest-apart points, simplify both halves. */
export function rdpRing(ring: Ring, eps: number): Ring {
  if (ring.length < 8) return ring;
  let far = 0, fd = -1;
  for (let i = 1; i < ring.length; i++) { const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const a = rdpOpen(ring.slice(0, far + 1), eps), b = rdpOpen(ring.slice(far).concat([ring[0]]), eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

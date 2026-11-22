/**
 * Cards — cut-out analysis (the recipe's analyse.cjs): turn a segmentation model's soft mask into a subject (a cluster
 * of components), keep lettering out of it, and measure the quality signals the score uses (area, fill, edge contact,
 * edge softness, straight outline, lettering, fragmentation).
 * Lettering is found two ways and both veto components:
 *   - by shape in the mask: three or more components of similar height on one line; a wide flat plate across >= 45 %
 *     of the width in the top or bottom 38 % of the art; rows that cross five or more strokes;
 *   - by the glyph finder and logo template match (lettering.ts): a component with >= 45 % of its pixels inside the
 *     detected lettering blocks is lettering.
 */
import { components, type Comp } from "./mask";

export interface BBox { x0: number; y0: number; x1: number; y1: number; w: number; h: number }
export interface Contact { t: number; b: number; l: number; r: number }
export interface TextComp { x0: number; y0: number; x1: number; y1: number; n: number }
export interface Subject {
  empty?: false; W: number; H: number; sub: Uint8Array; lab: Int32Array; keepIds: Set<number>; mainId: number; area: number; bbox: BBox; fill: number; contact: Contact;
  softBand: number; straight: number; textShare: number; inTextShare: number; letterShare: number; cutY: number | null; bands: { y0: number; y1: number }[];
  textIds: Set<number>; textComps: TextComp[]; vetoed: number; nKept: number; nBig: number; runsMed: number;
}
export interface EmptySubject { empty: true; W: number; H: number; textIds: Set<number>; textComps: TextComp[]; vetoed: number; cutY?: null; letterShare?: null }

type CompX = Comp & { h: number; w: number };

/** Text lines made of separate letter components: components of similar height overlapping vertically, close horizontally. */
export function textLineComponents(comps: Comp[], W: number, H: number): Set<number> {
  const N = W * H;
  const cand: CompX[] = comps.filter(c => c.n >= N * 0.00015 && c.n <= N * 0.03).map(c => ({ ...c, h: c.y1 - c.y0 + 1, w: c.x1 - c.x0 + 1 }));
  const parent = cand.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
    const a = cand[i], b = cand[j];
    const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ov < 0.5 * Math.min(a.h, b.h)) continue;
    if (Math.max(a.h, b.h) / Math.min(a.h, b.h) > 2.2) continue;
    const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
    if (gap > 1.2 * Math.max(a.h, b.h)) continue;
    parent[find(i)] = find(j);
  }
  const groups = new Map<number, CompX[]>();
  cand.forEach((c, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(c); });
  const text = new Set<number>();
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    const x0 = Math.min(...g.map(c => c.x0)), x1 = Math.max(...g.map(c => c.x1));
    const hs = g.map(c => c.h).sort((a, b) => a - b), mh = hs[hs.length >> 1];
    if (x1 - x0 >= 2.5 * mh) for (const c of g) text.add(c.id);
  }
  return text;
}

/** Rows of a component that cross many short runs (lettering): the component's pixels inside bands of such rows. */
export function textBands(lab: Int32Array, id: number, comp: Comp, W: number, H: number) {
  const rows: { y: number; runs: number; mean: number }[] = [];
  for (let y = comp.y0; y <= comp.y1; y++) {
    let runs = 0, len = 0, inRun = false;
    for (let x = comp.x0; x <= comp.x1; x++) {
      const on = lab[y * W + x] === id;
      if (on) { len++; if (!inRun) { runs++; inRun = true; } } else inRun = false;
    }
    rows.push({ y, runs, mean: runs ? len / runs : 0 });
  }
  const texty = rows.map(r => r.runs >= 5 && r.mean <= 0.03 * W);
  const bands: { y0: number; y1: number }[] = [];
  let start = -1, gap = 0;
  for (let i = 0; i <= rows.length; i++) {
    const t = i < rows.length && texty[i];
    if (t) { if (start < 0) start = i; gap = 0; }
    else if (start >= 0) { gap++; if (gap > 3 || i === rows.length) { const end = i - gap; if (end - start + 1 >= 0.02 * H) bands.push({ y0: rows[start].y, y1: rows[end].y }); start = -1; gap = 0; } }
  }
  let px = 0;
  for (const b of bands) for (let y = b.y0; y <= b.y1; y++) for (let x = comp.x0; x <= comp.x1; x++) if (lab[y * W + x] === id) px++;
  return { bands, px };
}

/** Long straight outline runs (door frames, windows, UI panels): share of the boundary pixels that sit on a horizontal
 * or vertical boundary run longer than 6 % of the image's shorter side. */
export function straightShare(bin: Uint8Array, W: number, H: number): number {
  const L = Math.max(12, Math.round(0.06 * Math.min(W, H)));
  let boundary = 0, straight = 0;
  const isB = (x: number, y: number) => { const i = y * W + x; if (!bin[i]) return false; return (x > 0 && !bin[i - 1]) || (x < W - 1 && !bin[i + 1]) || (y > 0 && !bin[i - W]) || (y < H - 1 && !bin[i + W]); };
  for (let x = 1; x < W; x++) { let run = 0; for (let y = 0; y <= H; y++) { const t = y < H && bin[y * W + x] !== bin[y * W + x - 1]; if (t) run++; else { if (run >= L) straight += run; run = 0; } } }
  for (let y = 1; y < H; y++) { let run = 0; for (let x = 0; x <= W; x++) { const t = x < W && bin[y * W + x] !== bin[(y - 1) * W + x]; if (t) run++; else { if (run >= L) straight += run; run = 0; } } }
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x++) if (isB(x, y)) boundary++;
  return boundary ? Math.min(1, straight / boundary) : 0;
}

/** Median number of separate runs per row of a binary mask inside a box (a figure crosses a row 1-3 times; a
 * backdrop striped by line art or a fence crosses it many times). */
function rowRunsMedian(bin: Uint8Array, W: number, x0: number, y0: number, x1: number, y1: number): number {
  const runs: number[] = [];
  for (let y = y0; y <= y1; y++) { let r = 0, inR = false; for (let x = x0; x <= x1; x++) { const on = bin[y * W + x] === 1; if (on && !inR) r++; inR = on; } runs.push(r); }
  runs.sort((a, b) => a - b);
  return runs.length ? runs[runs.length >> 1] : 0;
}

/** Build the subject for one soft mask (0..255, W x H). textRects: lettering blocks in source px [x0, y0, x1, y1]
 * (exclusive ends) from the glyph finder / logo match; letterMask: the letters themselves, 1 per pixel.
 * Lettering painted over the subject (a logo across a figure's cloak): when it lies in the subject's lower half, the
 * subject is cut just above it (a bottom cut, kept below the card bottom); higher up it counts as lettering in the
 * subject (the score rules it out). */
export function subjectOf(soft: Uint8Array, W: number, H: number, textRects: number[][] = [], letterMask: Uint8Array | null = null): Subject | EmptySubject {
  const N = W * H;
  const bin = new Uint8Array(N);
  for (let i = 0; i < N; i++) bin[i] = soft[i] >= 128 ? 1 : 0;
  const { lab, comps } = components(bin, W, H);
  comps.sort((a, b) => b.n - a.n || a.id - b.id);
  const textIds = textLineComponents(comps, W, H);
  const bandInfo = new Map<number, { bands: { y0: number; y1: number }[]; px: number }>();
  for (const c of comps) if (c.n >= N * 0.01 && !textIds.has(c.id)) { const tb = textBands(lab, c.id, c, W, H); if (tb.bands.length) bandInfo.set(c.id, tb); }
  for (const [id, tb] of bandInfo) { const c = comps.find(q => q.id === id)!; if (tb.px >= 0.5 * c.n) textIds.add(id); }
  for (const c of comps) {
    if (c.n < N * 0.004 || textIds.has(c.id)) continue;
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1, aspect = w / h, cyc = (c.y0 + c.y1) / 2 / H;
    const runs: number[] = [];
    for (let y = c.y0; y <= c.y1; y++) { let r = 0, inR = false; for (let x = c.x0; x <= c.x1; x++) { const on = lab[y * W + x] === c.id; if (on && !inR) r++; inR = on; } runs.push(r); }
    runs.sort((a, b) => a - b);
    const runsMed = runs[runs.length >> 1];
    if ((aspect >= 2.2 && w >= 0.45 * W && (cyc < 0.38 || cyc > 0.62)) || (runsMed >= 5 && aspect >= 1.4)) textIds.add(c.id);
  }
  // the glyph finder's veto: a component with >= 45 % of its pixels inside the detected lettering blocks is lettering
  const inText = new Uint8Array(N);
  for (const r of textRects) for (let y = Math.max(0, Math.floor(r[1])); y < Math.min(H, Math.ceil(r[3])); y++) for (let x = Math.max(0, Math.floor(r[0])); x < Math.min(W, Math.ceil(r[2])); x++) inText[y * W + x] = 1;
  const inTextCount = new Map<number, number>();
  if (textRects.length) { for (let i = 0; i < N; i++) if (lab[i] >= 0 && inText[i]) inTextCount.set(lab[i], (inTextCount.get(lab[i]) || 0) + 1); }
  const vetoed: number[] = [];
  for (const c of comps) { const k = inTextCount.get(c.id) || 0; if (!textIds.has(c.id) && c.n >= N * 0.0005 && k >= 0.45 * c.n) { textIds.add(c.id); vetoed.push(c.id); } }
  const nonText = comps.filter(c => !textIds.has(c.id) && c.n >= N * 0.0005);
  const textComps = comps.filter(c => textIds.has(c.id)).map(c => ({ x0: c.x0, y0: c.y0, x1: c.x1 + 1, y1: c.y1 + 1, n: c.n }));
  if (!nonText.length) return { empty: true, W, H, textIds, textComps, vetoed: vetoed.length };
  const main = nonText[0];
  const diag = Math.hypot(W, H), reach = 0.06 * diag;
  const near = (a: Comp, b: Comp) => { const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)); const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1)); return Math.hypot(dx, dy) <= reach; };
  const keep = [main];
  for (const c of nonText.slice(1)) if (c.n >= 0.04 * main.n && keep.some(k => near(k, c))) keep.push(c);
  const keepIds = new Set(keep.map(c => c.id));
  const sub = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (keepIds.has(lab[i])) sub[i] = 1;
  // lettering over the subject: rows where the letters cover >= 1.5 % of the subject's width
  let cutY: number | null = null, letterShare = 0;
  if (letterMask) {
    let sy0 = H, sy1 = -1, sx0 = W, sx1 = -1, tot = 0; const rowHits = new Int32Array(H);
    for (let i = 0; i < N; i++) if (sub[i]) { const x = i % W, y = (i - x) / W; tot++; if (y < sy0) sy0 = y; if (y > sy1) sy1 = y; if (x < sx0) sx0 = x; if (x > sx1) sx1 = x; if (letterMask[i]) rowHits[y]++; }
    const minHit = Math.max(2, 0.015 * (sx1 - sx0 + 1));
    let first = -1, hits = 0; for (let y = sy0; y <= sy1; y++) { hits += rowHits[y]; if (first < 0 && rowHits[y] >= minHit) first = y; }
    letterShare = tot ? hits / tot : 0;
    if (first >= 0 && hits >= 0.004 * tot) {
      if (first >= sy0 + 0.5 * (sy1 - sy0)) { cutY = Math.max(sy0 + 1, Math.round(first - 0.012 * H)); for (let y = cutY; y < H; y++) for (let x = 0; x < W; x++) sub[y * W + x] = 0; letterShare = 0; }
    } else letterShare = 0;
  }
  let area = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, inTextKept = 0;
  for (let i = 0; i < N; i++) if (sub[i]) { area++; if (inText[i]) inTextKept++; const x = i % W, y = (i - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  let textPx = 0; const bands: { y0: number; y1: number }[] = [];
  for (const c of keep) { const tb = bandInfo.get(c.id); if (tb) { textPx += tb.px; for (const b of tb.bands) bands.push(b); } }
  let cT = 0, cB = 0, cL = 0, cR = 0;
  for (let x = 0; x < W; x++) { cT += sub[x]; cB += sub[(H - 1) * W + x]; }
  for (let y = 0; y < H; y++) { cL += sub[y * W]; cR += sub[y * W + W - 1]; }
  cT /= W; cB /= W; cL /= H; cR /= H;
  // a lettering cut is a bottom cut: the subject must reach past the card bottom there
  if (cutY != null) { let n = 0; for (let x = 0; x < W; x++) n += sub[(cutY - 1) * W + x]; cB = Math.max(cB, n / W); }
  let band = 0, perim = 0;
  for (let y = Math.max(0, y0 - 4); y <= Math.min(H - 1, y1 + 4); y++) for (let x = Math.max(0, x0 - 4); x <= Math.min(W - 1, x1 + 4); x++) {
    const i = y * W + x; const v = soft[i];
    if (v > 25 && v < 230) band++;
    if (sub[i] && ((x > 0 && !sub[i - 1]) || (x < W - 1 && !sub[i + 1]) || (y > 0 && !sub[i - W]) || (y < H - 1 && !sub[i + W]))) perim++;
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const modelScale = Math.sqrt((W / 1024) * (H / 1024));   // the model saw a 1024x1024 squash: soft band in model pixels
  return {
    W, H, sub, lab, keepIds, mainId: main.id, area: area / N, bbox: { x0, y0, x1, y1, w: bw, h: bh }, fill: area / (bw * bh), contact: { t: cT, b: cB, l: cL, r: cR },
    softBand: perim ? band / perim / modelScale : 99, straight: straightShare(sub, W, H), textShare: area ? Math.max(textPx / area, letterShare) : 0, inTextShare: area ? inTextKept / area : 0, letterShare, cutY, bands,
    textIds, textComps, vetoed: vetoed.length, nKept: keep.length,
    nBig: comps.filter(c => c.n >= N * 0.002).length, runsMed: rowRunsMedian(sub, W, x0, y0, x1, y1),
  };
}

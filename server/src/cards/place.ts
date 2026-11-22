/**
 * Cards — art placement on a card (the recipe's place.cjs): the cut-out rule and the dissolve search; and for the box-art styles
 * (CARD_STYLE=cover, fade) the poster's two fixed places. Pure functions of the art analysis (or the poster's size) and the card's
 * visible window; nothing per game.
 */
import type { Block } from "./lettering";
import type { Saliency } from "./saliency";

export const MAX_SCALE = 1.25;                       // card px per source px, for every image on every card
export const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
export const alphaAt = (y: number, m0: number, m1: number) => smooth((y - m0) / (m1 - m0));

/** what a cut needs to know about its subject: the source size, the subject's box and edge contacts, the head's x */
export interface CutSubject { W: number; H: number; bbox: { x0: number; y0: number; x1: number; y1: number; w: number; h: number }; contact: { t: number; b: number; l: number; r: number }; headX: number }
export interface Window { cardW: number; cardH: number; x0: number; x1: number; cx: number; y0: number; y1: number; bleedY: number; visibleAt: (x: number, y: number) => boolean }
export interface CutFade { dir: 90 | 270; from: number; to: number }
export interface CutPlace { kind: "cut"; s: number; imgLeft: number; imgTop: number; imgW: number; imgH: number; subjTop: number; subjLeft: number; subjW: number; subjH: number; fade: CutFade[]; sides: string[] }

// ---------------------------------------------------------------- cut-out
// Size: the subject fills 88 % of the window width, or enough to fill its height (at most 1.45 card widths), never
// above MAX_SCALE. Position: its head (the centroid of its top 30 %) over the window centre, its top on the window
// top. A subject the art's bottom edge cuts sits on the card bottom (bleedY); one no edge cuts sinks 14 % of its
// height off it. A side cut that would show inside the card moves to the card edge when that costs at most 30 % of
// the window width; otherwise it fades out over 18 % of the subject's width. (A subject cut by the top edge never
// gets here: the score rules it out, so no head is ever faded.)
export function placeCut(art: CutSubject, win: Window): CutPlace {
  const b = art.bbox, W = art.W, H = art.H;
  const winW = win.x1 - win.x0, winH = win.y1 - win.y0;
  const touch = { b: art.contact.b > 0.02, l: art.contact.l > 0.02, r: art.contact.r > 0.02 };
  let s = 0.88 * winW / b.w;
  const sFill = winH * 1.04 / b.h;
  if (sFill > s) s = Math.min(sFill, 1.45 * win.cardW / b.w);
  s = Math.min(s, MAX_SCALE);
  const dispH = b.h * s, dispW = b.w * s;
  let top = win.y0;
  if (top + dispH < win.bleedY) top = touch.b ? win.bleedY - dispH : win.y1 - 0.86 * dispH;
  top = Math.max(top, win.y0);
  let left = win.cx - (art.headX - b.x0) * s;
  const cutShows = (x: number) => { for (let k = 0; k <= 10; k++) { const y = top + dispH * k / 10; if (y > win.y1) break; if (x > 0.5 && x < win.cardW - 0.5 && win.visibleAt(x, y)) return true; } return false; };
  const fades: string[] = [];
  if (touch.l && cutShows(left)) { if (left <= 0.3 * winW) left = 0; else fades.push("left"); }
  if (touch.r && cutShows(left + dispW)) { const need = win.cardW - (left + dispW); if (need <= 0.3 * winW && !(touch.l && left === 0 && need > 0)) left += need; else fades.push("right"); }
  if (touch.l && !fades.includes("left") && cutShows(left)) fades.push("left");
  const imgLeft = left - b.x0 * s, imgTop = top - b.y0 * s;
  const fade: CutFade[] = [];
  if (fades.includes("left")) fade.push({ dir: 90, from: b.x0 * s, to: b.x0 * s + 0.18 * dispW });
  if (fades.includes("right")) { const d0 = W * s - (b.x1 + 1) * s; fade.push({ dir: 270, from: d0, to: d0 + 0.18 * dispW }); }
  return { kind: "cut", s, imgLeft, imgTop, imgW: W * s, imgH: H * s, subjTop: top, subjLeft: left, subjW: dispW, subjH: dispH, fade, sides: fades };
}

// ---------------------------------------------------------------- dissolve
export interface DissolveArt { natW: number; natH: number; blocks: Block[]; sal: Saliency }
export interface Geom { w: number; h: number; m0: number; m1: number; vis: (cx: number, cy: number) => number; hiddenWeight?: number; minTextPx?: number; step?: number; cell?: number }
export interface DissolvePlace { kind: "dissolve"; s: number; dx: number; dy: number; iw: number; ih: number; shown: number; hidden: number; unseen: number; cut: number; top: number; score: number; sCover?: number; median?: number; fallback?: boolean }

// Every scale from "just covers the art area" up to 1.75x that (never above MAX_SCALE) in 9.3 % steps and every offset
// in 6 px steps is scored:
//    figure the card shows (saliency above the image's median, x mask opacity x visibility)
//    - 0.9 x figure hidden above the middle of the dissolve (0.45 on a tilted fan card)
//    - 0.35 x figure the fan leaves unseen (under the neighbouring card, below the frame)
//    - 0.3 x figure cut at the card's side edges and 0.6 x figure in the image's own top rows (a subject the source
//      already cuts off), both counted only above the image's mean figure
//    - a small zoom cost.
// Placements that let lettering show (mask opacity > 3 %) or show an image edge are rejected.
export function placeImage(an: DissolveArt, geom: Geom): DissolvePlace | null {
  const { w: CW, h: CH, m0, m1, vis } = geom;
  const minText = geom.minTextPx || 15, maxZoom = 1.75, step = geom.step || 6;
  const natW = an.natW, natH = an.natH, sal = an.sal, SW = sal.W, SH = sal.H, kx = SW / natW, ky = SH / natH;
  const sorted = Float32Array.from(sal.S).sort(), median = sorted[sorted.length >> 1];
  const F = new Float32Array(SW * SH); for (let i = 0; i < F.length; i++) F[i] = Math.max(0, sal.S[i] - median);
  const colPre: Float32Array[] = []; for (let x = 0; x < SW; x++) { const c = new Float32Array(SH + 1); for (let y = 0; y < SH; y++) c[y + 1] = c[y] + F[y * SW + x]; colPre.push(c); }
  let meanF = 0; for (let i = 0; i < F.length; i++) meanF += F[i]; meanF /= F.length;
  const cell = geom.cell || 12;
  // the sample grid: columns cxs, rows cys (rows the mask shows); each cell keeps its column, row and weight, in row
  // order, so a position's sum runs over precomputed column and row indices in exactly the order of the plain loop
  const cxs: number[] = [], cys: number[] = [];
  for (let cx = cell / 2; cx < CW; cx += cell) cxs.push(cx);
  const cc: number[] = [], cr: number[] = [], cw: number[] = [], uc: number[] = [], ur: number[] = [], uw: number[] = []; let wsum = 0, wun = 0;
  for (let cy = cell / 2; cy < CH; cy += cell) {
    const a = alphaAt(cy, m0, m1); if (a <= 0) continue;
    const r = cys.length; cys.push(cy);
    for (let c = 0; c < cxs.length; c++) { const cx = cxs[c], v = vis(cx, cy); if (v <= 0) { uc.push(c); ur.push(r); uw.push(a); wun += a; continue; } cc.push(c); cr.push(r); cw.push(a * v); wsum += a * v; }
  }
  const CC = Int32Array.from(cc), CR = Int32Array.from(cr), CWt = Float64Array.from(cw), UC = Int32Array.from(uc), UR = Int32Array.from(ur), UWt = Float64Array.from(uw);
  const ixCol = new Int32Array(cxs.length), iyRow = new Int32Array(cys.length);
  const yHidden = hiddenTo(m0, m1);
  const yMid = (m0 + m1) / 2;
  const sCover = Math.max(CW / natW, (CH - m0) / natH);
  const sBase = sCover;
  const sTop = Math.max(sBase, Math.min(MAX_SCALE, sCover * maxZoom));
  const scales = [sBase];
  for (let k = 1; k < 40; k++) { const s = sBase * Math.pow(1.093, k); if (s > sTop + 1e-9) break; scales.push(s); }
  if (sTop - scales[scales.length - 1] > 0.005) scales.push(sTop);
  const textOk = (s: number, dx: number, dy: number) => textHidden(an.blocks, natW, natH, s, dx, dy, CW, CH, yHidden, minText);
  let best: DissolvePlace | null = null;
  for (const s of scales) {
    const iw = s * natW, ih = s * natH, px2 = (s / kx) * (s / ky) / (cell * cell);
    const dxs: number[] = []; for (let dx = CW - iw; dx < 0; dx += step) dxs.push(dx); dxs.push(0);
    const dys: number[] = []; for (let dy = CH - ih; dy < m0; dy += step) dys.push(dy); dys.push(Math.max(CH - ih, m0));
    for (const dx of dxs) for (const dy of dys) {
      if (dy > m0 + 0.01 || dy + ih < CH - 0.01 || dx > 0.01 || dx + iw < CW - 0.01) continue;
      if (!textOk(s, dx, dy)) continue;
      // out-of-image columns and rows are marked -1 (the same floors the plain loop takes per cell)
      for (let c = 0; c < cxs.length; c++) { const ix = Math.floor((cxs[c] - dx) / s * kx); ixCol[c] = ix >= 0 && ix < SW ? ix : -1; }
      for (let r = 0; r < cys.length; r++) { const iy = Math.floor((cys[r] - dy) / s * ky); iyRow[r] = iy >= 0 && iy < SH ? iy : -1; }
      let acc = 0;
      for (let k = 0; k < CC.length; k++) { const ix = ixCol[CC[k]], iy = iyRow[CR[k]]; if (ix >= 0 && iy >= 0) acc += CWt[k] * F[iy * SW + ix]; }
      const shown = acc / wsum;
      let un = 0;
      for (let k = 0; k < UC.length; k++) { const ix = ixCol[UC[k]], iy = iyRow[UR[k]]; if (ix >= 0 && iy >= 0) un += UWt[k] * F[iy * SW + ix]; }
      const unseenMean = un / (wsum + wun);
      const xa = Math.max(0, Math.floor(-dx / s * kx)), xb = Math.min(SW, Math.ceil((CW - dx) / s * kx));
      const rowMid = Math.max(0, Math.min(SH, Math.round((yMid - dy) / s * ky)));
      let hid = 0; for (let x = xa; x < xb; x++) hid += colPre[x][rowMid];
      const hidden = hid * px2 / wsum;
      const strip = Math.max(1, Math.round(40 / s * kx));
      const rA = Math.max(0, Math.min(SH, Math.round((m1 - dy) / s * ky))), rB = Math.max(0, Math.min(SH, Math.round((CH - dy) / s * ky)));
      let cut = 0, cn = 0;
      for (let x = xa - strip; x < xa; x++) if (x >= 0) { cut += colPre[x][rB] - colPre[x][rA]; cn += rB - rA; }
      for (let x = xb; x < xb + strip; x++) if (x < SW) { cut += colPre[x][rB] - colPre[x][rA]; cn += rB - rA; }
      const cutMean = cn ? Math.max(0, cut / cn - meanF) : 0;
      const rt = Math.max(1, Math.round(0.04 * SH));
      let top = 0; for (let x = xa; x < xb; x++) top += colPre[x][rt];
      const topMean = xb > xa ? Math.max(0, top / ((xb - xa) * rt) - meanF) : 0;
      const zoom = Math.log(s / sCover) / Math.log(1.093);
      const score = shown - (geom.hiddenWeight == null ? 0.9 : geom.hiddenWeight) * hidden - 0.35 * unseenMean - 0.3 * cutMean - 0.6 * topMean - 0.006 * zoom;
      if (!best || score > best.score + 1e-9) best = { kind: "dissolve", s, dx, dy, iw, ih, shown, hidden, unseen: unseenMean, cut: cutMean, top: topMean, score };
    }
  }
  return best && { ...best, kind: "dissolve", sCover, median };
}

/** the last row of a ramp m0..m1 that is still out of sight (opacity at most 3 %) */
export function hiddenTo(m0: number, m1: number): number {
  let y = m0; while (alphaAt(y + 1, m0, m1) <= 0.03) y++;
  return y;
}
/** Does the image keep its lettering out of sight at scale s and offset (dx, dy) on a CW x CH card? Every block whose letters are
 * minText tall or more on the card ([x0, y0, x1, y1, letter height], fractions of the natW x natH image; a block without its
 * letter height always counts) lies off the card's sides, below its bottom edge, or above `yHidden` (hiddenTo). */
export function textHidden(blocks: readonly number[][], natW: number, natH: number, s: number, dx: number, dy: number, CW: number, CH: number, yHidden: number, minText: number): boolean {
  for (const b of blocks) {
    if (s * b[4] * natH < minText) continue;
    const X0 = dx + s * b[0] * natW, X1 = dx + s * b[2] * natW, Y0 = dy + s * b[1] * natH, Y1 = dy + s * b[3] * natH;
    if (X1 <= 0 || X0 >= CW || Y0 >= CH) continue;
    if (Math.min(Y1, CH) > yHidden) return false;
  }
  return true;
}

/// ---------------------------------------------------------------- the box art where the cut-out stood
/** What shows of a card, on a grid of `cell`-unit squares: each cell's weight (0..1, sampled at its centre) as prefix sums, so the
 * weight under any box is four lookups. */
export interface ShowGrid { cell: number; cols: number; rows: number; sum: Float64Array }
export function showGrid(W: number, H: number, weight: (x: number, y: number) => number, cell = 4): ShowGrid {
  const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell), sum = new Float64Array((cols + 1) * (rows + 1)), C = cols + 1;
  for (let r = 0; r < rows; r++) {
    let acc = 0;
    for (let c = 0; c < cols; c++) { acc += weight((c + 0.5) * cell, (r + 0.5) * cell); sum[(r + 1) * C + c + 1] = sum[r * C + c + 1] + acc; }
  }
  return { cell, cols, rows, sum };
}
/** the grid's weight under the box x0..x1, y0..y1 (card units): the cells whose centres it holds */
export function shownIn(g: ShowGrid, x0: number, y0: number, x1: number, y1: number): number {
  const c0 = Math.max(0, Math.ceil(x0 / g.cell - 0.5)), c1 = Math.min(g.cols, Math.ceil(x1 / g.cell - 0.5));
  const r0 = Math.max(0, Math.ceil(y0 / g.cell - 0.5)), r1 = Math.min(g.rows, Math.ceil(y1 / g.cell - 0.5));
  if (c1 <= c0 || r1 <= r0) return 0;
  const C = g.cols + 1;
  return g.sum[r1 * C + c1] - g.sum[r0 * C + c1] - g.sum[r1 * C + c0] + g.sum[r0 * C + c0];
}
/** whether a block ([x0, y0, x1, y1, letter height], fractions of the natW x natH image) has letters minText tall or more at scale
 *  s (a block without its letter height always counts) */
const counts = (b: readonly number[], s: number, natH: number, minText: number) => b[4] == null || s * b[4] * natH >= minText;
/** How much of an image's lettering shows at scale s and offset (dx, dy): the grid's weight under every block that counts, each
 * grown by half a cell (so a sliver between cell centres counts too). 0: none of it shows. */
export function letteringSeen(blocks: readonly number[][], natW: number, natH: number, s: number, dx: number, dy: number, g: ShowGrid, minText: number): number {
  let seen = 0;
  const m = g.cell / 2;
  for (const b of blocks) {
    if (!counts(b, s, natH, minText)) continue;
    seen += shownIn(g, dx + s * b[0] * natW - m, dy + s * b[1] * natH - m, dx + s * b[2] * natW + m, dy + s * b[3] * natH + m);
  }
  return seen;
}
/** whether no block that counts reaches into the box x0..x1, y0..y1 (card units) at scale s and offset (dx, dy) */
function outOfBox(blocks: readonly number[][], natW: number, natH: number, s: number, dx: number, dy: number, box: { x0: number; y0: number; x1: number; y1: number }, minText: number): boolean {
  for (const b of blocks) {
    if (!counts(b, s, natH, minText)) continue;
    if (dx + s * b[2] * natW > box.x0 && dx + s * b[0] * natW < box.x1 && dy + s * b[3] * natH > box.y0 && dy + s * b[1] * natH < box.y1) return false;
  }
  return true;
}
/** the zoom steps of the box-art places: from `from` in the dissolve search's 9.3 % steps up to `to` (both included) */
function zooms(from: number, to: number): number[] {
  const out: number[] = [];
  for (let k = 0; ; k++) { const s = Math.min(to, from * Math.pow(1.093, k)); out.push(s); if (s >= to - 1e-9) break; }
  return out;
}
/** the offsets lo..hi in 2-unit steps, nearest `at` first (the lower first on a tie) */
function nearest(lo: number, hi: number, at: number): number[] {
  const a = Math.max(lo, Math.min(hi, at)), out = [a];
  for (let d = 2; a - d > lo - 2 || a + d < hi + 2; d += 2) {
    if (a - d > lo - 2) out.push(Math.max(lo, a - d));
    if (a + d < hi + 2) out.push(Math.min(hi, a + d));
  }
  return out;
}

/** the cover's corner radius, and its least width, as fractions of its width and of the card's; how far it may zoom into the
 *  poster to keep the lettering out of its frame */
export const COVER_RADIUS = 0.045, COVER_MIN = 0.44, COVER_ZOOM = 1.75;
/** the cover: its frame (x, y, w, h: the poster's shape at the frame's width, corners rounded by r), the poster inside it (img,
 *  card units: the frame clips it), and how much lettering still shows (0 but for the last resort) */
export interface CoverPlace { kind: "cover"; s: number; x: number; y: number; w: number; h: number; r: number; img: { x: number; y: number; w: number; h: number }; seen: number }

/** The cover (CARD_STYLE=cover): the poster as an object where the cut-out stood, one rule for every poster.
 * The frame: as wide as the window under the labels less the labels' own padding on either side (so its edges line up with the
 * title's), centred on the window, its top on the window top, in the poster's shape, running on past the bottom edge like a
 * cut-out (the frame hides the bottom of every fan card); never under 44 % of the card's width (on an outer fan card under a long
 * title the window is a sliver: the poster's top shows there, as a cut-out's head would); its corners rounded at 4.5 % of its width.
 * Inside it the poster shows none of its lettering (`blocks`, poster.ts posterText: the card's title already names the game):
 * centred across, at the least zoom (1x up to 1.75x in 9.3 % steps) at which a place nearest the poster's top (its top on the
 * frame's top, else moved up just enough) leaves the lettering out of the frame (or under the card's bottom edge), or else out of
 * what the fan shows of the card (`win.visibleAt`: under the next card, under the frame's bottom edge); failing that, where the
 * least of it shows. The poster always fills the frame down to `bottom(x0, x1)`, the lowest row the card shows across the frame
 * (with a margin for a hovered or turning card). */
export function placeCover(natW: number, natH: number, win: Window, pad: number, blocks: readonly number[][] = [], { bottom = () => win.cardH, minTextPx = 8 }: { bottom?: (x0: number, x1: number) => number; minTextPx?: number } = {}): CoverPlace {
  const w = Math.max(COVER_MIN * win.cardW, win.x1 - win.x0 - 2 * pad), h = (w * natH) / natW;
  const x = win.cx - w / 2, y = win.y0, r = COVER_RADIUS * w;
  const fill = Math.min(y + h, Math.max(y, bottom(x, x + w)));            // the poster fills the frame down to here
  const frame = { x0: x, y0: y, x1: x + w, y1: Math.min(y + h, win.cardH) };   // what of the frame lies on the card
  const shown = showGrid(win.cardW, win.cardH, (px, py) => (px >= x && px <= x + w && py >= y && py <= y + h && win.visibleAt(px, py) ? 1 : 0));
  const at = (z: number, iy: number, seen: number): CoverPlace => {
    const iw = w * z, ih = h * z;
    return { kind: "cover", s: iw / natW, x, y, w, h, r, img: { x: x + (w - iw) / 2, y: y + iy, w: iw, h: ih }, seen };
  };
  let best: CoverPlace | null = null;
  for (const z of zooms(1, Math.max(1, Math.min(COVER_ZOOM, (MAX_SCALE * natW) / w)))) {
    const iw = w * z, ih = h * z, ix = x + (w - iw) / 2;
    for (let iy = 0; iy >= fill - y - ih - 1e-9; iy -= 2) if (outOfBox(blocks, natW, natH, iw / natW, ix, y + iy, frame, minTextPx)) return at(z, iy, 0);
    for (let iy = 0; iy >= fill - y - ih - 1e-9; iy -= 2) {
      const seen = letteringSeen(blocks, natW, natH, iw / natW, ix, y + iy, shown, minTextPx);
      if (seen <= 0) return at(z, iy, 0);
      if (!best || seen < best.seen - 1e-9) best = at(z, iy, seen);
    }
  }
  return best ?? at(1, 0, 0);
}

/** what the fade's place needs of the card: its size, the ramp (m0..m1), the least letter height that counts, what shows of it
 *  (`vis` > 0; fan cards: not under the next card or the frame), the middle of what shows across (`cx`) and the lowest row that
 *  shows (`y1`); by default a card shows all of itself */
export interface FadeGeom { w: number; h: number; m0: number; m1: number; minTextPx?: number; vis?: (x: number, y: number) => number; cx?: number; y1?: number }

/** The fade (CARD_STYLE=fade): the poster under the dissolve's ramp, by one rule for every poster in place of the dissolve's search.
 * Across, its middle goes to the middle of what the card shows (`cx`; a fan card's visible window), zooming as much as that takes
 * for the poster to still cover the card (up to 1.75x the scale that just covers the art area; past that, as near as 1.75x
 * allows). Down:
 *   - under a wordmark at the top (lettering centred in the poster's top half), the art right under it goes to the top of what shows:
 *     the lettering's bottom edge at the last row the ramp keeps out of sight (hiddenTo). A poster sets its subject just under its
 *     logo (a head, most often), and that band would otherwise stay under the colour;
 *   - otherwise the poster row that sits at the middle of what shows (the ramp's start to `y1`) when the poster just covers the
 *     card bottom-aligned stays there at every zoom (on the centre card: bottom-aligned, the top under the ramp, the middle showing).
 * Then it keeps its lettering (`blocks`, poster.ts posterText) out of sight, at the least zoom that can (the search's 9.3 % steps
 * up to 1.75x, never above MAX_SCALE) and the place nearest that one: the lettering off the card or above the ramp; failing that,
 * out of what the fan shows (`vis`: under the next card, under the frame's bottom edge); failing that, where the least of it shows
 * (weighted by the ramp's opacity). */
export function placeFade(natW: number, natH: number, geom: FadeGeom, blocks: readonly number[][] = []): DissolvePlace {
  const { w: CW, h: CH, m0, m1 } = geom;
  const cx = geom.cx ?? CW / 2, minText = geom.minTextPx || 15;
  const sCover = Math.max(CW / natW, (CH - m0) / natH), sTop = Math.max(sCover, Math.min(MAX_SCALE, sCover * 1.75));
  // the zoom at which the poster, its middle on cx, still covers the card
  const sMid = Math.min(sTop, Math.max(sCover, (2 * Math.max(cx, CW - cx)) / natW));
  const y1 = Math.min(CH, geom.y1 ?? CH), mid = (m0 + y1) / 2;
  const f0 = (mid - (CH - sCover * natH)) / (sCover * natH);            // the poster row at the middle of what shows
  const yHidden = hiddenTo(m0, m1);
  const shown = showGrid(CW, CH, (x, y) => { const a = alphaAt(y, m0, m1); return a > 0.03 && (!geom.vis || geom.vis(x, y) > 0) ? a : 0; });
  const dxAt = (iw: number) => Math.max(CW - iw, Math.min(0, cx - iw / 2));
  const at = (s: number, dy: number, score = 0): DissolvePlace =>
    ({ kind: "dissolve", s, dx: dxAt(s * natW), dy, iw: s * natW, ih: s * natH, shown: 0, hidden: 0, unseen: 0, cut: 0, top: 0, score, sCover });
  // the bottom edge of the wordmark at the top (the lettering that counts at scale s, centred in the poster's top half); 0: none
  const topEdge = (s: number) => { let f = 0; for (const b of blocks) if (b[1] + b[3] < 1 && counts(b, s, natH, minText)) f = Math.max(f, b[3]); return f; };
  const anchor = (s: number, ih: number) => { const f = topEdge(s); return f > 0 ? yHidden - f * ih : mid - f0 * ih; };
  let best: DissolvePlace | null = null, least = Infinity;
  for (const pass of ["card", "shown"] as const) {
    for (const s of zooms(sMid, sTop)) {
      const iw = s * natW, ih = s * natH, dx = dxAt(iw);
      for (const dy of nearest(CH - ih, m0, anchor(s, ih))) {
        if (pass === "card") { if (textHidden(blocks, natW, natH, s, dx, dy, CW, CH, yHidden, minText)) return at(s, dy); continue; }
        const seen = letteringSeen(blocks, natW, natH, s, dx, dy, shown, minText);
        if (seen <= 0) return at(s, dy);
        if (seen < least - 1e-9) { least = seen; best = at(s, dy, -seen); }
      }
    }
  }
  return best ?? at(sMid, Math.max(CH - sMid * natH, Math.min(m0, anchor(sMid, sMid * natH))));
}

/** Last resort (never throws): the image's middle band at cover scale, centred; used when no placement keeps the
 * lettering hidden. */
export function placeMiddle(an: { natW: number; natH: number }, geom: { w: number; h: number; m0: number }): DissolvePlace {
  const s = Math.max(geom.w / an.natW, (geom.h - geom.m0) / an.natH);
  const iw = s * an.natW, ih = s * an.natH;
  return { kind: "dissolve", s, dx: (geom.w - iw) / 2, dy: Math.max(geom.h - ih, Math.min(geom.m0, geom.m0 - (ih - (geom.h - geom.m0)) / 2)), iw, ih, shown: 0, hidden: 0, unseen: 0, cut: 0, top: 0, score: -1, fallback: true };
}

/**
 * Cards — fan geometry (the recipe's geom.cjs): card-local <-> board transforms for rotated cards (transform-origin
 * 50% 50%), rounded-rect hit tests, visibility of card-local points (inside the frame, not under a card with a higher
 * z-index) and the darkening the box-shadows of the cards above cast on a point.
 */

export interface Shadow { x: number; y: number; blur: number; spread: number; a: number }
export interface Box { x: number; y: number; w: number; h: number }
export interface Frame { x0: number; y0: number; x1: number; y1: number }
export interface Card {
  left: number; top: number; w: number; h: number; rot: number; z: number; radius: number; shadow: Shadow | null; cx: number; cy: number;
  toBoard(x: number, y: number): [number, number];
  toLocal(X: number, Y: number): [number, number];
  insideLocal(x: number, y: number): boolean;
  insideBoard(X: number, Y: number): boolean;
}

export function makeCard({ left, top, w, h, rot, z, radius, shadow = null }: { left: number; top: number; w: number; h: number; rot: number; z: number; radius: number; shadow?: Shadow | null }): Card {
  const a = rot * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const cx = left + w / 2, cy = top + h / 2;
  const toBoard = (x: number, y: number): [number, number] => { const dx = x - w / 2, dy = y - h / 2; return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]; };
  const toLocal = (X: number, Y: number): [number, number] => { const dx = X - cx, dy = Y - cy; return [w / 2 + dx * cos + dy * sin, h / 2 - dx * sin + dy * cos]; };
  const insideLocal = (x: number, y: number) => {
    if (x < 0 || y < 0 || x > w || y > h) return false;
    const r = radius;
    const qx = x < r ? r - x : x > w - r ? x - (w - r) : 0;
    const qy = y < r ? r - y : y > h - r ? y - (h - r) : 0;
    return qx * qx + qy * qy <= r * r;
  };
  return { left, top, w, h, rot, z, radius, shadow, cx, cy, toBoard, toLocal, insideLocal, insideBoard: (X, Y) => { const [x, y] = toLocal(X, Y); return insideLocal(x, y); } };
}

/** Is the card-local point (x,y) of card c visible on the board (inside the frame) and not covered by a higher card? */
export function visible(c: Card, cards: Card[], x: number, y: number, frame: Frame): boolean {
  const [X, Y] = c.toBoard(x, y);
  if (X < frame.x0 || Y < frame.y0 || X > frame.x1 || Y > frame.y1) return false;
  for (const o of cards) if (o !== c && o.z > c.z && o.insideBoard(X, Y)) return false;
  return true;
}

/** Every sample of a card-local box visible?  Samples the border and interior every `step` px. */
export function boxVisible(c: Card, cards: Card[], box: Box, frame: Frame, step = 3): boolean {
  for (let y = box.y; y <= box.y + box.h + 1e-6; y += Math.min(step, Math.max(1, box.h / 2)))
    for (let x = box.x; x <= box.x + box.w + 1e-6; x += Math.min(step, Math.max(1, box.w / 2)))
      if (!visible(c, cards, x, y, frame)) return false;
  return true;
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7). */
function Phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + e) / 2 : (1 - e) / 2;
}
/** How much the box-shadows of the cards above c darken its card-local point (x, y): 0 (untouched) to 1 (black). A CSS
 * box-shadow is the card's box offset by (x, y), grown by its spread, blurred by a gaussian of sigma blur / 2 and drawn
 * only outside its own card; the rounded corners are taken square (a slight overestimate, on the safe side). */
export function shadowAt(c: Card, cards: Card[], x: number, y: number): number {
  const [X, Y] = c.toBoard(x, y);
  let keep = 1;
  for (const o of cards) {
    if (o === c || o.z <= c.z || !o.shadow) continue;
    const [u, v] = o.toLocal(X, Y);
    if (o.insideLocal(u, v)) continue;
    const s = o.shadow, sg = Math.max(0.5, s.blur / 2);
    const x0 = s.x - s.spread, x1 = o.w + s.x + s.spread, y0 = s.y - s.spread, y1 = o.h + s.y + s.spread;
    const g = (Phi((u - x0) / sg) - Phi((u - x1) / sg)) * (Phi((v - y0) / sg) - Phi((v - y1) / sg));
    keep *= 1 - s.a * g;
  }
  return 1 - keep;
}
/** The strongest shadow over a card-local box (sampled like boxVisible). */
export function boxShadow(c: Card, cards: Card[], box: Box, step = 3): number {
  let m = 0;
  for (let y = box.y; y <= box.y + box.h + 1e-6; y += Math.min(step, Math.max(1, box.h / 2)))
    for (let x = box.x; x <= box.x + box.w + 1e-6; x += Math.min(step, Math.max(1, box.w / 2)))
      m = Math.max(m, shadowAt(c, cards, x, y));
  return m;
}

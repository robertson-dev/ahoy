/**
 * Cards — the cut-out quality score (the recipe's score.cjs). One rule for every game: each factor maps one mask signal
 * to 0..1, the score is their product, logo-free art gets a bonus (its cut-out cannot carry a burned-in title), and a
 * cut-out is used only when its score clears CUTOUT_THRESHOLD; otherwise the card falls back to a dissolve.
 */
import type { EmptySubject, Subject } from "./analyse";

export const CUTOUT_THRESHOLD = 0.5;
const ramp = (v: number, a: number, b: number) => (v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a));

export function score(s: Subject | EmptySubject | null, { logoFree }: { logoFree: boolean }): { q: number; f: Record<string, number> } {
  if (!s || s.empty) return { q: 0, f: {} };
  const f: Record<string, number> = {
    // subject share of the art: under ~4 % the model found a detail of a scene, over ~60 % it took the whole frame
    area: ramp(s.area, 0.035, 0.06) * (1 - ramp(s.area, 0.45, 0.7)),
    // a mask that fills its own bounding box is a region (a panel, a window, a backdrop), not a figure
    fill: 1 - 0.8 * ramp(s.fill, 0.7, 0.9),
    // width of the model's uncertain edge band, in model pixels: soft masks leave halos when cut hard
    edge: 1 - 0.65 * ramp(s.softBand, 3.5, 7),
    // long straight outline runs: architecture and UI frames rather than a subject
    straight: 1 - 0.8 * ramp(s.straight, 0.2, 0.5),
    // lettering kept inside the subject
    text: 1 - ramp(s.textShare, 0, 0.25),
    // a subject the art's own top edge cuts has lost its top (for a figure, the head): anything beyond a hair-thin
    // contact (0.2 % of the width) rules the candidate out (the other image, or the dissolve, is used)
    top: 1 - ramp(s.contact.t, 0.002, 0.012),
    // rows crossing the mask many times: a backdrop striped by line art, not a figure
    fragments: 1 - 0.6 * ramp(s.runsMed, 3, 6),
    // cut by both side edges: a band across the art rather than an object
    sides: s.contact.l > 0.3 && s.contact.r > 0.3 ? 0.5 : 1,
  };
  let q = Object.values(f).reduce((a, b) => a * b, 1);
  if (logoFree) q *= 1.25;
  return { q, f };
}

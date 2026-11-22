/**
 * Spotlight — the JSON the endpoint answers (contracts/spotlight.md), and the layout built from a decision. Lengths are CSS px
 * on the stage (the full-width block from the window's top edge); "file px" are the image's own pixels.
 */
import { RULE, geometryFor, round2, type Box } from "./rule";
import type { Decision } from "./decide";

/** the widths the server lays the stage out for: the asked width rounded to 40 px, from 960 to 2560 */
export const BUCKET = { step: 40, min: 960, max: 2560 };
export const bucketOf = (w: number) => Math.min(BUCKET.max, Math.max(BUCKET.min, Math.round(w / BUCKET.step) * BUCKET.step));

export interface SpotLayout {
  /** the stage this layout was decided for */
  stage: { w: number; bar: number; left: number; boxH: number; fade: { from: number; to: number; step: number }; idBottom: number; factsGap: number; actionsGap: number };
  art: {
    url: string;
    /** the file's size, and the rows the rule used (art that is not a Steam library hero: its top 90%) */
    w: number; h: number; windowH: number;
    fromSteam: boolean;
    /** no key art: the hero route's blank gradient */
    placeholder: boolean;
    /** CSS px per file px, and the image's box on the stage (its top-left at x, y; x is -pan) */
    scale: number; x: number; y: number; width: number; height: number;
    /** blur in CSS px (0: sharp); a blurred image reaches `reach` px past the stage on the left, right and top */
    blur: number; reach: number;
    /** where the pan put the subject: the art's x (0..1 of the file's width) at the middle of the room beside the text */
    focus: number;
  };
  scrim: {
    /** the top scrim (.72 at 0, .5 at 120, 0 at 240) times `top` */
    top: number;
    /** the side scrim's strength with a facts line of the nominal width (`nominalFacts`) */
    k: number; nominalFacts: number;
    /** [w, k] rising: a facts line w px wide takes the k of the last step whose w is below its width; the first step also holds
     *  for no facts line. Use this, not `k`, with the real facts line. */
    steps: [number, number][];
    /** the side scrim at strength 1 for this stage width: [x px, alpha]; multiply every alpha by k (and clamp to 1) */
    side: [number, number][];
  };
  /** the room the pan kept the subject in: right of `right` (the text's right edge + 24) and left of `clear` (the stage width - 100) */
  text: { right: number; top: number; bottom: number; clear: number };
  identity:
    | { kind: "logo"; recolour: boolean; filter: string | null; url: string;
        /** the PNG's size and the crop window (file px), and how it is drawn: scale, the window's size (width x height) with its
         *  left edge `hang` px left of the content edge, the identity's own width (inkWidth: the h1), standing on y `bottom` */
        file: { w: number; h: number }; crop: Box; scale: number; width: number; height: number; hang: number; inkWidth: number; bottom: number }
    | { kind: "title"; size: number; lineHeight: number; letterSpacing: number; lines: string[]; widest: number; height: number; bearing: number; bottom: number };
  /** why the identity is what it is (debugging; never shown) */
  why: string[];
  ms: number;
}

export interface SpotlightJson {
  v: 1;
  /** what the layout was made from (the art's and the logo's bytes, the name, the rule): a new key means new art */
  key: string | null;
  status: "ready" | "pending";
  retryAfter: number | null;
  /** the stage asked for (after rounding: w to its bucket) */
  asked: { w: number; bar: number; left: number };
  /** the layout for `asked`, or while that one is being made, the nearest one there is (its stage.w differs); null: none yet */
  layout: SpotLayout | null;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
/** the side scrim's profile (strength 1) on a stage this wide */
export const sideProfile = (W: number): [number, number][] => RULE.scrimH(W).map(([x, a]) => [round2(x), a]);

/** the layout of a decision, without its URLs (added per source when answered) */
export function layoutOf(d: Decision, hero: { w: number; h: number; fromSteam: boolean; placeholder: boolean }, logoSize: { w: number; h: number } | null, w: number, bar: number, left: number, nominalFacts: number): SpotLayout {
  const geo = geometryFor(w, bar, left), pl = d.placement;
  const clear = w - RULE.anchor.clearRight, xc = (d.text.right + clear) / 2;
  const id = d.identity;
  const identity: SpotLayout["identity"] = id.kind === "logo"
    ? { kind: "logo", recolour: id.recolour, filter: id.recolour ? RULE.logo.recolour : null, url: "", file: logoSize ?? { w: 0, h: 0 }, crop: id.fit.box, scale: r6(id.fit.k),
        width: id.fit.dw, height: id.fit.dh, hang: id.fit.hang, inkWidth: id.fit.inkW, bottom: RULE.id.bottom + geo.dy }
    : { kind: "title", size: id.title.size, lineHeight: id.title.lineHeight, letterSpacing: RULE.title.letterSpacing, lines: id.title.lines, widest: round2(id.title.widest), height: round2(id.title.height), bearing: id.title.bearing, bottom: RULE.id.bottom + geo.dy };
  return {
    stage: { w, bar, left, boxH: geo.boxH, fade: { from: geo.fadeFrom, to: geo.fadeTo, step: RULE.fade.step }, idBottom: RULE.id.bottom + geo.dy, factsGap: 24, actionsGap: 28 },
    art: { url: "", w: hero.w, h: hero.h, windowH: pl.winH, fromSteam: hero.fromSteam, placeholder: hero.placeholder, scale: r6(pl.s), x: -d.ox, y: -d.oy,
      width: round2(pl.dispW), height: round2(pl.dispH), blur: pl.blur, reach: pl.reach, focus: r6((xc + d.ox) / pl.s / hero.w) },
    scrim: { top: d.topK, k: d.k, nominalFacts, steps: d.steps, side: sideProfile(w) },
    text: { right: round2(d.text.right), top: round2(d.text.top), bottom: RULE.anchor.textBottom + geo.dy, clear },
    identity, why: d.why, ms: d.ms,
  };
}

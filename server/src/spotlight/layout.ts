/**
 * Spotlight — where the text sits on the stage (the generator laid the board out in a browser; here it is a model of the same
 * layout, measured against the board on all 21 games):
 *   - the top bar and the presence chips: the board's own runs (board.ts), the left cluster and the chips from the content edge,
 *     the right cluster from the right edge, everything in the bar moved by half the bar's change and the chips by all of it;
 *   - the stage, from the content edge, standing on y 380 (+ the bar's change): the identity (a logo's box or the title), 24 below
 *     it one facts line (Figtree 400 17/24), 28 below that the actions (the white primary pill, 12, then Details);
 *   - the title: Bricolage Grotesque 800, line-height 1.06, letter-spacing -0.02em, balanced, the largest whole size from 160
 *     down to 16 that fits 580 x 140 in at most two lines, widths from the fonts' advance widths (cards/fontmetrics.ts, the same
 *     numbers the generator's browser used; kerning is not in them, so a width can only come out a little wide, never narrow),
 *     shifted left by the smallest left side bearing among its line-starting letters (board.ts BEARINGS).
 */
import { FONT_METRICS } from "../cards/fontmetrics";
import { BEARINGS, BOARD_RUNS, KERN } from "./board";
import { RULE, type Geometry, type Rect, type Run } from "./rule";

/** the text of the stage the server cannot know (it is the viewer's: play time, progress, which action): how wide the facts line
 *  is, and the label(s) the primary pill may carry (Details stands after it, so it may stand at each of their ends) */
export interface StageText { factsWidth: number; primaries: string[] }
/** what a page may show: a facts line as long as "Arrived Wednesday · 12.5 GB" or "Nov 6 · today · Pell tracks it" (for the pan's
 *  text edge; its strength comes back per width), and every label GameAction's primary can have */
export const NOMINAL_STAGE: StageText = { factsWidth: 240, primaries: ["Play", "Running", "Install", "Cancel", "Track", "Tracked", "Request", "Try again", "Watch for it"] };

type FontKey = keyof typeof FONT_METRICS;
/** Bricolage 800's kerning, "ab" -> px at 100 px */
const KERNING = new Map<string, number>();
for (const [a, list] of Object.entries(KERN)) for (const m of list.matchAll(/(.)([+-]\d+(?:\.\d+)?)(?: |$)/gu)) KERNING.set(a + m[1], Number(m[2]));
/** the width of a string (no safety margin: these are the browser's own advances), letter-spacing after every character, and for
 *  the display face its kerning */
export function textWidth(str: string, font: FontKey, size: number, letterSpacingEm = 0): number {
  const t = FONT_METRICS[font], kern = font === "display800";
  let w = 0, prev = "";
  for (const ch of str) {
    w += ((t[ch] !== undefined ? t[ch] : t["n"]) / 100) * size + letterSpacingEm * size;
    if (kern && prev) w += ((KERNING.get(prev + ch) ?? 0) / 100) * size;
    prev = ch;
  }
  return w;
}

const D = RULE.dpr;
/** a Figtree line's text box inside its line (ascent .95, descent .25 of the size, each whole device px), and Bricolage's (.93, .27) */
function inlineBox(size: number, lineHeight: number, asc: number, desc: number) {
  const a = Math.round(asc * size * D), d = Math.round(desc * size * D);
  return { top: Math.floor((lineHeight * D - (a + d)) / 2) / D, h: (a + d) / D };
}

// the board's stage, measured (Details is a fixed word: its pill and label are the board's)
const STAGE = {
  idBottom: RULE.id.bottom, factsTop: 404, factsLine: 24, factsSize: 17, actionsTop: 456, actionsH: 48, gap: 12,
  primaryPad: 24 + 18 + 8 + 28,                 // padding 24, the icon 18, gap 8, the label, padding 28
  details: { w: 95.969, labelX: 24.667, labelW: 46.635, labelTop: 15, labelH: 18 },
  labelSize: 15,
};

/** the bar's and the chips' runs on this stage */
export function boardRuns(geo: Geometry): Run[] {
  const dl = geo.left - RULE.board.left;
  return BOARD_RUNS.map(r => {
    const dx = r.at === "left" ? dl : r.at === "right" ? geo.W - RULE.board.w - dl : (geo.W - RULE.board.w) / 2;
    const dy = r.zone === "chips" ? geo.dy : geo.dy / 2;
    const mv = (x: Rect): Rect => ({ l: x.l + dx, t: x.t + dy, r: x.r + dx, b: x.b + dy });
    const ground = r.ground.kind === "glass" ? { ...r.ground, rect: mv(r.ground.rect) } : r.ground;
    return { who: r.who, text: r.text, rgb: r.rgb, rects: r.rects.map(mv), ground, need: r.need, reportOnly: r.reportOnly };
  });
}

/** the facts line and the actions: their runs, and how far right the stage's text reaches without the identity */
export function stageRuns(geo: Geometry, st: StageText = NOMINAL_STAGE): { runs: Run[]; right: number; details: Rect } {
  const x = geo.left, dy = geo.dy;
  const fb = inlineBox(STAGE.factsSize, STAGE.factsLine, 0.95, 0.25);
  const facts: Rect = { l: x, t: STAGE.factsTop + dy + fb.top, r: x + st.factsWidth, b: STAGE.factsTop + dy + fb.top + fb.h };
  const top = STAGE.actionsTop + dy, labels: Rect[] = [];
  let right = facts.r, details: Rect | null = null;
  for (const primary of st.primaries) {
    const label = textWidth(primary, "text700", STAGE.labelSize);
    const dl = x + STAGE.primaryPad + label + STAGE.gap;
    const d: Rect = { l: dl, t: top, r: dl + STAGE.details.w, b: top + STAGE.actionsH };
    labels.push({ l: dl + STAGE.details.labelX, t: top + STAGE.details.labelTop, r: dl + STAGE.details.labelX + STAGE.details.labelW, b: top + STAGE.details.labelTop + STAGE.details.labelH });
    right = Math.max(right, d.r, x + 24 + 18 + 8 + label);
    if (!details || d.r > details.r) details = d;
  }
  const runs: Run[] = [
    { who: "stage:facts", text: "facts", rgb: [164, 164, 164], rects: [facts], ground: { kind: "direct" }, need: RULE.target.text },
    { who: "stage:details", text: "Details", rgb: [242, 242, 242], rects: labels, ground: { kind: "tint", rgb: [255, 255, 255], alpha: 0.07 }, need: RULE.target.text },
  ];
  return { runs, right, details: details! };
}

/** the bearing (px) Bricolage 800 gives a glyph at a size (canvas actualBoundingBoxLeft, negated) */
export function bearingOf(ch: string, size: number): number {
  const steps = BEARINGS[ch];
  if (!steps) return 0;
  let v = steps[0][1];
  for (const [from, b] of steps) { if (size >= from) v = b; else break; }
  return v;
}

export interface TitleFit { size: number; lines: string[]; widths: number[]; widest: number; height: number; lineHeight: number; bearing: number; lineStarts: string }
/** the largest whole size (160 down to 16) at which the title fits 580 x 140 in at most two balanced lines */
export function fitTitle(name: string): TitleFit {
  const T = RULE.title, box = RULE.id;
  const words = name.split(/\s+/).filter(Boolean);
  const W = (s: string, F: number) => textWidth(s, "display800", F, T.letterSpacing);
  for (let F = T.max; F >= T.min; F--) {
    const lh = T.lineHeight * F;
    const one = W(words.join(" "), F);
    let lines: string[] | null = null, widths: number[] = [];
    if (one <= box.width) { if (lh <= box.height + 0.01) { lines = [words.join(" ")]; widths = [one]; } }
    else if (2 * lh <= box.height + 0.01 && words.length > 1) {
      // balance: the split that keeps the longer line shortest (Chromium's text-wrap: balance on two lines)
      let best: { i: number; m: number; ws: number[] } | null = null;
      for (let i = 1; i < words.length; i++) {
        const ws = [W(words.slice(0, i).join(" "), F), W(words.slice(i).join(" "), F)], m = Math.max(...ws);
        if (!best || m < best.m - 1e-9) best = { i, m, ws };
      }
      if (best && best.m <= box.width) { lines = [words.slice(0, best.i).join(" "), words.slice(best.i).join(" ")]; widths = best.ws; }
    }
    if (!lines) continue;
    const starts = lines.map(l => l.trim()[0] ?? "");
    const bearing = Math.max(0, Math.min(...starts.map(c => bearingOf(c, F))));
    return { size: F, lines, widths, widest: Math.max(...widths), height: lines.length * lh, lineHeight: T.lineHeight, bearing, lineStarts: starts.join("") };
  }
  // nothing fits (one enormous word): the smallest size on one line, as wide as it is
  const F = T.min, w = W(name, F);
  return { size: F, lines: [name], widths: [w], widest: w, height: T.lineHeight * F, lineHeight: T.lineHeight, bearing: 0, lineStarts: name[0] ?? "" };
}

/** the title's text run (one rect per line, the glyphs' box: ascent .93 and descent .27 of the size) and where it reaches */
export function titleLayout(t: TitleFit, geo: Geometry): { run: Run; top: number; right: number } {
  const lh = t.lineHeight * t.size, top = RULE.id.bottom + geo.dy - t.lines.length * lh, x = geo.left - t.bearing;
  const ib = inlineBox(t.size, lh, 0.93, 0.27);
  const rects = t.widths.map((w, i) => ({ l: x, t: top + i * lh + ib.top, r: x + w, b: top + i * lh + ib.top + ib.h }));
  return { run: { who: "stage:title", text: t.lines.join(" "), rgb: [242, 242, 242], rects, ground: { kind: "direct" }, need: RULE.target.identity, title: true }, top, right: Math.max(...rects.map(r => r.r)) };
}

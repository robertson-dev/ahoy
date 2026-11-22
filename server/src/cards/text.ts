/**
 * Cards — text measurement without a layout engine (the recipe's text.cjs): advance widths measured once from the real
 * fonts (fontmetrics.ts) scaled to the font size, letter-spacing added per character, plus a 3 % safety margin for
 * kerning and rounding.
 */
import { FONT_METRICS } from "./fontmetrics";

export type FontKey = "display800" | "text400" | "text500" | "text600" | "text700";

export function width(str: string, font: FontKey, size: number, letterSpacingEm = 0): number {
  const t = FONT_METRICS[font];
  let w = 0;
  for (const ch of str) w += (t[ch] !== undefined ? t[ch] : t["n"]) / 100 * size + letterSpacingEm * size;
  return w * 1.03;
}

export interface TitleFit { size: number; lines: string[]; widths: number[]; overflow: boolean }

/** Title rule (never throws): for each size, largest first: one line in w1 (the first line may share its row with
 * the verb pill); else two lines (first <= w1, second <= w2) where a break right after "Title:" wins when it fits,
 * else the break that keeps the longer line shortest; else three lines the same way (up to maxLines). The slot's
 * sizes come first, then smaller ones down to 60 % of the largest. Only when no size fits does the title fall back to
 * the smallest size, wrapped greedily (reported as overflow). */
export function fitTitle(text: string, sizes0: number[], w1: number, w2: number, { font = "display800" as FontKey, ls = -0.02, maxLines = 3 } = {}): TitleFit {
  const words = text.split(/\s+/).filter(Boolean);
  const sizes = sizes0.slice();
  for (let z = sizes0[sizes0.length - 1] - 2; z >= Math.max(12, Math.round(0.6 * sizes0[0])); z -= 2) sizes.push(z);
  const W = (s: string, size: number) => width(s, font, size, ls);
  for (const size of sizes) {
    const one = W(text, size);
    if (one <= w1) return { size, lines: [text], widths: [one], overflow: false };
    const held: { best: { lines: string[]; widths: number[]; m: number; colon: boolean } | null } = { best: null };
    const consider = (lines: string[]) => {
      const ws = lines.map(l => W(l, size));
      if (ws[0] > w1 || ws.slice(1).some(x => x > w2)) return;
      const colon = lines.slice(0, -1).some(l => l.endsWith(":"));
      const m = Math.max(...ws), best = held.best;
      if (!best || (colon && !best.colon) || (colon === best.colon && m < best.m - 1e-6)) held.best = { lines, widths: ws, m, colon };
    };
    const found = () => held.best;        // read through a call: the closure above may have set it
    for (let i = 1; i < words.length; i++) consider([words.slice(0, i).join(" "), words.slice(i).join(" ")]);
    let b = found();
    if (b) return { size, lines: b.lines, widths: b.widths, overflow: false };
    if (maxLines >= 3) {
      for (let i = 1; i < words.length; i++) for (let j = i + 1; j < words.length; j++) consider([words.slice(0, i).join(" "), words.slice(i, j).join(" "), words.slice(j).join(" ")]);
      b = found();
      if (b) return { size, lines: b.lines, widths: b.widths, overflow: false };
    }
  }
  const size = sizes[sizes.length - 1], lines: string[] = []; let cur = "";
  for (const w of words) { const cand = cur ? cur + " " + w : w; if (!cur || W(cand, size) <= (lines.length ? w2 : w1)) cur = cand; else { lines.push(cur); cur = w; } }
  if (cur) lines.push(cur);
  return { size, lines, widths: lines.map(l => W(l, size)), overflow: true };
}

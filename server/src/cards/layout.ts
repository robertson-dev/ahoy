/**
 * Cards — layouts (the recipe's gen.cjs card rules): the labels of a card (title fitted with the real fonts' advance
 * widths, the status line, the action pill) and where the art goes under them, for a free-standing 384 x 560 card and
 * for each of the Home fan's five slots (the visible window of a tilted card under its neighbours and the frame).
 *
 * The server does not know a viewer's status line or action, so every layout is made for a reference state (REF_*)
 * and reports the room the status row has; the client applies its own text by the rules in contracts/cards.md (full
 * status, else the short one, else the pill under the status).
 */
import * as C from "./colour";
import * as G from "./geom";
import * as T from "./text";
import { placeCover, placeCut, placeFade, placeImage, placeMiddle, type CoverPlace, type CutPlace, type CutSubject, type DissolveArt, type DissolvePlace, type FadeGeom, type Window } from "./place";

export const CARD = { w: 384, h: 560, radius: 36 };
export const FRAME: G.Frame = { x0: 0, y0: 0, x1: 1440, y1: 960 };
/** the frame as a side card under the pointer sees it: it rises 10 units (fan.css), and 16 leaves room for a card on its way */
const LIFTED: G.Frame = { ...FRAME, y1: FRAME.y1 + 16 };
/** the Home fan: five equal 384 x 560 cards on a 1440 x 960 frame; the centre upright, the inner pair 5.5 deg, the
 * outer pair 10.5 deg; z-order centre > inner > outer */
export const FAN = [
  { slot: -2, left: 82, top: 671, rot: -10.5, z: 3, side: "left" as const },
  { slot: -1, left: 309, top: 609, rot: -5.5, z: 4, side: "left" as const },
  { slot: 0, left: 528, top: 545, rot: 0, z: 5, side: "centre" as const },
  { slot: 1, left: 747, top: 609, rot: 5.5, z: 4, side: "right" as const },
  { slot: 2, left: 974, top: 671, rot: 10.5, z: 3, side: "right" as const },
];
/** the fan's box-shadows as data (the label rule needs to know where a neighbour's shadow falls): the centre card
 * lifts straight up, the side cards cast outwards */
export const FAN_SHADOW: Record<"centre" | "left" | "right", G.Shadow> = { centre: { x: 0, y: 30, blur: 60, spread: -30, a: 0.5 }, left: { x: -18, y: 22, blur: 44, spread: -16, a: 0.42 }, right: { x: 18, y: 22, blur: 44, spread: -16, a: 0.42 } };
export const CENTRE_LABELS = { titleSizes: [36, 34, 32], statusSize: 15, pillH: 36, pad: 32, pillInset: 26 };
/** the free card is the recipe's Library card: 314 x 458 with these labels (expressed in 384 card units by the JSON) */
export const LIB_LABELS = { titleSizes: [26, 24, 22], statusSize: 14, pillH: 32, pad: 24, pillInset: 18 };
export const LIB_CARD = { w: 314, h: 458 };
/** the action pill's geometry by its height */
export const PILL: Record<number, { font: number; icon: number; padL: number; padR: number; gap: number }> = { 36: { font: 13, icon: 14, padL: 12, padR: 14, gap: 7 }, 32: { font: 13, icon: 13, padL: 11, padR: 13, gap: 7 } };
export const MIN_TEXT_PX = 8;                // burned-in lettering this tall on a 384 card must stay hidden

/** a card's state as its labels show it: the status line, the short status a narrow card falls back to, the verb */
export interface CardState { status: string; short: string; verb: string; progress: number | null }
/** The states the server's layouts are made for (it does not know the viewer's):
 *   free card    a one-line status and Install (the board's case: Install and Play fit beside the first title
 *                line); the wide free card the widest action a library game has ("Try again": Cancel, Running,
 *                Request and Tracked fit too);
 *   fan centre   a one-line status and Install (the centre shows only its title; this keeps the board's room);
 *   fan sides    the narrowest status row ("On this PC" and Play): the title is chosen for what the slot shows, and the
 *                layout reports the room the row has, so a client checks its own status and pill against it. */
export const REF_FREE: CardState = { status: "On the server", short: "On the server", verb: "Install", progress: null };
export const REF_FREE_WIDE: CardState = { status: "On the server", short: "On the server", verb: "Try again", progress: null };
export const REF_CENTRE: CardState = { status: "On the server", short: "On the server", verb: "Install", progress: null };
export const REF_SIDE: CardState = { status: "On this PC", short: "On this PC", verb: "Play", progress: null };

const SMALL = new Set(["the", "of", "a", "an", "and", "in", "on", "at", "to", "for", "or"]);
/** Names typed in capitals by their store page read as shouting on a card: title-case them (roman numerals stay). */
export function displayName(raw: string): string {
  // the store's trademark signs never reach a card ("DARK SOULS™ III" is Dark Souls III), as on the spotlight
  const name = raw.replace(/[™®©]/g, "").replace(/\s{2,}/g, " ").trim();
  const letters = name.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4 || name !== name.toUpperCase()) return name;
  return name.split(" ").map((w, i) => /^[IVX]+$/.test(w) ? w : (i > 0 && SMALL.has(w.toLowerCase())) ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
}

export function pillSize(verb: string, h: number) { const p = PILL[h]; return { w: Math.ceil(p.padL + p.icon + p.gap + T.width(verb, "text700", p.font) + p.padR), h }; }

export interface LabelBox { x: number; y: number; w: number; h: number }
export interface Labels {
  kind: "top" | "side"; align: "left" | "right"; pad: number;
  size: number; lh: number; lines: string[]; widths: number[]; title: LabelBox;
  status: LabelBox; statusLines: string[]; statusSize: number; statusLH: number;
  pill: LabelBox; progress: LabelBox | null; bottom: number;
  short?: boolean; pillUnder?: boolean; fallback?: boolean;
  /** side labels: the room the status row has, measured from the outer padding (status + 10 + pill must fit) */
  room?: { row: number; status: number; pill: number };
}

/** Labels for a free-standing card (and the fan centre): title top-left, pill top-right, status under the title,
 * progress bar under the status. */
export function topLabels(title: string, st: CardState, W: number, { titleSizes, statusSize, pillH, pad, pillInset }: typeof CENTRE_LABELS): Labels {
  const pill = pillSize(st.verb, pillH);
  const pillX = W - pillInset - pill.w, pillY = pillInset;
  const w1 = pillX - 12 - pad, w2 = W - 2 * pad;
  const t = T.fitTitle(title, titleSizes, w1, w2);
  // a title line is as tall as the pill and as the font's own box (1.2 em): the first line and the pill share one
  // centre line, and a second line never reaches up beside the pill
  const lh = Math.max(pillH, Math.round(t.size * 1.2));
  const titleY = pillY + (pillH - lh) / 2;
  const titleH = t.lines.length * lh;
  const statusLH = Math.round(statusSize * 1.34);
  const statusW = T.width(st.status, "text500", statusSize);
  let statusLines = [st.status];
  if (statusW > w2) { const i = st.status.indexOf(" · "); if (i > 0) statusLines = [st.status.slice(0, i), st.status.slice(i + 3)]; }
  const statusY = titleY + titleH + 6;
  const sw = Math.max(...statusLines.map(s => T.width(s, "text500", statusSize)));
  const progress = st.progress != null ? { x: pad, y: statusY + statusLines.length * statusLH + 8, w: Math.round(140 * W / 384), h: 4 } : null;
  const bottom = Math.max(progress ? progress.y + progress.h : statusY + statusLines.length * statusLH, pillY + pillH);
  return { kind: "top", align: "left", pad, size: t.size, lh, lines: t.lines, widths: t.widths, title: { x: pad, y: titleY, w: Math.max(...t.widths), h: titleH },
    status: { x: pad, y: statusY, w: sw, h: statusLines.length * statusLH }, statusLines, statusSize, statusLH, pill: { x: pillX, y: pillY, w: pill.w, h: pillH }, progress, bottom };
}

/** Side-card labels: title (32 px; one line, else two, three or four balanced lines) aligned to the card's outer edge,
 * then a status row holding the status and the pill (the short status when the full one leaves no room; the pill under
 * the status as the last resort; `under` picks which). Every box must be visible: 6 px clear of the neighbouring card
 * and the frame. Every text box must also stay legible where the cards above cast their shadows on this card: its
 * contrast is solved on the card colour darkened by the strongest shadow over the box. */
export function sideLabels(title: string, st: CardState, side: "left" | "right", card: G.Card, cards: G.Card[], colour: C.CardColour, under: boolean): Labels {
  const align = side, PH = 36;
  const pill = pillSize(st.verb, PH);
  const ok = (b: LabelBox) => G.boxVisible(card, cards, { x: b.x - 6, y: b.y - 6, w: b.w + 12, h: b.h + 12 }, FRAME, 3);
  const shade = (b: LabelBox) => G.boxShadow(card, cards, b, 3);
  const titleOk = (b: LabelBox) => C.shadedContrast(colour, shade(b)).title >= C.MIN_TEXT;
  const statusOk = (b: LabelBox) => C.shadedContrast(colour, shade(b)).status >= C.MIN_TEXT;
  const words = title.split(" ");
  const sets: string[][] = [[title]];
  for (let i = 1; i < words.length; i++) sets.push([words.slice(0, i).join(" "), words.slice(i).join(" ")]);
  for (let i = 1; i < words.length; i++) for (let j = i + 1; j < words.length; j++) sets.push([words.slice(0, i).join(" "), words.slice(i, j).join(" "), words.slice(j).join(" ")]);
  for (let i = 1; i < words.length; i++) for (let j = i + 1; j < words.length; j++) for (let k = j + 1; k < words.length; k++) sets.push([words.slice(0, i).join(" "), words.slice(i, j).join(" "), words.slice(j, k).join(" "), words.slice(k).join(" ")]);
  const statusSize = 15, statusLH = 20;
  const room = (y: number, h: number, pad: number) => {          // widest box from the outer padding that stays visible
    const place = (w: number) => ({ x: align === "left" ? pad : CARD.w - pad - w, y, w, h });
    let lo = 0, hi = CARD.w - pad;
    if (!ok(place(1))) return 0;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ok(place(mid))) lo = mid; else hi = mid; }
    return lo;
  };
  // preference: the full status, then the short one; within each, the outer padding 30, 26 then 22, and the fewest
  // title lines (up to four); a smaller title size only when nothing fits
  for (const size of [32, 30, 28, 26, 24, 22, 20]) {
    const lh = Math.round(size * 1.06 * 10) / 10;
    const titleSets = sets.map(lines => { const ws = lines.map(l => T.width(l, "display800", size, -0.02)); return { lines, ws, m: Math.max(...ws), colon: lines.slice(0, -1).some(l => l.endsWith(":")) }; })
      .sort((a, b) => a.lines.length - b.lines.length || (Number(b.colon) - Number(a.colon)) || a.m - b.m);
    for (const text of [st.status, st.short]) for (const pad of [30, 26, 22]) {
      const place = (w: number, y: number, h: number): LabelBox => ({ x: align === "left" ? pad : CARD.w - pad - w, y, w, h });
      for (const ts of titleSets) {
        const lineBoxes = ts.lines.map((l, i) => place(ts.ws[i], 30 + i * lh, lh));
        if (!lineBoxes.every(b => ok(b) && titleOk(b))) continue;
        const rowY = 30 + ts.lines.length * lh + 8;
        const sw = T.width(text, "text500", statusSize);
        let status: LabelBox, pl: LabelBox, bottom: number;
        if (!under) {
          const row = place(sw + 10 + pill.w, rowY, PH);
          status = { x: row.x, y: rowY + (PH - statusLH) / 2, w: sw, h: statusLH };
          pl = { x: row.x + sw + 10, y: rowY, w: pill.w, h: PH };
          bottom = rowY + PH;
        } else {
          status = place(sw, rowY, statusLH);
          pl = place(pill.w, rowY + statusLH + 8, PH);
          bottom = pl.y + PH;
        }
        if (!ok(status) || !statusOk(status) || !ok(pl)) continue;
        const r = under ? { row: 0, status: room(rowY, statusLH, pad), pill: room(rowY + statusLH + 8, PH, pad) } : { row: room(rowY, PH, pad), status: 0, pill: 0 };
        return { kind: "side", align, pad, size, lh, lines: ts.lines, widths: ts.ws, title: { x: Math.min(...lineBoxes.map(b => b.x)), y: 30, w: ts.m, h: ts.lines.length * lh },
          status, statusLines: [text], statusSize, statusLH, pill: pl, progress: null, bottom, short: text !== st.status, pillUnder: under, room: r };
      }
    }
  }
  // never fails: the one-line title at 28 px, status and pill stacked (reported as not fully visible)
  const lh = 29.7, tw = T.width(title, "display800", 28, -0.02), sw = T.width(st.short, "text500", 15);
  const pos = (w: number) => (align === "left" ? 30 : CARD.w - 30 - w);
  return { kind: "side", align, pad: 30, size: 28, lh, lines: [title], widths: [tw], title: { x: pos(tw), y: 30, w: tw, h: lh }, status: { x: pos(sw), y: 68, w: sw, h: 20 }, statusLines: [st.short], statusSize: 15, statusLH: 20,
    pill: { x: pos(pill.w), y: 96, w: pill.w, h: PH }, progress: null, bottom: 132, pillUnder: true, fallback: true, room: { row: 0, status: room(68, 20, 30), pill: room(96, PH, 30) } };
}

/** The visible window of a fan card below its labels: the widest visible run of x near the window top gives the width,
 * the centre is the mean of that run's centre and the centre of the run at mid-height (fan cards narrow downwards),
 * the bottom is the last visible row under that centre. */
export function fanWindow(card: G.Card, cards: G.Card[], y0: number): Window {
  const vis = (x: number, y: number) => card.insideLocal(x, y) && G.visible(card, cards, x, y, FRAME);
  const runAt = (y: number) => {
    let best: { x0: number; x1: number } | null = null, run: { x0: number; x1: number } | null = null;
    for (let x = 0; x <= CARD.w; x += 2) {
      const v = vis(x, y);
      if (v) { if (!run) run = { x0: x, x1: x }; else run.x1 = x; }
      if ((!v || x === CARD.w) && run) { if (!best || run.x1 - run.x0 > best.x1 - best.x0) best = run; run = null; }
    }
    return best;
  };
  const topRun = runAt(Math.min(CARD.h - 1, y0 + 40)) || { x0: 0, x1: CARD.w };
  const cx0 = (topRun.x0 + topRun.x1) / 2;
  let y1 = y0;
  for (let y = y0; y <= CARD.h; y += 2) { if (vis(cx0, y)) y1 = y; else if (y > y0 + 40) break; }
  const midRun = runAt(Math.round((y0 + y1) / 2)) || topRun;
  const cx = (cx0 + (midRun.x0 + midRun.x1) / 2) / 2;
  return { cardW: CARD.w, cardH: CARD.h, x0: topRun.x0, x1: topRun.x1, cx, y0, y1, bleedY: Math.min(CARD.h + 2, y1 + 6), visibleAt: vis };
}

/** what a layout needs from the art analysis; for the box-art styles (CARD_STYLE=cover, fade) the poster's size and its lettering
 *  (poster.ts posterText), and for the fade the lightness of the band it melts into */
type DissolveLike = { mode: "dissolve"; an: DissolveArt; bandL: number } | { mode: "fade"; w: number; h: number; bandL: number; text: readonly number[][] };
export type LayoutArt = { mode: "cut"; subject: CutSubject } | { mode: "cover"; w: number; h: number; text: readonly number[][] } | DissolveLike | { mode: "none" };
/** a dissolve's place, its ramp, and over the band it melts into either the colour wash (a band that is not dark) or, for the fade
 *  over a dark band, the tint (the card's colour laid over the art, a colour blend cannot tint black) */
export type Placement = (CutPlace & { win: { y0: number; y1: number } }) | (DissolvePlace & { m0: number; m1: number; wash: number; tint: number }) | CoverPlace | null;

// visibility weights of a free-standing card's art: lower rows and the sides count less
const freeVis = (W: number, H: number) => (cx: number, cy: number) => (cy <= 0.714 * H ? 1 : 1 - 0.55 * (cy - 0.714 * H) / (0.286 * H)) * (1 - 0.3 * Math.pow((cx - W / 2) / (W / 2), 2));

/** Dissolve placement on a card: the dissolve search with this card's geometry (the fade: the poster's fixed place, centred on what
 * the card shows); the colour wash over a band that is not dark (median L >= 0.3); the fade's tint over a dark one. */
function placeDissolveOn(art: DissolveLike, geom: { w: number; h: number; m0: number; m1: number; vis: (x: number, y: number) => number; hiddenWeight: number; minTextPx: number }, fade: Omit<FadeGeom, "w" | "h" | "m0" | "m1" | "minTextPx"> = {}) {
  const pl = art.mode === "fade" ? placeFade(art.w, art.h, { ...geom, ...fade }, art.text) : placeImage(art.an, geom) ?? placeMiddle(art.an, geom);
  const band = Math.round(1.7 * (geom.m1 - geom.m0)), dark = art.bandL < 0.3;
  return { ...pl, m0: geom.m0, m1: geom.m1, wash: dark ? 0 : band, tint: dark && art.mode === "fade" ? band : 0 };
}

/** the art on a free-standing card under its labels */
export function freePlacement(art: LayoutArt, L: Labels, W = CARD.w, H = CARD.h): Placement {
  const k = W / 384;
  if (art.mode === "cut" || art.mode === "cover") {
    const win: Window = { cardW: W, cardH: H, x0: 0, x1: W, cx: W / 2, y0: Math.round(L.bottom + 14 * Math.max(1, k)), y1: H, bleedY: H + 2, visibleAt: () => true };
    if (art.mode === "cover") return placeCover(art.w, art.h, win, L.pad, art.text, { minTextPx: Math.max(6, MIN_TEXT_PX * k) });
    return { ...placeCut(art.subject, win), win: { y0: win.y0, y1: win.y1 } };
  }
  if (art.mode === "dissolve" || art.mode === "fade") {
    const m0 = Math.round(L.bottom + 10 * Math.max(k, 0.8));
    return placeDissolveOn(art, { w: W, h: H, m0, m1: m0 + Math.round(92 * k), vis: freeVis(W, H), hiddenWeight: 0.9, minTextPx: Math.max(6, MIN_TEXT_PX * k) });
  }
  return null;
}

let fanCards: G.Card[] | null = null;
export const fanGeometry = () => (fanCards ??= FAN.map(s => G.makeCard({ left: s.left, top: s.top, w: CARD.w, h: CARD.h, rot: s.rot, z: s.z, radius: CARD.radius, shadow: FAN_SHADOW[s.side] })));

/** the art on a fan card in slot i (0..4) under labels L */
export function fanPlacement(art: LayoutArt, i: number, L: Labels): Placement {
  const cards = fanGeometry(), card = cards[i], side = FAN[i].side;
  if (art.mode === "cut" || art.mode === "cover") {
    const win = fanWindow(card, cards, Math.round(L.bottom + 16));
    // the poster fills the frame down past the lowest row this card shows (the frame's bottom edge, 16 units more for a hovered or
    // a turning card)
    if (art.mode === "cover") return placeCover(art.w, art.h, win, L.pad, art.text, { minTextPx: MIN_TEXT_PX, bottom: (x0, x1) => Math.min(CARD.h, Math.max(foldAt(i, x0), foldAt(i, x1)) + 16) });
    return { ...placeCut(art.subject, win), win: { y0: win.y0, y1: win.y1 } };
  }
  if (art.mode === "dissolve" || art.mode === "fade") {
    const m0 = Math.round(L.bottom + 10);
    let ramp = 92;
    if (side !== "centre") {
      // the frame leaves a short art band on a tilted card: the dissolve takes 40 % of it (48-92 px)
      const xMid = L.align === "left" ? L.pad + 60 : CARD.w - L.pad - 60;
      let yCut = m0; while (yCut < CARD.h && card.insideLocal(xMid, yCut + 1) && G.visible(card, cards, xMid, yCut + 1, FRAME)) yCut++;
      ramp = Math.round(Math.max(48, Math.min(92, 0.4 * (yCut - m0))));
    }
    const vis = (cx: number, cy: number) => (G.visible(card, cards, cx, cy, FRAME) ? 1 : 0);
    // the fade centres the poster on what the fan shows of the card: the visible window's middle, down to its lowest visible row.
    // Lettering it hides under the frame's bottom edge stays 16 units under it on a side card, which rises 10 under the pointer
    // (fan.css; the cover's fill keeps the same margin)
    const win = art.mode === "fade" ? fanWindow(card, cards, m0) : null;
    const lifted = side === "centre" ? vis : (cx: number, cy: number) => (G.visible(card, cards, cx, cy, LIFTED) ? 1 : 0);
    return placeDissolveOn(art, { w: CARD.w, h: CARD.h, m0, m1: m0 + ramp, vis, hiddenWeight: side === "centre" ? 0.9 : 0.45, minTextPx: MIN_TEXT_PX },
      win ? { vis: lifted, cx: side === "centre" ? CARD.w / 2 : win.cx, y1: win.y1 } : {});
  }
  return null;
}

/** the row (card units) at which the frame's bottom edge cuts the card in fan slot i, at x */
export function foldAt(i: number, x: number): number {
  const s = FAN[i], a = (s.rot * Math.PI) / 180;
  return CARD.h / 2 + (FRAME.y1 - s.top - CARD.h / 2 - (x - CARD.w / 2) * Math.sin(a)) / Math.cos(a);
}

/** labels of slot i for a state; the side slots in the pill-on-the-row or the pill-under variant */
export function fanLabels(title: string, st: CardState, i: number, colour: C.CardColour, under: boolean): Labels {
  const cards = fanGeometry(), side = FAN[i].side;
  return side === "centre" ? topLabels(title, st, CARD.w, CENTRE_LABELS) : sideLabels(title, st, side, cards[i], cards, colour, under);
}

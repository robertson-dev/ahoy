/**
 * Cards — from an art analysis to a card record: the colour and its alternates, the labels and the art placement of
 * the free card (the recipe's Library card) and of every fan slot, in 384 x 560 card units, and the cut-out PNG.
 * Runs in the card worker (no database here).
 */
import * as C from "./colour";
import type { Analysis } from "./recipe";
import type { ArtPlacementJson, ColourJson, FanSlotJson, LabelsJson, LayoutJson } from "./contract";
import { renderCutout, type Cutout } from "./cutout";
import { CARD, FAN, LIB_CARD, LIB_LABELS, PILL, REF_CENTRE, REF_FREE, REF_FREE_WIDE, REF_SIDE, fanLabels, fanPlacement, freePlacement, topLabels, type Labels, type LayoutArt, type Placement } from "./layout";

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const MAX_ALTERNATES = 4;
/** the Library card is drawn at 314; its numbers go out in 384 card units */
const FREE_K = CARD.w / LIB_CARD.w;

export function colourJson(c: C.CardColour): ColourJson {
  return { top: C.hex(c.top), bottom: C.hex(c.bottom), base: C.hex(c.base), title: c.text, status: c.status, ink: c.ink, hue: c.h, s: c.s, l: c.l, grey: c.grey };
}
/** the colour (pick 0) and the next swatches of the same art, the recipe's way */
export function coloursOf(swatches: C.SwatchSet, bandL: number | null) {
  const c0 = C.cardColour(swatches, bandL, 0);
  const alts: C.CardColour[] = [];
  for (let pick = 1; pick < Math.min(c0.options, MAX_ALTERNATES + 1); pick++) alts.push(C.cardColour(swatches, bandL, pick));
  return { colour: c0, alternates: alts };
}

/** labels in card units (k: card units per px of the card the labels were laid out on) */
export function labelsJson(L: Labels, k = 1, W = CARD.w): LabelsJson {
  const box = (b: { x: number; y: number; w: number; h: number }) => ({ x: r1(b.x * k), y: r1(b.y * k), w: r1(b.w * k), h: r1(b.h * k) });
  const p = PILL[L.pill.h];
  const statusLines = L.statusLines.length;
  // where a progress bar goes on a free card (under the status), whether or not the reference state has one
  const progress = L.kind === "top" ? (L.progress ?? { x: L.pad, y: L.status.y + statusLines * L.statusLH + 8, w: Math.round(140 * W / 384), h: 4 }) : null;
  return {
    kind: L.kind, align: L.align, pad: r1(L.pad * k),
    title: { lines: L.lines, size: r1(L.size * k), lineHeight: r1(L.lh * k), ...box(L.title) },
    status: { size: r1(L.statusSize * k), lineHeight: r1(L.statusLH * k), ...box(L.status) },
    pill: { ...box(L.pill), font: r1(p.font * k), icon: r1(p.icon * k), padL: r1(p.padL * k), padR: r1(p.padR * k), gap: r1(p.gap * k) },
    progress: progress ? box(progress) : null,
    room: L.room ? { row: r1(L.room.row * k), status: r1(L.room.status * k), pill: r1(L.room.pill * k) } : null,
    bottom: r1(L.bottom * k),
  };
}

/** a placement in card units; a cut is the cut-out PNG's box (the crop of the source it was made from) */
export function placementJson(pl: Placement, W: number, crop: Cutout["crop"] | null, k = 1): ArtPlacementJson | null {
  if (!pl) return null;
  if (pl.kind === "cut") {
    if (!crop) return null;
    const s = pl.s, w = (crop.x1 - crop.x0) * s;
    const fade = pl.fade.map(f => {
      const off = f.dir === 90 ? crop.x0 * s : (W - crop.x1) * s;       // the full image's edge to the PNG's edge
      return { side: f.dir === 90 ? "left" as const : "right" as const, from: r3(Math.max(0, (f.from - off) / w)), to: r3(Math.max(0, (f.to - off) / w)) };
    });
    return { kind: "cut", x: r1((pl.imgLeft + crop.x0 * s) * k), y: r1((pl.imgTop + crop.y0 * s) * k), w: r1(w * k), h: r1((crop.y1 - crop.y0) * s * k), fade };
  }
  if (pl.kind === "cover") {
    const box = (b: { x: number; y: number; w: number; h: number }) => ({ x: r1(b.x * k), y: r1(b.y * k), w: r1(b.w * k), h: r1(b.h * k) });
    return { kind: "cover", ...box(pl), radius: r1(pl.r * k), img: box(pl.img) };
  }
  const d: ArtPlacementJson = { kind: "dissolve", x: r1(pl.dx * k), y: r1(pl.dy * k), w: r1(pl.iw * k), h: r1(pl.ih * k), fade: { from: r1(pl.m0 * k), to: r1(pl.m1 * k) }, wash: r1(pl.wash * k) };
  return pl.tint > 0 ? { ...d, tint: r1(pl.tint * k) } : d;
}

interface One { L: Labels; pl: Placement; k: number; W: number }
export interface Layouts { free: One; freeWide: One; fan: { row: One; under: One }[] }

/** labels and placements of the free card (both pill widths) and of the five fan slots (both pill variants) */
export function layoutsOf(title: string, art: LayoutArt, colour: C.CardColour): Layouts {
  const free = (st: typeof REF_FREE): One => { const L = topLabels(title, st, LIB_CARD.w, LIB_LABELS); return { L, pl: freePlacement(art, L, LIB_CARD.w, LIB_CARD.h), k: FREE_K, W: LIB_CARD.w }; };
  const fan = FAN.map((s, i) => {
    const st = s.side === "centre" ? REF_CENTRE : REF_SIDE;
    const rowL = fanLabels(title, st, i, colour, false);
    const row: One = { L: rowL, pl: fanPlacement(art, i, rowL), k: 1, W: CARD.w };
    if (s.side === "centre") return { row, under: row };
    const underL = fanLabels(title, st, i, colour, true);
    return { row, under: { L: underL, pl: fanPlacement(art, i, underL), k: 1, W: CARD.w } };
  });
  return { free: free(REF_FREE), freeWide: free(REF_FREE_WIDE), fan };
}

export function layoutsJson(lay: Layouts, srcW: number, crop: Cutout["crop"] | null): { free: LayoutJson; freeWide: LayoutJson; fan: FanSlotJson[] } {
  const one = (x: One): LayoutJson => ({ labels: labelsJson(x.L, x.k, x.W), art: placementJson(x.pl, srcW, crop, x.k) });
  return {
    free: one(lay.free), freeWide: one(lay.freeWide),
    fan: lay.fan.map((f, i) => ({ slot: FAN[i].slot, left: FAN[i].left, top: FAN[i].top, rot: FAN[i].rot, z: FAN[i].z, row: one(f.row), under: one(f.under) })),
  };
}

/** the largest scale (card units per source px) any layout shows a cut at */
export function maxCutScale(lay: Layouts): number {
  let m = 0;
  for (const o of [lay.free, lay.freeWide, ...lay.fan.flatMap(f => [f.row, f.under])]) if (o.pl && o.pl.kind === "cut") m = Math.max(m, o.pl.s * o.k);
  return m;
}

export interface BuiltCard {
  mode: "cut" | "dissolve"; source: "poster" | "keyart";
  colour: ColourJson; alternates: ColourJson[];
  free: LayoutJson; freeWide: LayoutJson; fan: FanSlotJson[];
  image: { w: number; h: number; png: Buffer | null };
  report: Record<string, unknown>;
}

/** the whole card from an analysis: layouts, colours and (for a cut) the cut-out PNG */
export async function buildCard(an: Analysis, title: string): Promise<BuiltCard> {
  const art: LayoutArt = an.mode === "cut" && an.cut ? { mode: "cut", subject: an.cut.subject } : { mode: "dissolve", an: an.dissolve!.an, bandL: an.bandL ?? 0.5 };
  const { colour, alternates } = coloursOf(an.swatches, an.bandL);
  const lay = layoutsOf(title, art, colour);
  let cut: Cutout | null = null;
  if (an.mode === "cut" && an.cut) cut = await renderCutout(an.src.file, an.src.W, an.src.H, an.cut.rings, Math.min(1, 2 * maxCutScale(lay)));
  const json = layoutsJson(lay, an.src.W, cut ? cut.crop : null);
  return {
    mode: an.mode, source: an.src.k === "poster" ? "poster" : "keyart",
    colour: colourJson(colour), alternates: alternates.map(colourJson),
    free: json.free, freeWide: json.freeWide, fan: json.fan,
    image: cut ? { w: cut.w, h: cut.h, png: cut.png } : { w: an.src.W, h: an.src.H, png: null },
    report: {
      ranked: an.ranked, colourPool: an.colourPool, bandL: an.bandL == null ? null : r3(an.bandL), swatch: colour.swatch, contrast: colour.contrast,
      ...(an.cut ? { erode: an.cut.erode, openHoles: an.cut.openHoles, rings: an.cut.rings.length, cutoutScale: cut ? r3(cut.scale) : null } : {}),
      ...(an.dissolve ? { dissolveScores: an.dissolve.scores, middle: an.dissolve.middle } : {}),
    },
  };
}

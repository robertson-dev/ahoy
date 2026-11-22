/**
 * Cards — the box art: a game's library poster drawn as its card, the colour of that art, and the lettering on it.
 *   - Every card's JSON carries `poster` (contracts/cards.md): the poster route's address (the one Discover and the Library
 *     use, ?v= following its bytes), its pixel size and its colour, so a client may draw the box art instead of the recipe.
 *   - Under CARD_STYLE=boxart (model.ts cardStyle) the server makes no other card: `art.kind` is "poster", the card's colour
 *     is the poster's, and there is no cut-out, no dissolve and no model.
 *   - Under CARD_STYLE=cover or fade (or for a client asking ?style=cover|fade) the card is the recipe's own, its title laid out by
 *     the same rules, with the poster where the cut-out stood (posterCardJson): "cover" places it as an object, "fade" melts it into
 *     the colour like a dissolve. No key art, no cut-out, no model: the poster (and the game's logo, to read its lettering) and its
 *     colours are all it needs.
 *   - `poster.text`: the poster's lettering, so a client that draws box art (it asks with ?text=1; always under
 *     CARD_STYLE=boxart) can keep its labels off the game's logo, and the cover and the fade can keep it out of sight (the card's
 *     title already names the game). The recipe's glyph finder (lettering.ts detectText) reads the poster 300 px wide (the
 *     recipe's main reading of a poster) and 240 px wide (the stability test is scale-sensitive: a logo one size misses, the
 *     other may catch). Its second opinion is the game's own logo (Steam's logo PNG, sources.ts logoOf), found on the poster by
 *     the recipe's template match (lettering.ts matchLogo, counted by its rule): where it counts, the logo's place on the poster
 *     is the poster's wordmark (lettering.ts withLogo): it finds a logo the glyph rules cannot read (drawn, metallic, condensed
 *     letters) and drops the art they misread beside it; a close match adds the letters they left out, and on the logo the poster
 *     is read at 200 px too (brush letters that run together at 300 px). A poster neither reads lettering on is read once more
 *     with the glyph finder's extra rules (a wordmark whose swashes join its letters, a stamp set at an angle: lettering.ts
 *     GlyphRules). Each block is [x0, y0, x1, y1] in fractions of the poster. A poster is read once (about 0.3-1.5 s): the server
 *     keeps the blocks by its hash and its logo's (<cards>/text/<sha1>[-<logo sha1>].json), with each block's letter height.
 * The colours come from the poster read at 160 px, through the recipe's colour rule (colour.ts) on the pool each card shows the
 * colour next to:
 *   - the whole poster (posterColours): the quick card's and the box art's; the cover's with its lettering left out (the
 *     cut-out's own pool is the backdrop around its subject, which takes the model to find; the whole image is that rule's
 *     fallback pool, and a logo's gold or white is no colour of the art);
 *   - the fade's (fadeColours): the dissolve's pool, the art the reference card shows under the ramp with the band it melts into
 *     counted 2.5x, with the poster where the fade puts it (place.ts placeFade) and its lettering left out; that band's median
 *     lightness decides the wash (or, over a dark band, the tint).
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { coloursOf, colourJson, layoutsJson, layoutsOf } from "./build";
import type * as C from "./colour";
import type { CardJson, PosterJson } from "./contract";
import { CARD, type LayoutArt } from "./layout";
import { detectText, loadPixels, logoCounts, matchLogo, withLogo, type GlyphRules, type LogoBox } from "./lettering";
import { placeFade } from "./place";
import { REF, dissolvePool, swatchesOf } from "./recipe";
import { atomicWrite } from "./store-io";

export interface Colours { colour: C.CardColour; alternates: C.CardColour[] }
const NONE: C.SwatchSet = { swatches: [], meanChroma: 0 };
/** the poster read small, as the colour rule reads it */
const small = (file: string) => sharp(file).removeAlpha().toColourspace("srgb").resize(160, 160, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });

/** the lettering as the cover and the fade keep it out of sight: the letters of a block at least half the poster wide (a wordmark,
 *  not a sticker) count as at least a third of its box's height (the glyph rules can read a logo's drawn letters as the small
 *  lines beside them: Ocarina of Time's ZELDA) */
export const keptLettering = (text: readonly number[][]): number[][] =>
  text.map(b => (b.length > 4 && b[2] - b[0] >= 0.5 ? [b[0], b[1], b[2], b[3], Math.max(b[4], (b[3] - b[1]) / 3)] : b.slice()));

/** whether a point of the poster (fractions) lies in its lettering */
const inLettering = (text: readonly number[][]) => (fx: number, fy: number) => text.some(b => fx >= b[0] && fx <= b[2] && fy >= b[1] && fy <= b[3]);

/** a poster's colour and the next ones of the same art, from the whole poster, its lettering `text` left out when given (the
 *  neutral rule when there is no poster or it cannot be read) */
export async function posterColours(file: string | null, text: readonly number[][] | null = null): Promise<Colours> {
  let sw = NONE;
  if (file) {
    try {
      const { data, info } = await small(file), W = info.width, H = info.height, inText = text?.length ? inLettering(text) : null;
      sw = swatchesOf(data, W, H, inText ? (x, y) => (inText((x + 0.5) / W, (y + 0.5) / H) ? 0 : 1) : null);
      if (inText && !sw.swatches.length) sw = swatchesOf(data, W, H, null);   // all lettering: the whole poster after all
    } catch { /* the neutral colour */ }
  }
  return coloursOf(sw, null);
}

/** the fade's colour (and the next ones), from the dissolve's pool with the poster where the fade puts it on the reference card
 *  (its lettering `text` kept out of sight, and out of the pool), and that band's median lightness */
export async function fadeColours(file: string | null, text: readonly number[][]): Promise<Colours & { bandL: number }> {
  let sw = NONE, bandL = 0.5;
  if (file) {
    try {
      const { data, info } = await small(file), W = info.width, H = info.height;
      ({ swatches: sw, bandL } = dissolvePool(data, W, H, W, H, placeFade(W, H, REF, keptLettering(text)), text.length ? inLettering(text) : undefined));
    } catch { /* the neutral colour */ }
  }
  return { ...coloursOf(sw, bandL), bandL };
}

/** The card of a style that puts the poster where the cut-out stood (CARD_STYLE=cover or fade): the recipe's card, its labels laid
 *  out by the same rules for its colour (`pick`: posterColours without the lettering for the cover, fadeColours for the fade), the
 *  poster as its art ("cover": an object, place.ts placeCover; "fade": a dissolve of the poster, placeFade, which also needs the
 *  band's lightness `bandL`), its lettering `text` kept out of sight. `poster` is the card's `poster` block: the route's address
 *  and the poster's pixel size. */
export function posterCardJson(style: "cover" | "fade", id: number, key: string, title: string, poster: PosterJson, pick: Colours, text: readonly number[][], bandL = 0.5): CardJson {
  const kept = keptLettering(text);
  const art: LayoutArt = style === "cover" ? { mode: "cover", w: poster.w, h: poster.h, text: kept } : { mode: "fade", w: poster.w, h: poster.h, bandL, text: kept };
  const lay = layoutsJson(layoutsOf(title, art, pick.colour), poster.w, null);
  return { v: 1, id, key, status: "ready", retryAfter: null, title, card: { ...CARD }, colour: colourJson(pick.colour), alternates: pick.alternates.map(colourJson),
    art: { kind: style === "cover" ? "cover" : "dissolve", url: poster.url, w: poster.w, h: poster.h, source: "poster" },
    free: lay.free, freeWide: lay.freeWide, fan: lay.fan, poster };
}

/** bump when the reading changes: every poster is read again (2: each block keeps its letter height; 3: read at 240 px too; 4: the
 *  game's logo as a second opinion; 5: a close logo match's pieces, and a reading at 200 px on the logo) */
const TEXT_VERSION = 5;
/** the widths the poster is read at, the main reading first */
const TEXT_W = [300, 240];
/** the width the poster is read at once more where the game's logo is found on it, keeping only the blocks on the logo: brush or
 *  drawn letters that run together at 300 and 240 px come apart at 200 (Samurai GUNN 2's "GUNN 2"); elsewhere a reading this small
 *  takes art for lettering (a figure's body) */
const TEXT_W_LOGO = 200;
/** the glyph finder's extra rules for a poster nothing else read lettering on (lettering.ts GlyphRules: a wordmark whose letters a
 *  swash or a second line runs across, a stamp set at an angle) */
const LAST_RESORT: GlyphRules = { nested: true, slanted: 5, bounded: true };

/** the lettering on a poster: the glyph finder's blocks as [x0, y0, x1, y1, letter height] fractions of the poster, read at each
 *  of TEXT_W (a later reading adds the blocks that lie mostly outside the earlier ones'), with the game's logo (`logo`: its PNG,
 *  its hash and the box of its opaque pixels) as the second opinion: found on the poster, it is the wordmark (lettering.ts
 *  withLogo), and the blocks a reading at TEXT_W_LOGO finds on it count too. When neither finds any lettering (no logo, or none on
 *  the poster), the glyph finder reads the poster again with its extra rules (LAST_RESORT): a poster carries a wordmark. Empty when nothing is found, or when the poster cannot be read. With
 *  `keep` (a folder) a reading is kept there under the poster's hash (and the logo's) and never made twice; a failed reading is
 *  not kept. */
export async function posterText(ref: { file: string; hash: string; w: number; h: number }, keep: string | null, logo: { file: string; hash: string; box: LogoBox } | null = null): Promise<number[][]> {
  const path = keep ? join(keep, `${ref.hash}${logo ? `-${logo.hash}` : ""}.json`) : null;
  if (path) {
    try {
      const kept = JSON.parse(await Bun.file(path).text()) as { v?: number; blocks?: number[][] };
      if (kept.v === TEXT_VERSION && Array.isArray(kept.blocks)) return kept.blocks;
    } catch { /* not read yet */ }
  }
  let blocks: number[][] = [];
  const area = (b: readonly number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const overlap = (a: readonly number[], b: readonly number[]) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  let found: { ncc: number; z: number; used: boolean } | null = null;
  const read = async (widths: readonly number[], rules?: GlyphRules, where?: (b: readonly number[]) => boolean) => {
    for (const w of widths) {
      const h = Math.max(1, Math.round((ref.h * w) / Math.max(1, ref.w))), known = blocks.slice();
      for (const b of detectText(await loadPixels(ref.file, w, h), rules).blocks) {
        if (where && !where(b)) continue;
        if (known.some(k => overlap(k, b) >= 0.6 * area(b))) continue;   // that reading found it already
        blocks.push(b.slice(0, 5).map(r3));
      }
    }
  };
  try {
    await read(TEXT_W);
    if (logo) {
      // a logo that will not read (a broken PNG) leaves the glyph finder's reading as it is
      const match = await matchLogo(ref.file, ref.w, ref.h, logo.file, logo.box).catch(() => null);
      const used = !!match && logoCounts(match, blocks);
      found = match ? { ncc: r3(match.ncc), z: r3(match.z), used } : null;
      blocks = withLogo(blocks, match).map(b => b.slice(0, 5).map(r3));
      if (match && used) {
        // on the logo (a block's middle on its box), the smaller reading's blocks count too
        const [x0, y0, x1, y1] = match.box;
        await read([TEXT_W_LOGO], undefined, b => { const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2; return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1; });
      }
    }
    if (!blocks.length) await read(TEXT_W, LAST_RESORT);
  } catch { return []; }
  if (keep && path) { try { await mkdir(keep, { recursive: true }); await atomicWrite(path, JSON.stringify({ v: TEXT_VERSION, blocks, logo: found })); } catch { /* read again next time */ } }
  return blocks;
}

/** the `poster` block: the poster route's address (?v= changes with the bytes; a client adds &w= for a sized copy), its size
 *  in pixels, its colour, and its lettering once read (the blocks' boxes) */
export function posterJson(gameId: number, ref: { hash: string; w: number; h: number }, colour: C.CardColour, text?: number[][] | null): PosterJson {
  const json: PosterJson = { url: `/api/v1/art/game/${gameId}/poster?v=${ref.hash.slice(0, 12)}`, w: ref.w, h: ref.h, colour: colourJson(colour) };
  if (text) json.text = text.map(b => b.slice(0, 4));
  return json;
}

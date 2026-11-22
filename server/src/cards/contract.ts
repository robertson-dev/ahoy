/**
 * Cards — the JSON contract of GET /api/v1/art/game/:id/card (documented with an example and the CSS recipe in
 * contracts/cards.md). Every length is in card units: the card is 384 x 560 and scales as one block, so a client draws
 * it at any size by multiplying with (its width / 384).
 */

export interface ColourJson {
  /** the card's vertical gradient, top to bottom (under a 3 % white diagonal grain) */
  top: string; bottom: string;
  /** the solved card colour (the gradient's middle); the dissolve's colour wash uses it */
  base: string;
  /** text colours: the title, and the status line */
  title: string; status: string;
  /** "white" text, or near-black "ink" (#141414) */
  ink: "white" | "ink";
  hue: number; s: number; l: number; grey: boolean;
}

/** the cut-out PNG's box on the card; a side the image's own edge cuts may fade out (fractions of the box width,
 * measured from that side: transparent at `from`, opaque at `to`) */
export interface CutArtJson { kind: "cut"; x: number; y: number; w: number; h: number; fade: { side: "left" | "right"; from: number; to: number }[] }
/** the source image's box on the card; the art is transparent above fade.from and opaque below fade.to (a smoothstep
 * ramp between); a colour wash (mix-blend-mode: color, the card's base colour fading out) covers `wash` units from
 * fade.from when wash > 0 */
export interface DissolveArtJson {
  kind: "dissolve"; x: number; y: number; w: number; h: number; fade: { from: number; to: number }; wash: number;
  /** CARD_STYLE=fade over a dark band (where the wash is 0): the card's base colour laid over the art (normal blend) at 30 % from
   *  fade.from to fade.to, fading out over the rest of `tint` units */
  tint?: number;
}
/** CARD_STYLE=cover: the frame on the card (x, y, w, h: the poster's shape, running on past the bottom edge), drawn as an object
 *  (corners rounded by `radius`, a neutral hairline and shadow), and the poster inside it (`img`, card units, clipped by the frame:
 *  moved up or zoomed when that keeps the poster's lettering out of the frame) */
export interface CoverArtJson { kind: "cover"; x: number; y: number; w: number; h: number; radius: number; img: { x: number; y: number; w: number; h: number } }
export type ArtPlacementJson = CutArtJson | DissolveArtJson | CoverArtJson;

export interface BoxJson { x: number; y: number; w: number; h: number }
export interface LabelsJson {
  /** "top": title top-left, pill top-right, status under the title (free card, fan centre);
   *  "side": title on the outer edge, then the status row (fan side cards) */
  kind: "top" | "side";
  align: "left" | "right";
  /** distance of the text from the aligned edge */
  pad: number;
  title: { lines: string[]; size: number; lineHeight: number } & BoxJson;
  /** where the reference status sat (its y and line metrics are what a client keeps; x and w follow its own text) */
  status: { size: number; lineHeight: number } & BoxJson;
  /** where the reference pill sat, and the pill's geometry (font size, icon size, left and right padding, gap) */
  pill: BoxJson & { font: number; icon: number; padL: number; padR: number; gap: number };
  /** top labels: where a progress bar goes (under the status) when the card has one */
  progress: BoxJson | null;
  /** side labels: the visible room from the outer padding: for the status row (status + 10 + pill), or, with the
   * pill under the status, for the status line and for the pill */
  room: { row: number; status: number; pill: number } | null;
  /** where the labels end: the art below was placed for this */
  bottom: number;
}
export interface LayoutJson { labels: LabelsJson; art: ArtPlacementJson | null }
/** the game's box art: the poster route's address (?v= follows the poster's bytes; add &w= for a sized copy), its size in
 * pixels, the colour of that art (the poster's own swatches through the colour rule), and once read, for a client that draws
 * box art (?text=1, and always under CARD_STYLE=boxart), its lettering: [x0, y0, x1, y1] blocks in fractions of the poster */
export interface PosterJson { url: string; w: number; h: number; colour: ColourJson; text?: number[][] }
export interface FanSlotJson {
  slot: number; left: number; top: number; rot: number; z: number;
  /** the pill on the status row, and the pill under the status (identical for the centre) */
  row: LayoutJson; under: LayoutJson;
}
export interface CardJson {
  v: 1;
  id: number;
  /** changes whenever the art, the title or the recipe changes */
  key: string;
  status: "ready" | "pending";
  /** pending: ask again after this many seconds */
  retryAfter: number | null;
  title: string;
  card: { w: number; h: number; radius: number };
  colour: ColourJson;
  /** the next colours of the same art, best first (the fan's hue-clash rule takes them in order) */
  alternates: ColourJson[];
  /** "poster" under CARD_STYLE=boxart: the card is the box art itself (url, w, h are the poster's). Under CARD_STYLE=cover (or
   *  ?style=cover) "cover": the poster as an object where the cut-out stood; under CARD_STYLE=fade (or ?style=fade) a "dissolve"
   *  whose source is the poster (url, w, h are the poster's), placed by a fixed rule instead of the search */
  art: { kind: "cut" | "dissolve" | "none" | "poster" | "cover"; url: string | null; w: number; h: number; source: "poster" | "keyart" | null };
  /** the box art and its colour, on every card once the poster was read (null before, and for a game with no poster): what a
   * client draws when it shows box art instead of the recipe */
  poster: PosterJson | null;
  /** a card on its own (the recipe's Library card): `free` when the action pill is no wider than Install's, `freeWide`
   * for a wider one (up to "Try again") */
  free: LayoutJson;
  freeWide: LayoutJson;
  fan: FanSlotJson[];
}

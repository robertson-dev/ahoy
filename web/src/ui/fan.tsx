/**
 * Ahoy — the fan's drawing, shared by the Home (screens/home-fan.tsx: the five cards with each game's status and action) and
 * the doors (ShelfFan, session.tsx: the server's newest games, nothing to click). The card JSON and its polling
 * (GET /api/v1/art/game/:id/card, I/contracts/cards.md), the recipe's hue rule, the board's 1440 × 960 slots and the scale,
 * one card's face, and the ring that turns. It knows no games and no session, so the doors can use it before anyone signs in.
 *
 * Box art where the cut-out stood: the recipe's card (its colour, title, status row and pill) with the game's poster as its art,
 * placed by one rule for every game, its lettering out of sight (the title names the game): as an object under the labels
 * (`art.kind: "cover"`, CardArtView: a frame showing the poster, moved up or zoomed in it), or melting into the colour like a
 * dissolve (a "dissolve" of the poster, with a tint of the colour over a dark band). The server sends these cards under
 * CARD_STYLE=cover or fade; a device asks for them with ?cards=cover or ?cards=fade (sent as ?style=, remembered until
 * ?cards=recipe).
 *
 * Box art as the card: a card may be drawn as its game's poster instead of the recipe's face (PosterFace, with the name and the
 * state on frosted glass over it: CardTag). The server says so for every card under CARD_STYLE=boxart (`art.kind: "poster"`); a
 * device asks for it with ?cards=boxart (remembered until ?cards=recipe). Either way the poster, its colour and its lettering come in
 * the card's `poster` (a device that draws box art asks for the lettering with ?text=1).
 */
import { useArtRevisionList, versionedArt } from "../art-revisions";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { urlBase } from "../api";
import { art } from "./art";
import { Avatar, type AvatarUser } from "./avatar";
import "./fan.css";

/* ─────────── the card JSON (contracts/cards.md) ─────────── */

export interface CardColour { top: string; bottom: string; base: string; title: string; status: string; ink: "white" | "ink"; hue: number; s: number; l: number; grey: boolean }
export interface PillBox { x: number; y: number; w: number; h: number; font: number; icon: number; padL: number; padR: number; gap: number }
export interface Labels {
  kind: "top" | "side"; align: "left" | "right"; pad: number;
  title: { lines: string[]; size: number; lineHeight: number; x: number; y: number; w: number; h: number };
  status: { size: number; lineHeight: number; x: number; y: number; w: number; h: number };
  pill: PillBox;
  progress: { x: number; y: number; w: number; h: number } | null;
  room: { row: number; status: number; pill: number } | null;
  bottom: number;
}
export type CardArt =
  | { kind: "cut"; x: number; y: number; w: number; h: number; fade: { side: "left" | "right"; from: number; to: number }[] }
  | { kind: "dissolve"; x: number; y: number; w: number; h: number; fade: { from: number; to: number }; wash: number; tint?: number }
  | { kind: "cover"; x: number; y: number; w: number; h: number; radius: number; img?: { x: number; y: number; w: number; h: number } };
export interface CardLayout { labels: Labels; art: CardArt | null }
export interface FanSlot { slot: number; left: number; top: number; rot: number; z: number; row: CardLayout; under: CardLayout }
/** the game's box art: the poster route's address (with ?v=), its pixel size, the colour of that art, and once read (for a client
 *  that draws box art) its lettering: [x0, y0, x1, y1] blocks in fractions of the poster */
export interface PosterJson { url: string; w: number; h: number; colour: CardColour; text?: number[][] }
export interface CardJson {
  v: 1; id: number; key: string; status: "ready" | "pending"; retryAfter: number | null; title: string;
  card: { w: number; h: number; radius: number };
  colour: CardColour; alternates: CardColour[];
  art: { kind: "cut" | "dissolve" | "none" | "poster" | "cover"; url: string | null; w: number; h: number; source: string | null };
  fan: FanSlot[];
  /** null until the server read the poster, and for a game with none; absent from an older server */
  poster?: PosterJson | null;
}

/* ─────────── box art or the recipe ─────────── */

const CARDS_KEY = "ahoy.cards";
/** what this device asks the cards to be: the poster where the cut-out stood (cover, fade) or the box art as the card (boxart) */
export type CardsLook = "cover" | "fade" | "boxart";
const LOOKS: readonly CardsLook[] = ["cover", "fade", "boxart"];
const lookOf = (v: string | null): CardsLook | null => LOOKS.find(l => l === v) ?? null;
/** the look this device asks for: ?cards=cover|fade|boxart turns one on and remembers it here, ?cards=recipe forgets it (the
 *  server's own cards then); null when it asks for none */
export function cardsWanted(): CardsLook | null {
  let q: string | null = null;
  try { q = new URLSearchParams(location.search).get("cards"); } catch { /* no location */ }
  const asked = lookOf(q);
  try {
    if (asked) localStorage.setItem(CARDS_KEY, asked);
    else if (q === "recipe") localStorage.removeItem(CARDS_KEY);
    else return lookOf(localStorage.getItem(CARDS_KEY));
  } catch { /* storage off: the address alone decides */ }
  return asked;
}
/** this device asks for box art as the card (?cards=boxart) */
export const boxArtWanted = (): boolean => cardsWanted() === "boxart";
/** what a card request adds for this device's look: the poster's lettering for box art, the style for cover and fade */
export function cardQuery(look: CardsLook | null = cardsWanted()): string {
  return look === "boxart" ? "?text=1" : look ? `?style=${look}` : "";
}
/** the box art a card is drawn as: every card of a box-art server, any card when this device asks; null for the recipe's face
 *  (and for a game with no poster, which keeps its colour and title) */
export function boxOf(card: CardJson | null | undefined, wanted = boxArtWanted()): PosterJson | null {
  if (!card?.poster) return null;
  return card.art.kind === "poster" || wanted ? card.poster : null;
}

/* ─────────── loading the cards: polled while the server is still making them ─────────── */

/** the cards asked for, by the request's address (a game's card in another look is another card) */
const memo = new Map<string, { json: CardJson; at: number }>();
const flights = new Map<string, Promise<CardJson | null>>();
/** a card older than this is drawn but asked again (the server looks at a game's art again at most this often) */
const FRESH_MS = 10 * 60_000;
function fetchCard(id: number): Promise<CardJson | null> {
  // a device that draws box art asks for the poster's lettering too (its tags keep off the logo); cover and fade ask for that card
  const url = versionedArt(art.card(id) + cardQuery(), "game", id);
  let p = flights.get(url);
  if (!p) {
    p = fetch(url, { credentials: "include" })
      .then(r => (r.ok ? (r.json() as Promise<CardJson>) : null))
      .catch(() => null)
      .then(j => { flights.delete(url); if (j && Array.isArray(j.fan) && j.fan.length === 5) { memo.set(url, { json: j, at: Date.now() }); return j; } return null; });
    flights.set(url, p);
  }
  return p;
}
const memoOf = (id: number) => memo.get(versionedArt(art.card(id) + cardQuery(), "game", id));

/** the cards for these games; `settled` once every one answered (or failed), or after a moment, so the fan appears whole.
 *  `poster` (a device that draws box art): a card the server has not read the poster of yet is asked again within a second,
 *  and the fan waits for it in that moment too, so it never shows the recipe's face first and the box art a few seconds later */
export function useFanCards(ids: number[], { poster = false }: { poster?: boolean } = {}): { cards: Map<number, CardJson>; settled: boolean } {
  const key = useArtRevisionList(ids);
  const [, setTick] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set());
  const [late, setLate] = useState(false);
  useEffect(() => {
    let live = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const ask = (id: number, tries: number) => {
      void fetchCard(id).then(j => {
        if (!live) return;
        if (!j) { setFailed(f => new Set(f).add(id)); return; }
        setTick(t => t + 1);
        // a pending card is complete and drawable; ask again for the better one the server is making
        if (j.status === "pending" && tries < 60) timers.push(setTimeout(() => ask(id, tries + 1), (poster && !j.poster ? 1 : Math.max(1, j.retryAfter ?? 3)) * 1000));
      });
    };
    for (const id of ids) {
      const m = memoOf(id);
      if (!m || m.json.status === "pending" || Date.now() - m.at > FRESH_MS) ask(id, 0);
    }
    setLate(false);
    timers.push(setTimeout(() => { if (live) setLate(true); }, 2500));
    return () => { live = false; timers.forEach(clearTimeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const cards = new Map<number, CardJson>();
  for (const id of ids) { const m = memoOf(id); if (m) cards.set(id, m.json); }
  const answered = (id: number) => failed.has(id) || (cards.has(id) && !(poster && !cards.get(id)!.poster && cards.get(id)!.status === "pending"));
  return { cards, settled: late || ids.every(answered) };
}

/* ─────────── the hue rule (gen.cjs fanOrder) ─────────── */

/** neighbours' colours this close (degrees) are a clash: the recipe's faces are colour fields */
const MIN_HUE = 18;
const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const perms = <T,>(a: T[]): T[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p])));

/** the five cards in slot order (centre at 2): the four others keep their order unless neighbours fall within 18° of hue;
 *  then the arrangement that separates every neighbour with the fewest cards moved (ties: the earliest permutation).
 *  Every card keeps its own artwork colour, even when no arrangement separates the neighbours. */
export function hueOrder<T extends { colour: CardColour }>(five: T[]): { order: T[]; colours: CardColour[] } {
  const centre = five[2], others = [five[0], five[1], five[3], five[4]];
  const arrange = (p: T[]) => [p[0], p[1], centre, p[2], p[3]];
  const ok = (o: T[]) => o.every((c, i) => i === 0 || hueDist(c.colour.hue, o[i - 1].colour.hue) >= MIN_HUE);
  const best = perms(others).map((p, idx) => ({ o: arrange(p), idx, moved: p.filter((c, i) => c !== others[i]).length }))
    .filter(x => ok(x.o)).sort((a, b) => a.moved - b.moved || a.idx - b.idx)[0];
  if (best) return { order: best.o, colours: best.o.map(c => c.colour) };
  return { order: five.slice(), colours: five.map(c => c.colour) };
}

/* ─────────── the frame and its scale ─────────── */

/** the board's slots, outer left to outer right (also in every card's JSON) */
export const SLOTS = [
  { left: 82, top: 671, rot: -10.5, z: 3 },
  { left: 309, top: 609, rot: -5.5, z: 4 },
  { left: 528, top: 545, rot: 0, z: 5 },
  { left: 747, top: 609, rot: 5.5, z: 4 },
  { left: 974, top: 671, rot: 10.5, z: 3 },
];
const SHADOW = ["-18px 22px 44px -16px rgba(0,0,0,.42)", "-18px 22px 44px -16px rgba(0,0,0,.42)", "0 30px 60px -30px rgba(0,0,0,.5)", "18px 22px 44px -16px rgba(0,0,0,.42)", "18px 22px 44px -16px rgba(0,0,0,.42)"];
const rad = (d: number) => (d * Math.PI) / 180;
/** a slot's top edge: its card's two top corners after the rotation (board px) */
function topEdge(s: { left: number; top: number; rot: number }): [number, number, number, number] {
  const cx = s.left + 192, cy = s.top + 280, c = Math.cos(rad(s.rot)), sn = Math.sin(rad(s.rot));
  return [cx - 192 * c + 280 * sn, cy - 192 * sn - 280 * c, cx + 192 * c + 280 * sn, cy + 192 * sn - 280 * c];
}

/**
 * How large the fan is drawn in a window `w` × `h` (the top bar `bar` tall, the page margin `px`): the board's size at
 * 1440 × 960; narrower windows scale it down with the width; and it shrinks further when the window is too short for the
 * cards' top edges to stay 24 px clear of the spotlight's actions (which end 124 px under the identity's baseline, at most
 * 280 px into the page). Big windows grow it a little, up to 1.25. `clear` is another column to keep clear of instead (the
 * doors': its bottom and right edge in window px).
 */
export function fanScale(w: number, h: number, bar: number, px: number, clear?: { bottom: number; right: number }): number {
  const hi = w < 1440 ? w / 1440 : Math.max(1, Math.min(w / 1440, h / 960, 1.25));
  const yMin = clear ? clear.bottom + 24 : 380 + (bar - 148) + 124 + 24, xMax = clear ? clear.right : px + 280;
  const ok = (s: number) => SLOTS.every(sl => {
    const [x1, y1, x2, y2] = topEdge(sl);
    for (let i = 0; i <= 24; i++) {
      const t = i / 24, X = w / 2 + (x1 + (x2 - x1) * t - 720) * s, Y = h - (960 - (y1 + (y2 - y1) * t)) * s;
      if (X < xMax && Y < yMin) return false;
    }
    return true;
  });
  if (ok(hi)) return hi;
  let lo = 0.3, up = hi;
  if (!ok(lo)) return lo;
  for (let i = 0; i < 18; i++) { const m = (lo + up) / 2; if (ok(m)) lo = m; else up = m; }
  return lo;
}

let fontsLoaded = false;
export function useFontsReady() {
  const [ready, setReady] = useState(fontsLoaded);
  useEffect(() => {
    if (ready || !document.fonts) { if (!document.fonts) setReady(true); return; }
    let live = true;
    void Promise.all([
      document.fonts.load('500 15px "Figtree Variable"'), document.fonts.load('700 13px "Figtree Variable"'), document.fonts.load('800 32px "Bricolage Grotesque Variable"'),
    ]).catch(() => null).then(() => document.fonts.ready).then(() => { fontsLoaded = true; if (live) setReady(true); });
    return () => { live = false; };
  }, [ready]);
  return ready;
}

/* ─────────── drawing one card ─────────── */

const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(3)}%`;
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** the cover's edge and shadow in card units (`u`: the frame's px per card unit), never in the art's colour: a neutral hairline (a
 *  poster in the card's own colour keeps its edge), a tight contact shadow and a soft drop */
const COVER_SHADOW = (u: number) => [`0 0 0 ${u.toFixed(2)}px rgba(0,0,0,.2)`, `0 ${u.toFixed(2)}px ${(2.5 * u).toFixed(2)}px rgba(0,0,0,.3)`,
  `0 ${(14 * u).toFixed(1)}px ${(30 * u).toFixed(1)}px ${(-10 * u).toFixed(1)}px rgba(0,0,0,.42)`].join(", ");
/** the fade's tint over a dark band: the card's colour at this opacity over the ramp, fading out below it */
const TINT = 0.3;

/** the face's art: a cut-out on its box (soft shadow, edge fades); the source under the smoothstep fade plus the wash (or the tint);
 *  or the poster as an object (a frame with rounded corners, a hairline and a neutral shadow, the poster moved and scaled in it) */
function CardArtView({ card, a, colour }: { card: CardJson; a: CardArt | null; colour: CardColour }) {
  if (!a || !card.art.url) return null;
  const src = urlBase + card.art.url, H = card.card.h;
  // the image keeps its own pixel size and is moved and scaled onto its box by a transform, so a change of slot
  // (another box) transitions on the compositor
  const iw = card.art.w || a.w, ih = card.art.h || a.h;
  const box: CSSProperties = { width: iw, height: ih, transform: `translate(${a.x.toFixed(2)}px, ${a.y.toFixed(2)}px) scale(${(a.w / iw).toFixed(5)}, ${(a.h / ih).toFixed(5)})` };
  if (a.kind === "cover") {
    // the frame is drawn at the image's own size (its corners and shadow scale with it into every slot), the poster inside it is
    // moved and scaled onto its own box (the frame clips what would show its lettering)
    const k = iw / a.w;
    return (
      <span className="hf-art" aria-hidden>
        <span className="hf-cover" style={{ ...box, borderRadius: a.radius * k, boxShadow: COVER_SHADOW(k) }}><img src={src} alt="" draggable={false} style={{ transform: coverInner(a, iw) }} /></span>
      </span>
    );
  }
  if (a.kind === "cut") {
    const mask = a.fade.length ? a.fade.map(f => `linear-gradient(${f.side === "left" ? 90 : 270}deg, rgba(0,0,0,0) ${(f.from * 100).toFixed(2)}%, #000 ${(f.to * 100).toFixed(2)}%)`).join(", ") : undefined;
    const two = a.fade.length > 1;
    return (
      <span className="hf-art cut" aria-hidden>
        <img src={src} alt="" draggable={false} style={{ ...box, maskImage: mask, WebkitMaskImage: mask, maskComposite: two ? "intersect" : undefined, WebkitMaskComposite: two ? "source-in" : undefined } as CSSProperties} />
      </span>
    );
  }
  const { from, to } = a.fade, stops = [`rgba(0,0,0,0) ${pct(from, H)}`];
  for (const t of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) stops.push(`rgba(0,0,0,${smooth(t).toFixed(3)}) ${pct(from + t * (to - from), H)}`);
  stops.push(`#000 ${pct(to, H)}`);
  const mask = `linear-gradient(180deg, ${stops.join(", ")})`;
  return (
    <>
      <span className="hf-art" aria-hidden style={{ maskImage: mask, WebkitMaskImage: mask }}><img src={src} alt="" draggable={false} style={box} /></span>
      {a.wash > 0 && <span className="hf-wash" aria-hidden style={{ top: pct(from, H), height: pct(a.wash, H), background: `linear-gradient(180deg, ${colour.base} 0%, ${colour.base}00 100%)` }} />}
      {!!a.tint && a.tint > 0 && <span className="hf-tint" aria-hidden style={{ top: pct(from, H), height: pct(a.tint, H), background: tintOf(colour.base, (to - from) / a.tint) }} />}
    </>
  );
}

/** the poster inside a cover's frame: drawn at its own pixel size `iw` like the frame, moved and scaled from the frame's box onto its
 *  own (`img`, card units; the whole frame when a server sends none) */
export function coverInner(a: { x: number; y: number; w: number; img?: { x: number; y: number; w: number } }, iw: number): string {
  const k = iw / a.w, img = a.img ?? a;
  return `translate(${((img.x - a.x) * k).toFixed(2)}px, ${((img.y - a.y) * k).toFixed(2)}px) scale(${(img.w / a.w).toFixed(5)})`;
}

/** the tint's gradient: the colour at TINT over the ramp (`ramp`: its share of the tint's height), then smoothly to nothing */
export function tintOf(base: string, ramp: number): string {
  const a = (t: number) => Math.round(TINT * 255 * t).toString(16).padStart(2, "0");
  const stops = [`${base}${a(1)} 0%`, `${base}${a(1)} ${(ramp * 100).toFixed(2)}%`];
  for (const t of [0.25, 0.5, 0.75]) stops.push(`${base}${a(1 - smooth(t))} ${((ramp + t * (1 - ramp)) * 100).toFixed(2)}%`);
  stops.push(`${base}00 100%`);
  return `linear-gradient(180deg, ${stops.join(", ")})`;
}

/* ─────────── box art: the poster is the card ─────────── */

const CARD_W = 384, CARD_H = 560;
/** a poster's address for a card drawn up to 384 px wide at twice the density (the poster route's sized copy) */
const posterSrc = (url: string) => `${/^https?:/.test(url) ? "" : urlBase}${url}${url.includes("?") ? "&" : "?"}w=768`;
/** a poster that ends above the card's bottom edge fades into its field over its last 24 units */
const SHORT_FADE = "linear-gradient(180deg, #000 calc(100% - 24px), rgba(0,0,0,0) 100%)";
/** the centre card on box art: the slot's shadow and a neutral contact shadow all round, so a dark poster stands off the page and
 *  off the spotlight behind it (never a glow in the art's colour: a blue poster would tint the page navy) */
const CENTRE_BOX_SHADOW = `${SHADOW[2]}, 0 0 60px rgba(0,0,0,.55)`;

/* what the fan shows of each card: from the board's slots, so the same at every scale */

/** a point of the card in `slot` (card units) on the board (px) */
function onBoard(slot: number, x: number, y: number): [number, number] {
  const s = SLOTS[slot], a = rad(s.rot), dx = x - CARD_W / 2, dy = y - CARD_H / 2;
  return [s.left + CARD_W / 2 + dx * Math.cos(a) - dy * Math.sin(a), s.top + CARD_H / 2 + dx * Math.sin(a) + dy * Math.cos(a)];
}
/** whether the card in `slot` covers a board point */
function covers(slot: number, [X, Y]: [number, number]): boolean {
  const s = SLOTS[slot], a = rad(s.rot), dX = X - s.left - CARD_W / 2, dY = Y - s.top - CARD_H / 2;
  return Math.abs(dX * Math.cos(a) + dY * Math.sin(a)) <= CARD_W / 2 && Math.abs(-dX * Math.sin(a) + dY * Math.cos(a)) <= CARD_H / 2;
}
const shownCache = new Map<string, number>();
/** how far in from its outer edge a side card shows at height `y` (card units) before the next card toward the centre covers
 *  it; all of it at the centre */
export function shownTo(slot: number, y: number): number {
  if (slot === 2) return CARD_W;
  const k = `${slot}:${Math.round(y)}`;
  let d = shownCache.get(k);
  if (d == null) {
    const over = slot < 2 ? slot + 1 : slot - 1;
    d = CARD_W;
    for (let i = 0; i <= CARD_W; i++) if (covers(over, onBoard(slot, slot < 2 ? i : CARD_W - i, Math.round(y)))) { d = i; break; }
    shownCache.set(k, d);
  }
  return d;
}
/** how far down (card units) the card in `slot` shows at `x` before the frame's bottom edge cuts it */
export function foldAt(slot: number, x: number): number {
  const s = SLOTS[slot], a = rad(s.rot);
  return CARD_H / 2 + (960 - s.top - CARD_H / 2 - (x - CARD_W / 2) * Math.sin(a)) / Math.cos(a);
}
/** what the fan shows of a card across (card units, left to right): from its outer edge to the next card, measured halfway down
 *  what shows of it; all of it at the centre */
export function shownSpan(slot: number): [number, number] {
  if (slot === 2) return [0, CARD_W];
  const w = shownTo(slot, foldAt(slot, slot < 2 ? 0 : CARD_W) / 2);
  return slot < 2 ? [0, w] : [CARD_W - w, CARD_W];
}
/** the room a box-art tag has on a side card in the band `y0..y1` (card units): from its outer inset to 12 units before the next
 *  card toward the centre */
export function tagRoom(slot: number, y0: number, y1: number, inset: number): number {
  return Math.min(shownTo(slot, y0), shownTo(slot, (y0 + y1) / 2), shownTo(slot, y1)) - inset - 12;
}

/**
 * The box-art face, one rule for every poster:
 *   - the poster spans the card's width from its top edge: a 2:3 poster runs 16 units past the bottom edge (the frame hides the
 *     bottom of every fan card anyway), so nothing at its top, where most logos sit, is cut;
 *   - a shorter poster (3:4 console covers) ends above the bottom edge, on a field of its own blurred and darkened copy
 *     (Discover's rule for art of the wrong shape), its last 24 units fading into it; in the fan that strip is under the frame;
 *   - a game that moves is grey with what has arrived in colour from the left (PosterArt's rule), the arrival spread across
 *     the part of the card the fan shows (shownSpan: a side card's inner part is under its neighbour); all grey while there is
 *     no number, lighter then (a dark poster stays a picture);
 *   - a 1 px hairline and the top light of the recipe's faces over the art; the slot's shadow, and round the centre card a
 *     neutral contact shadow;
 *   - the side cards recede: their art at 85 % brightness and saturation in the inner pair, 70 % in the outer pair (fan.css),
 *     full again under the pointer.
 */
export function PosterFace({ box, slot, progress, grey }: { box: PosterJson; slot: number; progress?: number | null; grey?: boolean }) {
  const src = posterSrc(box.url);
  const h = (CARD_W * box.h) / Math.max(1, box.w), short = h < CARD_H - 0.5;
  const p = progress == null ? null : Math.max(0, Math.min(1, progress));
  const [x0, x1] = shownSpan(slot);
  const front = p == null ? 0 : x0 + p * (x1 - x0);           // everything left of it has arrived
  const layers = (cls: string) => <>
    {short && <img className={`hf-field${cls}`} src={src} alt="" draggable={false} />}
    <img className={`hf-poster${cls}`} src={src} alt="" draggable={false} style={{ height: `${((h / CARD_H) * 100).toFixed(3)}%`, maskImage: short ? SHORT_FADE : undefined, WebkitMaskImage: short ? SHORT_FADE : undefined }} />
  </>;
  return (
    <div className="hf-face box" style={{ boxShadow: slot === 2 ? CENTRE_BOX_SHADOW : SHADOW[slot] }}>
      <span className="hf-pics">
        {layers(p != null ? " grey" : grey ? " grey all" : "")}
        {p != null && front > 0 && <span className="hf-arrived" style={{ clipPath: `inset(0 ${(100 - (front / CARD_W) * 100).toFixed(2)}% 0 0)` }}>{layers("")}</span>}
      </span>
    </div>
  );
}

/** a poster's lettering (the card JSON's `poster.text`, fractions of the poster) in card units: the poster is drawn 384 wide from
 *  the card's top edge */
export function posterBlocks(box: PosterJson | null | undefined): number[][] {
  if (!box?.text) return [];
  const ph = (CARD_W * box.h) / Math.max(1, box.w);
  return box.text.map(b => [b[0] * CARD_W, b[1] * ph, b[2] * CARD_W, b[3] * ph]);
}

let measure: CanvasRenderingContext2D | null = null;
/** a text's width in card units: Figtree at this weight and size */
export function figtreeWidth(s: string, weight: number, size: number): number {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return s.length * size * 0.55;
  measure.font = `${weight} ${size}px "Figtree Variable", Figtree, system-ui, sans-serif`;
  return measure.measureText(s).width;
}
/** the recipe measures every text 3 % wide (kerning and rounding) */
const WIDE = 1.03;

/** the tag's geometry (card units): its inset from the top and the outer edge; the glass block (padding, radius: concentric with
 *  the card's 36); the name (Figtree 700), the state (Figtree 500) with a friend's face, the progress bar; the gap to the pill; what
 *  it keeps clear of a lettering block (whose box the glyph finder already pads by a third to a half of a letter) and of the
 *  frame's bottom edge */
export const TAG = { inset: 18, padX: 14, padY: 10, radius: 18, name: 15, nameLH: 20, status: 13, statusLH: 18, lineGap: 2, avatar: 18, avatarGap: 6, bar: 2, barGap: 6, gap: 8, textGap: 2, foldGap: 8 };
/** the pill beside or under a tag: the recipe's 36 tall pill (server/src/cards/layout.ts PILL[36]) */
export const TAG_PILL: PillBox = { x: 0, y: 0, w: 0, h: 36, font: 13, icon: 14, padL: 12, padR: 14, gap: 7 };

/** a name on one line, else on two (the recipe's title rule, made for a tag):
 *   - after "Title:" or a dash when both lines then fit, else where the longer line is shortest;
 *   - never before a number or a roman numeral ("Shrek 2", "Dark Souls III"), never next to an ampersand or before a dash;
 *   - a line that is still too wide ends in an ellipsis (CSS) */
export function nameLines(name: string, max: number, width: (s: string) => number): string[] {
  if (width(name) <= max) return [name];
  const words = name.split(" ").filter(Boolean);
  const breaks: { a: string; b: string; after: boolean }[] = [];
  for (let i = 1; i < words.length; i++) {
    const next = words[i], prev = words[i - 1];
    if (/^(\d+|[IVXLC]+)$/.test(next) || next === "&" || prev === "&" || /^[-–—]$/.test(next)) continue;
    breaks.push({ a: words.slice(0, i).join(" "), b: words.slice(i).join(" "), after: /[:\-–—]$/.test(prev) });
  }
  const after = breaks.find(x => x.after && width(x.a) <= max && width(x.b) <= max);
  if (after) return [after.a, after.b];
  let best: { a: string; b: string } | null = null, longest = Infinity;
  for (const x of breaks) { const m = Math.max(width(x.a), width(x.b)); if (m < longest) { longest = m; best = x; } }
  return best ? [best.a, best.b] : [name];
}

/** what a side card's tag says: the game, its state (the full one and the one-fact short form), who else plays it, the action
 *  pill's label, and whether a progress bar goes under the state */
export interface TagWords { name: string; status: string; short: string; who?: AvatarUser | null; verb?: string | null; bar?: boolean }
export interface TagPlan { lines: string[]; text: string; row: boolean; top: number; w: number; h: number; room: number }

/**
 * A side card's tag, laid out (card units):
 *   - a glass block with the name (one line, or two) and the state; the action pill beside it when both fit the room the next
 *     card leaves (with the full state, else the short one), else under it (the full state when it fits, else the short one);
 *   - at the card's outer top corner, unless that covers lettering on the poster (`text`, card units: posterBlocks); then just
 *     under the highest block that leaves it clear of every block, laid out for the room it has there, above the frame's bottom
 *     edge; when no such place shows, at the top after all.
 */
export function planTag(slot: number, words: TagWords, text: number[][], width: (s: string, weight: number, size: number) => number = figtreeWidth): TagPlan {
  const right = slot > 2, T = TAG;
  const nameW = (s: string) => width(s, 700, T.name) * WIDE;
  const stateW = (s: string) => (words.who ? T.avatar + T.avatarGap : 0) + width(s, 500, T.status) * WIDE;
  const pill = words.verb ? Math.ceil(TAG_PILL.padL + TAG_PILL.icon + TAG_PILL.gap + width(words.verb, 700, TAG_PILL.font) * WIDE + TAG_PILL.padR + 2) : 0;
  /** the tag laid out for `room` (its top at `top`) */
  const lay = (room: number, top: number): TagPlan => {
    const lines = nameLines(words.name, room - 2 * T.padX, nameW);
    const nameMax = Math.max(...lines.map(nameW));
    const need = (s: string) => Math.ceil(2 * T.padX + Math.max(nameMax, stateW(s)));
    let row = false, said = words.status;
    if (pill && need(words.status) + T.gap + pill <= room) row = true;
    else if (pill && need(words.short) + T.gap + pill <= room) { row = true; said = words.short; }
    else if (need(words.status) > room) said = words.short;
    const blockW = Math.min(room, need(said));
    const blockH = 2 * T.padY + lines.length * T.nameLH + T.lineGap + T.statusLH + (words.bar ? T.barGap + T.bar : 0);
    const w = !pill ? blockW : row ? blockW + T.gap + pill : Math.max(blockW, pill);
    const h = !pill ? blockH : row ? Math.max(blockH, TAG_PILL.h) : blockH + T.gap + TAG_PILL.h;
    return { lines, text: said, row, top, w, h, room };
  };
  const across = (p: TagPlan): [number, number] => (right ? [CARD_W - T.inset - p.w, CARD_W - T.inset] : [T.inset, T.inset + p.w]);
  const crosses = (p: TagPlan) => { const [x0, x1] = across(p); return text.some(b => b[0] < x1 - 2 && b[2] > x0 + 2 && b[1] < p.top + p.h - 2 && b[3] > p.top + 2); };
  const BAND = 140;                                           // the most a tag takes down the card (two name lines, the bar, the pill under)
  const first = lay(tagRoom(slot, T.inset, T.inset + BAND, T.inset), T.inset);
  if (!crosses(first)) return first;
  for (const y of [...new Set(text.map(b => Math.ceil(b[3] + T.textGap)))].filter(y => y > T.inset).sort((a, b) => a - b)) {
    const p = lay(tagRoom(slot, y, y + BAND, T.inset), y), [x0, x1] = across(p);
    if (p.room > 2 * T.padX && y + p.h <= Math.min(foldAt(slot, x0), foldAt(slot, x1)) - T.foldGap && !crosses(p)) return p;
  }
  return first;
}

/**
 * The state over a box-art side card (planTag lays it out): the name and the state on neutral frosted glass, aligned to the
 * card's outer edge like the recipe's side labels, a friend playing it first with their face, the progress bar under the state while
 * the game moves (a near-monochrome poster shows its arrival badly), and the action pill (`children`, labelled `verb`).
 */
export function CardTag({ slot, name, status, short, who, verb, progress, text, children }: {
  slot: number; name: string; status: string; short: string; who?: AvatarUser | null; verb?: string | null;
  progress?: number | null; text?: number[][]; children?: ReactNode;
}) {
  const right = slot > 2, bar = progress != null;
  const plan = planTag(slot, { name, status, short, who, verb, bar }, text ?? []);
  return (
    <div className={`hf-tag${right ? " right" : ""}${plan.row ? " row" : ""}`} style={{ [right ? "right" : "left"]: TAG.inset, top: plan.top, maxWidth: plan.room, gap: TAG.gap } as CSSProperties}>
      <div className="hf-tag-b" style={{ maxWidth: plan.room, padding: `${TAG.padY}px ${TAG.padX}px`, borderRadius: TAG.radius }}>
        {plan.lines.map((l, i) => <span key={i} className="hf-tag-n" style={{ fontSize: TAG.name, lineHeight: `${TAG.nameLH}px` }}>{l}</span>)}
        <span className="hf-tag-st" style={{ marginTop: TAG.lineGap, gap: TAG.avatarGap, fontSize: TAG.status, lineHeight: `${TAG.statusLH}px` }}>
          {who && <Avatar u={who} size={TAG.avatar} />}
          <span className="hf-tag-t">{plan.text}</span>
        </span>
        {bar && <span className="hf-tag-bar" style={{ marginTop: TAG.barGap, height: TAG.bar, "--p": `${(Math.max(0, Math.min(1, progress ?? 0)) * 100).toFixed(1)}%` } as CSSProperties} />}
      </div>
      {children}
    </div>
  );
}

/** a card's face in one slot, as the recipe draws it: the colour, the grain, the art and the fitted title (no status, no action);
 *  or, given `box`, the box art (PosterFace) with `progress` / `grey` for a game that moves */
export function CardFace({ card, colour, slot, layout, title, box, progress, grey }: { card: CardJson | null; colour: CardColour | null; slot: number; layout: CardLayout | null; title: string; box?: PosterJson | null; progress?: number | null; grey?: boolean }) {
  if (box) return <PosterFace box={box} slot={slot} progress={progress} grey={grey} />;
  const L = layout?.labels;
  const right = L?.align === "right";
  const edge: CSSProperties = L ? (right ? { right: L.pad } : { left: L.pad }) : { left: 30 };
  const face: CSSProperties = {
    background: colour
      ? `repeating-linear-gradient(135deg, rgba(255,255,255,.03) 0 1px, rgba(255,255,255,0) 1px 7px), linear-gradient(180deg, ${colour.top} 0%, ${colour.bottom} 100%)`
      : "linear-gradient(180deg, #2a2a2a 0%, #1e1e1e 100%)",
    boxShadow: `${SHADOW[slot]}, inset 0 1px 0 rgba(255,255,255,.16)`,
  };
  return (
    <div className="hf-face" style={face}>
      {card && colour && <CardArtView card={card} a={layout?.art ?? null} colour={colour} />}
      {L && colour
        ? <div key={`t${slot}`} className="hf-title" style={{ ...edge, top: L.title.y, fontSize: L.title.size, lineHeight: `${L.title.lineHeight}px`, color: colour.title, textAlign: right ? "right" : "left" }}>
            {L.title.lines.map((l, i) => <span key={i}>{i > 0 && <br />}{l}</span>)}
          </div>
        // no card from the server: the name on a neutral face, where a side card's title stands
        : <div key={`t${slot}`} className="hf-title plain" style={{ left: 30, right: 30, top: 30 }}>{title}</div>}
    </div>
  );
}

/** where each card of the ring sits when `focus` is at the centre: the next one to its right, the previous one to its
 *  left, then the ones after those (a ring of five turns; with fewer cards, they gather round the centre) */
function slotsAround(n: number, focus: number): number[] {
  const slot = new Array<number>(n).fill(-1);
  if (!n) return slot;
  slot[focus] = 2;
  for (let k = 1; k <= 2; k++) {
    const next = (focus + k) % n, prev = (focus - k + n * 3) % n;
    if (slot[next] === -1) slot[next] = 2 + k;
    if (slot[prev] === -1) slot[prev] = 2 - k;
  }
  return slot;
}

/**
 * The ring of up to five cards: `slotIds` in slot order (outer left … outer right, null where there are fewer). When all five
 * have cards the hue rule orders them; each sits round `focus` (slotsAround) and keeps its own artwork colour. A card that
 * wraps round (more than two slots in one turn) fades in place instead of sweeping across (`warps`). `hue: false`
 * (box art: the faces are pictures, not colour fields) keeps the picked order.
 */
export function useRing(slotIds: (number | null)[], cards: Map<number, CardJson>, focus: number, { hue = true }: { hue?: boolean } = {}) {
  const keyOfCards = slotIds.map(id => (id != null ? `${id}:${cards.get(id)?.key ?? "-"}` : "-")).join(",") + (hue ? "" : ":picked");
  const order = useMemo(() => {
    const all = slotIds.map(id => (id != null ? cards.get(id) ?? null : null));
    if (hue && slotIds.length === 5 && slotIds.every(id => id != null) && all.every(Boolean)) {
      const tagged = slotIds.map((id, i) => ({ id: id as number, colour: all[i]!.colour }));
      const { order: o, colours } = hueOrder(tagged);
      return o.map((t, i) => ({ id: t.id, base: colours[i] as CardColour | null }));
    }
    return slotIds.filter((id): id is number => id != null).map(id => ({ id, base: cards.get(id)?.colour ?? null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyOfCards]);
  const live = new Set(slotIds.filter((id): id is number => id != null));
  const ring = order.filter(o => live.has(o.id));
  let focusIdx = ring.findIndex(r => r.id === focus);
  if (focusIdx < 0) focusIdx = Math.max(0, ring.findIndex(r => r.id === slotIds[2]));
  const slots = slotsAround(ring.length, focusIdx);
  const colourOf = (i: number) => ring[i].base;
  const prevSlots = useRef(new Map<number, number>());
  const warpUntil = useRef(new Map<number, number>());
  const t0 = Date.now();
  ring.forEach((r, i) => { const prev = prevSlots.current.get(r.id); if (prev != null && Math.abs(prev - slots[i]) > 2) warpUntil.current.set(r.id, t0 + 600); });
  useEffect(() => { ring.forEach((r, i) => prevSlots.current.set(r.id, slots[i])); });
  const warps = (id: number) => (warpUntil.current.get(id) ?? 0) > t0;
  return { ring, slots, colourOf, warps };
}

/**
 * The fan with no library behind it: the server's newest games on the doors (session.tsx), drawn as the Home draws them but
 * not for use (no status, no actions, nothing to click). `focus` is the game at the centre; the doors turn it.
 */
export function ShelfFan({ ids, focus, scale }: { ids: number[]; focus: number; scale: number }) {
  const five = ids.slice(0, 5);
  const look = cardsWanted(), wanted = look === "boxart";
  const { cards, settled } = useFanCards(five, { poster: !!look });
  const fonts = useFontsReady();
  // only the games the server drew a card for: a door has no names to put on a neutral face
  const boxed = five.some(id => !!boxOf(cards.get(id), wanted));
  const { ring, slots, colourOf, warps } = useRing(five.map(id => (cards.has(id) ? id : null)), cards, focus, { hue: !(wanted || boxed) });
  if (!settled || !ring.length || !fonts) return null;
  return (
    <div className="hf hf-shelf" aria-hidden>
      <div className="hf-frame" style={{ transform: `translateX(-50%) scale(${scale})`, "--hf-s": scale } as CSSProperties}>
        {ring.map((r, i) => {
          const slot = slots[i], card = cards.get(r.id);
          if (slot < 0 || !card) return null;
          const geo = card.fan[slot];
          return (
            <div key={r.id} className={`hf-card${slot === 2 ? " centre" : " side"}${warps(r.id) ? " warp" : ""}`} data-slot={slot}
              style={{ transform: `translate(${geo.left}px, ${geo.top}px) rotate(${geo.rot}deg)`, zIndex: geo.z }}>
              <CardFace card={card} colour={colourOf(i)} slot={slot} layout={geo.row} title={card.title} box={boxOf(card, wanted)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

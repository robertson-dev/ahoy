/**
 * Ahoy — the Home's fan (M/mine/livefan/Main.dc.html, the five cards at the bottom; spec I/SCREENS.md "Home").
 *
 * Five generated cards (GET /api/v1/art/game/:id/card, I/contracts/cards.md) on the board's 1440 × 960 frame: the centre
 * upright, the inner pair at ±5.5°, the outer pair at ±10.5°, cut by the frame's bottom edge. The frame scales as one block
 * anchored to the bottom centre (fanScale), small enough that the cards never reach the spotlight's actions.
 *   - Each card is drawn from its JSON exactly as the recipe says (I/run/cards-check/card-render.js is the reference):
 *     the face (colour, grain, a cut-out or a dissolve), the server's fitted title, and on side cards the status with
 *     the game's real action as a frosted pill, in the slot's "row" or "under" variant.
 *   - The centre card shows only its title; its status and actions are on the spotlight above. Clicking it opens the game.
 *   - Clicking a side card (or Left / Right while the fan has focus) brings it to the centre: the cards turn like a ring,
 *     each taking its new slot's layout; a card that wraps round fades instead of crossing the fan.
 *   - The recipe's hue rule (gen.cjs fanOrder) keeps neighbours apart: the four side cards are reordered with the fewest
 *     moves, else a clashing card takes its colour alternates.
 * The drawing that knows no game (the card JSON, the hue rule, the slots and scale, a card's face, the ring) is in
 * ui/fan.tsx, which the doors share.
 *
 * The poster where the cut-out stood (a server's CARD_STYLE=cover or fade, or ?cards=cover|fade on this device): the same cards,
 * drawn the same way (colour, title, status row, pill, the hue rule); only their art is the game's poster (ui/fan.tsx CardArtView).
 *
 * Box art (ui/fan.tsx boxOf: a box-art server, or ?cards=boxart on this device): each card is its game's poster, a moving game
 * grey with what has arrived in colour; side cards carry the name and the state on frosted glass at the outer top corner
 * (CardTag, moved under the poster's logo when that leaves it in view) with the same action pill beside or under it, and a
 * friend playing it wins over the game's own fact (the Library's rule). The picked order stands: the hue rule is for colour
 * fields.
 */
import { useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Game } from "../api";
import { CardFace, CardTag, SLOTS, TAG_PILL, boxOf, cardsWanted, posterBlocks, useFanCards, useFontsReady, useRing, type CardColour, type CardJson, type CardLayout, type FanSlot, type Labels, type PillBox, type PosterJson } from "../ui/fan";
import type { AvatarUser } from "../ui/avatar";
import { useGameAction, type Act } from "../ui/game-action";
import { Icon } from "../ui/icons";

export { fanScale } from "../ui/fan";

/* ─────────── measuring the labels (the recipe's variant choice) ─────────── */

let ctx: CanvasRenderingContext2D | null = null;
/** a text's width in px, Figtree at this weight and size (the card's own units: the frame is drawn 1:1) */
function textW(s: string, weight: number, size: number): number {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return s.length * size * 0.55;
  ctx.font = `${weight} ${size}px "Figtree Variable", Figtree, system-ui, sans-serif`;
  return ctx.measureText(s).width;
}
/** what a card says about its game: the full status, and the one-fact short form the recipe falls back to */
export interface CardWords { status: string; short: string }

/** the recipe measures every text 3 % wide (M/live/home/gen/lib/text.cjs width(): kerning and rounding) and lays the labels
 *  out with those widths, so on the status row the pill starts 10 after the widened status (the board's Play at 118.8) */
const MEASURE = 1.03;
/** how long after a turn a mouse click on the centre card opens nothing (the turn's glide, .5 s, and a double click's gap) */
const TURN_GUARD_MS = 700;

/** a side slot's variant: the pill on the status row with the full status, else the short one, else the pill under it;
 *  `w` is the status's width on the row as the recipe lays it out */
function sideVariant(slot: FanSlot, words: CardWords, verb: string | null): { v: CardLayout; under: boolean; text: string; w?: number } {
  const row = slot.row.labels, under = slot.under.labels;
  const pill = verb ? Math.ceil(row.pill.padL + row.pill.icon + row.pill.gap + textW(verb, 700, row.pill.font) * MEASURE + row.pill.padR) : -10;
  const full = textW(words.status, 500, row.status.size) * MEASURE, short = textW(words.short, 500, row.status.size) * MEASURE;
  if (row.room && row.title.size >= under.title.size) {
    if (full + 10 + pill <= row.room.row) return { v: slot.row, under: false, text: words.status, w: full };
    if (short + 10 + pill <= row.room.row) return { v: slot.row, under: false, text: words.short, w: short };
  }
  return { v: slot.under, under: slot.under !== slot.row, text: under.room && full <= under.room.status ? words.status : words.short };
}

/** which layout a card takes in a slot and the status it shows: the centre (and a fan drawn too small to read) the row layout with
 *  the full status, a side card the recipe's variant (sideVariant) */
export type CardPick = { v: CardLayout; under: boolean; text: string; w?: number };
export function pickLayout(card: CardJson, slot: number, words: CardWords, verb: string | null, detail: boolean): CardPick {
  const fs = card.fan[slot];
  if (slot === 2 || !detail || fs.row.labels.kind === "top") return { v: fs.row, under: false, text: words.status };
  return sideVariant(fs, words, verb);
}

/** a side card's status row, laid out by the recipe: the status in the card's status colour, then the action pill (`children`)
 *  beside it on the row, or under it */
export function CardRow({ L, pick, colour, children }: { L: Labels; pick: CardPick; colour: CardColour; children?: ReactNode }) {
  const right = L.align === "right";
  const edge: CSSProperties = right ? { right: L.pad } : { left: L.pad };
  const rowY = L.title.y + L.title.lines.length * L.title.lineHeight + 8;
  return (
    <div className={`hf-row${pick.under ? " under" : ""}`}
      style={{ ...edge, top: rowY, height: pick.under ? undefined : L.pill.h, alignItems: pick.under ? (right ? "flex-end" : "flex-start") : "center" }}>
      <span className="hf-status" style={{ fontSize: L.status.size, lineHeight: `${L.status.lineHeight}px`, color: colour.status, minWidth: pick.w, textAlign: right ? "right" : undefined }}>{pick.text}</span>
      {children}
    </div>
  );
}


/** the action as the card's pill (the recipe's geometry: frosted .55 glass, a .22 hairline) */
export function CardPill({ act, p, busy, label, onAct }: { act: Act; p: PillBox; busy: boolean; label: string; onAct: () => void }) {
  return (
    // (with a pad the side cards' pills are no stops: Left and Right bring a card to the centre, where the spotlight's own button is its action)
    <button type="button" className="hf-pill" data-pad-skip="" aria-disabled={act.disabled || busy || undefined} aria-busy={busy || undefined} aria-pressed={act.pressed} title={act.title} aria-label={`${act.label} ${label}`}
      style={{ height: p.h, padding: `0 ${p.padR}px 0 ${p.padL}px`, gap: p.gap, borderRadius: p.h / 2, fontSize: p.font }}
      onClick={e => { e.preventDefault(); e.stopPropagation(); if (!act.disabled && !busy) onAct(); }}>
      <Icon name={busy ? "spinner" : act.icon} size={p.icon} strokeWidth={act.icon === "cancel" || act.icon === "plus" || act.icon === "tick" ? 2.6 : act.icon === "track" ? 2.2 : 2.4} />
      {act.label}
    </button>
  );
}

interface FanCardProps {
  game: Game;
  card: CardJson | null;
  colour: CardColour | null;
  /** draw the box art instead of the recipe's face (ui/fan.tsx boxOf) */
  box: PosterJson | null;
  /** box art: how far the game has come while it moves (PosterArt's rule), and who else plays it now */
  moving?: { progress: number | null; grey: boolean };
  playing?: { who: AvatarUser; text: string } | null;
  /** 0..4, outer left to outer right; 2 is the centre */
  slot: number;
  words: CardWords;
  /** draw the side cards' status and pill (off when the fan is drawn too small to read them) */
  detail: boolean;
  /** this card wraps round the ring: it fades in at its new slot instead of crossing the fan */
  warp: boolean;
  onPick: () => void;
  /** false for a moment after the fan turned: a second click on the spot a side card was picked from opens nothing */
  canOpen: () => boolean;
}

function FanCard({ game, card, colour, box, moving, playing, slot, words, detail, warp, onPick, canOpen }: FanCardProps) {
  const { plan, perform, busy, extra } = useGameAction({ game });
  const centre = slot === 2;
  const geo = card?.fan[slot] ?? { ...SLOTS[slot], slot: slot - 2 };
  const title = card?.title ?? game.name;
  const act = !centre && detail ? plan.main : null;
  // which layout the slot takes, and the status it can show (box art lays its own tag out)
  const pick = useMemo(() => (!card || box ? null : pickLayout(card, slot, words, act?.label ?? null, detail)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [card, box, slot, detail, words.status, words.short, act?.label]);
  if (box) {
    const said = playing?.text ?? words.status;
    const label = `${title} — ${said}`;
    return (
      <div className={`hf-card${centre ? " centre" : " side"}${warp ? " warp" : ""}`} data-slot={slot}
        style={{ transform: `translate(${geo.left}px, ${geo.top}px) rotate(${geo.rot}deg)`, zIndex: geo.z }}>
        <CardFace card={card} colour={colour} slot={slot} layout={null} title={title} box={box} progress={moving?.progress} grey={moving?.grey} />
        {centre
          ? <Link className="hf-hit" to={`/game/${game.id}`} aria-label={label} aria-current="true" aria-keyshortcuts="ArrowLeft ArrowRight" data-hit={game.id}
              onClick={e => { if (e.detail > 0 && !canOpen()) e.preventDefault(); }} />
          : <button type="button" className="hf-hit" aria-label={label} tabIndex={-1} data-hit={game.id} onClick={e => { if (e.detail < 2) onPick(); }} />}
        {!centre && detail && (
          <CardTag key={`t${slot}`} slot={slot} name={title} status={said} short={playing?.text ?? words.short} who={playing?.who ?? null} verb={act?.label ?? null}
            progress={moving?.progress ?? null} text={posterBlocks(box)}>
            {act && <CardPill act={act} p={TAG_PILL} busy={busy === act.kind} label={title} onAct={() => perform(act)} />}
          </CardTag>
        )}
        {extra}
      </div>
    );
  }
  const c = colour ?? card?.colour ?? null;
  const L = pick?.v.labels;
  const label = `${title} — ${words.status}`;
  return (
    <div className={`hf-card${centre ? " centre" : " side"}${warp ? " warp" : ""}`} data-slot={slot}
      style={{ transform: `translate(${geo.left}px, ${geo.top}px) rotate(${geo.rot}deg)`, zIndex: geo.z }}>
      <CardFace card={card} colour={c} slot={slot} layout={pick?.v ?? null} title={title} />
      {centre
        ? <Link className="hf-hit" to={`/game/${game.id}`} aria-label={label} aria-current="true" aria-keyshortcuts="ArrowLeft ArrowRight" data-hit={game.id}
            onClick={e => { if (e.detail > 0 && !canOpen()) e.preventDefault(); }} />
        : <button type="button" className="hf-hit" aria-label={label} tabIndex={-1} data-hit={game.id} onClick={e => { if (e.detail < 2) onPick(); }} />}
      {!centre && detail && pick && L && c && L.kind === "side" && (
        <CardRow key={`r${slot}`} L={L} pick={pick} colour={c}>
          {act && <CardPill act={act} p={L.pill} busy={busy === act.kind} label={title} onAct={() => perform(act)} />}
        </CardRow>
      )}
      {/* the launcher download dialog (a plain browser's Install); a portal, so the turned, scaled frame cannot hold it */}
      {extra}
    </div>
  );
}

/* ─────────── the fan ─────────── */

export interface FanEntry {
  game: Game; words: CardWords;
  /** for box art: the game's progress while it moves, and a friend who plays it now ("Pell is playing") */
  moving?: { progress: number | null; grey: boolean };
  playing?: { who: AvatarUser; text: string } | null;
}

/**
 * The fan: `entries` are the picked games in slot order (outer left … outer right, null where the library has too few),
 * `focus` the game at the centre now. Picking a side card calls `onFocus`; the page then makes it the spotlight.
 */
export function Fan({ entries, focus, onFocus, scale }: { entries: (FanEntry | null)[]; focus: number; onFocus: (gameId: number) => void; scale: number }) {
  const present = entries.filter((e): e is FanEntry => !!e);
  const ids = present.map(e => e.game.id);
  // box art: every card of a box-art server, or all of them when this device asks (?cards=boxart); a device asking for the poster
  // where the cut-out stood (?cards=cover|fade) gets those cards from the server; either way the fan waits a moment for the posters
  const look = cardsWanted(), wanted = look === "boxart";
  const { cards, settled } = useFanCards(ids, { poster: !!look });
  const fonts = useFontsReady();
  const boxed = ids.some(id => !!boxOf(cards.get(id), wanted));
  // the ring (useRing): the picked order after the hue rule (not for box art, from the first answer on, so no card moves when
  // the posters arrive), where each card sits round `focus`, its colour, which wrap round
  const { ring: turn, slots, colourOf, warps } = useRing(entries.map(e => e?.game.id ?? null), cards, focus, { hue: !(wanted || boxed) });
  const live = new Map(present.map(e => [e.game.id, e]));
  const ring = turn.map(o => ({ ...o, entry: live.get(o.id)! }));
  const n = ring.length;
  // keyboard: Left / Right bring the neighbour to the centre, and the focus follows it
  const frame = useRef<HTMLDivElement>(null);
  const byKey = useRef(false);
  // the turn: the picked card glides to the centre under the pointer, so a double click (or a second click on the same spot)
  // landed on it and opened its page; a mouse click on the centre opens it only once the fan has stopped (keys are never held)
  const turnedAt = useRef(0), mounted = useRef(false);
  useEffect(() => { if (mounted.current) turnedAt.current = performance.now(); mounted.current = true; }, [focus]);
  const canOpen = () => performance.now() - turnedAt.current > TURN_GUARD_MS;
  useEffect(() => {
    if (!byKey.current) return;
    byKey.current = false;
    // the cards reach past the window's bottom edge: focusing one must not scroll the page to it
    frame.current?.querySelector<HTMLElement>(`[data-hit="${focus}"]`)?.focus({ preventScroll: true });
  }, [focus]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const want = e.key === "ArrowLeft" ? 1 : 3, i = slots.indexOf(want);
    if (i < 0) return;
    e.preventDefault();
    byKey.current = true;
    onFocus(ring[i].entry.game.id);
  };
  // the fan appears whole: once every card answered and the fonts the labels were measured in are there
  if (!settled || !n || !fonts) return null;
  const detail = scale >= 0.66;
  return (
    <div className="hf" role="group" aria-label="Your games" onKeyDown={onKey}>
      <div className="hf-frame" ref={frame} style={{ transform: `translateX(-50%) scale(${scale})`, "--hf-s": scale } as CSSProperties}>
        {ring.map((r, i) => slots[i] < 0 ? null : (
          <FanCard key={r.entry.game.id} game={r.entry.game} card={cards.get(r.entry.game.id) ?? null} colour={colourOf(i)} slot={slots[i]}
            box={boxOf(cards.get(r.entry.game.id), wanted)} moving={r.entry.moving} playing={r.entry.playing}
            words={r.entry.words} detail={detail} warp={warps(r.entry.game.id)}
            onPick={() => onFocus(r.entry.game.id)} canOpen={canOpen} />
        ))}
      </div>
    </div>
  );
}


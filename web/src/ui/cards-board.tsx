/**
 * Dev only: /__cards?src=<address of a JSON list> — a stress board for the Home's cards. Every card in the list is drawn at the fan's
 * own size (384 × 560, k = 1) twice, with the real components (ui/fan.tsx CardFace, CardTag; screens/home-fan.tsx pickLayout,
 * CardRow, CardPill):
 *   - as the front card (the centre slot, upright);
 *   - as a side card in an inner or outer slot, turned like the fan's, carrying a sample state in turn (arrived, on this PC, copying,
 *     looking, tracked) with its action pill.
 * What the fan hides is dimmed: everything under the frame's bottom edge, and on a side card the part the next card toward the
 * centre covers (its outline dashed). Rendered outside the sign-in gate, like /__gallery.
 * The list: { cards: [...] }, each the card JSON as GET /api/v1/art/game/:id/card gives it (an art or poster url may be absolute):
 * the recipe's face with its art (a cut-out, a dissolve, or the poster where the cut-out stood: cover, fade), or box art as the card
 * (art.kind "poster": its poster with the tag). An entry of { id, title, poster } alone is drawn as box art too.
 */
import { useEffect, useState, type ReactNode } from "react";
import { CardFace, CardTag, SLOTS, TAG_PILL, posterBlocks, useFontsReady, type CardJson, type PosterJson } from "./fan";
import { CardPill, CardRow, pickLayout } from "../screens/home-fan";
import type { Act } from "./game-action";
import type { AvatarUser } from "./avatar";

type BoxEntry = { id: number; title: string; poster: PosterJson };
type Entry = CardJson | BoxEntry;
const isCard = (e: Entry): e is CardJson => Array.isArray((e as CardJson).fan);

const act = (kind: Act["kind"], label: string, icon: Act["icon"], extra: Partial<Act> = {}): Act => ({ kind, label, icon, lead: kind !== "cancel" && kind !== "tracked", ...extra });
const PELL: AvatarUser = { displayName: "Pell", name: "pell", hue: 280 };
/** the sample states on box art, in turn: the Home's words (screens/home.tsx sayGame), the action, how far it moved, who plays it */
const STATES: { status: string; short: string; act: Act | null; progress?: number; grey?: boolean; who?: AvatarUser }[] = [
  { status: "Arrived Tuesday · 2.4 GB", short: "Arrived Tuesday", act: act("install", "Install", "install") },
  { status: "On this PC · 41 h played", short: "41 h played", act: act("play", "Play", "playSolid") },
  { status: "Downloading · 48% · about 13 min left", short: "48% · about 13 min left", act: act("cancel", "Cancel", "cancel"), progress: 0.48 },
  { status: "Pell is playing", short: "Pell is playing", act: act("install", "Install", "install"), who: PELL },
  { status: "Asked for by Mika · Looking", short: "Looking", act: act("cancel", "Cancel", "cancel"), grey: true },
  { status: "Tracked · in 3 days", short: "In 3 days", act: act("tracked", "Tracked", "tick", { pressed: true }) },
  { status: "Installing · 61% · 2 min left", short: "61% · 2 min left", act: null, progress: 0.61 },
];
/** the sample states on the recipe's face, in turn: what the Home's side cards say (the status, its one-fact short form, the pill) */
const WORDS: { status: string; short: string; act: Act | null }[] = [
  { status: "Arrived Tuesday · 2.4 GB", short: "Arrived Tuesday", act: act("install", "Install", "install") },
  { status: "On this PC · 41 h played", short: "41 h played", act: act("play", "Play", "playSolid") },
  { status: "Downloading · 48% · about 13 min left", short: "48% · about 13 min left", act: act("cancel", "Cancel", "cancel") },
  { status: "Arrived today · On this PC", short: "Arrived today", act: act("play", "Play", "playSolid") },
  { status: "Looking", short: "Looking", act: act("cancel", "Cancel", "cancel") },
  { status: "Tracked · in 3 days", short: "In 3 days", act: act("tracked", "Tracked", "tick", { pressed: true }) },
  { status: "Installing · 61% · 2 min left", short: "61% · 2 min left", act: null },
];
/** the side slots, in turn: inner left, inner right, outer left, outer right */
const SIDES = [1, 3, 0, 4];
const sideName = (s: number) => `${s < 2 ? "left" : "right"} ${s === 1 || s === 3 ? "inner" : "outer"}`;

/** where a slot's card sits relative to another slot's (board px, before either turns) */
const offset = (from: number, to: number) => ({ x: SLOTS[to].left - SLOTS[from].left, y: SLOTS[to].top - SLOTS[from].top });

/** the card's place in its stage: room for a card turned 10.5 degrees */
const X0 = 58, Y0 = 22;

function Stage({ slot, children, label }: { slot: number; children: ReactNode; label: string }) {
  const s = SLOTS[slot], cut = 960 - s.top;                          // the frame's bottom edge, in the card's own (unturned) box
  const over = slot === 2 ? null : slot < 2 ? slot + 1 : slot - 1;
  const o = over == null ? null : offset(slot, over);
  return (
    <figure className="cb-stage">
      <div className="cb-clip">
        <div className="hf-card" data-slot={slot} style={{ position: "absolute", left: X0, top: Y0, transform: `rotate(${s.rot}deg)`, zIndex: 1 }}>{children}</div>
        {o && over != null && <div className="cb-over" style={{ left: X0 + o.x, top: Y0 + o.y, transform: `rotate(${SLOTS[over].rot}deg)` }} />}
        <div className="cb-cut" style={{ top: Y0 + cut }} />
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

/** a box-art card (the poster is the card): the front, and a side card with its tag */
function BoxCell({ i, title, box }: { i: number; title: string; box: PosterJson }) {
  const st = STATES[i % STATES.length], side = SIDES[i % SIDES.length];
  return <>
    <Stage slot={2} label={`${title} · ${box.w} × ${box.h} · front`}>
      <CardFace card={null} colour={box.colour} slot={2} layout={null} title={title} box={box} />
    </Stage>
    <Stage slot={side} label={`${sideName(side)} · ${st.short}`}>
      <CardFace card={null} colour={box.colour} slot={side} layout={null} title={title} box={box} progress={st.progress} grey={st.grey} />
      <CardTag slot={side} name={title} status={st.status} short={st.short} who={st.who ?? null} verb={st.act?.label ?? null}
        progress={st.progress ?? null} text={posterBlocks(box)}>
        {st.act && <CardPill act={st.act} p={TAG_PILL} busy={false} label={title} onAct={() => {}} />}
      </CardTag>
    </Stage>
  </>;
}

/** the recipe's face (its own colour, title and art): the front, and a side card with the status row and the pill */
function RecipeCell({ i, card }: { i: number; card: CardJson }) {
  const w = WORDS[i % WORDS.length], side = SIDES[i % SIDES.length];
  const front = pickLayout(card, 2, w, null, true), back = pickLayout(card, side, w, w.act?.label ?? null, true);
  const L = back.v.labels;
  return <>
    <Stage slot={2} label={`${card.title} · ${card.art.w} × ${card.art.h} · front`}>
      <CardFace card={card} colour={card.colour} slot={2} layout={front.v} title={card.title} />
    </Stage>
    <Stage slot={side} label={`${sideName(side)} · ${back.text}`}>
      <CardFace card={card} colour={card.colour} slot={side} layout={back.v} title={card.title} />
      {L.kind === "side" && (
        <CardRow L={L} pick={back} colour={card.colour}>
          {w.act && <CardPill act={w.act} p={L.pill} busy={false} label={card.title} onAct={() => {}} />}
        </CardRow>
      )}
    </Stage>
  </>;
}

/** what the list draws, for the heading */
function lookOf(e: Entry | undefined): string {
  if (!e || !isCard(e) || e.art.kind === "poster") return "box art as the card";
  if (e.art.kind === "cover") return "the poster as an object where the cut-out stood (cover)";
  if (e.art.kind === "dissolve" && e.art.source === "poster" && e.art.url === e.poster?.url) return "the poster melting into the colour (fade)";
  return `the recipe (${e.art.kind})`;
}

export default function CardsBoard() {
  const fonts = useFontsReady();
  const [list, setList] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const src = new URLSearchParams(location.search).get("src");
  useEffect(() => {
    if (!src) { setError("Add ?src=<address of the JSON list>"); return; }
    fetch(src).then(r => r.json()).then((j: { cards: Entry[] }) => setList(j.cards)).catch(e => setError(String(e)));
  }, [src]);
  if (error) return <p className="cb-msg">{error}</p>;
  if (!list || !fonts) return <p className="cb-msg">Loading…</p>;
  const posterOf = (e: Entry): PosterJson | null => (isCard(e) ? e.poster ?? null : e.poster);
  const short = list.filter(e => { const p = posterOf(e); return !!p && p.h / p.w < 560 / 384 - 0.01; }).length;
  return (
    <main className="cb">
      <style>{CSS}</style>
      <h1>{list.length} cards · {lookOf(list[0])} · {list.length - short} posters at 2:3 or taller, {short} shorter (3:4) · drawn at the fan's size; dimmed: what the fan hides</h1>
      <div className="cb-grid">
        {list.map((e, i) => {
          const box = posterOf(e);
          return (
            <section key={e.id} className="cb-cell">
              {isCard(e) && e.art.kind !== "poster" ? <RecipeCell i={i} card={e} /> : box ? <BoxCell i={i} title={e.title} box={box} /> : null}
            </section>
          );
        })}
      </div>
    </main>
  );
}

const CSS = `
body { background: #101010; }
.cb { padding: 32px 40px 48px; color: #a4a4a4; font: 500 15px/20px var(--ui); }
.cb h1 { margin: 0 0 24px; font: 600 17px/24px var(--ui); color: #f2f2f2; }
.cb-msg { padding: 40px; color: #f2f2f2; font: 500 15px/20px var(--ui); }
.cb-grid { display: grid; grid-template-columns: repeat(auto-fill, 1000px); gap: 4px 24px; }
.cb-cell { display: flex; gap: 0; }
.cb-stage { position: relative; margin: 0; width: 500px; }
.cb-clip { position: relative; height: 604px; overflow: hidden; border-radius: 12px; background: #161616; box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }
.cb-over { position: absolute; width: 384px; height: 560px; z-index: 2; border-radius: 36px; transform-origin: 50% 50%; background: rgba(16,16,16,.55); outline: 1px dashed rgba(255,255,255,.28); outline-offset: -1px; }
.cb-cut { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; background: rgba(16,16,16,.62); border-top: 1px dashed rgba(255,255,255,.4); }
.cb figcaption { margin: 8px 4px 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #a4a4a4; font: 500 13px/18px var(--ui); }
`;

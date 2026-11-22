/**
 * Cards — the generated Home cards, made from each game's own art (the recipe in recipe.ts and layout.ts):
 *   - a request is answered at once with the best card there is: the built one (cut-out or dissolve), else a
 *     colour-only card made from the poster on the spot, else a neutral one; status "pending" while a better one is
 *     coming;
 *   - the work happens in the background: the sources are resolved (the poster, the key art, the logo), a dissolve
 *     is made first (no model needed), then the cut-out pass with BiRefNet when cut-outs are on and the model is there;
 *   - cards are cached under <config>/cache/cards by the hash of their sources, so new art makes a new card;
 *   - every card also carries its game's box art and the colour of that art (`poster`, poster.ts), so a client may draw the
 *     box art instead; under CARD_STYLE=boxart that is the only card there is (no jobs, no model). The poster is read first
 *     (before the key art and the logo), and for a client that draws box art (?text=1, and always under CARD_STYLE=boxart)
 *     its lettering too, once per poster;
 *   - under CARD_STYLE=cover or fade, and for a client that asks ?style=cover|fade, the card is the recipe's own with the poster
 *     where the cut-out stood (posterCard): made on the spot from the poster, its lettering and that style's colours, so no jobs,
 *     no key art, no model. The game's logo is asked for alongside the poster: it is the reading's second opinion on the poster's
 *     lettering (poster.ts posterText).
 */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { logger } from "../log";
import * as ludarr from "../ludarr";
import type { CardJson, PosterJson } from "./contract";
import type * as C from "./colour";
import { colourJson, layoutsJson, layoutsOf } from "./build";
import { CARD, displayName } from "./layout";
import { cardStyle, ensureModel, modelPath, modelState, onModelReady, cutoutsOn, posterOnly } from "./model";
import { fadeColours, posterCardJson, posterColours, posterJson, posterText, type Colours } from "./poster";
import { addJob, jobStage, stopQueue, type Stage } from "./queue";
import { keyArtOf, logoOf, posterOf, type Inputs, type SourceRef } from "./sources";
import { RECIPE_VERSION, absolute, cardsRoot, gameDir, maskDir, newestRecord, readRecord, sha1, writeRecord, type CardRecord } from "./store";
import type { WorkerCard, WorkerJob } from "./worker";

const log = logger("Cards");
export const cardOptions = { revalidateMs: 10 * 60_000, quickWaitMs: 1000, retryFailedMs: 60 * 60_000 };

/** the styles that put the poster where the cut-out stood (a server's CARD_STYLE, or what a client asks with ?style=) */
export type PosterStyle = "cover" | "fade";
/** the box art as the cards use it: the poster's hash and file, the game's logo (the lettering's second opinion; null when there is
 *  none), its colour and alternates, its lettering once read, the cover's and the fade's colours once made (and the readings under
 *  way), and the JSON block */
interface PosterInfo {
  hash: string; ref: SourceRef; logo: Inputs["logo"]; colour: C.CardColour; alternates: C.CardColour[]; text: number[][] | null; json: PosterJson;
  styles: Partial<Record<PosterStyle, Colours & { bandL: number }>>; reading: Partial<Record<PosterStyle, Promise<void>>>;
}
/** the rules of the cover's and the fade's places, in their cards' keys (2: the lettering kept out of the cover, the fade centred on
 *  what shows, its tint; 3: the lettering read with the game's logo as a second opinion; 4: the fade shows the art right under a
 *  wordmark at the top, and keeps lettering 16 units under a side card's frame edge) */
const POSTER_RULES = 4;
interface GameState {
  id: number;
  record: CardRecord | null;
  loaded: Promise<void> | null;
  title: string | null; inputs: Inputs | null; key: string | null;
  artRev?: number;
  resolvedAt: number; resolving: Promise<void> | null;
  poster: Promise<SourceRef | null> | null;
  posterInfo: PosterInfo | null;
  /** settles once the resolution under way has read the poster (its colour, and its lettering when wanted) */
  posterRead: Promise<void> | null;
  /** a client draws this game's box art (it asked with ?text=1): its poster's lettering is read too */
  wantText: boolean;
  texting: Promise<void> | null;
  quick: { key: string; json: CardJson } | null;
  /** CARD_STYLE=boxart: the poster card, under its key */
  boxed: { key: string; json: CardJson } | null;
  /** the cover and fade cards, each under its key */
  styled: Partial<Record<PosterStyle, { key: string; json: CardJson }>>;
  failed: Map<string, number>;
}
const states = new Map<number, GameState>();
let generation = 0;                          // stopCards() starts a new one: work begun before it is dropped
const stateOf = (id: number): GameState => {
  let st = states.get(id);
  if (!st) { st = { id, record: null, loaded: null, title: null, inputs: null, key: null, resolvedAt: 0, resolving: null, poster: null, posterInfo: null, posterRead: null, wantText: false, texting: null, quick: null, boxed: null, styled: {}, failed: new Map() }; states.set(id, st); }
  return st;
};
/** the state of a game the cards know: a library game, or one with a card on disk. The routes are session-free, so an
 * id that is neither holds nothing in memory. */
const knownState = (id: number, inLibrary: boolean): GameState | null => states.get(id) ?? (inLibrary || existsSync(gameDir(id)) ? stateOf(id) : null);

const keyOf =(title: string, i: Inputs) => sha1([RECIPE_VERSION, title, i.poster?.hash ?? "-", i.keyArt ? `${i.keyArt.hash}:${i.keyArt.trusted ? "t" : "r"}` : "-", i.logo ? `${i.logo.hash}:${i.logo.box.x},${i.logo.box.y},${i.logo.box.w},${i.logo.box.h}` : "-"].join("|")).slice(0, 20);

/** resolve the game's art (in the background) and queue what is missing; the box art is read first, so a client that draws
 *  it never waits on the key art */
function ensure(st: GameState, g: ludarr.LudarrGame) {
  const title = displayName(g.name);
  if (st.resolvedAt && Date.now() - st.resolvedAt < cardOptions.revalidateMs && st.title === title && st.artRev === (g.customArtAt ?? 0)) { schedule(st); return; }
  if (st.resolving) return;
  const gen = generation;
  let posterDone = () => {};
  st.posterRead = new Promise<void>(r => { posterDone = r; });
  st.resolving = (async () => {
    try {
      const poster = posterOf(g);
      // the logo is the second opinion on the poster's lettering (poster.ts posterText): asked for alongside the poster
      const logo = logoOf(g);
      st.poster = poster;
      const p = await poster;
      if (gen !== generation) return;
      const lg = await logo;
      if (gen !== generation) return;
      await readPoster(st, p, lg, gen);
      posterDone();
      if (gen !== generation) return;
      // the box-art styles need only the poster (and the logo for its lettering)
      const keyArt: Inputs["keyArt"] = posterOnly() ? null : await keyArtOf(g, p);
      if (gen !== generation) return;
      const inputs: Inputs = { poster: p, keyArt, logo: posterOnly() ? null : lg };
      st.artRev = g.customArtAt ?? 0; st.title = title; st.inputs = inputs; st.key = keyOf(title, inputs); st.resolvedAt = Date.now();
      if (!st.record || st.record.key !== st.key) { const r = await readRecord(st.id, st.key); if (r) st.record = r; }
      schedule(st);
    } catch (e: any) { log.warn(`card sources for game ${st.id}: ${e?.message ?? e}`); }
    finally { posterDone(); st.resolving = null; }
  })();
}

/** the box art: the poster's colour, and its lettering (read with the game's logo `logo`) when a client draws box art */
async function readPoster(st: GameState, p: SourceRef | null, logo: Inputs["logo"], gen: number) {
  if (!p) { st.posterInfo = null; return; }
  if (st.posterInfo?.hash !== p.hash || st.posterInfo.logo?.hash !== logo?.hash) {
    const { colour, alternates } = await posterColours(p.file);
    if (gen !== generation) return;
    st.posterInfo = { hash: p.hash, ref: p, logo, colour, alternates, text: null, json: posterJson(st.id, p, colour), styles: {}, reading: {} };
  }
  const own = cardStyle();
  if (own === "cover" || own === "fade") await styleRead(st, own);
  else if (st.wantText || own === "boxart") await readText(st);
}
/** the poster's lettering (poster.ts posterText with the game's logo as its second opinion, kept under <cards>/text by the poster's
 *  hash and the logo's); one reading per game at a time */
function readText(st: GameState): Promise<void> {
  const info = st.posterInfo;
  if (!info || info.text) return Promise.resolve();
  if (st.texting) return st.texting;
  const gen = generation;
  const reading: Promise<void> = posterText(info.ref, join(cardsRoot(), "text"), info.logo)
    .then(text => { if (gen === generation && st.posterInfo === info) { info.text = text; info.json = posterJson(st.id, info.ref, info.colour, text); } })
    .catch(() => {})
    .finally(() => { if (st.texting === reading) st.texting = null; });
  st.texting = reading;
  return reading;
}
/** what the cover and the fade need besides the poster: its lettering (readText), then that style's colours (poster.ts:
 *  posterColours without the lettering for the cover, fadeColours for the fade); made once per poster, one reading at a time */
function styleRead(st: GameState, style: PosterStyle): Promise<void> | null {
  const info = st.posterInfo;
  if (!info || info.styles[style]) return null;
  const reading = info.reading[style] ?? readText(st)
    .then(async () => {
      if (st.posterInfo !== info) return;
      const text = info.text ?? [];
      const made = style === "fade" ? await fadeColours(info.ref.file, text) : { ...(await posterColours(info.ref.file, text)), bandL: 0.5 };
      if (st.posterInfo === info) info.styles[style] = made;
    })
    .catch(() => {})
    .finally(() => { delete info.reading[style]; });
  info.reading[style] = reading;
  return reading;
}
/** what a request that wants the box art waits for (a moment at most): the poster, then its lettering */
const boxArtRead = (st: GameState): Promise<void> | null =>
  !st.posterInfo ? (st.resolving ? st.posterRead : null) : st.posterInfo.text || !(st.wantText || cardStyle() === "boxart") ? null : readText(st);

const failedRecently = (st: GameState, stage: Stage) => { const at = st.failed.get(`${st.key}:${stage}`); return !!at && Date.now() - at < cardOptions.retryFailedMs; };

function schedule(st: GameState) {
  if (posterOnly()) return;                                               // the box-art styles make nothing in the background
  const i = st.inputs, key = st.key, title = st.title;
  if (!i || !key || !title || (!i.poster && !i.keyArt)) return;
  const rec = st.record && st.record.key === key ? st.record : null;
  if (!rec && !failedRecently(st, "dissolve")) addJob(job(st, "dissolve", key, title, i));
  if ((!rec || rec.tier !== "final") && cutoutsOn() && ensureModel() === "ready" && !failedRecently(st, "final")) addJob(job(st, "final", key, title, i));
}

function job(st: GameState, stage: Stage, key: string, title: string, i: Inputs) {
  const cutout = `${gameDir(st.id)}/${key}.png`;
  return {
    gameId: st.id, stage, key,
    make: (id: number): WorkerJob => ({
      id, gameId: st.id, key, stage, title,
      poster: i.poster ? { file: i.poster.file, hash: i.poster.hash } : null,
      keyArt: i.keyArt ? { file: i.keyArt.file, hash: i.keyArt.hash, trusted: i.keyArt.trusted } : null,
      logo: i.logo ? { file: i.logo.file, box: i.logo.box } : null,
      model: stage === "final" ? modelPath() : null, maskDir: maskDir(), cutout,
    }),
    done: async (card: WorkerCard, ms: number) => {
      if (st.key !== key) return;                                            // the art changed meanwhile: a newer job follows
      if (stage === "dissolve" && st.record?.key === key && st.record.tier === "final") return;
      const src = card.srcFile === i.poster?.file ? i.poster : i.keyArt;
      const rec: CardRecord = {
        v: RECIPE_VERSION, id: st.id, key, tier: stage, at: Date.now(), ms, title, mode: card.mode, source: card.source,
        image: card.image.cutout ? { file: relative(cardsRoot(), cutout).replace(/\\/g, "/"), type: "image/png", w: card.image.w, h: card.image.h }
          : { file: relative(cardsRoot(), card.srcFile).replace(/\\/g, "/"), type: src?.type ?? "image/jpeg", w: card.image.w, h: card.image.h },
        colour: card.colour, alternates: card.alternates, free: card.free, freeWide: card.freeWide, fan: card.fan, report: card.report,
      };
      await writeRecord(rec);
      st.record = rec;
      log.debug(`card for game ${st.id}: ${rec.mode} from the ${rec.source} (${stage}, ${(ms / 1000).toFixed(1)} s)`);
    },
    fail: (error: string) => {
      st.failed.set(`${key}:${stage}`, Date.now());
      log.warn(`card for game ${st.id} (${stage}): ${error.split("\n")[0]}`);
    },
  };
}

onModelReady(() => { for (const st of states.values()) schedule(st); });

/** what a pending card should tell the client */
function statusOf(st: GameState): { status: "ready" | "pending"; retryAfter: number | null } {
  const stage = jobStage(st.id);
  if (stage === "dissolve") return { status: "pending", retryAfter: 3 };
  if (stage === "final") return { status: "pending", retryAfter: 10 };
  // the art is being read (again): new art would make a new card, so this answer is not final yet
  if (st.resolving) return { status: "pending", retryAfter: 3 };
  // the poster's lettering is being read for a client that draws box art
  if (st.texting) return { status: "pending", retryAfter: 1 };
  if (!st.record || (st.key && st.record.key !== st.key)) return !st.resolvedAt ? { status: "pending", retryAfter: 3 } : { status: "ready", retryAfter: null };
  if (st.record.tier === "dissolve" && cutoutsOn() && modelState() === "downloading") return { status: "pending", retryAfter: 60 };
  return { status: "ready", retryAfter: null };
}

function fromRecord(st: GameState, rec: CardRecord): CardJson {
  const url = rec.mode === "cut" ? `/api/v1/art/game/${rec.id}/card/cutout.png?v=${rec.key}` : `/api/v1/art/game/${rec.id}/card/art?v=${rec.key}`;
  return { v: 1, id: rec.id, key: rec.key, ...statusOf(st), title: rec.title, card: { ...CARD }, colour: rec.colour, alternates: rec.alternates,
    art: { kind: rec.mode, url, w: rec.image.w, h: rec.image.h, source: rec.source }, free: rec.free, freeWide: rec.freeWide, fan: rec.fan,
    poster: st.posterInfo?.json ?? null };
}

/** a card without art: its colour from the poster's own swatches (or the neutral rule when there is no poster) */
async function quickCard(st: GameState, title: string, poster: SourceRef | null): Promise<CardJson> {
  const qkey = `q${sha1(`${title}|${poster?.hash ?? "-"}`).slice(0, 19)}`;
  const boxArt = () => ({ poster: st.posterInfo?.json ?? null });
  if (st.quick && st.quick.key === qkey) return { ...st.quick.json, ...statusOf(st), ...boxArt() };
  const known = poster && st.posterInfo?.hash === poster.hash ? st.posterInfo : null;
  const { colour, alternates } = known ?? await posterColours(poster?.file ?? null);
  const lay = layoutsJson(layoutsOf(title, { mode: "none" }, colour), 0, null);
  const json: CardJson = { v: 1, id: st.id, key: qkey, status: "pending", retryAfter: 3, title, card: { ...CARD }, colour: colourJson(colour), alternates: alternates.map(colourJson),
    art: { kind: "none", url: null, w: 0, h: 0, source: null }, free: lay.free, freeWide: lay.freeWide, fan: lay.fan, poster: null };
  if (poster) st.quick = { key: qkey, json };
  return { ...json, ...statusOf(st), ...boxArt() };
}

const sleep = (ms: number) => new Promise<null>(r => { const t = setTimeout(() => r(null), ms); (t as { unref?: () => void }).unref?.(); });

/** CARD_STYLE=boxart: the poster is the card once it was read (its colour the poster's, the labels laid out as on a card with
 *  no art, for clients that draw labels); before that, and for a game with no poster, the colour-only card */
async function boxCard(st: GameState, g: ludarr.LudarrGame): Promise<CardJson> {
  ensure(st, g);
  const title = displayName(g.name);
  // the first request waits a moment for the poster and its lettering, like the quick card
  const reading = boxArtRead(st);
  if (reading) await Promise.race([reading, sleep(cardOptions.quickWaitMs)]);
  const info = st.posterInfo;
  if (!info) return quickCard(st, title, null);
  const key = "b" + sha1([RECIPE_VERSION, "boxart", title, info.hash].join("|")).slice(0, 19);
  if (st.boxed?.key !== key) {
    const lay = layoutsJson(layoutsOf(title, { mode: "none" }, info.colour), 0, null);
    st.boxed = { key, json: { v: 1, id: st.id, key, status: "ready", retryAfter: null, title, card: { ...CARD }, colour: colourJson(info.colour), alternates: info.alternates.map(colourJson),
      art: { kind: "poster", url: info.json.url, w: info.json.w, h: info.json.h, source: "poster" }, free: lay.free, freeWide: lay.freeWide, fan: lay.fan, poster: info.json } };
  }
  return { ...st.boxed.json, ...statusOf(st), poster: info.json };
}

/** CARD_STYLE=cover or fade, or a client asking ?style=cover|fade: the recipe's card with the poster where the cut-out stood
 *  (poster.ts posterCardJson), its lettering out of sight, its colour the poster's by the recipe's rule for what the card shows;
 *  made on the spot once the poster and its lettering were read (the first request waits a moment for them), and kept under its
 *  key. A game with no poster keeps the colour-only card with its title. Ready as soon as it is made: nothing better is coming. */
async function posterCard(st: GameState, g: ludarr.LudarrGame, style: PosterStyle): Promise<CardJson> {
  ensure(st, g);
  const title = displayName(g.name);
  if (!st.posterInfo && st.resolving) await Promise.race([st.posterRead, sleep(cardOptions.quickWaitMs)]);
  const info = st.posterInfo;
  if (!info) {
    const q = await quickCard(st, title, null);
    return { ...q, ...(st.resolving ? { status: "pending" as const, retryAfter: 1 } : { status: "ready" as const, retryAfter: null }) };
  }
  // both keep the poster's lettering out of sight and take their colour from the poster without it: read once
  if (!info.styles[style]) { const reading = styleRead(st, style); if (reading) await Promise.race([reading, sleep(cardOptions.quickWaitMs)]); }
  const pick = info.styles[style];
  if (!pick) return { ...(await quickCard(st, title, info.ref)), status: "pending", retryAfter: 1 };
  const key = style.charAt(0) + sha1([RECIPE_VERSION, POSTER_RULES, style, title, info.hash, info.logo?.hash ?? "-"].join("|")).slice(0, 19);
  let made = st.styled[style];
  if (made?.key !== key) {
    made = { key, json: posterCardJson(style, st.id, key, title, info.json, pick, info.text ?? [], pick.bandL) };
    st.styled[style] = made;
  }
  return { ...made.json, ...(st.resolving ? { status: "pending" as const, retryAfter: 1 } : {}), poster: info.json };
}

/** the card of a library game (null when the game is unknown); never waits on the queue. `text`: the client draws box art,
 *  so the card's `poster` carries the poster's lettering (read now if need be, with a moment's wait like the quick card's).
 *  `style`: the client asks for the poster where the cut-out stood (cover, fade), whatever this server's own style */
export async function getCard(id: number, { text = false, style = null }: { text?: boolean; style?: PosterStyle | null } = {}): Promise<CardJson | null> {
  const g = ludarr.libraryById().get(id);
  const st = knownState(id, !!g);
  if (!st) return null;
  if (text) st.wantText = true;
  const own = cardStyle(), want = style ?? (own === "cover" || own === "fade" ? own : null);
  if (want) return g ? posterCard(st, g, want) : null;
  if (own === "boxart") return g ? boxCard(st, g) : null;
  if (!st.loaded) st.loaded = newestRecord(id).then(r => { if (r && !st.record) st.record = r; }).catch(() => {});
  await st.loaded;
  if (g) ensure(st, g);
  const reading = text ? boxArtRead(st) : null;
  if (reading) await Promise.race([reading, sleep(cardOptions.quickWaitMs)]);
  if (st.record) return fromRecord(st, st.record);
  if (!g) return null;
  const title = displayName(g.name);
  const poster = st.poster ? await Promise.race([st.poster, sleep(cardOptions.quickWaitMs)]) : null;
  if (st.record) return fromRecord(st, st.record);
  return quickCard(st, title, poster);
}

/** the image a built card draws: the cut-out PNG or the source art (null when the card has none of that kind) */
export async function cardImage(id: number, kind: "cutout" | "art"): Promise<{ path: string; type: string; key: string } | null> {
  const st = knownState(id, ludarr.libraryById().has(id));
  if (!st) return null;
  if (!st.loaded) st.loaded = newestRecord(id).then(r => { if (r && !st.record) st.record = r; }).catch(() => {});
  await st.loaded;
  const rec = st.record;
  if (!rec || (kind === "cutout") !== (rec.mode === "cut")) return null;
  return { path: absolute(rec.image.file), type: rec.image.type, key: rec.key };
}

/** stop the worker and forget every game's state (tests, shutdown) */
export function stopCards() { generation++; stopQueue(); states.clear(); }
export const cardsInternals = { states, statusOf: (id: number) => statusOf(stateOf(id)), modelState };

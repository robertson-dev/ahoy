/**
 * Spotlight — the stage at the top of Home, Discover and the game pages, laid out by the boards' rule (M/spot/gen) for each game's
 * own art: where the key art sits and how it is blurred, how strong the scrims are, and whether the identity is the Steam logo (as it
 * is, or recoloured) or the title, at which size.
 *   - The art is the spotlight's hero chain (art.ts): Steam's library hero for the game's app (used whole), else ludarr's banner
 *     (its top 90%), else the blank placeholder; the logo is Steam's.
 *   - A layout is made per stage width (rounded to 40 px), top-bar height and page margin, in the background (the worker), and
 *     kept under <config>/cache/spotlight/<key>/ where the key is the hash of the art's and the logo's bytes, the name and the
 *     rule's version: new art makes new layouts, and the same art is never laid out twice for one stage.
 *   - A request never waits on the work: it answers with the layout when there is one, else "pending" with the nearest layout of
 *     the same art (or none yet), and the client asks again after retryAfter.
 */
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../config";
import { stmts } from "../db";
import { knownName } from "../names";
import { logger } from "../log";
import * as ludarr from "../ludarr";
import { gameImage, steamHeroImage, steamLogo, type CachedImage } from "../art";
import { atomicWrite, sha1 } from "../cards/store-io";
import { bucketOf, type SpotLayout, type SpotlightJson } from "./contract";
import { addJob, jobState, stopQueue } from "./queue";

const log = logger("Spotlight");
/** bump when the rule or the layout changes: every layout is made again */
/** 2: every stage but the board's keeps the board's subject (rule.ts anchor, keep) */
export const SPOT_VERSION = 2;
export const spotOptions = { revalidateMs: 10 * 60_000, quickWaitMs: 1000, retryFailedMs: 30 * 60_000, memo: 600, sources: 2000 };

export type Source = { kind: "game"; id: number } | { kind: "app"; id: number; name?: string | null };
export interface Asked { w: number; bar: number; left: number }

/** where the art comes from (tests point these at fixture files) */
export const spotDeps = {
  game: (id: number) => ludarr.libraryById().get(id) ?? null,
  gameOfApp: (appId: number) => ludarr.libraryByApp().get(appId) ?? null,
  appName: (appId: number) => knownName((stmts.catalogGet.get(appId) as { name?: string } | undefined)?.name),
  steamHero: (appId: number): Promise<CachedImage | null> => steamHeroImage(appId),
  banner: (gameId: number): Promise<CachedImage | null> => gameImage(gameId, "banner"),
  logo: (appId: number): Promise<CachedImage | null> => steamLogo(appId),
};

const RASTER = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);
interface FileRef { file: string; hash: string }
interface Inputs { hero: (FileRef & { fromSteam: boolean }) | null; logo: FileRef | null; name: string }
interface State { artRev?: number; id: string; src: Source; inputs: Inputs | null; key: string | null; resolvedAt: number; resolving: Promise<void> | null; failed: Map<string, number> }

const states = new Map<string, State>();
const layouts = new Map<string, SpotLayout>();            // "<key>/<bucket>" -> layout (most recent last)
const known = new Map<string, Set<string>>();             // key -> the buckets on disk
const hashes = new Map<string, { sig: string; hash: string }>();
let generation = 0;
const hold = <K, V>(m: Map<K, V>, k: K, v: V, max: number) => { m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value!); };
const root = () => join(configDir(), "cache", "spotlight");
const bucketName = (a: Asked) => `${a.w}-${a.bar}-${a.left}`;

/** the asked stage, rounded: the width to its 40 px bucket; the bar and the margin to the two the UI has (defaults by width) */
export function askedOf(w?: number | null, bar?: number | null, left?: number | null): Asked {
  const W = bucketOf(Number.isFinite(w) && w! > 0 ? w! : 1440);
  const wide = (Number.isFinite(w) && w! > 0 ? w! : 1440) >= 1280;
  return { w: W, bar: bar === 104 || bar === 148 ? bar : wide ? 148 : 104, left: left === 40 || left === 48 ? left : wide ? 48 : 40 };
}

async function fileHash(img: CachedImage): Promise<string | null> {
  const s = await stat(img.path).catch(() => null);
  if (!s) return null;
  const sig = `${s.size}:${Math.round(s.mtimeMs)}`, m = hashes.get(img.path);
  if (m?.sig === sig) return m.hash;
  const bytes = await readFile(img.path).catch(() => null);
  if (!bytes) return null;
  const hash = sha1(bytes);
  hold(hashes, img.path, { sig, hash }, spotOptions.sources);
  return hash;
}
const ref = async (img: CachedImage | null): Promise<FileRef | null> => {
  if (!img || !RASTER.has(img.type)) return null;
  const hash = await fileHash(img);
  return hash ? { file: img.path, hash } : null;
};

/** the art, the logo and the name of a source, read now */
/** the title a player reads: the store name without trademark signs (the web's cleanName does the same) */
const shownName = (s: string) => s.replace(/[™®©]/g, "").replace(/\s{2,}/g, " ").trim();

async function inputsOf(src: Source): Promise<Inputs | null> {
  if (src.kind === "game") {
    const g = spotDeps.game(src.id);
    if (!g) return null;
    const app = g.steamAppId ?? null;
    const steam = app ? await ref(await spotDeps.steamHero(app).catch(() => null)) : null;
    const hero = steam ? { ...steam, fromSteam: true } : await ref(await spotDeps.banner(g.id).catch(() => null)).then(r => (r ? { ...r, fromSteam: false } : null));
    const logo = app ? await ref(await spotDeps.logo(app).catch(() => null)) : null;
    return { hero, logo, name: shownName(g.name) };
  }
  const g = spotDeps.gameOfApp(src.id);
  const steam = await ref(await spotDeps.steamHero(src.id).catch(() => null));
  const hero = steam ? { ...steam, fromSteam: true } : g ? await ref(await spotDeps.banner(g.id).catch(() => null)).then(r => (r ? { ...r, fromSteam: false } : null)) : null;
  const logo = await ref(await spotDeps.logo(src.id).catch(() => null));
  return { hero, logo, name: shownName(spotDeps.appName(src.id) ?? g?.name ?? src.name ?? String(src.id)) };
}
const keyOf = (i: Inputs) => sha1([SPOT_VERSION, i.hero ? `${i.hero.hash}:${i.hero.fromSteam ? "s" : "b"}` : "-", i.logo?.hash ?? "-", i.name].join("|")).slice(0, 20);

function stateOf(src: Source): State {
  const id = `${src.kind}:${src.id}`;
  let st = states.get(id);
  if (!st) st = { id, src, inputs: null, key: null, resolvedAt: 0, resolving: null, failed: new Map() };
  // a store app the server knows no name for takes the one the page shows (the title is fitted to it)
  else if (src.kind === "app" && src.name && st.src.kind === "app" && src.name !== st.src.name && st.inputs && st.inputs.name === shownName(st.src.name ?? String(src.id))) { st.src = src; st.resolvedAt = 0; }
  hold(states, id, st, spotOptions.sources);
  return st;
}
/** read the source's art again when it is older than revalidateMs (in the background) */
function ensure(st: State) {
  const game = st.src.kind === "game" ? spotDeps.game(st.src.id) : spotDeps.gameOfApp(st.src.id);
  const artRev = game?.customArtAt ?? 0;
  if (st.resolving || (st.resolvedAt && st.artRev === artRev && Date.now() - st.resolvedAt < spotOptions.revalidateMs)) return;
  const gen = generation;
  st.resolving = (async () => {
    try {
      const i = await inputsOf(st.src);
      if (gen !== generation || !i) return;
      st.artRev = artRev; st.inputs = i; st.key = keyOf(i); st.resolvedAt = Date.now();
    } catch (e: any) { log.warn(`spotlight art for ${st.id}: ${e?.message ?? e}`); }
    finally { st.resolving = null; }
  })();
}

async function load(key: string, bucket: string): Promise<SpotLayout | null> {
  const id = `${key}/${bucket}`, m = layouts.get(id);
  if (m) { hold(layouts, id, m, spotOptions.memo); return m; }
  const d = await readFile(join(root(), key, `${bucket}.json`), "utf8").then(t => JSON.parse(t) as { v: number; layout: SpotLayout }, () => null);
  if (!d || d.v !== SPOT_VERSION) return null;
  hold(layouts, id, d.layout, spotOptions.memo);
  return d.layout;
}
async function save(key: string, bucket: string, layout: SpotLayout) {
  hold(layouts, `${key}/${bucket}`, layout, spotOptions.memo);
  await mkdir(join(root(), key), { recursive: true });
  await atomicWrite(join(root(), key, `${bucket}.json`), JSON.stringify({ v: SPOT_VERSION, layout }));
  (await bucketsOf(key)).add(bucket);
}
async function bucketsOf(key: string): Promise<Set<string>> {
  let s = known.get(key);
  if (!s) {
    s = new Set((await readdir(join(root(), key)).catch(() => [] as string[])).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)));
    hold(known, key, s, spotOptions.memo);
  }
  return s;
}
/** the layout of the same art closest to the asked stage (same bar and margin first, then the nearest width) */
async function nearest(key: string, a: Asked): Promise<SpotLayout | null> {
  let best: { b: string; d: number } | null = null;
  for (const b of await bucketsOf(key)) {
    const [w, bar, left] = b.split("-").map(Number);
    const d = Math.abs(w - a.w) + (bar === a.bar ? 0 : 10_000) + (left === a.left ? 0 : 1_000);
    if (!best || d < best.d) best = { b, d };
  }
  return best ? load(key, best.b) : null;
}

/** the URLs of the files a layout draws, for this source */
function withUrls(src: Source, i: Inputs, l: SpotLayout): SpotLayout {
  const base = src.kind === "game" ? `/api/v1/art/game/${src.id}` : `/api/v1/art/steam/${src.id}`;
  const art = { ...l.art, url: i.hero ? `${base}/hero?v=${i.hero.hash.slice(0, 12)}` : `${base}/hero` };
  const identity = l.identity.kind === "logo" && i.logo ? { ...l.identity, url: `${base}/logo?v=${i.logo.hash.slice(0, 12)}` } : l.identity;
  return { ...l, art, identity };
}

const sleep = (ms: number) => new Promise<null>(r => { const t = setTimeout(() => r(null), ms); (t as { unref?: () => void }).unref?.(); });

/** a source's spotlight for a stage; null when the source is not a library game (game) or not a valid app id (app) */
export async function getSpotlight(src: Source, a: Asked): Promise<SpotlightJson | null> {
  if (!Number.isInteger(src.id) || src.id <= 0) return null;
  if (src.kind === "game" && !spotDeps.game(src.id)) return null;
  const st = stateOf(src);
  ensure(st);
  if (!st.inputs && st.resolving) await Promise.race([st.resolving, sleep(spotOptions.quickWaitMs)]);
  const i = st.inputs, key = st.key;
  if (!i || !key) return { v: 1, key: null, status: "pending", retryAfter: 2, asked: a, layout: null };
  const bucket = bucketName(a), id = `${key}/${bucket}`;
  const have = await load(key, bucket);
  if (have) return { v: 1, key, status: st.resolving ? "pending" : "ready", retryAfter: st.resolving ? 2 : null, asked: a, layout: withUrls(st.src, i, have) };
  const failedAt = st.failed.get(id);
  let queued = !!jobState(id);
  if (!queued && !(failedAt && Date.now() - failedAt < spotOptions.retryFailedMs)) {
    const gen = generation;
    queued = addJob({
      id,
      make: seq => ({ id: seq, key, hero: i.hero, logo: i.logo, name: i.name, w: a.w, bar: a.bar, left: a.left }),
      done: async layout => { if (gen === generation) await save(key, bucket, layout); log.debug(`spotlight ${st.id} at ${bucket}: ${layout.identity.kind}, k ${layout.scrim.k} (${layout.ms} ms)`); },
      fail: error => { st.failed.set(id, Date.now()); log.warn(`spotlight ${st.id} at ${bucket}: ${error.split("\n")[0]}`); },
    });
  }
  const near = await nearest(key, a);
  const failed = !!(failedAt && Date.now() - failedAt < spotOptions.retryFailedMs);
  return { v: 1, key, status: failed && near ? "ready" : "pending", retryAfter: failed ? (near ? null : 60) : queued ? 1 : 10, asked: a, layout: near ? withUrls(st.src, i, near) : null };
}

/** stop the worker and forget what is held in memory (tests, shutdown) */
export function stopSpotlight() { generation++; stopQueue(); states.clear(); layouts.clear(); known.clear(); }
export const spotInternals = { states, layouts };

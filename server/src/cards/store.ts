/**
 * Cards — the cache under <config>/cache/cards:
 *   src/<sha1>.<ext>       every source image a card was made from, by the hash of its bytes (immutable)
 *   masks/<sha1>.png       the segmentation model's soft mask of a source image, by the same hash
 *   <gameId>/<key>.json    a game's card record; key = hash of its sources, title and the recipe version, so new art
 *   <gameId>/<key>.png     regenerates; the cut-out next to it
 * Writes are atomic (a temporary file renamed into place); a game's older keys are removed once a new one is written.
 */
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../config";
import type { ColourJson, FanSlotJson, LayoutJson } from "./contract";
import { atomicWrite } from "./store-io";
export { atomicWrite, sha1 } from "./store-io";

/** bump when the recipe or the layouts change: every card is made again */
export const RECIPE_VERSION = 2;

export const cardsRoot = () => join(configDir(), "cache", "cards");
export const srcDir = () => join(cardsRoot(), "src");
export const maskDir = () => join(cardsRoot(), "masks");
export const gameDir = (id: number) => join(cardsRoot(), String(id));

export interface CardRecord {
  v: number; id: number; key: string; tier: "dissolve" | "final"; at: number; ms: number;
  title: string; mode: "cut" | "dissolve"; source: "poster" | "keyart";
  /** the image the card draws: the cut-out PNG, or the source copy (paths relative to the cards root) */
  image: { file: string; type: string; w: number; h: number };
  colour: ColourJson; alternates: ColourJson[]; free: LayoutJson; freeWide: LayoutJson; fan: FanSlotJson[];
  report: Record<string, unknown>;
}

export async function writeRecord(rec: CardRecord) {
  const dir = gameDir(rec.id);
  await mkdir(dir, { recursive: true });
  await atomicWrite(join(dir, `${rec.key}.json`), JSON.stringify(rec));
  // a game keeps only its newest key
  for (const f of await readdir(dir).catch(() => [] as string[])) if (!f.startsWith(rec.key + ".") && /\.(json|png)$/.test(f)) await rm(join(dir, f), { force: true }).catch(() => {});
}

export async function readRecord(id: number, key: string): Promise<CardRecord | null> {
  try { const r = JSON.parse(await Bun.file(join(gameDir(id), `${key}.json`)).text()) as CardRecord; return r.v === RECIPE_VERSION ? r : null; } catch { return null; }
}

/** the newest record a game has on disk (whatever its key) */
export async function newestRecord(id: number): Promise<CardRecord | null> {
  const dir = gameDir(id);
  let best: { f: string; t: number } | null = null;
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (!f.endsWith(".json")) continue;
    const s = await stat(join(dir, f)).catch(() => null);
    if (s && (!best || s.mtimeMs > best.t)) best = { f, t: s.mtimeMs };
  }
  return best ? readRecord(id, best.f.slice(0, -5)) : null;
}

export const absolute = (rel: string) => join(cardsRoot(), rel);

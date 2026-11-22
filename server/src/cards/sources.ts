/**
 * Cards — the art a game's card is made from, by rule:
 *   poster   the library poster (gameImage(id, "poster"): ludarr resolves it from every source it knows)
 *   key art  the hero chain the spotlight uses (art.ts): Steam's library hero for the game's app (logo-free by
 *            Steam's own rules, so trusted), else ludarr's banner (read for lettering like a poster). Portrait art,
 *            or the poster itself, is no key art.
 *   logo     Steam's logo PNG for the app (art.ts steamLogo), when there is one; the recipe's box is the logo's
 *            opaque pixels at alpha >= 16 (the template match crops it; the spotlight's meta box is a different rule).
 * Each image is copied into the card cache under the hash of its bytes, so a card never draws from a file that changed
 * under it, and new art makes a new card.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { gameImage, steamHeroImage, steamLogo, type CachedImage } from "../art";
import type { LudarrGame } from "../ludarr";
import { atomicWrite, sha1, srcDir } from "./store";
import type { LogoBox } from "./lettering";

export interface SourceRef { file: string; hash: string; w: number; h: number; type: string }
export interface Inputs { poster: SourceRef | null; keyArt: (SourceRef & { trusted: boolean }) | null; logo: (SourceRef & { box: LogoBox }) | null }

/** where each image comes from (tests point these at fixture files) */
export const sourceDeps = {
  poster: (g: LudarrGame): Promise<CachedImage | null> => gameImage(g.id, "poster"),
  /** the Steam library hero (trusted), else ludarr's banner */
  keyArt: async (g: LudarrGame): Promise<(CachedImage & { trusted: boolean }) | null> => {
    const hero = g.steamAppId ? await steamHeroImage(g.steamAppId).catch(() => null) : null;
    if (hero) return { ...hero, trusted: true };
    const b = await gameImage(g.id, "banner");
    return b ? { ...b, trusted: false } : null;
  },
  logo: async (g: LudarrGame): Promise<CachedImage | null> => (g.steamAppId ? steamLogo(g.steamAppId) : null),
};

const RASTER = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif" };

/** an image copied into the card cache under the hash of its bytes */
export async function adopt(img: CachedImage | null): Promise<SourceRef | null> {
  if (!img || !RASTER.has(img.type)) return null;
  try {
    const bytes = await Bun.file(img.path).bytes();
    const hash = sha1(bytes);
    const file = join(srcDir(), `${hash}.${EXT[img.type]}`);
    if (!(await Bun.file(file).exists())) { await mkdir(srcDir(), { recursive: true }); await atomicWrite(file, bytes); }
    const m = await sharp(file).metadata();
    if (!m.width || !m.height) return null;
    return { file, hash, w: m.width, h: m.height, type: img.type };
  } catch { return null; }
}

/** the box of a logo's opaque pixels (alpha >= 16); null for an empty logo */
export async function logoBox(file: string): Promise<LogoBox | null> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (data[(y * info.width + x) * 4 + 3] >= 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export async function posterOf(g: LudarrGame): Promise<SourceRef | null> {
  return adopt(await sourceDeps.poster(g).catch(() => null));
}
export async function keyArtOf(g: LudarrGame, poster: SourceRef | null): Promise<Inputs["keyArt"]> {
  const k = await sourceDeps.keyArt(g).catch(() => null);
  const ref = await adopt(k);
  if (!ref || !k || ref.h >= ref.w || (poster && ref.hash === poster.hash)) return null;
  return { ...ref, trusted: k.trusted };
}
export async function logoOf(g: LudarrGame): Promise<Inputs["logo"]> {
  const ref = await adopt(await sourceDeps.logo(g).catch(() => null));
  if (!ref) return null;
  const box = await logoBox(ref.file).catch(() => null);
  return box ? { ...ref, box } : null;
}

/** Spotlight — files to pixels (sharp): an image as 8-bit sRGB RGBA, as a browser's canvas reads it. */
import sharp from "sharp";
import type { Rgba } from "./pixels";

export async function decodeRgba(file: string | Uint8Array): Promise<Rgba> {
  const { data, info } = await sharp(file, { failOn: "none", autoOrient: true }).toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`expected RGBA, got ${info.channels} channels`);
  return { w: info.width, h: info.height, d: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

/** the hero placeholder the art route serves when a game has no key art (art.ts placeholderSvg "hero": #1c1c1c to #101010 down
 *  1920 x 620), as pixels, so the rule can still decide the identity and the scrim over it */
export function placeholderHero(): Rgba {
  const w = 1920, h = 620, d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = Math.round(28 + (16 - 28) * ((y + 0.5) / h));
    for (let x = 0; x < w; x++) { const p = (y * w + x) * 4; d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255; }
  }
  return { w, h, d };
}

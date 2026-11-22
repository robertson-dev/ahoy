/**
 * Cards — the cut-out image: the subject's traced outline (trimmed, holes decided, eroded, as the recipe traces it)
 * filled into an alpha channel (antialiased, even-odd, like a CSS clip-path), applied to the untouched source pixels,
 * cropped to the outline's box and scaled to what the largest layout needs at 2x.
 */
import sharp from "sharp";
import * as MK from "./mask";

const r1 = (v: number) => Math.round(v * 100) / 100;

export interface Cutout { png: Buffer; w: number; h: number; crop: { x0: number; y0: number; x1: number; y1: number }; scale: number }

/** rings: closed outlines in source px (pixel-centre coordinates); scale: output px per source px (<= 1) */
export async function renderCutout(file: string, W: number, H: number, rings: MK.Ring[], scale: number): Promise<Cutout> {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (!Number.isFinite(minX)) throw new Error("cut-out without an outline");
  // edges: pixel (i, j) covers [i, i+1] x [j, j+1]; the outline's points sit on pixel centres (+0.5)
  const x0 = Math.max(0, Math.floor(minX + 0.5) - 1), y0 = Math.max(0, Math.floor(minY + 0.5) - 1);
  const x1 = Math.min(W, Math.ceil(maxX + 0.5) + 1), y1 = Math.min(H, Math.ceil(maxY + 0.5) + 1);
  const cw = x1 - x0, ch = y1 - y0;
  const k = Math.min(1, scale, 2048 / Math.max(cw, ch));
  const w = Math.max(1, Math.round(cw * k)), h = Math.max(1, Math.round(ch * k));
  const eps = 0.35 / k;                                     // the outline simplified to about a third of an output pixel
  const parts: string[] = [];
  for (const ring of rings) {
    const simp = MK.rdpRing(ring, eps);
    if (simp.length < 3) continue;
    parts.push("M" + simp.map(([x, y]) => `${r1(x + 0.5)} ${r1(y + 0.5)}`).join("L") + "Z");
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x0} ${y0} ${cw} ${ch}" preserveAspectRatio="none"><path fill="#fff" fill-rule="evenodd" d="${parts.join("")}"/></svg>`;
  const alpha = await sharp(Buffer.from(svg)).ensureAlpha().extractChannel(3).raw().toBuffer();
  const rgb = await sharp(file).removeAlpha().toColourspace("srgb").extract({ left: x0, top: y0, width: cw, height: ch }).resize(w, h, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
  const png = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).joinChannel(alpha, { raw: { width: w, height: h, channels: 1 } }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  return { png, w, h, crop: { x0, y0, x1, y1 }, scale: k };
}

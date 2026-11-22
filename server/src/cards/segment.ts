/**
 * Cards — background removal with BiRefNet-general (ONNX) via onnxruntime-node, in the card worker only. The image is
 * resized to 1024 x 1024 (squashed, as the model was trained), normalised, run through the model, sigmoid (BiRefNet
 * emits logits), min-max normalised and resized back: an 8-bit soft mask (255 = subject), cached by the image's hash.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { atomicWrite } from "./store-io";

const S = 1024, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
type Ort = typeof import("onnxruntime-node");
let ort: Ort | null = null;
let session: { path: string; s: import("onnxruntime-node").InferenceSession } | null = null;

async function sessionFor(model: string) {
  if (session && session.path === model) return session.s;
  ort ??= await import("onnxruntime-node");
  // no CPU memory arena: with it a BiRefNet run peaks at ~12 GB working set (17 GB private), without it at ~6 GB; the
  // masks are byte-identical
  const s = await ort.InferenceSession.create(model, { executionProviders: ["cpu"], graphOptimizationLevel: "all", enableCpuMemArena: false });
  session = { path: model, s };
  return s;
}

/** the soft mask of `file` (W x H), from the cache or the model */
export async function maskFor(model: string, file: string, hash: string, W: number, H: number, dir: string): Promise<Uint8Array> {
  const cached = join(dir, `${hash}.png`);
  if (existsSync(cached)) {
    const { data, info } = await sharp(cached).greyscale().raw().toBuffer({ resolveWithObject: true });
    if (info.width === W && info.height === H) return new Uint8Array(data);
  }
  const s = await sessionFor(model);
  const { data } = await sharp(file).removeAlpha().toColourspace("srgb").resize(S, S, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
  const t = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) t[c * S * S + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  const out = await s.run({ [s.inputNames[0]]: new ort!.Tensor("float32", t, [1, 3, S, S]) });
  const pred = out[s.outputNames[0]].data as Float32Array;
  let mn = Infinity, mx = -Infinity;
  const p = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) { const v = 1 / (1 + Math.exp(-pred[i])); p[i] = v; if (v < mn) mn = v; if (v > mx) mx = v; }
  const g = Buffer.alloc(S * S), span = mx - mn || 1;
  for (let i = 0; i < S * S; i++) g[i] = Math.round(((p[i] - mn) / span) * 255);
  const png = await sharp(g, { raw: { width: S, height: S, channels: 1 } }).resize(W, H, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
  await mkdir(dir, { recursive: true });
  await atomicWrite(cached, png);
  const { data: m } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  return new Uint8Array(m);
}

export const modelLoaded = () => !!session;

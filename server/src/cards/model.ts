/**
 * Cards — the segmentation model (BiRefNet-general, ONNX, 973 MB) that cuts subjects out of the art.
 *   AHOY_CARD_MODEL   a path to the .onnx file: used as it is, never downloaded
 *   otherwise         <config>/models/BiRefNet-general-epoch_244.onnx, downloaded once in the background from the
 *                     rembg release: resumable (a .part file continued with a Range request), checked by size, logged
 *   CARD_CUTOUTS=off  no cut-outs: the model is neither used nor downloaded (every card is a dissolve)
 *   CARD_STYLE=boxart the cards are the games' box art (poster.ts): no cut-out, no dissolve, no model
 *   CARD_STYLE=cover  the recipe's card with the box art in place of the cut-out, as an object (poster.ts): no model
 *   CARD_STYLE=fade   the recipe's card with the box art in place of the cut-out, melting into the colour: no model
 * AHOY_WORKERS=0 (tests, tools) holds the download too. While the model is missing, cards use the dissolve.
 */
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../config";
import { logger } from "../log";

const log = logger("Cards");
export const MODEL_FILE = "BiRefNet-general-epoch_244.onnx";
export const MODEL_URL = `https://github.com/danielgatis/rembg/releases/download/v0.0.0/${MODEL_FILE}`;
export const MODEL_BYTES = 972_666_916;

export type ModelState = "off" | "ready" | "missing" | "downloading" | "failed";

/** what the cards are: the recipe's card with the box art where the cut-out stood (fade, the default since 2026-11-09: the poster
 *  melting into the colour; cover: the poster as an object); the recipe's own (CARD_STYLE=recipe: a cut-out or a dissolve of the
 *  key art, made with the cut-out model); or the box art itself (boxart) */
export type CardStyle = "recipe" | "boxart" | "cover" | "fade";
const STYLES: readonly CardStyle[] = ["recipe", "boxart", "cover", "fade"];
export const cardStyle = (): CardStyle => STYLES.find(s => s === (process.env.CARD_STYLE ?? "").trim().toLowerCase()) ?? "fade";
/** a style made from the poster alone (and the game's logo, to read the poster's lettering): no key art, no jobs, no model */
export const posterOnly = (s: CardStyle = cardStyle()) => s !== "recipe";
export const cutoutsOn = () => cardStyle() === "recipe" && (process.env.CARD_CUTOUTS ?? "").toLowerCase() !== "off";
export const modelPath = () => process.env.AHOY_CARD_MODEL || join(configDir(), "models", MODEL_FILE);
const managed = () => !process.env.AHOY_CARD_MODEL;

/** how the download runs (tests replace it); resolves when `part` holds the whole file */
export const modelDeps = {
  allowDownload: () => process.env.AHOY_WORKERS !== "0",
  download: downloadResumable,
  url: MODEL_URL,
  bytes: MODEL_BYTES,
  now: () => Date.now(),
};

let downloading: Promise<void> | null = null;
let failedAt = 0, failures = 0, fatal = false, warnedMissing = false;
const readyListeners = new Set<() => void>();
export const onModelReady = (fn: () => void) => { readyListeners.add(fn); return () => readyListeners.delete(fn); };

export function modelState(): ModelState {
  if (!cutoutsOn()) return "off";
  if (existsSync(modelPath())) return "ready";
  if (downloading) return "downloading";
  if (fatal || (failedAt && managed())) return "failed";
  return "missing";
}

/** start the download when the model is missing and may be fetched; harmless to call often */
export function ensureModel(): ModelState {
  const s = modelState();
  if (s === "ready" || s === "off" || s === "downloading") return s;
  if (!managed()) {
    if (!warnedMissing) { warnedMissing = true; log.warn(`AHOY_CARD_MODEL points at ${modelPath()}, which does not exist: cards use the dissolve`); }
    return s;
  }
  if (fatal || !modelDeps.allowDownload()) return s;
  // after a failure, wait 30 s, 2 min, 10 min, then every 30 min
  const backoff = [30_000, 120_000, 600_000, 1_800_000][Math.min(failures - 1, 3)] ?? 0;
  if (failedAt && modelDeps.now() - failedAt < backoff) return s;
  const final = modelPath(), part = final + ".part";
  downloading = (async () => {
    try {
      await mkdir(join(configDir(), "models"), { recursive: true });
      const have = await stat(part).then(x => x.size, () => 0);
      const total = modelDeps.bytes;
      log.info(have ? `continuing the card model download at ${(have / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB` : `downloading the card model (${(total / 1e6).toFixed(0)} MB) from ${modelDeps.url}`);
      await modelDeps.download(modelDeps.url, part, total);
      const size = statSync(part).size;
      if (size !== total) { await rm(part, { force: true }); throw new Error(`the downloaded model is ${size} bytes, expected ${total}`); }
      await rename(part, final);
      failures = 0; failedAt = 0;
      log.info(`card model ready (${final})`);
      for (const fn of readyListeners) { try { fn(); } catch { /* a listener never breaks the download */ } }
    } catch (e: any) {
      failures++; failedAt = modelDeps.now();
      if (e?.fatal) fatal = true;
      log.warn(`card model download: ${e?.message ?? e}${fatal ? " (not retried)" : ""}`);
    } finally { downloading = null; }
  })();
  return "downloading";
}

/** GET url into `part`, continuing what is there (Range); logs progress every 10 %; aborts when stalled for a minute */
export async function downloadResumable(url: string, part: string, total: number): Promise<void> {
  let have = await stat(part).then(x => x.size, () => 0);
  if (have > total) { await rm(part, { force: true }); have = 0; }
  if (have === total) return;
  const ac = new AbortController();
  let stall: ReturnType<typeof setTimeout> = setTimeout(() => ac.abort(), 60_000);
  const kick = () => { clearTimeout(stall); stall = setTimeout(() => ac.abort(), 60_000); };
  try {
    const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: "follow", signal: ac.signal });
    if (res.status === 416) { await rm(part, { force: true }); throw new Error("the server refused to continue the download; starting over next time"); }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const resumed = res.status === 206;
    const announced = resumed ? Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? NaN) : Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(announced) && announced !== total) throw Object.assign(new Error(`the release offers ${announced} bytes, expected ${total}`), { fatal: true });
    if (!resumed) have = 0;
    const out = createWriteStream(part, { flags: resumed ? "a" : "w" });
    let got = have, nextLog = Math.floor((got / total) * 10) + 1;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        kick();
        if (!out.write(value)) await new Promise<void>(r => out.once("drain", () => r()));
        got += value.byteLength;
        if (got / total * 10 >= nextLog) { log.info(`card model ${Math.floor(got / total * 100)} %`); nextLog = Math.floor((got / total) * 10) + 1; }
      }
    } finally { await new Promise<void>(r => out.end(() => r())); }
  } finally { clearTimeout(stall); }
}

/** for tests: forget failures and backoff */
export const _modelTest = { reset() { downloading = null; failedAt = 0; failures = 0; fatal = false; warnedMissing = false; }, pending: () => downloading };

/**
 * Ahoy — how long until a download is on the server ("about 20 min left").
 *
 * ludarr's request carries the release's size (words.ts strips it before members see the game), the request's progress and,
 * in the stage text, the current rate ("downloading · 6.2 MB/s", decimal megabytes). The progress is not a share of the bytes:
 * a request moves over two legs (ludarr src/requests.ts, mirrorFetch), each mapped onto its own stretch of it —
 *   downloading    the download client fetches the release                0.05 → 0.50   "downloading · 6.2 MB/s"
 *   (between)      done there, the transfer is next                       0.50          "finished downloading — transferring next"
 *   transferring   the copy comes over to the server                      0.50 → 0.85   "transferring to ludarr · 12 MB/s"
 * then importing (the player's "Preparing") up to 1, which has no estimate. So what is left is the rest of the current leg and,
 * while downloading, the whole transfer after it. The transfer runs at its own speed: the transfer rate seen lately (a smoothed
 * average, kept across restarts), else the rate the download has now.
 */
import { kv } from "./db";
import type { GameStatus, LudarrGame, RequestView } from "./ludarr";

export const LEGS = { download: { from: 0.05, to: 0.5 }, transfer: { from: 0.5, to: 0.85 } } as const;
export type Leg = "download" | "between" | "transfer";

export const edeps = { now: () => Date.now() };

const UNIT: Record<string, number> = { K: 1e3, M: 1e6, G: 1e9 };
/** the rate a stage names, in bytes a second ("6.2 MB/s" → 6,200,000); null when it names none */
export function rateOf(stage: string | null | undefined): number | null {
  const m = /(\d+(?:\.\d+)?)\s*([KMG])B\/s/i.exec(stage ?? "");
  const v = m ? Number(m[1]) * UNIT[m[2].toUpperCase()] : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}
/** which leg a stage is on; null when it is on neither (queued, importing, looking) */
export function legOf(stage: string | null | undefined): Leg | null {
  const s = (stage ?? "").trim().toLowerCase();
  if (/^finished downloading\b/.test(s)) return "between";
  if (/^transferring\b/.test(s)) return "transfer";
  if (/^downloading\b/.test(s)) return "download";
  return null;
}

/* ─────────── the transfer rate seen lately ─────────── */

const KEY = "eta.transferRate";
const SAVE_EVERY_MS = 60_000;
let transfer = kv.json<{ bps: number; at: number } | null>(KEY, null);
let savedAt = 0;
/** each refresh of the library: every request on its transfer leg says how fast copies come over (smoothed: 0.7 old, 0.3 new) */
export function noteTransfers(games: LudarrGame[]) {
  let changed = false;
  for (const g of games) {
    const r = g.request;
    if (!r || legOf(r.stage) !== "transfer") continue;
    const bps = rateOf(r.stage);
    if (!bps) continue;
    transfer = { bps: transfer ? Math.round(transfer.bps * 0.7 + bps * 0.3) : Math.round(bps), at: edeps.now() };
    changed = true;
  }
  if (changed && transfer && edeps.now() - savedAt >= SAVE_EVERY_MS) { savedAt = edeps.now(); kv.set(KEY, JSON.stringify(transfer)); }
}
export const transferRate = () => transfer?.bps ?? null;

/* ─────────── the estimate ─────────── */

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const shareOf = (p: number, leg: { from: number; to: number }) => clamp01((p - leg.from) / (leg.to - leg.from));
/** at most this far out: beyond it the number says nothing useful */
const MAX_S = 30 * 86_400;

/** seconds until the copy is on the server, at the rates known now; null when it cannot be told (another state, no size, no rate) */
export function etaSeconds(status: GameStatus, r: RequestView | null | undefined): number | null {
  if (!r || status !== "downloading") return null;
  const size = r.release?.size ?? null;
  if (!size || !(size > 0)) return null;
  const leg = legOf(r.stage), rate = rateOf(r.stage), p = Number.isFinite(r.progress) ? r.progress : 0, pull = transferRate();
  let s: number | null = null;
  if (leg === "download" && rate) s = (size * (1 - shareOf(p, LEGS.download))) / rate + size / (pull ?? rate);
  else if (leg === "between" && pull) s = size / pull;
  else if (leg === "transfer" && rate) s = (size * (1 - shareOf(p, LEGS.transfer))) / rate;
  return s != null && Number.isFinite(s) && s <= MAX_S ? Math.max(0, Math.round(s)) : null;
}

/** tests: forget the rate seen (in memory and on disk) */
export const _test = { reset() { transfer = null; savedAt = 0; kv.del(KEY); } };

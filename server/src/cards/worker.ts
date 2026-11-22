/**
 * Cards — the card worker: a child process (bun src/cards/worker.ts) that runs the recipe, so the server never spends
 * its own time on pixels. It takes one job at a time over IPC, writes the cut-out PNG and the masks into the card cache
 * and answers with the card. It keeps the segmentation model loaded between jobs; the server stops it when idle.
 * Nothing here touches the database.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { analyseArt, type ArtInput } from "./recipe";
import { buildCard, type BuiltCard } from "./build";
import { maskFor } from "./segment";
import { atomicWrite } from "./store-io";
import type { LogoBox } from "./lettering";

export interface WorkerJob {
  id: number; gameId: number; key: string; stage: "dissolve" | "final"; title: string;
  poster: { file: string; hash: string } | null;
  keyArt: { file: string; hash: string; trusted: boolean } | null;
  logo: { file: string; box: LogoBox } | null;
  /** the model file (final stage only) */
  model: string | null;
  maskDir: string;
  /** where the cut-out PNG goes */
  cutout: string;
}
export type WorkerCard = Omit<BuiltCard, "image"> & { image: { w: number; h: number; cutout: boolean }; srcFile: string };
export type WorkerReply = { type: "done"; id: number; card: WorkerCard; ms: number } | { type: "error"; id: number; error: string } | { type: "ready" };

async function run(job: WorkerJob): Promise<WorkerCard> {
  const poster: ArtInput | null = job.poster ? { kind: "poster", file: job.poster.file } : null;
  const banner: ArtInput | null = job.keyArt ? { kind: "banner", file: job.keyArt.file, trusted: job.keyArt.trusted } : null;
  const hashOf = (a: ArtInput) => (a.kind === "poster" ? job.poster!.hash : job.keyArt!.hash);
  const mask = job.stage === "final" && job.model ? (a: ArtInput, W: number, H: number) => maskFor(job.model!, a.file, hashOf(a), W, H, job.maskDir) : null;
  const an = await analyseArt({ poster, banner, logo: job.logo, mask });
  const built = await buildCard(an, job.title);
  if (built.image.png) { await mkdir(dirname(job.cutout), { recursive: true }); await atomicWrite(job.cutout, built.image.png); }
  return { ...built, image: { w: built.image.w, h: built.image.h, cutout: !!built.image.png }, srcFile: an.src.file };
}

if (import.meta.main) {
  const send = (m: WorkerReply) => process.send?.(m);
  process.on("message", async (msg: { type: string; job?: WorkerJob }) => {
    if (msg?.type !== "job" || !msg.job) return;
    const t0 = Date.now();
    try { send({ type: "done", id: msg.job.id, card: await run(msg.job), ms: Date.now() - t0 }); }
    catch (e: any) { send({ type: "error", id: msg.job.id, error: String(e?.stack ?? e) }); }
  });
  process.on("disconnect", () => process.exit(0));
  send({ type: "ready" });
}

export { run as runJobInProcess };

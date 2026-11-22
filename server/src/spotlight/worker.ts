/**
 * Spotlight — the worker: a child process (bun src/spotlight/worker.ts) that decides stages, so the server never spends its own
 * time on pixels. One job at a time over IPC: decode the art and the logo, run the rule for one stage width, answer with the
 * layout. It keeps the last subject maps (they depend on the art only, and one art is laid out for several widths) and the last
 * decoded images. Nothing here touches the database.
 */
import { decide } from "./decide";
import { decodeRgba, placeholderHero } from "./decode";
import { NOMINAL_STAGE } from "./layout";
import { layoutOf, type SpotLayout } from "./contract";
import { geometryFor, subjectMap, type SubjectMap } from "./rule";
import { cropRows, type Rgba } from "./pixels";

export interface SpotJob {
  id: number; key: string;
  /** the key art (null: the hero route's blank placeholder) */
  hero: { file: string; hash: string; fromSteam: boolean } | null;
  logo: { file: string; hash: string } | null;
  name: string;
  w: number; bar: number; left: number;
}
export type SpotReply = { type: "done"; id: number; layout: SpotLayout } | { type: "error"; id: number; error: string } | { type: "ready" };

/** a small most-recently-used memo */
function lru<V>(max: number) {
  const m = new Map<string, V>();
  return {
    get(k: string) { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; },
    set(k: string, v: V) { m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value!); },
  };
}
const maps = lru<SubjectMap>(32), images = lru<Rgba>(3);
const PLACEHOLDER = "placeholder";

async function image(file: string, hash: string): Promise<Rgba> {
  let img = images.get(hash);
  if (!img) { img = await decodeRgba(file); images.set(hash, img); }
  return img;
}

export async function runJob(job: SpotJob): Promise<SpotLayout> {
  const hero = job.hero ? await image(job.hero.file, job.hero.hash) : placeholderHero();
  const heroKey = job.hero?.hash ?? PLACEHOLDER, fromSteam = job.hero ? job.hero.fromSteam : true;
  const logo = job.logo ? await image(job.logo.file, job.logo.hash) : null;
  // the subject map belongs to the art's used window, which depends only on the art and where it came from
  const winH = fromSteam ? hero.h : Math.round(hero.h * 0.9), mk = `${heroKey}:${winH}`;
  let map = maps.get(mk);
  if (!map) { map = subjectMap(winH === hero.h ? hero : cropRows(hero, 0, winH)); maps.set(mk, map); }
  const d = decide({ hero, fromSteam, logo, name: job.name, geo: geometryFor(job.w, job.bar, job.left), map, mode: "page", stage: NOMINAL_STAGE });
  return layoutOf(d, { w: hero.w, h: hero.h, fromSteam, placeholder: !job.hero }, logo ? { w: logo.w, h: logo.h } : null, job.w, job.bar, job.left, NOMINAL_STAGE.factsWidth);
}

if (import.meta.main) {
  const send = (m: SpotReply) => process.send?.(m);
  process.on("message", async (msg: { type: string; job?: SpotJob }) => {
    if (msg?.type !== "job" || !msg.job) return;
    try { send({ type: "done", id: msg.job.id, layout: await runJob(msg.job) }); }
    catch (e: any) { send({ type: "error", id: msg.job.id, error: String(e?.stack ?? e) }); }
  });
  process.on("disconnect", () => process.exit(0));
  send({ type: "ready" });
}

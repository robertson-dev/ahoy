/**
 * Ahoy — where games keep their saves (for save sync, saves.ts). A rule is a path with a place of the PC at its start and
 * forward slashes, a folder standing for everything in it:
 *
 *   <base>               the game's install folder
 *   <home>               the Windows profile (C:\Users\<name>)
 *   <winAppData>         AppData\Roaming       <winLocalAppData>   AppData\Local
 *   <winDocuments>       Documents             <winPublic>         C:\Users\Public
 *   <winProgramData>     C:\ProgramData        <osUserName>        the Windows account's name, inside a path
 *
 * with * and ? inside a name and ** for any folders. The launcher resolves the places (launcher/src/saves.ts), and reads and
 * writes nothing outside them.
 *
 * Where the rules come from, for a game with a Steam app id:
 *  - the Ludusavi manifest (github.com/mtkennerly/ludusavi-manifest, MIT; its data is PCGamingWiki's, CC BY-NC-SA 3.0), read
 *    every few days and kept as a small index by app id: the paths it tags as saves that a Windows PC has (not settings
 *    alone, not another system's, not a store client's own folders);
 *  - the folders the stand-ins for Steam's own library keep a game's cloud saves and progress in, by app id (a copy that
 *    does not run through Steam writes there what Steam would keep in its cloud).
 * A game the manifest does not know still has those folders, and any folder its player adds by hand; for it the launcher
 * also takes what the game made inside its own folder since it was installed (`made`: a third of all known save locations
 * are inside the game's folder, so that is where an unknown game's saves most likely are). `made` is decided per game and
 * stays as it is: never for a game the manifest knows (its paths say exactly where), always for a game without a Steam app
 * id, and for an unknown one only once the manifest has been read at all (before that nobody can say which games it knows).
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { kv } from "./db";
import { configDir } from "./config";
import { logger } from "./log";

const log = logger("Saves");

export interface SaveRules {
  /** where the game's saves may be */
  paths: string[];
  /** what is never a save among them */
  exclude: string[];
  /** also the files the game made inside its own folder (a game nobody has paths for) */
  made: boolean;
  appId: number | null;
}

export const MANIFEST_URL = "https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/refs/heads/data/data/manifest.yaml";
const ROOTS = ["base", "home", "winAppData", "winLocalAppData", "winDocuments", "winPublic", "winProgramData"];
/** never a save: pictures of unlocked achievements and screenshots (large, and remade), logs */
export const EXCLUDE = ["**/achievement_images/**", "**/screenshots/**", "**/*.log"];

/**
 * A rule as it is kept, or null when it is none: it starts at one of the places above; no step back up, no empty name, no
 * character Windows refuses; not a whole place (at least one name after the place that is more than wildcards).
 */
export function rulePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p || p.length > 300) return null;
  p = p.replace(/<winLocalAppDataLow>/g, "<home>/AppData/LocalLow").replace(/<storeUserId>/g, "*").replace(/\*{3,}/g, "**");
  const m = /^<([A-Za-z]+)>(?:\/(.*))?$/.exec(p);
  if (!m || !ROOTS.includes(m[1]!)) return null;
  const segs = (m[2] ?? "").split("/");
  if (!m[2] || segs.some(s => !s || /^[. ]+$/.test(s))) return null;
  // <osUserName> may stand inside a name; no other angle bracket, and nothing Windows refuses in a name
  if (segs.some(s => /[<>:"|\u0000-\u001f[\]{}]/.test(s.replace(/<osUserName>/g, "")))) return null;
  if (segs.some(s => s.includes("**") && s !== "**")) return null;
  if (!segs.some(s => /[^*?]/.test(s))) return null;
  return `<${m[1]}>/${segs.join("/")}`;
}

interface WhenEntry { os?: unknown; store?: unknown }
/** does a manifest path apply to a copy on Windows that is the Steam or GOG build (or says nothing of where it applies) */
function applies(when: unknown): boolean {
  if (!Array.isArray(when) || !when.length) return true;
  return (when as WhenEntry[]).some(w => (w?.os == null || w.os === "windows") && (w?.store == null || w.store === "steam" || w.store === "gog"));
}

/**
 * The manifest as an index: Steam app id → the save paths a Windows PC has. An entry that is another's alias is skipped (the
 * other one carries the paths); paths of several titles that share an app id are joined.
 */
export function indexManifest(doc: unknown): Map<number, string[]> {
  const out = new Map<number, Set<string>>();
  if (!doc || typeof doc !== "object") return new Map();
  for (const entry of Object.values(doc as Record<string, unknown>)) {
    const g = entry as { alias?: unknown; steam?: { id?: unknown }; files?: Record<string, { tags?: unknown; when?: unknown } | null> } | null;
    const id = Number(g?.steam?.id);
    if (!g || typeof g !== "object" || g.alias != null || !Number.isSafeInteger(id) || id <= 0 || !g.files || typeof g.files !== "object") continue;
    for (const [path, said] of Object.entries(g.files)) {
      const tags = Array.isArray(said?.tags) ? said!.tags as unknown[] : [];
      if (tags.length && !tags.includes("save")) continue;                  // settings alone do not follow a player around
      if (!applies(said?.when)) continue;
      const p = rulePath(path);
      if (!p) continue;
      (out.get(id) ?? out.set(id, new Set()).get(id)!).add(p);
    }
  }
  return new Map([...out].filter(([, s]) => s.size).map(([id, s]) => [id, [...s].sort()]));
}

/**
 * The folders a copy that does not run through Steam keeps its cloud saves and progress in, for one app id: one per
 * stand-in for Steam's library, as each names its own (their whole folder for the game: saves under remote/, progress
 * beside it), and a folder of that id holding remote/ anywhere inside the game's own folder (kept local by its settings).
 */
export function standInPaths(id: number): string[] {
  return [
    `<winAppData>/Goldberg SteamEmu Saves/${id}`, `<winAppData>/GSE Saves/${id}`,
    `<winPublic>/Documents/Steam/CODEX/${id}`, `<winAppData>/Steam/CODEX/${id}`,
    `<winPublic>/Documents/Steam/RUNE/${id}`, `<winAppData>/Steam/RUNE/${id}`,
    `<winPublic>/Documents/Steam/TENOKE/${id}`, `<winDocuments>/Steam/TENOKE/${id}`,
    `<winPublic>/Documents/OnlineFix/${id}`,
    `<winPublic>/Documents/EMPRESS/${id}`, `<winAppData>/EMPRESS/${id}`, `<winAppData>/EMPRESS/remote/${id}`,
    `<winLocalAppData>/SKIDROW/${id}`, `<winDocuments>/SKIDROW/${id}`, `<winDocuments>/Player/${id}`,
    `<winAppData>/SmartSteamEmu/${id}`, `<winAppData>/SmartSteamEmu/remote_${id}`, `<winAppData>/SmartSteamEmu/*/remote_${id}`,
    `<winProgramData>/Steam/*/${id}`, `<winProgramData>/RLD!/${id}`,
    `<winLocalAppData>/FLT/Steam/${id}`, `<winAppData>/.1911/${id}`, `<winAppData>/RLE/${id}`,
    `<winDocuments>/DARKSiDERS/${id}`, `<winDocuments>/VALVE/${id}`,
    `<base>/**/${id}/remote`,
  ];
}

/* ─────────── the index, kept on disk and in memory ─────────── */

const file = () => join(process.env.AHOY_SAVES_DIR || join(configDir(), "saves"), "rules.json");
let index: Map<number, string[]> | null = null;
async function load(): Promise<Map<number, string[]>> {
  if (index) return index;
  try {
    const j = await Bun.file(file()).json() as { games?: Record<string, string[]> };
    index = new Map(Object.entries(j.games ?? {}).map(([id, paths]) => [Number(id), paths.map(rulePath).filter((p): p is string => !!p)]));
  } catch { index = new Map(); }
  return index;
}
/** the rules for a game: by its Steam app id when it has one, and whatever folders its player added (`extra`) */
export async function rulesFor(appId: number | null, extra: readonly string[] = []): Promise<SaveRules & { known: boolean }> {
  const all = await load();
  const known = appId != null ? all.get(appId) ?? null : null;
  const paths = [...new Set([...(known ?? []), ...(appId != null ? standInPaths(appId) : []), ...extra.map(rulePath).filter((p): p is string => !!p)])];
  return { paths, exclude: EXCLUDE, made: appId == null ? true : !known && all.size > 0, appId, known: !!known };
}

export const sdeps = { fetch: ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch };
/** read the manifest again when it changed (its ETag says so); the index is replaced only by one that parsed and holds games */
export async function saveRulesTick(): Promise<{ games: number; changed: boolean }> {
  const etag = kv.get("saves.rules.etag");
  const have = (await load()).size;
  const res = await sdeps.fetch(MANIFEST_URL, { headers: etag && have ? { "if-none-match": etag } : {}, signal: AbortSignal.timeout(120_000) });
  if (res.status === 304) return { games: have, changed: false };
  if (!res.ok) throw new Error(`the save locations did not load (HTTP ${res.status})`);
  const next = indexManifest(Bun.YAML.parse(await res.text()));
  if (next.size < 1000 && have > next.size) throw new Error(`the save locations came back with ${next.size} games; kept the ${have} from before`);
  await mkdir(join(file(), ".."), { recursive: true });
  await Bun.write(file(), JSON.stringify({ at: Date.now(), games: Object.fromEntries(next) }));
  index = next;
  const tag = res.headers.get("etag");
  if (tag) kv.set("saves.rules.etag", tag); else kv.del("saves.rules.etag");
  log.info(`save locations for ${next.size} games`);
  return { games: next.size, changed: true };
}
export const _test = { set(m: Map<number, string[]> | null) { index = m; } };

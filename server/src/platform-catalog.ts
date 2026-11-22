import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ludarr from "./ludarr";
import { plainId } from "./ids";

const indexPath = () => join(process.env.AHOY_CONFIG || ".", "platform-games.db");
const week = 7 * 86400_000;
let opened: Database | null = null;
let refreshing: Promise<void> | null = null;
let lastAttempt = 0;

/** Publish a complete replacement atomically. Readers use the previous edition during refresh. */
async function catalog(): Promise<Database> {
  const path = indexPath();
  if (!opened && existsSync(path)) opened = new Database(path, { readonly: true });
  if (!refreshing && Date.now() - lastAttempt > 60_000 && (!opened || Date.now() - statSync(path).mtimeMs > week)) {
    lastAttempt = Date.now();
    refreshing = (async () => {
      const script = fileURLToPath(new URL("./platform-index.py", import.meta.url));
      const proc = Bun.spawn(["python3", script, path], { stderr: "inherit", stdout: "ignore" });
      if (await proc.exited !== 0) throw Error("Platform catalog refresh failed");
      const fresh = new Database(path, { readonly: true });
      opened?.close();
      opened = fresh;
    })().finally(() => { refreshing = null; });
    refreshing.catch(e => console.warn("[Discover]", e.message));
  }
  if (!opened) await refreshing;
  if (!opened) throw Error("Platform catalog unavailable");
  return opened;
}

export const platformDeps = { catalog };
interface Entry { id: number; platform: string; name: string; year: number | null; summary: string; cover: string | null; steam: number | null }
const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const coverUrl = (e: Entry) => e.cover ? `https://images.launchbox-app.com/${e.cover}` : null;

export async function platformChoices() {
  const db = await platformDeps.catalog();
  return db.query("SELECT p.id,p.label,count(*) AS count FROM platforms p JOIN games g ON g.platform=p.id GROUP BY p.id ORDER BY p.label COLLATE NOCASE").all();
}

export async function platformGames(platform: string, query: string, page: number) {
  const db = await platformDeps.catalog();
  const term = fold(query);
  const filters: string[] = [], args: string[] = [];
  if (platform !== "all") { filters.push("g.platform=?"); args.push(platform); }
  if (query) {
    const words = term.split(" ").filter(Boolean);
    if (!words.length) return { items: [], total: 0, pages: 0 };
    filters.push(`EXISTS (SELECT 1 FROM names n WHERE n.game=g.id AND ${words.map(() => "instr(n.text,?)>0").join(" AND ")})`);
    args.push(...words);
  }
  const where = filters.length ? "WHERE " + filters.join(" AND ") : "";
  const exact = term ? "EXISTS (SELECT 1 FROM names n WHERE n.game=g.id AND n.text=?) DESC," : "";
  const { total } = db.query(`SELECT count(*) AS total FROM games g ${where}`).get(...args) as { total: number };
  const limit = 48;
  const rows = db.query(`SELECT g.* FROM games g ${where} ORDER BY ${exact} votes DESC, name, id LIMIT ? OFFSET ?`)
    .all(...args, ...(term ? [term] : []), limit, (page - 1) * limit) as Entry[];
  const library = ludarr.library();
  const items: ludarr.LookupHit[] = rows.map(e => {
    const game = library.find(g => (e.platform === "pc" && e.steam && g.steamAppId === e.steam) ||
      (fold(g.name) === fold(e.name) && (!e.year || !g.releaseYear || e.year === g.releaseYear) &&
        g.platformChoices?.some(p => p.id === e.platform)));
    return { id: { scheme: "launchbox", value: String(e.id) }, source: "launchbox", name: e.name, year: e.year,
      platforms: [e.platform], cover: coverUrl(e), summary: e.summary || null, gameId: game?.id ?? null, status: game?.status ?? null };
  });
  return { items, total, pages: Math.ceil(total / limit) };
}

/** Resolve on the server so a player can only submit the title and platform that belong to this edition. */
export async function platformRequest(id: string, platform?: string) {
  const db = await platformDeps.catalog();
  const e = db.query("SELECT * FROM games WHERE id=?").get(plainId(id)) as Entry | null;
  if (!e || (platform && platform !== e.platform)) throw new ludarr.LudarrError("That edition couldn't be found", 404);
  if (e.platform === "pc" && e.steam) return { source: "steam", id: String(e.steam), platform: e.platform };
  const hits = await ludarr.get<{items: ludarr.LookupHit[]}>(`/api/v1/game/lookup?term=${encodeURIComponent(e.name)}`);
  const match = hits.items.find(h => fold(h.name) === fold(e.name) && (!h.year || !e.year || h.year === e.year) &&
    h.platforms.includes(e.platform) && ["catalog", "steam"].includes(h.id.scheme));
  if (match) return { source: match.id.scheme, id: match.id.value, platform: e.platform };
  return { source: "manual", platform: e.platform, game: { name: e.name, platforms: [e.platform],
    year: e.year && e.year >= 1970 && e.year <= 2100 ? e.year : null, summary: e.summary || null } };
}

/**
 * Ahoy — a person's saves, kept for them: every PC of theirs brings a game's saves here after playing and takes the newest
 * before playing, so progress follows them from PC to PC, and the versions before stay here to go back to.
 *
 * A version is one file as the launcher packs it (launcher/src/saves.ts: the save files, each named by its place on a PC, with
 * a list at the end), kept as it came under <config>/saves/<user>/<game>/<id>.sav; the server does not read into it. What it
 * knows of a version the launcher says beside it: which PC, how many files, how large, and a digest of the files (the same
 * saves give the same digest on every PC: that is how a PC knows whether it has what the server has).
 *
 * It arrives in parts of at most PART_MAX, one request each, in order: a reverse proxy in front of the server lets only so
 * much through in one request (often a megabyte), and saves can be hundreds. The parts are written one after the other
 * into a file beside the versions; the last one makes it a version, when it ends with the launcher's mark.
 *
 * A game is the same game on every PC by its key: a<Steam app id> when it has one, else g<its id on this server>.
 * The newest version of a key is its head. Bringing the head's own digest again adds nothing. The last KEEP versions of a
 * game stay; older ones go when a new one arrives.
 *
 * Saves are one person's own: nobody else lists, reads or replaces them, and their events go to that person only.
 */
import { appendFile, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { db } from "./db";
import { configDir } from "./config";
import { events } from "./events";
import { rulePath } from "./saverules";

export class SaveError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

/** how many versions of a game's saves stay, how large one may be, and how much one person may keep in all */
export const KEEP = 10, MAX_BYTES = 512 * 1024 * 1024, MAX_TOTAL = 10 * 1024 * 1024 * 1024;
/** how much of a version one request brings at most, and how long a version may take to arrive whole */
export const PART_MAX = 1024 * 1024, UPLOAD_MS = 3600_000;
/** how every version ends: the launcher's mark (it is checked, so a page or an upload cut short is not kept as saves) */
const MARK = "AHOYSAV1";

export interface Snap { id: number; key: string; gameId: number | null; name: string | null; device: string | null; digest: string; files: number; bytes: number; size: number; newest: number | null; at: number }
interface Row { id: number; user_id: number; game_key: string; game_id: number | null; name: string | null; device: string | null; digest: string; files: number; bytes: number; size: number; newest: number | null; created_at: number }
const toSnap = (r: Row): Snap => ({ id: r.id, key: r.game_key, gameId: r.game_id, name: r.name, device: r.device, digest: r.digest, files: r.files, bytes: r.bytes, size: r.size, newest: r.newest, at: r.created_at });

export const keyOk = (k: unknown): k is string => typeof k === "string" && /^[ag][0-9]{1,12}$/.test(k);
/** the Steam app id a key names, when it names one */
export const appIdOf = (key: string): number | null => (key[0] === "a" ? Number(key.slice(1)) : null);
const root = () => process.env.AHOY_SAVES_DIR || join(configDir(), "saves");
const dirOf = (userId: number, key: string) => join(root(), String(userId), key);
export const fileOf = (userId: number, key: string, id: number) => join(dirOf(userId, key), `${id}.sav`);

/** a game's versions, newest first */
export const snapsOf = (userId: number, key: string): Snap[] => (db.query("SELECT * FROM saves WHERE user_id=? AND game_key=? ORDER BY id DESC").all(userId, key) as Row[]).map(toSnap);
export const snapOf = (userId: number, key: string, id: number): Snap | null => { const r = db.query("SELECT * FROM saves WHERE id=? AND user_id=? AND game_key=?").get(id, userId, key) as Row | null; return r ? toSnap(r) : null; };
/** every game this person has saves of: its newest version, and how many there are */
export function gamesOf(userId: number): (Snap & { versions: number })[] {
  const rows = db.query("SELECT s.*, n.versions FROM saves s JOIN (SELECT game_key, MAX(id) AS id, COUNT(*) AS versions FROM saves WHERE user_id=? GROUP BY game_key) n ON n.id = s.id ORDER BY s.id DESC").all(userId) as (Row & { versions: number })[];
  return rows.map(r => ({ ...toSnap(r), versions: r.versions }));
}
const totalOf = (userId: number) => (db.query("SELECT COALESCE(SUM(size),0) AS n FROM saves WHERE user_id=?").get(userId) as { n: number }).n;

export interface SnapMeta { digest: string; files: number; bytes: number; newest: number | null; device: string | null; gameId: number | null; name: string | null }
/** what the launcher says of a version it brings, checked; null when it is not that */
export function metaOf(raw: unknown): SnapMeta | null {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const int = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null);
  const files = int(m.files), bytes = int(m.bytes);
  if (typeof m.digest !== "string" || !/^[0-9a-f]{64}$/.test(m.digest) || !files || bytes == null) return null;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) || null : null);
  return { digest: m.digest, files, bytes, newest: int(m.newest), device: text(m.device, 80), gameId: int(m.gameId), name: text(m.name, 200) };
}

/** which part of which upload a request brings: "<upload id>:<index>:<count>" (the id is the launcher's own, per version) */
export interface Part { upload: string; index: number; count: number }
export function partOf(raw: unknown): Part | null {
  const m = /^([a-z0-9]{8,40}):(\d{1,5}):(\d{1,5})$/.exec(typeof raw === "string" ? raw : "");
  if (!m) return null;
  const index = Number(m[2]), count = Number(m[3]);
  return count >= 1 && count <= Math.ceil(MAX_BYTES / 1024) && index < count ? { upload: m[1]!, index, count } : null;
}
/** versions on their way: by person, game and the launcher's id for the upload */
interface Upload { digest: string; next: number; count: number; bytes: number; path: string; at: number }
const uploads = new Map<string, Upload>();
const drop = async (id: string) => { const u = uploads.get(id); uploads.delete(id); if (u) await rm(u.path, { force: true }).catch(() => {}); };

/**
 * A PC brings one part of a game's saves. The first part of saves the head already is (the same digest) is answered with
 * the head, and nothing is kept twice. Parts come in order; each is written after the one before. The last one makes the
 * version: the whole must end with the launcher's mark, and it becomes the head; versions past the last KEEP go.
 */
export async function keepPart(userId: number, key: string, meta: SnapMeta, part: Part, body: Uint8Array): Promise<{ item: Snap; same: boolean } | { next: number }> {
  if (!keyOk(key)) throw new SaveError("no such game", 404);
  if (!body.byteLength || body.byteLength > PART_MAX) throw new SaveError(body.byteLength ? "that part is too large" : "no saves came", body.byteLength ? 413 : 400);
  const id = `${userId}/${key}/${part.upload}`;
  for (const [k, u] of uploads) if (Date.now() - u.at > UPLOAD_MS) await drop(k);
  let up = uploads.get(id);
  if (part.index === 0) {
    const head = snapsOf(userId, key)[0];
    if (head && head.digest === meta.digest) return { item: head, same: true };
    if (totalOf(userId) + body.byteLength > MAX_TOTAL) throw new SaveError("no room for more saves", 413);
    if (up) await drop(id);
    const dir = dirOf(userId, key);
    await mkdir(dir, { recursive: true });
    up = { digest: meta.digest, next: 0, count: part.count, bytes: 0, path: join(dir, `in-${part.upload}.part`), at: Date.now() };
    await rm(up.path, { force: true });
    uploads.set(id, up);
  }
  // a part out of turn (one was lost, the server restarted in between): the launcher starts the version again
  if (!up || up.next !== part.index || up.count !== part.count || up.digest !== meta.digest) { await drop(id); throw new SaveError("these saves did not arrive in order: send them again", 409); }
  if (up.bytes + body.byteLength > MAX_BYTES) { await drop(id); throw new SaveError("these saves are too large to keep", 413); }
  await appendFile(up.path, body);
  up.bytes += body.byteLength; up.next++; up.at = Date.now();
  if (up.next < up.count) return { next: up.next };
  // the last part: a version, when it is one
  uploads.delete(id);
  try {
    if (up.bytes <= MARK.length) throw new SaveError("no saves came");
    if (totalOf(userId) + up.bytes > MAX_TOTAL) throw new SaveError("no room for more saves", 413);
    const end = await open(up.path, "r");
    try {
      const b = Buffer.alloc(MARK.length);
      await end.read(b, 0, b.length, up.bytes - b.length);
      if (b.toString("latin1") !== MARK) throw new SaveError("that is not a set of saves");
    } finally { await end.close(); }
    const row = db.query("INSERT INTO saves (user_id, game_key, game_id, name, device, digest, files, bytes, size, newest) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *")
      .get(userId, key, meta.gameId, meta.name, meta.device, meta.digest, meta.files, meta.bytes, up.bytes, meta.newest) as Row;
    try { await rename(up.path, fileOf(userId, key, row.id)); }
    catch (e) { db.query("DELETE FROM saves WHERE id=?").run(row.id); throw e; }
    await prune(userId, key);
    events.emit("save", { key, id: row.id, device: meta.device }, userId);
    return { item: toSnap(row), same: false };
  } finally { await rm(up.path, { force: true }).catch(() => {}); }
}
async function prune(userId: number, key: string) {
  const old = (db.query("SELECT id FROM saves WHERE user_id=? AND game_key=? ORDER BY id DESC LIMIT -1 OFFSET ?").all(userId, key, KEEP) as { id: number }[]).map(r => r.id);
  for (const id of old) { db.query("DELETE FROM saves WHERE id=?").run(id); await rm(fileOf(userId, key, id), { force: true }).catch(() => {}); }
}
/** a version's file, when it is this person's and on disk */
export async function fileFor(userId: number, key: string, id: number): Promise<{ path: string; size: number } | null> {
  if (!keyOk(key) || !snapOf(userId, key, id)) return null;
  const path = fileOf(userId, key, id);
  const s = await stat(path).catch(() => null);
  return s?.isFile() ? { path, size: s.size } : null;
}

/* ─────────── folders added by hand ─────────── */

export function extraPaths(userId: number, key: string): string[] {
  const r = db.query("SELECT paths_json FROM save_paths WHERE user_id=? AND game_key=?").get(userId, key) as { paths_json: string } | null;
  try { return (JSON.parse(r?.paths_json ?? "[]") as unknown[]).map(rulePath).filter((p): p is string => !!p); } catch { return []; }
}
/** the folders this person says the game keeps its saves in (at most 8, each a rule as saverules.ts takes one) */
export function setExtraPaths(userId: number, key: string, raw: unknown): string[] {
  if (!keyOk(key)) throw new SaveError("no such game", 404);
  if (!Array.isArray(raw) || raw.length > 8) throw new SaveError("a short list of folders is needed");
  const paths: string[] = [];
  for (const x of raw) { const p = rulePath(x); if (!p) throw new SaveError("that folder cannot hold saves Ahoy keeps"); if (!paths.includes(p)) paths.push(p); }
  db.query("INSERT INTO save_paths (user_id, game_key, paths_json, updated_at) VALUES (?,?,?,unixepoch()) ON CONFLICT(user_id, game_key) DO UPDATE SET paths_json=excluded.paths_json, updated_at=unixepoch()").run(userId, key, JSON.stringify(paths));
  events.emit("save", { key }, userId);
  return paths;
}

/** files under <config>/saves that no version names any more (an account that was removed, an upload that never finished) */
export async function sweepSaves(): Promise<number> {
  let gone = 0;
  const arriving = new Set([...uploads.values()].map(u => u.path));
  for (const user of await readdir(root()).catch(() => [] as string[])) {
    if (!/^\d+$/.test(user)) continue;
    for (const key of await readdir(join(root(), user)).catch(() => [] as string[])) {
      if (!keyOk(key)) continue;
      const dir = join(root(), user, key);
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        const m = /^(\d+)\.sav$/.exec(name);
        const live = (m ? !!db.query("SELECT 1 FROM saves WHERE id=? AND user_id=? AND game_key=?").get(Number(m[1]), Number(user), key) : false) || arriving.has(join(dir, name));
        // a write under way is younger than an hour
        const s = live ? null : await stat(join(dir, name)).catch(() => null);
        if (!live && s && Date.now() - s.mtimeMs > UPLOAD_MS) { await rm(join(dir, name), { force: true }).catch(() => {}); gone++; }
      }
    }
  }
  return gone;
}

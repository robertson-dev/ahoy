/**
 * Ahoy — a person's PCs, and what is to be installed on them.
 *
 * A PC is known from the moment its launcher shows this server's page signed in (it says its name, its version and how much
 * room it has). An order is "install this game on that PC": placed from anywhere (a phone, the couch, another PC), kept
 * here, and carried out by the page running in that PC's launcher once the PC is on and the game has a copy. An order for a
 * game that is still on its way waits for it.
 *
 * Asking for a game places orders by itself (`wanted`): on the PC it was asked from, when that PC's setting says it installs
 * what its person asks for (`auto`, on by default); asked from anywhere that is no PC (a phone, a browser), on every PC of
 * theirs that says so. Only for a game the server has no copy of yet: Install is the action for one that has.
 *
 * Everything here is one person's own: nobody else reads or changes it, and its events go to that person only.
 */
import { db } from "./db";
import { events } from "./events";
import type { UserRow } from "./auth";

export class PcError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

/** a PC counts as on while its launcher said "I'm here" this recently (it says so every 45 s) */
const ON_WINDOW_S = 120;
/** how long a finished order stays listed (so whoever placed it sees how it ended), and a failed one */
const DONE_KEEP_S = 86_400, FAILED_KEEP_S = 7 * 86_400;

export interface Pc { device: string; version: string | null; auto: boolean; freeBytes: number | null; seenAt: number | null; on: boolean; games: number }
export type OrderState = "waiting" | "installing" | "done" | "failed";
export interface Order {
  id: number; device: string; gameId: number; name: string | null; origin: "asked" | "wanted"; state: OrderState;
  /** 0..1 while it installs */
  progress: number; error: string | null; from: string | null; createdAt: number; updatedAt: number;
}
interface PcRow { user_id: number; device: string; version: string | null; auto: number; free_bytes: number | null; seen_at: number | null; created_at: number }
interface OrderRow { id: number; user_id: number; device: string; game_id: number; name: string | null; origin: string; state: string; progress: number; error: string | null; from_device: string | null; created_at: number; updated_at: number }

const now = () => Math.floor(Date.now() / 1000);
/** a PC's name as it is kept: trimmed, at most 80 characters; null when it is none */
export function deviceName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return s || null;
}

const q = {
  pc: db.query("SELECT * FROM pcs WHERE user_id=? AND device=?"),
  pcs: db.query("SELECT * FROM pcs WHERE user_id=? ORDER BY seen_at DESC, device"),
  upsert: db.query(`INSERT INTO pcs (user_id, device, version, free_bytes, seen_at) VALUES (?,?,?,?,unixepoch())
    ON CONFLICT(user_id, device) DO UPDATE SET version=COALESCE(excluded.version, version), free_bytes=COALESCE(excluded.free_bytes, free_bytes), seen_at=unixepoch()`),
  touch: db.query("UPDATE pcs SET seen_at=unixepoch() WHERE user_id=? AND device=?"),
  games: db.query("SELECT device, COUNT(*) AS n FROM installs WHERE user_id=? GROUP BY device"),
  has: db.query("SELECT 1 FROM installs WHERE user_id=? AND device=? AND game_id=? LIMIT 1"),
  order: db.query("SELECT * FROM orders WHERE id=? AND user_id=?"),
  open: db.query("SELECT * FROM orders WHERE user_id=? AND device=? AND game_id=? AND state IN ('waiting','installing')"),
  place: db.query("INSERT INTO orders (user_id, device, game_id, name, origin, from_device) VALUES (?,?,?,?,?,?) RETURNING *"),
  orders: db.query("SELECT * FROM orders WHERE user_id=? ORDER BY id DESC"),
};

const toPc = (r: PcRow, games: Map<string, number>, at = now()): Pc => ({
  device: r.device, version: r.version, auto: !!r.auto, freeBytes: r.free_bytes, seenAt: r.seen_at, on: r.seen_at != null && at - r.seen_at < ON_WINDOW_S, games: games.get(r.device) ?? 0,
});
const toOrder = (r: OrderRow): Order => ({
  id: r.id, device: r.device, gameId: r.game_id, name: r.name, origin: r.origin === "wanted" ? "wanted" : "asked",
  state: (["waiting", "installing", "done", "failed"].includes(r.state) ? r.state : "waiting") as OrderState,
  progress: Math.min(1, Math.max(0, Number(r.progress) || 0)), error: r.error, from: r.from_device, createdAt: r.created_at, updatedAt: r.updated_at,
});
const gamesPer = (userId: number) => new Map((q.games.all(userId) as { device: string; n: number }[]).map(r => [r.device, r.n]));

/* ─────────────────────── PCs ─────────────────────── */

/** the launcher's page on a PC says it is there: its version, and the room left where its games go */
export function registerPc(user: UserRow, device: string, facts: { version?: string | null; freeBytes?: number | null } = {}): Pc {
  const fresh = !q.pc.get(user.id, device);
  const free = Number.isFinite(facts.freeBytes) && (facts.freeBytes as number) >= 0 ? Math.floor(facts.freeBytes as number) : null;
  q.upsert.run(user.id, device, typeof facts.version === "string" ? facts.version.slice(0, 40) : null, free);
  if (fresh) events.emit("pc", { device }, user.id);
  return pcOf(user.id, device)!;
}
/** "I'm here" from a PC this person has: it stays on. A name that is no PC of theirs (a browser) changes nothing */
export const touchPc = (userId: number, device: string | null) => { if (device) q.touch.run(userId, device); };
export const pcOf = (userId: number, device: string): Pc | null => { const r = q.pc.get(userId, device) as PcRow | null; return r ? toPc(r, gamesPer(userId)) : null; };
export function pcsOf(userId: number): Pc[] {
  const games = gamesPer(userId), at = now();
  return (q.pcs.all(userId) as PcRow[]).map(r => toPc(r, games, at));
}
export function setAuto(userId: number, device: string, auto: boolean): Pc {
  if (!q.pc.get(userId, device)) throw new PcError("no such PC", 404);
  db.query("UPDATE pcs SET auto=? WHERE user_id=? AND device=?").run(auto ? 1 : 0, userId, device);
  // it no longer installs what is asked for: what waited for that reason alone no longer waits
  if (!auto) db.query("DELETE FROM orders WHERE user_id=? AND device=? AND origin='wanted' AND state='waiting'").run(userId, device);
  events.emit("pc", { device }, userId);
  if (!auto) events.emit("order", { device }, userId);
  return pcOf(userId, device)!;
}
/** a PC this person no longer has: gone with what was said to be on it and what was to be installed there */
export function forgetPc(userId: number, device: string) {
  db.transaction(() => {
    db.query("DELETE FROM pcs WHERE user_id=? AND device=?").run(userId, device);
    db.query("DELETE FROM installs WHERE user_id=? AND device=?").run(userId, device);
    db.query("DELETE FROM orders WHERE user_id=? AND device=?").run(userId, device);
  })();
  events.emit("pc", { device }, userId);
  events.emit("order", { device }, userId);
  events.emit("install", { userId, device, count: 0 });
}

/* ─────────────────────── orders ─────────────────────── */

function prune(userId: number) {
  db.query("DELETE FROM orders WHERE user_id=? AND ((state='done' AND updated_at < ?) OR (state='failed' AND updated_at < ?))").run(userId, now() - DONE_KEEP_S, now() - FAILED_KEEP_S);
}
/** this person's orders, newest first: those open, and those that ended lately; `device`: one PC's only */
export function ordersOf(userId: number, device?: string | null): Order[] {
  prune(userId);
  const rows = q.orders.all(userId) as OrderRow[];
  return (device ? rows.filter(r => r.device === device) : rows).map(toOrder);
}
/**
 * Install this game on that PC. Placing it again while it is open changes nothing (the same order is the answer); placing it
 * after it ended starts afresh (that is "Try again"). The PC must be one of this person's.
 */
export function placeOrder(user: UserRow, device: string, game: { id: number; name: string | null }, o: { origin?: "asked" | "wanted"; from?: string | null } = {}): Order {
  if (!q.pc.get(user.id, device)) throw new PcError("no such PC", 404);
  const open = q.open.get(user.id, device, game.id) as OrderRow | null;
  if (open) {
    // asked for by hand now: it no longer goes away with the wish that placed it
    if (o.origin !== "wanted" && open.origin === "wanted") { db.query("UPDATE orders SET origin='asked' WHERE id=?").run(open.id); open.origin = "asked"; }
    return toOrder(open);
  }
  db.query("DELETE FROM orders WHERE user_id=? AND device=? AND game_id=?").run(user.id, device, game.id);
  const row = q.place.get(user.id, device, game.id, game.name, o.origin ?? "asked", o.from ?? null) as OrderRow;
  events.emit("order", { id: row.id, device, gameId: game.id, state: row.state }, user.id);
  return toOrder(row);
}
export function cancelOrder(userId: number, id: number): boolean {
  const r = q.order.get(id, userId) as OrderRow | null;
  if (!r) return false;
  db.query("DELETE FROM orders WHERE id=?").run(id);
  events.emit("order", { id, device: r.device, gameId: r.game_id, state: "cancelled" }, userId);
  return true;
}
/**
 * The PC that carries an order out says how it goes: installing (with how far), done, or failed and why; waiting again when
 * it was stopped there before it finished. Only that PC says so (`device`), and nothing is said about one that ended.
 */
export function reportOrder(userId: number, id: number, device: string | null, said: { state?: unknown; progress?: unknown; error?: unknown }): Order {
  const r = q.order.get(id, userId) as OrderRow | null;
  if (!r) throw new PcError("no such order", 404);
  if (r.device !== device) throw new PcError("that order is another PC's", 403);
  if (r.state === "done" || r.state === "failed") return toOrder(r);
  const state = said.state === "installing" || said.state === "done" || said.state === "failed" || said.state === "waiting" ? said.state : r.state;
  const p = Number(said.progress);
  const progress = state === "done" ? 1 : state === "waiting" ? 0 : Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : r.progress;
  const error = state === "failed" ? String(said.error ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300) || null : null;
  db.query("UPDATE orders SET state=?, progress=?, error=?, updated_at=unixepoch() WHERE id=?").run(state, progress, error, id);
  const out = toOrder(q.order.get(id, userId) as OrderRow);
  events.emit("order", { id, device: r.device, gameId: r.game_id, state: out.state, progress: out.progress }, userId);
  return out;
}

/**
 * A game was asked for (Request, or looking again for one without a copy): the PCs that install what their person asks for
 * get an order each. Asked from one of their PCs: that PC, when its setting says so. Asked from anywhere else: every PC of
 * theirs whose setting says so. Never a PC that has the game already.
 */
export function ordersForWant(user: UserRow, game: { id: number; name: string | null; hasFile: boolean }, from: string | null): Order[] {
  if (game.hasFile) return [];
  const mine = q.pcs.all(user.id) as PcRow[];
  const here = from ? mine.find(p => p.device === from) : undefined;
  const targets = (here ? [here] : mine).filter(p => !!p.auto && !q.has.get(user.id, p.device, game.id));
  return targets.map(p => placeOrder(user, p.device, game, { origin: "wanted", from: here?.device ?? null }));
}
/** this person no longer wants the game (they cancelled its search): what waited because they asked for it no longer does.
 *  An order placed by hand (Install on a PC) is its own wish and stays. `userId` null: everyone's (an admin ended the search) */
export function dropWantedOrders(userId: number | null, gameId: number) {
  const rows = (userId == null ? db.query("SELECT * FROM orders WHERE game_id=? AND origin='wanted' AND state='waiting'").all(gameId)
    : db.query("SELECT * FROM orders WHERE game_id=? AND user_id=? AND origin='wanted' AND state='waiting'").all(gameId, userId)) as OrderRow[];
  for (const r of rows) { db.query("DELETE FROM orders WHERE id=?").run(r.id); events.emit("order", { id: r.id, device: r.device, gameId, state: "cancelled" }, r.user_id); }
}
/** the game left the server: nothing of it can be installed any more */
export function dropOrdersOfGame(gameId: number) {
  const rows = db.query("SELECT * FROM orders WHERE game_id=? AND state IN ('waiting','installing')").all(gameId) as OrderRow[];
  db.query("DELETE FROM orders WHERE game_id=?").run(gameId);
  for (const r of rows) events.emit("order", { id: r.id, device: r.device, gameId, state: "cancelled" }, r.user_id);
}
/** open orders for games the server no longer has (one removed in the engine itself): `have` is every game it has now */
export function dropOrphanOrders(have: Set<number>) {
  const ids = (db.query("SELECT DISTINCT game_id FROM orders WHERE state IN ('waiting','installing')").all() as { game_id: number }[]).map(r => r.game_id);
  for (const id of ids) if (!have.has(id)) dropOrdersOfGame(id);
}

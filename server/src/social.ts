/**
 * Ahoy — the people side: friends, the activity feed, presence (what everyone is doing right now), and what each
 * person has installed or asked for. ludarr knows games; this knows who.
 */
import { db, kv } from "./db";
import { events } from "./events";
import { userById, userRef, type UserRef, type UserRow } from "./auth";

export class SocialError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

/* ─────────────────────── friends ─────────────────────── */

export type FriendState = "none" | "pending_out" | "pending_in" | "friends";
const q = {
  edge: db.query("SELECT * FROM friends WHERE user_id=? AND friend_id=?"),
  insert: db.query("INSERT OR IGNORE INTO friends (user_id, friend_id, state) VALUES (?,?,'pending')"),
  accept: db.query("UPDATE friends SET state='accepted', accepted_at=unixepoch() WHERE user_id=? AND friend_id=? AND state='pending'"),
  drop: db.query("DELETE FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)"),
  of: db.query("SELECT * FROM friends WHERE user_id=? OR friend_id=?"),
};
interface Edge { user_id: number; friend_id: number; state: string; created_at: number; accepted_at: number | null }

export function friendState(me: number, other: number): FriendState {
  if (me === other) return "none";
  const out = q.edge.get(me, other) as Edge | undefined;
  const inn = q.edge.get(other, me) as Edge | undefined;
  if (out?.state === "accepted" || inn?.state === "accepted") return "friends";
  if (out) return "pending_out";
  if (inn) return "pending_in";
  return "none";
}
/** ids of accepted friends */
export function friendIds(me: number): number[] {
  return (q.of.all(me, me) as Edge[]).filter(e => e.state === "accepted").map(e => (e.user_id === me ? e.friend_id : e.user_id));
}
export function friendsOf(me: number): { friends: UserRef[]; incoming: UserRef[]; outgoing: UserRef[] } {
  const friends: UserRef[] = [], incoming: UserRef[] = [], outgoing: UserRef[] = [];
  for (const e of q.of.all(me, me) as Edge[]) {
    const other = userById(e.user_id === me ? e.friend_id : e.user_id);
    if (!other) continue;
    if (e.state === "accepted") friends.push(userRef(other));
    else if (e.user_id === me) outgoing.push(userRef(other));
    else incoming.push(userRef(other));
  }
  return { friends, incoming, outgoing };
}
/** ask, or accept when the other side already asked */
export function addFriend(me: UserRow, otherId: number): FriendState {
  if (me.id === otherId) throw new SocialError("that is you");
  const other = userById(otherId);
  if (!other) throw new SocialError("no such user", 404);
  const state = friendState(me.id, otherId);
  if (state === "friends") return state;
  if (state === "pending_in") { q.accept.run(otherId, me.id); record(me.id, "friends", { name: other.display_name, data: { userId: other.id, userName: other.name } }); record(other.id, "friends", { name: me.display_name, data: { userId: me.id, userName: me.name } }); events.emit("friend", { a: me.id, b: otherId, state: "friends" }); return "friends"; }
  if (state === "pending_out") return state;
  q.insert.run(me.id, otherId);
  events.emit("friend", { a: me.id, b: otherId, state: "pending" });
  return "pending_out";
}
export function removeFriend(me: number, otherId: number) {
  q.drop.run(me, otherId, otherId, me);
  events.emit("friend", { a: me, b: otherId, state: "none" });
}

/* ─────────────────────── activity ─────────────────────── */

export type ActivityKind = "joined" | "requested" | "tracked" | "installed" | "played" | "friends" | "arrived";
export interface ActivityItem { id: number; user: UserRef; kind: ActivityKind; gameId: number | null; appId: number | null; name: string | null; data: Record<string, unknown> | null; at: number }
interface ActRow { id: number; user_id: number; kind: ActivityKind; game_id: number | null; app_id: number | null; name: string | null; data_json: string | null; created_at: number }

const a = {
  insert: db.query("INSERT INTO activity (user_id, kind, game_id, app_id, name, data_json) VALUES (?,?,?,?,?,?) RETURNING *"),
  recentSame: db.query("SELECT id FROM activity WHERE user_id=? AND kind=? AND COALESCE(game_id,-1)=COALESCE(?,-1) AND created_at > unixepoch() - ? LIMIT 1"),
};

/** add a line to the feed; a repeat of the same thing within `dedupeSec` is dropped (a game played twice tonight is one line) */
export function record(userId: number, kind: ActivityKind, opt: { gameId?: number | null; appId?: number | null; name?: string | null; data?: Record<string, unknown>; dedupeSec?: number } = {}): ActivityItem | null {
  const dedupe = opt.dedupeSec ?? (kind === "played" ? 6 * 3600 : 60);
  if (a.recentSame.get(userId, kind, opt.gameId ?? null, dedupe)) return null;
  const row = a.insert.get(userId, kind, opt.gameId ?? null, opt.appId ?? null, opt.name ?? null, opt.data ? JSON.stringify(opt.data) : null) as ActRow;
  const item = toItem(row);
  if (item) events.emit("activity", item);
  return item;
}
function toItem(r: ActRow): ActivityItem | null {
  const u = userById(r.user_id);
  if (!u) return null;
  let data: Record<string, unknown> | null = null; try { data = r.data_json ? JSON.parse(r.data_json) : null; } catch { /* ignore */ }
  return { id: r.id, user: userRef(u), kind: r.kind, gameId: r.game_id, appId: r.app_id, name: r.name, data, at: r.created_at };
}
/** the feed for one person: their own lines and their friends', newest first */
export function feed(me: number, opt: { limit?: number; before?: number; only?: "friends" | "mine" | "all" } = {}): ActivityItem[] {
  const ids = opt.only === "mine" ? [me] : opt.only === "all" ? null : [me, ...friendIds(me)];
  const where = [ids ? `user_id IN (${ids.map(() => "?").join(",")})` : "1", opt.before ? "id < ?" : "1"];
  const args: number[] = [...(ids ?? []), ...(opt.before ? [opt.before] : [])];
  const rows = db.query(`SELECT * FROM activity WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(200, opt.limit ?? 40)) as ActRow[];
  return rows.map(toItem).filter((x): x is ActivityItem => !!x);
}
export function activityOfGame(gameId: number, limit = 20): ActivityItem[] {
  return (db.query("SELECT * FROM activity WHERE game_id=? ORDER BY id DESC LIMIT ?").all(gameId, limit) as ActRow[]).map(toItem).filter((x): x is ActivityItem => !!x);
}

/* ─────────────────────── presence ─────────────────────── */

export interface Presence { user: UserRef; state: "online" | "playing" | "offline"; gameId: number | null; appId: number | null; gameName: string | null; since: number | null; device: string | null; lastSeen: number | null }
interface PresRow { user_id: number; state: string; game_id: number | null; app_id: number | null; game_name: string | null; slug: string | null; since: number | null; device: string | null; updated_at: number }
const ONLINE_WINDOW = 120;      // the launcher pings every 45 s

const p = {
  get: db.query("SELECT * FROM presence WHERE user_id=?"),
  upsert: db.query(`INSERT INTO presence (user_id, state, game_id, app_id, game_name, slug, since, device, updated_at) VALUES (?,?,?,?,?,?,?,?,unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, game_id=excluded.game_id, app_id=excluded.app_id, game_name=excluded.game_name, slug=excluded.slug, since=excluded.since, device=excluded.device, updated_at=unixepoch()`),
  ping: db.query("UPDATE presence SET updated_at=unixepoch(), device=COALESCE(?, device) WHERE user_id=?"),
  all: db.query("SELECT * FROM presence"),
};

export function presenceOf(userId: number, now = Math.floor(Date.now() / 1000)): Presence {
  const u = userById(userId)!;
  const r = p.get.get(userId) as PresRow | undefined;
  const online = !!r && now - r.updated_at < ONLINE_WINDOW;
  return { user: userRef(u), state: !online ? "offline" : r!.state === "playing" ? "playing" : "online", gameId: online ? r!.game_id : null, appId: online ? r!.app_id : null, gameName: online ? r!.game_name : null, since: online ? r!.since : null, device: online ? r!.device : null, lastSeen: r ? r.updated_at : u.last_seen_at };
}
/** "I'm here" — every launcher/browser tab says so now and then; also carries what is running */
export function heartbeat(userId: number, device: string | null) {
  const r = p.get.get(userId) as PresRow | undefined;
  if (!r) p.upsert.run(userId, "online", null, null, null, null, null, device);
  else p.ping.run(device, userId);
}
/** a game started or stopped on this person's PC */
export function setPlaying(user: UserRow, opt: { running: boolean; gameId?: number | null; appId?: number | null; name?: string | null; slug?: string | null; device?: string | null }) {
  if (opt.running) {
    p.upsert.run(user.id, "playing", opt.gameId ?? null, opt.appId ?? null, opt.name ?? null, opt.slug ?? null, Math.floor(Date.now() / 1000), opt.device ?? null);
    record(user.id, "played", { gameId: opt.gameId, appId: opt.appId, name: opt.name });
  } else {
    const r = p.get.get(user.id) as PresRow | undefined;
    if (r?.state === "playing" && r.since && opt.device && r.slug) {
      const secs = Math.max(0, Math.floor(Date.now() / 1000) - r.since);
      db.query("UPDATE installs SET last_played_at=unixepoch(), play_seconds=play_seconds+? WHERE user_id=? AND device=? AND slug=?").run(secs, user.id, opt.device, r.slug);
    }
    p.upsert.run(user.id, "online", null, null, null, null, null, opt.device ?? null);
  }
  events.emit("presence", presenceOf(user.id));
}
export function everyone(now = Math.floor(Date.now() / 1000)): Presence[] {
  return (db.query("SELECT id FROM users").all() as { id: number }[]).map(u => presenceOf(u.id, now));
}

/* ─────────────────────── installs and wants ─────────────────────── */

export interface InstallRow { user_id: number; device: string; slug: string; game_id: number | null; package_id: number | null; app_id: number | null; name: string; size: number | null; installed_at: number | null; last_played_at: number | null; play_seconds: number; updated_at: number }
const i = {
  upsert: db.query(`INSERT INTO installs (user_id, device, slug, game_id, package_id, app_id, name, size, installed_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,unixepoch())
    ON CONFLICT(user_id, device, slug) DO UPDATE SET game_id=excluded.game_id, package_id=excluded.package_id, app_id=excluded.app_id, name=excluded.name, size=excluded.size, installed_at=excluded.installed_at, updated_at=unixepoch()`),
  dropMissing: db.query("DELETE FROM installs WHERE user_id=? AND device=? AND slug NOT IN (SELECT value FROM json_each(?))"),
  ofUser: db.query("SELECT * FROM installs WHERE user_id=? ORDER BY last_played_at DESC, installed_at DESC"),
  ofGame: db.query("SELECT * FROM installs WHERE game_id=?"),
  all: db.query("SELECT * FROM installs"),
};

/** the launcher's whole list for one PC; what it no longer lists is gone from that PC */
/** an install is news (a feed line) only while it is recent: the launcher reports a new copy the moment it is saved, so a list
 *  sent again later (a page that had lost the rows, a renamed PC) brings the rows back but no "installed" lines for old copies
 *  (four such lines appeared when the redesigned page first loaded, 2026-11-07) */
const INSTALL_NEWS_S = 3600;
export function syncInstalls(user: UserRow, device: string, list: { slug: string; gameId: number | null; packageId: number; appId?: number | null; name: string; sizeBytes: number; installedAt: number }[]) {
  const before = new Set((db.query("SELECT slug FROM installs WHERE user_id=? AND device=?").all(user.id, device) as { slug: string }[]).map(r => r.slug));
  db.transaction(() => {
    for (const g of list) i.upsert.run(user.id, device, g.slug, g.gameId, g.packageId, g.appId ?? null, g.name, g.sizeBytes, Math.floor(g.installedAt / 1000));
    i.dropMissing.run(user.id, device, JSON.stringify(list.map(g => g.slug)));
  })();
  const now = Date.now() / 1000;
  const recent = (g: { installedAt: number }) => !(g.installedAt > 0) || now - g.installedAt / 1000 < INSTALL_NEWS_S;
  for (const g of list) if (!before.has(g.slug) && recent(g)) record(user.id, "installed", { gameId: g.gameId, appId: g.appId, name: g.name, data: { device } });
  events.emit("install", { userId: user.id, device, count: list.length });
}
export const installsOf = (userId: number) => i.ofUser.all(userId) as InstallRow[];
/** who has this game on a PC */
export function ownersOf(gameId: number): UserRef[] {
  const seen = new Set<number>(); const out: UserRef[] = [];
  for (const r of i.ofGame.all(gameId) as InstallRow[]) { if (seen.has(r.user_id)) continue; seen.add(r.user_id); const u = userById(r.user_id); if (u) out.push(userRef(u)); }
  return out;
}
/** a map gameId → owners, for decorating the whole library in one go */
export function ownersMap(): Map<number, UserRef[]> {
  const out = new Map<number, UserRef[]>();
  const users = new Map<number, UserRef>();
  for (const r of i.all.all() as InstallRow[]) {
    if (r.game_id == null) continue;
    let u = users.get(r.user_id); if (!u) { const row = userById(r.user_id); if (!row) continue; u = userRef(row); users.set(r.user_id, u); }
    const list = out.get(r.game_id) ?? []; if (!list.some(x => x.id === u!.id)) list.push(u); out.set(r.game_id, list);
  }
  return out;
}

export function want(user: UserRow, gameId: number, kind: "get" | "track" | "watch", name: string | null, appId: number | null) {
  db.query("INSERT INTO wants (user_id, game_id, kind) VALUES (?,?,?) ON CONFLICT(user_id, game_id) DO UPDATE SET kind=excluded.kind, created_at=unixepoch()").run(user.id, gameId, kind);
  record(user.id, kind === "get" ? "requested" : "tracked", { gameId, appId, name });
}
export function wantsMap(): Map<number, { user: UserRef; kind: string; at: number }[]> {
  const out = new Map<number, { user: UserRef; kind: string; at: number }[]>();
  for (const r of db.query("SELECT * FROM wants ORDER BY created_at").all() as { user_id: number; game_id: number; kind: string; created_at: number }[]) {
    const u = userById(r.user_id); if (!u) continue;
    const list = out.get(r.game_id) ?? []; list.push({ user: userRef(u), kind: r.kind, at: r.created_at }); out.set(r.game_id, list);
  }
  return out;
}
export const dropWants = (gameId: number) => db.query("DELETE FROM wants WHERE game_id=?").run(gameId);

/* ─────────── whose game, whose search ───────────
 * A want is anyone's for the asking, so it cannot decide who may remove a game or cancel a search. These are written once:
 * who brought the game to the server (it was not there before they asked), and who started each search for a copy. */

/** the game was new to the server when this person asked for it; the first one stays */
export const noteAsked = (userId: number, gameId: number) => db.query("INSERT OR IGNORE INTO asked (game_id, user_id) VALUES (?,?)").run(gameId, userId);
/** who brought the game to the server; null for a game the admin added in the engine (or whose asker left) */
export const askerOf = (gameId: number): number | null => (db.query("SELECT user_id FROM asked WHERE game_id=?").get(gameId) as { user_id: number } | null)?.user_id ?? null;
/** this person's action started that search */
export const noteStarted = (userId: number, gameId: number, requestId: number) => db.query("INSERT OR IGNORE INTO request_starts (request_id, game_id, user_id) VALUES (?,?,?)").run(requestId, gameId, userId);
/** this person's action set a search going again that had stopped (the engine keeps its number): theirs now, unless someone
 *  else's action already did so since it stopped (`stoppedAt`: when the engine last touched it before this) */
export const noteRestarted = (userId: number, gameId: number, requestId: number, stoppedAt: number) =>
  db.query(`INSERT INTO request_starts (request_id, game_id, user_id) VALUES (?,?,?)
    ON CONFLICT(request_id) DO UPDATE SET user_id=excluded.user_id, game_id=excluded.game_id, created_at=unixepoch() WHERE request_starts.created_at < ?`).run(requestId, gameId, userId, Math.floor(seconds(stoppedAt)));
export const starterOf = (requestId: number): number | null => (db.query("SELECT user_id FROM request_starts WHERE request_id=?").get(requestId) as { user_id: number } | null)?.user_id ?? null;
/** the game is gone: so is whose it was */
export const dropAsked = (gameId: number) => { db.query("DELETE FROM asked WHERE game_id=?").run(gameId); db.query("DELETE FROM request_starts WHERE game_id=?").run(gameId); };
/** does anyone but this person want the game? */
export const othersWant = (userId: number, gameId: number) => (db.query("SELECT COUNT(*) AS n FROM wants WHERE game_id=? AND user_id<>?").get(gameId, userId) as { n: number }).n > 0;
/** a game counts as new to the server, and so as brought by whoever asks for it, for this long after the engine added it */
export const NEW_GAME_S = 600;
/** a time of the engine's in seconds, whichever of seconds or milliseconds it came in */
export const seconds = (at: number | null | undefined) => { const n = Number(at ?? 0); return n > 1e11 ? n / 1000 : n; };
/**
 * Once, for a server that ran before `asked` existed. The feed has a "requested" or "tracked" line for every want there ever
 * was, also for a game the admin had added long before (Track, Watch and looking again wrote one too), so a line says who
 * brought a game only by when it was written: the first such line about the game since it came to the server, written
 * within the NEW_GAME_S that make a game new when someone asks today, by someone who still wants it. `games`: the library as
 * the server last read it (the snapshot it keeps). Every other game stays the admin's.
 */
export function backfillAsked(games: { id: number; addedAt: number }[] = kv.json("ludarr.games", [])) {
  if (kv.get("asked.backfilled")) return;
  const first = db.query("SELECT user_id, created_at FROM activity WHERE game_id=? AND kind IN ('requested','tracked') AND created_at > ? ORDER BY id LIMIT 1");
  const wants = db.query("SELECT 1 FROM wants WHERE game_id=? AND user_id=?");
  const give = db.query("INSERT OR IGNORE INTO asked (game_id, user_id, created_at) VALUES (?,?,?)");
  db.transaction(() => {
    for (const g of Array.isArray(games) ? games : []) {
      const added = seconds(g?.addedAt);
      if (!Number.isSafeInteger(g?.id) || !(added > 0)) continue;
      // lines from before the game came are about another game that had its number
      const line = first.get(g.id, added - NEW_GAME_S) as { user_id: number; created_at: number } | null;
      if (line && line.created_at < added + NEW_GAME_S && wants.get(g.id, line.user_id)) give.run(g.id, line.user_id, line.created_at);
    }
    kv.set("asked.backfilled", "1");
  })();
}
backfillAsked();
/** one person stops wanting a game (they untrack it); everyone else's wants stay */
export const dropWant = (userId: number, gameId: number) => db.query("DELETE FROM wants WHERE user_id=? AND game_id=?").run(userId, gameId);
/** how many people still want a game (asked for it, track it or watch it) */
export const wantCount = (gameId: number) => (db.query("SELECT COUNT(*) AS n FROM wants WHERE game_id=?").get(gameId) as { n: number }).n;

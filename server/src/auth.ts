/**
 * Ahoy — accounts. The first person to sign up owns the server (admin); after that the SIGNUP setting decides who
 * may join. A session is a random token: the launcher keeps it, a browser gets it as an httpOnly cookie as well.
 * Passwords are hashed with argon2id (Bun.password); the token is stored hashed too.
 */
import { createHash, randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, kv } from "./db";
import { cfg, configDir } from "./config";
import { events } from "./events";

export interface UserRow { id: number; name: string; display_name: string; pass_hash: string; role: "admin" | "member"; hue: number; bio: string | null; created_at: number; last_seen_at: number | null }
export interface UserRef { id: number; name: string; displayName: string; hue: number; role: "admin" | "member" }
export interface SessionRow { id: number; token_hash: string; user_id: number; device: string | null; created_at: number; last_seen_at: number }

export class AuthError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

const q = {
  byName: db.query("SELECT * FROM users WHERE name=?"),
  byId: db.query("SELECT * FROM users WHERE id=?"),
  count: db.query("SELECT COUNT(*) AS n FROM users"),
  insert: db.query("INSERT INTO users (name, display_name, pass_hash, role, hue) VALUES (?,?,?,?,?) RETURNING *"),
  all: db.query("SELECT * FROM users ORDER BY created_at"),
  seen: db.query("UPDATE users SET last_seen_at=unixepoch() WHERE id=?"),
  session: db.query("SELECT * FROM sessions WHERE token_hash=?"),
  sessionUser: db.query("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND COALESCE(s.last_seen_at, s.created_at, unixepoch()) >= unixepoch() - ?"),
  dropIdle: db.query("DELETE FROM sessions WHERE COALESCE(last_seen_at, created_at, unixepoch()) < unixepoch() - ?"),
  dropOthers: db.query("DELETE FROM sessions WHERE user_id=? AND id<>?"),
  sessionsOf: db.query("SELECT * FROM sessions WHERE user_id=? ORDER BY last_seen_at DESC"),
  insertSession: db.query("INSERT INTO sessions (token_hash, user_id, device) VALUES (?,?,?)"),
  touchSession: db.query("UPDATE sessions SET last_seen_at=unixepoch() WHERE id=? AND last_seen_at < unixepoch() - 60"),
  dropSession: db.query("DELETE FROM sessions WHERE token_hash=?"),
  dropSessionId: db.query("DELETE FROM sessions WHERE id=? AND user_id=?"),
  dropAllSessions: db.query("DELETE FROM sessions WHERE user_id=?"),
  invite: db.query("SELECT * FROM invites WHERE code=? AND used_by IS NULL"),
  useInvite: db.query("UPDATE invites SET used_by=?, used_at=unixepoch() WHERE code=? AND used_by IS NULL"),
  newInvite: db.query("INSERT INTO invites (code, created_by) VALUES (?, ?)"),
  invites: db.query("SELECT i.*, u.name AS used_name FROM invites i LEFT JOIN users u ON u.id=i.used_by ORDER BY i.created_at DESC"),
  dropInvite: db.query("DELETE FROM invites WHERE code=? AND used_by IS NULL"),
};

export const userRef = (u: UserRow): UserRef => ({ id: u.id, name: u.name, displayName: u.display_name, hue: u.hue, role: u.role });
export const userById = (id: number) => q.byId.get(id) as UserRow | undefined;
export const userByName = (name: string) => q.byName.get(name.trim()) as UserRow | undefined;
export const userCount = () => (q.count.get() as { n: number }).n;
export const allUsers = () => q.all.all() as UserRow[];

const NAME = /^[a-z0-9][a-z0-9_-]{1,23}$/i;
export const validName = (s: string) => NAME.test(s);
const hueOf = (name: string) => parseInt(createHash("sha1").update(name.toLowerCase()).digest("hex").slice(0, 4), 16) % 360;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export const signupPolicy = () => (userCount() === 0 ? "first" : (cfg("SIGNUP") as "open" | "invite" | "closed"));

/* ─────────── the setup code: the first account owns the server, so on a reachable server it must be the right person ─────────── */

/** the code the first sign-up must present; made at boot while there are no accounts, written to <config>/setup-code.txt and the log */
export const setupCode = () => kv.get("setup.code");
export const setupCodeFile = () => join(configDir(), "setup-code.txt");
export function ensureSetupCode(): string | null {
  if (userCount() > 0) { clearSetupCode(); return null; }
  let code = kv.get("setup.code");
  if (!code) { code = randomBytes(5).toString("base64url").replace(/[-_]/g, "x").slice(0, 6).toUpperCase(); kv.set("setup.code", code); }
  try { writeFileSync(setupCodeFile(), code + "\n"); } catch { /* the log still has it */ }
  return code;
}
export function clearSetupCode() { kv.del("setup.code"); try { unlinkSync(setupCodeFile()); } catch { /* never written */ } }

/** create an account; the very first one is the admin (and shows the setup code, when the server has one); after that the policy decides */
export async function register(opt: { name: string; password: string; displayName?: string; invite?: string; setup?: string }): Promise<UserRow> {
  const name = opt.name.trim();
  if (!validName(name)) throw new AuthError("a name is 2 to 24 letters, digits, _ or -");
  if (opt.password.length < 6) throw new AuthError("a password needs at least 6 characters");
  if (userByName(name)) throw new AuthError("that name is taken", 409);
  const first = userCount() === 0;
  if (first) {
    const want = setupCode();
    if (want && (opt.setup ?? "").trim().toUpperCase() !== want) throw new AuthError("the setup code is wrong: it is in the server's log and in setup-code.txt next to its database", 403);
  } else {
    const policy = cfg("SIGNUP");
    if (policy === "closed") throw new AuthError("this server does not take new accounts", 403);
    if (policy === "invite") {
      const code = (opt.invite ?? "").trim();
      if (!code || !q.invite.get(code)) throw new AuthError("an invite code from an admin is needed", 403);
    }
  }
  const pass_hash = await hashing(() => Bun.password.hash(opt.password, { algorithm: "argon2id" }));
  // hashing took a while and other sign-ups ran meanwhile: what was checked above is checked again and used in one step, so
  // one invite makes one account and the first account is one account
  const row = db.transaction(() => {
    if (userByName(name)) throw new AuthError("that name is taken", 409);
    const admin = userCount() === 0;
    if (admin !== first) throw new AuthError("someone else signed up just now: try again", 409);
    const policy = admin ? "first" : cfg("SIGNUP");
    if (policy === "closed") throw new AuthError("this server does not take new accounts", 403);
    const made = q.insert.get(name, (opt.displayName ?? "").trim() || name, pass_hash, admin ? "admin" : "member", hueOf(name)) as UserRow;
    if (policy === "invite" && q.useInvite.run(made.id, (opt.invite ?? "").trim()).changes !== 1) throw new AuthError("an invite code from an admin is needed", 403);
    return made;
  })();
  if (first) clearSetupCode();
  events.emit("user", { id: row.id, name: row.name, joined: true });
  return row;
}

/**
 * argon2id is meant to be expensive: a few at a time, a short line behind them, and past that the answer is "busy" rather
 * than a server with every core and its memory spent on strangers' guesses.
 */
export const hashLimit = { running: 4, waiting: 32 };
let hashingNow = 0;
const hashQueue: (() => void)[] = [];
async function hashing<T>(work: () => Promise<T>): Promise<T> {
  if (hashingNow >= hashLimit.running) {
    if (hashQueue.length >= hashLimit.waiting) throw new AuthError("the server is busy, try again in a moment", 503);
    await new Promise<void>(go => hashQueue.push(go));       // whoever finishes hands its place on
  } else hashingNow++;
  try { return await work(); }
  finally { const next = hashQueue.shift(); if (next) next(); else hashingNow--; }
}

export async function login(name: string, password: string): Promise<UserRow> {
  const u = userByName(name);
  if (!u || !(await hashing(() => Bun.password.verify(password, u.pass_hash)))) throw new AuthError("wrong name or password", 401);
  return u;
}

/** a new password; every other session of that person ends (a copied token dies with the old password), `keepSession` stays signed in */
export async function changePassword(userId: number, current: string, next: string, keepSession: number | null = null) {
  const u = userById(userId);
  if (!u) throw new AuthError("no such user", 404);
  if (!(await hashing(() => Bun.password.verify(current, u.pass_hash)))) throw new AuthError("the current password is wrong", 403);   // not 401: the session is fine, and 401 means "signed out" to the web
  if (next.length < 6) throw new AuthError("a password needs at least 6 characters");
  const pass_hash = await hashing(() => Bun.password.hash(next, { algorithm: "argon2id" }));
  db.transaction(() => {
    db.query("UPDATE users SET pass_hash=? WHERE id=?").run(pass_hash, userId);
    q.dropOthers.run(userId, keepSession ?? -1);
  })();
}

export function updateProfile(userId: number, patch: { displayName?: string; bio?: string; hue?: number }) {
  const sets: string[] = []; const args: (string | number)[] = [];
  if (patch.displayName !== undefined) { const d = patch.displayName.trim(); if (!d || d.length > 40) throw new AuthError("a display name is 1 to 40 characters"); sets.push("display_name=?"); args.push(d); }
  if (patch.bio !== undefined) { sets.push("bio=?"); args.push(patch.bio.trim().slice(0, 200)); }
  if (patch.hue !== undefined) { const h = Math.round(Number(patch.hue)); if (!Number.isFinite(h) || h < 0 || h > 359) throw new AuthError("hue is 0 to 359"); sets.push("hue=?"); args.push(h); }
  if (sets.length) db.query(`UPDATE users SET ${sets.join(", ")} WHERE id=?`).run(...args, userId);
  events.emit("user", { id: userId });
  return userById(userId)!;
}

/* ─────────────────────── sessions ─────────────────────── */

export function createSession(userId: number, device: string | null): string {
  const token = randomBytes(32).toString("base64url");
  q.insertSession.run(hash(token), userId, device);
  return token;
}
/** a session ends when it has not been used for this long; each use starts the count again */
export const SESSION_IDLE_DAYS = 90;
const IDLE_S = SESSION_IDLE_DAYS * 86_400;
/** sessions nobody used for SESSION_IDLE_DAYS, removed (a daily task; userForToken refuses them in between) */
export const dropIdleSessions = () => q.dropIdle.run(IDLE_S).changes;
/** the user behind a token, or null; touches last-seen (user and session) at most once a minute */
export function userForToken(token: string | null | undefined): { user: UserRow; session: SessionRow } | null {
  if (!token) return null;
  const s = q.session.get(hash(token)) as SessionRow | undefined;
  if (!s) return null;
  const used = s.last_seen_at ?? s.created_at;
  if (used != null && Math.floor(Date.now() / 1000) - used > IDLE_S) { q.dropSessionId.run(s.id, s.user_id); return null; }
  const u = userById(s.user_id);
  if (!u) return null;
  q.touchSession.run(s.id); q.seen.run(u.id);
  return { user: u, session: s };
}
/** whose session that is, while it lasts: null once it has ended (signed out, a new password, the account removed, left idle).
 *  What stays open on a session (the event stream) asks this before it sends anything more; asking is not using the session */
export const sessionUser = (sessionId: number) => (q.sessionUser.get(sessionId, IDLE_S) as UserRow | null) ?? null;
export const dropSession = (token: string) => q.dropSession.run(hash(token));
export const dropSessionById = (id: number, userId: number) => q.dropSessionId.run(id, userId);
export const dropAllSessions = (userId: number) => q.dropAllSessions.run(userId);
export const sessionsOf = (userId: number) => (q.sessionsOf.all(userId) as SessionRow[]).map(s => ({ id: s.id, device: s.device, createdAt: s.created_at, lastSeenAt: s.last_seen_at }));

/* ─────────────────────── invites and roles (admin) ─────────────────────── */

export function createInvite(by: number): string {
  const code = randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8).toUpperCase();
  q.newInvite.run(code, by);
  return code;
}
export const invites = () => (q.invites.all() as { code: string; created_by: number | null; used_by: number | null; used_name: string | null; created_at: number; used_at: number | null }[])
  .map(i => ({ code: i.code, createdAt: i.created_at, usedBy: i.used_name, usedAt: i.used_at }));
export const dropInvite = (code: string) => q.dropInvite.run(code);

export function setRole(userId: number, role: "admin" | "member", by: number) {
  if (userId === by && role !== "admin") throw new AuthError("you cannot demote yourself");
  const u = userById(userId);
  if (!u) throw new AuthError("no such user", 404);
  db.query("UPDATE users SET role=? WHERE id=?").run(role, userId);
  events.emit("user", { id: userId });
}
export function removeUser(userId: number, by: number) {
  if (userId === by) throw new AuthError("you cannot remove yourself");
  const u = userById(userId);
  if (!u) throw new AuthError("no such user", 404);
  db.query("DELETE FROM users WHERE id=?").run(userId);
  events.emit("user", { id: userId, deleted: true });
}

/**
 * Ahoy API — accounts.
 *
 *   GET    /api/v1/auth/status            { users, policy: first|open|invite|closed, connected, version }   (public)
 *   POST   /api/v1/auth/register          { name, password, displayName?, invite?, device? } → { user, token }  + cookie
 *   POST   /api/v1/auth/login             { name, password, device? } → { user, token }  + cookie
 *   POST   /api/v1/auth/logout
 *   GET    /api/v1/me                      the signed-in user
 *   PUT    /api/v1/me                      { displayName?, bio?, hue? }
 *   PUT    /api/v1/me/password             { current, next }
 *   GET    /api/v1/me/sessions  ·  DELETE /api/v1/me/sessions/:id
 *   admin: GET /api/v1/admin/users · PUT /api/v1/admin/users/:id/role { role } · DELETE /api/v1/admin/users/:id
 *          GET/POST /api/v1/admin/invites · DELETE /api/v1/admin/invites/:code
 *          GET/PUT /api/v1/admin/settings · POST /api/v1/admin/ludarr/probe { url, apiKey } · POST /api/v1/admin/ludarr { url, apiKey }
 *          (the engine's address and key are saved by the last one only, both at once and after trying them; PUT refuses them)
 */
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { AuthError, allUsers, changePassword, createInvite, createSession, dropInvite, dropSession, dropSessionById, invites, login, register, removeUser, sessionsOf, setRole, signupPolicy, updateProfile, userByName, userCount, userRef, type UserRow } from "../auth";
import { SETTINGS, VERSION, cfg, cfgSource, setCfg } from "../config";
import { setLogLevel, type Level } from "../log";
import * as ludarr from "../ludarr";
import { presenceOf, record } from "../social";
import type { Env } from "../server";
import { setupCode } from "../auth";
import { attempt, limiter, limits, tooMany } from "../ratelimit";
import { COOKIE } from "../who";

export const authApi = new Hono<Env>();
const fail = (c: any, e: any) => c.json({ error: String(e?.message ?? e) }, e instanceof AuthError || e instanceof ludarr.LudarrError ? e.status : 500);
/** behind a reverse proxy the request reaches us as http; X-Forwarded-Proto says what the browser used */
const isHttps = (c: any) => (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.slice(0, -1)).split(",")[0].trim() === "https";
const cookieOpts = (c: any) => ({ httpOnly: true, sameSite: "Lax" as const, path: "/", maxAge: 400 * 86_400, secure: isHttps(c) });

// `setup`: the first account must present the setup code the server made at boot (see auth.ensureSetupCode)
authApi.get("/api/v1/auth/status", c => c.json({ users: userCount(), policy: signupPolicy(), setup: userCount() === 0 && !!setupCode(), connected: ludarr.connected(), version: VERSION }));

async function signedIn(c: any, u: UserRow, device: string | undefined) {
  const token = createSession(u.id, device?.slice(0, 80) || c.req.header("user-agent")?.slice(0, 80) || null);
  setCookie(c, COOKIE, token, cookieOpts(c));
  return c.json({ user: userRef(u), token, role: u.role });
}
// the doors that face the internet are rate-limited per address: 8 sign-up tries an hour, 10 failed sign-ins per 10 minutes;
// and per account, whatever the address: 30 failed sign-ins per 10 minutes (guesses spread over many addresses). That count
// is kept for accounts that exist only (as many counts as accounts) and apart from the per-address ones, so no flood of tries
// from elsewhere or for made-up names starts it over
authApi.post("/api/v1/auth/register", limiter("register", 8, 3600_000), async c => {
  const b = await c.req.json().catch(() => ({})) as { name?: string; password?: string; displayName?: string; invite?: string; setup?: string; device?: string };
  try {
    const u = await register({ name: String(b.name ?? ""), password: String(b.password ?? ""), displayName: b.displayName, invite: b.invite, setup: b.setup });
    record(u.id, "joined");
    return await signedIn(c, u, b.device);
  } catch (e) { return fail(c, e); }
});
authApi.post("/api/v1/auth/login", limiter("login", 10, 10 * 60_000, c => c.res.status !== 200), async c => {
  const b = await c.req.json().catch(() => ({})) as { name?: string; password?: string; device?: string };
  const known = limits.enabled ? userByName(String(b.name ?? "")) : undefined;
  const account = known ? attempt(`login-as:${known.id}`, 30, 10 * 60_000, true) : null;
  if (account && !account.ok) return tooMany(c, account.retryAfter);
  try {
    const u = await login(String(b.name ?? ""), String(b.password ?? ""));
    account?.refund();
    return await signedIn(c, u, b.device);
  } catch (e) {
    if (!(e instanceof AuthError && e.status === 401)) account?.refund();        // only a wrong password is a guess
    return fail(c, e);
  }
});
authApi.post("/api/v1/auth/logout", c => {
  const token = c.get("token");
  if (token) dropSession(token);
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

/* ─────────── me ─────────── */

const me = (c: any): UserRow => c.get("user");
// the page asks this first, every time it opens: the cookie is set again, so it lasts as long as the session is used (and a
// launcher that kept only its token has one for the pictures and cards the page asks for without a header)
authApi.get("/api/v1/me", c => {
  const u = me(c), token = c.get("token");
  if (token) setCookie(c, COOKIE, token, cookieOpts(c));
  return c.json({ user: userRef(u), bio: u.bio, createdAt: u.created_at, presence: presenceOf(u.id) });
});
authApi.put("/api/v1/me", async c => {
  const b = await c.req.json().catch(() => ({}));
  try { const u = updateProfile(me(c).id, { displayName: b.displayName, bio: b.bio, hue: b.hue }); return c.json({ user: userRef(u), bio: u.bio }); } catch (e) { return fail(c, e); }
});
authApi.put("/api/v1/me/password", async c => {
  const b = await c.req.json().catch(() => ({}));
  try { await changePassword(me(c).id, String(b.current ?? ""), String(b.next ?? ""), c.get("session")?.id ?? null); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
});
authApi.get("/api/v1/me/sessions", c => c.json({ items: sessionsOf(me(c).id), current: c.get("session")?.id ?? null }));
authApi.delete("/api/v1/me/sessions/:id", c => { dropSessionById(Number(c.req.param("id")), me(c).id); return c.json({ ok: true }); });

/* ─────────── admin ─────────── */

const admin = new Hono<Env>();
admin.use("/api/v1/admin/*", async (c, next) => { if (c.get("user")?.role !== "admin") return c.json({ error: "admins only" }, 403); await next(); });

admin.get("/api/v1/admin/users", c => c.json({ items: allUsers().map(u => ({ ...userRef(u), createdAt: u.created_at, lastSeenAt: u.last_seen_at, presence: presenceOf(u.id).state })) }));
admin.put("/api/v1/admin/users/:id/role", async c => {
  const b = await c.req.json().catch(() => ({}));
  try { setRole(Number(c.req.param("id")), b.role === "admin" ? "admin" : "member", me(c).id); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
});
admin.delete("/api/v1/admin/users/:id", c => { try { removeUser(Number(c.req.param("id")), me(c).id); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });
admin.get("/api/v1/admin/invites", c => c.json({ items: invites() }));
admin.post("/api/v1/admin/invites", c => c.json({ code: createInvite(me(c).id) }, 201));
admin.delete("/api/v1/admin/invites/:code", c => { dropInvite(c.req.param("code")); return c.json({ ok: true }); });

admin.get("/api/v1/admin/settings", c => c.json({ items: SETTINGS.map(k => ({ ...k, value: k.secret ? (cfg(k.key) ? "••••••••" : "") : cfg(k.key), source: cfgSource(k.key) })) }));
/** the engine's address and its key are saved together, by POST /api/v1/admin/ludarr, which tries them first and sends the
 *  saved key to the saved address only. Saved one by one here, a new address alone would be sent the key that is saved */
const ENGINE = ["LUDARR_URL", "LUDARR_API_KEY"];
admin.put("/api/v1/admin/settings", async c => {
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const changes = Object.entries(b).filter(([k, v]) => cfgSource(k) !== "env" && v !== "••••••••").map(([k, v]) => [k, String(v ?? "")] as const);
  if (changes.some(([k]) => ENGINE.includes(k))) return c.json({ error: "the engine's address and key are saved together, with POST /api/v1/admin/ludarr { url, apiKey }" }, 400);
  // a choice must be one of its options; nothing is saved when one is not
  for (const [k, v] of changes) {
    const opts = SETTINGS.find(s => s.key === k)?.options;
    if (opts && !opts.some(o => o.value === v)) return c.json({ error: `${k} takes one of: ${opts.map(o => o.value).join(", ")}` }, 400);
  }
  try {
    for (const [k, v] of changes) {
      setCfg(k, v);
      if (k === "LOG_LEVEL") setLogLevel(v as Level);                             // "applies at once": the running logger follows
    }
    return c.json({ ok: true });
  } catch (e) { return fail(c, e); }
});
/** the key to try at an address: the one typed, else the saved one, and that only at the saved address (the saved key is never
 *  sent anywhere else: an address typed into this form is not yet the engine); null: a key has to be typed */
const sameAddress = (a: string, b: string) => !!b.trim() && a.trim().replace(/\/+$/, "").toLowerCase() === b.trim().replace(/\/+$/, "").toLowerCase();
function engineKey(url: string, typed: string | undefined): string | null {
  if (typed && typed !== "••••••••") return typed.trim();
  return sameAddress(url, cfg("LUDARR_URL")) ? cfg("LUDARR_API_KEY") : null;
}
const KEY_AGAIN = "enter the API key again: the saved one is only used at the saved address";
admin.post("/api/v1/admin/ludarr/probe", async c => {
  const b = await c.req.json().catch(() => ({})) as { url?: string; apiKey?: string };
  const url = String(b.url ?? cfg("LUDARR_URL")), key = engineKey(url, b.apiKey);
  if (key == null) return c.json({ ok: false, detail: KEY_AGAIN });
  return c.json(await ludarr.probe(url, key));
});
admin.post("/api/v1/admin/ludarr", async c => {
  const b = await c.req.json().catch(() => ({})) as { url?: string; apiKey?: string };
  const url = String(b.url ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) return c.json({ error: "the address needs to start with http:// or https://" }, 400);
  const key = engineKey(url, b.apiKey);
  if (key == null) return c.json({ error: KEY_AGAIN }, 400);
  const p = await ludarr.probe(url, key);
  if (!p.ok) return c.json({ error: p.detail }, 400);
  if (cfgSource("LUDARR_URL") !== "env") setCfg("LUDARR_URL", url);
  if (cfgSource("LUDARR_API_KEY") !== "env") setCfg("LUDARR_API_KEY", key);
  await ludarr.refreshLibrary();
  ludarr.followEvents();
  return c.json({ ok: true, detail: p.detail, version: p.version });
});
authApi.route("/", admin);

/**
 * Ahoy — HTTP: the API under /api/v1 behind a user session (Bearer token or the ahoy_session cookie; ?token= on the event
 * stream only, for EventSource), art and the launcher build without one, and the web UI (public/, built from web/) for
 * everything else.
 *
 * Other origins: the web UI and the launcher's window are served from here, so nothing of another origin needs to read the
 * API with someone's session, and nothing is told it may. The launcher's own setup page (a file, no origin) reads the few
 * answers that are for everyone (ANYONE) before it has a server. Nor may another origin change anything with someone's
 * session: a request that is not a GET and rides on the cookie is taken from Ahoy's own page only (otherSite).
 */
import { Hono, type Context, type Next } from "hono";
import { ART_HEADERS } from "./art";
import { serveStatic } from "hono/bun";
import { join } from "node:path";
import { VERSION } from "./config";
import { logger } from "./log";
import { userForToken, type SessionRow, type UserRow } from "./auth";
import { getCookie } from "hono/cookie";
import { COOKIE, mayFetchArt, tokenOf } from "./who";
import { authApi } from "./api/auth";
import { libraryApi } from "./api/library";
import { discoverApi } from "./api/discover";
import { socialApi } from "./api/social";
import { artApi } from "./api/art";
import { cardsApi } from "./api/cards";
import { spotlightApi } from "./api/spotlight";
import { launcherApi, systemApi } from "./api/system";
import { pcsApi } from "./api/pcs";
import { savesApi } from "./api/saves";

export type Env = { Variables: { user: UserRow; session: SessionRow | null; token: string | null } };
const log = logger("Http");
export const app = new Hono<Env>();
const PUBLIC = join(import.meta.dir, "..", "public");

/** what any page may read: no names, no session */
const ANYONE = ["/api/health", "/api/v1/shelf", "/api/v1/auth/status", "/api/v1/launcher"];
app.use("*", async (c, next) => {
  await next();
  if (c.req.header("origin") && c.req.method === "GET" && ANYONE.includes(c.req.path)) c.res.headers.set("access-control-allow-origin", "*");
});
app.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  if (c.req.path.startsWith("/api/") && !c.req.path.endsWith("/events")) log.debug(`${c.req.method} ${c.req.path} → ${c.res.status} in ${Date.now() - t0} ms`);
});

/**
 * Where a request that changes something was sent from, by the browser's own word: null when it is Ahoy's own page (or no page
 * at all), else the other site. Sec-Fetch-Site says it outright wherever browsers send it (https, localhost) and no page can
 * write it; without it, Origin (which browsers put on every POST, PUT and DELETE) against the address this server was asked
 * at, as the request and the reverse proxy name it.
 */
export function otherSite(c: Context): string | null {
  const site = c.req.header("sec-fetch-site"), origin = c.req.header("origin") ?? "";
  if (site) return site === "same-origin" || site === "none" ? null : origin || site;
  if (!origin) return null;
  let from: URL;
  try { from = new URL(origin); } catch { return origin; }                       // "null": a file, a sandboxed frame
  const asked = [new URL(c.req.url).host, c.req.header("host"), ...(c.req.header("x-forwarded-host") ?? "").split(",")];
  const here = asked.some(h => { try { return !!h?.trim() && new URL(`${from.protocol}//${h.trim()}`).host === from.host; } catch { return false; } });
  return here ? null : origin;
}
/* the session cookie goes along with whatever any page of the same domain sends (to a cookie, every subdomain is the same
   site), and a plain POST asks no permission first: so a change that rides on the cookie is taken from Ahoy's own page only.
   A Bearer header is not something another site's page can send, so the launcher and scripts are not asked */
app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.header("authorization")?.startsWith("Bearer ") || !getCookie(c, COOKIE)) return next();
  const from = otherSite(c);
  if (!from) return next();
  log.warn(`refused ${c.req.method} ${c.req.path}: sent from ${from.slice(0, 120)} with a session cookie`);
  return c.json({ error: "this was sent from another site, so nothing was done" }, 403);
});

/* How much a request may bring: a little JSON, or one part of a set of saves (saves.ts PART_MAX, a megabyte). Every body
   is read whole into memory, so it is held to BODY_MAX: by the length it states, and one that states none while sending
   in pieces is refused. */
export const BODY_MAX = 2 * 1024 * 1024;
app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const length = c.req.header("content-length");
  if (length == null ? !!c.req.header("transfer-encoding") : !(Number(length) <= BODY_MAX)) return c.json({ error: "that is too much to send" }, 413);
  return next();
});

app.get("/api/health", c => c.json({ ok: true, version: VERSION, app: "ahoy" }));
/* art: pictures of library games are for everyone (an <img> on the doors has no session yet); what names a game is for members
   and the front page's five (api/cards.ts, api/spotlight.ts, api/art.ts ask who.ts). Art of store apps, of search hits and of
   any address makes the server (and the engine) fetch and keep files, so only a member can ask for it (the page's <img> sends
   the cookie) */
app.use("/api/v1/art/*", async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(ART_HEADERS)) c.res.headers.set(k, v);
});
const membersArt = async (c: Context, next: Next) => (mayFetchArt(c) ? next() : c.json({ error: "sign in first" }, 401));
app.use("/api/v1/art/steam/*", membersArt);
app.use("/api/v1/art/title/*", membersArt);
app.use("/api/v1/art/url", membersArt);
app.route("/", cardsApi);            // the generated Home cards
app.route("/", spotlightApi);        // the spotlight's layout
app.route("/", artApi);
app.route("/", launcherApi);

/* who is asking? */
const OPEN = ["/api/v1/auth/status", "/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/shelf", "/api/v1/client-error"];
app.use("/api/*", async (c, next) => {
  const token = tokenOf(c, c.req.path === "/api/v1/events");
  const who = userForToken(token);
  c.set("token", token); c.set("session", who?.session ?? null);
  if (who) c.set("user", who.user);
  if (!who && !OPEN.includes(c.req.path) && c.req.path !== "/api/v1/auth/logout") return c.json({ error: "sign in first" }, 401);
  await next();
});
app.route("/", authApi);
app.route("/", libraryApi);
app.route("/", discoverApi);
app.route("/", socialApi);
app.route("/", pcsApi);
app.route("/", savesApi);
app.route("/", systemApi);
app.all("/api/*", c => c.json({ error: "no such endpoint" }, 404));

/* the web UI: hashed assets straight from disk, index.html with the runtime injected, SPA fallback */
app.use("/assets/*", serveStatic({ root: "./public" }));
app.use("/favicon.svg", serveStatic({ root: "./public" }));
let page: { at: number; html: string } | null = null;
async function indexHtml(): Promise<string> {
  if (page && Date.now() - page.at < 10_000) return page.html;
  const f = Bun.file(join(PUBLIC, "index.html"));
  const html = (await f.exists()) ? await f.text() : `<!doctype html><html><head><meta charset="utf-8"><title>Ahoy</title></head><body style="font-family:sans-serif;background:#101010;color:#a4a4a4;padding:40px"><h1>Ahoy ${VERSION}</h1><p>The web UI is not built yet (run <code>bun run build:web</code>). The API is up at <code>/api/v1</code>.</p></body></html>`;
  page = { at: Date.now(), html };
  return html;
}
const withRuntime = (html: string) => html.replace("</head>", `<script>window.ahoy=${JSON.stringify({ version: VERSION })}</script></head>`);
app.get("*", async c => c.html(withRuntime(await indexHtml()), 200, { "cache-control": "no-cache, must-revalidate" }));

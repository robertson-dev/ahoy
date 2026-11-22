/**
 * Ahoy — who is asking. A session token comes as a Bearer header (the launcher) or the ahoy_session cookie (a browser);
 * only the event stream also takes it as ?token= (an EventSource cannot send headers), so tokens stay out of every other
 * address a proxy might log.
 *
 * The art routes are mounted before the session check (an <img> on the doors has no session yet): the ones that are not
 * for everyone ask here.
 */
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { userForToken, type UserRow } from "./auth";
import * as ludarr from "./ludarr";

export const COOKIE = "ahoy_session";

export function tokenOf(c: Context, fromQuery = false): string | null {
  const bearer = c.req.header("authorization");
  if (bearer?.startsWith("Bearer ")) return bearer.slice(7).trim() || null;
  return getCookie(c, COOKIE) ?? (fromQuery ? c.req.query("token") ?? null : null);
}
/** the signed-in person behind a request to a route that sits outside the session check, or null */
export const viewer = (c: Context): UserRow | null => userForToken(tokenOf(c))?.user ?? null;

/** the games on the front page (GET /api/v1/shelf): the newest five that are ready. The doors draw these before anyone signs in */
export const shelfIds = (): number[] =>
  ludarr.library().filter(g => g.status === "available").sort((a, b) => (b.file?.addedAt ?? 0) - (a.file?.addedAt ?? 0)).slice(0, 5).map(g => g.id);

/** tests ask for art without signing in all day; they switch this on only to test it */
export const artGate = { enabled: process.env.NODE_ENV !== "test" };
/** may this request read what the server knows about a library game (its card, its stage, its name)? Members, and anyone for a front-page game */
export const maySeeGame = (c: Context, gameId: number): boolean => !artGate.enabled || shelfIds().includes(gameId) || !!viewer(c);
/** may this request make the server fetch and keep art for a store app or an address? Members only */
export const mayFetchArt = (c: Context): boolean => !artGate.enabled || !!viewer(c);

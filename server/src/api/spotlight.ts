/**
 * Ahoy API — the spotlight's layout (contracts/spotlight.md), served without a session like the rest of the art:
 *
 *   GET /api/v1/art/game/:id/spotlight?w=&bar=&x=      a library game's stage: where its key art sits, the scrims' strength,
 *   GET /api/v1/art/steam/:appid/spotlight?w=&bar=&x=&n=   the logo or the title; for a stage w px wide under a bar px top bar
 *                                                      with an x px page margin (defaults: 1440, and the UI's own rules)
 *
 * The JSON is revalidated (ETag, no-cache); a pending answer carries Retry-After.
 */
import { Hono, type Context } from "hono";
import { askedOf, getSpotlight, type Source } from "../spotlight";
import { sha1 } from "../cards/store-io";
import { STEAM_APP_MAX, plainId } from "../ids";
import { maySeeGame } from "../who";

export const spotlightApi = new Hono();

const notModified = (inm: string | undefined, etag: string) => !!inm && inm.split(",").some(t => t.trim().replace(/^W\//, "") === etag);
const num = (v: string | undefined) => (v == null || v === "" ? null : Number(v));

async function answer(c: Context, src: Source) {
  const asked = askedOf(num(c.req.query("w")), num(c.req.query("bar")), num(c.req.query("x")));
  const j = await getSpotlight(src, asked);
  if (!j) return c.json({ error: src.kind === "game" ? "no such game" : "no such app" }, 404);
  const body = JSON.stringify(j), etag = `"${sha1(body).slice(0, 27)}"`;
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache", etag };
  if (j.status === "pending" && j.retryAfter) headers["retry-after"] = String(j.retryAfter);
  if (notModified(c.req.header("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}

// ids in plain digits only ("1e3" or "0x10" is no id: NaN, which answers 404)
// a game's stage names it (its title when it has no logo): for members, and for anyone only for the front page's five (who.ts)
spotlightApi.get("/api/v1/art/game/:id/spotlight", c => {
  const id = plainId(c.req.param("id"));
  if (id && !maySeeGame(c, id)) return c.json({ error: "sign in first" }, 401);
  return answer(c, { kind: "game", id: id ?? NaN });
});
spotlightApi.get("/api/v1/art/steam/:appid/spotlight", c => {
  const n = (c.req.query("n") ?? "").trim().slice(0, 120);
  return answer(c, { kind: "app", id: plainId(c.req.param("appid"), STEAM_APP_MAX) ?? NaN, name: n || null });
});

/**
 * Ahoy API — art, only ever images or small JSON. A library game's pictures are served without a session (the doors and the
 * launcher's setup page show them before anyone signs in); its name on a stand-in, and everything under steam/ and url (which
 * make the server fetch and keep files), are for members: a page's <img> sends the session cookie (server.ts, who.ts).
 *
 *   GET /api/v1/art/game/:id/poster|banner    a library game's art, through ludarr, cached here
 *   GET /api/v1/art/game/:id/hero             its logo-free key art: Steam's library hero, else ludarr's banner, else a blank placeholder
 *   GET /api/v1/art/game/:id/logo             its Steam logo (PNG); 404 when there is none
 *   GET /api/v1/art/game/:id/meta             { hero: { w, h, mean } | null, logo: { w, h, box: { x, y, w, h }, readable } | null }
 *   GET /api/v1/art/steam/:appid/poster       a Steam app's library capsule, else a placeholder (?n=<name>)
 *   GET /api/v1/art/steam/:appid/banner       a Steam app's wide hero, else a placeholder
 *   GET /api/v1/art/steam/:appid/hero|logo|meta   the same three for a Steam app
 *   GET /api/v1/art/title/:id/poster          a catalog title's cover (a search hit not on the server yet), through ludarr
 *   GET /api/v1/art/url?u=<https url>         an image from an allowed host (Steam, Metacritic …), cached
 *
 * Every image route but the logos takes `?w=<px>`: a smaller copy for a small slot (a 40 × 60 thumb, a 104 calendar capsule,
 * a friend's tile), at most that wide, as WebP, rounded up to one of a fixed set of widths (art.ts ART_WIDTHS) and kept on disk.
 */
import { Hono, type Context } from "hono";
import { stmts } from "../db";
import { appHero, appMeta, artWidth, cachedImage, gameHero, gameImage, gameLogo, gameMeta, placeholderSvg, sizedImage, steamHero, steamLogo, steamPoster, titleImage, type ArtMeta, type CachedImage } from "../art";
import * as ludarr from "../ludarr";
import { STEAM_APP_MAX, plainId } from "../ids";
import { knownName } from "../names";
import { maySeeGame } from "../who";

export const artApi = new Hono();

/** the image (a smaller copy when the request asks for one with ?w=), else the placeholder */
async function serve(c: Context, img: CachedImage | null, name: string, kind: "poster" | "banner" | "hero"): Promise<Response> {
  if (!img) return new Response(placeholderSvg(name, kind), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600", "x-ahoy-art": "placeholder" } });
  const w = artWidth(c.req.query("w"));
  const out = w ? await sizedImage(img, w) : img;
  return new Response(Bun.file(out.path), { headers: { "content-type": out.type, "cache-control": "public, max-age=86400" } });
}
const logo = (img: CachedImage | null) =>
  img ? new Response(Bun.file(img.path), { headers: { "content-type": img.type, "cache-control": "public, max-age=86400" } })
      : Response.json({ error: "no logo" }, { status: 404, headers: { "cache-control": "public, max-age=3600" } });
const meta = (m: ArtMeta) => Response.json(m, { headers: { "cache-control": "public, max-age=3600" } });
/** a positive whole number spelled in plain digits from the path ("1e3", "0x10", "+5" are not ids), else null */
const idParam = (c: Context, name: string, max?: number) => plainId(c.req.param(name), max);

artApi.get("/api/v1/art/game/:id/hero", async c => {
  const id = idParam(c, "id");
  return serve(c, id ? await gameHero(id) : null, "", "hero");
});
artApi.get("/api/v1/art/game/:id/logo", async c => {
  const id = idParam(c, "id");
  return logo(id ? await gameLogo(id) : null);
});
artApi.get("/api/v1/art/game/:id/meta", async c => {
  const id = idParam(c, "id");
  return id ? meta(await gameMeta(id)) : c.json({ error: "no such game" }, 404);
});
artApi.get("/api/v1/art/game/:id/:kind{poster|banner}", async c => {
  const id = idParam(c, "id");
  const kind = c.req.param("kind") === "banner" ? "banner" : "poster";
  // the stand-in carries the game's name: for members and the front page's games, like everything that names a game
  const name = (id && maySeeGame(c, id) ? ludarr.libraryById().get(id)?.name : null) ?? "?";
  if (!id) return serve(c, null, name, kind);
  return serve(c, await gameImage(id, kind), name, kind);
});
/** the name a Steam app's placeholder art carries: the catalog's, else the one the page sends (?n=), else none (never "app <id>") */
const appName = (c: Context, appId: number | null) =>
  (appId ? knownName((stmts.catalogGet.get(appId) as { name?: string } | undefined)?.name) : null) ?? knownName(c.req.query("n")?.slice(0, 120)) ?? "";
artApi.get("/api/v1/art/steam/:appid/poster", async c => {
  const appId = idParam(c, "appid", STEAM_APP_MAX), name = appName(c, appId);
  if (!appId) return serve(c, null, name, "poster");
  const url = await steamPoster(appId);
  return serve(c, url ? await cachedImage(url) : null, name, "poster");
});
artApi.get("/api/v1/art/steam/:appid/banner", async c => {
  const appId = idParam(c, "appid", STEAM_APP_MAX), name = appName(c, appId);
  if (!appId) return serve(c, null, name, "banner");
  const url = await steamHero(appId);
  return serve(c, url ? await cachedImage(url) : null, name, "banner");
});
artApi.get("/api/v1/art/steam/:appid/hero", async c => {
  const appId = idParam(c, "appid", STEAM_APP_MAX);
  return serve(c, appId ? await appHero(appId) : null, "", "hero");
});
artApi.get("/api/v1/art/steam/:appid/logo", async c => {
  const appId = idParam(c, "appid", STEAM_APP_MAX);
  return logo(appId ? await steamLogo(appId) : null);
});
artApi.get("/api/v1/art/steam/:appid/meta", async c => {
  const appId = idParam(c, "appid", STEAM_APP_MAX);
  return appId ? meta(await appMeta(appId)) : c.json({ error: "no such app" }, 404);
});
/** a catalog title's cover; the placeholder carries the name the page sends (?n=) */
artApi.get("/api/v1/art/title/:id/poster", async c => {
  const id = idParam(c, "id"), name = knownName(c.req.query("n")?.slice(0, 120)) ?? "";
  return serve(c, id ? await titleImage(id) : null, name, "poster");
});
artApi.get("/api/v1/art/url", async c => {
  const img = await cachedImage(c.req.query("u") ?? "");
  return img ? serve(c, img, "", "poster") : c.json({ error: "no image there (or the host is not allowed)" }, 404);
});

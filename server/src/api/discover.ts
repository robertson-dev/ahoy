/**
 * Ahoy API — discovery.
 *
 *   GET /api/v1/discover                       Steam storefront feeds (coming soon / new / top)
 *   GET /api/v1/discover/app/:appId            one Steam app: details, art, trailers, verdict, library state (404 when Steam does not know it)
 *   GET /api/v1/discover/app/:appId/similar    what the store puts next to this game ("More like this")
 *   GET /api/v1/discover/genres  ·  /genre/:tag
 *   GET /api/v1/discover/list/:key?page=N      a whole row, 50 at a time: coming_soon | new | top | playable | genre:<tag>:rated|sellers | best:<list>
 *   GET /api/v1/discover/playable              games whose protection was broken lately (newest first)
 *   GET /api/v1/discover/best  ·  /best/:key   the Metacritic lists, matched to Steam
 */
import { Hono } from "hono";
import { appDetail, discover, discoverGenre, discoverList, GENRES, recentlyPlayable, similarTo } from "../discover";
import { bestOf, isList, lists } from "../metacritic";
import { STEAM_APP_MAX, plainId } from "../ids";
import { platformChoices, platformGames } from "../platform-catalog";
import type { Env } from "../server";

export const discoverApi = new Hono<Env>();
const fail = (c: any, e: any) => c.json({ error: String(e?.message ?? e) }, 500);

discoverApi.get("/api/v1/discover", async c => { try { return c.json(await discover()); } catch (e) { return fail(c, e); } });
discoverApi.get("/api/v1/discover/genres", c => c.json({ items: GENRES }));
discoverApi.get("/api/v1/discover/platforms", async c => {
  try { return c.json({ items: await platformChoices() }); }
  catch { return c.json({ error: "Platforms couldn't be loaded" }, 502); }
});
discoverApi.get("/api/v1/discover/platform/:platform", async c => {
  const platform = c.req.param("platform");
  const page = plainId(c.req.query("page") ?? "1", 1_000_000);
  const query = (c.req.query("q") ?? "").trim();
  if (!/^[a-z0-9]{1,16}$/.test(platform) || !page || query.length > 120) return c.json({ error: "Invalid search" }, 400);
  try { return c.json(await platformGames(platform, query, page)); }
  catch { return c.json({ error: "Games couldn't be loaded" }, 502); }
});
discoverApi.get("/api/v1/discover/genre/:tag", async c => { try { return c.json(await discoverGenre(Number(c.req.param("tag")))); } catch (e) { return fail(c, e); } });
discoverApi.get("/api/v1/discover/playable", async c => { try { return c.json(await recentlyPlayable()); } catch (e) { return fail(c, e); } });
discoverApi.get("/api/v1/discover/list/:key", async c => {
  const key = c.req.param("key"), page = Math.max(0, Number(c.req.query("page")) || 0);
  try {
    const best = /^best:(.+)$/.exec(key);
    if (best) {
      if (!isList(best[1])) return c.json({ error: "not one of the Metacritic lists" }, 400);
      const list = await bestOf(best[1], 200);                                       // the lists run four pages deep at most
      const items = list.items.slice(page * 50, page * 50 + 50);
      return c.json({ key, title: `Highest rated · ${list.label.toLowerCase() === "all time" ? "all time" : list.label}`, sub: "", items, page, more: list.items.length > page * 50 + 50, pending: list.pending });
    }
    return c.json(await discoverList(key, page));
  } catch (e) { return fail(c, e); }
});
discoverApi.get("/api/v1/discover/best", c => c.json({ items: lists() }));
discoverApi.get("/api/v1/discover/best/:key", async c => {
  const key = c.req.param("key");
  if (!isList(key)) return c.json({ error: "not one of the Metacritic lists" }, 400);
  try { return c.json(await bestOf(key)); } catch (e) { return fail(c, e); }
});
discoverApi.get("/api/v1/discover/app/:appId/similar", async c => {
  const id = plainId(c.req.param("appId"), STEAM_APP_MAX);
  if (!id) return c.json({ error: "that is not a Steam app id" }, 400);
  try { return c.json(await similarTo(id)); } catch (e) { return fail(c, e); }
});
discoverApi.get("/api/v1/discover/app/:appId", async c => {
  const id = plainId(c.req.param("appId"), STEAM_APP_MAX);
  if (!id) return c.json({ error: "that is not a Steam app id" }, 400);
  try { const item = await appDetail(id); return item ? c.json({ item }) : c.json({ error: "Steam does not know that app" }, 404); } catch (e) { return fail(c, e); }
});

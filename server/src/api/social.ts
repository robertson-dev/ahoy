/**
 * Ahoy API — people.
 *
 *   GET    /api/v1/people                    everyone on this server, with presence and your friend state
 *   GET    /api/v1/people/:name              a profile: presence, what they have, what they did lately
 *   GET    /api/v1/friends                   { friends, incoming, outgoing }, each with presence
 *   POST   /api/v1/friends/:id               ask, or accept when they asked first
 *   DELETE /api/v1/friends/:id               unfriend / withdraw / decline
 *   GET    /api/v1/activity?only=friends|mine|all&before=&limit=
 *   POST   /api/v1/me/heartbeat              { device }                                        every open client, now and then
 *   POST   /api/v1/me/playing                { running, gameId, appId, name, slug, device }     the launcher, on start and stop
 *   PUT    /api/v1/me/installed              { device, items: [...] }                           the launcher's whole list for that PC
 *   GET    /api/v1/me/installed
 */
import { Hono } from "hono";
import { allUsers, userById, userByName, userRef, type UserRow } from "../auth";
import { SocialError, addFriend, everyone, feed, friendIds, friendState, friendsOf, heartbeat, installsOf, presenceOf, removeFriend, setPlaying, syncInstalls } from "../social";
import type { Env } from "../server";
import { deviceName, touchPc } from "../pcs";

export const socialApi = new Hono<Env>();
const fail = (c: any, e: any) => c.json({ error: String(e?.message ?? e) }, e instanceof SocialError ? e.status : 500);
const me = (c: any): UserRow => c.get("user");

socialApi.get("/api/v1/people", c => {
  const u = me(c);
  const pres = new Map(everyone().map(p => [p.user.id, p]));
  return c.json({ items: allUsers().map(x => ({ ...userRef(x), presence: pres.get(x.id)!, friend: friendState(u.id, x.id), joinedAt: x.created_at })) });
});
socialApi.get("/api/v1/people/:name", c => {
  const u = me(c);
  const other = userByName(c.req.param("name"));
  if (!other) return c.json({ error: "no such person" }, 404);
  const installs = installsOf(other.id);
  const games = new Map<string, { gameId: number | null; appId: number | null; name: string; devices: string[]; lastPlayedAt: number | null; playSeconds: number }>();
  for (const i of installs) {
    const k = i.game_id != null ? `g${i.game_id}` : i.slug;
    const g = games.get(k) ?? { gameId: i.game_id, appId: i.app_id, name: i.name, devices: [], lastPlayedAt: null, playSeconds: 0 };
    g.devices.push(i.device); g.lastPlayedAt = Math.max(g.lastPlayedAt ?? 0, i.last_played_at ?? 0) || null; g.playSeconds += i.play_seconds;
    games.set(k, g);
  }
  return c.json({
    user: userRef(other), bio: other.bio, joinedAt: other.created_at, presence: presenceOf(other.id), friend: friendState(u.id, other.id),
    friends: friendIds(other.id).map(id => userById(id)).filter((x): x is UserRow => !!x).map(userRef),
    games: [...games.values()].sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0)),
    activity: feed(other.id, { only: "mine", limit: 30 }),
  });
});

socialApi.get("/api/v1/friends", c => {
  const f = friendsOf(me(c).id);
  const withPresence = (list: ReturnType<typeof userRef>[]) => list.map(x => ({ ...x, presence: presenceOf(x.id) }));
  return c.json({ friends: withPresence(f.friends), incoming: withPresence(f.incoming), outgoing: withPresence(f.outgoing) });
});
socialApi.post("/api/v1/friends/:id", c => { try { return c.json({ state: addFriend(me(c), Number(c.req.param("id"))) }); } catch (e) { return fail(c, e); } });
socialApi.delete("/api/v1/friends/:id", c => { removeFriend(me(c).id, Number(c.req.param("id"))); return c.json({ state: "none" }); });

socialApi.get("/api/v1/activity", c => {
  const only = c.req.query("only");
  return c.json({ items: feed(me(c).id, { only: only === "mine" || only === "all" ? only : "friends", before: Number(c.req.query("before")) || undefined, limit: Number(c.req.query("limit")) || undefined }) });
});

socialApi.post("/api/v1/me/heartbeat", async c => {
  const b = await c.req.json().catch(() => ({})) as { device?: string };
  heartbeat(me(c).id, b.device?.slice(0, 80) ?? null);
  touchPc(me(c).id, deviceName(b.device));                 // one of their PCs saying so stays "on" in their list of PCs
  return c.json({ ok: true });
});
socialApi.post("/api/v1/me/playing", async c => {
  const b = await c.req.json().catch(() => ({})) as { running?: boolean; gameId?: number | null; appId?: number | null; name?: string; slug?: string; device?: string };
  setPlaying(me(c), { running: !!b.running, gameId: b.gameId ?? null, appId: b.appId ?? null, name: b.name ?? null, slug: b.slug ?? null, device: b.device?.slice(0, 80) ?? null });
  return c.json({ ok: true });
});
socialApi.put("/api/v1/me/installed", async c => {
  const b = await c.req.json().catch(() => ({})) as { device?: string; items?: { slug: string; gameId: number | null; packageId: number; appId?: number | null; name: string; sizeBytes: number; installedAt: number }[] };
  const device = String(b.device ?? "").trim().slice(0, 80);
  if (!device || !Array.isArray(b.items)) return c.json({ error: "device and items are needed" }, 400);
  syncInstalls(me(c), device, b.items.filter(i => i && typeof i.slug === "string" && typeof i.name === "string"));
  return c.json({ ok: true, count: b.items.length });
});
socialApi.get("/api/v1/me/installed", c => c.json({ items: installsOf(me(c).id).map(i => ({ device: i.device, slug: i.slug, gameId: i.game_id, packageId: i.package_id, appId: i.app_id, name: i.name, size: i.size, installedAt: i.installed_at, lastPlayedAt: i.last_played_at, playSeconds: i.play_seconds })) }));

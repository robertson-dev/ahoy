/** shared bits for the tests: a minimal ludarr game, a fresh database, HTTP through the app */
import { db, kv } from "../src/db";
import { _test, type LudarrGame } from "../src/ludarr";
import { app } from "../src/server";

export const game = (id: number, name: string, over: Partial<LudarrGame> = {}): LudarrGame => ({
  id, igdbId: null, steamAppId: null, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), summary: null, releaseYear: null, rating: null,
  drm: null, crackStatus: null, crackDate: null, crackGroup: null, crackwatchUrl: null, coverUrl: null, bannerUrl: null, screenshots: [], genres: [], themes: [], platforms: ["win"], gameModes: [],
  developer: null, publisher: null, comingSoon: false, releaseText: null, releaseIso: null, monitored: true, profileId: null, rootFolderId: null, path: null, tags: [], addedAt: 1700000000, titleId: null,
  status: "missing", statusDetail: "", hasFile: false, file: null, cutoffUnmet: false, request: null, profile: null, rootFolder: null, tracked: false, ...over,
});
export const setLibrary = (list: LudarrGame[]) => _test.setLibrary(list);

export function wipe() {
  db.exec("DELETE FROM sessions; DELETE FROM invites; DELETE FROM friends; DELETE FROM activity; DELETE FROM presence; DELETE FROM installs; DELETE FROM pcs; DELETE FROM orders; DELETE FROM saves; DELETE FROM save_paths; DELETE FROM wants; DELETE FROM asked; DELETE FROM request_starts; DELETE FROM users; DELETE FROM catalog; DELETE FROM kv;");
  kv.set("cfg.SIGNUP", "open");          // the default is invite-only; most tests just want people on the server
  _test.setLibrary([]);
}

/** one request to the app; `token` goes as a Bearer header; `peer` is the address at the other end of the socket (without one
 *  the app is called with no socket at all, as Bun.serve never does) */
export async function http(method: string, path: string, body?: unknown, token?: string | null, headers: Record<string, string> = {}, peer?: string) {
  const env = peer ? { requestIP: () => ({ address: peer, family: peer.includes(":") ? "IPv6" : "IPv4", port: 50_000 }) } : undefined;
  const res = await app.fetch(new Request(`http://ahoy.test${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined }), env);
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}
export async function signup(name: string, password = "secret123", extra: Record<string, unknown> = {}) {
  const r = await http("POST", "/api/v1/auth/register", { name, password, ...extra });
  if (r.status !== 200) throw new Error(`signup ${name}: ${r.status} ${JSON.stringify(r.json)}`);
  return { token: r.json.token as string, user: r.json.user as { id: number; name: string; role: string } };
}

/** the doors under pressure: rate limits behind the proxy, sign-ups racing each other, sessions that end, other origins, the engine's key. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { http, signup, wipe } from "./helpers";
import { db, kv } from "../src/db";
import { SESSION_IDLE_DAYS, allUsers, dropIdleSessions, hashLimit } from "../src/auth";
import { attempt, bucketLimit, limits, _test as rl, visitor } from "../src/ratelimit";
import { guestErrors } from "../src/api/system";
import { app } from "../src/server";
import * as ludarr from "../src/ludarr";
import { events } from "../src/events";
import { logger } from "../src/log";

beforeEach(() => { wipe(); rl.reset(); });

/** a sign-in try as the proxy passes it on: `peer` is the socket's other end, `fwd` the X-Forwarded-For it carries */
const tryLogin = (password: string, peer: string | undefined, fwd?: string, name = "skipper") =>
  http("POST", "/api/v1/auth/login", { name, password }, null, fwd ? { "x-forwarded-for": fwd } : {}, peer);
const PROXY = "172.17.0.1";

describe("rate limits", () => {
  afterEach(() => { limits.enabled = false; rl.reset(); bucketLimit.max = 20_000; kv.del("cfg.TRUSTED_PROXY"); });
  test("ten failed sign-ins from one address, then 429; a success does not count", async () => {
    await signup("skipper", "secret123");
    limits.enabled = true;
    for (let i = 0; i < 9; i++) expect((await tryLogin("wrong", PROXY, "203.0.113.9")).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await tryLogin("secret123", PROXY, "203.0.113.9")).status).toBe(200);
    expect((await tryLogin("wrong", PROXY, "203.0.113.9")).status).toBe(401);
    const blocked = await tryLogin("secret123", PROXY, "203.0.113.9");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    // another address is unaffected
    expect((await tryLogin("secret123", PROXY, "198.51.100.4")).status).toBe(200);
  });
  test("the address is the one the proxy wrote: whatever the caller put in X-Forwarded-For before it changes nothing", async () => {
    await signup("skipper", "secret123");
    limits.enabled = true;
    for (let i = 0; i < 10; i++) expect((await tryLogin("wrong", PROXY, `1.2.3.${i}, 203.0.113.9`)).status).toBe(401);
    expect((await tryLogin("wrong", PROXY, "9.9.9.9, 203.0.113.9")).status).toBe(429);
  });
  test("a caller that is not the proxy is known by its socket, whatever header it sends", async () => {
    await signup("skipper", "secret123");
    limits.enabled = true;
    for (let i = 0; i < 10; i++) expect((await tryLogin("wrong", "203.0.113.50", `1.2.3.${i}`)).status).toBe(401);
    expect((await tryLogin("wrong", "203.0.113.50", "8.8.8.8")).status).toBe(429);
    // TRUSTED_PROXY names the proxy: another machine on the LAN does not get to speak for anyone either
    kv.set("cfg.TRUSTED_PROXY", "172.17.0.1, 10.9.0.0/16"); rl.reset();
    for (let i = 0; i < 10; i++) expect((await tryLogin("wrong", "192.168.1.50", `1.2.3.${i}`)).status).toBe(401);
    expect((await tryLogin("wrong", "192.168.1.50", "8.8.8.8")).status).toBe(429);
    // the named proxy, and one in a named block, are believed; a second named proxy in the chain is passed over
    rl.reset();
    for (let i = 0; i < 10; i++) expect((await tryLogin("wrong", i % 2 ? "172.17.0.1" : "::ffff:10.9.3.4", i % 2 ? "198.51.100.7" : "198.51.100.7, 172.17.0.1", `nobody${i}`)).status).toBe(401);
    expect((await tryLogin("wrong", "172.17.0.1", "198.51.100.7", "nobody")).status).toBe(429);
    expect((await tryLogin("wrong", "172.17.0.1", "198.51.100.8", "nobody")).status).toBe(401);
  });
  test("tries sent all at once are counted before they are checked", async () => {
    await signup("skipper", "secret123");
    limits.enabled = true;
    const all = await Promise.all(Array.from({ length: 30 }, () => tryLogin("wrong", PROXY, "203.0.113.77")));
    expect(all.filter(r => r.status === 401).length).toBe(10);
    expect(all.filter(r => r.status === 429).length).toBe(20);
  });
  test("an account takes 30 wrong passwords per 10 minutes, however many addresses they come from", async () => {
    await signup("skipper", "secret123"); await signup("mate", "secret123");
    limits.enabled = true;
    for (let i = 0; i < 30; i++) expect((await tryLogin("wrong", PROXY, `198.51.100.${i}`, i % 2 ? "Skipper" : "skipper")).status).toBe(401);
    expect((await tryLogin("wrong", PROXY, "198.51.100.200")).status).toBe(429);
    expect((await tryLogin("secret123", PROXY, "198.51.100.201", "mate")).status).toBe(200);     // another account is not held up
  });
  test("the limiter remembers a bounded number of addresses: when all of them are counting, a new one waits and none is forgotten", async () => {
    await signup("skipper", "secret123");
    limits.enabled = true; bucketLimit.max = 50;
    for (let i = 0; i < 10; i++) expect((await tryLogin("wrong", PROXY, "203.0.113.9", "nobody")).status).toBe(401);      // this address has spent its ten
    const flood: number[] = [];
    for (let i = 0; i < 120; i++) flood.push((await tryLogin("wrong", PROXY, `198.18.${i}.1`, `nobody${i}`)).status);
    expect(flood.slice(0, 49).every(s => s === 401)).toBe(true);
    expect(flood.slice(49).every(s => s === 429)).toBe(true);                                    // no room: told to wait, nothing dropped for them
    expect(rl.size()).toBe(50);
    expect((await tryLogin("secret123", PROXY, "203.0.113.9")).status).toBe(429);                // the first address did not get its ten back
    expect((await tryLogin("secret123", PROXY, "198.18.3.1")).status).toBe(200);                 // and one that is known still signs in
    const turnedAway = await tryLogin("secret123", PROXY, "198.19.0.1");
    expect(turnedAway.status).toBe(429); expect(Number(turnedAway.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  test("room is made by counts that have run out, and only by those", async () => {
    bucketLimit.max = 3;
    expect(attempt("door:a", 5, 40).ok).toBe(true); expect(attempt("door:b", 5, 60_000).ok).toBe(true); expect(attempt("door:c", 5, 60_000).ok).toBe(true);
    expect(attempt("door:d", 5, 60_000).ok).toBe(false);
    expect(attempt("door:b", 5, 60_000).ok).toBe(true);                                          // one that is counting goes on counting
    await new Promise(r => setTimeout(r, 60));                                                    // a's count has run out
    expect(attempt("door:d", 5, 60_000).ok).toBe(true);
    expect(attempt("door:e", 5, 60_000).ok).toBe(false);
    expect(rl.size()).toBe(3);
  });
  test("an account's count of wrong passwords is not started over by a flood of other tries", async () => {
    await signup("skipper", "secret123");
    limits.enabled = true; bucketLimit.max = 200;
    for (let i = 0; i < 30; i++) expect((await tryLogin("wrong", PROXY, `203.0.113.${1 + Math.floor(i / 10)}`)).status).toBe(401);   // 30 wrong, from three addresses
    expect((await tryLogin("wrong", PROXY, "203.0.113.200")).status).toBe(429);
    // far more tries than the limiter remembers addresses, each for a made-up name from an address of its own
    for (let i = 0; i < 1200; i++) await tryLogin("wrong", PROXY, `198.18.${i >> 8}.${i & 255}`, `nobody${i}`);
    expect(rl.held()).toBe(1);                                                                    // a made-up name gets no count of its own
    expect((await tryLogin("wrong", PROXY, "203.0.113.200")).status).toBe(429);                  // still locked, for a known address
    expect((await tryLogin("secret123", PROXY, "203.0.113.200")).status).toBe(429);
  });
  test("an IPv6 visitor is its /64, whichever of its addresses it uses", async () => {
    expect(visitor("2001:db8:12:3400:1:2:3:4")).toBe("2001:db8:12:3400::/64");
    expect(visitor("2001:db8::7")).toBe("2001:db8:0:0::/64");
    expect(visitor("2001:DB8:0:0:ffff::1")).toBe("2001:db8:0:0::/64");
    expect(visitor("2001:db8:1::")).toBe("2001:db8:1:0::/64");
    expect(visitor("64:ff9b::203.0.113.9")).toBe("64:ff9b:0:0::/64");
    expect(visitor("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    for (const same of ["203.0.113.9", "::1", "::", "::ffff:cb00:7109", "1:2:3", "1::2::3", "1:2:3:4:5:6:7:8:9", "g::1", "not an address"]) expect(visitor(same)).toBe(same);
    await signup("skipper", "secret123");
    limits.enabled = true;
    for (let i = 0; i < 10; i++) expect((await tryLogin("wrong", PROXY, `2001:db8:5:6:${i}::${i + 1}`)).status).toBe(401);
    expect((await tryLogin("wrong", PROXY, "2001:db8:5:6:aaaa:bbbb:cccc:dddd")).status).toBe(429);
    expect((await tryLogin("wrong", "2001:db8:5:6::99", undefined)).status).toBe(429);           // the same when it is the socket's own address
    expect((await tryLogin("wrong", PROXY, "2001:db8:5:7::1")).status).toBe(401);                // the next /64 is someone else
  });
  test("password hashing runs a few at a time; past the line behind it the answer is busy", async () => {
    await signup("skipper", "secret123");
    const was = { ...hashLimit };
    hashLimit.running = 1; hashLimit.waiting = 1;
    try {
      const all = await Promise.all(Array.from({ length: 6 }, () => tryLogin("secret123", undefined)));
      expect(all.filter(r => r.status === 200).length).toBe(2);
      expect(all.filter(r => r.status === 503).length).toBe(4);
      expect((await tryLogin("secret123", undefined)).status).toBe(200);                         // and the places are given back
    } finally { Object.assign(hashLimit, was); }
  });
  test("a page's error report: a guest is known by address, not by a header, and all guests share a budget", async () => {
    const report = (peer: string, fwd: string) => http("POST", "/api/v1/client-error", { message: "boom", path: "/" }, null, { "x-forwarded-for": fwd }, peer);
    for (let i = 0; i < guestErrors.each; i++) expect((await report("203.0.113.60", `made-up-${i}`)).status).toBe(200);
    expect((await report("203.0.113.60", "made-up-again")).status).toBe(429);
    // other addresses still get through, until the guests' shared budget is spent
    let ok = 0;
    for (let i = 0; i < 100; i++) if ((await report(`198.51.100.${i}`, "x")).status === 200) ok++;
    expect(ok).toBe(guestErrors.all - guestErrors.each);
    // someone signed in is not a guest
    const m = await signup("mika");
    expect((await http("POST", "/api/v1/client-error", { message: "boom" }, m.token, {}, "203.0.113.60")).status).toBe(200);
  });
});

describe("accounts under a burst", () => {
  test("one invite makes one account, however many sign-ups present it at once", async () => {
    const admin = await signup("skipper");
    kv.set("cfg.SIGNUP", "invite");
    const code = (await http("POST", "/api/v1/admin/invites", undefined, admin.token)).json.code as string;
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => http("POST", "/api/v1/auth/register", { name: `guest${i}`, password: "secret123", invite: code })));
    expect(all.filter(r => r.status === 200).length).toBe(1);
    expect(all.filter(r => r.status === 403).length).toBe(7);
    expect(allUsers().length).toBe(2);
    const used = (await http("GET", "/api/v1/admin/invites", undefined, admin.token)).json.items[0];
    expect(used.usedBy).toBe(all.find(r => r.status === 200)!.json.user.name);
  });
  test("the first account is one account: sign-ups racing for it do not all become the admin", async () => {
    kv.set("cfg.SIGNUP", "invite");
    const all = await Promise.all(Array.from({ length: 5 }, (_, i) => http("POST", "/api/v1/auth/register", { name: `first${i}`, password: "secret123" })));
    expect(all.filter(r => r.status === 200).length).toBe(1);
    expect(allUsers().filter(u => u.role === "admin").length).toBe(1);
    expect(allUsers().length).toBe(1);
  });
});

describe("sessions", () => {
  const age = (days: number) => db.query("UPDATE sessions SET last_seen_at = unixepoch() - ?").run(days * 86_400);
  test("a session ends after 90 days without use; using it starts the count again", async () => {
    const a = await signup("yam");
    age(SESSION_IDLE_DAYS - 1);
    expect((await http("GET", "/api/v1/me", undefined, a.token)).status).toBe(200);
    const seen = (db.query("SELECT last_seen_at AS t FROM sessions").get() as { t: number }).t;
    expect(Date.now() / 1000 - seen).toBeLessThan(60);                                           // used: it is fresh again
    age(SESSION_IDLE_DAYS + 1);
    expect((await http("GET", "/api/v1/me", undefined, a.token)).status).toBe(401);
    expect((db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
  });
  test("the daily sweep removes only the sessions left idle", async () => {
    const a = await signup("yam");
    age(SESSION_IDLE_DAYS + 5);
    const fresh = (await http("POST", "/api/v1/auth/login", { name: "yam", password: "secret123" })).json.token as string;
    expect(dropIdleSessions()).toBe(1);
    expect((await http("GET", "/api/v1/me", undefined, fresh)).status).toBe(200);
    expect((await http("GET", "/api/v1/me", undefined, a.token)).status).toBe(401);
  });
  test("a new password ends every other session and keeps the one that changed it", async () => {
    const a = await signup("yam");
    const stolen = (await http("POST", "/api/v1/auth/login", { name: "yam", password: "secret123" })).json.token as string;
    const b = await signup("mika");
    expect((await http("PUT", "/api/v1/me/password", { current: "nope", next: "another1" }, a.token)).status).toBe(403);
    expect((await http("GET", "/api/v1/me", undefined, stolen)).status).toBe(200);                // a wrong password changes nothing
    expect((await http("PUT", "/api/v1/me/password", { current: "secret123", next: "another1" }, a.token)).status).toBe(200);
    expect((await http("GET", "/api/v1/me", undefined, stolen)).status).toBe(401);
    expect((await http("GET", "/api/v1/me", undefined, a.token)).status).toBe(200);
    expect((await http("GET", "/api/v1/me", undefined, b.token)).status).toBe(200);               // nobody else is signed out
  });
  test("a token in the address is read on the event stream only", async () => {
    const a = await signup("yam");
    expect((await http("GET", `/api/v1/me?token=${a.token}`)).status).toBe(401);
    expect((await http("GET", `/api/v1/game?token=${a.token}`)).status).toBe(401);
    const res = await app.fetch(new Request(`http://ahoy.test/api/v1/events?token=${a.token}`));
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });
  test("the page's first question sets the cookie again, so it lasts as long as the session is used", async () => {
    const a = await signup("yam");
    const r = await http("GET", "/api/v1/me", undefined, a.token);
    expect(r.headers.get("set-cookie")).toContain(`ahoy_session=${a.token}`);
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
  });

  /** an open event stream, read as it comes: what has arrived so far, and whether the server has ended it */
  async function listen(token: string) {
    const res = await app.fetch(new Request("http://ahoy.test/api/v1/events", { headers: { authorization: `Bearer ${token}` } }));
    const reader = res.body!.getReader(), dec = new TextDecoder();
    const s = { got: "", ended: false, close: async () => { await reader.cancel().catch(() => {}); } };
    void (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; s.got += dec.decode(value, { stream: true }); } } catch { /* cancelled */ } s.ended = true; })();
    await new Promise(r => setTimeout(r, 20));
    expect(s.got).toContain("event: hello");
    return s;
  }
  const soon = () => new Promise(r => setTimeout(r, 40));
  test("an event stream ends with its session: after a new password a copied token's stream gets nothing more", async () => {
    const admin = await signup("skipper", "secret123");
    const copied = (await http("POST", "/api/v1/auth/login", { name: "skipper", password: "secret123" })).json.token as string;
    const mine = await listen(admin.token), theirs = await listen(copied);
    try {
      events.emit("library", { games: 1 }); logger("Library").info("a line before");
      await soon();
      for (const s of [mine, theirs]) { expect(s.got).toContain('"games":1'); expect(s.got).toContain("a line before"); expect(s.ended).toBe(false); }
      expect((await http("PUT", "/api/v1/me/password", { current: "secret123", next: "newsecret456" }, admin.token)).status).toBe(200);
      events.emit("library", { games: 2 }); logger("Library").info("skipper removed game 5 and its files");
      events.emit("presence", { secret: "later" });
      await soon();
      expect(theirs.ended).toBe(true);                                                           // closed by the server, not left to idle
      expect(theirs.got).not.toContain('"games":2'); expect(theirs.got).not.toContain("removed game 5"); expect(theirs.got).not.toContain("later");
      expect(mine.ended).toBe(false);                                                            // the session that changed the password stays
      expect(mine.got).toContain('"games":2'); expect(mine.got).toContain("removed game 5");
    } finally { await mine.close(); await theirs.close(); }
  });
  test("signing out, a session ended from another device, a removed account and a session left idle all end the stream", async () => {
    const admin = await signup("skipper");
    const out = await signup("anne"), ended = await signup("bart"), removed = await signup("cleo"), idle = await signup("dora"), stays = await signup("emil");
    const streams = { out: await listen(out.token), ended: await listen(ended.token), removed: await listen(removed.token), idle: await listen(idle.token), stays: await listen(stays.token) };
    try {
      expect((await http("POST", "/api/v1/auth/logout", undefined, out.token)).status).toBe(200);
      const other = (await http("POST", "/api/v1/auth/login", { name: "bart", password: "secret123" })).json.token as string;
      const first = ((await http("GET", "/api/v1/me/sessions", undefined, other)).json.items as { id: number }[]).map(s => s.id).sort((x, y) => x - y)[0];
      expect((await http("DELETE", `/api/v1/me/sessions/${first}`, undefined, other)).status).toBe(200);
      expect((await http("DELETE", `/api/v1/admin/users/${removed.user.id}`, undefined, admin.token)).status).toBe(200);
      db.query("UPDATE sessions SET last_seen_at = unixepoch() - ? WHERE user_id=?").run((SESSION_IDLE_DAYS + 1) * 86_400, idle.user.id);
      events.emit("friend", { after: "all that" });
      await soon();
      for (const k of ["out", "ended", "removed", "idle"] as const) { expect(streams[k].ended).toBe(true); expect(streams[k].got).not.toContain("all that"); }
      expect(streams.stays.ended).toBe(false); expect(streams.stays.got).toContain("all that");
    } finally { for (const s of Object.values(streams)) await s.close(); }
  });
  test("log lines go to whoever is an admin when they are written: an admin made a member gets no more of them", async () => {
    const admin = await signup("skipper"), second = await signup("mate");
    expect((await http("PUT", `/api/v1/admin/users/${second.user.id}/role`, { role: "admin" }, admin.token)).status).toBe(200);
    const s = await listen(second.token);
    try {
      logger("Library").info("while an admin"); await soon();
      expect(s.got).toContain("while an admin");
      expect((await http("PUT", `/api/v1/admin/users/${second.user.id}/role`, { role: "member" }, admin.token)).status).toBe(200);
      logger("Library").info("skipper removed game 5 and its files"); events.emit("library", { games: 3 }); await soon();
      expect(s.got).not.toContain("removed game 5");
      expect(s.got).toContain('"games":3'); expect(s.ended).toBe(false);                         // still signed in: events go on
    } finally { await s.close(); }
  });
});

describe("other origins", () => {
  test("no other site is told it may read the API with someone's session", async () => {
    const a = await signup("yam");
    for (const origin of ["https://evil.example", "https://other.ahoy.test", "null"]) {
      const r = await http("GET", "/api/v1/me", undefined, a.token, { origin });
      expect(r.status).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      expect(r.headers.get("access-control-allow-credentials")).toBeNull();
      const pre = await http("OPTIONS", "/api/v1/me", undefined, null, { origin, "access-control-request-method": "PUT" });
      expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  test("the launcher's setup page (a file) still reads what is for everyone", async () => {
    const r = await http("GET", "/api/v1/shelf", undefined, null, { origin: "null" });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    expect((await http("GET", "/api/health", undefined, null, { origin: "null" })).headers.get("access-control-allow-origin")).toBe("*");
  });

  describe("a change that rides on the session cookie", () => {
    let sent: string[] = [];
    const realFetch = ludarr.pdeps.fetch;
    beforeEach(() => {
      sent = [];
      ludarr.pdeps.fetch = (async (url: string | URL | Request) => { sent.push(String(url)); return new Response(JSON.stringify({ ok: true, version: "9.9.9", items: [] }), { headers: { "content-type": "application/json" } }); }) as typeof fetch;
    });
    afterEach(() => { ludarr.pdeps.fetch = realFetch; });
    /** a POST as a browser sends it for a page: the cookie goes along by itself, the headers say where the page is */
    const post = (path: string, body: string, headers: Record<string, string>, cookie: string | null) =>
      app.fetch(new Request(`http://ahoy.test${path}`, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", ...(cookie ? { cookie: `ahoy_session=${cookie}` } : {}), ...headers }, body }));
    const invitesMade = () => (db.query("SELECT COUNT(*) AS n FROM invites").get() as { n: number }).n;
    const ENGINE = JSON.stringify({ url: "https://engine.attacker.example", apiKey: "theirs" });

    test("is not taken from another site, a sibling subdomain included: nothing is made, saved or sent", async () => {
      const admin = await signup("skipper");
      kv.set("cfg.LUDARR_URL", "http://engine:7979"); kv.set("cfg.LUDARR_API_KEY", "s3cret-key");
      // fetch(url, { method: "POST", mode: "no-cors", credentials: "include", body }) from https://sonarr.example.com: no
      // permission is asked first for such a POST, and the cookie (SameSite=Lax) goes with it from the same site
      const sibling = { origin: "https://sonarr.example.com", "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" };
      const elsewhere = { origin: "https://evil.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" };
      const noMetadata = { origin: "https://sonarr.example.com" };                               // a browser that sends Origin only (plain http, an older one)
      const sandboxed = { origin: "null" };
      const sites: Record<string, string>[] = [sibling, elsewhere, noMetadata, sandboxed, { "sec-fetch-site": "same-site" }];
      for (const from of sites) {
        const inv = await post("/api/v1/admin/invites", "", from, admin.token);
        expect(inv.status).toBe(403); expect((await inv.json()).error).toContain("another site");
        expect((await post("/api/v1/admin/ludarr", ENGINE, from, admin.token)).status).toBe(403);
        expect((await post("/api/v1/auth/logout", "", from, admin.token)).status).toBe(403);
        for (const method of ["PUT", "DELETE", "PATCH"]) {
          const r = await app.fetch(new Request("http://ahoy.test/api/v1/admin/settings", { method, headers: { ...from, cookie: `ahoy_session=${admin.token}`, "content-type": "text/plain" }, body: JSON.stringify({ SIGNUP: "open" }) }));
          expect(r.status).toBe(403);
        }
      }
      expect(invitesMade()).toBe(0);
      expect(kv.get("cfg.LUDARR_URL")).toBe("http://engine:7979"); expect(kv.get("cfg.LUDARR_API_KEY")).toBe("s3cret-key");
      expect(kv.get("cfg.SIGNUP")).toBe("open");                                                  // as wipe() left it
      expect(sent).toEqual([]);
      expect((await http("GET", "/api/v1/me", undefined, null, { cookie: `ahoy_session=${admin.token}` })).status).toBe(200);   // and nobody was signed out
    });

    test("is taken from Ahoy's own page, however the browser and the proxy name it, and from whatever is not a page", async () => {
      const admin = await signup("skipper");
      const own: Record<string, string>[] = [
        { origin: "http://ahoy.test", "sec-fetch-site": "same-origin" },                         // a browser on https or localhost
        { origin: "https://ahoy.example.com", "sec-fetch-site": "same-origin" },                 // behind a proxy that does not pass the name on: the browser's word is enough
        { "sec-fetch-site": "none" },
        { origin: "http://ahoy.test" },                                                           // plain http on the LAN: Origin against the address asked
        { origin: "http://AHOY.test:80" },
        { origin: "https://ahoy.example.com", host: "ahoy.example.com" },                         // the proxy passes the name on as Host
        { origin: "https://ahoy.example.com", "x-forwarded-host": "ahoy.example.com" },           // or as X-Forwarded-Host
        { origin: "https://ahoy.example.com:8443", "x-forwarded-host": "other.example.com, ahoy.example.com:8443" },
        {},                                                                                       // no page: a script with the cookie
      ];
      for (const from of own) expect((await post("/api/v1/admin/invites", "", from, admin.token)).status).toBe(201);
      expect(invitesMade()).toBe(own.length);
      // a port or a name that is not this server's is another origin
      const others: Record<string, string>[] = [{ origin: "http://ahoy.test:8080" }, { origin: "https://ahoy.example.com", "x-forwarded-host": "ahoy.example.com.evil.example" }, { origin: "https://ahoy.example.com:8443", host: "ahoy.example.com" }];
      for (const from of others)
        expect((await post("/api/v1/admin/invites", "", from, admin.token)).status).toBe(403);
      // a Bearer header is not something another site's page can send: the launcher is not asked where it is
      const cross = { origin: "https://sonarr.example.com", "sec-fetch-site": "same-site" };
      expect((await post("/api/v1/admin/invites", "", { ...cross, authorization: `Bearer ${admin.token}` }, null)).status).toBe(201);
      expect((await post("/api/v1/admin/invites", "", { ...cross, authorization: `Bearer ${admin.token}` }, admin.token)).status).toBe(201);
      const saved = await post("/api/v1/admin/ludarr", ENGINE, { "sec-fetch-site": "same-origin", origin: "http://ahoy.test" }, admin.token);
      ludarr.stopFollowing();                                                                    // saving an engine starts following its events
      expect(saved.status).toBe(200); expect(kv.get("cfg.LUDARR_URL")).toBe("https://engine.attacker.example");
      // without a session there is nothing to ride on: signing in from a file (the launcher's own pages) is not this door's business
      const fresh = await post("/api/v1/auth/login", JSON.stringify({ name: "skipper", password: "secret123" }), { origin: "null", "sec-fetch-site": "cross-site" }, null);
      expect(fresh.status).toBe(200);
      // and reading is never refused here
      expect((await http("GET", "/api/v1/me", undefined, null, { ...cross, cookie: `ahoy_session=${admin.token}` })).status).toBe(200);
    });
  });
});

describe("the engine's key", () => {
  let sent: { url: string; key: string | null }[] = [];
  const realFetch = ludarr.pdeps.fetch;
  afterEach(() => { ludarr.pdeps.fetch = realFetch; });
  const fake = () => {
    sent = [];
    ludarr.pdeps.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), key: (init?.headers as Record<string, string> | undefined)?.["X-Api-Key"] ?? null });
      return new Response(JSON.stringify({ ok: true, version: "1.0.0", items: [] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  };
  test("the saved key is tried at the saved address only: a new address needs the key typed again", async () => {
    const admin = await signup("skipper");
    kv.set("cfg.LUDARR_URL", "http://engine:7979"); kv.set("cfg.LUDARR_API_KEY", "s3cret-key");
    fake();
    for (const body of [{ url: "https://attacker.example" }, { url: "https://attacker.example", apiKey: "••••••••" }, { url: "http://engine:7979.attacker.example" }]) {
      const r = await http("POST", "/api/v1/admin/ludarr/probe", body, admin.token);
      expect(r.json.ok).toBe(false);
      expect((await http("POST", "/api/v1/admin/ludarr", body, admin.token)).status).toBe(400);
    }
    expect(sent).toEqual([]);
    expect(kv.get("cfg.LUDARR_URL")).toBe("http://engine:7979");
    // the saved address (however it is written) still takes the saved key, and a typed key goes where it was typed for
    expect((await http("POST", "/api/v1/admin/ludarr/probe", {}, admin.token)).json.ok).toBe(true);
    expect((await http("POST", "/api/v1/admin/ludarr/probe", { url: "http://ENGINE:7979/", apiKey: "••••••••" }, admin.token)).json.ok).toBe(true);
    expect((await http("POST", "/api/v1/admin/ludarr/probe", { url: "http://moved:7979", apiKey: "typed" }, admin.token)).json.ok).toBe(true);
    expect(sent.filter(s => s.key === "s3cret-key").every(s => s.url.toLowerCase().startsWith("http://engine:7979/"))).toBe(true);
    expect(sent.filter(s => s.url.startsWith("http://moved:7979") && s.key).map(s => s.key)).toEqual(["typed"]);
  });
  test("the address is not changed by itself through the general settings either: the saved key would follow it", async () => {
    const admin = await signup("skipper");
    kv.set("cfg.LUDARR_URL", "http://engine:7979"); kv.set("cfg.LUDARR_API_KEY", "s3cret-key");
    fake();
    for (const body of [{ LUDARR_URL: "https://engine.attacker.example" }, { LUDARR_API_KEY: "theirs" }, { LOG_LEVEL: "warn", LUDARR_URL: "https://engine.attacker.example" }]) {
      const r = await http("PUT", "/api/v1/admin/settings", body, admin.token);
      expect(r.status).toBe(400); expect(r.json.error).toContain("/api/v1/admin/ludarr");
    }
    expect(kv.get("cfg.LUDARR_URL")).toBe("http://engine:7979"); expect(kv.get("cfg.LUDARR_API_KEY")).toBe("s3cret-key");
    expect(kv.get("cfg.LOG_LEVEL")).toBeNull();                                                  // nothing of a refused change is saved
    await ludarr.refreshLibrary();                                                              // the minute's re-read
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every(s => s.url.startsWith("http://engine:7979/"))).toBe(true);
    // the masked key the page shows changes nothing and is not refused; the other settings are saved as before
    expect((await http("PUT", "/api/v1/admin/settings", { LUDARR_API_KEY: "••••••••", SIGNUP: "closed" }, admin.token)).status).toBe(200);
    expect(kv.get("cfg.SIGNUP")).toBe("closed"); expect(kv.get("cfg.LUDARR_API_KEY")).toBe("s3cret-key");
    // and the form that sets both still does, after trying them
    expect((await http("POST", "/api/v1/admin/ludarr", { url: "http://moved:7979", apiKey: "typed" }, admin.token)).status).toBe(200);
    ludarr.stopFollowing();
    expect([kv.get("cfg.LUDARR_URL"), kv.get("cfg.LUDARR_API_KEY")]).toEqual(["http://moved:7979", "typed"]);
  });
});

import { beforeEach, describe, expect, test } from "bun:test";
import { http, signup, wipe } from "./helpers";
import { kv } from "../src/db";
import { logLevel, setLogLevel } from "../src/log";

beforeEach(() => wipe());

describe("accounts", () => {
  test("the first to sign up is the admin, the next a member; the status says so before and after", async () => {
    expect((await http("GET", "/api/v1/auth/status")).json).toMatchObject({ users: 0, policy: "first", connected: false });
    const a = await signup("yam");
    expect(a.user.role).toBe("admin");
    expect((await http("GET", "/api/v1/auth/status")).json).toMatchObject({ users: 1, policy: "open" });
    const b = await signup("Mika", "longenough", { displayName: "Mika ✨" });
    expect(b.user).toMatchObject({ role: "member", name: "Mika", displayName: "Mika ✨" });
  });
  test("names are checked, taken names refused (case-insensitively), short passwords refused", async () => {
    expect((await http("POST", "/api/v1/auth/register", { name: "a", password: "secret123" })).status).toBe(400);
    expect((await http("POST", "/api/v1/auth/register", { name: "bad name!", password: "secret123" })).status).toBe(400);
    expect((await http("POST", "/api/v1/auth/register", { name: "fine", password: "short" })).status).toBe(400);
    await signup("Yam");
    expect((await http("POST", "/api/v1/auth/register", { name: "yam", password: "secret123" })).status).toBe(409);
  });
  test("login: right password gives a token and a cookie; wrong one is refused; the token opens /me", async () => {
    await signup("yam", "secret123");
    const bad = await http("POST", "/api/v1/auth/login", { name: "yam", password: "nope" });
    expect(bad.status).toBe(401);
    const ok = await http("POST", "/api/v1/auth/login", { name: "YAM", password: "secret123", device: "test box" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("ahoy_session=");
    expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
    const me = await http("GET", "/api/v1/me", undefined, ok.json.token);
    expect(me.json.user.name).toBe("yam");
    // the cookie alone works too (a browser), and nothing works without either
    const cookie = ok.headers.get("set-cookie")!.split(";")[0];
    expect((await http("GET", "/api/v1/me", undefined, null, { cookie })).status).toBe(200);
    expect((await http("GET", "/api/v1/me")).status).toBe(401);
    expect((await http("GET", "/api/v1/game")).status).toBe(401);
    // logout drops the session
    await http("POST", "/api/v1/auth/logout", undefined, ok.json.token);
    expect((await http("GET", "/api/v1/me", undefined, ok.json.token)).status).toBe(401);
  });
  test("signup policy: closed refuses, invite needs a code the admin made, and a code works once", async () => {
    const admin = await signup("yam");
    kv.set("cfg.SIGNUP", "closed");
    expect((await http("POST", "/api/v1/auth/register", { name: "late", password: "secret123" })).status).toBe(403);
    kv.set("cfg.SIGNUP", "invite");
    expect((await http("POST", "/api/v1/auth/register", { name: "late", password: "secret123" })).status).toBe(403);
    const inv = await http("POST", "/api/v1/admin/invites", undefined, admin.token);
    expect(inv.status).toBe(201);
    const code = inv.json.code as string;
    expect(code).toHaveLength(8);
    expect((await http("POST", "/api/v1/auth/register", { name: "late", password: "secret123", invite: "WRONG" })).status).toBe(403);
    expect((await http("POST", "/api/v1/auth/register", { name: "late", password: "secret123", invite: code })).status).toBe(200);
    expect((await http("POST", "/api/v1/auth/register", { name: "later", password: "secret123", invite: code })).status).toBe(403);
    const list = await http("GET", "/api/v1/admin/invites", undefined, admin.token);
    expect(list.json.items[0]).toMatchObject({ code, usedBy: "late" });
  });
  test("profile and password changes; sessions can be listed and dropped", async () => {
    const a = await signup("yam", "secret123");
    const p = await http("PUT", "/api/v1/me", { displayName: "Yam Z", bio: "harbor master", hue: 200 }, a.token);
    expect(p.json.user).toMatchObject({ displayName: "Yam Z", hue: 200 });
    expect((await http("PUT", "/api/v1/me/password", { current: "wrong", next: "another1" }, a.token)).status).toBe(403);   // a wrong password is not a lost session
    expect((await http("PUT", "/api/v1/me/password", { current: "secret123", next: "another1" }, a.token)).status).toBe(200);
    expect((await http("POST", "/api/v1/auth/login", { name: "yam", password: "another1" })).status).toBe(200);
    const s = await http("GET", "/api/v1/me/sessions", undefined, a.token);
    expect(s.json.items.length).toBe(2);
    const other = s.json.items.find((x: { id: number }) => x.id !== s.json.current);
    await http("DELETE", `/api/v1/me/sessions/${other.id}`, undefined, a.token);
    expect((await http("GET", "/api/v1/me/sessions", undefined, a.token)).json.items.length).toBe(1);
  });
  test("admin-only routes: members are refused; roles change; nobody demotes or removes themselves", async () => {
    const admin = await signup("yam");
    const m = await signup("mika");
    expect((await http("GET", "/api/v1/admin/users", undefined, m.token)).status).toBe(403);
    expect((await http("GET", "/api/v1/admin/users", undefined, admin.token)).json.items.length).toBe(2);
    expect((await http("PUT", `/api/v1/admin/users/${admin.user.id}/role`, { role: "member" }, admin.token)).status).toBe(400);
    expect((await http("PUT", `/api/v1/admin/users/${m.user.id}/role`, { role: "admin" }, admin.token)).status).toBe(200);
    expect((await http("GET", "/api/v1/admin/users", undefined, m.token)).status).toBe(200);
    expect((await http("DELETE", `/api/v1/admin/users/${admin.user.id}`, undefined, admin.token)).status).toBe(400);
    expect((await http("DELETE", `/api/v1/admin/users/${m.user.id}`, undefined, admin.token)).status).toBe(200);
    expect((await http("GET", "/api/v1/me", undefined, m.token)).status).toBe(401);
  });
  test("settings: secrets are masked, env-pinned keys stay read-only, unknown keys are refused", async () => {
    const admin = await signup("yam");
    kv.set("cfg.LUDARR_API_KEY", "abc");                                                          // as the engine form saved it (POST /api/v1/admin/ludarr)
    await http("PUT", "/api/v1/admin/settings", { SIGNUP: "invite" }, admin.token);
    const items = (await http("GET", "/api/v1/admin/settings", undefined, admin.token)).json.items as { key: string; value: string; source: string }[];
    expect(items.find(i => i.key === "LUDARR_API_KEY")).toMatchObject({ value: "••••••••", source: "saved" });
    expect(items.find(i => i.key === "SIGNUP")).toMatchObject({ value: "invite" });
    await http("PUT", "/api/v1/admin/settings", { LUDARR_API_KEY: "••••••••" }, admin.token);     // the mask sent back changes nothing
    expect(kv.get("cfg.LUDARR_API_KEY")).toBe("abc");
    // the engine's key and address are saved together by their own form, never one by one here (lockdown-limits: the engine's key)
    expect((await http("PUT", "/api/v1/admin/settings", { LUDARR_API_KEY: "other" }, admin.token)).status).toBe(400);
    expect(kv.get("cfg.LUDARR_API_KEY")).toBe("abc");
    expect((await http("PUT", "/api/v1/admin/settings", { NOPE: "x" }, admin.token)).status).toBe(500);
  });
});

describe("settings that apply at once", () => {
  test("Log level: the running logger follows a save; a choice that is not one of its options is refused and nothing is saved", async () => {
    const before = logLevel(), env = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL;
    try {
      const admin = await signup("yam");
      expect((await http("PUT", "/api/v1/admin/settings", { LOG_LEVEL: "debug" }, admin.token)).status).toBe(200);
      expect(logLevel()).toBe("debug");
      const bad = await http("PUT", "/api/v1/admin/settings", { SIGNUP: "closed", LOG_LEVEL: "verbose" }, admin.token);
      expect(bad.status).toBe(400);
      expect(bad.json.error).toMatch(/LOG_LEVEL/);
      expect(logLevel()).toBe("debug");
      expect(kv.get("cfg.LOG_LEVEL")).toBe("debug");
      expect(kv.get("cfg.SIGNUP")).not.toBe("closed");                                  // all or nothing
      expect((await http("PUT", "/api/v1/admin/settings", { SIGNUP: "everyone" }, admin.token)).status).toBe(400);
      expect((await http("PUT", "/api/v1/admin/settings", { LOG_LEVEL: "warn" }, admin.token)).status).toBe(200);
      expect(logLevel()).toBe("warn");
    } finally { setLogLevel(before); if (env != null) process.env.LOG_LEVEL = env; }
  });
});

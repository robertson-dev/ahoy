/** the server faces the internet: invite-only by default, a setup code guards the first (admin) account, sign-in is rate-limited. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { http, signup, wipe } from "./helpers";
import { kv } from "../src/db";
import { clearSetupCode, setupCode } from "../src/auth";
import { limits, _test as rl } from "../src/ratelimit";

beforeEach(() => wipe());

describe("who may join", () => {
  test("by default only with an invite code once the admin exists", async () => {
    kv.del("cfg.SIGNUP");
    const admin = await signup("skipper");
    expect((await http("GET", "/api/v1/auth/status")).json.policy).toBe("invite");
    expect((await http("POST", "/api/v1/auth/register", { name: "stranger", password: "secret123" })).status).toBe(403);
    const code = (await http("POST", "/api/v1/admin/invites", undefined, admin.token)).json.code as string;
    expect((await http("POST", "/api/v1/auth/register", { name: "friend", password: "secret123", invite: code.toLowerCase() })).status).toBe(403);   // exact code
    expect((await http("POST", "/api/v1/auth/register", { name: "friend", password: "secret123", invite: code })).status).toBe(200);
    expect((await http("POST", "/api/v1/auth/register", { name: "another", password: "secret123", invite: code })).status).toBe(403);   // one use
  });
});

describe("the setup code", () => {
  afterEach(() => clearSetupCode());
  test("guards the first account and is gone once it is used", async () => {
    kv.set("setup.code", "ABC123");
    expect((await http("GET", "/api/v1/auth/status")).json).toMatchObject({ policy: "first", setup: true });
    expect((await http("POST", "/api/v1/auth/register", { name: "skipper", password: "secret123" })).status).toBe(403);
    expect((await http("POST", "/api/v1/auth/register", { name: "skipper", password: "secret123", setup: "nope" })).status).toBe(403);
    const r = await http("POST", "/api/v1/auth/register", { name: "skipper", password: "secret123", setup: " abc123 " });
    expect(r.status).toBe(200);
    expect(r.json.user.role).toBe("admin");
    expect(setupCode()).toBeNull();
    expect((await http("GET", "/api/v1/auth/status")).json.setup).toBe(false);
  });
  test("a server that never made one (tests, upgrades) does not ask for it", async () => {
    expect((await http("GET", "/api/v1/auth/status")).json.setup).toBe(false);
    expect((await signup("skipper")).user.role).toBe("admin");
  });
});

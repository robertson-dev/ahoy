/** system: what members may learn about the engine, and the launcher feed the updater follows. */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, signup, wipe } from "./helpers";
import { latestLauncher } from "../src/api/system";

beforeEach(() => wipe());

describe("engine address", () => {
  test("the admin sees it, a member only whether it is up", async () => {
    const admin = await signup("skipper");
    const member = await signup("deckhand");
    const a = await http("GET", "/api/v1/system/status", undefined, admin.token);
    const m = await http("GET", "/api/v1/system/status", undefined, member.token);
    expect(a.status).toBe(200);
    expect(typeof a.json.ludarr.connected).toBe("boolean");
    expect(a.json.ludarr).toHaveProperty("url");
    expect(m.json.ludarr.url).toBeNull();
    expect(typeof m.json.ludarr.connected).toBe("boolean");
  });
  test("the admin settings (address and key) are not for members", async () => {
    await signup("skipper");
    const member = await signup("deckhand");
    expect((await http("GET", "/api/v1/admin/settings", undefined, member.token)).status).toBe(403);
    expect((await http("POST", "/api/v1/admin/ludarr/probe", { url: "http://x" }, member.token)).status).toBe(403);
  });
});

describe("launcher feed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahoy-launcher-"));
  const prev = process.env.AHOY_CONFIG;
  const publish = (files: Record<string, string>) => { for (const [n, body] of Object.entries(files)) writeFileSync(join(dir, "launcher", n), body); };
  test("latest.yml names the current build; without it the newest exe wins", async () => {
    process.env.AHOY_CONFIG = dir;
    try {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(dir, "launcher"), { recursive: true });
      publish({ "Ahoy-Setup-0.6.0.exe": "old", "Ahoy-Setup-0.7.0.exe": "new!" });
      utimesSync(join(dir, "launcher", "Ahoy-Setup-0.6.0.exe"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      expect((await latestLauncher())?.file).toBe("Ahoy-Setup-0.7.0.exe");
      publish({ "latest.yml": "version: 0.6.0\nfiles:\n  - url: Ahoy-Setup-0.6.0.exe\npath: Ahoy-Setup-0.6.0.exe\n" });
      const l = await latestLauncher();
      expect(l?.file).toBe("Ahoy-Setup-0.6.0.exe");
      expect(l?.version).toBe("0.6.0");
      // the feed files are public (the launcher's updater has no session of its own), everything else is not
      expect((await http("GET", "/launcher/latest.yml")).status).toBe(200);
      expect((await http("GET", "/launcher/Ahoy-Setup-0.6.0.exe")).status).toBe(200);
      expect((await http("GET", "/launcher/Ahoy-Setup-0.6.0.exe.blockmap")).status).toBe(404);   // not published → 404, but the name itself is allowed
      expect((await http("GET", "/launcher/..%2Fahoy-app.db")).status).toBe(404);
      expect((await http("GET", "/launcher/notes.txt")).status).toBe(404);
    } finally { if (prev === undefined) delete process.env.AHOY_CONFIG; else process.env.AHOY_CONFIG = prev; }
  });
});

/**
 * The engine's former name (src/former.ts): an Ahoy set up when the engine was called playarr keeps its connection.
 */
import { describe, expect, test } from "bun:test";
import { adoptFormerEnv, adoptFormerKeys, FORMER_ART_MARK } from "../src/former";

const store = (rows: Record<string, string>) => ({ rows, get: (k: string) => rows[k] ?? null, set: (k: string, v: string) => { rows[k] = v; } });

describe("the engine's former name", () => {
  test("the old variables count as the new ones; a new one that is set wins", () => {
    const env: Record<string, string | undefined> = { PLAYARR_URL: "http://engine:7979", PLAYARR_API_KEY: "old", LUDARR_API_KEY: "new" };
    adoptFormerEnv(env);
    expect(env).toMatchObject({ LUDARR_URL: "http://engine:7979", LUDARR_API_KEY: "new" });
  });
  test("the saved address, key and library snapshot are copied to their new names once, and the old rows stay", () => {
    const s = store({ "cfg.PLAYARR_URL": "http://engine:7979", "cfg.PLAYARR_API_KEY": "k3y", "playarr.games": "[1]" });
    expect(adoptFormerKeys(s)).toEqual(["cfg.LUDARR_URL", "cfg.LUDARR_API_KEY", "ludarr.games"]);
    expect(s.rows).toMatchObject({ "cfg.LUDARR_URL": "http://engine:7979", "cfg.LUDARR_API_KEY": "k3y", "ludarr.games": "[1]", "cfg.PLAYARR_URL": "http://engine:7979" });
    s.rows["cfg.LUDARR_API_KEY"] = "changed";
    expect(adoptFormerKeys(s)).toEqual([]);                                   // what is there under the new name is never overwritten
    expect(s.rows["cfg.LUDARR_API_KEY"]).toBe("changed");
  });
  test("a fresh server has nothing to copy", () => {
    expect(adoptFormerKeys(store({}))).toEqual([]);
  });
  test("the old placeholder header", () => {
    expect(FORMER_ART_MARK).toBe("x-playarr-art");
  });
});

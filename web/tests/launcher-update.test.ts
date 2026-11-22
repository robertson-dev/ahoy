/**
 * Settings → This PC, the launcher's own update line (bun test, in web/): what each state the launcher reports reads as, and
 * whether "Check now" is offered with it. Both are pure (launcher.ts); the module reads the page's `window` as it loads,
 * which bun has not, so the global stands in for it first.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { UpdateState } from "../src/launcher";

let updateLine: typeof import("../src/launcher").updateLine;
let updateCheckable: typeof import("../src/launcher").updateCheckable;
beforeAll(async () => {
  (globalThis as { window?: unknown }).window ??= globalThis;
  ({ updateLine, updateCheckable } = await import("../src/launcher"));
});

const state = (status: string, over: Partial<UpdateState> = {}): UpdateState => ({ status: status as UpdateState["status"], version: null, percent: 0, error: null, checkedAt: null, ...over });

describe("the launcher's update line", () => {
  test("updates being off is said in the launcher's own words, not as an update that failed, and there is nothing to check", () => {
    const off = state("off", { error: "Updates are off: this server's address is not https" });
    expect(updateLine(off)).toEqual({ text: "Updates are off: this server's address is not https" });      // no `bad`: not red
    expect(updateCheckable(off)).toBe(false);
    expect(updateLine(state("off"))).toEqual({ text: "Updates are off" });                                  // a launcher that gives no reason
  });
  test("an update that failed is red, with what the updater said for the pointer, and can be tried again", () => {
    const failed = state("error", { error: "net::ERR_CONNECTION_RESET" });
    expect(updateLine(failed)).toEqual({ text: "The update didn't make it", bad: true, detail: "net::ERR_CONNECTION_RESET" });
    expect(updateCheckable(failed)).toBe(true);
  });
  test("the other states read as before; Check now is offered unless a build is arriving or waiting for the restart", () => {
    expect(updateLine(null)).toBeNull();
    expect(updateLine(state("idle"))).toBeNull();
    expect(updateLine(state("none"))).toEqual({ text: "Up to date" });
    expect(updateLine(state("none", { checkedAt: Date.now() }))).toEqual({ text: "Up to date · checked just now" });
    expect(updateLine(state("checking"))).toEqual({ text: "Checking for an update" });
    expect(updateLine(state("available", { version: "0.12.0" }))).toEqual({ text: "0.12.0 is on its way" });
    expect(updateLine(state("downloading", { version: "0.12.0", percent: 41.6 }))).toEqual({ text: "Downloading 0.12.0 · 42%" });
    expect(updateLine(state("ready", { version: "0.12.0" }))).toEqual({ text: "0.12.0 is ready" });
    expect(["idle", "none", "checking", "error"].map(s => updateCheckable(state(s)))).toEqual([true, true, true, true]);
    expect(["available", "downloading", "ready", "off"].map(s => updateCheckable(state(s)))).toEqual([false, false, false, false]);
  });
  test("a state this page does not know (a newer launcher's) says nothing", () => {
    expect(updateLine(state("paused"))).toBeNull();
  });
});

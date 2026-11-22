/**
 * The page's Update for a copy whose start the server changed in place (bun test, in web/). planAction is pure; the modules
 * around it read the page's `window` as they load, which bun has not, so the global stands in for it first.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { Game } from "../src/api";
import type { InstalledGame } from "../src/launcher";

let planAction: typeof import("../src/ui/game-action").planAction;
let NOTE: typeof import("../src/ui/game-action").NOTE;
let newerCopy: typeof import("../src/launcher").newerCopy;
let olderThan: typeof import("../src/launcher").olderThan;
beforeAll(async () => {
  (globalThis as { window?: unknown }).window ??= globalThis;
  ({ planAction, NOTE } = await import("../src/ui/game-action"));
  ({ newerCopy, olderThan } = await import("../src/launcher"));
});

const T1 = 1731170000000, T2 = 1731170099999;
/** the library's game: package `id`, its start last changed at `launchRev` (absent: never) */
const game = (id: number, launchRev?: number | string | null) => ({
  id: 7, name: "Demon's Souls", status: "available", request: null, monitored: true, tracked: false,
  file: { id, path: "", size: 58e9, version: "20261108", launch: null, files: 32, importer: null, release: null, group: null, format: "folder", addedAt: 1, kind: "emulated", requiresLauncher: "0.10.0", ...(launchRev !== undefined ? { launchRev } : {}) },
}) as unknown as Game;
/** this PC's copy of package `packageId`, recorded with the start's stamp `rev` (absent: installed before any change) */
const copy = (packageId: number, rev?: number | string | null): InstalledGame => ({
  slug: "demons-souls", gameId: 7, packageId, name: "Demon's Souls", version: "20261108", path: "C:\\Games\\Ahoy\\demons-souls",
  launch: { exe: "KytyLauncher.exe", args: "--play", cwd: "", argv: ["--play"], ...(rev !== undefined ? { rev } : {}) },
  kind: "emulated", platform: "ps5", sizeBytes: 58e9, installedAt: 1, serverUrl: "http://ahoy:8790",
});
const main = (g: Game, inst: InstalledGame, refreshes: boolean, running = false) => planAction({ game: g, inst, canArgv: true, refreshes, running }).main?.label;

describe("a copy that needs a newer Ahoy than this PC has", () => {
  test("held by the launcher's version against what the copy needs: told to update Ahoy, never offered an Install or Update that would fail", () => {
    expect([olderThan("0.10.0", "0.11.0"), olderThan("0.11.0", "0.11.0"), olderThan("0.11.2", "0.11.0"), olderThan("1.0.0", "0.11.0"), olderThan("0.9", "0.10.0")]).toEqual([true, false, false, false, true]);
    expect([olderThan(null, "0.11.0"), olderThan("0.10.0", null), olderThan("soon", "0.11.0"), olderThan("0.10.0", "soon")]).toEqual([false, false, false, false]);
    // a game that starts through its own script needs 0.11: on 0.10 its changed start is not offered as an Update, and Play stays
    const scripted = { ...game(43, T1), file: { ...game(43, T1).file!, requiresLauncher: "0.11.0" } } as Game;
    const on10 = planAction({ game: scripted, inst: copy(43), canArgv: true, launcherVersion: "0.10.0", refreshes: false });
    expect([on10.main?.label, on10.more.map(a => a.kind)]).toEqual(["Play", ["folder", "uninstall"]]);
    // not installed yet on 0.10: the note, and no Install
    const fresh = planAction({ game: scripted, canArgv: true, launcherVersion: "0.10.0", refreshes: false });
    expect([fresh.main, fresh.note]).toEqual([null, NOTE.launcher]);
    // on 0.11 it is Install, and a changed start is taken at Play
    expect(planAction({ game: scripted, canArgv: true, launcherVersion: "0.11.0", refreshes: true }).main?.label).toBe("Install");
    expect(planAction({ game: scripted, inst: copy(43), canArgv: true, launcherVersion: "0.11.0", refreshes: true, server: "http://ahoy:8790" }).main?.label).toBe("Play");
  });
});

describe("Update for a start changed in place", () => {
  test("a launcher that does not take a changed start at Play is offered Update when the stamp differs, with Play still at hand", () => {
    const plan = planAction({ game: game(43, T1), inst: copy(43), canArgv: true, refreshes: false });
    expect(plan.main).toMatchObject({ kind: "install", label: "Update" });
    expect(plan.more.map(a => a.kind)).toEqual(["play", "folder", "uninstall"]);
    expect(main(game(43, T2), copy(43, T1), false)).toBe("Update");               // changed again since
  });
  test("…and not otherwise: the stamp it has, a number and its text, a start never changed, a server that sends no stamp", () => {
    expect(main(game(43, T1), copy(43, T1), false)).toBe("Play");
    expect(main(game(43, String(T1)), copy(43, T1), false)).toBe("Play");
    expect(main(game(43, null), copy(43), false)).toBe("Play");
    expect(main(game(43), copy(43, T1), false)).toBe("Play");
  });
  test("a launcher that takes a changed start at Play (launch-refresh) is never offered Update for it", () => {
    expect(main(game(43, T1), copy(43), true)).toBe("Play");
    expect(main(game(43, T2), copy(43, T1), true)).toBe("Play");
  });
  test("another package is an Update whatever the launcher; a running game shows Running", () => {
    expect(main(game(44, T1), copy(43, T1), true)).toBe("Update");
    expect(main(game(44), copy(43), false)).toBe("Update");
    expect(main(game(43, T2), copy(43, T1), false, true)).toBe("Running");
  });
  test("a copy recorded under another server address is offered Update by a launcher that takes changed starts (it asks only its own server)", () => {
    const here = "http://ahoy:8790", old = "http://192.168.1.20:7979";
    const plan = (g: Game, inst: InstalledGame, server: string | null) => planAction({ game: g, inst, canArgv: true, refreshes: true, server }).main?.label;
    expect(plan(game(43, T2), { ...copy(43, T1), serverUrl: old }, here)).toBe("Update");
    expect(newerCopy(game(43, T2), { ...copy(43), serverUrl: old }, true, here)).toBe(true);
    expect(plan(game(43, T2), copy(43, T1), here)).toBe("Play");                                  // its own: Play takes it
    expect(plan(game(43, T2), { ...copy(43, T1), serverUrl: `${here}/` }, here)).toBe("Play");    // a slash aside, the same
    expect(plan(game(43, T2), copy(43, T1), `${here}/`)).toBe("Play");
    expect(plan(game(43, T2), { ...copy(43, T1), serverUrl: old }, null)).toBe("Play");          // the address not known yet
    expect(plan(game(43, T1), { ...copy(43, T1), serverUrl: old }, here)).toBe("Play");          // nothing changed
    expect(planAction({ game: game(43, T2), inst: { ...copy(43, T1), serverUrl: old }, canArgv: true, refreshes: false, server: here }).main?.label).toBe("Update");
  });
  test("a copy whose changed start Play could not take (the launcher noted it on the copy) is offered Update; a note about another start is not", () => {
    const here = "http://ahoy:8790";
    const plan = (inst: InstalledGame) => planAction({ game: game(43, T2), inst, canArgv: true, refreshes: true, server: here }).main?.label;
    expect(plan({ ...copy(43, T1), skippedRev: T2 })).toBe("Update");
    expect(plan({ ...copy(43, T1), skippedRev: String(T2) })).toBe("Update");
    expect(plan({ ...copy(43, T1), skippedRev: 1731170055555 })).toBe("Play");
    expect(plan({ ...copy(43, T1), skippedRev: null })).toBe("Play");
    // taken by an Update since: the same stamp as the server's, nothing newer
    expect(planAction({ game: game(43, T2), inst: { ...copy(43, T2), skippedRev: T2 }, canArgv: true, refreshes: true, server: here }).main?.label).toBe("Play");
  });
  test("nothing on this PC or on the server: nothing newer", () => {
    expect(newerCopy(game(43, T1), undefined, false)).toBe(false);
    expect(newerCopy({ file: null }, copy(43), false)).toBe(false);
    expect(newerCopy(undefined, copy(43), false)).toBe(false);
  });
});

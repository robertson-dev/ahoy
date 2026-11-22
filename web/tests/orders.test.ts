/**
 * Your PCs and what is to be installed on them (bun test, in web/): what a PC does about one of its orders (orders.ts
 * orderStep), how an order reads (orderWords, orderLine), how my PCs stand to a game (pcStates), and what a game offers when
 * I have other PCs, or no PC here at all (ui/game-action planAction).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import "./harness";
import type { Game } from "../src/api";
import type { InstalledGame } from "../src/launcher";
import { ORDER_FAIL, ROOM_MARGIN, orderLine, orderStep, orderWords, pcStates, type Order, type Pc, type PcState, type StepCtx } from "../src/orders";

let planAction: typeof import("../src/ui/game-action").planAction;
beforeAll(async () => { ({ planAction } = await import("../src/ui/game-action")); });

const GB = 1e9;
const ready = (over: Record<string, unknown> = {}, file: Record<string, unknown> = {}) => ({
  id: 7, name: "Hades", status: "available", statusDetail: "", monitored: true, tracked: false, hasFile: true, comingSoon: false, releaseIso: null, request: null,
  file: { id: 70, path: "", size: 10 * GB, version: "1.0", launch: null, files: 3, importer: null, release: null, group: null, format: "folder", addedAt: 1, ...file },
  people: { requestedBy: [], owners: [], playing: [] }, ...over,
}) as unknown as Game;
const moving = () => ready({ status: "downloading", hasFile: false, file: null, request: { id: 9, gameId: 7, state: "downloading", stage: "Downloading", progress: 0.4, message: null, release: null, attempt: 1, candidates: 1, createdAt: 1, updatedAt: 1, doneAt: null }, may: { cancel: true } });
const order = (over: Partial<Order> = {}): Order => ({ id: 1, device: "COUCH", gameId: 7, name: "Hades", origin: "asked", state: "waiting", progress: 0, error: null, from: null, createdAt: 1, updatedAt: 1, ...over });
const ctx = (over: Partial<StepCtx> = {}): StepCtx => ({ flying: false, busy: false, free: 500 * GB, canArgv: true, launcherVersion: "0.13.0", refreshes: true, server: "http://ahoy", ...over });
const inst = (packageId: number): InstalledGame => ({ slug: "hades", gameId: 7, packageId, name: "Hades", version: "1.0", path: "D:/Games/hades", launch: { exe: "hades.exe", args: "", cwd: "" }, kind: "native", platform: null, sizeBytes: 1, installedAt: 1, serverUrl: "http://ahoy" });

describe("what a PC does about one of its orders", () => {
  test("a game with a copy is installed; one still on its way waits for it", () => {
    expect(orderStep(order(), ready(), ctx())).toEqual({ do: "install", packageId: 70 });
    expect(orderStep(order(), moving(), ctx())).toEqual({ do: "wait" });
    expect(orderStep(order(), undefined, ctx())).toEqual({ do: "wait" });
  });
  test("one at a time: while this PC installs something else, it waits its turn", () => {
    expect(orderStep(order(), ready(), ctx({ busy: true }))).toEqual({ do: "wait" });
  });
  test("an install of that game already running here is followed, never started twice", () => {
    expect(orderStep(order(), ready(), ctx({ flying: true, busy: true }))).toEqual({ do: "follow", packageId: 70 });
    expect(orderStep(order({ state: "installing", progress: 0.3 }), ready(), ctx({ flying: true }))).toEqual({ do: "follow", packageId: 70 });
  });
  test("one that was installing when the launcher closed is taken up again", () => {
    expect(orderStep(order({ state: "installing", progress: 0.3 }), ready(), ctx())).toEqual({ do: "install", packageId: 70 });
  });
  test("a game already here in its current copy is done; an older copy here is installed over", () => {
    expect(orderStep(order(), ready(), ctx({ inst: inst(70) }))).toEqual({ do: "done" });
    expect(orderStep(order(), ready(), ctx({ inst: inst(69) }))).toEqual({ do: "install", packageId: 70 });
    // here, and the server's copy is gone or being replaced: still here
    expect(orderStep(order(), moving(), ctx({ inst: inst(69) }))).toEqual({ do: "done" });
  });
  test("no room: it fails with words for whoever placed it; an update needs no such room, and no answer is no refusal", () => {
    expect(orderStep(order(), ready(), ctx({ free: 10 * GB }))).toEqual({ do: "fail", error: ORDER_FAIL.room });
    expect(orderStep(order(), ready(), ctx({ free: 10 * GB + ROOM_MARGIN }))).toEqual({ do: "install", packageId: 70 });
    expect(orderStep(order(), ready(), ctx({ free: 1, inst: inst(69) }))).toEqual({ do: "install", packageId: 70 });
    expect(orderStep(order(), ready(), ctx({ free: null }))).toEqual({ do: "install", packageId: 70 });
  });
  test("a console dump, and a copy this launcher is too old for, are refused in words that fit another device", () => {
    expect(orderStep(order(), ready({}, { kind: "rom" }), ctx())).toEqual({ do: "fail", error: ORDER_FAIL.rom });
    expect(orderStep(order(), ready({}, { requiresLauncher: "0.14.0" }), ctx())).toEqual({ do: "fail", error: ORDER_FAIL.launcher });
    expect(orderStep(order(), ready({}, { requiresLauncher: "0.10.0" }), ctx({ canArgv: false }))).toEqual({ do: "fail", error: ORDER_FAIL.launcher });
    expect(orderStep(order(), ready({}, { requiresLauncher: "0.13.0" }), ctx())).toEqual({ do: "install", packageId: 70 });
    for (const e of Object.values(ORDER_FAIL)) expect(e).not.toMatch(/this PC/i);
  });
  test("an order that ended is left alone", () => {
    for (const state of ["done", "failed"] as const) expect(orderStep(order({ state }), ready(), ctx())).toEqual({ do: "wait" });
  });
});

describe("how an order reads", () => {
  test("beside its PC's name", () => {
    expect(orderWords(order({ state: "installing", progress: 0.476 }), true, true)).toBe("Installing 48%");
    expect(orderWords(order(), true, true)).toBe("Starting");
    expect(orderWords(order(), false, true)).toBe("When it's on");
    expect(orderWords(order(), true, false)).toBe("When it arrives");
    expect(orderWords(order(), false, false)).toBe("When it arrives");
    expect(orderWords(order({ state: "failed", error: "Not enough room" }), true, true)).toBe("Not enough room");
    expect(orderWords(order({ state: "failed" }), true, true)).toBe("Didn't install");
    expect(orderWords(order({ state: "done" }), true, true)).toBe("Installed");
  });
  test("as one line that names the PC", () => {
    expect(orderLine(order({ state: "installing", progress: 0.48 }), true, true)).toBe("Installing on COUCH 48%");
    expect(orderLine(order(), false, true)).toBe("Waiting for COUCH");
    expect(orderLine(order(), true, true)).toBe("Starting on COUCH");
    expect(orderLine(order(), false, false)).toBe("Installs on COUCH when it arrives");
    expect(orderLine(order({ state: "failed", error: "Not enough room" }), true, true)).toBe("COUCH: Not enough room");
    expect(orderLine(order({ state: "done" }), true, true)).toBe("Installed on COUCH");
  });
});

describe("how my PCs stand to a game", () => {
  const pc = (device: string, on = false): Pc => ({ device, version: "0.13.0", auto: true, freeBytes: null, seenAt: 1, on, games: 0 });
  test("which have it, which are to get it; this PC by the launcher's own word, and always on", () => {
    const s = pcStates(7, [pc("DESK"), pc("COUCH", true), pc("LAPTOP")], [order({ id: 3, device: "LAPTOP", state: "failed", error: "Not enough room" }), order({ id: 2, device: "COUCH", gameId: 8 }), order({ id: 1, device: "COUCH" })],
      [{ device: "DESK", gameId: 7 }, { device: "LAPTOP", gameId: 9 }], "DESK", false);
    expect(s.map(p => [p.device, p.here, p.on, p.has, p.order?.id ?? null])).toEqual([["DESK", true, true, false, null], ["COUCH", false, true, false, 1], ["LAPTOP", false, false, false, 3]]);
    expect(pcStates(7, [pc("DESK")], [], [], "DESK", true)[0].has).toBe(true);
    // an open order outranks an older failed one for the same PC
    expect(pcStates(7, [pc("COUCH")], [order({ id: 5, state: "failed" }), order({ id: 6, state: "waiting" })], [], null, false)[0].order?.id).toBe(6);
  });
});

describe("a game, when I have other PCs", () => {
  const st = (device: string, over: Partial<PcState> = {}): PcState => ({ device, here: false, on: true, has: false, order: null, ...over });
  test("in the launcher: this PC's own action stays, and my other PCs are offered beside it", () => {
    const plan = planAction({ game: ready(), canArgv: true, launcherVersion: "0.13.0", pcs: [st("DESK", { here: true }), st("COUCH")] });
    expect(plan.main).toMatchObject({ kind: "install", label: "Install" });
    expect(plan.elsewhere?.map(p => p.device)).toEqual(["COUCH"]);
    expect(planAction({ game: ready(), canArgv: true, pcs: [st("DESK", { here: true })] }).elsewhere).toEqual([]);
    const here = planAction({ game: ready(), inst: inst(70), canArgv: true, pcs: [st("DESK", { here: true, has: true }), st("COUCH")] });
    expect(here.main).toMatchObject({ kind: "play" });
    expect(here.elsewhere?.map(p => p.device)).toEqual(["COUCH"]);
  });
  test("a game still on its way can be told to install anywhere, this PC too", () => {
    const plan = planAction({ game: moving(), canArgv: true, pcs: [st("DESK", { here: true }), st("COUCH")] });
    expect(plan.main).toMatchObject({ kind: "cancel" });
    expect(plan.main?.orderId).toBeUndefined();
    expect(plan.elsewhere?.map(p => p.device)).toEqual(["DESK", "COUCH"]);
  });
  test("no PC here (a phone) and one PC of mine: the action names it, then says how it goes there", () => {
    const plain = planAction({ game: ready(), remote: true, pcs: [st("COUCH")] });
    expect(plain.main).toMatchObject({ kind: "install-on", label: "Install on COUCH", device: "COUCH" });
    const waiting = planAction({ game: ready(), remote: true, pcs: [st("COUCH", { on: false, order: order() })] });
    expect(waiting.main).toMatchObject({ kind: "cancel", orderId: 1 });
    expect(waiting.status).toBe("Waiting for COUCH");
    const going = planAction({ game: ready(), remote: true, pcs: [st("COUCH", { order: order({ state: "installing", progress: 0.48 }) })] });
    expect(going.status).toBe("Installing on COUCH 48%");
    const failed = planAction({ game: ready(), remote: true, pcs: [st("COUCH", { order: order({ state: "failed", error: "Not enough room" }) })] });
    expect(failed.main).toMatchObject({ kind: "install-on", label: "Try again", device: "COUCH" });
    expect(failed.status).toBe("COUCH: Not enough room");
    const there = planAction({ game: ready(), remote: true, pcs: [st("COUCH", { has: true })] });
    expect(there.main).toBeNull();
    expect(there.note).toBe("On COUCH");
  });
  test("no PC here and several of mine: the chooser, with the furthest install's line", () => {
    const plan = planAction({ game: ready(), remote: true, pcs: [st("DESK", { order: order({ device: "DESK", state: "installing", progress: 0.2 }) }), st("COUCH", { order: order({ state: "installing", progress: 0.7 }) })] });
    expect(plan.main).toMatchObject({ kind: "install-on", label: "Install on…" });
    expect(plan.main?.device).toBeUndefined();
    expect(plan.status).toBe("Installing on COUCH 70%");
    expect(planAction({ game: ready(), remote: true, pcs: [st("DESK", { has: true }), st("COUCH", { has: true })] })).toMatchObject({ main: null, note: "On your PCs" });
  });
  test("no PC here and none of mine: the launcher's download, as before", () => {
    expect(planAction({ game: ready(), remote: true }).main).toMatchObject({ kind: "install", label: "Install" });
  });
  test("a console dump is offered to no PC", () => {
    const plan = planAction({ game: ready({}, { kind: "rom" }), remote: true, pcs: [st("COUCH")] });
    expect(plan.main).toBeNull();
    expect(plan.elsewhere ?? []).toEqual([]);
  });
});

/**
 * A game's saves in step between PCs (bun test, in web/): what moves when (saves.ts decide), the game's key, and the words
 * the page says about it (saves.ts placeWords; saves-state.tsx saveWords, whenWords).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import "./harness";
import { decide, placeWords, saveKey, type SaveState, type Snap } from "../src/saves";

let saveWords: typeof import("../src/saves-state").saveWords;
let whenWords: typeof import("../src/saves-state").whenWords;
beforeAll(async () => { ({ saveWords, whenWords } = await import("../src/saves-state")); });

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
const snap = (digest: string, over: Partial<Snap> = {}): Snap => ({ id: 3, key: "a1145360", gameId: 7, name: "Hades", device: "COUCH", digest, files: 2, bytes: 1200, size: 600, newest: null, at: Math.floor(Date.now() / 1000) - 7200, ...over });

describe("what moves", () => {
  test("nothing on the server yet: this PC's saves go up, when it has any", () => {
    expect(decide(A, null, null)).toEqual({ do: "push" });
    expect(decide(null, null, null)).toEqual({ do: "nothing" });
  });
  test("this PC has what the server has: nothing moves; they agree from now when they did not know it", () => {
    expect(decide(A, A, snap(A))).toEqual({ do: "nothing" });
    expect(decide(A, null, snap(A))).toEqual({ do: "agree", head: snap(A) });
    expect(decide(A, B, snap(A))).toEqual({ do: "agree", head: snap(A) });
  });
  test("no saves here: the server's come down (a fresh install, a second PC)", () => {
    expect(decide(null, null, snap(A))).toEqual({ do: "pull", head: snap(A) });
    expect(decide(null, B, snap(A))).toEqual({ do: "pull", head: snap(A) });
  });
  test("only this PC changed since they agreed: its saves go up", () => {
    expect(decide(B, A, snap(A))).toEqual({ do: "push" });
  });
  test("only the server changed since they agreed: its saves come down", () => {
    expect(decide(A, A, snap(B))).toEqual({ do: "pull", head: snap(B) });
  });
  test("both changed, or they never agreed: the player chooses", () => {
    expect(decide(C, A, snap(B))).toEqual({ do: "ask", head: snap(B) });
    expect(decide(A, null, snap(B))).toEqual({ do: "ask", head: snap(B) });
  });
});

describe("the game's key", () => {
  test("its Steam app id when it has one, else its id on this server", () => {
    expect(saveKey({ id: 31, steamAppId: 1145360 })).toBe("a1145360");
    expect(saveKey({ id: 31, steamAppId: null })).toBe("g31");
    expect(saveKey({ id: 31, steamAppId: 0 })).toBe("g31");
  });
});

describe("the words", () => {
  test("a place of the PC as a person reads it", () => {
    expect(placeWords("<winDocuments>/Saved Games/Hades")).toBe("Documents\\Saved Games\\Hades");
    expect(placeWords("<winAppData>/Goldberg SteamEmu Saves/1145360")).toBe("AppData\\Roaming\\Goldberg SteamEmu Saves\\1145360");
    expect(placeWords("<home>/AppData/LocalLow/Team Cherry/Hollow Knight/*.dat")).toBe("Your user folder\\AppData\\LocalLow\\Team Cherry\\Hollow Knight\\*.dat");
    expect(placeWords("<base>/**/7/remote")).toBe("The game's folder\\7\\remote");
    expect(placeWords("<base>")).toBe("The game's folder");
  });
  test("how a game's saves stand", () => {
    const at = { here: true, on: true, can: true, device: "DESK" };
    const head = snap(A);
    expect(saveWords({ is: "synced", head }, head, at)).toBe("From COUCH · 2 h ago");
    expect(saveWords({ is: "synced", head: snap(A, { device: "DESK" }) }, head, at)).toBe("Kept 2 h ago");
    expect(saveWords({ is: "checking" }, null, at)).toBe("Checking");
    expect(saveWords({ is: "none" }, null, at)).toBe("None yet");
    expect(saveWords({ is: "choose", head, local: {} as SaveState }, head, at)).toBe("Two different saves");
    expect(saveWords({ is: "too-big" }, null, at)).toBe("Too large to keep in step");
    expect(saveWords({ is: "waiting" }, null, at)).toBe("Not kept yet");
    expect(saveWords({ is: "waiting" }, head, at)).toBe("From COUCH · 2 h ago");
    // this PC does not keep them in step: said so, with what the server has
    expect(saveWords(null, null, { ...at, on: false })).toBe("Off on this PC");
    expect(saveWords(null, head, { ...at, on: false })).toBe("From COUCH · 2 h ago · off on this PC");
    // not on this PC, or no launcher here: only what the server has, when it has any
    expect(saveWords(null, head, { ...at, here: false })).toBe("From COUCH · 2 h ago");
    expect(saveWords(null, null, { ...at, here: false })).toBeNull();
    expect(saveWords(null, head, { here: false, on: false, can: false, device: "browser" })).toBe("From COUCH · 2 h ago");
  });
  test("when a set of saves was last written", () => {
    const now = new Date(2026, 10, 11, 20, 0, 0).getTime();
    expect(whenWords(new Date(2026, 10, 11, 18, 2).getTime(), now)).toBe("Today 18:02");
    expect(whenWords(new Date(2026, 10, 10, 21, 40).getTime(), now)).toBe("Yesterday 21:40");
    expect(whenWords(new Date(2026, 10, 3, 9, 5).getTime(), now)).toBe("Nov 3 09:05");
    expect(whenWords(new Date(2025, 11, 24, 9, 5).getTime(), now)).toBe("Dec 24, 2025 09:05");
    expect(whenWords(null, now)).toBe("Not played yet");
  });
});

/**
 * The big screen's pad and keys (bun test, in web/): what one press is (big/nav.ts listenInput), and that the screen listens
 * once for its whole stay (big/index.tsx useInput). (Uninstall asks first there as everywhere: the big screen is the app's own
 * pages, so the question is the app's own.)
 * The pad, the frames and the clock are stood in for: `press` and `release` set what the pad reports, `frames` runs that many
 * animation frames, `clock` is the time they see.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mount, pageState } from "./harness";
import type { Cmd } from "../src/big/nav";

let nav: typeof import("../src/big/nav");
let big: typeof import("../src/big/index");

const g = globalThis as Record<string, any>;
const real: Record<string, unknown> = {};
/** the pad: which buttons are down (by index: 0 A, 1 B, 13 d-pad down), and the left stick */
let down = new Set<number>(), stick: [number, number] = [0, 0];
let frame: (() => void) | null = null;
let clock = 0;
/** keydown listeners now on the page, and how many were ever added */
let keys: ((e: unknown) => void)[] = [], added = 0;
const press = (...b: number[]) => { for (const x of b) down.add(x); };
const release = (...b: number[]) => { for (const x of b) down.delete(x); };
/** run `n` animation frames, 16 ms apart */
const frames = (n = 1) => { for (let i = 0; i < n; i++) { clock += 16; const f = frame; frame = null; f?.(); } };

beforeAll(async () => {
  for (const k of ["requestAnimationFrame", "cancelAnimationFrame", "addEventListener", "removeEventListener"]) real[k] = g[k];
  real.now = performance.now; real.pads = (navigator as any).getGamepads;
  g.requestAnimationFrame = (f: () => void) => { frame = f; return 1; };
  g.cancelAnimationFrame = () => { frame = null; };
  g.addEventListener = (name: string, f: (e: unknown) => void) => { if (name === "keydown") { keys.push(f); added++; } };
  g.removeEventListener = (name: string, f: (e: unknown) => void) => { if (name === "keydown") keys = keys.filter(x => x !== f); };
  performance.now = () => clock;
  (navigator as any).getGamepads = () => [{ buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: down.has(i) })), axes: stick }];
  nav = await import("../src/big/nav");
  big = await import("../src/big/index");
});
afterAll(() => {
  for (const k of ["requestAnimationFrame", "cancelAnimationFrame", "addEventListener", "removeEventListener"]) g[k] = real[k];
  performance.now = real.now as typeof performance.now; (navigator as any).getGamepads = real.pads;
});
beforeEach(() => { down = new Set(); stick = [0, 0]; frame = null; keys = []; added = 0; pageState.focused = true; pageState.hidden = false; });
afterEach(() => { pageState.focused = true; pageState.hidden = false; });

/** listen, with every command collected */
function listen() {
  const got: Cmd[] = [];
  const off = nav.listenInput(c => got.push(c), () => false, () => {});
  return { got, off };
}

describe("one press of a pad button", () => {
  test("is one command, however long it is held; let go and pressed again, another", () => {
    const { got, off } = listen();
    frames(2);
    press(0); frames(40);                        // A held for two thirds of a second
    expect(got).toEqual(["ok"]);
    release(0); frames(2); press(0); frames(5);
    expect(got).toEqual(["ok", "ok"]);
    off();
  });

  test("a direction repeats while it is held: after 360 ms, then every 100", () => {
    const { got, off } = listen();
    frames(1);
    press(13); frames(1);
    expect(got).toEqual(["down"]);
    frames(21);                                  // 336 ms on
    expect(got).toEqual(["down"]);
    frames(2);                                   // past 360
    expect(got).toEqual(["down", "down"]);
    frames(7);                                   // 112 ms more
    expect(got).toEqual(["down", "down", "down"]);
    off();
  });

  test("a button already down when listening starts is not a press: it counts once let go and pressed again", () => {
    press(0, 13);                                // A and Down are held as the listener starts
    const { got, off } = listen();
    frames(60);                                  // a second: no press, and the held direction does not start repeating
    expect(got).toEqual([]);
    release(0, 13); frames(1); press(0); frames(3);
    expect(got).toEqual(["ok"]);
    off();
  });
});

describe("a window that is not in front", () => {
  test("does not hear the pad (a game played beside it would drive it)", () => {
    const { got, off } = listen();
    frames(2);
    pageState.focused = false;
    press(0); frames(5); release(0); frames(2); press(13); frames(40); release(13); frames(2);
    expect(got).toEqual([]);
    pageState.focused = true; pageState.hidden = true;
    press(1); frames(5); release(1); frames(2);
    expect(got).toEqual([]);
    off();
  });

  test("a button still down when the window comes back was pressed for the game, not for it", () => {
    const { got, off } = listen();
    frames(2);
    pageState.focused = false;
    press(0, 13); frames(10);                    // A and Down held in the game…
    pageState.focused = true;
    frames(60);                                  // …and still held as the window comes back
    expect(got).toEqual([]);
    release(0, 13); frames(1); press(0); frames(2);
    expect(got).toEqual(["ok"]);
    off();
  });
});

describe("the big screen's listener", () => {
  test("is one for the whole stay: a page that changes while A is down does not hear A again, and the newest handlers get what comes", async () => {
    const heard: string[] = [];
    let page = "home";                           // what the screen shows now: its handlers change with it, as with a layer or the search
    const m = await mount(() => big.useInput(c => heard.push(`${page}:${c}`), () => false, () => {}));
    frames(2);
    press(0); frames(3);
    expect(heard).toEqual(["home:ok"]);
    // A opened a game: the layer changed while A is still down (a press lasts many frames), then the page changes again
    page = "game"; await m.rerender(); frames(10);
    page = "game2"; await m.rerender(); frames(10);
    expect(heard).toEqual(["home:ok"]);
    expect(added).toBe(1);                       // it listened once…
    expect(keys.length).toBe(1);                 // …and never stopped
    release(0); frames(1); press(1); frames(2);
    expect(heard).toEqual(["home:ok", "game2:back"]);
    await m.unmount();
    expect(keys.length).toBe(0);
  });
});

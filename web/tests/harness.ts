/**
 * Hooks without a browser (bun test, in web/). react-dom mounts a component that draws nothing into a stand-in for a page
 * element, so a hook's state and effects run as they do on the page; `act` waits for them. The page's globals the modules read
 * (`window`, `document`) are stood in for here: import this before anything from ../src.
 * Also here: the server as a test scripts it (`fakeServer`: answers by path, every call recorded, an answer held back until the
 * test lets it go) and a browser's EventSource the test can speak through (`FakeEventSource`).
 */
import { act, createElement, type ReactElement } from "react";

const g = globalThis as Record<string, any>;
g.window ??= globalThis;
g.IS_REACT_ACT_ENVIRONMENT = true;
/** the page's focus and visibility, as tests set them */
export const pageState = { focused: true, hidden: false };
const noEvents = () => ({ addEventListener() {}, removeEventListener() {} });
g.document ??= { ...noEvents(), activeElement: null, body: null, get hidden() { return pageState.hidden; }, hasFocus: () => pageState.focused };
g.HTMLIFrameElement ??= class {};

/** somewhere for react-dom to mount: an element as far as it asks (nothing is ever drawn into it) */
const container = () => ({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: g.document, textContent: "", ...noEvents() });

export interface Mounted<T> { readonly value: T; rerender: () => Promise<void>; unmount: () => Promise<void> }

/** run `hook` in a mounted component; `value` is what its last render returned, `rerender` draws it again (the hook's closure
 *  reads whatever the test changed since) */
export async function mount<T>(hook: () => T, wrap: (el: ReactElement) => ReactElement = el => el): Promise<Mounted<T>> {
  const { createRoot } = await import("react-dom/client");   // it reads the page's globals as it loads: after the stand-ins
  let value!: T;
  const Probe = () => { value = hook(); return null; };
  const root = createRoot(container() as unknown as Element);
  // a turn of the timers too, so an answer that is ready lands before the test looks
  const draw = () => act(async () => { root.render(wrap(createElement(Probe))); await new Promise(r => setTimeout(r, 0)); });
  await draw();
  return { get value() { return value; }, rerender: draw, unmount: () => act(async () => { root.unmount(); }) };
}

/** let what is pending happen: answers, effects, and timers up to `ms` */
export function settle(ms = 0): Promise<void> {
  return act(async () => { await new Promise(r => setTimeout(r, ms)); });
}
/** do something that changes a mounted hook's state (call what it returned, let an answer go), and wait for what follows */
export function during(fn: () => unknown): Promise<void> {
  return act(async () => { await fn(); await new Promise(r => setTimeout(r, 0)); });
}

/* ─────────── the server, scripted ─────────── */

export interface Call { method: string; path: string; headers: Record<string, string> }
type Answer = unknown | ((call: Call) => unknown | Promise<unknown>);
/** an answer the test lets go when it wants: `await held.promise` in a route, `held.go(value)` in the test */
export function hold<T = unknown>() {
  let go!: (v: T) => void;
  const promise = new Promise<T>(r => { go = r; });
  return { promise, go };
}
/**
 * `fetch` stood in for: `on(path, answer)` scripts one address (a value, or a function of the call; a `Response` goes out as it
 * is, anything else as JSON), everything asked for is in `calls`. Addresses nobody scripted answer 404. `restore` puts the real
 * fetch back.
 */
export function fakeServer() {
  const real = g.fetch;
  const calls: Call[] = [];
  const routes = new Map<string, Answer>();
  g.fetch = async (input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    const path = String(input);
    const call: Call = { method: init?.method ?? "GET", path, headers: { ...(init?.headers ?? {}) } };
    calls.push(call);
    const a = routes.has(path) ? routes.get(path) : routes.get(path.split("?")[0]);
    if (a === undefined) return new Response(JSON.stringify({ error: "no such endpoint" }), { status: 404 });
    const v = typeof a === "function" ? await (a as (c: Call) => unknown)(call) : a;
    return v instanceof Response ? v : new Response(JSON.stringify(v), { status: 200 });
  };
  return {
    calls,
    on: (path: string, answer: Answer) => { routes.set(path, answer); },
    asked: (path: string) => calls.filter(c => c.path === path).length,
    restore: () => { g.fetch = real; },
  };
}

/* ─────────── a browser's EventSource, spoken through by the test ─────────── */

export class FakeEventSource {
  static made: FakeEventSource[] = [];
  static get last(): FakeEventSource | undefined { return FakeEventSource.made[FakeEventSource.made.length - 1]; }
  private heard = new Map<string, ((e: { data: string }) => void)[]>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string, public init?: { withCredentials?: boolean }) { FakeEventSource.made.push(this); }
  addEventListener(name: string, fn: (e: { data: string }) => void) { this.heard.set(name, [...(this.heard.get(name) ?? []), fn]); }
  close() { this.closed = true; }
  /** the server says something */
  say(name: string, data: unknown = {}) { for (const f of this.heard.get(name) ?? []) f({ data: JSON.stringify(data) }); }
}

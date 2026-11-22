/**
 * The event stream (bun test, in web/): how text/event-stream is read, and how each kind of client says who it is. The launcher
 * keeps a token: it goes in a header, to a real server on this machine that turns away anything else, and never in the address.
 * A browser has its cookie: a plain EventSource, stood in for here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { FakeEventSource } from "./harness";

let ev: typeof import("../src/events");
let api: typeof import("../src/api");
const g = globalThis as Record<string, any>;
const realFetch = g.fetch, realES = g.EventSource;

/** the server: every request to the stream is noted; a stream is given only to the right Bearer header */
const TOKEN = "t0ken-of-the-launcher";
const asked: { url: string; auth: string | null }[] = [];
let streams: ReadableStreamDefaultController<Uint8Array>[] = [];
let closedByClient = 0;
const enc = new TextEncoder();
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1", idleTimeout: 30,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/api/v1/events") return new Response("{}", { status: 404 });
    asked.push({ url: url.pathname + url.search, auth: req.headers.get("authorization") });
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: "sign in first" }, { status: 401 });
    req.signal.addEventListener("abort", () => { closedByClient++; });
    return new Response(new ReadableStream<Uint8Array>({
      start(c) { streams.push(c); c.enqueue(enc.encode(`event: hello\ndata: ${JSON.stringify({ version: "t" })}\n\n`)); },
      cancel() { closedByClient++; },
    }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  },
});
const say = (name: string, data: unknown) => { for (const c of streams) { try { c.enqueue(enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ } } };
const until = async (ok: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!ok()) { if (Date.now() - t0 > ms) throw new Error("waited too long"); await new Promise(r => setTimeout(r, 15)); } };

beforeAll(async () => {
  g.fetch = (u: unknown, init?: RequestInit) => realFetch(new URL(String(u), `http://127.0.0.1:${server.port}`), init);   // the page's own origin
  g.EventSource = FakeEventSource;
  api = await import("../src/api");
  ev = await import("../src/events");
});
afterEach(() => { ev.setStream(false); api.setToken(null); });
afterAll(() => { g.fetch = realFetch; g.EventSource = realES; void server.stop(true); });

describe("reading text/event-stream", () => {
  const read = (...pieces: string[]) => { const got: [string, string][] = []; const feed = ev.eventParser((n, d) => got.push([n, d])); for (const p of pieces) feed(p); return got; };

  test("an event is its name and its data, ended by an empty line", () => {
    expect(read("event: hello\ndata: {\"v\":1}\n\nevent: library\ndata: {\"games\":3}\n\n")).toEqual([["hello", "{\"v\":1}"], ["library", "{\"games\":3}"]]);
    expect(read("data: no name\n\n")).toEqual([["message", "no name"]]);
    expect(read("event: ping\ndata: 1\n")).toEqual([]);                                       // not ended yet
    expect(read("event: empty\n\n")).toEqual([]);                                             // nothing to say
  });

  test("pieces may end anywhere: inside a word, between the two characters of a line end, between the lines", () => {
    const whole = "event: engine\r\ndata: {\"p\":0.5}\r\n\r\nevent: install\r\ndata: a\r\ndata: b\r\n\r\n";
    const want = [["engine", "{\"p\":0.5}"], ["install", "a\nb"]];
    expect(read(whole)).toEqual(want);
    for (let cut = 1; cut < whole.length; cut++) expect(read(whole.slice(0, cut), whole.slice(cut))).toEqual(want);
    expect(read(...whole)).toEqual(want);                                                     // a character at a time
  });

  test("comments and fields it has no use for are passed over", () => {
    expect(read(": keep-alive\nid: 7\nretry: 1000\nevent: user\ndata:tight\n\n")).toEqual([["user", "tight"]]);
  });
});

describe("the launcher's stream", () => {
  test("says who it is in a header; the token is in no address, and no EventSource is opened (it could only put it there)", async () => {
    const got: [string, unknown][] = [], conn: boolean[] = [];
    const off = ev.subscribe((n, d) => got.push([n, d])), offConn = ev.onConnection(ok => conn.push(ok));
    FakeEventSource.made.length = 0; asked.length = 0; streams = [];
    api.setToken(TOKEN);
    ev.setStream(true);
    await until(() => got.length >= 1);
    say("library", { games: 3 });
    await until(() => got.length >= 2);
    expect(got).toEqual([["hello", { version: "t" }], ["library", { games: 3 }]]);
    expect(ev.connected).toBe(true);
    expect(asked).toEqual([{ url: "/api/v1/events", auth: `Bearer ${TOKEN}` }]);
    expect(JSON.stringify(asked)).not.toContain("token=");
    expect(FakeEventSource.made.length).toBe(0);

    // the server ends the stream (a restart): the page notices and comes back, the same way
    for (const c of streams) c.close();
    streams = [];
    await until(() => conn.includes(false));
    expect(ev.connected).toBe(false);
    await until(() => asked.length >= 2 && got.filter(x => x[0] === "hello").length >= 2);
    expect(asked[1]).toEqual({ url: "/api/v1/events", auth: `Bearer ${TOKEN}` });
    expect(conn).toEqual([true, false, true]);

    // switched off (signed out): the stream is let go, and nothing comes back for it
    const before = asked.length;
    ev.setStream(false);
    await until(() => closedByClient >= 1);
    await new Promise(r => setTimeout(r, 1300));
    expect(asked.length).toBe(before);
    off(); offConn();
  });

  test("a server that does not know the token is asked again later, never with the token in the address", async () => {
    asked.length = 0;
    api.setToken("someone-else");
    ev.setStream(true);
    await until(() => asked.length >= 2, 4000);
    for (const a of asked) expect(a).toEqual({ url: "/api/v1/events", auth: "Bearer someone-else" });
  });
});

describe("a browser's stream", () => {
  test("is a plain EventSource to the plain address: the cookie says who it is", () => {
    FakeEventSource.made.length = 0; asked.length = 0;
    const got: [string, unknown][] = [];
    const off = ev.subscribe((n, d) => got.push([n, d]));
    ev.setStream(true);                                                                       // no token: a browser
    expect(FakeEventSource.made.length).toBe(1);
    const es = FakeEventSource.last!;
    expect(es.url).toBe("/api/v1/events");
    expect(es.init).toEqual({ withCredentials: true });
    es.say("hello", { version: "t" }); es.say("friend", { id: 2 });
    expect(got).toEqual([["hello", { version: "t" }], ["friend", { id: 2 }]]);
    expect(ev.connected).toBe(true);
    es.onerror?.();                                                                           // it broke: closed, to be opened again
    expect(es.closed).toBe(true);
    expect(ev.connected).toBe(false);
    expect(asked).toEqual([]);                                                                // nothing went the launcher's way
    off();
  });
});

/** Ahoy web — one event stream for the whole app; pages subscribe to the event names they care about. */
import { useEffect } from "react";
import { token, urlBase } from "./api";

type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();
/** the open stream: a browser's EventSource (its cookie says who it is), or the launcher's, read with its token in a header */
let source: { close(): void } | null = null;
let backoff = 1000;
export let connected = false;
const connListeners = new Set<(ok: boolean) => void>();
let enabled = false;

const NAMES = ["hello", "library", "engine", "user", "activity", "presence", "friend", "install", "pc", "order", "save", "log", "ping"];

/**
 * text/event-stream, read piece by piece: an `event:` line names what follows, `data:` lines carry it, an empty line ends it.
 * A piece may end anywhere (inside a line, between the two characters of a line end).
 */
export function eventParser(onEvent: (name: string, data: string) => void): (piece: string) => void {
  let rest = "", name = "", data: string[] = [];
  return piece => {
    rest += piece;
    for (;;) {
      const end = /\r\n|\n|\r/.exec(rest);
      if (!end || (end[0] === "\r" && end.index === rest.length - 1)) break;      // a last \r may be half of \r\n: wait for more
      const line = rest.slice(0, end.index);
      rest = rest.slice(end.index + end[0].length);
      if (line === "") { if (data.length) onEvent(name || "message", data.join("\n")); name = ""; data = []; continue; }
      if (line.startsWith(":")) continue;                                           // a comment (a proxy's keep-alive)
      const at = line.indexOf(":");
      const field = at < 0 ? line : line.slice(0, at), value = at < 0 ? "" : line.slice(at + 1).replace(/^ /, "");
      if (field === "event") name = value; else if (field === "data") data.push(value);
    }
  };
}

/**
 * The launcher's stream. Its token goes in a header, as on every other request, and never in the address: an EventSource can
 * only put it there, where a reverse proxy's access log keeps it, over and over as the stream reconnects. So this one is read
 * with fetch. `onLost` is called once, when it ends or breaks without having been closed here.
 */
function headerStream(url: string, bearer: string, onEvent: (name: string, data: string) => void, onLost: () => void): { close(): void } {
  const stop = new AbortController();
  void (async () => {
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}`, accept: "text/event-stream" }, credentials: "include", cache: "no-store", signal: stop.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const feed = eventParser(onEvent), text = new TextDecoder(), reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feed(text.decode(value, { stream: true }));
      }
    } catch { /* it broke, or it was closed */ }
    if (!stop.signal.aborted) onLost();
  })();
  return { close: () => stop.abort() };
}
/** a browser's stream: the session cookie goes with it by itself */
function cookieStream(url: string, onEvent: (name: string, data: string) => void, onLost: () => void): { close(): void } {
  const es = new EventSource(url, { withCredentials: true });
  for (const n of NAMES) es.addEventListener(n, (e: MessageEvent) => onEvent(n, e.data));
  es.onerror = onLost;
  return es;
}

function heard(n: string, raw: string) {
  let data: unknown = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (n === "hello") { connected = true; backoff = 1000; for (const l of connListeners) l(true); }
  for (const l of listeners) { try { l(n, data); } catch { /* ignore */ } }
}
function connect() {
  if (source || !enabled) return;
  const url = `${urlBase}/api/v1/events`, t = token();
  const lost = () => {
    if (source !== mine) return;                                                    // closed on purpose since, or replaced
    mine.close(); source = null; connected = false;
    for (const l of connListeners) l(false);
    if (enabled) { setTimeout(connect, backoff); backoff = Math.min(30_000, backoff * 2); }
  };
  const mine = t ? headerStream(url, t, heard, lost) : cookieStream(url, heard, lost);
  source = mine;
}
/** the stream only makes sense with a session: the session provider switches it on and off */
export function setStream(on: boolean) {
  enabled = on;
  if (on) connect();
  else { source?.close(); source = null; connected = false; }
}

export function subscribe(l: Listener): () => void { connect(); listeners.add(l); return () => { listeners.delete(l); }; }
export function onConnection(l: (ok: boolean) => void): () => void { connListeners.add(l); return () => { connListeners.delete(l); }; }

/** run `fn` (debounced) whenever one of the named events arrives */
export function useEvents(names: string[], fn: (event: string, data: unknown) => void, deps: unknown[] = []) {
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    let last: [string, unknown] | null = null;
    const off = subscribe((event, data) => {
      if (!names.includes(event)) return;
      last = [event, data];
      if (t) return;
      t = setTimeout(() => { t = null; if (last) fn(last[0], last[1]); }, 400);
    });
    return () => { off(); if (t) clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

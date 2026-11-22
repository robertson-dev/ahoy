/** events: ludarr's stream reaches members as the kind of event only — the UI reloads on it, and the data is the engine's own
 * wording (release titles, indexers, groups), which members never read. */
import { expect, test } from "bun:test";
import { events } from "../src/events";
import * as ludarr from "../src/ludarr";
import { kv } from "../src/db";
import { wipe } from "./helpers";

test("an engine event carries its kind, nothing of what the engine said", async () => {
  wipe();
  kv.set("cfg.LUDARR_URL", "http://engine:7979"); kv.set("cfg.LUDARR_API_KEY", "k3y");
  const realFetch = ludarr.pdeps.fetch, enc = new TextEncoder();
  const said = 'event: request\ndata: {"id":9,"stage":"transferring to ludarr · 20 MB/s","release":{"title":"Hades-RUNE","indexer":"GazelleGames","group":"RUNE"}}\n\n';
  ludarr.pdeps.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/v1/system/events")) return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(said)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ items: [] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const seen: unknown[] = [];
  const off = events.subscribe(e => { if (e.event === "engine") seen.push(e.data); });
  try {
    ludarr.followEvents();
    for (let i = 0; i < 100 && !seen.length; i++) await new Promise(r => setTimeout(r, 20));
    ludarr.stopFollowing();
    expect(seen).toEqual([{ event: "request" }]);
    expect(JSON.stringify(events.recent())).not.toMatch(/RUNE|GazelleGames|Hades|ludarr/);
    await new Promise(r => setTimeout(r, 700));                                          // the library refresh the event set off
  } finally { off(); ludarr.pdeps.fetch = realFetch; }
});

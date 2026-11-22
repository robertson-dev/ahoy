import { expect, test } from "bun:test";
import { FakeEventSource, during, fakeServer, mount, settle } from "./harness";
import { artRevision, rememberArtRevisions, versionedArt } from "../src/art-revisions";

test("a second art replacement changes every cached request, preserving sizes and card styles", () => {
  const id = 918001, appId = 918002;
  const paths = ["/api/v1/art/game/" + id + "/poster?w=208", "/api/v1/art/game/" + id + "/card?style=fade", "/api/v1/art/game/" + id + "/spotlight?w=1440&bar=148", "/api/v1/art/game/" + id + "/meta"];
  const revisions = [];
  for (const artRev of [100, 101, 102]) {
    rememberArtRevisions([{ id, steamAppId: appId, artRev }]);
    const urls = paths.map(url => versionedArt(url, "game", id));
    expect(urls.every(u => u.endsWith("rev=" + artRev))).toBe(true);
    expect(urls[0]).toContain("?w=208&"); expect(urls[1]).toContain("?style=fade&");
    expect(artRevision("steam", appId)).toBe(artRev);
    revisions.push(urls);
  }
  expect(new Set(revisions.map(x => x.join("|"))).size).toBe(3);
  expect(versionedArt(revisions[0][0], "game", id)).toBe(revisions[2][0]);
  expect(versionedArt("/api/v1/art/game/918999/poster", "game", 918999)).toBe("/api/v1/art/game/918999/poster");
});

test("an open page refreshes its image, metadata, cards and spotlight after both library updates", async () => {
  const g = globalThis as Record<string, any>;
  const oldES = g.EventSource, oldLocation = g.location, oldStorage = g.localStorage;
  g.EventSource = FakeEventSource; g.location = { search: "" };
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const srv = fakeServer();
  const { setStream } = await import("../src/events");
  const { useLibrarySource } = await import("../src/data");
  const { Art, useArtMeta } = await import("../src/ui/art");
  const { useFanCards } = await import("../src/ui/fan");
  const { useSpotlightLayout } = await import("../src/ui/spotlight");
  const id = 918003, base = `/api/v1/art/game/${id}`;
  let artRev = 201;
  srv.on("/api/v1/game", () => ({ items: [{ id, name: "Changed art", artRev }] }));
  srv.on(`${base}/meta`, () => ({ hero: { w: artRev }, logo: null }));
  srv.on(`${base}/card`, () => ({ key: String(artRev), status: "ready", fan: [{}, {}, {}, {}, {}] }));
  srv.on(`${base}/spotlight`, () => ({ key: String(artRev), status: "ready", layout: {} }));
  setStream(true);
  const library = await mount(() => useLibrarySource());
  const page = await mount(() => ({
    image: Art({ src: `${base}/poster?w=208`, title: "Changed art" }),
    meta: useArtMeta("game", id),
    cards: useFanCards([id]),
    spot: useSpotlightLayout({ gameId: id }, { w: 1440, bar: 148, left: 48 }),
  }));
  try {
    for (const rev of [201, 202, 203]) {
      if (rev !== artRev) {
        artRev = rev;
        await during(() => FakeEventSource.last!.say("library"));
        await settle(450); // the library's event debounce
      }
      await settle(350); // the spotlight's request debounce
      expect(page.value.image.props.src).toBe(`${base}/poster?w=208&rev=${rev}`);
      expect(page.value.meta?.hero?.w).toBe(rev);
      expect(page.value.cards.cards.get(id)?.key).toBe(String(rev));
      expect(page.value.spot.json?.key).toBe(String(rev));
      for (const kind of ["meta", "card", "spotlight"]) {
        expect(srv.calls.some(c => c.path.startsWith(`${base}/${kind}?`) && c.path.endsWith(`rev=${rev}`))).toBe(true);
      }
    }
  } finally {
    await page.unmount(); await library.unmount(); setStream(false); srv.restore();
    g.EventSource = oldES; g.location = oldLocation; g.localStorage = oldStorage;
  }
});


import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kv } from "../src/db";
import * as ludarr from "../src/ludarr";
import { gameImage, _test as artMemory } from "../src/art";
import { forPlayers } from "../src/words";
import { getCard, stopCards } from "../src/cards";
import { sourceDeps } from "../src/cards/sources";
import { askedOf, getSpotlight, spotDeps, stopSpotlight } from "../src/spotlight";
import { game, setLibrary } from "./helpers";

const fx = (name: string) => join(import.meta.dir, "fixtures", "cards", name);
const files = ["batomon-poster.jpg", "the-drifter-poster.jpg", "samurai-gunn-2-poster.jpg"];
const original = { fetch: ludarr.pdeps.fetch, sources: { ...sourceDeps }, spots: { ...spotDeps }, style: process.env.CARD_STYLE };
afterAll(() => {
  ludarr.pdeps.fetch = original.fetch;
  Object.assign(sourceDeps, original.sources); Object.assign(spotDeps, original.spots);
  if (original.style === undefined) delete process.env.CARD_STYLE; else process.env.CARD_STYLE = original.style;
  stopCards(); stopSpotlight(); artMemory.forget();
});

test("three successive artwork revisions fetch different bytes and reach the player payload", async () => {
  const id = 917301;
  kv.set("cfg.LUDARR_URL", "http://engine:7979"); kv.set("cfg.LUDARR_API_KEY", "test");
  let bytes = readFileSync(fx(files[0])), calls = 0;
  ludarr.pdeps.fetch = (async () => { calls++; return new Response(bytes, { headers: { "content-type": "image/jpeg" } }); }) as typeof fetch;
  const paths = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    bytes = readFileSync(fx(files[i]));
    const g = game(id, "Art revisions", { customArt: ["poster"], customArtAt: 101 + i });
    setLibrary([g]);
    const p = forPlayers(g);
    expect(p.artRev).toBe(101 + i); expect(p.customArt).toBeUndefined();
    const image = await gameImage(id, "poster");
    expect(image).not.toBeNull(); paths.add(image!.path);
    expect(readFileSync(image!.path).equals(bytes)).toBe(true);
  }
  expect(paths.size).toBe(3); expect(calls).toBe(3);
});

test("an earlier missing picture does not suppress a replacement for a day", async () => {
  const id = 917302;
  kv.set("cfg.LUDARR_URL", "http://engine:7979"); kv.set("cfg.LUDARR_API_KEY", "test");
  setLibrary([game(id, "Art retry", { customArt: ["poster"], customArtAt: 1 })]);
  ludarr.pdeps.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  expect(await gameImage(id, "poster")).toBeNull();
  setLibrary([game(id, "Art retry", { customArt: ["poster"], customArtAt: 2 })]);
  ludarr.pdeps.fetch = (async () => new Response(readFileSync(fx(files[1])), { headers: { "content-type": "image/jpeg" } })) as typeof fetch;
  expect(await gameImage(id, "poster")).not.toBeNull();
});

test("cards and spotlight sources refresh on every replacement within their normal cache lifetime", async () => {
  process.env.CARD_STYLE = "boxart";
  const id = 917303;
  let file = fx(files[0]);
  sourceDeps.poster = async () => ({ path: file, type: "image/jpeg" });
  sourceDeps.logo = async () => null;
  spotDeps.banner = async () => ({ path: file, type: "image/jpeg" });
  const cardKeys = new Set(), spotKeys = new Set();
  for (let i = 0; i < files.length; i++) {
    file = fx(files[i]);
    setLibrary([game(id, "Changed art", { customArt: ["poster", "banner"], customArtAt: 10 + i })]);
    let card, spot;
    const deadline = Date.now() + 15000;
    do {
      card = await getCard(id);
      spot = await getSpotlight({ kind: "game", id }, askedOf(1440));
      if (card?.status === "ready" && card.key && !cardKeys.has(card.key) && spot?.key && !spotKeys.has(spot.key)) break;
      await Bun.sleep(20);
    } while (Date.now() < deadline);
    expect(card?.key).toBeTruthy(); expect(cardKeys.has(card?.key)).toBe(false);
    expect(spot?.key).toBeTruthy(); expect(spotKeys.has(spot?.key)).toBe(false);
    cardKeys.add(card!.key); spotKeys.add(spot!.key);
  }
  expect(cardKeys.size).toBe(3); expect(spotKeys.size).toBe(3);
}, 60000);


/**
 * What's new (bun test, in web/): which items are news where (whatsnew.ts), what a launcher update brings, and that the
 * list players read stays in the product's words.
 */
import { describe, expect, test } from "bun:test";
import "./harness";
import { NEWS, atLeast, comesWith, notesHere, unseen, type News } from "../src/whatsnew";

const day = (d: string) => Math.floor(new Date(`${d}T12:00:00`).getTime() / 1000);
const news: News[] = [
  { id: "n2", date: "2026-11-11", items: [{ id: "a", text: "A page change." }, { id: "b", text: "Needs the new launcher.", needs: "0.13.0" }] },
  { id: "n1", date: "2026-10-01", items: [{ id: "c", text: "An older change." }, { id: "d", text: "An older launcher's.", needs: "0.11.0" }] },
];

describe("what is news where", () => {
  test("a browser lists what needs no launcher; a launcher lists what it has", () => {
    expect(notesHere(news, { launcher: null }).map(n => n.items.map(i => i.id))).toEqual([["a"], ["c"]]);
    expect(notesHere(news, { launcher: "0.12.0" }).map(n => n.items.map(i => i.id))).toEqual([["a"], ["c", "d"]]);
    expect(notesHere(news, { launcher: "0.13.0" }).map(n => n.items.map(i => i.id))).toEqual([["a", "b"], ["c", "d"]]);
    expect(notesHere([{ id: "x", date: "2026-11-11", items: [{ id: "y", text: "t", needs: "9.0.0" }] }], { launcher: "0.13.0" })).toEqual([]);
  });
  test("news is what came after a person joined and they have not seen on this device", () => {
    const old = { launcher: "0.13.0", joinedAt: day("2026-01-01") };
    expect(unseen(news, old, new Set()).map(i => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(unseen(news, old, new Set(["a", "c"])).map(i => i.id)).toEqual(["b", "d"]);
    // joined between the two notes: only the later one is news; joined after both: nothing is
    expect(unseen(news, { launcher: "0.13.0", joinedAt: day("2026-10-20") }, new Set()).map(i => i.id)).toEqual(["a", "b"]);
    expect(unseen(news, { launcher: "0.13.0", joinedAt: day("2026-11-12") }, new Set())).toEqual([]);
    // joined on the day of a note: it is theirs
    expect(unseen(news, { launcher: null, joinedAt: day("2026-11-11") }, new Set()).map(i => i.id)).toEqual(["a"]);
    // an item becomes news when the launcher that brings it is the one running
    expect(unseen(news, { ...old, launcher: "0.12.0" }, new Set(["a", "c", "d"]))).toEqual([]);
    expect(unseen(news, { ...old, launcher: "0.13.0" }, new Set(["a", "c", "d"])).map(i => i.id)).toEqual(["b"]);
  });
  test("what a launcher update brings: what it has and the one running has not", () => {
    expect(comesWith(news, "0.12.0", "0.13.0").map(i => i.id)).toEqual(["b"]);
    expect(comesWith(news, "0.10.0", "0.13.0").map(i => i.id)).toEqual(["b", "d"]);
    expect(comesWith(news, "0.13.0", "0.13.1")).toEqual([]);
    expect(comesWith(news, "0.12.0", null)).toEqual([]);
    expect(comesWith(news, null, "0.11.0").map(i => i.id)).toEqual(["d"]);
  });
  test("versions compare by number", () => {
    expect(atLeast("0.13.0", "0.13.0")).toBe(true);
    expect(atLeast("0.13.1", "0.13.0")).toBe(true);
    expect(atLeast("0.9.9", "0.13.0")).toBe(false);
    expect(atLeast("1.0", "0.13.0")).toBe(true);
    expect(atLeast("dev", "0.13.0")).toBe(false);
    expect(atLeast("0.13.0", null)).toBe(false);
  });
});

describe("the list players read", () => {
  test("every item has an id of its own and a sentence; every note a day", () => {
    const ids = NEWS.flatMap(n => n.items.map(i => i.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(NEWS.map(n => n.id)).size).toBe(NEWS.length);
    for (const n of NEWS) {
      expect(n.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(n.items.length).toBeGreaterThan(0);
      for (const i of n.items) {
        expect(i.text.length, i.id).toBeGreaterThan(10);
        expect(i.text.length, i.id).toBeLessThan(200);
        expect(i.text, i.id).toMatch(/[.)]$/);
        if (i.needs) expect(i.needs).toMatch(/^\d+\.\d+\.\d+$/);
      }
    }
    // newest first
    expect([...NEWS].sort((a, b) => (a.date < b.date ? 1 : -1)).map(n => n.id)).toEqual(NEWS.map(n => n.id));
  });
  test("says nothing of the engine or how things are made", () => {
    for (const i of NEWS.flatMap(n => n.items)) expect(i.text, i.id).not.toMatch(/playarr|arcadearr|ludarr|indexer|torrent|usenet|nzb|crack|scene|repack|emulator|sha|digest|endpoint|api\b/i);
  });
});

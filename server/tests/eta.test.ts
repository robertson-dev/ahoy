/** eta: "about 20 min left" for a server download — ludarr's own numbers (the release's size, the request's progress, the rate in
 * its stage) read with ludarr's two legs (download 0.05→0.5, transfer 0.5→0.85), the transfer at the rate seen lately; and the
 * field on the members' view of a game, after the size itself is gone. */
import { beforeEach, describe, expect, test } from "bun:test";
import { LEGS, _test, edeps, etaSeconds, legOf, noteTransfers, rateOf, transferRate } from "../src/eta";
import { forPlayers } from "../src/words";
import { kv } from "../src/db";
import type { RequestView } from "../src/ludarr";
import { game, http, setLibrary, signup, wipe } from "./helpers";

const GB = 1e9, MB = 1e6;
const req = (stage: string | null, progress: number, size: number | null = 4.6 * GB): RequestView => ({
  id: 7, gameId: 26, state: "fetching", stage, progress, message: null, attempt: 0, candidates: 1, createdAt: 0, updatedAt: 0, doneAt: null,
  release: size == null ? null : { title: "Endacopia-GRP", protocol: "torrent", indexer: "x", size, group: "GRP" },
});
let now = 1_800_000_000_000;

beforeEach(() => { wipe(); _test.reset(); now = 1_800_000_000_000; edeps.now = () => now; });

describe("reading ludarr's stage", () => {
  test("the rate in bytes a second (decimal units, as ludarr writes them), and the leg", () => {
    expect(rateOf("downloading · 6.2 MB/s")).toBe(6.2 * MB);
    expect(rateOf("transferring to ludarr · 12 MB/s")).toBe(12 * MB);
    expect(rateOf("downloading · 850 KB/s")).toBe(850e3);
    expect(rateOf("downloading")).toBeNull();
    expect(rateOf(null)).toBeNull();
    expect(legOf("downloading · 6.2 MB/s")).toBe("download");
    expect(legOf("transferring to ludarr · 12 MB/s")).toBe("transfer");
    expect(legOf("finished downloading — transferring next")).toBe("between");
    expect([legOf("queued in the download client"), legOf("sent to the download client"), legOf("importing"), legOf(null)]).toEqual([null, null, null, null]);
  });
});

describe("the estimate", () => {
  test("downloading: what is left of the download, then the whole transfer; at the current rate while no transfer has been seen", () => {
    // 48% of the request is 95.6% of the download leg: 0.044 x 4.6 GB left there, then 4.6 GB to bring over, all at 6.2 MB/s
    const left = 4.6 * GB * (1 - (0.48 - LEGS.download.from) / (LEGS.download.to - LEGS.download.from)) + 4.6 * GB;
    expect(etaSeconds("downloading", req("downloading · 6.2 MB/s", 0.48))).toBe(Math.round(left / (6.2 * MB)));
    expect(etaSeconds("downloading", req("downloading · 6.2 MB/s", 0.48))).toBe(775);                     // about 13 min
    expect(etaSeconds("downloading", req("downloading · 10 MB/s", 0.05, 1 * GB))).toBe(200);              // 1 GB down + 1 GB over
  });
  test("the transfer runs at the rate transfers had lately (smoothed, kept across restarts), not the download's", () => {
    noteTransfers([game(1, "A", { request: req("transferring to ludarr · 40 MB/s", 0.6) })]);
    expect(transferRate()).toBe(40 * MB);
    noteTransfers([game(1, "A", { request: req("transferring to ludarr · 20 MB/s", 0.7) })]);
    expect(transferRate()).toBe(34 * MB);                                                                   // 0.7 x 40 + 0.3 x 20
    expect(JSON.parse(kv.get("eta.transferRate")!)).toMatchObject({ bps: 40 * MB });                        // saved at most once a minute
    now += 61_000;
    noteTransfers([game(1, "A", { request: req("transferring to ludarr · 34 MB/s", 0.75) })]);
    expect(JSON.parse(kv.get("eta.transferRate")!)).toMatchObject({ bps: 34 * MB });
    // 1 GB at 10 MB/s for the download's last half, then 1 GB at the transfer rate seen
    expect(etaSeconds("downloading", req("downloading · 10 MB/s", 0.275, 1 * GB))).toBe(Math.round(0.5 * GB / (10 * MB) + GB / (34 * MB)));
    // between the legs the stage names no rate: the transfer rate seen answers; without one, nothing can be told
    expect(etaSeconds("downloading", req("finished downloading — transferring next", 0.5, 1 * GB))).toBe(Math.round(GB / (34 * MB)));
    _test.reset();
    expect(etaSeconds("downloading", req("finished downloading — transferring next", 0.5, 1 * GB))).toBeNull();
  });
  test("transferring: the rest of the transfer at its rate", () => {
    expect(etaSeconds("downloading", req("transferring to ludarr · 20 MB/s", 0.675, 2 * GB))).toBe(50);   // halfway: 1 GB at 20 MB/s
    expect(etaSeconds("downloading", req("transferring to ludarr · 20 MB/s", 0.85, 2 * GB))).toBe(0);
  });
  test("nothing is guessed: no size, no rate, queued, looking, preparing, ready, another state", () => {
    expect(etaSeconds("downloading", req("downloading · 6.2 MB/s", 0.48, null))).toBeNull();
    expect(etaSeconds("downloading", req("downloading · 6.2 MB/s", 0.48, 0))).toBeNull();
    expect(etaSeconds("downloading", req("downloading", 0.3))).toBeNull();
    expect(etaSeconds("downloading", req("queued in the download client", 0.05))).toBeNull();
    expect(etaSeconds("searching", req("searching the indexers", 0.02))).toBeNull();
    expect(etaSeconds("importing", req("importing", 0.9))).toBeNull();
    expect(etaSeconds("available", req("imported", 1))).toBeNull();
    expect(etaSeconds("downloading", null)).toBeNull();
    expect(etaSeconds("downloading", req("downloading · 0.2 MB/s", 0.05, 900 * GB))).toBeNull();          // weeks away: says nothing useful
  });
});

describe("what members get", () => {
  test("request.etaSeconds on every game view, worked out before the size is stripped; the engine's words stay out", async () => {
    const downloading = game(26, "Endacopia", { status: "downloading", statusDetail: "downloading · 6.2 MB/s", request: req("downloading · 6.2 MB/s", 0.48) });
    const p = forPlayers(downloading);
    expect(p.request).toMatchObject({ stage: "Downloading · 6.2 MB/s", release: null, message: null, progress: 0.48, etaSeconds: 775 });
    expect(JSON.stringify(p)).not.toMatch(/GRP|Endacopia-|torrent|indexer/);
    expect(forPlayers(game(2, "Queued", { status: "downloading", request: req("queued in the download client", 0.05) })).request!.etaSeconds).toBeNull();
    setLibrary([downloading, game(3, "Ready", { status: "available", statusDetail: "1.0 GB" })]);
    const { token } = await signup("kay");
    const list = await http("GET", "/api/v1/game", undefined, token);
    expect(list.status).toBe(200);
    expect(list.json.items.find((g: any) => g.id === 26).request).toMatchObject({ etaSeconds: 775, release: null });
    expect(list.json.items.find((g: any) => g.id === 3).request).toBeNull();
  });
});

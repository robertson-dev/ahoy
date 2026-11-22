import { describe, expect, test } from "bun:test";
import { cleanVersion, forPlayers, playerWords } from "../src/words";
import type { LudarrGameDetail } from "../src/ludarr";

describe("what a player reads", () => {
  test("the engine's stages become a few plain phrases, no component ever named", () => {
    expect(playerWords("downloading", "sent to the download client")).toBe("Queued");
    expect(playerWords("downloading", "queued in the download client")).toBe("Queued");
    expect(playerWords("downloading", "downloading · 12.4 MB/s")).toBe("Downloading · 12.4 MB/s");
    expect(playerWords("downloading", "finished downloading — transferring next")).toBe("Downloading");
    expect(playerWords("downloading", "transferring to ludarr · 48 MB/s")).toBe("Downloading · 48 MB/s");
    expect(playerWords("importing", "importing")).toBe("Preparing");
    expect(playerWords("importing", "waiting for the importer")).toBe("Preparing");
    expect(playerWords("importing", "running innoextract on setup.exe")).toBe("Preparing");
    expect(playerWords("importing", "downloaded, but it needs the AI importer — add an API key under Settings → Importers")).toBe("Needs a hand from whoever runs the server");
    expect(playerWords("searching", "searching the indexers")).toBe("Looking");
    expect(playerWords("searching", "no PC version found — looking for a console dump")).toBe("Looking");
    expect(playerWords("searching", "the indexer search failed — trying again soon")).toBe("Trying again soon");
    expect(playerWords("searching", "no usable copy yet — searching again in 6h")).toBe("Nothing yet · trying again in 6 h");
    expect(playerWords("failed", "every candidate release failed")).toBe("Nothing usable turned up");
    expect(playerWords("missing", "no copy yet")).toBe("Nothing found yet");
    expect(playerWords("unmonitored", "not monitored")).toBe("");
    expect(playerWords("available", "imported")).toBe("Ready");
    expect(playerWords("available", "ready to install")).toBe("Ready");
    expect(playerWords("unreleased", "Mar 3, 2027")).toBe("Mar 3, 2027");
    for (const [st, raw] of [["downloading", "transferring to ludarr"], ["importing", "the AI importer's key was rejected"], ["searching", "the indexer search failed"], ["failed", "GazelleGames: 429"]] as const)
      expect(playerWords(st, raw).toLowerCase()).not.toMatch(/ludarr|indexer|importer|seedbox|torrent|client/);
  });

  test("a version is a number; a group's label is not a version", () => {
    expect(cleanVersion("1.0.206.0")).toBe("1.0.206.0");
    expect(cleanVersion("v1.09")).toBe("1.09");
    expect(cleanVersion("TENOKE 2025 release")).toBeNull();
    expect(cleanVersion("RUNE")).toBeNull();
    expect(cleanVersion("unknown")).toBeNull();
    expect(cleanVersion(null)).toBeNull();
    const ready = forPlayers({ id: 1, status: "available", statusDetail: "1.0 GB · vTENOKE 2025 release", request: { stage: "imported", message: null, release: null }, file: { id: 1, size: 1_000_000_000, version: "TENOKE 2025 release", release: "x", group: "TENOKE", importer: "scene" } } as any);
    expect(ready.statusDetail).toBe("1.0 GB"); expect(ready.file!.version).toBeNull(); expect(ready.request!.stage).toBe("Ready");
    const versioned = forPlayers({ id: 1, status: "available", statusDetail: "9.3 GB · v1.0.0", request: null, file: { id: 1, size: 9_300_000_000, version: "1.0.0", release: null, group: null, importer: null } } as any);
    expect(versioned.statusDetail).toBe("9.3 GB · v1.0.0");
  });

  test("a game loses the engine's wording, its sources and its jobs before it reaches a member", () => {
    const g = {
      id: 1, name: "Hades", status: "downloading", statusDetail: "transferring to ludarr · 20 MB/s",
      request: { id: 9, gameId: 1, state: "fetching", stage: "transferring to ludarr · 20 MB/s", progress: 0.6, message: "torrent · scene", release: { title: "Hades-RUNE", protocol: "torrent", indexer: "GazelleGames", size: 1, group: "RUNE" }, attempt: 1, candidates: 2, createdAt: 1, updatedAt: 2, doneAt: null },
      file: { id: 3, path: "/library/hades", size: 1, version: null, launch: null, files: 1, importer: "scene", release: "Hades-RUNE", group: "RUNE", format: "x", addedAt: 5 },
      history: [{ id: 1, event: "grabbed", release: "Hades-RUNE", source: "GazelleGames", message: "torrent · scene", at: 1 }],
      jobs: [{ id: 1, state: "done", tier: "recipe", message: "innoextract", createdAt: 1, doneAt: 2 }],
    } as unknown as LudarrGameDetail;
    const p = forPlayers(g);
    expect(p.statusDetail).toBe("Downloading · 20 MB/s");
    expect(p.request).toMatchObject({ id: 9, stage: "Downloading · 20 MB/s", message: null, release: null, progress: 0.6 });
    expect(p.file).toMatchObject({ id: 3, release: null, group: null, importer: null });
    expect(p.history).toEqual([{ id: 1, event: "grabbed", release: null, source: null, message: null, at: 1 }]);
    expect(p.jobs).toEqual([]);
    expect(JSON.stringify(p)).not.toMatch(/RUNE|GazelleGames|ludarr|innoextract|scene/);
    expect(g.request!.stage).toBe("transferring to ludarr · 20 MB/s");                       // the snapshot itself is untouched
  });
});

describe("what members never see about games the admin made", () => {
  test("search terms, where the art came from and how a game was added stay with the engine; ways the admin built keep no repository link", () => {
    const g = { id: 9, status: "available", statusDetail: "", request: null, file: { id: 3, size: 1e9, version: "1.0", release: null, group: null, importer: null, kind: "recomp", requiresLauncher: "0.10.0" },
      source: "manual", aliases: ["Dinosaur Planet (Prototype)"], searchTerms: ["Dinosaur Planet N64 proto"], customArt: ["poster", "logo"], customArtAt: 1731000000000,
      history: [], jobs: [], routes: [
        { id: 1, kind: "recomp", platform: "n64", provenance: "prototype", label: "Dinosaur Planet Recomp", status: "playable", statusNote: "built", runtime: { id: "plan:dp", name: "Dinosaur Planet Recomp", kind: "recomp", latest: { tag: "v1.0", date: null, asset: { name: "dp.zip", url: "https://github.com/x/dp/releases/dp.zip", size: 1 }, page: "https://github.com/x/dp/releases" } }, content: { accept: { hashes: [{ algo: "sha1", value: "abc" }] } }, needs: [], features: [], launch: { exe: "dp.exe" }, link: "https://github.com/x/dp", source: "custom", updatedAt: 1 },
        { id: 2, kind: "port", platform: "n64", provenance: "retail", label: "Ship of Harkinian", status: "perfect", statusNote: null, runtime: null, content: null, needs: [], features: ["randomizer"], launch: null, link: "https://github.com/HarbourMasters/Shipwright", source: "ports", updatedAt: 1 },
      ] } as any;
    const p = forPlayers(g) as any;
    for (const k of ["searchTerms", "customArt", "customArtAt", "source"]) expect(k in p).toBe(false);
    expect(p.aliases).toEqual(["Dinosaur Planet (Prototype)"]);
    expect(p.file).toMatchObject({ kind: "recomp", requiresLauncher: "0.10.0" });
    expect(p.routes[0]).toMatchObject({ label: "Dinosaur Planet Recomp", link: null, content: null, launch: null, statusNote: null, runtime: { latest: { tag: "v1.0", asset: null, page: null } } });
    expect(p.routes[1].link).toBe("https://github.com/HarbourMasters/Shipwright");
    expect(JSON.stringify(p.routes)).not.toMatch(/github\.com\/x\/dp|abc|dp\.exe/);
  });
  test("a catalog's link reaches members only when it is a web page's address", () => {
    const way = (link: unknown) => ({ id: 1, kind: "port", platform: "n64", provenance: "retail", label: "A port", status: "perfect", statusNote: null, runtime: null, content: null, needs: [], features: [], launch: null, link, source: "ports", updatedAt: 1 });
    const links = ["https://example.org/port", "http://example.org/port", "file:///C:/Windows/System32/calc.exe", "\\\\share\\x\\run.exe", "search-ms:query=x", "javascript:alert(1)", "steam://run/1", "ms-settings:", "not a link", "", null, 7, { href: "https://example.org" }];
    const g = { id: 9, status: "available", statusDetail: "", request: null, file: null, history: [], jobs: [], routes: links.map(way) } as any;
    const got = (forPlayers(g) as any).routes.map((r: any) => r.link);
    expect(got).toEqual(["https://example.org/port", "http://example.org/port", ...links.slice(2).map(() => null)]);
  });
  test("a start the admin set by hand: members keep only its opaque stamp, never the start line", () => {
    const g = { id: 43, status: "available", statusDetail: "", request: null,
      file: { id: 43, size: 58e9, version: "20261108", release: null, group: null, importer: null, kind: "emulated", requiresLauncher: "0.10.0", launchRev: 1731170000000, start: "KytyLauncher.exe --play" } } as any;
    const p = forPlayers(g) as any;
    expect(p.file.launchRev).toBe(1731170000000);
    expect("start" in p.file).toBe(false);
    expect(JSON.stringify(p)).not.toMatch(/--play/);
    expect(g.file.start).toBe("KytyLauncher.exe --play");                                     // the snapshot itself is untouched
  });
});

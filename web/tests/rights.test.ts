/**
 * Whose Cancel it is, and the reverse proxy field (bun test, in web/).
 * The server takes a Cancel only from an admin, whoever started that search or whoever brought the game, and says so with every
 * game (may.cancel, for whoever asked): the page offers Cancel only then (ui/game-action planAction, model mayCancel).
 * Settings' reverse proxy field saves only what the server can read (screens/settings-kit proxyList).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import "./harness";
import type { Game } from "../src/api";
import type { InstallProgress } from "../src/launcher";

let planAction: typeof import("../src/ui/game-action").planAction;
let mayCancel: typeof import("../src/model").mayCancel;
let proxyList: typeof import("../src/screens/settings-kit").proxyList;
beforeAll(async () => {
  ({ planAction } = await import("../src/ui/game-action"));
  ({ mayCancel } = await import("../src/model"));
  ({ proxyList } = await import("../src/screens/settings-kit"));
});

/** a game the server is downloading; `may` as the server says it for whoever is looking (absent: a server that does not say) */
const moving = (may?: { cancel: boolean }) => ({
  id: 7, name: "Hades", status: "downloading", statusDetail: "Downloading", monitored: true, tracked: false, hasFile: false, file: null, comingSoon: false, releaseIso: null,
  request: { id: 9, gameId: 7, state: "downloading", stage: "Downloading", progress: 0.4, message: null, release: null, attempt: 1, candidates: 1, createdAt: 1, updatedAt: 1, doneAt: null },
  people: { requestedBy: [], owners: [], playing: [] }, ...(may ? { may } : {}),
}) as unknown as Game;

describe("Cancel on a game the server is fetching", () => {
  test("is offered to whoever the server would take it from", () => {
    expect(planAction({ game: moving({ cancel: true }) }).main).toMatchObject({ kind: "cancel", label: "Cancel" });
    expect(mayCancel(moving({ cancel: true }))).toBe(true);
  });
  test("is not offered to a member whose search it is not: the page says where it is, with nothing to press", () => {
    const plan = planAction({ game: moving({ cancel: false }) });
    expect(plan.main).toBeNull();
    expect(plan.status).toBe("Downloading…");
    expect(mayCancel(moving({ cancel: false }))).toBe(false);
  });
  test("is offered as before by a server that does not say (an older one lets any member)", () => {
    expect(planAction({ game: moving() }).main).toMatchObject({ kind: "cancel" });
    expect(mayCancel(moving())).toBe(true);
  });
  test("an install on this PC is its own to cancel, whoever asked the server for the game", () => {
    const g = { ...moving({ cancel: false }), status: "available", request: null, file: { id: 3, size: 1e9, version: null, kind: "native" } } as unknown as Game;
    const prog = { type: "install", packageId: 3, gameId: 7, slug: "hades", name: "Hades", phase: "downloading", progress: 0.5, bytes: 5, total: 10, rate: 1 } as InstallProgress;
    expect(planAction({ game: g, prog }).main).toMatchObject({ kind: "cancel" });
  });
});

describe("the admin's settings page", () => {
  test("has a field for every setting the server lists (one without a field can only be set by hand, on the server)", async () => {
    const config = await Bun.file(new URL("../../server/src/config.ts", import.meta.url)).text();
    const page = await Bun.file(new URL("../src/screens/settings-admin.tsx", import.meta.url)).text();
    const keys = [...config.matchAll(/\{ key: "([A-Z0-9_]+)"/g)].map(m => m[1]);
    expect(keys).toContain("TRUSTED_PROXY");
    expect(keys.length).toBeGreaterThanOrEqual(7);
    expect(keys.filter(k => !page.includes(`"${k}"`))).toEqual([]);
  });
});

describe("the reverse proxy's address", () => {
  test("addresses and IPv4 blocks, separated by commas or spaces, are saved tidied", () => {
    expect(proxyList("172.17.0.1")).toBe("172.17.0.1");
    expect(proxyList(" 172.17.0.0/16 ,10.0.0.5   192.168.1.20,")).toBe("172.17.0.0/16, 10.0.0.5, 192.168.1.20");
    expect(proxyList("::1, fd00::2, 0.0.0.0/0")).toBe("::1, fd00::2, 0.0.0.0/0");
    expect(proxyList("")).toBe("");                                   // nothing: any private address, the server's own rule
    expect(proxyList("  ")).toBe("");
  });
  test("anything the server could not read as one is refused, not saved (it would find no proxy, and count every visitor as one address)", () => {
    for (const bad of ["traefik", "proxy.local", "172.17.0", "172.17.0.256", "172.17.0.0/33", "172.17.0.0/", "172.17.0.0/16/8", "fd00::/8", "10.0.0.1; 10.0.0.2", "http://10.0.0.1", "10.0.0.1:8080", "localhost"]) {
      expect(proxyList(bad)).toBeNull();
      expect(proxyList(`10.0.0.1, ${bad}`)).toBeNull();
    }
  });
});

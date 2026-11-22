/**
 * The data the pages share (bun test, in web/; the hooks run mounted, tests/harness.ts): the library and a game catch up when
 * the event stream comes back, answers that arrive out of order or for something the page has left are not shown, a store
 * app's kept answer grows old, and nothing kept for one person is there for the next.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FakeEventSource, during, fakeServer, hold, mount, settle } from "./harness";

let data: typeof import("../src/data");
let ev: typeof import("../src/events");
let api: typeof import("../src/api");
let session: typeof import("../src/session");
const g = globalThis as Record<string, any>;
const realES = g.EventSource, realNow = Date.now;
let srv: ReturnType<typeof fakeServer>;

beforeAll(async () => {
  g.EventSource = FakeEventSource;
  api = await import("../src/api");
  ev = await import("../src/events");
  data = await import("../src/data");
  session = await import("../src/session");
});
beforeEach(() => { srv = fakeServer(); api.setToken(null); ev.setStream(true); });
afterEach(() => { ev.setStream(false); srv.restore(); Date.now = realNow; api.forgetPerson(); });
afterAll(() => { g.EventSource = realES; });

/** what the server says over the stream; the pages take it up after their 400 ms pause */
const heard = async (name: string) => { FakeEventSource.last!.say(name, {}); await settle(450); };
const game = (id: number, status: string, over: Record<string, unknown> = {}) => ({ id, name: `Game ${id}`, status, steamAppId: null, request: null, file: null, ...over });
const app = (appId: number, over: Record<string, unknown> = {}) => ({ appId, name: `App ${appId}`, gameId: null, inLibrary: false, comingSoon: false, crackStatus: null, ...over });

describe("the library", () => {
  test("is asked again when the stream comes back: what happened while it was down was never told", async () => {
    let now = [game(1, "downloading")];
    srv.on("/api/v1/game", () => ({ items: now }));
    const m = await mount(() => data.useLibrarySource());
    await settle();
    expect(m.value.games.map(x => x.status)).toEqual(["downloading"]);
    now = [game(1, "available")];                       // the download finished while the stream was down (a restart, a sleeping PC)
    await heard("hello");
    expect(srv.asked("/api/v1/game")).toBe(2);
    expect(m.value.games.map(x => x.status)).toEqual(["available"]);
    await m.unmount();
  });

  test("shows the answer asked for last, whichever comes back last", async () => {
    const first = hold<unknown>(), second = hold<unknown>();
    const answers = [first.promise, second.promise];
    srv.on("/api/v1/game", () => answers.shift());
    const m = await mount(() => data.useLibrarySource());   // asks once as it mounts
    await during(async () => {
      const again = m.value.reload();                        // and again (an event, an action)
      second.go({ items: [game(1, "available")] });
      await again;
    });
    expect(m.value.games.map(x => x.status)).toEqual(["available"]);
    first.go({ items: [game(1, "downloading")] });           // the older answer, late
    await settle();
    expect(m.value.games.map(x => x.status)).toEqual(["available"]);
    expect(m.value.loaded).toBe(true);
    await m.unmount();
  });
});

describe("one game", () => {
  test("an answer that arrives after the page moved on to another game is not shown; the stream coming back asks again", async () => {
    const slow = hold<unknown>();
    srv.on("/api/v1/game/1", () => slow.promise);
    srv.on("/api/v1/game/2", { item: game(2, "available") });
    let id = 1;
    const m = await mount(() => data.useGame(id));
    id = 2; await m.rerender(); await settle();
    expect(m.value.item?.id).toBe(2);
    slow.go({ item: game(1, "available") });                 // game 1's answer, late
    await settle();
    expect(m.value.item?.id).toBe(2);
    await heard("hello");
    expect(srv.asked("/api/v1/game/2")).toBe(2);
    await m.unmount();
  });

  test("another game starts without the last one's error", async () => {
    srv.on("/api/v1/game/2", { item: game(2, "available") });   // game 1 is not on the server: 404
    let id = 1;
    const m = await mount(() => data.useGame(id));
    await settle();
    expect(m.value.error).toBeTruthy();
    const later = hold<unknown>();
    srv.on("/api/v1/game/2", () => later.promise);
    id = 2; await m.rerender();
    expect(m.value.error).toBeNull();                         // loading, not "that game is not on your server"
    later.go({ item: game(2, "available") });
    await settle();
    expect(m.value.item?.id).toBe(2);
    await m.unmount();
  });
});

describe("a person's profile", () => {
  test("an answer that arrives after the page moved on to someone else is not shown there", async () => {
    const slow = hold<unknown>();
    srv.on("/api/v1/people/anne", () => slow.promise);
    srv.on("/api/v1/people/bart", { user: { id: 2, name: "bart" }, games: [] });
    let name = "anne";
    const m = await mount(() => data.useProfile(name));
    name = "bart"; await m.rerender(); await settle();
    expect(m.value.item?.user.name).toBe("bart");
    slow.go({ user: { id: 1, name: "anne" }, games: [] });   // Anne's page, late
    await settle();
    expect(m.value.item?.user.name).toBe("bart");
    await m.unmount();
  });
});

describe("a store app's answer", () => {
  test("is kept, and asked again once it is ten minutes old (it says how the app stands on this server): the old one stays up meanwhile", async () => {
    let now = app(10, { gameId: 5, inLibrary: true });
    srv.on("/api/v1/discover/app/10", () => ({ item: now }));
    const a = await mount(() => data.useApp(10));
    await settle();
    expect(a.value.item?.gameId).toBe(5);
    await a.unmount();
    const b = await mount(() => data.useApp(10));              // the page again, soon after: the kept answer, nothing asked
    await settle();
    expect(b.value.item?.gameId).toBe(5);
    expect(srv.asked("/api/v1/discover/app/10")).toBe(1);
    await b.unmount();

    now = app(10);                                             // the game was taken off the server since
    Date.now = () => realNow() + data.APP_FRESH_MS + 1000;
    const later = hold<void>();
    srv.on("/api/v1/discover/app/10", async () => { await later.promise; return { item: now }; });
    const c = await mount(() => data.useApp(10));
    expect(c.value.item?.gameId).toBe(5);                      // the old answer while the new one comes
    later.go();
    await settle();
    expect(srv.asked("/api/v1/discover/app/10")).toBe(2);
    expect(c.value.item?.gameId).toBeNull();
    expect(c.value.error).toBeNull();
    await c.unmount();
  });

  test("that arrives after the page moved on to another app is not shown there", async () => {
    const slow = hold<unknown>();
    srv.on("/api/v1/discover/app/20", () => slow.promise);
    srv.on("/api/v1/discover/app/21", { item: app(21) });
    const seed = await mount(() => data.useApp(21)); await settle(); await seed.unmount();   // app 21 is already kept
    let id = 20;
    const m = await mount(() => data.useApp(id));
    id = 21; await m.rerender(); await settle();
    expect(m.value.item?.appId).toBe(21);
    slow.go({ item: app(20) });                               // app 20's answer, late
    await settle();
    expect(m.value.item?.appId).toBe(21);                     // (it was shown here, and the page's guard then showed nothing of the store's)
    await m.unmount();
  });

  test("names a library game only while the library has it", () => {
    const lib = (ids: number[], byApp: [number, number][] = [], loaded = true) =>
      ({ loaded, byId: new Map(ids.map(i => [i, game(i, "available")])), byApp: new Map(byApp.map(([a, i]) => [a, game(i, "available")])) }) as unknown as Parameters<typeof data.gameOfApp>[0];
    expect(data.gameOfApp(lib([5]), 10, app(10, { gameId: 5 }))).toBe(5);
    expect(data.gameOfApp(lib([]), 10, app(10, { gameId: 5 }))).toBeNull();                   // removed since the answer was kept: no page to go to
    expect(data.gameOfApp(lib([7], [[10, 7]]), 10, app(10, { gameId: 5 }))).toBe(7);          // the library's own game for the app
    expect(data.gameOfApp(lib([7], [[10, 7]]), 10, null)).toBe(7);                            // before the store answered
    expect(data.gameOfApp(lib([], [], false), 10, app(10, { gameId: 5 }))).toBe(5);           // the library not read yet: the answer is all there is
    expect(data.gameOfApp(lib([5]), 10, app(10))).toBeNull();
  });
});

describe("a kept row (More like this, a genre)", () => {
  test("shows only what belongs to what the page is on now: not the last game's answer when it comes late, nothing for no app", async () => {
    const slow = hold<unknown>();
    srv.on("/api/v1/discover/app/30/similar", () => slow.promise);
    srv.on("/api/v1/discover/app/31/similar", { items: [app(310)] });
    const seed = await mount(() => data.useSimilar(31)); await settle(); await seed.unmount();   // game B's row is already kept
    let id: number | null = 30;
    const m = await mount(() => data.useSimilar(id));         // game A: its row is still on its way…
    id = 31; await m.rerender(); await settle();              // …when the page moves to game B
    expect(m.value.items?.map(x => x.appId)).toEqual([310]);
    slow.go({ items: [app(300)] });
    await settle();
    expect(m.value.items?.map(x => x.appId)).toEqual([310]);  // A's row did not land under B
    id = null; await m.rerender(); await settle();            // a game the store does not know
    expect(m.value.items).toBeNull();
    await m.unmount();
    const a = await mount(() => data.useSimilar(30));         // A's late answer was kept for A
    expect(a.value.items?.map(x => x.appId)).toEqual([300]);
    await a.unmount();
  });

  test("an error does not outlive what it was about", async () => {
    srv.on("/api/v1/discover/genre/2", { sellers: [app(1)], rated: [] });   // genre 1 fails: 404
    let tag = 1;
    const m = await mount(() => data.useGenre(tag));
    await settle();
    expect(m.value.error).toBeTruthy();
    tag = 2; await m.rerender(); await settle();
    expect(m.value.error).toBeNull();
    expect(m.value.items?.sellers.length).toBe(1);
    await m.unmount();
  });
});

describe("the next person on this PC", () => {
  const friends = (name: string) => ({ friends: [{ id: 9, name, displayName: name }], incoming: [], outgoing: [] });

  test("does not start from the last one's friends", async () => {
    srv.on("/api/v1/friends", friends("anne-s-friend"));
    const a = await mount(() => data.useFriends());
    await settle();
    expect(a.value.data?.friends[0].name).toBe("anne-s-friend");
    await a.unmount();

    session.signedOut();                                       // Anne signs out (or her session ended)
    expect(api.token()).toBeNull();
    expect(FakeEventSource.last!.closed).toBe(true);           // the stream is let go with her

    const theirs = hold<unknown>();
    srv.on("/api/v1/friends", () => theirs.promise);           // Bart signs in: his own answer is still on its way
    const b = await mount(() => data.useFriends());
    expect(b.value.data).toBeNull();
    theirs.go(friends("bart-s-friend"));
    await settle();
    expect(b.value.data?.friends[0].name).toBe("bart-s-friend");
    await b.unmount();
  });

  test("is not handed an answer of the last one's that came after they left", async () => {
    const late = hold<unknown>();
    srv.on("/api/v1/friends", () => late.promise);
    const a = await mount(() => data.useFriends());
    await a.unmount();
    session.signedOut();
    late.go(friends("anne-s-friend"));                         // asked for by Anne, answered after she left
    await settle();
    const theirs = hold<unknown>();
    srv.on("/api/v1/friends", () => theirs.promise);
    const b = await mount(() => data.useFriends());
    expect(b.value.data).toBeNull();
    theirs.go(friends("bart-s-friend"));
    await settle();
    await b.unmount();
  });

  test("finds none of the store's kept answers either", async () => {
    srv.on("/api/v1/discover/app/40", { item: app(40) });
    srv.on("/api/v1/discover/app/40/similar", { items: [app(400)] });
    const a = await mount(() => [data.useApp(40), data.useSimilar(40)] as const);
    await settle();
    expect(a.value[0].item?.appId).toBe(40);
    await a.unmount();
    session.signedOut();
    const wait = hold<unknown>();
    srv.on("/api/v1/discover/app/40", () => wait.promise);
    srv.on("/api/v1/discover/app/40/similar", () => wait.promise);
    const b = await mount(() => [data.useApp(40), data.useSimilar(40)] as const);
    expect(b.value[0].item).toBeNull();
    expect(b.value[1].items).toBeNull();
    wait.go({});
    await b.unmount();
  });
});

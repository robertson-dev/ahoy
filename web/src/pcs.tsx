/**
 * Your PCs, live for every page, and the part of the page that does a PC's work.
 *
 * Every page reads the same lists: my PCs, what is to be installed on them (orders), and what is on each. In the launcher
 * the page also says "this PC is here" (its name, version and room) and carries this PC's orders out: an order whose game
 * has a copy is installed with the launcher's own Install, one at a time; how far it is, that it is done, or why it failed
 * is told to the server, where whoever placed the order (a phone, the couch) reads it. An install stopped here ends its
 * order; an order cancelled elsewhere stops its install here.
 *
 * The launcher also shows a Windows notification, when its window is not in front (launchers from 0.13): a game finished
 * installing here, or a game I asked for arrived on the server and nothing installs it here. Clicking one opens the game.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { del, get, personNow, post, put } from "./api";
import { useLib } from "./data";
import { useEvents } from "./events";
import { launcher, refreshesStart, type LauncherEvent } from "./launcher";
import { useLauncher } from "./launcher-state";
import { isOpen, orderStep, pcStates, type Order, type Pc, type PcState } from "./orders";
import { errText } from "./screens/settings-kit";
import { useSession } from "./session";

interface Installed { device: string; gameId: number | null; packageId: number | null }
interface PcsState {
  /** this PC's name; null in a plain browser */
  here: string | null;
  pcs: Pc[]; orders: Order[]; loaded: boolean;
  /** every PC of mine as it stands to one game */
  statesOf: (gameId: number) => PcState[];
  place: (device: string, gameId: number) => Promise<Order>;
  cancel: (id: number) => Promise<void>;
  setAuto: (device: string, auto: boolean) => Promise<void>;
  forget: (device: string) => Promise<void>;
  reload: () => Promise<void>;
}
const none: PcsState = { here: null, pcs: [], orders: [], loaded: false, statesOf: () => [], place: async () => { throw new Error("not signed in"); }, cancel: async () => {}, setAuto: async () => {}, forget: async () => {}, reload: async () => {} };
const Ctx = createContext<PcsState>(none);
export const usePcs = () => useContext(Ctx);

/** how often an install's progress is told to the server */
const SAY_EVERY_MS = 2500;
/** a route a notification may open: one of the app's own pages */
const routeOk = (r: unknown): r is string => typeof r === "string" && /^\/[A-Za-z0-9/_-]*$/.test(r) && !r.startsWith("//");

export function PcsProvider({ children }: { children: ReactNode }) {
  const { me, device } = useSession();
  const L = useLauncher();
  const lib = useLib();
  const nav = useNavigate();
  const here = launcher && me ? device : null;
  const [pcs, setPcs] = useState<Pc[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [installs, setInstalls] = useState<Installed[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** room left where games go, as the launcher last said (null: it cannot say) */
  const free = useRef<number | null>(null);

  const reload = useCallback(async () => {
    if (!me) return;
    const who = personNow();
    try {
      const [p, o, i] = await Promise.all([get<{ items: Pc[] }>("/api/v1/me/pcs"), get<{ items: Order[] }>("/api/v1/me/orders"), get<{ items: Installed[] }>("/api/v1/me/installed")]);
      if (who !== personNow()) return;
      setPcs(p.items); setOrders(o.items); setInstalls(i.items); setLoaded(true);
    } catch { /* the stream's next word asks again */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  /** "this PC is here": its name, its launcher's version, the room it has. Then the lists */
  const register = useCallback(async () => {
    if (!me) return;
    if (launcher && here) {
      free.current = await launcher.disk?.().then(d => (d && Number.isFinite(d.free) ? d.free : null)).catch(() => null) ?? null;
      await put("/api/v1/me/pc", { device: here, version: launcher.version, freeBytes: free.current }).catch(() => {});
    }
    await reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id, here, reload]);
  useEffect(() => { setPcs([]); setOrders([]); setInstalls([]); setLoaded(false); void register(); }, [register]);
  // "hello": the stream is back; what happened meanwhile was never told
  useEvents(["pc", "order", "install", "hello"], () => void reload(), [reload]);

  const merge = (o: Order) => setOrders(list => (list.some(x => x.id === o.id) ? list.map(x => (x.id === o.id ? o : x)) : [o, ...list.filter(x => !(x.device === o.device && x.gameId === o.gameId))]));
  const place = useCallback(async (dev: string, gameId: number) => { const r = await post<{ item: Order }>("/api/v1/me/orders", { device: dev, gameId }); merge(r.item); return r.item; }, []);
  const cancel = useCallback(async (id: number) => { await del(`/api/v1/me/orders/${id}`); setOrders(list => list.filter(x => x.id !== id)); }, []);
  const setAuto = useCallback(async (dev: string, auto: boolean) => {
    const r = await put<{ pc: Pc }>(`/api/v1/me/pcs/${encodeURIComponent(dev)}`, { auto });
    setPcs(list => list.map(p => (p.device === dev ? r.pc : p)));
    void reload();
  }, [reload]);
  const forget = useCallback(async (dev: string) => { await del(`/api/v1/me/pcs/${encodeURIComponent(dev)}`); await reload(); }, [reload]);

  const statesOf = useCallback((gameId: number) => pcStates(gameId, pcs, orders, installs, here, !!L.installedFor(gameId)), [pcs, orders, installs, here, L.installedFor]);

  /* ─────────── this PC's work ─────────── */

  /** what the effects below read without running again for it */
  const now = useRef({ orders, lib, here, me });
  now.current = { orders, lib, here, me };
  /** orders with something on its way to the server (one report at a time each) */
  const acting = useRef(new Set<number>());
  /** installs this page started for an order and that have not ended: order id → package id (an order that goes away stops
   *  its install; one that is here is not started twice while the launcher has yet to say its first word about it) */
  const started = useRef(new Map<number, number>());
  /** when each order's progress was last told */
  const told = useRef(new Map<number, number>());

  /** tell the server how an order goes; the answer is the order as it stands */
  const say = useCallback(async (id: number, body: { state: string; progress?: number; error?: string }) => {
    if (acting.current.has(id)) return;
    acting.current.add(id);
    try { merge((await put<{ item: Order }>(`/api/v1/me/orders/${id}`, body)).item); }
    catch { /* asked again when the lists next change */ }
    finally { acting.current.delete(id); }
  }, []);

  // carry out what waits for this PC
  useEffect(() => {
    if (!launcher || !here || !loaded || !L.loaded || !lib.loaded) return;
    // an order that went away (cancelled from somewhere else) stops the install it started here
    for (const [id, packageId] of started.current) {
      if (orders.some(o => o.id === id)) continue;
      started.current.delete(id);
      if (L.installs[packageId]) void L.cancelInstall(packageId);
    }
    let busy = Object.keys(L.installs).length > 0 || started.current.size > 0;
    const mine = orders.filter(o => o.device === here && isOpen(o)).sort((a, b) => a.id - b.id);
    for (const o of mine) {
      if (acting.current.has(o.id)) continue;
      const g = lib.byId.get(o.gameId), f = g?.file;
      const step = orderStep(o, g, {
        inst: g ? L.installedFor(g.id, f?.id) : undefined, flying: started.current.has(o.id) || (!!f && !!L.installs[f.id]), busy, free: free.current,
        canArgv: !!launcher.features?.includes("argv"), launcherVersion: launcher.version ?? null, refreshes: refreshesStart, server: L.server,
      });
      if (step.do === "done") void say(o.id, { state: "done" });
      else if (step.do === "fail") void say(o.id, { state: "failed", error: step.error });
      else if (step.do === "follow") { if (o.state !== "installing") void say(o.id, { state: "installing", progress: L.installs[step.packageId]?.progress ?? 0 }); }
      else if (step.do === "install") {
        busy = true;
        const id = o.id;
        started.current.set(id, step.packageId);
        void say(id, { state: "installing", progress: 0 });
        // the launcher's own Install; how it ends is also said by its events below (whichever comes first tells the server)
        launcher.install(step.packageId).then(
          () => { if (started.current.delete(id)) { acting.current.delete(id); void say(id, { state: "done" }); } },
          err => {
            if (!started.current.delete(id)) return;
            acting.current.delete(id);
            if (/cancelled/i.test(String(err?.message ?? err))) void drop(id);
            else void say(id, { state: "failed", error: errText(err, "launcher") });
          });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, lib.games, lib.loaded, L.installed, L.installs, L.loaded, here, loaded]);

  /** an order ended by hand on this PC */
  const drop = useCallback((id: number) => del(`/api/v1/me/orders/${id}`).then(() => setOrders(x => x.filter(y => y.id !== id))).catch(() => {}), []);

  // what the launcher says about an install: how far (told on, now and then), that it ended (told at once)
  useEffect(() => {
    if (!launcher) return;
    return launcher.onEvent((e: LauncherEvent) => {
      if (e.type === "open") { if (routeOk(e.route)) nav(e.route); return; }
      if (e.type !== "install") return;
      const { orders: list, lib: l, here: pc } = now.current;
      const gameId = e.gameId ?? l.games.find(g => g.file?.id === e.packageId)?.id ?? null;
      const o = pc && gameId != null ? list.find(x => x.device === pc && x.gameId === gameId && isOpen(x)) : undefined;
      if (e.phase === "done") {
        if (o) { started.current.delete(o.id); acting.current.delete(o.id); void say(o.id, { state: "done" }); }
        void launcher!.notify?.({ title: `${e.name} is ready to play`, route: gameId != null ? `/game/${gameId}` : "/library" })?.catch(() => {});
        void register();                                       // the room left changed
      } else if (e.phase === "failed") {
        if (o) { started.current.delete(o.id); acting.current.delete(o.id); void say(o.id, { state: "failed", error: e.message ?? "Didn't install" }); }
      } else if (e.phase === "cancelled") {
        // stopped here by hand: the order ends with it (it would start again at once otherwise)
        if (o) { started.current.delete(o.id); void drop(o.id); }
      } else if (o) {
        const t = Date.now();
        if (t - (told.current.get(o.id) ?? 0) < SAY_EVERY_MS) return;
        told.current.set(o.id, t);
        void say(o.id, { state: "installing", progress: e.progress });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [say, register, drop]);

  // a game I asked for arrived on the server, and nothing installs it on this PC: say so (the launcher shows it when its
  // window is not in front). What was there when the page loaded is not news
  const had = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!launcher?.notify || !lib.loaded || !me) return;
    const have = new Set(lib.games.filter(g => g.status === "available" && g.file).map(g => g.id));
    const before = had.current;
    had.current = have;
    if (!before) return;
    for (const g of lib.games) {
      if (!have.has(g.id) || before.has(g.id)) continue;
      if (!g.people.requestedBy.some(r => r.user.id === me.id)) continue;
      if (now.current.orders.some(o => o.device === here && o.gameId === g.id && isOpen(o))) continue;
      void launcher.notify({ title: `${g.name} has arrived`, body: "Ready to install", route: `/game/${g.id}` }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.games, lib.loaded, me?.id]);

  const value = useMemo<PcsState>(() => ({ here, pcs, orders, loaded, statesOf, place, cancel, setAuto, forget, reload }), [here, pcs, orders, loaded, statesOf, place, cancel, setAuto, forget, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

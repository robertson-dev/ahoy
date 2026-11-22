/**
 * What the launcher knows, kept live for every page: installed games, installs in flight, what is running.
 * The page also tells the server about it (what is installed on this PC, what is being played), so friends see it.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { launcher, inLauncher, PHASE_LABEL, type InstalledGame, type InstallProgress, type LauncherEvent, type UpdateState } from "./launcher";
import { post, put } from "./api";
import { useUi } from "./ui/kit";
import { useSession } from "./session";
import { errText } from "./screens/settings-kit";
import { useNews } from "./whatsnew-state";

interface LauncherState {
  inLauncher: boolean;
  /** this PC's list has come from the launcher (always true in a plain browser): before that, no games is not "none" */
  loaded: boolean;
  installed: InstalledGame[];
  installs: Record<number, InstallProgress>;      // by package id, while one is in flight
  playing: Record<string, boolean>;               // by slug
  update: UpdateState | null;                     // the launcher's own update, when it can update itself
  /** the server address the launcher uses now (its setting), which its copies are recorded under; null until it says */
  server: string | null;
  checkUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  installedFor: (gameId: number | null | undefined, packageId?: number | null) => InstalledGame | undefined;
  install: (packageId: number) => Promise<void>;
  cancelInstall: (packageId: number) => Promise<void>;
  uninstall: (slug: string) => Promise<void>;
  play: (slug: string) => Promise<void>;
  openFolder: (slug: string) => Promise<void>;
}

/**
 * What must happen before a game starts (its saves brought in step: saves-state.tsx). Each is asked in turn with the game's
 * slug; one that answers false keeps the game from starting (the player closed a question it asked).
 */
export const playGuards = new Set<(slug: string) => Promise<boolean>>();

const Ctx = createContext<LauncherState>({ inLauncher: false, loaded: true, installed: [], installs: {}, playing: {}, update: null, server: null, checkUpdate: async () => {}, installUpdate: async () => {}, installedFor: () => undefined, install: async () => {}, cancelInstall: async () => {}, uninstall: async () => {}, play: async () => {}, openFolder: async () => {} });
export const useLauncher = () => useContext(Ctx);

export function LauncherProvider({ children }: { children: ReactNode }) {
  const { toast } = useUi();
  const { me, device } = useSession();
  const news = useNews();
  const [installed, setInstalled] = useState<InstalledGame[]>([]);
  const [loaded, setLoaded] = useState(!launcher);
  const [installs, setInstalls] = useState<Record<number, InstallProgress>>({});
  const [playing, setPlaying] = useState<Record<string, boolean>>({});
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [server, setServer] = useState<string | null>(null);
  const latest = useRef<InstalledGame[] | null>(null);    // this PC's list as the launcher last gave it; null until it first answers
  const installUpdate = useCallback(async () => { await launcher?.installUpdate?.(); }, []);
  const checkUpdate = useCallback(async () => { const s = await launcher?.checkUpdate?.(); if (s) setUpdate(s); }, []);

  // The server's copy of this PC's list: sent whenever it changes, and once after signing in. Never before the launcher's
  // first answer: this mounts once signed in, before launcher.installed() resolves, and an empty list would make the server
  // forget every game on this PC (and its play time).
  const report = useCallback((list: InstalledGame[] | null) => {
    if (!list || !me || !device) return;
    void put("/api/v1/me/installed", { device, items: list.map(g => ({ slug: g.slug, gameId: g.gameId, packageId: g.packageId, name: g.name, sizeBytes: g.sizeBytes, installedAt: g.installedAt })) }).catch(() => {});
  }, [me, device]);
  useEffect(() => { if (launcher && me) report(latest.current); }, [me, report]);

  useEffect(() => {
    if (!launcher) return;
    let live = true;
    void launcher.installed().then(l => {
      if (!live) return;                                     // a newer run of this effect asks again
      const first = latest.current == null;
      latest.current = l; setInstalled(l); setLoaded(true);
      if (first) report(l);                                  // the first real list, so the server may hear it now
    }).catch(() => { if (live) setLoaded(true); });          // no answer: show what there is (nothing) rather than wait
    void launcher.updateState?.().then(setUpdate).catch(() => {});
    void launcher.config().then(c => { if (live && typeof c?.serverUrl === "string") setServer(c.serverUrl); }).catch(() => {});
    const off = launcher.onEvent((e: LauncherEvent) => {
      if (e.type === "installed-changed") { latest.current = e.installed; setInstalled(e.installed); setLoaded(true); report(e.installed); }
      else if (e.type === "install") {
        setInstalls(m => { const n = { ...m }; if (e.phase === "done" || e.phase === "failed" || e.phase === "cancelled") delete n[e.packageId]; else n[e.packageId] = e; return n; });
        if (e.phase === "done") toast(`${e.name} is installed`, "success");
        if (e.phase === "failed") toast(`${e.name}: ${e.message ?? PHASE_LABEL.failed}`, "danger");
      } else if (e.type === "update") {
        setUpdate(prev => { if (e.update.status === "ready" && prev?.status !== "ready") toast(<>Ahoy {e.update.version} is downloaded. <button className="link" onClick={() => void installUpdate()}>Restart to update</button> <button className="link" onClick={() => news.open(e.update.version)}>What's new</button></>, "success", 12_000); return e.update; });
      } else if (e.type === "play") {
        setPlaying(p => ({ ...p, [e.slug]: e.running }));
        const g = latest.current?.find(x => x.slug === e.slug);
        if (!e.running && e.message) toast(`${g?.name ?? "The game"} didn't start`, "danger");
        if (me && device) void post("/api/v1/me/playing", { running: e.running, gameId: g?.gameId ?? null, name: g?.name ?? e.slug, slug: e.slug, device }).catch(() => {});
      }
    });
    return () => { live = false; off(); };
  }, [toast, report, me, device, installUpdate, news.open]);

  const installedFor = useCallback((gameId: number | null | undefined, packageId?: number | null) =>
    installed.find(g => (packageId != null && g.packageId === packageId) || (gameId != null && g.gameId === gameId)), [installed]);
  const install = useCallback(async (packageId: number) => {
    if (!launcher) throw new Error("installing needs the Ahoy launcher");
    try { await launcher.install(packageId); } catch (e: any) {
      const m = String(e?.message ?? e);
      // a copy this launcher is too old to start (it says so before downloading anything)
      if (/update-needed:/.test(m)) toast("Update Ahoy to play this", "danger");
      else if (!/cancelled/.test(m)) toast(errText(e, "launcher"), "danger");   // the launcher's own sentence, without the IPC wrapping
    }
  }, [toast]);
  const cancelInstall = useCallback(async (packageId: number) => { await launcher?.cancelInstall(packageId); }, []);
  const uninstall = useCallback(async (slug: string) => { await launcher?.uninstall(slug); }, []);
  const play = useCallback(async (slug: string) => {
    if (!launcher) return;
    for (const guard of playGuards) { try { if (!(await guard(slug))) return; } catch { /* a guard that fails keeps nobody from playing */ } }
    setPlaying(p => ({ ...p, [slug]: true }));
    try { await launcher.play(slug); } catch (e: any) { setPlaying(p => ({ ...p, [slug]: false })); toast(errText(e, "launcher"), "danger"); }
  }, [toast]);
  const openFolder = useCallback(async (slug: string) => { await launcher?.openFolder(slug); }, []);

  return <Ctx.Provider value={{ inLauncher, loaded, installed, installs, playing, update, server, checkUpdate, installUpdate, installedFor, install, cancelInstall, uninstall, play, openFolder }}>{children}</Ctx.Provider>;
}

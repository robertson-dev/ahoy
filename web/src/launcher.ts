/** The bridge the Ahoy launcher injects (window.ahoyLauncher). Null in a plain browser. */
import { timeAgo, type Game } from "./api";

export interface InstalledGame {
  slug: string; gameId: number | null; packageId: number; name: string; version: string | null;
  /** rev: the stamp of the start as this PC recorded it (the manifest's launch.rev; absent when the server never changed it) */
  path: string; launch: { exe: string; args: string; cwd: string; argv?: string[]; env?: Record<string, string>; rev?: number | string | null };
  kind: "native" | "rom" | "recomp" | "port" | "emulated"; platform: string | null;
  sizeBytes: number; installedAt: number; serverUrl: string;
  /** launchers from 0.10 (feature "argv"): saves kept across updates and uninstalls, settings shipped once, the shortcut it made */
  keep?: string[]; seed?: string[]; shortcut?: string | null;
  /** launchers from 0.11 ("launch-refresh"): the stamp of a start the server changed in place that Play did not take on this PC */
  skippedRev?: number | string | null;
}
export type InstallPhase = "downloading" | "verifying" | "prerequisites" | "finishing" | "done" | "failed" | "cancelled";
export interface InstallProgress {
  type: "install"; packageId: number; gameId: number | null; slug: string; name: string; phase: InstallPhase;
  progress: number; bytes: number; total: number; rate: number; message?: string;
}
/** the launcher's own updater: it follows the build the connected server publishes under /launcher/. "off" (launchers that
 *  check where a build comes from): it follows none from this server's address, and `error` is its sentence saying why */
export interface UpdateState { status: "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error" | "off"; version: string | null; percent: number; error: string | null; checkedAt: number | null }
export type LauncherEvent = InstallProgress
  | { type: "installed-changed"; installed: InstalledGame[] }
  | { type: "play"; slug: string; running: boolean; pid?: number; code?: number | null; message?: string }
  | { type: "update"; update: UpdateState }
  /** the launcher asks for the big screen (its pad button set to open it, a start with --big); on: false asks to leave it */
  | { type: "big"; on?: boolean }
  /** a notification of the launcher's was clicked (its window is in front by now): the page it names is to be opened */
  | { type: "open"; route: string };

/** what the pad's home button (Xbox, PS) does while the launcher runs: nothing, bring the window to the front, or that and the big screen */
export type PadButton = "off" | "show" | "big";
/** padButton: launchers from 0.12 (feature "pad-button"). background, startWithWindows: from 0.13 (feature "background"):
 *  closing the window leaves Ahoy running by the clock (what was asked for elsewhere installs meanwhile), and Ahoy starts with
 *  Windows, there and not in front. syncSaves: from 0.13 (feature "saves"): this PC's saves are kept in step with the server */
export interface LauncherConfig { serverUrl: string; libraryDir: string; desktopShortcuts: boolean; user: string; hasSession: boolean; version: string; platform: string; hostname: string; padButton?: PadButton; background?: boolean; startWithWindows?: boolean; syncSaves?: boolean }

export interface LauncherBridge {
  version: string;
  features?: string[];
  config(): Promise<LauncherConfig>;
  /** sendsTo: the address answers by sending on to that other one, which the launcher never takes in its place */
  probe(patch: Record<string, unknown>): Promise<{ ok: boolean; detail: string; version?: string; sendsTo?: string }>;
  setConfig(patch: Partial<{ serverUrl: string; libraryDir: string; desktopShortcuts: boolean; padButton: PadButton; background: boolean; startWithWindows: boolean; syncSaves: boolean }>): Promise<{ ok: boolean; error?: string; sendsTo?: string }>;
  /** the page signed in (or out): the launcher keeps the token for its own downloads */
  setSession(s: { token: string; user: string } | null): Promise<{ ok: boolean }>;
  /** the token the launcher keeps, so the page is signed in the moment it loads */
  session(): Promise<{ token: string; user: string } | null>;
  pickDir(): Promise<string | null>;
  state(): Promise<{ installed: InstalledGame[]; config: LauncherConfig }>;
  installed(): Promise<InstalledGame[]>;
  install(packageId: number): Promise<InstalledGame>;
  cancelInstall(packageId: number): Promise<boolean>;
  /** launchers with "argv" keep a game's saves on uninstall unless deleteSaves */
  uninstall(slug: string, opts?: { deleteSaves?: boolean }): Promise<boolean>;
  play(slug: string): Promise<number>;
  openFolder(slug: string): Promise<boolean>;
  onEvent(cb: (e: LauncherEvent) => void): () => void;
  /** launchers from 0.7 on update themselves; older ones lack these */
  /** launchers from 0.8 on go fullscreen natively (feature "fullscreen"), so Esc stays the page's key */
  fullscreen?(on: boolean): Promise<boolean>;
  isFullscreen?(): Promise<boolean>;
  /** launchers from 0.12 (feature "zoom"): the page's own zoom (1 is its real size); the big screen is the app zoomed for a television */
  zoom?(factor: number): Promise<number>;
  /** launchers from 0.12 (feature "big"): was the big screen asked for before the page could hear it (--big, the pad button)? Asked once */
  wantsBig?(): Promise<boolean>;
  /** launchers from 0.13 (feature "notify"): a Windows notification. Shown only while the launcher's window is not in front
   *  (the answer says whether it was); clicking it brings the window forward and tells the page to open `route` (event "open") */
  notify?(n: { title: string; body?: string; route?: string }): Promise<boolean>;
  /** launchers from 0.13 (feature "disk"): the room on the drive games are installed to, in bytes; null when it cannot say */
  disk?(): Promise<{ free: number; total: number } | null>;
  /** launchers from 0.13 (feature "saves"): a game's saves on this PC and on the server. The page says which game (its slug
   *  here, its key everywhere), where it keeps its saves (the server's rules) and what to do (saves.ts decides); the launcher
   *  looks (state), brings this PC's saves to the server as its newest version (push; null: none here), takes a version from
   *  there and puts it back here (pull; what it replaces is copied aside first), notes that this PC has what a version has
   *  (agree), and lets the person point at a folder (pick: the folder as a rule, why it cannot be one, or null: cancelled) */
  saves?: {
    state(slug: string, key: string, rules: unknown): Promise<{ digest: string | null; files: number; bytes: number; newest: number | null; tooBig: boolean; where: string[]; base: { id: number; digest: string } | null }>;
    push(slug: string, key: string, rules: unknown): Promise<{ id: number; digest: string; same: boolean } | null>;
    pull(slug: string, key: string, rules: unknown, id: number): Promise<{ written: number; removed: number; skipped: number; digest: string | null }>;
    agree(slug: string, key: string, rules: unknown, snap: { id: number; digest: string }): Promise<boolean>;
    pick(slug: string): Promise<{ rule: string } | { error: string } | null>;
  };
  updateState?(): Promise<UpdateState>;
  checkUpdate?(): Promise<UpdateState>;
  installUpdate?(): Promise<void>;
}

export const launcher: LauncherBridge | null = (globalThis as { ahoyLauncher?: LauncherBridge }).ahoyLauncher ?? null;
export const inLauncher = !!launcher;
/** this launcher takes a start the server changed in place at Play (0.11 on), so such a change needs no Update on this PC */
export const refreshesStart = !!launcher?.features?.includes("launch-refresh");

/**
 * Is a launcher of this version older than the one a copy needs (file.requiresLauncher: "0.11.0" for a game that starts
 * through its own script)? It would refuse the copy, so the player is told to update Ahoy instead of being offered an
 * Install or Update that fails. A version that cannot be read is not called older.
 */
export function olderThan(version: string | null | undefined, needs: string | null | undefined): boolean {
  const parts = (v: string | null | undefined) => { const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v ?? "").trim()); return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null; };
  const a = parts(version), b = parts(needs);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/**
 * Is the server's copy newer than this PC's? Another package is (a new build, an upgrade). So is the same package whose start
 * the server changed in place since this PC recorded it (file.launchRev against the recorded launch.rev), unless the launcher
 * takes that start at Play by itself (followsStart). Its Update installs the same package again: nothing is downloaded, but
 * every file is checked and the package's setup programs run again.
 */
export function newerCopy(g: Pick<Game, "file"> | null | undefined, inst: Pick<InstalledGame, "packageId" | "launch" | "serverUrl" | "skippedRev"> | null | undefined,
  refreshes: boolean | null | undefined, server?: string | null): boolean {
  const f = g?.file;
  if (!f || !inst) return false;
  if (f.id !== inst.packageId) return true;
  if (f.launchRev == null || String(f.launchRev) === String(inst.launch?.rev ?? "")) return false;
  return !followsStart(inst, f.launchRev, refreshes, server);
}

/**
 * Does the launcher take this copy's changed start (stamp `rev`) at Play by itself? One with "launch-refresh" does, for a copy
 * recorded under the server address it uses now (`server`, compared as the launcher compares them; while not known, it is
 * taken to be that one): it asks only that server, so a copy installed from another address (the engine's own, before Ahoy)
 * gets Update, which records it under this one. Not when Play could not take that start for the copy (the launcher noted it).
 */
export function followsStart(inst: Pick<InstalledGame, "serverUrl" | "skippedRev">, rev: number | string, refreshes: boolean | null | undefined, server?: string | null): boolean {
  if (!refreshes) return false;
  if (inst.skippedRev != null && String(inst.skippedRev) === String(rev)) return false;
  const bare = (u: unknown) => (typeof u === "string" ? u.replace(/\/+$/, "") : null);
  return !server || bare(inst.serverUrl) === bare(server);
}

/**
 * Where the launcher's own update stands, as Settings words it: "Up to date · checked 2 h ago", a build on its way, or a
 * failure in the product's words (red; what the updater said is kept for the pointer). Updates being off is not a failure:
 * the launcher's own sentence saying why is the line, plain. A status this page does not know says nothing.
 */
export function updateLine(u: UpdateState | null): { text: string; bad?: boolean; detail?: string } | null {
  if (!u) return null;
  switch (u.status) {
    case "none": return { text: `Up to date${u.checkedAt ? ` · checked ${timeAgo(u.checkedAt, true)}` : ""}` };
    case "checking": return { text: "Checking for an update" };
    case "available": return { text: `${u.version ?? "A new version"} is on its way` };
    case "downloading": return { text: `Downloading ${u.version ?? "the update"} · ${Math.round(u.percent)}%` };
    case "ready": return { text: `${u.version ?? "The update"} is ready` };
    case "error": return { text: "The update didn't make it", bad: true, detail: u.error ?? undefined };
    case "off": return { text: u.error || "Updates are off" };
    default: return null;
  }
}
/** is "Check now" worth offering? Not while a build is arriving or waiting for the restart, and not while updates are off:
 *  the launcher would answer with the same sentence and nothing else would happen */
export const updateCheckable = (u: UpdateState): boolean => u.status !== "ready" && u.status !== "downloading" && u.status !== "available" && u.status !== "off";

export const PHASE_LABEL: Record<InstallPhase, string> = {
  downloading: "installing", verifying: "checking", prerequisites: "setting up", finishing: "finishing",
  done: "installed", failed: "failed", cancelled: "cancelled",
};

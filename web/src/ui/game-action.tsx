/**
 * GameAction: the one thing to do about a game, decided exactly as the old `Actions` did (web/src/parts.tsx before the
 * redesign), calling the same functions:
 *   on this PC          Play (Running while it runs)            + Open folder, Uninstall (asks first, in place) in the full form
 *   installing here     Cancel (cancels the launcher install)    status "Installing 48%"
 *   on the server       Install (in the launcher; a plain browser offers the launcher download)
 *   moving on server    Cancel (the request), for whoever may cancel it (the server says: game.may.cancel); status "Downloading…"
 *   not out yet         Track / Tracked (a toggle)
 *   otherwise           Request (look for it; "Try again" when it failed). A game on several platforms (an arcade game that
 *                       also came out on consoles) asks which version first, unless one was chosen already
 *   store item          Track (coming soon) · Watch for it (protected: "Not yet") · Request (add it and look; opens its page)
 * The boards say "Request" where the old code said "Get it"; the function is the same.
 *
 * My other PCs (orders.ts, pcs.tsx). In a plain browser (a phone) there is no PC to install on here, so a game on the server
 * offers my PCs instead: "Install on COUCH" when there is one (then its state there, with Cancel, or "On COUCH"), "Install
 * on…" (a chooser) when there are several; without any, the launcher's download as before. In the launcher the full form adds
 * "Install on…" after the game's own action whenever I have another PC, and for a game still on its way (this PC included:
 * it installs when it arrives).
 *
 * planAction() is pure (the gallery and tests call it); useGameAction() adds the live state and the handlers;
 * <ActionView> draws a plan; <GameActionView> draws a useGameAction() result with the dialog it may open; <GameAction>
 * is both: a frosted pill on art, a row pill, a big button, or the full set for a game page.
 * The launcher-download dialog (Install in a plain browser) mounts, and asks the server for the build, only once it is
 * opened; it renders into a portal on document.body, so the extra node can sit anywhere.
 */
import { useState, type ReactNode } from "react";
import type { DiscoverItem, Game } from "../api";
import { launcher, newerCopy, olderThan, refreshesStart, type InstallProgress, type InstalledGame } from "../launcher";
import { act, useLib } from "../data";
import { useLauncher } from "../launcher-state";
import { journeyOf, mayCancel, notOutYet, tracksIt } from "../model";
import { isOpen, orderLine, type PcState } from "../orders";
import { usePcs } from "../pcs";
import { useSession } from "../session";
import { Ask } from "./ask";
import { Icon, type IconName } from "./icons";
import { Button, type ButtonKind, type ButtonSize } from "./button";
import { useUi } from "./kit";
import { InstallOn } from "./install-on";
import { LauncherDownload } from "./launcher-download";

export type ActKind = "play" | "running" | "install" | "install-on" | "request" | "retry" | "track" | "tracked" | "watch" | "cancel" | "folder" | "uninstall";
export interface Act {
  kind: ActKind;
  label: string;
  icon: IconName;
  /** may lead: drawn as the primary (white) button in the big forms; Cancel, Tracked and Watch never lead */
  lead: boolean;
  disabled?: boolean;
  pressed?: boolean;
  title?: string;
  /** install-on: the one PC it installs on; absent: the chooser opens */
  device?: string;
  /** cancel: the order it cancels (an install waiting or running on one of my PCs), not the search */
  orderId?: number;
}
export interface ActionPlan {
  /** the one thing to do; null when there is nothing (a server download with no request to cancel, or someone else's) */
  main: Act | null;
  /** what the full form adds after it (Open folder, Uninstall) */
  more: Act[];
  /** a state the full form shows before the action ("Installing 48%", "Downloading…", "Not yet") */
  status: string | null;
  /** why the server's copy cannot be installed or played on this PC (a console dump; a launcher too old to start it): the game
   *  page and the list's room say it where the action would be */
  note?: string | null;
  /** the library game the plan is about, when there is one */
  game: Game | undefined;
  /** my PCs this game can be installed on from here (the full form's "Install on…"); none: no such control */
  elsewhere?: PcState[];
}
/** the part of a store item (DiscoverItem or AppDetail) the decision reads */
export type ActionApp = Pick<DiscoverItem, "appId" | "gameId" | "comingSoon" | "crackStatus" | "drm">;
export interface PlanInput {
  game?: Game | null;
  app?: ActionApp | null;
  /** who is looking: tracking is each person's own (Tracked only when I track it) */
  meId?: number | null;
  /** this PC's copy (launcher), the install in flight, whether it runs */
  inst?: InstalledGame;
  prog?: InstallProgress;
  running?: boolean;
  /** this launcher starts copies by their argv (0.10 on); null outside the launcher, where Install is a download */
  canArgv?: boolean | null;
  /** this launcher's version, held against what the copy needs (requiresLauncher); null outside the launcher or not known */
  launcherVersion?: string | null;
  /** this launcher takes a start the server changed in place at Play (0.11 on); older ones are offered Update for it */
  refreshes?: boolean | null;
  /** the server address this launcher uses now: a copy recorded under another is offered Update for a changed start, since
   *  the launcher asks only this one (launcher.ts followsStart); null while not known */
  server?: string | null;
  /** my PCs as they stand to this game (this one among them, in the launcher); none known: nothing about PCs is offered */
  pcs?: PcState[];
  /** there is no PC here (a plain browser): a game on the server is installed on one of mine, from here */
  remote?: boolean;
}

const A = {
  play: (): Act => ({ kind: "play", label: "Play", icon: "playSolid", lead: true }),
  running: (): Act => ({ kind: "running", label: "Running", icon: "playSolid", lead: true, disabled: true, pressed: true }),
  install: (): Act => ({ kind: "install", label: "Install", icon: "install", lead: true }),
  /** a newer copy on the server than the one on this PC (the launcher updates it in place, saves kept) */
  update: (): Act => ({ kind: "install", label: "Update", icon: "install", lead: true }),
  request: (failed = false): Act => (failed ? { kind: "retry", label: "Try again", icon: "retry", lead: true } : { kind: "request", label: "Request", icon: "plus", lead: true }),
  track: (): Act => ({ kind: "track", label: "Track", icon: "track", lead: true }),
  tracked: (): Act => ({ kind: "tracked", label: "Tracked", icon: "tick", lead: false, pressed: true }),
  watch: (): Act => ({ kind: "watch", label: "Watch for it", icon: "track", lead: false }),
  cancel: (): Act => ({ kind: "cancel", label: "Cancel", icon: "cancel", lead: false }),
  /** install on one of my PCs from here: on that one, or wherever the chooser says */
  installOn: (device?: string): Act => ({ kind: "install-on", label: device ? `Install on ${device}` : "Install on…", icon: "install", lead: true, device }),
  /** once more on a PC where it could not be installed */
  retryOn: (device: string): Act => ({ kind: "install-on", label: "Try again", icon: "retry", lead: true, device }),
  /** the full form's secondary "Install on…" beside the game's own action */
  elsewhere: (): Act => ({ kind: "install-on", label: "Install on…", icon: "tv", lead: false }),
  cancelOrder: (orderId: number): Act => ({ kind: "cancel", label: "Cancel", icon: "cancel", lead: false, orderId }),
  folder: (): Act => ({ kind: "folder", label: "Open folder", icon: "folder", lead: false }),
  uninstall: (): Act => ({ kind: "uninstall", label: "Uninstall", icon: "trash", lead: false }),
};

/** what the player reads where Install would be, when the server's copy is not for this PC (the big screen says the same) */
export const NOTE = { rom: "Can't be played on this PC yet", launcher: "Update Ahoy to play this" } as const;

/** the decision, branch for branch the old Actions. Track / Tracked is mine: someone else tracking a game does not make it Tracked
 *  for me, and my Tracked never untracks it for them (server/src/library.ts monitor) */
export function planAction({ game: g, app, inst, prog, running, meId, canArgv = null, launcherVersion = null, refreshes = null, server = null, pcs = [], remote = false }: PlanInput): ActionPlan {
  const none: ActionPlan = { main: null, more: [], status: null, game: g ?? undefined };
  // my other PCs, for a game a PC can start
  const others = (g?.file?.kind ?? "native") === "rom" ? [] : pcs.filter(p => !p.here);
  if (g && prog) {
    const j = journeyOf(g, inst, prog);
    return { main: A.cancel(), more: [], status: `${j.label} ${Math.round((j.progress ?? 0) * 100)}%`, game: g, elsewhere: others };
  }
  // the server's copy: a console dump is nothing a PC starts; a built way needs a launcher that starts by argv
  const kind = g?.file?.kind ?? "native";
  // (a launcher from before 0.10 has no "argv"; a later one is held by its version against what the copy says it needs)
  const tooOld = !!g?.file?.requiresLauncher && (canArgv === false || olderThan(launcherVersion, g.file.requiresLauncher));
  if (g && inst) {
    // another package, or the same one started another way now (unless the launcher takes that at Play for this copy)
    const newer = newerCopy(g, inst, refreshes, server) && kind !== "rom";
    const more = [A.folder(), A.uninstall()];
    none.elsewhere = others;
    if (inst.kind === "rom") {
      if (newer) return tooOld ? { main: null, more, status: null, note: NOTE.launcher, game: g } : { main: A.update(), more, status: null, game: g };
      return { main: null, more, status: null, note: NOTE.rom, game: g };
    }
    if (newer && !running && !tooOld) return { main: A.update(), more: [A.play(), ...more], status: null, game: g, elsewhere: others };
    return { main: running ? A.running() : A.play(), more, status: null, game: g, elsewhere: others };
  }
  if (g) {
    const j = journeyOf(g);
    if (g.status === "available" && g.file) {
      if (kind === "rom") return { ...none, note: NOTE.rom };
      if (tooOld) return { ...none, note: NOTE.launcher };
      if (remote && others.length) return remotePlan(none, others);
      return { ...none, main: A.install(), elsewhere: others };
    }
    // Cancel only where the server would take it from this person (someone else's search says where it is, nothing to press).
    // Still on its way: any PC of mine, this one too, can be told to install it when it arrives
    if (j.active) return { ...none, main: g.request && mayCancel(g) ? A.cancel() : null, status: `${j.label}…`, elsewhere: kind === "rom" ? [] : pcs };
    if (notOutYet(g)) return { ...none, main: tracksIt(g, meId) ? A.tracked() : A.track() };
    return { ...none, main: A.request(g.status === "failed") };
  }
  if (app) {
    if (app.comingSoon) return { ...none, main: A.track() };
    if (app.crackStatus === "uncracked" || app.crackStatus === "hypervisor") return { ...none, main: A.watch(), status: "Not yet" };
    return { ...none, main: A.request() };
  }
  return none;
}

/**
 * A game on the server, seen from where there is no PC (a phone, a browser): it is installed on one of mine. One PC: the
 * action names it, then says how it goes there (with Cancel), why it did not (Try again), or that it is there. Several: the
 * chooser, with the furthest order's line beside it.
 */
function remotePlan(none: ActionPlan, pcs: PcState[]): ActionPlan {
  if (pcs.length === 1) {
    const p = pcs[0], o = p.order;
    if (p.has) return { ...none, note: `On ${p.device}` };
    if (o && isOpen(o)) return { ...none, main: A.cancelOrder(o.id), status: orderLine(o, p.on, true) };
    if (o) return { ...none, main: A.retryOn(p.device), status: orderLine(o, p.on, true) };
    return { ...none, main: A.installOn(p.device) };
  }
  if (pcs.every(p => p.has)) return { ...none, note: "On your PCs" };
  const open = pcs.filter(p => p.order && isOpen(p.order)).sort((a, b) => b.order!.progress - a.order!.progress)[0];
  return { ...none, main: A.installOn(), status: open ? orderLine(open.order!, open.on, true) : null, elsewhere: pcs };
}

/** the plan for a game or a store item, with the live launcher state and a handler for every act */
export function useGameAction({ game, app }: { game?: Game | null; app?: ActionApp | null }) {
  const L = useLauncher();
  const lib = useLib();
  const P = usePcs();
  const { me } = useSession();
  const { toast, confirm, choose } = useUi();
  const [busy, setBusy] = useState<ActKind | null>(null);
  const [download, setDownload] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const g = game ?? (app?.gameId != null ? lib.byId.get(app.gameId) : undefined) ?? (app ? lib.byApp.get(app.appId) : undefined);
  const inst = g?.file ? L.installedFor(g.id, g.file.id) : undefined;
  const prog = g?.file ? L.installs[g.file.id] : undefined;
  const running = inst ? !!L.playing[inst.slug] : false;
  const canArgv = L.inLauncher ? !!launcher?.features?.includes("argv") : null;
  const refreshes = L.inLauncher ? refreshesStart : null;
  const plan = planAction({ game: g, app, inst, prog, running, meId: me?.id ?? null, canArgv, launcherVersion: L.inLauncher ? launcher?.version ?? null : null, refreshes, server: L.server,
    pcs: g ? P.statesOf(g.id) : [], remote: !L.inLauncher });
  // the old Actions' run(): busy while it works, a toast when done, the library reloaded, errors as a toast
  const run = async (kind: ActKind, fn: () => Promise<unknown>, done?: string) => {
    setBusy(kind);
    try { await fn(); if (done) toast(done, "success"); await lib.reload(); } catch (e: any) { toast(String(e?.message ?? e), "danger"); } finally { setBusy(null); }
  };
  const uninstall = async () => {
    if (!inst) return;
    try { await L.uninstall(inst.slug); } catch (e: any) { toast(String(e?.message ?? e), "danger"); }
  };
  /** do an act; Uninstall asks first (a dialog) unless it was already asked in place (`confirmed`) */
  const perform = async (a: Act, opt: { confirmed?: boolean } = {}): Promise<void> => {
    if (a.disabled || busy) return;
    switch (a.kind) {
      case "play": if (inst) await L.play(inst.slug); return;
      case "folder": if (inst) await L.openFolder(inst.slug); return;
      case "uninstall":
        if (!inst || !g) return;
        if (opt.confirmed || await confirm(`Uninstall ${g.name}?`, inst.keep?.length
          ? <>The folder <code>{inst.path}</code> is deleted from this PC; its saves stay for the next time you install it. The copy on your server stays.</>
          : <>The folder <code>{inst.path}</code> is deleted from this PC. The copy on your server stays.</>, { ok: "Uninstall" })) await uninstall();
        return;
      case "install":
        if (!g?.file) return;
        if (L.inLauncher) await L.install(g.file.id); else setDownload(true);
        return;
      case "install-on": {
        if (!g) return;
        const dev = a.device;
        if (!dev) { setChoosing(true); return; }
        const on = P.pcs.find(p => p.device === dev)?.on;
        await run("install-on", () => P.place(dev, g.id), on ? `Installing on ${dev}` : `${dev} installs it when it's on`);
        return;
      }
      case "cancel":
        if (a.orderId != null) { const id = a.orderId; await run("cancel", () => P.cancel(id), "Cancelled"); return; }
        if (g?.file && prog) { await L.cancelInstall(g.file.id); return; }
        if (g?.request) await run("cancel", () => act.cancel(g.request!.id), "Cancelled");
        return;
      case "tracked": if (g) await run("tracked", () => act.monitor(g.id, false), "No longer tracked"); return;
      case "track":
        if (g) await run("track", () => act.monitor(g.id, true), "Tracked");
        else if (app) await run("track", () => act.getSteam(app.appId, false), "Tracked");
        return;
      case "watch": if (app) await run("watch", () => act.getSteam(app.appId, false), "Watching"); return;
      case "request": case "retry":
        if (g) {
          // on several platforms, and nobody said which version yet: that is asked first (closing the question asks for nothing)
          if ((g.platformChoices?.length ?? 0) > 1 && !g.wantPlatform && g.may?.version) {
            const version = await choose("Which version?", g.platformChoices!);
            if (version == null) return;
            await run(a.kind, () => act.setVersion(g.id, version), "Looking for it");
          } else await run(a.kind, () => act.search(g.id), "Looking for it");
        }
        // asked for where you are: the page (or card) turns into the game's state in place, with "On its way"; it used to jump
        // to the game's page, which rebuilt the head from nothing (2026-11-07)
        else if (app) await run(a.kind, () => act.getSteam(app.appId, true), "On its way");
        return;
      case "running": return;
    }
  };
  /** the dialogs an act may open: the launcher download (a plain browser's Install), the chooser of my PCs (Install on…);
   *  nothing until then (render it anywhere, they are portals) */
  const extra: ReactNode = download ? <LauncherDownload onClose={() => setDownload(false)} /> : choosing && g ? <InstallOn game={g} onClose={() => setChoosing(false)} /> : null;
  return { plan, perform, busy, extra, game: g, inst, prog };
}
export type GameActionState = ReturnType<typeof useGameAction>;

/* ─────────── drawing ─────────── */

/** the stroke the boards draw each glyph at, 14 px */
const strokeOf = (icon: IconName) => (icon === "track" ? 2.2 : icon === "tick" || icon === "plus" || icon === "cancel" ? 2.6 : 2.4);

/** a 36 px action pill: frosted glass on art (cards, the fan, tiles) or the quiet row pill (chart rows, lists) */
export function ActionPill({ act: a, onClick, busy, look = "glass", className, label }: { act: Act; onClick?: () => void; busy?: boolean; look?: "glass" | "row"; className?: string; label?: string }) {
  // working, or unavailable (Running): it keeps the focus where it is (aria-disabled), and a press does nothing
  const held = !!(a.disabled || busy);
  return (
    <button type="button" className={`ap${look === "row" ? " ap-row" : ""}${className ? " " + className : ""}`} aria-disabled={held || undefined} aria-busy={busy || undefined} aria-pressed={a.pressed} title={a.title}
      aria-label={label ? `${a.label} ${label}` : undefined} onClick={e => { e.preventDefault(); e.stopPropagation(); if (!held) onClick?.(); }}>
      <Icon name={busy ? "spinner" : a.icon} size={14} strokeWidth={busy ? 2.4 : strokeOf(a.icon)} />
      {a.label}
    </button>
  );
}

/** how an act is drawn as a button: a kind for every act, or a rule per act (the default: the lead one white, the rest secondary) */
export type ActKindRule = ButtonKind | ((a: Act) => ButtonKind);
const kindFor = (a: Act, rule?: ActKindRule): ButtonKind => (typeof rule === "function" ? rule(a) : rule ?? (a.lead ? "primary" : "secondary"));

/** an act as a button: the lead one white, the others secondary, unless `kind` says otherwise */
export function ActButton({ act: a, onClick, busy, size = 48, kind, className, label, primary }: { act: Act; onClick?: () => void; busy?: boolean; size?: ButtonSize; kind?: ActKindRule; className?: string; label?: string; primary?: boolean }) {
  return (
    <Button kind={kindFor(a, kind)} size={size} icon={a.icon} busy={busy} unavailable={a.disabled} pressed={a.pressed} title={a.title} className={className} data-primary={primary ? "" : undefined}
      aria-label={label ? `${a.label} ${label}` : undefined} onClick={onClick}>
      {a.label}
    </Button>
  );
}

/**
 *   pill    the frosted pill on art (hover action on cards, the fan, playing tiles)
 *   row     the quiet pill at the end of a chart row or list row
 *   button  the one action as a 36/44/48 button (spotlight primary, a friend's tile, a ticket)
 *   full    the game page: [status] action [Open folder] [Uninstall, asking in place]
 */
export type GameActionVariant = "pill" | "row" | "button" | "full";
export interface ActionLook {
  variant?: GameActionVariant;
  size?: ButtonSize;
  /** the full form's state before the action ("Installing 48%") */
  showStatus?: boolean;
  /** the button forms' kind: one for every act ("secondary": a ticket's Cancel and Try again), or a rule per act */
  kind?: ActKindRule;
  /** draw the main act only when it is one of these (a friend's tile offers Play, Install, Request, Try again) */
  only?: readonly ActKind[];
  /** the game's name, for what a screen reader hears ("Cancel Endacopia") */
  label?: string;
  /** on the main act's button or pill */
  className?: string;
}

/** a plan drawn without live state (the gallery, previews): `onAct` gets every press; an Uninstall asked in place passes `confirmed` */
export function ActionView({ plan, variant = "pill", size = 48, showStatus, kind, only, label, className, onAct, busy }: ActionLook & { plan: ActionPlan; onAct?: (a: Act, confirmed?: boolean) => Promise<unknown> | void; busy?: ActKind | null }) {
  const m = plan.main && (!only || only.includes(plan.main.kind)) ? plan.main : null;
  if (variant === "pill" || variant === "row") return m ? <ActionPill act={m} look={variant === "row" ? "row" : "glass"} busy={busy === m.kind} label={label} className={className} onClick={() => void onAct?.(m)} /> : null;
  if (variant === "button") return m ? <ActButton act={m} size={size} kind={kind} label={label} className={className} busy={busy === m.kind} onClick={() => void onAct?.(m)} />
    : plan.note && !only ? <span className={`btn s${size} quiet ga-status ga-note`}>{plan.note}</span> : null;
  return <FullView plan={plan} main={m} size={size} showStatus={showStatus} kind={kind} label={label} className={className} onAct={onAct} busy={busy} />;
}

/** the full form: the state, the action, then Open folder (secondary) and Uninstall, which asks in place (Settings' Ask) */
function FullView({ plan, main: m, size, showStatus, kind, label, className, onAct, busy }: { plan: ActionPlan; main: Act | null; size: ButtonSize; showStatus?: boolean; kind?: ActKindRule; label?: string; className?: string; onAct?: (a: Act, confirmed?: boolean) => Promise<unknown> | void; busy?: ActKind | null }) {
  const [asking, setAsking] = useState(false);
  const name = label ?? plan.game?.name;
  return (
    <span className="ga-full">
      {!m && plan.note && <span className={`btn s${size} quiet ga-status ga-note`}>{plan.note}</span>}
      {showStatus && plan.status && <span className={`btn s${size} quiet ga-status`} aria-live="polite">{plan.main?.kind === "cancel" && <Icon name="spinner" size={size === 36 ? 14 : 16} strokeWidth={2.4} />}{plan.status}</span>}
      {/* data-primary: the page's main action, which the launcher's end-to-end test presses */}
      {m && <ActButton act={m} size={size} kind={kind} label={label} className={className} busy={busy === m.kind} primary onClick={() => void onAct?.(m)} />}
      {plan.more.map(a => a.kind === "uninstall"
        ? <Ask key={a.kind} open={asking} onOpen={() => setAsking(true)} onClose={() => setAsking(false)} size={size} icon={a.icon} label={a.label}
            aria={name ? `${a.label} ${name}` : undefined} confirmAria={name ? `Uninstall ${name} from this PC` : undefined} onConfirm={() => onAct?.(a, true)} />
        : asking && a.kind === "folder" ? null   // while it asks, Open folder steps aside (the board's Balatro row)
        : <ActButton key={a.kind} act={a} size={size} kind="secondary" label={label} onClick={() => void onAct?.(a)} />)}
      {/* my other PCs (and this one, for a game still on its way): the chooser. Not beside a main action that opens it already */}
      {!asking && !!plan.elsewhere?.length && !(m?.kind === "install-on" && !m.device) && <ActButton act={A.elsewhere()} size={size} kind="secondary" label={label} onClick={() => void onAct?.(A.elsewhere())} />}
    </span>
  );
}

/** a useGameAction() result drawn, with the dialog its Install may open */
export function GameActionView({ ga, ...look }: ActionLook & { ga: GameActionState }) {
  const { plan, perform, busy, extra } = ga;
  const showStatus = look.showStatus ?? look.variant === "full";
  const shown = plan.main && (!look.only || look.only.includes(plan.main.kind));
  const noted = !!plan.note && (look.variant === "full" || (look.variant === "button" && !look.only));
  if (!shown && !noted && !(look.variant === "full" && (plan.more.length || plan.elsewhere?.length || (showStatus && plan.status)))) return <>{extra}</>;
  return <><ActionView plan={plan} {...look} showStatus={showStatus} busy={busy} onAct={(a, confirmed) => perform(a, { confirmed })} />{extra}</>;
}

/** the one thing to do about a game or a store item, decided and drawn (see ActionLook for the forms) */
export function GameAction({ game, app, ...look }: ActionLook & { game?: Game | null; app?: ActionApp | null }) {
  const ga = useGameAction({ game, app });
  return <GameActionView ga={ga} {...look} />;
}

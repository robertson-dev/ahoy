/**
 * Your PCs and what is to be installed on them, as the page reasons about them (no React here; pcs.tsx keeps them live and
 * carries orders out). The server's side is server/src/pcs.ts: an order is "install this game on that PC", placed from
 * anywhere and carried out by the page running in that PC's launcher.
 */
import type { Game } from "./api";
import { newerCopy, olderThan, type InstalledGame } from "./launcher";

export interface Pc { device: string; version: string | null; auto: boolean; freeBytes: number | null; seenAt: number | null; on: boolean; games: number }
export type OrderState = "waiting" | "installing" | "done" | "failed";
export interface Order {
  id: number; device: string; gameId: number; name: string | null; origin: "asked" | "wanted"; state: OrderState;
  progress: number; error: string | null; from: string | null; createdAt: number; updatedAt: number;
}
/** a game as one of my PCs stands to it: is it there, is it to be installed there */
export interface PcState { device: string; here: boolean; on: boolean; has: boolean; order: Order | null }

export const isOpen = (o: Pick<Order, "state">) => o.state === "waiting" || o.state === "installing";

/** room an install needs beyond the game's own size */
export const ROOM_MARGIN = 256 * 1024 * 1024;
/** why an order cannot be carried out on its PC, in the words whoever placed it reads (on another device, so never "this PC") */
export const ORDER_FAIL = { rom: "Can't be played on a PC yet", launcher: "Ahoy there needs an update", room: "Not enough room" } as const;

export type OrderStep =
  /** nothing to do yet: the game has no copy, or this PC is installing something else */
  | { do: "wait" }
  | { do: "install"; packageId: number }
  /** it is installing here now (started by this order, or by hand): say how far it is */
  | { do: "follow"; packageId: number }
  | { do: "done" }
  | { do: "fail"; error: string };

export interface StepCtx {
  /** this PC's copy of the game, when it has one */
  inst?: InstalledGame;
  /** the game's package is being installed here right now */
  flying: boolean;
  /** this PC is installing something (one at a time: an order waits its turn) */
  busy: boolean;
  /** room left where games go; null when the launcher cannot say */
  free: number | null;
  canArgv: boolean; launcherVersion: string | null; refreshes: boolean; server: string | null;
}

/**
 * What this PC does about one of its orders now. Decided the way Install is (ui/game-action.tsx planAction): a console dump
 * and a copy this launcher is too old for are refused, with words for whoever placed the order; a game already here in its
 * current copy is done; one whose copy is newer than this PC's is installed over it (an update).
 */
export function orderStep(o: Order, g: Game | undefined, c: StepCtx): OrderStep {
  if (!isOpen(o) || !g) return { do: "wait" };
  const f = g.file;
  if (c.inst && (!f || !newerCopy(g, c.inst, c.refreshes, c.server))) return { do: "done" };
  if (!f || g.status !== "available") return { do: "wait" };
  if ((f.kind ?? "native") === "rom") return { do: "fail", error: ORDER_FAIL.rom };
  if (f.requiresLauncher && (!c.canArgv || olderThan(c.launcherVersion, f.requiresLauncher))) return { do: "fail", error: ORDER_FAIL.launcher };
  if (c.flying) return { do: "follow", packageId: f.id };
  if (!c.inst && c.free != null && f.size != null && c.free < f.size + ROOM_MARGIN) return { do: "fail", error: ORDER_FAIL.room };
  if (c.busy) return { do: "wait" };
  return { do: "install", packageId: f.id };
}

const pct = (p: number) => `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
/** an order's state beside its PC's name (the chooser's rows): "Installing 48%", "When it's on", "When it arrives" */
export function orderWords(o: Order, on: boolean, hasCopy: boolean): string {
  if (o.state === "installing") return `Installing ${pct(o.progress)}`;
  if (o.state === "done") return "Installed";
  if (o.state === "failed") return o.error || "Didn't install";
  return !hasCopy ? "When it arrives" : on ? "Starting" : "When it's on";
}
/** the same as one line that names the PC (a game's status, On the way): "Installing on COUCH 48%", "Waiting for COUCH" */
export function orderLine(o: Order, on: boolean, hasCopy: boolean): string {
  const d = o.device;
  if (o.state === "installing") return `Installing on ${d} ${pct(o.progress)}`;
  if (o.state === "done") return `Installed on ${d}`;
  if (o.state === "failed") return `${d}: ${o.error || "Didn't install"}`;
  return !hasCopy ? `Installs on ${d} when it arrives` : on ? `Starting on ${d}` : `Waiting for ${d}`;
}

/** every PC of mine as it stands to one game; `here`: this PC's name (null in a browser), `hereHas`: the launcher's own word
 *  for this PC (the server's list of what is on it can be a moment behind) */
export function pcStates(gameId: number, pcs: Pc[], orders: Order[], installs: { device: string; gameId: number | null }[], here: string | null, hereHas: boolean): PcState[] {
  return pcs.map(p => {
    const mine = orders.filter(o => o.device === p.device && o.gameId === gameId);
    const order = mine.find(isOpen) ?? mine.find(o => o.state === "failed") ?? null;
    const isHere = p.device === here;
    return { device: p.device, here: isHere, on: p.on || isHere, has: isHere ? hereHas : installs.some(i => i.device === p.device && i.gameId === gameId), order };
  });
}

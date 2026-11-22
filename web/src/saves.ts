/**
 * A game's saves in step between my PCs, as the page reasons about them (no React here; saves-state.tsx does it at Play and
 * draws it). The server keeps versions (server/src/saves.ts), the launcher looks at this PC's saves, packs and puts back
 * (launcher/src/saves.ts, savesync.ts); the page decides, here, what moves.
 *
 * Three things are known of a game on this PC: its saves now (`local`, their digest: the same saves give the same digest
 * on every PC), what this PC and the server agreed on last time (`base`), and the server's newest version (`head`).
 *   no version on the server            this PC's saves go up (when it has any)
 *   this PC has what the head has       nothing moves (they agree from now, if they did not know it yet)
 *   no saves here                       the head comes down
 *   only this PC changed since          its saves go up
 *   only the server changed since       the head comes down
 *   both changed, or they never agreed  the player chooses which to keep: neither is thrown away without a word
 */
import type { Game } from "./api";

/** a version of a game's saves on the server */
export interface Snap { id: number; key: string; gameId: number | null; name: string | null; device: string | null; digest: string; files: number; bytes: number; size: number; newest: number | null; at: number }
/** this PC's saves of a game now, and the version it last agreed on with the server (the launcher's answer) */
export interface SaveState { digest: string | null; files: number; bytes: number; newest: number | null; tooBig: boolean; where: string[]; base: { id: number; digest: string } | null }
export interface SaveRules { paths: string[]; exclude: string[]; made: boolean; appId: number | null; known: boolean }

/** the game's name for its saves, the same on every PC: its Steam app id when it has one, else its id on this server */
export const saveKey = (g: Pick<Game, "id" | "steamAppId">): string => (g.steamAppId != null && g.steamAppId > 0 ? `a${g.steamAppId}` : `g${g.id}`);

export type SyncStep =
  | { do: "nothing" }
  /** this PC already has what the head has: note it, nothing moves */
  | { do: "agree"; head: Snap }
  | { do: "push" }
  | { do: "pull"; head: Snap }
  | { do: "ask"; head: Snap };

export function decide(local: string | null, base: string | null, head: Snap | null): SyncStep {
  if (!head) return local ? { do: "push" } : { do: "nothing" };
  if (local === head.digest) return base === head.digest ? { do: "nothing" } : { do: "agree", head };
  if (!local) return { do: "pull", head };
  if (base === head.digest) return { do: "push" };
  if (base != null && local === base) return { do: "pull", head };
  return { do: "ask", head };
}

/** how a game's saves stand, for the page to say */
export type SaveStatus =
  | { is: "checking" }
  /** in step with the server's newest version */
  | { is: "synced"; head: Snap }
  /** nothing here and nothing there */
  | { is: "none" }
  /** this PC and the server each have saves the other has not: the player chooses */
  | { is: "choose"; head: Snap; local: SaveState }
  | { is: "too-big" }
  /** the server or the launcher did not answer: tried again at the next Play */
  | { is: "waiting" };

/** a place of the PC as a person reads it: where the launcher found saves ("Documents\Saved Games\Hades") */
export function placeWords(rule: string): string {
  const m = /^<([A-Za-z]+)>(?:\/(.*))?$/.exec(rule);
  if (!m) return rule;
  const rest = (m[2] ?? "").replace(/<osUserName>/g, "you").split("/").filter(s => s && s !== "**").join("\\");
  const at: Record<string, string> = { base: "The game's folder", home: "Your user folder", winAppData: "AppData\\Roaming", winLocalAppData: "AppData\\Local", winDocuments: "Documents", winPublic: "Public", winProgramData: "ProgramData" };
  const place = at[m[1]!] ?? m[1]!;
  return rest ? `${place}\\${rest}` : place;
}

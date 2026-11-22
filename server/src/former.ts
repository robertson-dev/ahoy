/**
 * Ahoy — the engine's former name. The engine was called playarr until 2026-11-21, and a server set up then keeps
 * working without being touched. This file is the one place in Ahoy that knows the old name.
 *
 *   environment   PLAYARR_URL / PLAYARR_API_KEY count as LUDARR_URL / LUDARR_API_KEY, unless those are set themselves
 *   saved         the engine's address and key saved as cfg.PLAYARR_*, and the library snapshot kept as playarr.games,
 *                 are copied to their new names once, when the new ones are not there yet. The old rows stay, so the
 *                 build from before the rename can be put back.
 *   art           an engine from before the rename marks a placeholder image with its old header (src/art.ts)
 *   messages      a message that names the engine by its old name is still not shown to players (web: search-parts.tsx)
 */
import { kv } from "./db";

export const FORMER = "playarr";
const OLD_ENV = "PLAYARR_", NEW_ENV = "LUDARR_";

/** PLAYARR_X → LUDARR_X in the environment, where LUDARR_X is not set itself */
export function adoptFormerEnv(env: Record<string, string | undefined> = process.env): void {
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(OLD_ENV) || v == null) continue;
    const now = NEW_ENV + k.slice(OLD_ENV.length);
    if (env[now] == null) env[now] = v;
  }
}

/** what was saved under the old names, copied to the new ones where those are missing; returns the names it filled */
export function adoptFormerKeys(store: { get(key: string): string | null; set(key: string, value: string): void } = kv): string[] {
  const filled: string[] = [];
  for (const now of ["cfg.LUDARR_URL", "cfg.LUDARR_API_KEY", "ludarr.games"]) {
    if (store.get(now) != null) continue;
    const old = store.get(now.replace("LUDARR_", OLD_ENV).replace("ludarr.", FORMER + "."));
    if (old != null) { store.set(now, old); filled.push(now); }
  }
  return filled;
}

/** the header an engine from before the rename puts on a placeholder image */
export const FORMER_ART_MARK = `x-${FORMER}-art`;

adoptFormerEnv();
adoptFormerKeys();

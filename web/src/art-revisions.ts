/** Artwork revisions follow library updates, including a second replacement of the same image. */
import { useSyncExternalStore } from "react";

const revisions = new Map<string, number>();
const listeners = new Set<() => void>();
const key = (kind: string, id: number | string) => `${kind}:${id}`;
export function rememberArtRevisions(games: { id: number; steamAppId?: number | null; artRev?: number }[]) {
  let changed = false;
  for (const g of games) {
    for (const k of [key("game", g.id), ...(g.steamAppId ? [key("steam", g.steamAppId)] : [])]) {
      const rev = g.artRev ?? 0;
      if ((revisions.get(k) ?? 0) !== rev) changed = true;
      revisions.set(k, rev);
    }
  }
  if (changed) for (const l of listeners) l();
}
export const artRevision = (kind: string, id: number | string | null | undefined) => id == null ? 0 : revisions.get(key(kind, id)) ?? 0;
export function useArtRevision(kind: string, id: number | string | null | undefined): number {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => artRevision(kind, id), () => 0);
}
export function useArtRevisionList(ids: number[]): string {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => ids.map(id => id + ":" + artRevision("game", id)).join(","), () => ids.join(","));
}
export function versionedArt(url: string, kind: string, id: number | string): string {
  const rev = artRevision(kind, id);
  if (rev && /[?&]rev=/.test(url)) return url.replace(/([?&]rev=)[^&#]*/, (_, prefix) => prefix + rev);
  return rev ? `${url}${url.includes("?") ? "&" : "?"}rev=${rev}` : url;
}

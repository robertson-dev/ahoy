/**
 * Ahoy — "can it be had today?" for storefront games that are not in the library. ludarr keeps CrackWatch's
 * verdicts (it needs them for its own searching); Ahoy asks it one title at a time, politely, and remembers the
 * answer on the catalog row. Library games carry ludarr's verdict directly.
 */
import { db, stmts, type CatalogRow } from "./db";
import * as ludarr from "./ludarr";
import { onScreen } from "./discover";
import { logger } from "./log";
const log = logger("Crack");

interface CwGame { slug: string; title: string; status: string; crackDate: string | null; drm: string | null; group: string | null }
export const cdeps = {
  find: async (title: string): Promise<CwGame | null> => {
    try { return (await ludarr.get<{ item: CwGame }>(`/api/v1/crackwatch/lookup?title=${encodeURIComponent(title)}`)).item; }
    catch (e: any) { if (e instanceof ludarr.LudarrError && e.status === 404) return null; throw e; }
  },
  now: () => Date.now(),
  log: (...a: unknown[]) => log.log(...a),
};

const FRESH_SEC = 6 * 3600;            // unknown / unreleased / uncracked: ask again after this
const SETTLED_SEC = 7 * 86_400;        // cracked: nothing changes quickly any more
const mark = db.query("UPDATE catalog SET drm=?, crack_status=?, crack_date=?, crack_group=?, crackwatch_at=? WHERE steam_appid=?");

/** one app's verdict, when due; returns whether ludarr was asked */
export async function checkApp(appId: number): Promise<boolean> {
  const row = stmts.catalogGet.get(appId) as (CatalogRow & { crackwatch_at: number | null }) | undefined;
  if (!row) return false;
  const now = Math.floor(cdeps.now() / 1000);
  const ttl = row.crack_status === "cracked" ? SETTLED_SEC : FRESH_SEC;
  if (row.crackwatch_at && now - row.crackwatch_at < ttl) return false;
  if (row.type && row.type !== "game") { mark.run(row.drm, row.crack_status, row.crack_date, row.crack_group, now, appId); return false; }
  try {
    const g = await cdeps.find(row.name);
    if (g) mark.run(g.drm, g.status, g.crackDate, g.group, now, appId);
    else mark.run(row.drm, row.crack_status, row.crack_date, row.crack_group, now, appId);   // not tracked there: remember we asked
    return true;
  } catch (e: any) { cdeps.log(`${row.name}: ${e?.message ?? e}`); return false; }
}

/** background: the storefront rows first, then whatever else is in the catalog and due; a bounded number per pass */
export async function crackTick(limit = 40): Promise<{ checked: number }> {
  if (!ludarr.connected()) return { checked: 0 };
  let checked = 0;
  for (const id of await onScreen()) { if (checked >= limit) break; if (await checkApp(id)) { checked++; await new Promise(r => setTimeout(r, 200)); } }
  if (checked < limit) {
    const due = db.query("SELECT steam_appid FROM catalog WHERE (type IS NULL OR type='game') AND (crackwatch_at IS NULL OR crackwatch_at < ?) ORDER BY updated_at DESC LIMIT ?").all(Math.floor(cdeps.now() / 1000) - FRESH_SEC, limit - checked) as { steam_appid: number }[];
    for (const r of due) { if (await checkApp(r.steam_appid)) { checked++; await new Promise(res => setTimeout(res, 200)); } }
  }
  return { checked };
}

/**
 * Ahoy — what a player reads about a game's progress.
 *
 * The engine narrates its own machinery ("sent to the download client", "transferring to ludarr 12 MB/s",
 * "downloaded, but it needs the AI importer — add an API key…"). None of that is for members: they get a handful of
 * plain phrases, and nothing that names a component, a release, a group or an indexer.
 */
import { LudarrError, type GameStatus, type LudarrGame, type LudarrGameDetail } from "./ludarr";
import { etaSeconds } from "./eta";

/**
 * What a member reads when an action on the library fails. The engine's own text never reaches them: it names itself, its
 * sources and settings ("IGDB is not configured", "upgrades are off in the profile") or an HTTP code. The API logs that text
 * for whoever runs the server; the member gets one plain sentence for the kind of failure.
 */
export function playerError(e: unknown): { status: number; error: string } {
  if (!(e instanceof LudarrError)) return { status: 500, error: "That didn't work" };
  const status = e.status;
  if (status === 503) return { status, error: "Your server isn't ready for that yet" };
  if (status === 404) return { status, error: "That game couldn't be found" };
  if (status === 409) return { status, error: "That's already on its way or on your server" };
  if (status >= 500) return { status: 502, error: "Your server didn't answer. Try again in a moment" };
  return { status, error: "That didn't work" };
}

const RATE = /(\d+(?:\.\d+)?\s*[KMG]B\/s)/i;

/** the engine's stage text → a player's phrase for that status */
export function playerWords(status: GameStatus, raw: string | null | undefined): string {
  const s = (raw ?? "").toLowerCase();
  switch (status) {
    case "searching": {                                                      // the UI's label is "Looking"; what follows it never repeats it
      const again = /again in (\d+)\s*h/.exec(s);
      return again ? `Nothing yet · trying again in ${again[1]} h` : /failed/.test(s) ? "Trying again soon" : "Looking";
    }
    case "downloading": {
      if (/queued|sent to/.test(s)) return "Queued";
      const rate = RATE.exec(raw ?? "")?.[1];
      return rate ? `Downloading · ${rate}` : "Downloading";
    }
    case "importing": return /ai importer|api key|key was rejected/.test(s) ? "Needs a hand from whoever runs the server" : "Preparing";
    case "available": return "Ready";
    case "failed": return "Nothing usable turned up";
    case "missing": return "Nothing found yet";
    case "unmonitored": return "";
    default: return raw ?? "";                                                   // available: "12.3 GB · v1.2"; unreleased: the date
  }
}

/** a version is a number ("1.0.206.0", "v1.09"); anything else is the release's own label (a group, a date) and stays behind */
export const cleanVersion = (v: string | null | undefined): string | null => (v && /^v?\d/i.test(v.trim()) ? v.trim().replace(/^v/i, "") : null);

/** a request's progress as a share 0..1: an engine could report a percent (a folder-watch transfer said 88 for 88 %, which its
 *  transfer leg turned into 31.3 and the apps showed as 3130 %); null stays null */
export const progressShare = (v: number | null | undefined): number | null => {
  if (v == null) return null;
  const x = Number(v), f = x > 1 ? x / 100 : x;
  return Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : null;
};

/** the game as members see it: the engine's wording and its sources stripped out; a download says how long it has left (eta.ts),
 *  worked out from the release's size before that goes */
export function forPlayers<T extends LudarrGame>(g: T): T {
  // the protection's and the group's names never reach members (the verdict, crackStatus, stays: it decides Watch for it)
  const out: T = { ...g, drm: null, crackGroup: null, crackwatchUrl: null, statusDetail: playerWords(g.status, g.statusDetail), request: g.request ? { ...g.request, progress: progressShare(g.request.progress) as number, stage: playerWords(g.status, g.request.stage), message: null, release: null, etaSeconds: etaSeconds(g.status, { ...g.request, progress: progressShare(g.request.progress) as number }) } : null };
  if (out.file) {
    const version = cleanVersion(out.file.version);
    out.file = { ...out.file, path: "", version, release: null, group: null, importer: null };
    // the admin's whole start line is the engine's (launchRev, an opaque stamp, stays: it tells an older launcher to Update)
    delete out.file.start;
    if (out.status === "available") out.statusDetail = `${(Number(out.file.size ?? 0) / 1e9).toFixed(1)} GB${version ? ` · v${version}` : ""}`;
  }
  // how the engine finds and draws the game is its own business: the search terms, where the art came from, how it was added
  out.artRev = g.customArtAt ?? 0;
  const own = out as Partial<LudarrGame>;
  delete own.searchTerms; delete own.customArt; delete own.customArtAt; delete own.source;
  // where the copy sits on the server is the engine's too: its folders are named after the release (its group, its source),
  // and nobody's PC needs them (the launcher installs from the package's own list)
  out.path = null; out.rootFolder = null;
  const d = out as unknown as Partial<LudarrGameDetail>;
  if (d.files) d.files = [];
  if (d.history) d.history = d.history.map(h => ({ ...h, release: null, source: null, message: null }));
  if (d.jobs) d.jobs = [];
  if (d.routes) d.routes = d.routes.map(forPlayersRoute);
  return out;
}

/** another way to play, as members see it: what it is, where it runs, how well — not what file it wants, what it runs, or the
 *  link to a way the server's admin made (its repository) */
function forPlayersRoute(r: unknown): unknown {
  const x = (r ?? {}) as { id?: unknown; kind?: unknown; platform?: unknown; provenance?: unknown; label?: unknown; status?: unknown; statusNote?: unknown; statusAt?: unknown; runtime?: { id?: unknown; name?: unknown; kind?: unknown; latest?: { tag?: unknown; date?: unknown } | null } | null; features?: unknown; link?: unknown; source?: unknown; updatedAt?: unknown };
  const mine = x.source === "custom";
  return {
    id: x.id, kind: x.kind, platform: x.platform, provenance: x.provenance, label: x.label, status: x.status, statusNote: mine ? null : x.statusNote ?? null, statusAt: x.statusAt ?? null,
    runtime: x.runtime ? { id: x.runtime.id, name: x.runtime.name, kind: x.runtime.kind ?? null, latest: x.runtime.latest ? { tag: x.runtime.latest.tag, date: x.runtime.latest.date ?? null, asset: null, page: null } : null } : null,
    content: null, needs: [], features: Array.isArray(x.features) ? x.features : [], launch: null, link: mine ? null : webLink(x.link), source: mine ? "custom" : x.source, updatedAt: x.updatedAt,
  };
}
/** a catalog's link as members get it: a web page's address (http or https) or nothing. A file's, a share's or another program's
 *  address is something a click hands to Windows; the web UI and the launcher refuse those too, this is the same rule at the source */
export function webLink(u: unknown): string | null {
  if (typeof u !== "string" || !u) return null;
  try { const at = new URL(u); return at.protocol === "http:" || at.protocol === "https:" ? at.href : null; } catch { return null; }
}

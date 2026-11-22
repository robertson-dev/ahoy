/**
 * Ahoy — one status model for every surface. A game is somewhere on a journey of five stops
 * (Found · Downloaded · Prepared · Ready · Installed), and there is exactly one thing to do about it.
 */
import { fmtDay, fmtSize, type DiscoverItem, type Game } from "./api";
import type { InstallProgress, InstalledGame } from "./launcher";

export const STOPS = ["Found", "Downloaded", "Prepared", "Ready", "Installed"] as const;
export type Stage = "none" | "waiting" | "finding" | "downloading" | "preparing" | "ready" | "installing" | "installed" | "failed";

export interface Journey {
  stage: Stage;
  done: number;                 // stops completed, 0..5
  current: number | null;       // the stop in progress (index into STOPS), or null
  label: string;                // one short word for the card: Installed, Ready, Downloading…
  detail: string;               // one human line under it
  progress: number | null;      // 0..1 while something moves
  rate?: number; eta?: string;
  active: boolean;              // moving right now
}

/** how long is left, in the product's words: "under a minute left", "about 20 min left", "about 1.5 h left" */
export const etaWords = (s: number) => (s < 60 ? "under a minute left" : s < 3600 ? `about ${Math.round(s / 60)} min left` : `about ${(s / 3600).toFixed(1)} h left`);
const eta = (bytes: number, total: number, rate: number) => (!rate || !total || total <= bytes ? undefined : etaWords((total - bytes) / rate));
/** the server's estimate for a download, when it sends one (request.etaSeconds) */
const serverEta = (r: Game["request"]) => (typeof r?.etaSeconds === "number" && Number.isFinite(r.etaSeconds) && r.etaSeconds >= 0 ? etaWords(r.etaSeconds) : undefined);

export function journeyOf(g: Game | null | undefined, inst?: InstalledGame, prog?: InstallProgress): Journey {
  if (prog) {
    const p = prog.phase;
    const label = p === "downloading" ? "Installing" : p === "verifying" ? "Checking files" : p === "prerequisites" ? "Setting up" : "Finishing";
    return { stage: "installing", done: 4, current: 4, label, detail: `${Math.round(prog.progress * 100)}%${prog.rate ? ` · ${fmtRate(prog.rate)}` : ""}${eta(prog.bytes, prog.total, prog.rate) ? ` · ${eta(prog.bytes, prog.total, prog.rate)}` : ""}`, progress: prog.progress, rate: prog.rate, eta: eta(prog.bytes, prog.total, prog.rate), active: true };
  }
  if (inst) return { stage: "installed", done: 5, current: null, label: "Installed", detail: "On this PC", progress: null, active: false };
  if (!g) return { stage: "none", done: 0, current: null, label: "", detail: "", progress: null, active: false };
  const r = g.request;
  const said = r?.stage ?? g.statusDetail;                 // the server's words for where it is (server/src/words.ts)
  switch (g.status) {
    case "available": return { stage: "ready", done: 4, current: null, label: "Ready", detail: `${fmtSize(g.file?.size)} on your server`, progress: null, active: false };
    case "importing": return { stage: "preparing", done: 2, current: 2, label: "Preparing", detail: detailUnder("Preparing", said), progress: r?.progress ?? null, active: true };
    case "downloading": {
      // "6.2 MB/s · about 20 min left" (the Library board's ticket); the estimate alone is j.eta (the Home and the game page)
      const left = serverEta(r);
      return { stage: "downloading", done: 1, current: 1, label: "Downloading", detail: [detailUnder("Downloading", said), left].filter(Boolean).join(" · "), progress: r?.progress ?? null, eta: left, active: true };
    }
    case "searching": return { stage: "finding", done: 0, current: 0, label: "Looking", detail: detailUnder("Looking", said), progress: null, active: true };
    case "failed": return { stage: "failed", done: 0, current: null, label: "Didn't make it", detail: detailUnder("Didn't make it", r?.message ?? g.statusDetail), progress: null, active: false };
    case "unreleased": return { stage: "waiting", done: 0, current: null, label: g.tracked ? "Tracked" : "Not out yet", detail: g.releaseText || g.releaseIso || "no date yet", progress: null, active: false };
    default: {
      const label = g.monitored ? "Not found yet" : "Not on your server";
      // a missing game's words ("Nothing found yet") only say the label again
      return { stage: "none", done: 0, current: null, label, detail: g.status === "missing" ? "" : detailUnder(label, g.statusDetail), progress: null, active: false };
    }
  }
}

/**
 * The line under a label never says the label again. Every surface writes "<label> · <detail>", and the server's words
 * for a stage lead with the stage ("Downloading · 6.2 MB/s", "Looking"), so a part that only restates the label goes and
 * a part that starts with it loses it: under "Downloading", "Downloading · 6.2 MB/s" is "6.2 MB/s" and "Downloading" is "".
 */
export function detailUnder(label: string, words: string | null | undefined): string {
  const l = label.toLowerCase();
  const parts = (words ?? "").split("·").map(s => s.trim()).filter(Boolean)
    .map(p => (p.toLowerCase() === l ? "" : p.toLowerCase().startsWith(`${l} `) ? p.slice(l.length).trim() : p))
    .filter(Boolean);
  return sentence(parts.join(" · "));
}

/** a transfer rate in the product's words: "6.2 MB/s", "840 KB/s" */
export const fmtRate = (bps: number) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 5e7 ? 0 : 1)} MB/s` : `${Math.round(bps / 1e3)} KB/s`);
export const sentence = (s: string | null | undefined) => (!s ? "" : s.charAt(0).toUpperCase() + s.slice(1));

/** the word under a card for something that is not in the library: can it be had today? */
export function availabilityOf(i: Pick<DiscoverItem, "comingSoon" | "releaseText" | "releaseIso" | "crackStatus" | "free" | "reviewPct">): { text: string; dot: "ok" | "lamp" | "muted" } {
  if (i.comingSoon) return { text: shortDate(i.releaseIso) ?? i.releaseText ?? "Coming soon", dot: "muted" };
  if (i.crackStatus === "cracked") return { text: `Available${i.reviewPct != null ? ` · ${i.reviewPct}%` : ""}`, dot: "ok" };
  if (i.crackStatus === "uncracked" || i.crackStatus === "hypervisor") return { text: "Not yet", dot: "muted" };
  if (i.free) return { text: "Free on Steam", dot: "muted" };
  return { text: i.reviewPct != null ? `${i.reviewPct}% positive` : "", dot: "muted" };
}

/** a calendar day ("2026-08-02") in the product's words: "Aug 2", or "Aug 2, 2025" in another year */
export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  return Number.isNaN(d.getTime()) ? null : fmtDay(d);
}

export const isActive = (g: Game) => g.status === "searching" || g.status === "downloading" || g.status === "importing";

/** today's calendar day where the player is ("2026-11-06"; release dates are calendar days) */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/**
 * Not out yet: the engine says so (unreleased), or nobody tracks it any more (unmonitored) and its release is still ahead, by the
 * engine's own rule (a date after today; no date but "coming soon"). Such a game offers Track, never Request: a request would
 * look for a game that does not exist yet.
 */
export const notOutYet = (g: Game) => g.status === "unreleased" || (g.status === "unmonitored" && !g.hasFile && (g.releaseIso ? g.releaseIso > today() : g.comingSoon));
/** I track it: an ask of mine stands for it while the server keeps an eye on it. Track / Tracked is each person's own; another
 *  person's track neither makes it Tracked for me nor stops when I stop (server/src/library.ts monitor) */
export const tracksIt = (g: Game, meId: number | null | undefined) => meId != null && g.monitored && g.people.requestedBy.some(r => r.user.id === meId);
/** Cancel is mine to press: the server says so for whoever is looking (an admin, whoever started the search or brought the game:
 *  server/src/library.ts mayCancel). A server that does not say lets any member, as it always did */
export const mayCancel = (g: Pick<Game, "may">) => g.may?.cancel !== false;

/** strip Steam's HTML from "about the game" into a few readable paragraphs */
/** Windows-1252 punctuation that some store texts carry as C1 control characters (they draw as empty boxes) */
const C1: Record<string, string> = { "\u0085": "\u2026", "\u0091": "\u2018", "\u0092": "\u2019", "\u0093": "\u201c", "\u0094": "\u201d", "\u0095": "\u2022", "\u0096": "\u2013", "\u0097": "\u2014" };
export function plainText(html: string | null | undefined, maxChars = 1400): string[] {
  if (!html) return [];
  html = html.replace(/[\u0080-\u009f]/g, c => C1[c] ?? "");
  const t = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h\d|li)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const out: string[] = [];
  let n = 0;
  for (const p of t.split(/\n+/).map(s => s.trim()).filter(Boolean)) { if (n + p.length > maxChars) break; out.push(p); n += p.length; }
  return out;
}

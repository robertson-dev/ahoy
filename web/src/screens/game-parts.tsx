/**
 * The game and Steam pages' own pieces. There is no board for these pages: the head is built like the right pane of
 * M/lfs/library-split/Library-Split.dc.html (its gen.mjs holds the rules: the facts line, the facts table by state, Lately),
 * the rest in the language of the Discover and Library boards (section heads, poster shelves, hairline lists).
 *   factsLine     the one line under the title, in the product's words ("Arrived 22 h ago · 20 GB", "Nov 6 · today · Pell tracks it")
 *   libraryFacts  the facts table, its rows chosen by where the game is (size, version, on the server since, asked for by,
 *                 installed by, playing now, folder on this PC, out, tracked by)
 *   storeFacts    what the store says (release, developer, publisher, genres, reviews, Metacritic, platforms, "Playable: Not
 *                 yet" while no copy can be played, Steam)
 *   FactsTable, Lately, MediaSection, AboutSection, WaysSection, SimilarShelf (its cards say the shared ui/status line)
 * Everything is one rule for every game and person; nothing is set per game.
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { fmtDay, fmtPlay, fmtSize, timeAgo, type ActivityItem, type Game, type Route, type UserRef } from "../api";
import { act, useLib, usePeople, useSimilar, type AppDetail, type Trailer } from "../data";
import type { InstallProgress, InstalledGame } from "../launcher";
import { notOutYet, sentence, type Journey } from "../model";
import type { PcState } from "../orders";
import { hasCopy, pcLine } from "../ui/install-on";
import { art } from "../ui/art";
import { Avatar } from "../ui/avatar";
import { releaseWords } from "../ui/calendar";
import { Icon } from "../ui/icons";
import { useUi } from "../ui/kit";
import { Viewer } from "../ui/media";
import { FEED_VERB, playingFor } from "../ui/people";
import { SectionHead } from "../ui/section";
import { StoreCard, tracker, useLineCtx } from "../ui/status";
import { PLATFORM_WORD, releaseLine, steamStore, webLink } from "../ui/words";

/* ─────────── words ─────────── */

const pct = (p: number | null | undefined) => `${Math.round(Math.max(0, Math.min(1, p ?? 0)) * 100)}%`;
/** "You, Pell and Sasha" (me first); past three, "You, Pell and 2 more" */
export function namesOf(us: UserRef[], meId: number | undefined): string {
  const n = us.map(u => (u.id === meId ? "you" : u.displayName));
  const list = n.length <= 1 ? n.join("") : n.length <= 3 ? `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}` : `${n.slice(0, 2).join(", ")} and ${n.length - 2} more`;
  return sentence(list);
}
const meFirst = (us: UserRef[], meId: number | undefined) => [...us].sort((a, b) => Number(b.id === meId) - Number(a.id === meId));
/** a release in the product's words: "Nov 6 · today", "Nov 9 · in 3 days", "Dec 3", "November" */
export function releaseOut(r: { releaseIso: string | null; releaseText: string | null }): string | null {
  if (!r.releaseIso && !r.releaseText) return null;
  const w = releaseWords({ iso: r.releaseIso, text: r.releaseText });
  return w.rel ? `${w.date} · ${w.rel.charAt(0).toLowerCase()}${w.rel.slice(1)}` : w.date;
}
const platformWord = (p: string) => (/^(win|windows|pc)$/i.test(p) ? "Windows" : PLATFORM_WORD[p.toLowerCase()] ?? sentence(p));

/** everyone who asked for it in one way: get (asked for), track, watch; tracking and watching count only while the server
 *  still keeps an eye on the game (once someone stops tracking it, the old asks stay in the data) */
const askers = (g: Game, kind: string) => (kind !== "get" && !g.monitored ? [] : g.people.requestedBy.filter(r => r.kind === kind).map(r => r.user));

/* ─────────── the facts line under the title ─────────── */

/**
 * One line, in the product's words (M/lfs/library-split gen.mjs factsLine; the Home's "<n> played"):
 *   on this PC "On this PC · 41 h played" · ready "Arrived 22 h ago · 20 GB" · moving "Downloading 48% · 6.2 MB/s",
 *   "Installing 48% · about 3 min left", "Asked for by Mika · Looking" · didn't make it · not out yet "Nov 6 · today · Pell tracks it".
 */
export function factsLine(g: Game, j: Journey, meId: number | undefined, playSeconds: number | null): ReactNode {
  // not out yet, tracked or not (an untracked one is still not out: its date, never "Not on your server")
  if (j.stage === "waiting" || (j.stage === "none" && notOutYet(g))) {
    const out = releaseOut(g), t = tracker(g, meId ?? null);
    const track = t?.me ? <>Tracked</> : t ? <><b>{t.name}</b> {t.verb}</> : null;
    return <>{out ?? "Not out yet"}{track ? <> · {track}</> : null}</>;
  }
  switch (j.stage) {
    case "installed": return playSeconds ? <>On this PC · {fmtPlay(playSeconds)} played</> : <>On this PC</>;
    case "ready": return <>Arrived {timeAgo(g.file?.addedAt ?? g.addedAt)} · {fmtSize(g.file?.size)}</>;
    case "installing": return <>{j.label} <b>{pct(j.progress)}</b>{j.eta ? <> · {j.eta}</> : null}</>;
    case "downloading": { const tail = j.eta ?? j.detail; return <>{j.label}{j.progress != null && j.progress > 0 ? <> <b>{pct(j.progress)}</b></> : null}{tail ? <> · {tail}</> : null}</>; }
    case "preparing": return <>{j.label}{j.detail ? <> · {j.detail}</> : null}</>;
    case "finding": {
      const by = askers(g, "get")[0] ?? g.people.requestedBy[0]?.user;
      const who = by ? (by.id === meId ? <>you</> : <b>{by.displayName}</b>) : null;
      return <>{who ? <>Asked for by {who} · </> : null}{j.label}{j.detail ? <> · {j.detail}</> : null}</>;
    }
    case "failed": return <>{j.label}</>;
    default: return <>{j.label}</>;
  }
}

/* ─────────── which version ─────────── */

/** the version of a game that is looked for ("Arcade"; "Any" while none was chosen), and Change for whoever may say so: the
 *  question, then the search starts again for the version picked */
export function PlatformFact({ g }: { g: Game }) {
  const { toast, choose } = useUi();
  const lib = useLib();
  const [busy, setBusy] = useState(false);
  const choices = g.platformChoices ?? [];
  const now = choices.find(c => c.id === g.wantPlatform) ?? null;
  const change = async () => {
    const version = await choose("Which version?", choices, g.wantPlatform ?? null);
    if (version == null || version === g.wantPlatform) return;
    setBusy(true);
    try { await act.setVersion(g.id, version); toast("Looking for it", "success"); await lib.reload(); }
    catch (e: any) { toast(String(e?.message ?? e), "danger"); } finally { setBusy(false); }
  };
  return (
    <span className="sv-fact">
      <span aria-live="polite">{now ? now.label : "Any"}</span>
      {g.may?.version && <button type="button" className="link" disabled={busy} onClick={() => void change()} aria-label={`Change the version of ${g.name}`}>Change</button>}
    </span>
  );
}

/* ─────────── the facts table ─────────── */

export interface FactRow { key: string; label: string; value: ReactNode; quiet?: boolean; title?: string }

/** people in a fact: their faces (24, linked to them) and their names; "· since 9 pm" after them when it says how long */
function People({ users, meId, tail }: { users: UserRef[]; meId: number | undefined; tail?: string | null }) {
  const us = meFirst(users, meId);
  return (
    <span className="gp-ppl">
      <span className="gp-faces">{us.slice(0, 3).map(u => <Link key={u.id} to={`/u/${u.name}`} aria-label={u.displayName} title={u.displayName}><Avatar u={u} size={24} /></Link>)}</span>
      <span className="gp-ppl-t">{namesOf(us, meId)}{tail ? ` · ${tail}` : ""}</span>
    </span>
  );
}

/** who plays it now, and how long when it is one person ("Pell · since 9 pm"): everyone's presence is asked for only while
 *  someone plays the game, so a page nobody plays sends no request for it */
function PlayingNow({ users, meId }: { users: UserRef[]; meId: number | undefined }) {
  const { items: people } = usePeople();
  const tail = users.length === 1 ? playingFor(people?.find(p => p.id === users[0].id)?.presence.since ?? null) : null;
  return <People users={users} meId={meId} tail={tail} />;
}

/**
 * The game's facts, chosen by where it is (the board's rows plus the spec's version and folder):
 *   on this PC   size · version · last played · installed by · playing now · folder on this PC
 *   ready        size · version · on the server since · asked for by · installed by ("Nobody yet") · playing now
 *   installing   size · asked for by · installed by
 *   moving       size (when known) · asked for by · tracked by
 *   didn't make it, not on the server   asked for by · tracked by
 *   not out yet  out · tracked by · asked for by
 */
export function libraryFacts({ g, j, inst, prog, meId, lastPlayed, pcs = [], saves, newer, platform }: {
  g: Game; j: Journey; inst: InstalledGame | undefined; prog: InstallProgress | undefined; meId: number | undefined;
  lastPlayed: number | null;
  /** my PCs as they stand to the game: one that has it, or is to get it, is a fact of its own ("On COUCH · Installing 48%") */
  pcs?: PcState[];
  /** how its saves stand (saves-state.tsx SavesFact), when there is something to say */
  saves?: ReactNode;
  /** the server's copy is newer than this PC's (Update is offered): what the update is */
  newer?: boolean;
  /** which version is looked for, with the way to change it (PlatformFact), for a game on several platforms without a copy */
  platform?: ReactNode;
}): FactRow[] {
  const size = inst?.sizeBytes || prog?.total || g.file?.size || null;
  const version = inst?.version || g.file?.version || null;   // this PC's while it has the game (an Update's own row says where it goes)
  const playing = g.people.playing;
  const R: Record<string, () => FactRow | null> = {
    size: () => (size ? { key: "size", label: "Size", value: fmtSize(size) } : null),
    version: () => (version ? { key: "version", label: "Version", value: version } : null),
    since: () => (g.file?.addedAt ? { key: "since", label: "On the server since", value: fmtDay(new Date(g.file.addedAt * 1000)) } : null),
    played: () => (lastPlayed ? { key: "played", label: "Last played", value: timeAgo(lastPlayed) } : null),
    out: () => { const o = releaseOut(g); return o ? { key: "out", label: "Out", value: o } : null; },
    asked: () => { const us = askers(g, "get"); return us.length ? { key: "asked", label: "Asked for by", value: <People users={us} meId={meId} /> } : null; },
    tracked: () => { const us = askers(g, "track"); return us.length ? { key: "tracked", label: "Tracked by", value: <People users={us} meId={meId} /> } : null; },
    watched: () => { const us = askers(g, "watch"); return us.length ? { key: "watched", label: "Watched by", value: <People users={us} meId={meId} /> } : null; },
    installed: () => (g.people.owners.length
      ? { key: "installed", label: "Installed by", value: <People users={g.people.owners} meId={meId} /> }
      : { key: "installed", label: "Installed by", value: "Nobody yet", quiet: true }),
    playing: () => (playing.length ? { key: "playing", label: "Playing now", value: <PlayingNow users={playing} meId={meId} /> } : null),
    folder: () => (inst?.path ? { key: "folder", label: "Folder on this PC", value: <span className="gp-path">{inst.path}</span>, title: inst.path } : null),
    saves: () => (saves ? { key: "saves", label: "Saves", value: saves } : null),
    platform: () => (platform ? { key: "platform", label: "Platform", value: platform } : null),
    // what Update changes: the version it goes to from the one here, or when the newer copy arrived
    update: () => {
      if (!newer || !inst || !g.file) return null;
      const from = inst.version, to = g.file.version;
      return { key: "update", label: "Update", value: from && to && from !== to ? `${from} → ${to}` : `Newer copy · arrived ${timeAgo(g.file.addedAt)}` };
    },
  };
  const BY: Record<string, string[]> = {
    installed: ["update", "size", "version", "played", "saves", "installed", "playing", "folder"],
    ready: ["size", "version", "since", "saves", "asked", "installed", "playing"],
    installing: ["size", "asked", "installed"],
    downloading: ["platform", "size", "asked", "tracked"], preparing: ["platform", "size", "asked", "tracked"], finding: ["platform", "asked", "tracked"],
    failed: ["platform", "asked", "tracked", "watched"],
    waiting: ["out", "platform", "tracked", "asked"],
    none: ["platform", "asked", "tracked", "watched", "playing"],
  };
  const copy = hasCopy(g);
  const mine: FactRow[] = pcs.filter(p => !p.here && (p.has || p.order)).map(p => ({ key: `pc:${p.device}`, label: `On ${p.device}`, value: pcLine(p, copy) }));
  return [...(BY[j.stage] ?? BY.none).map(k => R[k]()).filter((r): r is FactRow => !!r), ...mine];
}

/** what the store says about it (the old page's facts, on both pages) */
export function storeFacts({ g, app }: { g?: Game | null; app?: AppDetail | null }): FactRow[] {
  const rows: FactRow[] = [];
  const add = (key: string, label: string, value: ReactNode | null | undefined | false, title?: string) => { if (value != null && value !== "" && value !== false) rows.push({ key, label, value, title }); };
  const rel = g ? releaseLine(g) ?? (g.releaseYear ? String(g.releaseYear) : null) : app ? releaseLine(app) : null;
  add("release", "Release", rel);
  const dev = g?.developer || app?.developers?.slice(0, 2).join(", ");
  const pub = g?.publisher || app?.publishers?.slice(0, 2).join(", ");
  add("dev", "Developer", dev, dev || undefined);
  if (pub && pub !== dev) add("pub", "Publisher", pub, pub);
  const genres = (g?.genres.length ? g.genres : app?.genres ?? []).slice(0, 3).join(", ");
  add("genres", "Genres", genres);
  if (app?.reviewSummary) add("reviews", "Reviews", <span>{app.reviewSummary}{app.reviewPct != null ? <span className="gp-soft"> · {app.reviewPct}%{app.reviewCount != null ? ` of ${app.reviewCount.toLocaleString("en-US")}` : ""}</span> : null}</span>);
  if (app?.metacritic != null) add("mc", "Metacritic", String(app.metacritic));
  const plats = [...new Set((g?.platforms.length ? g.platforms : app?.platforms ?? []).map(platformWord))].join(", ");
  add("plat", "Platforms", plats);
  // while no copy of it can be played yet (GameAction's "Watch for it"), in the product's words: never what protects it
  const crack = g?.crackStatus ?? app?.crackStatus ?? null;
  if (crack === "uncracked" || crack === "hypervisor") add("playable", "Playable", "Not yet");
  const appId = g?.steamAppId ?? app?.appId ?? null;
  if (appId) add("steam", "Steam", <a className="gp-out" href={steamStore(appId)} target="_blank" rel="noreferrer">Store page<Icon name="out" size={16} strokeWidth={2.2} /></a>);
  return rows;
}

export function FactsTable({ rows, label, className }: { rows: FactRow[]; label: string; className?: string }) {
  if (!rows.length) return null;
  return (
    <dl className={`gp-facts${className ? " " + className : ""}`} aria-label={label}>
      {rows.map(r => <div key={r.key} className="gp-fact"><dt>{r.label}</dt><dd className={r.quiet ? "quiet" : undefined} title={r.title}>{r.value}</dd></div>)}
    </dl>
  );
}

/* ─────────── Lately: what happened to this game ─────────── */

/** the feed lines about this game, newest first, in the product's verbs (four, as the board shows) */
export function Lately({ items, meId }: { items: ActivityItem[]; meId: number | undefined }) {
  if (!items.length) return null;
  return (
    <section className="gp-lately" aria-labelledby="gp-lately-h">
      <h2 id="gp-lately-h">Lately</h2>
      <ol>{items.slice(0, 4).map(a => <LatelyLine key={a.id} a={a} you={a.user.id === meId} />)}</ol>
    </section>
  );
}

function LatelyLine({ a, you }: { a: ActivityItem; you: boolean }) {
  const verb = you && a.kind === "tracked" ? "are tracking" : FEED_VERB[a.kind];
  const secs = a.kind === "played" && typeof a.data?.playSeconds === "number" ? a.data.playSeconds : 0;
  const what = a.kind === "friends" && a.data?.userName ? <Link to={`/u/${String(a.data.userName)}`}><b>{a.name}</b></Link> : a.name ? <b>{a.name}</b> : null;
  const tail = a.kind === "installed" && a.data?.device ? ` on ${String(a.data.device)}` : secs ? ` for ${fmtPlay(secs)}` : "";
  return (
    <li className="gp-line">
      <Link to={`/u/${a.user.name}`} className="gp-line-av" tabIndex={-1} aria-hidden="true"><Avatar u={a.user} size={32} /></Link>
      <span className="gp-line-tx">
        <span className="gp-line-s"><Link to={`/u/${a.user.name}`}><b>{you ? "You" : a.user.displayName}</b></Link> {verb} {what}{tail}</span>
        <span className="gp-line-t">{timeAgo(a.at)}</span>
      </span>
    </li>
  );
}

/* ─────────── trailers and screenshots ─────────── */

/** a screenshot's tile: the source's own smaller copy (Steam's 600 x 338 of its 1920 x 1080, IGDB's screenshot_med of its
 *  1280 one), so a 318 px tile never pulls a full-size image; any other address stays as it is */
export const tileOf = (u: string) =>
  u.replace(/\.1920x1080\.(jpe?g)(?=$|[?#])/i, ".600x338.$1").replace(/\/t_(screenshot_hugecap|screenshot_big|720p|1080p|original)\//, "/t_screenshot_med/");

/** up to eight 16:9 tiles (trailers first, a frosted play mark on them; six where three fit across, game.css); any tile opens
 *  the viewer over all of them. `shots` are the screenshots' own addresses: the tiles draw `tileOf` them, the viewer the full ones */
export function MediaSection({ trailers, shots: raw }: { trailers: Trailer[]; shots: string[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const shots = raw.map(s => art.proxy(s));
  const items = [...trailers.map(t => ({ video: true, thumb: t.thumb, label: t.name })), ...raw.map(s => ({ video: false, thumb: art.proxy(tileOf(s)), label: "" }))];
  if (!items.length) return null;
  const title = trailers.length && raw.length ? "Trailers & screenshots" : trailers.length ? (trailers.length > 1 ? "Trailers" : "Trailer") : "Screenshots";
  return (
    <section className="gp-sect gp-msect" aria-labelledby="gp-media-h">
      <SectionHead id="gp-media-h" title={title} count={items.length > 6 ? items.length : null} />
      <ul className="gp-media">
        {items.slice(0, 8).map((m, i) => (
          <li key={i}>
            <button type="button" className="gp-shot" onClick={() => setOpen(i)} aria-label={m.video ? `Play ${m.label || "the trailer"}` : `Screenshot ${i - trailers.length + 1} of ${shots.length}`}>
              <img src={m.thumb} alt="" loading="lazy" draggable={false} />
              {m.video && <span className="gp-play" aria-hidden><Icon name="playSolid" size={18} /></span>}
            </button>
          </li>
        ))}
      </ul>
      <Viewer open={open != null} index={open ?? 0} trailers={trailers} shots={shots} onClose={() => setOpen(null)} />
    </section>
  );
}

/* ─────────── about ─────────── */

/** the store's words about the game beside what the store says it is */
export function AboutSection({ paras, facts }: { paras: string[]; facts: FactRow[] }) {
  if (!paras.length && !facts.length) return null;
  return (
    <section className="gp-sect" aria-labelledby="gp-about-h">
      <SectionHead id="gp-about-h" title="About" />
      <div className={`gp-about${paras.length ? "" : " solo"}`}>
        {paras.length > 0 && <div className="gp-prose">{paras.map((p, i) => <p key={i}>{p}</p>)}</div>}
        <FactsTable rows={facts} label="Facts" className="gp-store" />
      </div>
    </section>
  );
}

/* ─────────── other ways to play (the catalog's routes) ─────────── */

const KIND_WORD: Record<string, string> = { native: "Native", recomp: "Recompiled", port: "Port", emulated: "Emulated" };
const PROVENANCE_WORD: Record<string, string> = { leak: "Unreleased build", prototype: "Prototype", beta: "Beta", demo: "Demo" };
const STATUS_WORD: Record<string, string> = { perfect: "Runs perfectly", playable: "Playable", ingame: "Gets in game", intro: "Reaches the intro", menus: "Reaches the menus", boots: "Starts", nothing: "Doesn't start" };

/** each route as a quiet row: its name, then where it runs, what build it is, what runs it and how well; Open when it links out
 *  to a web page (the link is a catalog's, from outside: nothing but http and https is ever drawn as one) */
export function WaysSection({ routes }: { routes: Route[] }) {
  if (!routes.length) return null;
  return (
    <section className="gp-sect" aria-labelledby="gp-ways-h">
      <SectionHead id="gp-ways-h" title="Other ways to play" />
      <ul className="gp-ways">
        {routes.map(r => {
          const name = r.label ?? r.runtime?.name ?? KIND_WORD[r.kind] ?? sentence(r.kind);
          const runtime = r.runtime?.latest ? (name === r.runtime.name ? r.runtime.latest.tag : `${r.runtime.name} ${r.runtime.latest.tag}`) : null;
          const line = [
            r.platform ? platformWord(r.platform) : null,
            PROVENANCE_WORD[r.provenance] ?? null,
            runtime ?? r.statusNote,
            r.status ? STATUS_WORD[r.status] ?? null : null,
          ].filter(Boolean).join(" · ");
          const link = webLink(r.link);
          return (
            <li key={r.id} className="gp-way">
              <span className="gp-way-t"><b>{name}</b>{line && <small>{line}</small>}</span>
              {link && <a className="btn s36" href={link} target="_blank" rel="noreferrer" aria-label={`Open ${name}`}><Icon name="out" size={14} strokeWidth={2.4} />Open</a>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ─────────── more like this ─────────── */

/** what the store puts next to this game, as a poster shelf; nothing is drawn until there is something to show */
export function SimilarShelf({ appId }: { appId: number | null | undefined }) {
  const { items } = useSimilar(appId);
  const c = useLineCtx();
  const list = (items ?? []).filter(i => i.appId !== appId);
  if (!list.length) return null;
  return (
    <section className="gp-sect" aria-labelledby="gp-more-h">
      <SectionHead id="gp-more-h" title="More like this" />
      <ol className="gp-shelf">{list.map((i, n) => <li key={`${i.appId}-${n}`}><StoreCard i={i} c={c} /></li>)}</ol>
    </section>
  );
}

/**
 * Ahoy — Home (/). Board: M/mine/livefan/Main.dc.html (render M/canvas-r/Main.png); spec: I/SCREENS.md "Home".
 *
 * One screen, the window tall, no scrolling:
 *   - the spotlight of the fan's centre game (ui/spotlight.tsx in its automatic mode: the server lays the stage out),
 *     with one facts line in the Home's words and two actions: the game's one action (GameAction) and Details;
 *   - under the top bar, the friends who are on: playing ones first (the game and how long), at most four, then +N;
 *   - at the bottom, the fan of five generated cards (screens/home-fan.tsx), cut by the window's bottom edge.
 * Which games make the fan is one rule for every library (pickFan). Picking a side card brings it to the centre and the
 * spotlight cross-fades to it; the centre card opens the game's page.
 * With no library yet the stage says so and offers Discover; there is no fan.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fmtDay, fmtPlay, fmtSize, sentence, type Game, type Person } from "../api";
import { useLib, usePeople } from "../data";
import { useLauncher } from "../launcher-state";
import type { InstallProgress, InstalledGame } from "../launcher";
import { fmtRate, isActive, journeyOf, notOutYet } from "../model";
import { useSession } from "../session";
import { useUnderBar } from "../shell";
import { Avatar } from "../ui/avatar";
import { Button, ButtonLink } from "../ui/button";
import { releaseWords } from "../ui/calendar";
import { Spinner } from "../ui/controls";
import { GameAction } from "../ui/game-action";
import { presenceWords } from "../ui/people";
import { Spotlight, prefetchSpotlight } from "../ui/spotlight";
import { artProgress, tracker, useLineCtx, usePlayed } from "../ui/status";
import { Fan, fanScale, type CardWords, type FanEntry } from "./home-fan";
import "./home.css";

/* ─────────── the Home's words ─────────── */

const DAY = 86_400;
/** a fresh arrival: on the server this long (the fan's centre, and its words even once it is on this PC) */
const FRESH = 7 * DAY;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** when a game arrived on the server: "today", "last night" (yesterday from 6 pm), "yesterday", the weekday within six
 *  days ("Tuesday"), else the day ("Oct 28"); local time */
function arrivedWords(sec: number, now = new Date()): string {
  const d = new Date(sec * 1000);
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(d)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return d.getHours() >= 18 ? "last night" : "yesterday";
  if (days <= 6) return WEEKDAYS[d.getDay()];
  return fmtDay(d);
}

/** what the Home says about a game: the spotlight's facts line, and a card's status in full and short */
interface Said extends CardWords { facts: string }
function sayGame(g: Game, here: { inst?: InstalledGame; prog?: InstallProgress; playSec?: number; meId: number | null }): Said {
  const { inst, prog, playSec, meId } = here;
  // copying to this PC: "48% · about 3 min left"
  if (prog) {
    const j = journeyOf(g, inst, prog), p = `${Math.round(prog.progress * 100)}%`;
    const tail = j.eta ?? (prog.rate ? fmtRate(prog.rate) : "");
    const facts = tail ? `${p} · ${tail}` : p;
    return { facts, status: `${j.label} · ${facts}`, short: facts };
  }
  // on this PC: "On this PC · 41 h played"; a fresh arrival not played yet still says it is new: "Arrived today · On this PC"
  if (inst) {
    const played = playSec && playSec >= 60 ? `${fmtPlay(playSec)} played` : null;
    if (!played && g.file && Date.now() / 1000 - g.file.addedAt <= FRESH) {
      const when = `Arrived ${arrivedWords(g.file.addedAt)}`, facts = `${when} · On this PC`;
      return { facts, status: facts, short: when };
    }
    const facts = played ? `On this PC · ${played}` : "On this PC";
    return { facts, status: facts, short: played ?? "On this PC" };
  }
  const j = journeyOf(g);
  // on the server: "Arrived last night · 20 GB"
  if (g.status === "available" && g.file) {
    const when = arrivedWords(g.file.addedAt), facts = `Arrived ${when} · ${fmtSize(g.file.size)}`;
    return { facts, status: facts, short: `Arrived ${when}` };
  }
  // moving on the server: "48% · about 20 min left" (or the rate, when the server sends no estimate), or the stage while
  // there is no number ("Looking")
  if (j.active) {
    if (j.progress != null && j.progress > 0) {
      const tail = j.eta ?? j.detail, p = `${Math.round(j.progress * 100)}%`, facts = tail ? `${p} · ${tail}` : p;
      return { facts, status: `${j.label} · ${facts}`, short: facts };
    }
    const facts = j.detail ? `${j.label} · ${j.detail}` : j.label;
    return { facts, status: facts, short: j.label };
  }
  // not out yet: "Tracked · in 3 days" when I track it, "Pell tracks it · in 3 days", else "Not out yet · Dec 3"
  if (notOutYet(g)) {
    const w = releaseWords({ iso: g.releaseIso, text: g.releaseText });
    const when = w.isToday ? "out today" : w.rel ?? w.date;
    const t = tracker(g, meId), who = t?.me ? "Tracked" : t ? `${t.name} ${t.verb}` : "Not out yet";
    return { facts: `${who} · ${when}`, status: `${who} · ${when}`, short: sentence(when) };
  }
  const facts = j.detail ? `${j.label} · ${j.detail}` : j.label;
  return { facts, status: facts, short: j.label };
}

/** box-art cards: everyone but me who plays it now, in the Library's words ("Pell is playing", "Jonas and Pell are playing",
 *  "Jonas and 2 more are playing"), with the first one's face */
function playingNow(g: Game, meId: number | null): FanEntry["playing"] {
  const us = g.people.playing.filter(u => u.id !== meId);
  if (!us.length) return null;
  const [a, b] = us;
  const text = us.length === 1 ? `${a.displayName} is playing` : us.length === 2 ? `${a.displayName} and ${b.displayName} are playing` : `${a.displayName} and ${us.length - 1} more are playing`;
  return { who: a, text };
}

const SMALL = new Set(["the", "of", "a", "an", "and", "in", "on", "at", "to", "for", "or"]);
/** a name typed in capitals reads as shouting: title-case it, roman numerals kept (the cards' rule, server/src/cards/layout.ts) */
function displayName(name: string): string {
  const letters = name.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4 || name !== name.toUpperCase()) return name;
  return name.split(" ").map((w, i) => (/^[IVX]+$/.test(w) ? w : i > 0 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase())).join(" ");
}

/* ─────────── which games make the fan ─────────── */

/** server moves: the one furthest along first (the top bar's downloads pill orders them the same way) */
const STAGE_RANK: Record<string, number> = { importing: 2, downloading: 1, searching: 0 };

interface FanInputs {
  games: Game[];
  /** seconds */
  now: number;
  /** the games played on this PC, by when they were last played (seconds) */
  played: Map<number, number>;
  /** what moves now: launcher installs first, then the server's, furthest along first */
  moving: number[];
  /** a game this person asked for or tracks (their want): the only other games that may fill the fan */
  mine: (g: Game) => boolean;
}

/**
 * The fan's games, outer left to outer right (null where the library has too few):
 *   centre       the newest arrival on the server within 7 days; else the game played last on this PC; else the one moving
 *                now; else the newest game
 *   inner left   the game played last on this PC
 *   inner right  the game moving now
 *   outer right  the next-newest arrival; outer left the one after that
 * Any empty slot is filled from the rest of the library, newest first. (The hue rule then runs in the fan.)
 */
function pickFan({ games, now, played, moving, mine }: FanInputs): (Game | null)[] {
  const byId = new Map(games.map(g => [g.id, g]));
  const arrivals = games.filter(g => g.file).sort((a, b) => b.file!.addedAt - a.file!.addedAt || a.name.localeCompare(b.name));
  const lastPlayed = [...played.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => byId.get(id)).filter((g): g is Game => !!g);
  const movingNow = moving.map(id => byId.get(id)).filter((g): g is Game => !!g);
  // the rest of the library fills empty slots, but only what someone here has a reason to see: on the server, moving, played here,
  // or wanted by this person. A game only in the engine's list (tracked, then untracked) stays off the Home
  const movingSet = new Set(moving);
  const newest = games.filter(g => !!g.file || movingSet.has(g.id) || played.has(g.id) || mine(g)).sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name));
  const fresh = arrivals[0] && now - arrivals[0].file!.addedAt <= FRESH ? arrivals[0] : undefined;
  const centre = fresh ?? lastPlayed[0] ?? movingNow[0] ?? newest[0];
  if (!centre) return [null, null, null, null, null];
  const used = new Set([centre.id]);
  const take = (list: Game[]) => { const g = list.find(x => !used.has(x.id)) ?? null; if (g) used.add(g.id); return g; };
  const innerL = take(lastPlayed), innerR = take(movingNow), outerR = take(arrivals), outerL = take(arrivals);
  const slots = [outerL, innerL, centre, innerR, outerR];
  for (const i of [1, 3, 4, 0]) if (!slots[i]) slots[i] = take(newest);
  return slots;
}

/* ─────────── the friends who are on ─────────── */

let measureCtx: CanvasRenderingContext2D | null = null;
const textW = (s: string, weight: number) => {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return s.length * 8;
  measureCtx.font = `${weight} 15px "Figtree Variable", Figtree, system-ui, sans-serif`;
  return measureCtx.measureText(s).width;
};

/** under the bar: each friend who is on, playing ones first; the game (bright) and how long, or "Online"; at most four, as
 *  many as fit the width, then +N (Friends). A chip opens the game they play, or the person. */
function WhoIsOn({ people, meId, width }: { people: Person[] | null; meId: number | undefined; width: number }) {
  const on = (people ?? []).filter(p => p.id !== meId && p.friend === "friends" && p.presence.state !== "offline")
    .sort((a, b) => Number(b.presence.state === "playing") - Number(a.presence.state === "playing") || a.displayName.localeCompare(b.displayName));
  if (!on.length) return null;
  const chips = on.map(p => {
    const w = presenceWords(p.presence), playing = p.presence.state === "playing";
    const game = playing ? displayName(w.game ?? "") || "Playing" : null;
    const to = playing && p.presence.gameId != null ? `/game/${p.presence.gameId}` : playing && p.presence.appId != null ? `/steam/${p.presence.appId}` : `/u/${p.name}`;
    const label = playing ? `${p.displayName} is playing ${game}${w.how ? `, ${w.how.startsWith("since") ? `on ${w.how}` : `for ${w.how}`}` : ""}` : `${p.displayName} is online`;
    const size = 44 + (playing ? textW(game ?? "", 600) + (w.how ? 8 + textW(w.how, 500) : 0) : textW("Online", 600));
    return { p, playing, game, how: w.how, to, label, size };
  });
  // as many as fit beside each other (28 apart), the +N square after them
  let n = 0, used = 0;
  for (const c of chips.slice(0, 4)) {
    const rest = chips.length - (n + 1);
    if (used + (n ? 28 : 0) + c.size + (rest > 0 ? 28 + 32 : 0) > width) break;
    used += (n ? 28 : 0) + c.size; n++;
  }
  n = Math.max(1, n);
  const more = chips.length - n;
  return (
    <nav className="home-who" aria-label="Friends online">
      {chips.slice(0, n).map(c => (
        <Link key={c.p.id} className="home-chip" to={c.to} aria-label={c.label}>
          <Avatar u={c.p} size={32} />
          {c.playing
            ? <span className="home-chip-t"><b>{c.game}</b>{c.how && <span>{c.how}</span>}</span>
            : <span className="home-chip-t"><i>Online</i></span>}
        </Link>
      ))}
      {more > 0 && <Link className="home-more" to="/people" aria-label={`${more} more friends online`}>+{more}</Link>}
    </nav>
  );
}

/* ─────────── the page ─────────── */

/** the game the fan was turned to, kept while the app is open (back from a game page, the same game is in the centre) until
 *  something newer arrives on the server (`newest`: the newest file's arrival when it was turned); the newest arrival, the
 *  rule's centre, then takes the centre again */
let turnedTo: { id: number; newest: number } | null = null;

/** the chips' row stays in the spotlight's text column (its stage is 660 wide): its scrims keep the text readable there */
const CHIPS_MAX = 660;

/** the window's stage: its size, the top bar's height and the page margin (the CSS variables the shell sets) */
function stageOf(el: HTMLElement | null) {
  const css = getComputedStyle(document.documentElement);
  return {
    w: el?.clientWidth || document.documentElement.clientWidth, h: el?.clientHeight || window.innerHeight,
    bar: parseFloat(css.getPropertyValue("--bar-h")) || 148, px: parseFloat(css.getPropertyValue("--page-x")) || 48,
  };
}

export function Home() {
  useUnderBar();                                         // the top is key art (or the dark stage), under the bar
  const lib = useLib();
  const L = useLauncher();
  const { me } = useSession();
  const play = usePlayed();                              // my play time and last session per game (null until my profile answers)
  const c = useLineCtx({ play });
  const { items: people } = usePeople();
  const root = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState(() => stageOf(null));
  useLayoutEffect(() => {
    const measure = () => { const s = stageOf(root.current); setStage(o => (o.w === s.w && o.h === s.h && o.bar === s.bar && o.px === s.px ? o : s)); };
    measure();
    const ro = new ResizeObserver(measure);
    if (root.current) ro.observe(root.current);
    addEventListener("resize", measure);
    return () => { ro.disconnect(); removeEventListener("resize", measure); };
  }, []);

  // this PC and my play time
  const said = (g: Game) => sayGame(g, { inst: c.inst(g), prog: c.prog(g), playSec: play?.get(g.id)?.s, meId: me?.id ?? null });

  // the fan's games, by the rule
  const fan = useMemo(() => {
    const played = new Map<number, number>();
    for (const [id, p] of play ?? []) {
      if (!p.at) continue;
      const g = lib.byId.get(id);
      if (!g || (L.inLauncher && !c.inst(g))) continue;    // in the launcher: played on this PC (installed here)
      played.set(g.id, p.at);
    }
    const fromPc = Object.values(L.installs).map(p => p.gameId ?? lib.games.find(g => g.file?.id === p.packageId)?.id).filter((id): id is number => id != null);
    const server = lib.games.filter(isActive).sort((a, b) => (STAGE_RANK[b.status] ?? 0) - (STAGE_RANK[a.status] ?? 0) || (b.request?.progress ?? 0) - (a.request?.progress ?? 0) || a.name.localeCompare(b.name)).map(g => g.id);
    const meId = me?.id ?? null;
    return pickFan({ games: lib.games, now: Date.now() / 1000, played, moving: [...fromPc, ...server], mine: g => meId != null && g.people.requestedBy.some(r => r.user.id === meId) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.games, play, L.installed, L.installs, L.inLauncher, me?.id]);
  const fanIds = fan.filter((g): g is Game => !!g).map(g => g.id);
  const fanKey = fanIds.join(",");

  // the centre: the game the fan was turned to while it is in the fan and nothing newer has arrived since, else the rule's centre
  const newest = lib.games.reduce((m, g) => Math.max(m, g.file?.addedAt ?? 0), 0);
  const [turned, setTurned] = useState(turnedTo);
  const focusId = turned && turned.newest >= newest && fanIds.includes(turned.id) ? turned.id : fan[2]?.id ?? null;
  const focus = focusId != null ? lib.byId.get(focusId) : undefined;
  const turn = (id: number) => { turnedTo = { id, newest }; setTurned(turnedTo); };
  // a newer arrival ends the turn for good: it is the rule's centre now
  useEffect(() => { if (turned && newest > turned.newest) { turnedTo = null; setTurned(null); } }, [newest]);   // eslint-disable-line react-hooks/exhaustive-deps
  // warm every fan game's stage, so turning the fan cross-fades at once (the Spotlight keeps the leaving art on top, fading)
  useEffect(() => { for (const id of fanIds) prefetchSpotlight({ gameId: id }, undefined, stage.w); }, [fanKey, stage.w]);   // eslint-disable-line react-hooks/exhaustive-deps

  // box art also shows how far a moving game has come and who else plays it now
  const entries: (FanEntry | null)[] = fan.map(g => (g ? { game: g, words: said(g), moving: artProgress(g, c), playing: playingNow(g, me?.id ?? null) } : null));
  const scale = fanScale(stage.w, stage.h, stage.bar, stage.px);

  let body;
  // the stage waits for the library and my play time (the rule's centre may be the game played last)
  if (!lib.loaded || (me && !play)) {
    body = <div className="home-wait"><Spinner size={28} label="Loading your games" /></div>;
  } else if (!lib.games.length && lib.error) {
    body = (
      <section className="home-empty" aria-label="Can't reach your server">
        <div className="home-empty-in">
          <h1>Can't reach your server</h1>
          <div className="spot-acts"><Button kind="primary" size={48} icon="retry" onClick={() => void lib.reload()}>Try again</Button></div>
        </div>
      </section>
    );
  } else if (!lib.games.length || !focus) {
    body = (
      <section className="home-empty" aria-label="Nothing on your server yet">
        <div className="home-empty-in">
          <h1>Nothing on your server yet</h1>
          <div className="spot-acts"><ButtonLink to="/discover" kind="primary" size={48} icon="compass">Discover</ButtonLink></div>
        </div>
      </section>
    );
  } else {
    body = (
      <>
        <Spotlight source={{ gameId: focus.id }} name={focus.name} height="100vh" facts={said(focus).facts}
          actions={<><GameAction game={focus} variant="button" size={48} label={displayName(focus.name)} /><ButtonLink to={`/game/${focus.id}`} size={48}>Details</ButtonLink></>} />
        <Fan entries={entries} focus={focus.id} onFocus={turn} scale={scale} />
      </>
    );
  }
  // the chips come first: they stand under the bar, above the stage, and Tab meets them in that order
  return (
    <div className="home" ref={root}>
      <WhoIsOn people={people} meId={me?.id} width={Math.min(CHIPS_MAX, stage.w - 2 * stage.px)} />
      {body}
    </div>
  );
}

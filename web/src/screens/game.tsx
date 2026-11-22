/**
 * Ahoy — one page for a game, whether it is on your server (GamePage, /game/:id) or only out there on Steam (SteamPage,
 * /steam/:appId). No board of its own: the head is built like the right pane of M/lfs/library-split/Library-Split.dc.html,
 * over the full width:
 *   the Spotlight (the server's layout of the game's logo-free key art and its identity: contracts/spotlight.md), one facts
 *   line, the one thing to do (GameAction) with what else this PC can do (Open folder, Uninstall), the five-stop journey
 *   while it moves or waits on the server; then the facts table beside Lately, on the board's ground (the art gone by 700).
 * Then the store's content in the new components: trailers and screenshots, About with the store's facts, other ways to play,
 * More like this (a poster shelf).
 */
import { useRef, useState, type ReactNode } from "react";
import { Navigate, useParams } from "react-router-dom";
import type { Game, GameDetail } from "../api";
import { gameOfApp, useApp, useGame, useLib, useProfile, type AppDetail } from "../data";
import { newerCopy, refreshesStart } from "../launcher";
import { useLauncher } from "../launcher-state";
import { journeyOf, plainText } from "../model";
import { usePcs } from "../pcs";
import { SavesFact, useHasSaves } from "../saves-state";
import { useSession } from "../session";
import { Button, ButtonLink } from "../ui/button";
import { releaseWords } from "../ui/calendar";
import { EmptyState, Spinner } from "../ui/controls";
import { GameActionView, useGameAction } from "../ui/game-action";
import { JourneyLine } from "../ui/journey";
import { useSwapFocus } from "../ui/motion";
import { Spotlight } from "../ui/spotlight";
import { cleanName } from "../ui/words";
import { AboutSection, FactsTable, Lately, MediaSection, PlatformFact, SimilarShelf, WaysSection, factsLine, libraryFacts, storeFacts } from "./game-parts";
import "./game.css";

/** where the head ends (board px on the 148 bar; the stage follows a shorter bar): the facts table starts 40 under the
 *  journey (the actions end at 504, the journey takes 544 to 588), or 40 under the actions when there is no journey */
const HEAD_WITH_JOURNEY = 628;
const HEAD = 544;
/** the board's art box over the head's lower half, so the journey, the facts and Lately always stand on the page (game.css) */
const GROUND = <div className="gp-ground" />;

/** the action row: the one thing to do, then what else this PC can do with it (Open folder; Uninstall asks first, in place) */
const ActRow = ({ ga }: { ga: ReturnType<typeof useGameAction> }) => <GameActionView ga={ga} variant="full" size={48} showStatus={false} />;

/** a page that has no game to show: loading, not on the server, or the server did not answer */
function Holding({ children }: { children: ReactNode }) {
  return <div className="gp-hold">{children}</div>;
}

export function GamePage() {
  const { id } = useParams();
  const gid = Number(id);
  const lib = useLib();
  const { item, error, reload } = useGame(gid);
  // the detail belongs to this id only (useGame keeps the last game's for a render after the id changes)
  const detail = item && item.id === gid ? item : null;
  const g = detail ?? lib.byId.get(gid) ?? null;
  if (!g) {
    if (error && lib.loaded && !lib.error) return <Holding><EmptyState title="That game is not on your server" action={<ButtonLink to="/library" size={44}>Back to the library</ButtonLink>} /></Holding>;
    if (error) return <Holding><EmptyState title="Could not load this game" action={<Button size={44} icon="retry" onClick={() => { void reload(); void lib.reload(); }}>Try again</Button>} /></Holding>;
    return <Holding><Spinner block label="Loading" /></Holding>;
  }
  return <GameView g={g} detail={detail} />;
}

function GameView({ g, detail }: { g: Game; detail: GameDetail | null }) {
  const { item: app0 } = useApp(g.steamAppId);
  const app = app0 && app0.appId === g.steamAppId ? app0 : null;
  const about = plainText(app?.about, 1600).length ? plainText(app?.about, 1600) : plainText(g.summary, 1600);
  const shots = app?.screenshots?.length ? app.screenshots : g.screenshots;
  return (
    <div className="gp">
      <GameHead g={g} detail={detail} below={low => (
        <div className={`gp-body${low ? "" : " near"}`} key={`body-${g.id}`}>
          <MediaSection trailers={app?.trailers ?? []} shots={shots} />
          <AboutSection paras={about} facts={storeFacts({ g, app })} />
          {detail && <WaysSection routes={detail.routes} />}
          <SimilarShelf appId={g.steamAppId} />
        </div>
      )} />
    </div>
  );
}

/**
 * A library game's head, as its page opens and as the Library's list shows the picked game beside the list: the Spotlight with
 * one facts line and the action row, the journey while it moves or waits on the server, then the facts beside Lately.
 * `actions` replaces the action row (the list's pane: the one thing to do, and Details); `below` is what follows (the page's
 * body), told whether the facts row is there.
 */
export function GameHead({ g, detail, actions, below }: {
  g: Game; detail: GameDetail | null;
  actions?: (ga: ReturnType<typeof useGameAction>) => ReactNode;
  below?: (low: boolean) => ReactNode;
}) {
  const ga = useGameAction({ game: g });
  const h = useHeadFacts(g, detail)!;
  return (
    <>
      <Spotlight source={{ gameId: g.id }} name={cleanName(g.name)} height={h.journey ? HEAD_WITH_JOURNEY : HEAD} ground={GROUND}
        facts={<Swap k={h.key}>{h.facts}</Swap>} actions={<ActSwap ga={ga}>{actions ? actions(ga) : <ActRow ga={ga} />}</ActSwap>}>
        {h.journey && <div className="gp-journey fx-in"><JourneyLine j={h.j} size="lg" /></div>}
      </Spotlight>
      {h.low && (
        <div className="gp-low fx-in" key={`low-${g.id}`}>
          <FactsTable rows={h.rows} label={`${g.name}: facts`} />
          <Lately items={h.lately} meId={h.meId} />
        </div>
      )}
      {below?.(h.low)}
    </>
  );
}

/** what a library game's head says (GameHead, and a store page whose game was just asked for): its journey, its facts line,
 *  the facts table and Lately. Null for no game. */
function useHeadFacts(g: Game | null, detail: GameDetail | null) {
  const { me } = useSession();
  const L = useLauncher();
  const P = usePcs();
  const hasSaves = useHasSaves(g);
  const inst = g?.file ? L.installedFor(g.id, g.file.id) : undefined;
  const prog = g?.file ? L.installs[g.file.id] : undefined;
  // my play time and last session (every PC): only a game on this PC says them, so my profile is asked for only then
  const { item: profile } = useProfile(inst ? me?.name : undefined);
  if (!g) return null;
  const mine = profile?.games.find(x => x.gameId === g.id) ?? null;
  const j = journeyOf(g, inst, prog);
  const rows = libraryFacts({ g, j, inst, prog, meId: me?.id, lastPlayed: mine?.lastPlayedAt ?? null, pcs: P.statesOf(g.id), saves: hasSaves ? <SavesFact g={g} /> : undefined,
    newer: !!inst && inst.kind !== "rom" && newerCopy(g, inst, L.inLauncher ? refreshesStart : null, L.server),
    platform: (g.platformChoices?.length ?? 0) > 1 && !g.hasFile ? <PlatformFact g={g} /> : undefined });
  const lately = detail?.activity ?? [];
  return {
    j, rows, lately, meId: me?.id,
    // a console dump on the server is ready there but goes no further on a PC: no journey towards Installed
    journey: j.active || (j.stage === "ready" && g.file?.kind !== "rom"),
    low: rows.length > 0 || lately.length > 0,
    facts: factsLine(g, j, me?.id, mine?.playSeconds ?? null),
    /** the facts line cross-fades when the game moves on (asked for, found, downloaded, installed) */
    key: `${j.stage}:${j.label}`,
  };
}

/** a line that cross-fades to its next words (ahoy.css .swap-in): the same `k`, the same line */
const Swap = ({ k, children }: { k: string; children: ReactNode }) => <span key={k} className="swap-in">{children}</span>;

/** the action row, cross-fading when the thing to do changes (Request → Cancel → Install → Play); the focus, when it was there,
 *  stays in its place */
function ActSwap({ ga, children }: { ga: ReturnType<typeof useGameAction>; children: ReactNode }) {
  const m = ga.plan.main;
  const k = m ? `${m.kind}:${m.label}` : "none";
  const box = useSwapFocus<HTMLSpanElement>(k);
  return <span key={k} ref={box} className="act-swap">{children}</span>;
}

/** the facts line of a store game: its release when it is coming ("Nov 9 · in 3 days"), else what players say and when it came out */
function storeLine(a: AppDetail): ReactNode {
  const w = a.releaseIso || a.releaseText ? releaseWords({ iso: a.releaseIso, text: a.releaseText }) : null;
  const blocked = a.crackStatus === "uncracked" || a.crackStatus === "hypervisor";
  if (a.comingSoon) return <>{w ? w.date : "Coming soon"}{w?.rel ? <> · {w.rel.charAt(0).toLowerCase()}{w.rel.slice(1)}</> : null}</>;
  const parts: ReactNode[] = [];
  if (a.reviewSummary) parts.push(<b key="r">{a.reviewSummary}</b>);
  if (w) parts.push(w.date);
  if (!a.reviewSummary && a.genres[0]) parts.push(a.genres[0]);
  if (blocked) parts.push("Not yet");
  return <>{parts.map((p, i) => <span key={i}>{i > 0 && " · "}{p}</span>)}</>;
}

export function SteamPage() {
  const { appId } = useParams();
  // Try again mounts the page afresh (the store's answer is asked again; a failure is never kept)
  const [tries, setTries] = useState(0);
  return <SteamLoad key={`${appId}:${tries}`} id={Number(appId)} retry={() => setTries(n => n + 1)} />;
}

/** a Steam app id as the server takes one: plain digits, above 0 */
const appIdOk = (id: number) => Number.isSafeInteger(id) && id > 0;


/** a store app's page: its game page when the server has it, Steam's answer, or why there is none (Steam does not know it, or
 *  no answer came: Try again) */
function SteamLoad({ id, retry }: { id: number; retry: () => void }) {
  const lib = useLib();
  const { item: a0, error, status } = useApp(id);
  const a = a0 && a0.appId === id ? a0 : null;
  // the store page failed: Steam does not know it (404, or not an app id), or no answer came
  const unknown = error && !a ? status === 404 || status === 400 : null;
  // the game as the library has it now: a kept answer may still name one that has left the server (the page then went to
  // "That game is not on your server", and stayed there until the app was restarted)
  const inLib = gameOfApp(lib, id, a);
  // a store page opened for a game the server has goes to the game's page; a game asked for on this page stays on it, its
  // head turning into the game's in place (it jumped to the game's page and built the head again from nothing, 2026-11-07)
  const shown = useRef(false);
  if (inLib != null && !shown.current) return <Navigate to={`/game/${inLib}`} replace />;
  if (!appIdOk(id) || (error && !a && unknown)) return <Holding><EmptyState title="Steam does not know that one" action={<ButtonLink to="/discover" size={44}>Back to Discover</ButtonLink>} /></Holding>;
  if (error && !a && unknown === false) return <Holding><EmptyState title="Could not load this game" action={<Button size={44} icon="retry" onClick={retry}>Try again</Button>} /></Holding>;
  if (!a) return <Holding><Spinner block label="Loading" /></Holding>;
  shown.current = true;
  return <SteamView a={a} />;
}

function SteamView({ a }: { a: AppDetail }) {
  const lib = useLib();
  const ga = useGameAction({ app: a });
  // the server's game for this app, once it has one (asked for on this page): the same head says the game's state
  const g = (a.gameId != null ? lib.byId.get(a.gameId) : undefined) ?? lib.byApp.get(a.appId) ?? null;
  const { item: d0 } = useGame(g?.id ?? -1);
  const h = useHeadFacts(g, g && d0 && d0.id === g.id ? d0 : null);
  const about = plainText(a.about, 1400).length ? plainText(a.about, 1400) : a.summary ? [a.summary] : [];
  return (
    <div className="gp">
      <Spotlight source={{ appId: a.appId }} name={cleanName(a.name)} height={h?.journey ? HEAD_WITH_JOURNEY : HEAD} ground={GROUND}
        facts={h ? <Swap k={h.key}>{h.facts}</Swap> : <Swap k="store">{storeLine(a)}</Swap>} actions={<ActSwap ga={ga}><ActRow ga={ga} /></ActSwap>}>
        {h?.journey && <div className="gp-journey fx-in"><JourneyLine j={h.j} size="lg" /></div>}
      </Spotlight>
      {h?.low && (
        <div className="gp-low fx-in" key={`low-${g!.id}`}>
          <FactsTable rows={h.rows} label={`${a.name}: facts`} />
          <Lately items={h.lately} meId={h.meId} />
        </div>
      )}
      <div className={`gp-body${h?.low ? "" : " near"}`} key={`body-${a.appId}`}>
        <MediaSection trailers={a.trailers} shots={a.screenshots} />
        <AboutSection paras={about} facts={storeFacts({ app: a })} />
        <SimilarShelf appId={a.appId} />
      </div>
    </div>
  );
}

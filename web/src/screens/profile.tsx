/**
 * Ahoy — a profile (/u/:name). Board: the right half of M/lfs/friends-roster/Friends-Roster.dc.html, as a whole page:
 * the board's two 432 px halves become the page's two halves (9 columns each, 660 at 1440).
 *  - Left: the person (96 px avatar beside the name, presence, "@name · joined <date> · N games installed · <time> played",
 *    the about line, the friend button or Edit profile on your own), then Played lately (when · how long; the live session
 *    counts, it is now) and Has installed ("On your PCs" on your own; your state as each card's line, your action on hover).
 *  - Right: while they play, the now card (that game's key art, its name, your state, your action), as tall as the left
 *    block; then Friends and Lately (their feed). Nobody playing: Friends and Lately start at the top.
 *  - When both halves start on one line and their second headings would land less than 48 px apart, they share a line.
 */
import { useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { fmtPlay, timeAgo, type ActivityItem, type FriendState, type Person, type Presence, type Profile, type UserRef } from "../api";
import { act, useLib, usePeople, useProfile } from "../data";
import { useLauncher } from "../launcher-state";
import { useSession } from "../session";
import { art } from "../ui/art";
import { Avatar } from "../ui/avatar";
import { Button, ButtonLink } from "../ui/button";
import { ChartList, ChartRow } from "../ui/chart";
import { EmptyState, Spinner } from "../ui/controls";
import { useUi } from "../ui/kit";
import { FEED_VERB, FriendButton, presenceWords } from "../ui/people";
import { PosterArt, PosterCard } from "../ui/poster";
import { SectionHead } from "../ui/section";
import { GameAction } from "../ui/game-action";
import { stateLine } from "../ui/status";
import { KeyArt, MineButton, PresenceText, joinedWords, useFriendGame, useMine } from "./friends-bits";
import "./profile.css";

export function ProfilePage() {
  const { name } = useParams();
  const { item: p, error, reload } = useProfile(name);
  const { items: people } = usePeople();
  const { me } = useSession();
  if (!p) {
    if (!error) return <div className="pf pf-state"><Spinner block label="Loading" /></div>;
    const gone = /no such person/i.test(error);
    return (
      <div className="pf pf-state">
        <EmptyState title={gone ? "No one by that name" : "The server did not answer"}
          action={gone ? <ButtonLink to="/people" size={44}>Back to Friends</ButtonLink> : <Button size={44} icon="retry" onClick={reload}>Try again</Button>} />
      </div>
    );
  }
  return <ProfileView key={p.user.id} p={p} people={people} meId={me?.id ?? null} reload={reload} />;
}

type Played = { key: string; gameId: number | null; appId: number | null; name: string; sec: number; at: number | null; live: boolean };
type FriendRowData = { u: UserRef; presence: Presence | null; you: boolean };
const RANK: Record<Presence["state"], number> = { playing: 0, online: 1, offline: 2 };
const gameKey = (x: { gameId: number | null; appId: number | null; name: string }) => (x.gameId != null ? `g${x.gameId}` : x.appId != null ? `a${x.appId}` : `n${x.name}`);
const gameTo = (x: { gameId: number | null; appId: number | null; name: string }) => (x.gameId != null ? `/game/${x.gameId}` : x.appId != null ? `/steam/${x.appId}` : `/search?q=${encodeURIComponent(x.name)}`);
/** a game's poster for a slot `w` px wide (the server sends a copy twice that wide) */
const posterOf = (x: { gameId: number | null; appId: number | null; name: string }, w: number) => (x.gameId != null ? art.poster(x.gameId, w * 2) : x.appId != null ? art.steam(x.appId, x.name, w * 2) : null);

function ProfileView({ p, people, meId, reload }: { p: Profile; people: Person[] | null; meId: number | null; reload: () => void }) {
  const mine = meId === p.user.id;
  const pr = p.presence;
  const playing = pr.state === "playing" && (pr.gameId != null || pr.appId != null || !!pr.gameName);

  // Played lately: the games with a last play; the live session first, its time added to that game's
  const liveSec = playing && pr.since ? Math.max(0, Math.floor(Date.now() / 1000 - pr.since)) : 0;
  const liveKey = playing ? gameKey({ gameId: pr.gameId, appId: pr.appId, name: pr.gameName ?? "" }) : null;
  const played: Played[] = [];
  let live: Played | null = null;
  for (const g of p.games) {
    const key = gameKey(g);
    if (key === liveKey) live = { key, gameId: g.gameId, appId: g.appId, name: g.name, sec: g.playSeconds + liveSec, at: null, live: true };
    else if (g.lastPlayedAt) played.push({ key, gameId: g.gameId, appId: g.appId, name: g.name, sec: g.playSeconds, at: g.lastPlayedAt, live: false });
  }
  if (playing && !live && pr.gameName) live = { key: liveKey!, gameId: pr.gameId, appId: pr.appId, name: pr.gameName, sec: liveSec, at: null, live: true };
  played.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const rows = [...(live ? [live] : []), ...played].slice(0, 4);
  const total = p.games.reduce((s, g) => s + g.playSeconds, 0) + liveSec;

  // Friends, with their presence (the people list has it): you first, then playing, online, the rest; by name
  const byId = new Map((people ?? []).map(x => [x.id, x]));
  const friends: FriendRowData[] = p.friends
    .map(u => ({ u, presence: byId.get(u.id)?.presence ?? null, you: u.id === meId }))
    .sort((a, b) => Number(b.you) - Number(a.you) || RANK[a.presence?.state ?? "offline"] - RANK[b.presence?.state ?? "offline"] || a.u.displayName.localeCompare(b.u.displayName));
  const faces = new Map<string, UserRef>([...(people ?? []).map(x => [x.name, x] as const), ...p.friends.map(u => [u.name, u] as const)]);
  // their games: the one they are playing first, then the last played, then by name
  const cards = [...p.games].sort((a, b) => Number(gameKey(b) === liveKey) - Number(gameKey(a) === liveKey) || (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) || a.name.localeCompare(b.name)).slice(0, 24);
  const feed = p.activity;

  const facts = [`@${p.user.name}`, `joined ${joinedWords(p.joinedAt)}`];
  if (p.games.length) facts.push(`${p.games.length} game${p.games.length === 1 ? "" : "s"} installed`);
  if (total) facts.push(`${fmtPlay(total)} played`);

  // the second headings share a line when both halves start together and would land less than 48 px apart
  const playedH = rows.length ? 48 + rows.length * 60 + (rows.length - 1) * 8 : 0;
  const friendsH = friends.length ? 48 + friends.length * 40 + (friends.length - 1) * 8 : 0;
  const pair = playing && !!playedH && cards.length > 0 && !!friendsH && feed.length > 0 && Math.abs(playedH - friendsH) < 48;
  const lift = (extra: number): CSSProperties | undefined => (pair && extra > 0 ? ({ ["--pf-pair" as string]: `${extra}px` }) : undefined);

  const head = (
    <section className="pf-who" aria-labelledby="pf-name">
      <div className="pf-id">
        <Avatar u={p.user} size={96} />
        <h1 id="pf-name" className="pf-name"><span>{p.user.displayName}</span>{p.user.role === "admin" && <>{" "}<span className="tag">runs this server</span></>}</h1>
      </div>
      <p className="pf-presence"><PresenceLine pr={pr} /></p>
      <p className="pf-facts">{facts.join(" · ")}</p>
      {p.bio?.trim() && <p className="pf-about">{p.bio}</p>}
      <div className="pf-acts">{mine ? <ButtonLink to="/settings" size={48}>Edit profile</ButtonLink> : <FriendActions id={p.user.id} name={p.user.displayName} state={p.friend} onChange={reload} />}</div>
    </section>
  );
  const playedSec = rows.length > 0 && (
    <section className="pf-sec" aria-labelledby="pf-played-h">
      <SectionHead id="pf-played-h" title="Played lately" />
      <ChartList>
        {rows.map(r => {
          const line = `${r.live ? "Playing now" : timeAgo(r.at)}${r.sec ? ` · ${fmtPlay(r.sec)}` : ""}`;
          return <ChartRow key={r.key} art={posterOf(r, 40)} title={r.name} to={gameTo(r)} line={line} label={`${r.name}, ${line}`} />;
        })}
      </ChartList>
    </section>
  );
  const haveSec = cards.length > 0 && (
    <section className="pf-sec pf-second" aria-labelledby="pf-have-h" style={lift(friendsH - playedH)}>
      <SectionHead id="pf-have-h" title={mine ? "On your PCs" : "Has installed"} count={p.games.length} />
      <ul className="pf-wall">{cards.map(g => <li key={gameKey(g)}><InstalledCard g={g} mine={mine} meId={meId} /></li>)}</ul>
    </section>
  );
  const friendsSec = friends.length > 0 && (
    <section className="pf-sec" aria-labelledby="pf-friends-h">
      <SectionHead id="pf-friends-h" title="Friends" count={friends.length} />
      <ul className="pf-list">{friends.map(f => <FriendRow key={f.u.id} f={f} />)}</ul>
    </section>
  );
  const feedSec = feed.length > 0 && (
    <section className="pf-sec pf-second" aria-labelledby="pf-lately-h" style={lift(playedH - friendsH)}>
      <SectionHead id="pf-lately-h" title="Lately" />
      <ol className="pf-list">{feed.map(a => <FeedRow key={a.id} a={a} meId={meId} faces={faces} />)}</ol>
    </section>
  );
  const nothing = !rows.length && !cards.length && !friends.length && !feed.length;
  const left = <div className="pf-col">{playedSec}{haveSec}</div>;
  const right = <div className="pf-col">{friendsSec}{feedSec}</div>;

  return (
    <div className="pf">
      {playing ? (
        <>
          <div className="pf-row pf-top">{head}<NowCard who={p.user} pr={pr} mine={mine} /></div>
          {!nothing && <div className="pf-row">{left}{right}</div>}
        </>
      ) : (
        <div className="pf-row">
          <div className="pf-col pf-first">{head}{playedSec}{haveSec}{nothing && <p className="pf-none">{mine ? "Nothing here yet" : `${p.user.displayName} has not played anything yet`}</p>}</div>
          {right}
        </div>
      )}
    </div>
  );
}

/** "• Playing Balatro · 40 min" with the game opening its page, "• Online", "Seen 2 h ago" */
function PresenceLine({ pr }: { pr: Presence }) {
  const fg = useFriendGame(pr);
  if (pr.state !== "playing" || !fg.to) return <PresenceText pr={pr} />;
  const how = presenceWords(pr).how;   // the same words as PresenceText, the game opening its page
  return <><i className="fr-pdot" aria-hidden />Playing <Link to={fg.to} className="pf-game">{fg.name}</Link>{how ? ` · ${how}` : ""}</>;
}

/** where you stand with them: today's FriendButton at 48, except Add friend, which leads here (the board's white pill) */
function FriendActions({ id, name, state, onChange }: { id: number; name: string; state: FriendState; onChange: () => void }) {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  if (state !== "none") return <FriendButton id={id} state={state} name={name} onChange={onChange} size={48} />;
  const ask = async () => {
    setBusy(true);
    try { await act.befriend(id); toast("Asked", "success"); onChange(); } catch (e: any) { toast(String(e?.message ?? e), "danger"); } finally { setBusy(false); }
  };
  return <Button kind="primary" size={48} icon="plus" busy={busy} aria-label={`Add ${name} as a friend`} onClick={() => void ask()}>Add friend</Button>;
}

/** what they are playing: the game's key art, its name, your state, your action; the card opens the game */
function NowCard({ who, pr, mine: own }: { who: UserRef; pr: Presence; mine: boolean }) {
  const fg = useFriendGame(pr);
  const mine = useMine(fg.game, fg.appId);
  const { me } = useSession();
  const status = stateLine(mine.game ?? fg.game, mine.inst, mine.prog, me?.id);
  const title = <><span className="pf-now-title">{fg.name}</span>{status && <span className="pf-now-line">{status}</span>}</>;
  return (
    <section className="pf-now" aria-label={`${own ? "You are" : `${who.displayName} is`} playing ${fg.name}`}>
      <span className="pf-now-art" aria-hidden><KeyArt key={`${fg.game?.id ?? "a"}-${fg.appId ?? ""}`} game={fg.game} appId={fg.appId} name={fg.name} /></span>
      {fg.to ? <Link to={fg.to} className="pf-now-link" aria-label={status ? `${fg.name} — ${status}` : fg.name}>{title}</Link> : <div className="pf-now-link">{title}</div>}
      <div className="pf-now-act"><MineButton mine={mine} size={44} name={fg.name} /></div>
    </section>
  );
}

/** a small shelf card: poster, name, your state (or, on your own, where it is), your action on hover */
function InstalledCard({ g, mine, meId }: { g: Profile["games"][number]; mine: boolean; meId: number | null }) {
  const lib = useLib();
  const L = useLauncher();
  const game = (g.gameId != null ? lib.byId.get(g.gameId) : undefined) ?? (g.appId != null ? lib.byApp.get(g.appId) : undefined);
  const inst = game?.file ? L.installedFor(game.id, game.file.id) : undefined;
  const prog = game?.file ? L.installs[game.file.id] : undefined;
  // the line waits for the library (its slot is kept), so a card never says "On JONAS-PC" for a moment before "On this PC"
  const line = !lib.loaded ? "" : mine && !inst && !prog && g.devices.length ? `On ${g.devices.join(", ")}` : stateLine(game, inst, prog, meId) || (g.devices.length ? `On ${g.devices.join(", ")}` : "");
  const ref = { gameId: game?.id ?? g.gameId, appId: game?.steamAppId ?? g.appId, name: g.name };
  return <PosterCard size={128} art={posterOf(ref, 128)} title={g.name} to={gameTo(ref)} line={line} label={line ? `${g.name} — ${line}` : g.name}
    action={game ? <GameAction game={game} variant="pill" label={g.name} /> : undefined} />;
}

/** a friend: the 40 px lead and 16 px gap the other rows use, so the text columns line up */
function FriendRow({ f }: { f: FriendRowData }) {
  return (
    <li className="pf-friend">
      <Link to={`/u/${f.u.name}`} className="pf-link" aria-label={f.you ? `${f.u.displayName} (you)` : f.u.displayName}>
        <Avatar u={f.u} size={40} />
        <span className="pf-two"><span className="pf-two-a">{f.u.displayName}</span><span className="pf-two-b">{f.you ? "You" : f.presence ? <PresenceText pr={f.presence} /> : null}</span></span>
      </Link>
    </li>
  );
}

/** one of their feed lines: the game's poster (or a face), the sentence, when; the line opens what it is about */
function FeedRow({ a, meId, faces }: { a: ActivityItem; meId: number | null; faces: Map<string, UserRef> }) {
  const you = meId != null && a.user.id === meId;
  const verb = you && a.kind === "tracked" ? "are tracking" : FEED_VERB[a.kind];
  const other = a.kind === "friends" && a.data?.userName ? String(a.data.userName) : null;
  const isGame = a.kind !== "friends" && a.kind !== "joined" && (a.gameId != null || a.appId != null);
  const href = isGame ? gameTo({ gameId: a.gameId, appId: a.appId, name: a.name ?? "" }) : other ? `/u/${other}` : `/u/${a.user.name}`;
  const face: UserRef | { displayName: string | null; name: string } = other ? faces.get(other) ?? { displayName: a.name, name: other } : a.user;
  const secs = a.kind === "played" && typeof a.data?.playSeconds === "number" ? a.data.playSeconds : 0;
  const device = a.kind === "installed" && a.data?.device ? String(a.data.device) : null;
  const when = `${timeAgo(a.at)}${secs > 0 ? ` · ${fmtPlay(secs)}` : ""}`;
  const who = you ? "You" : a.user.displayName;
  const object = a.kind === "joined" ? null : a.name;
  return (
    <li className="pf-feed">
      <Link to={href} className="pf-link" aria-label={`${who} ${verb}${object ? ` ${object}` : ""}${device ? ` on ${device}` : ""}, ${when}`}>
        {isGame ? <PosterArt src={posterOf({ gameId: a.gameId, appId: a.appId, name: a.name ?? "" }, 40)} title={a.name ?? ""} w={40} h={60} r={8} /> : <span className="pf-lead"><Avatar u={face} size={40} /></span>}
        <span className="pf-two">
          <span className="pf-two-a"><b>{who}</b> {verb}{object ? <> <b>{object}</b></> : null}{device ? ` on ${device}` : null}</span>
          <span className="pf-two-b">{when}</span>
        </span>
      </Link>
    </li>
  );
}

/**
 * Ahoy — Friends (/people; the nav calls it Friends). Board: M/lfs/friends-now/Friends-Now.dc.html.
 *  - Who is on: one tile per friend online or playing, playing first. A playing tile carries that game's key art, the
 *    friend, "<game> · <how long>" and your action for the game on this PC; a friend who is only online gets a quiet tile.
 *    Tiles sit on the page's 18 columns, row by row: a quiet tile takes 4, playing tiles share the rest and never go under
 *    7 (more on a narrow window, so the name, the line and the button always fit); a tile that does not fit starts the
 *    next row. A row with someone playing is 384 tall, a row of quiet tiles a compact 96.
 *  - Left: Find someone (it narrows every group; while it does, friends who are on are listed too), then Want to be
 *    friends, Friends who are not on, and Everyone, each person with today's friend button.
 *  - Right: Lately, Friends | Everyone.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fmtPlay, timeAgo, type ActivityItem, type Person } from "../api";
import { useActivity, usePeople } from "../data";
import { useSession } from "../session";
import { art } from "../ui/art";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Chips, Spinner, TextField } from "../ui/controls";
import { FEED_VERB, FriendButton, presenceWords } from "../ui/people";
import { PosterArt } from "../ui/poster";
import { SectionHead, SubHead } from "../ui/section";
import { KeyArt, MineButton, PresenceText, isOn, isPlaying, useFriendGame, useMine } from "./friends-bits";
import "./friends.css";

const byName = (a: Person, b: Person) => a.displayName.localeCompare(b.displayName);

export function PeoplePage() {
  const { items, error, reload } = usePeople();
  const { me } = useSession();
  const [q, setQ] = useState("");
  // after a friend change: this list at once (the server's "friend" event refreshes it, the bell and the menu anyway)
  const refresh = () => { void reload(); };

  const everyone = items ?? [];
  const others = everyone.filter(p => p.id !== me?.id);
  const on = others.filter(p => p.friend === "friends" && isOn(p.presence))
    .sort((a, b) => Number(isPlaying(b.presence)) - Number(isPlaying(a.presence)) || byName(a, b));
  const t = q.trim().toLowerCase();
  const hit = (p: Person) => !t || p.name.toLowerCase().includes(t) || p.displayName.toLowerCase().includes(t);
  const groups = [
    { id: "want", title: "Want to be friends", list: others.filter(p => p.friend === "pending_in") },
    { id: "friends", title: "Friends", list: others.filter(p => p.friend === "friends" && (t !== "" || !isOn(p.presence))) },
    { id: "everyone", title: "Everyone", list: others.filter(p => p.friend === "pending_out" || p.friend === "none") },
  ].map(g => ({ ...g, list: g.list.filter(hit).sort((a, b) => Number(isOn(b.presence)) - Number(isOn(a.presence)) || byName(a, b)) }))
    .filter(g => g.list.length > 0);

  return (
    <div className="fr">
      <h1 className="sr-only">Friends</h1>
      {on.length > 0 && <WhoIsOn list={on} />}
      <div className="fr-cols">
        <section className="fr-people" aria-labelledby="fr-people-h">
          <h2 id="fr-people-h" className="sr-only">People</h2>
          <TextField icon="search" type="search" className="fr-find" placeholder="Find someone" aria-label="Find someone" value={q}
            onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === "Escape") setQ(""); }} />
          {!items
            ? <div className="fr-wait">{error ? <><p className="fr-none">The server did not answer</p><Button size={36} icon="retry" onClick={() => void reload()}>Try again</Button></> : <Spinner label="Loading people" />}</div>
            : groups.map(g => (
              <div key={g.id} className="fr-group">
                <SubHead id={`fr-g-${g.id}`} title={g.title} />
                <ul className="fr-list" aria-labelledby={`fr-g-${g.id}`}>{g.list.map(p => <PersonRow key={p.id} p={p} onChange={refresh} />)}</ul>
              </div>
            ))}
          {items && !groups.length && (t || !others.length) && <p className="fr-none fr-gap">{t ? "Nobody by that name" : "Nobody else is here yet"}</p>}
        </section>
        <Lately people={everyone} />
      </div>
    </div>
  );
}

/* ─────────── who is on ─────────── */

interface Tile { p: Person; playing: boolean; cols: number }
interface TileRow { tiles: Tile[]; tall: boolean }
const COLS = 18, GUT = 24;
/** the narrowest a playing tile may be (avatar, name over "<game> · since 9 pm", a labelled button) and a quiet one */
const MIN_PLAYING = 420, MIN_QUIET = 200;

/** the board's packing, on a measured width: rows of 18 columns filled in order; quiet tiles keep their columns, playing tiles share the rest */
function packTiles(list: Person[], width: number): TileRow[] {
  const pitch = Math.max(1, (width - (COLS - 1) * GUT) / COLS) + GUT;
  const need = (playing: boolean) => Math.min(COLS, Math.max(playing ? 7 : 4, Math.ceil(((playing ? MIN_PLAYING : MIN_QUIET) + GUT) / pitch)));
  const rows: Tile[][] = [];
  let cur: Tile[] = [];
  for (const p of list) {
    const t: Tile = { p, playing: isPlaying(p.presence), cols: 0 };
    if (cur.length && cur.reduce((a, x) => a + need(x.playing), 0) + need(t.playing) > COLS) { rows.push(cur); cur = []; }
    cur.push(t);
  }
  if (cur.length) rows.push(cur);
  return rows.map(tiles => {
    const play = tiles.filter(t => t.playing);
    for (const t of tiles) if (!t.playing) t.cols = need(false);
    const share = COLS - tiles.filter(t => !t.playing).reduce((a, t) => a + t.cols, 0);
    const each = play.length ? Math.floor(share / play.length) : 0, extra = play.length ? share - each * play.length : 0;
    play.forEach((t, i) => { t.cols = each + (i < extra ? 1 : 0); });
    return { tiles, tall: play.length > 0 };
  });
}

function WhoIsOn({ list }: { list: Person[] }) {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rows = packTiles(list, width ?? 1344);
  return (
    <section ref={ref} className="fr-on" aria-label="Friends online">
      {rows.map((r, i) => (
        <ul key={i} className={`fr-tiles${r.tall ? "" : " compact"}`}>
          {r.tiles.map(t => (
            <li key={t.p.id} className={`fr-tile ${t.playing ? "is-playing" : "is-quiet"}`} style={{ gridColumn: `span ${t.cols}` }}>
              {t.playing ? <PlayingTile p={t.p} /> : <QuietTile p={t.p} compact={!r.tall} />}
            </li>
          ))}
        </ul>
      ))}
    </section>
  );
}

/** three targets, none nested: the art opens the game, the avatar and name open the friend, the button acts on this PC */
function PlayingTile({ p }: { p: Person }) {
  const fg = useFriendGame(p.presence);
  const mine = useMine(fg.game, fg.appId);
  const how = presenceWords(p.presence).how;   // "40 min" under an hour, else "since 9 pm"
  const spoken = `${p.displayName}, playing ${fg.name}${how ? `, ${how}` : ""}`;
  const artBody = <KeyArt key={`${fg.game?.id ?? "a"}-${fg.appId ?? ""}`} game={fg.game} appId={fg.appId} name={fg.name} />;
  return (
    <>
      {fg.to ? <Link to={fg.to} className="fr-tile-art" aria-label={fg.name}>{artBody}</Link> : <span className="fr-tile-art" aria-hidden>{artBody}</span>}
      <div className="fr-tile-foot">
        <Link to={`/u/${p.name}`} className="fr-tile-who" aria-label={spoken}>
          <Avatar u={p} size={48} dot />
          <span className="fr-tile-tx"><span className="fr-tile-name">{p.displayName}</span><span className="fr-tile-line"><b>{fg.name}</b>{how ? ` · ${how}` : ""}</span></span>
        </Link>
        <MineButton mine={mine} name={fg.name} />
      </div>
    </>
  );
}

/** a friend who is online but not playing: no art, their avatar large and neutral, the name and Online on the tiles' line */
function QuietTile({ p, compact }: { p: Person; compact: boolean }) {
  return (
    <Link to={`/u/${p.name}`} className={`fr-quiet${compact ? " compact" : ""}`} aria-label={`${p.displayName}, online`}>
      {compact ? <Avatar u={p} size={48} /> : <span className="fr-quiet-face"><Avatar u={p} size={96} /></span>}
      <span className="fr-tile-tx"><span className="fr-tile-name">{p.displayName}</span><span className="fr-tile-line"><PresenceText pr={p.presence} /></span></span>
    </Link>
  );
}

/* ─────────── people ─────────── */

/** avatar, the name over the presence line (20 + 4 + 20), then the friend button; hover lights a surface 8 px around it */
function PersonRow({ p, onChange }: { p: Person; onChange: () => void }) {
  return (
    <li className="fr-row">
      <Link to={`/u/${p.name}`} className="fr-row-who">
        <Avatar u={p} size={44} dot={isOn(p.presence)} />
        <span className="fr-row-tx"><span className="fr-row-name">{p.displayName}</span><span className="fr-row-line"><PresenceText pr={p.presence} dot={false} /></span></span>
      </Link>
      <FriendButton id={p.id} state={p.friend} name={p.displayName} onChange={onChange} size={p.friend === "pending_in" ? 44 : 36} />
    </li>
  );
}

/* ─────────── Lately ─────────── */

function Lately({ people }: { people: Person[] }) {
  const [only, setOnly] = useState<"friends" | "all">("friends");
  const { items, error, reload } = useActivity(only, 60);
  const byHandle = new Map(people.map(p => [p.name, p]));
  return (
    <section className="fr-lately" aria-labelledby="fr-lately-h">
      <SectionHead id="fr-lately-h" title="Lately" className="fr-lately-head"
        right={<Chips label="Whose activity" value={only} onChange={setOnly} controls="fr-lately-list" items={[{ id: "friends", label: "Friends" }, { id: "all", label: "Everyone" }]} />} />
      {!items
        ? <div className="fr-wait">{error ? <><p className="fr-none">The server did not answer</p><Button size={36} icon="retry" onClick={() => void reload()}>Try again</Button></> : <Spinner label="Loading" />}</div>
        : items.length
          ? <ol id="fr-lately-list" className="fr-feed">{items.map(a => <FeedRow key={a.id} a={a} people={byHandle} />)}</ol>
          : <p id="fr-lately-list" className="fr-none fr-gap">Nothing has happened yet</p>}
    </section>
  );
}

/**
 * One line of the feed, 64 tall: the person's avatar opens them; the slot after it opens what the line is about (the
 * game's poster, or for two people becoming friends the other one); the sentence in the product's verbs with the names
 * and games bright; when, on the column's edge (and for how long, for a game played).
 */
function FeedRow({ a, people }: { a: ActivityItem; people: Map<string, Person> }) {
  const { me } = useSession();
  const you = !!me && a.user.id === me.id;
  const verb = you && a.kind === "tracked" ? "are tracking" : FEED_VERB[a.kind];
  const otherHandle = a.kind === "friends" && a.data?.userName ? String(a.data.userName) : null;
  const other = otherHandle ? people.get(otherHandle) : undefined;
  const gameTo = a.gameId != null ? `/game/${a.gameId}` : a.appId != null ? `/steam/${a.appId}` : null;
  const poster = a.gameId != null ? art.poster(a.gameId, 96) : a.appId != null ? art.steam(a.appId, a.name ?? undefined, 96) : null;
  const secs = a.kind === "played" && typeof a.data?.playSeconds === "number" ? a.data.playSeconds : 0;
  const object = a.kind === "joined" ? null : a.name;
  const device = a.kind === "installed" && a.data?.device ? String(a.data.device) : null;
  return (
    <li className="fr-feed-row">
      <Link to={`/u/${a.user.name}`} className="fr-feed-av" aria-label={you ? "You" : a.user.displayName}><Avatar u={a.user} size={40} /></Link>
      {gameTo && poster && a.kind !== "friends"
        ? <Link to={gameTo} className="fr-feed-slot" aria-label={a.name ?? ""}><PosterArt src={poster} title={a.name ?? ""} w={40} h={64} r={8} /></Link>
        : otherHandle
          ? <Link to={`/u/${otherHandle}`} className="fr-feed-slot face" aria-label={a.name ?? otherHandle}><Avatar u={other ?? { displayName: a.name, name: otherHandle }} size={40} /></Link>
          : <span className="fr-feed-slot" aria-hidden />}
      <p className="fr-feed-tx"><b>{you ? "You" : a.user.displayName}</b> {verb}{object ? <> <b>{object}</b></> : null}{device ? ` on ${device}` : null}</p>
      <span className="fr-feed-when">{timeAgo(a.at)}{secs > 0 ? ` · ${fmtPlay(secs)}` : ""}</span>
    </li>
  );
}

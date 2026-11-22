/**
 * Dev only: /__gallery — every shared component in its states, with sample data shaped like the boards' (gallery-data.ts).
 * The first three frames are board-sized (1440 wide) so a screenshot lines up with M/canvas-r/Main.png, Discover.png and
 * Library-Wall.png; the sections after them show each component's states. Rendered outside the sign-in gate: no server needed.
 * Art: /__gallery?art=http://localhost:8894/ (a static server over the boards' art), else the server's art endpoints.
 */
import type { ReactNode } from "react";
import type { Game } from "../api";
import { journeyOf } from "../model";
import { BarFrame, NavTabs, SearchPill } from "../shell/bar";
import { BellButton, SocialPanelView } from "../shell/social";
import { AccountButton, AccountMenuItems } from "../shell/menu";
import { RequestButtonView, RequestRow } from "../shell/request";
import { TransferPill, type Transfer } from "../shell/transfer";
import { Avatar } from "./avatar";
import { Button, ButtonLink, IconButton } from "./button";
import { ReleaseCalendar } from "./calendar";
import { ChartList, ChartRow } from "./chart";
import { Chip, Chips, EmptyState, Pill, Select, Spinner, TextField, Toggle } from "./controls";
import { ActionPill, ActionView, planAction, type ActionApp, type ActionPlan } from "./game-action";
import { JourneyLine } from "./journey";
import { UiProvider } from "./kit";
import { PosterArt, PosterCard, StatusLine, type PosterSize } from "./poster";
import { GroupLabel, SectionHead, SubHead } from "./section";
import { Spotlight } from "./spotlight";
import { A, COMING, FEED, G, HIGHEST, META_DS3, META_HOLLOW, META_ROGER, NEW_TRENDING, PEOPLE, TOP_SELLERS, U, cap, installed, installing } from "./gallery-data";
import "./gallery.css";

const noop = () => {};
const TODAY = "2026-11-06";
const plan = (game: Game | null, opt: { inst?: boolean; prog?: number; running?: boolean } = {}): ActionPlan =>
  planAction({ game, inst: game && opt.inst ? installed(game) : undefined, prog: game && opt.prog != null ? installing(game, opt.prog) : undefined, running: opt.running, meId: U.k.id });
const app = (appId: number, x: Partial<ActionApp> = {}): ActionApp => ({ appId, gameId: null, comingSoon: false, crackStatus: "cracked", drm: null, ...x });
const appPlan = (a: ActionApp) => planAction({ app: a });
const TRANSFER: Transfer = { label: "Downloading", name: "Endacopia", progress: 0.48, gameId: 26, count: 2 };

/** the bar as the boards draw it, with sample data */
function Bar({ path, over = true, solid }: { path: string; over?: boolean; solid?: boolean }) {
  return (
    <BarFrame over={over} solid={solid}
      left={<>{!["/", "/discover", "/library", "/people"].includes(path) && <IconButton icon="chevronLeft" label="Back" className="tb-back" />}<NavTabs path={path} /><SearchPill value="" onChange={noop} onSubmit={noop} /></>}
      right={<><BellButton dot /><TransferPill t={TRANSFER} /><RequestButtonView /><AccountButton u={U.k} /></>} />
  );
}

function Sec({ id, title, board, children }: { id: string; title: string; board?: string; children: ReactNode }) {
  return <section className="gx-sec" id={id}><SectionHead title={title} />{board && <p className="gx-board">{board}</p>}{children}</section>;
}
const Cell = ({ label, children }: { label: string; children: ReactNode }) => <div className="gx-cell">{children}<small>{label}</small></div>;

/** ?only=<id> draws one part alone (home, discover, library, tokens, avatar, buttons, heads, chips, posters, status, actions, journey, spotlight, calendar, charts, controls, panels, empty) */
const ONLY = new URLSearchParams(location.search).get("only");
const FRAMES: [string, () => JSX.Element][] = [["home", FrameHome], ["discover", FrameDiscover], ["library", FrameLibrary]];
const SECTIONS: [string, () => JSX.Element][] = [
  ["tokens", Tokens], ["avatar", Avatars], ["buttons", Buttons], ["heads", Heads], ["chips", ChipsAndSelect], ["posters", Posters], ["status", StatusLines],
  ["actions", Actions], ["journey", Journeys], ["spotlight", Spotlights], ["calendar", Calendar], ["charts", Charts], ["controls", Controls], ["panels", Panels], ["empty", Empties],
];

export default function Gallery() {
  const frames = FRAMES.filter(([id]) => !ONLY || ONLY === id);
  const sections = SECTIONS.filter(([id]) => !ONLY || ONLY === id);
  return (
    <UiProvider>
      <div className="gx">
        {frames.map(([id, F]) => <F key={id} />)}
        {sections.length > 0 && <div className="gx-body" style={ONLY ? { paddingTop: 48 } : undefined}>{sections.map(([id, S]) => <S key={id} />)}</div>}
      </div>
    </UiProvider>
  );
}

function Empties() {
  return (
    <Sec id="empty" title="EmptyState and Spinner" board="ui/controls.tsx">
      <div className="gx-grid">
        <EmptyState title="Nothing on your server yet" action={<ButtonLink to="/discover" kind="primary" size={44}>Open Discover</ButtonLink>} />
        <EmptyState title="Nobody by that name" icon="search" />
        <Cell label="Spinner"><Spinner /></Cell>
        <Cell label="Spinner block"><Spinner block label="Searching" /></Cell>
      </div>
    </Sec>
  );
}

/* ─────────── board frames ─────────── */

function FrameHome() {
  return (
    <div className="gx-frame" style={{ height: 960 }}>
      <Bar path="/" />
      <Spotlight under={false} art={A("banner-31.jpg")} anchorX={0.55} artHeight={880} fadeFrom={460} fadeTo={880} height={960} titleBottom={380} factsGap={24}
        name="DARK SOULS III" logo={A("logo-31.png")} meta={META_DS3} logoArea={531 * 56}
        facts="Arrived last night · 20 GB"
        actions={<><ActionView plan={plan(G.ds3)} variant="button" /><ButtonLink to="/game/31" size={48}>Details</ButtonLink></>} />
      <span className="gx-frame-tag">M/canvas-r/Main.png (top bar + spotlight)</span>
    </div>
  );
}

function FrameDiscover() {
  return (
    <div className="gx-frame" style={{ height: 1012 }}>
      <Bar path="/discover" />
      <Spotlight under={false} art={A("hero-5160800.jpg")} name="Find The Needle"
        facts={<>Nov 6 · today · <b>Pell</b> tracks it</>}
        actions={<><ActionView plan={appPlan(app(5160800, { comingSoon: true }))} variant="button" /><ButtonLink to="/steam/5160800" size={48}>Details</ButtonLink></>} />
      <section className="gx-shelf">
        <SectionHead title="New & trending" all="/discover/list/new" allLabel="All new and trending games" />
        <div className="gx-row">
          {NEW_TRENDING.map((i, n) => <PosterCard key={i.appId} size={204} art={A(cap(i.appId))} title={i.name} line={i.line} to={`/steam/${i.appId}`} actionShown={n === 0}
            action={<ActionView plan={appPlan(app(i.appId))} variant="pill" />} />)}
        </div>
      </section>
      <span className="gx-frame-tag">M/canvas-r/Discover.png (0–1012)</span>
    </div>
  );
}

function FrameLibrary() {
  const here = [
    { g: G.konbini, line: "4.2 h played" }, { g: G.gunn, line: "2.1 h played" }, { g: G.outer, line: "9.3 h played" }, { g: G.hollow, line: "41 h played" },
    { g: G.balatro, line: <StatusLine avatar={U.jonas}><b>Jonas</b> is playing</StatusLine> },
  ];
  const jE = journeyOf(G.endacopia), jN = journeyOf(G.nightreign);
  const coming = [
    { name: "Find The Needle", appId: 5160800, iso: "2026-11-06", line: <StatusLine avatar={U.pell}><b>Pell</b> tracks it</StatusLine>, plan: appPlan(app(5160800, { comingSoon: true })) },
    { name: "DREADMOOR", appId: 3629430, iso: "2026-11-09", line: <StatusLine avatar={U.jonas}><b>Jonas</b> tracks it</StatusLine>, plan: appPlan(app(3629430, { comingSoon: true })) },
    { name: "Worst Class Ever", appId: 5175310, iso: "2026-11-09", line: <StatusLine check bright>Tracked</StatusLine>, plan: plan(G.worst) },
  ];
  return (
    <div className="gx-frame" style={{ height: 1560 }}>
      <Bar path="/library" over={false} />
      <div className="gx-controls">
        <Chips label="Shelves" value="all" onChange={noop} items={[{ id: "all", label: "All", count: 25 }, { id: "here", label: "On this PC", count: 5 }, { id: "ready", label: "Ready to install", count: 15 }, { id: "way", label: "On the way", count: 2 }, { id: "soon", label: "Coming", count: 3 }]} />
        <Select label="Sort" icon="sort" value="added" onChange={noop} options={[{ value: "added", label: "Recently added" }, { value: "name", label: "Name" }, { value: "played", label: "Last played" }]} />
      </div>
      <section className="gx-lib" style={{ top: 260 }}>
        <h2 className="gx-rail">On this PC</h2>
        <div className="gx-wall">{here.map(({ g, line }, n) => <PosterCard key={g.id} size={204} art={A(`poster-${g.id}.jpg`)} title={g.name} line={line} to={`/game/${g.id}`} actionShown={n === 0} action={<ActionView plan={plan(g, { inst: true })} variant="pill" />} />)}</div>
      </section>
      <section className="gx-lib" style={{ top: 696 }}>
        <h2 className="gx-rail">On the way</h2>
        <div style={{ marginLeft: 228 }} className="gx-tickets">
          <div className="gx-ticket">
            <PosterArt src={A("poster-26.jpg")} title="Endacopia" w={128} h={192} r={12} progress={0.48} />
            <div className="gx-ticket-info">
              <h4>Endacopia</h4>
              <p>Downloading <b>48%</b> · 6.2 MB/s · about 20 min left</p>
              <JourneyLine j={jE} />
              <div className="gx-ticket-foot"><span>Asked for by you · 3 h ago</span><Button size={36} icon="cancel">Cancel</Button></div>
            </div>
          </div>
          <div className="gx-ticket">
            <PosterArt src={A("poster-steam-2622380.jpg")} title="ELDEN RING NIGHTREIGN" w={128} h={192} r={12} grey />
            <div className="gx-ticket-info">
              <h4>ELDEN RING NIGHTREIGN</h4>
              <p>{jN.label}</p>
              <JourneyLine j={jN} />
              <div className="gx-ticket-foot"><span className="gx-asked">Asked for by<Avatar u={U.mika} size={20} /><span><b>Mika</b> · 2 h ago</span></span><Button size={36} icon="cancel">Cancel</Button></div>
            </div>
          </div>
        </div>
      </section>
      <section className="gx-lib" style={{ top: 1020 }}>
        <h2 className="gx-rail">Coming</h2>
        <div style={{ marginLeft: 228 }}>
          <ReleaseCalendar items={coming} keyOf={c => c.appId} release={c => ({ iso: c.iso })} today={TODAY} wrap col={204} gap={24} rowGap={40} ruleGap={20} label="Coming"
            renderCell={(c, k) => <PosterCard size={204} art={A(cap(c.appId))} title={c.name} line={c.line} to={`/steam/${c.appId}`} actionShown={k === 0 && c.iso === TODAY} action={<ActionView plan={c.plan} variant="pill" />} />} />
        </div>
      </section>
      <span className="gx-frame-tag">M/canvas-r/Library-Wall.png (controls, On this PC, On the way at the board's offsets; Coming moved up)</span>
    </div>
  );
}

/* ─────────── tokens and type ─────────── */

function Tokens() {
  const sw = (name: string, v: string) => <div className="gx-sw" key={name}><i style={{ background: v }} />{name}<br />{v}</div>;
  return (
    <Sec id="tokens" title="Tokens" board="BRIEF: page #101010; surfaces #161616 #1c1c1c #1e1e1e #2a2a2a; hairlines .06–.16; text #f2f2f2 / #a4a4a4 / #6e6e6e; amber only for the anchor, the bell dot, Request and focus">
      <div className="gx-swatches">
        {sw("--bg", "#101010")}{sw("--surface-1 / --card", "#161616")}{sw("--surface-2", "#1c1c1c")}{sw("--surface-3 / --raised", "#1e1e1e")}{sw("--surface-4 / --raised-2", "#2a2a2a")}
        {sw("--fill", "rgba(255,255,255,.07)")}{sw("--glass-2 on art", "rgba(16,16,16,.72)")}{sw("--fg", "#f2f2f2")}{sw("--fg-2", "#a4a4a4")}{sw("--muted", "#6e6e6e")}
        {sw("--lamp", "#f2b24a")}{sw("--ok", "#4cc38a")}{sw("--bad", "#e0675f")}
      </div>
      <div className="gx-type" style={{ marginTop: 32 }}>
        <div style={{ font: "800 72px/72px var(--display)", letterSpacing: "-.02em" }}>Find The Needle</div>
        <div style={{ font: "800 24px/28px var(--display)", letterSpacing: "-.01em" }}>New &amp; trending · Bricolage 800 24/28</div>
        <div style={{ fontSize: 17, lineHeight: "24px", color: "var(--fg-2)" }}>Nov 6 · today · <b style={{ color: "var(--fg)", fontWeight: 600 }}>Pell</b> tracks it — Figtree 17/24, the facts line</div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Phantom Blade Zero — 15/600 names</div>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-2)" }}>Very Positive — 13/500 status lines</div>
      </div>
    </Sec>
  );
}

/* ─────────── avatar ─────────── */

function Avatars() {
  const sizes = [20, 24, 28, 32, 40, 44, 48, 64, 96];
  return (
    <Sec id="avatar" title="Avatar" board="ui/avatar.tsx — rounded square (31%), #1e1e1e, .14 hairline, the initial in hsl(hue 65% 72%); green presence dot">
      <div className="gx-grid">
        {sizes.map(s => <Cell key={s} label={`${s}`}><Avatar u={U.k} size={s} /></Cell>)}
        {[U.jonas, U.pell, U.mika, U.sasha, U.theo, U.rin].map(u => <Cell key={u.id} label={`${u.displayName} · dot`}><Avatar u={u} size={44} dot={u.id < 5} /></Cell>)}
        <Cell label="96 · dot"><Avatar u={U.jonas} size={96} dot /></Cell>
        <Cell label="two words"><Avatar u={{ displayName: "Sea Dog", hue: 210 }} size={48} /></Cell>
      </div>
    </Sec>
  );
}

/* ─────────── buttons ─────────── */

function Buttons() {
  return (
    <Sec id="buttons" title="Buttons" board="ui/button.tsx — primary (#f2f2f2 pill), secondary (.07 fill, .12 hairline), quiet, glass on art; 36 / 44 / 48">
      <div className="gx-tbl" style={{ gridTemplateColumns: "120px repeat(4, max-content)" }}>
        <b /> <b>36</b> <b>44</b> <b>48</b> <b>48 with icon</b>
        {(["primary", "secondary", "quiet"] as const).map(k => (
          <Row key={k} label={k}>
            <Button kind={k} size={36}>Check now</Button><Button kind={k} size={44}>Save</Button><Button kind={k} size={48}>Details</Button><Button kind={k} size={48} icon={k === "primary" ? "install" : k === "secondary" ? "cancel" : "trash"}>{k === "primary" ? "Install" : k === "secondary" ? "Cancel" : "Uninstall"}</Button>
          </Row>
        ))}
      </div>
      <div className="gx-grid" style={{ marginTop: 24, padding: 24, borderRadius: 20, background: "url(" + A("banner-29.jpg") + ") center / cover" }}>
        <Button kind="glass" size={36} icon="playSolid">Play</Button><Button kind="glass" size={44}>Details</Button><IconButton icon="chevronLeft" label="Back" />
        <Button kind="primary" size={48} icon="playSolid">Play</Button>
      </div>
      <div className="gx-grid" style={{ marginTop: 24 }}>
        <Cell label="pressed (Tracked)"><Button size={48} icon="tick" pressed>Tracked</Button></Cell>
        <Cell label="busy"><Button kind="primary" size={44} busy>Install</Button></Cell>
        <Cell label="disabled"><Button size={44} disabled>Change</Button></Cell>
        <Cell label="Accept / Decline 44"><span style={{ display: "flex", gap: 8 }}><Button kind="primary" size={44} icon="tick">Accept</Button><Button size={44}>Decline</Button></span></Cell>
        <Cell label="ButtonLink"><ButtonLink to="/settings" size={48}>Edit profile</ButtonLink></Cell>
        <Cell label="round 36 / 44"><span style={{ display: "flex", gap: 8 }}><IconButton icon="chevronLeft" label="Back" size={36} kind="secondary" /><IconButton icon="chevronLeft" label="Back" kind="secondary" /></span></Cell>
      </div>
    </Sec>
  );
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <><b>{label}</b>{children}</>;

/* ─────────── heads ─────────── */

function Heads() {
  return (
    <Sec id="heads" title="SectionHead" board="ui/section.tsx — Bricolage 800 24/28, the grey All › (36 px hit area), counts, a right slot; SubHead 17/600; GroupLabel 13/600">
      <div style={{ display: "grid", gap: 32, maxWidth: 1344 }}>
        <SectionHead title="New & trending" all="/discover/list/new" allLabel="All new and trending games" />
        <SectionHead title="Highest rated" all="/discover/list/best:2026" right={<><Chip>All time</Chip><Chip>Players</Chip><Select chosen label="Year" value="2026" onChange={noop} options={[{ value: "2026", label: "2026" }, { value: "2025", label: "2025" }]} /><span className="dim">Metacritic</span></>} />
        <SectionHead title="Friends" count={4} />
        <SectionHead title="You" all="/u/k" allText="See your profile" />
        <SubHead title="Loved by players" all="/discover/list/genre:1:rated" />
        <GroupLabel count={1}>Want to be friends</GroupLabel>
      </div>
    </Sec>
  );
}

function ChipsAndSelect() {
  return (
    <Sec id="chips" title="Chips and Select" board="ui/controls.tsx — M/lfs/library-wall's control row; Discover's year chip; Friends | Everyone">
      <div style={{ display: "grid", gap: 20 }}>
        <Chips label="Whose activity" value="friends" onChange={noop} items={[{ id: "friends", label: "Friends" }, { id: "all", label: "Everyone" }]} />
        <Chips label="New accounts" value="invite" onChange={noop} items={[{ id: "open", label: "Anyone on the network" }, { id: "invite", label: "With an invite code" }, { id: "closed", label: "Nobody" }]} />
        <div style={{ display: "flex", gap: 12 }}>
          <Select label="Sort" icon="sort" value="added" onChange={noop} options={[{ value: "added", label: "Recently added" }]} />
          <Select label="Sort" value="name" onChange={noop} options={[{ value: "name", label: "Name" }]} />
          <Select chosen label="Year" value="2026" onChange={noop} options={[{ value: "2026", label: "2026" }]} />
        </div>
      </div>
    </Sec>
  );
}

/* ─────────── poster cards ─────────── */

function Posters() {
  const sizes: PosterSize[] = [104, 128, 140, 192, 204];
  return (
    <Sec id="posters" title="PosterCard" board="ui/poster.tsx — 104×156 · 128×192 · 140×212 · 192×288 · 204×304; the action on hover or focus (shown here on some)">
      <div className="gx-grid">
        {sizes.map((s, n) => <PosterCard key={s} size={s} art={A("poster-31.jpg")} title="DARK SOULS III" line={<StatusLine><b>Arrived 22 h ago</b> · 20 GB</StatusLine>} to="/game/31" actionShown={n % 2 === 0} action={<ActionView plan={plan(G.ds3)} variant="pill" />} />)}
      </div>
      <div className="gx-grid" style={{ marginTop: 40 }}>
        <PosterCard size={204} art={A("poster-26.jpg")} title="Endacopia" line="Downloading 48%" to="/game/26" progress={0.48} actionShown action={<ActionView plan={plan(G.endacopia)} variant="pill" />} />
        <PosterCard size={204} art={A("poster-steam-2622380.jpg")} title="ELDEN RING NIGHTREIGN" line={<StatusLine avatar={U.mika}>Asked for by <b>Mika</b> · Looking</StatusLine>} to="/steam/2622380" grey />
        <PosterCard size={204} art={A("poster-8.jpg")} title="DAVE THE DIVER" line={<StatusLine avatar={U.pell}><b>Pell</b> is playing</StatusLine>} to="/game/8" actionShown action={<ActionView plan={plan(G.dave)} variant="pill" />} />
        <PosterCard size={204} art={null} title="A game without art yet" line="Ready · 2.4 GB" to="/game/1" />
        <PosterCard size={204} art={null} wide={A("hero-4115450.jpg")} title="Wide art only" line="Very Positive" to="/steam/4115450" />
        <PosterCard size={128} art={A(cap(5175310))} title="Worst Class Ever" line={<StatusLine check bright>Tracked</StatusLine>} to="/steam/5175310" actionShown action={<ActionView plan={plan(G.worst)} variant="pill" />} />
      </div>
    </Sec>
  );
}

function StatusLines() {
  return (
    <Sec id="status" title="StatusLine" board="ui/poster.tsx StatusLine — text, an avatar, the green dot or a check; <b> for the bright part">
      <div style={{ display: "grid", gap: 12, fontSize: 13, fontWeight: 500, lineHeight: "20px" }}>
        <StatusLine>Very Positive</StatusLine>
        <StatusLine><b>Arrived 22 h ago</b> · 20 GB</StatusLine>
        <StatusLine avatar={U.jonas}><b>Jonas</b> is playing</StatusLine>
        <StatusLine avatar={U.pell}><b>Pell</b> tracks it</StatusLine>
        <StatusLine check bright>Tracked</StatusLine>
        <StatusLine dot>On the server</StatusLine>
      </div>
    </Sec>
  );
}

/* ─────────── GameAction ─────────── */

function Actions() {
  const rows: [string, ActionPlan][] = [
    ["on this PC", plan(G.hollow, { inst: true })],
    ["on this PC, running", plan(G.hollow, { inst: true, running: true })],
    ["installing here 48%", plan(G.ds3, { prog: 0.48 })],
    ["on the server (ready)", plan(G.ds3)],
    ["server downloading", plan(G.endacopia)],
    ["server preparing", plan(G.preparing)],
    ["not out yet", plan(G.needle)],
    ["not out yet, tracked", plan(G.worst)],
    ["didn't make it", plan(G.failed)],
    ["not on the server", plan(G.missing)],
    ["store: coming soon", appPlan(app(5160800, { comingSoon: true }))],
    ["store: protected", appPlan(app(2622380, { crackStatus: "uncracked", drm: "Denuvo" }))],
    ["store: can be had", appPlan(app(4115450))],
  ];
  return (
    <Sec id="actions" title="GameAction" board="ui/game-action.tsx — planAction() decides, exactly as the old Actions did; pill (on art) · row · button · full (game page)">
      <div className="gx-tbl">
        <b>state</b><b>pill (on art)</b><b>row</b><b>button 48</b><b>full</b>
        {rows.map(([label, p]) => <Row key={label} label={label}>
          <span className="gx-art" style={{ backgroundImage: `url(${A("banner-25.jpg")})`, display: "grid", placeItems: "center" }}><ActionView plan={p} variant="pill" /></span>
          <span><ActionView plan={p} variant="row" /></span>
          <span><ActionView plan={p} variant="button" /></span>
          <span><ActionView plan={p} variant="full" showStatus /></span>
        </Row>)}
      </div>
      <div className="gx-grid" style={{ marginTop: 24 }}>
        <Cell label="ActionPill busy"><ActionPill act={{ kind: "request", label: "Request", icon: "plus", lead: true }} busy /></Cell>
        <Cell label="ActionPill row disabled"><ActionPill look="row" act={{ kind: "running", label: "Running", icon: "playSolid", lead: true, disabled: true, pressed: true }} /></Cell>
      </div>
    </Sec>
  );
}

/* ─────────── journey ─────────── */

function Journeys() {
  const js: [string, ReturnType<typeof journeyOf>][] = [
    ["finding", journeyOf(G.nightreign)],
    ["downloading 48%", journeyOf(G.endacopia)],
    ["preparing 30%", journeyOf(G.preparing)],
    ["ready", journeyOf(G.ds3)],
    ["installing 72%", journeyOf(G.ds3, undefined, installing(G.ds3, 0.72))],
    ["installed", journeyOf(G.hollow, installed(G.hollow))],
    ["didn't make it", journeyOf(G.failed)],
  ];
  return (
    <Sec id="journey" title="JourneyLine" board="ui/journey.tsx — sm (M/lfs/library-wall tickets, 360 wide) and lg (M/lfs/library-split, 448 wide)">
      <div style={{ display: "grid", gridTemplateColumns: "360px 448px", gap: "28px 96px", padding: 24, borderRadius: 24, background: "var(--card)", width: "max-content", ["--jl-bg" as string]: "var(--card)" }}>
        {js.map(([label, j]) => <div key={label} style={{ display: "contents" }}>
          <Cell label={`${label} · sm`}><div style={{ width: 360 }}><JourneyLine j={j} /></div></Cell>
          <Cell label={`${label} · lg`}><div style={{ width: 448 }}><JourneyLine j={j} size="lg" /></div></Cell>
        </div>)}
      </div>
    </Sec>
  );
}

/* ─────────── spotlight title rules ─────────── */

function Spotlights() {
  const frame = (key: string, el: ReactNode) => <div key={key} className="gx-frame" style={{ height: 520, margin: "0 calc(-1 * var(--page-x))" }}>{el}</div>;
  const common = { under: false, artHeight: 520, fadeFrom: 300, fadeTo: 520, height: 520, titleBottom: 330 };
  return (
    <Sec id="spotlight" title="Spotlight" board="ui/spotlight.tsx — the logo when readable >= 0.4 (else the title at 72, 56 or 44 by fit), one facts line, actions; the art's fades and scrims">
      <div style={{ display: "grid", gap: 2 }}>
        {frame("hollow", <Spotlight {...common} art={A("banner-16.jpg")} name="Hollow Knight" logo={A("logo-16.png")} meta={META_HOLLOW} facts="On this PC · 41 h played" actions={<><ActionView plan={plan(G.hollow, { inst: true })} variant="button" /><ButtonLink to="/game/16" size={48}>Details</ButtonLink></>} />)}
        {frame("roger", <Spotlight {...common} art={A("banner-28.jpg")} name="and Roger" logo={A("logo-28.png")} meta={META_ROGER} facts="Arrived Aug 22 · 1.5 GB (the logo does not read: the title)" actions={<ActionView plan={plan(G.ds3)} variant="button" />} />)}
        {frame("hellraiser", <Spotlight {...common} art={A("banner-14.jpg")} name="Clive Barker's Hellraiser: Revival" facts="Arrived Oct 19 · 45 GB" actions={<ActionView plan={plan(G.ds3)} variant="button" />} />)}
        {frame("konbini", <Spotlight {...common} art={A("banner-30.jpg")} name="inKONBINI: One Store. Many Stories, Again and Again" facts="On this PC · 4.2 h played" actions={<ActionView plan={plan(G.konbini, { inst: true })} variant="button" />} />)}
      </div>
    </Sec>
  );
}

/* ─────────── calendar ─────────── */

function Calendar() {
  const firstFree = COMING.find(c => !c.tracker)?.appId;      // the board draws the hover state once: the first capsule nobody tracks
  return (
    <Sec id="calendar" title="ReleaseCalendar" board="ui/calendar.tsx — M/disc/picked Coming soon: one column per date, busy days ⌈n/3⌉ wide, today's panel, lanes, week/month rules">
      <SectionHead title="Coming soon" all="/discover/list/coming_soon" allLabel="All upcoming games" />
      <div style={{ marginTop: 4 }}>
        <ReleaseCalendar items={COMING} keyOf={c => c.appId} release={c => ({ iso: c.iso, text: c.text })} rows={3} today={TODAY} label="Coming soon"
          renderCell={c => {
            const show = c.appId === firstFree;
            const line = c.tracker === "me" ? <StatusLine check bright>Tracked</StatusLine> : c.tracker ? <StatusLine><b>{c.tracker.displayName}</b> tracks it</StatusLine> : null;
            const p = c.tracker === "me" ? plan(G.worst) : appPlan(app(c.appId, { comingSoon: true }));
            return <PosterCard bare size={104} art={A(cap(c.appId))} title={c.name} line={line} to={`/steam/${c.appId}`} actionShown={show} action={<ActionView plan={p} variant="pill" />} />;
          }} />
      </div>
    </Sec>
  );
}

/* ─────────── charts ─────────── */

function Charts() {
  return (
    <Sec id="charts" title="ChartRow" board="ui/chart.tsx — M/disc/picked Top sellers beside Highest rated">
      <div style={{ display: "grid", gridTemplateColumns: "584px 660px", gap: 100 }}>
        <div>
          <SectionHead title="Top sellers" all="/discover/list/top" />
          <div style={{ marginTop: 20 }}><ChartList>{TOP_SELLERS.map(([name, id, line], n) => <ChartRow key={id} lead={n + 1} art={A(cap(id))} title={name} to={`/steam/${id}`} line={line} action={<ActionView plan={appPlan(app(id))} variant="row" />} />)}</ChartList></div>
        </div>
        <div>
          <SectionHead title="Highest rated" all="/discover/list/best:2026" right={<><Chip>All time</Chip><Chip>Players</Chip><Select chosen label="Year" value="2026" onChange={noop} options={[{ value: "2026", label: "2026" }]} /><span className="dim">Metacritic</span></>} />
          <div style={{ marginTop: 20 }}><ChartList>{HIGHEST.map(([score, name, id, line]) => <ChartRow key={id} lead={score} score art={A(cap(id))} title={name} to={`/steam/${id}`}
            line={line ?? <StatusLine dot>On the server</StatusLine>} action={<ActionView plan={line ? appPlan(app(id)) : plan(G.ds3)} variant="row" />} />)}</ChartList></div>
        </div>
      </div>
    </Sec>
  );
}

/* ─────────── small controls ─────────── */

function Controls() {
  return (
    <Sec id="controls" title="Toggle, TextField, Pill" board="ui/controls.tsx — M/lfs/settings (toggle, wells), M/lfs/friends-now (Find someone), the top bar's pills">
      <div className="gx-grid">
        <Cell label="Toggle on"><Toggle on onChange={noop} label="Desktop shortcuts" /></Cell>
        <Cell label="Toggle off"><Toggle on={false} onChange={noop} label="Desktop shortcuts" /></Cell>
        <Cell label="disabled"><Toggle on disabled onChange={noop} label="Desktop shortcuts" /></Cell>
        <Cell label="TextField · search"><TextField icon="search" placeholder="Find someone" width={432} onChange={noop} value="" /></Cell>
        <Cell label="TextField · well (in a panel)"><div style={{ padding: 16, background: "var(--card)", borderRadius: 20 }}><TextField well placeholder="A line about you" limit={200} width={420} value="" onChange={noop} /></div></Cell>
        <Cell label="TextField · value"><TextField well value="K" width={320} onChange={noop} /></Cell>
        <Cell label="TextField · key hint"><TextField icon="search" placeholder="Search games" hint="/" width={240} value="" onChange={noop} /></Cell>
      </div>
      <div className="gx-grid" style={{ marginTop: 24, padding: 24, borderRadius: 20, background: "url(" + A("banner-31.jpg") + ") center 30% / cover" }}>
        <Pill icon="transfer"><span className="tb-w" style={{ color: "var(--fg-2)" }}>Downloading</span><b>Endacopia</b><span style={{ color: "var(--fg-2)" }}>48%</span></Pill>
        <Pill icon="refresh">Restart to update</Pill>
        <TransferPill t={{ label: "Looking", name: "ELDEN RING NIGHTREIGN", progress: null, gameId: 40, count: 1 }} />
        <RequestButtonView /><BellButton dot={false} /><BellButton dot /><AccountButton u={U.jonas} />
      </div>
    </Sec>
  );
}

/* ─────────── the bar's panels ─────────── */

function Panels() {
  const online = PEOPLE.filter(p => p.presence.state !== "offline");
  const theo = PEOPLE.find(p => p.id === U.theo.id)!;
  return (
    <Sec id="panels" title="The top bar: states and panels" board="shell/ — the bell's panel, the avatar menu, the Request panel; the bar condensed (scrolled) and on a plain page">
      <div style={{ display: "grid", gap: 2, margin: "0 calc(-1 * var(--page-x)) 32px" }}>
        <div className="gx-frame" style={{ height: 148 }}><Bar path="/library" over={false} /></div>
        <div className="gx-frame" style={{ height: 72 }}><Bar path="/game/31" over={false} solid /></div>
      </div>
      <div className="gx-panels gx-static">
        <SocialPanelView pending={[theo]} online={online} lately={FEED} />
        <div className="tb-panel mn" role="menu"><AccountMenuItems u={U.k} pending={1} onSignOut={noop} /></div>
        <div className="tb-panel rq" role="dialog">
          <TextField icon="search" well placeholder="Find a game" value="hollow" onChange={noop} />
          <div className="rq-body"><ol className="rq-list">
            <RequestRow art={A("poster-16.jpg")} title="Hollow Knight" line="Installed" to="/game/16" action={<ActionView plan={plan(G.hollow, { inst: true })} variant="row" />} />
            <RequestRow art={A(cap(1030300))} title="Hollow Knight: Silksong" line="2025" to="/steam/1030300" action={<ActionView plan={appPlan(app(1030300))} variant="row" />} />
            <RequestRow art={null} title="Hollow Knight (Switch)" line="2018 · Switch" to={null} action={<ActionPill look="row" act={{ kind: "request", label: "Request", icon: "plus", lead: true }} />} />
          </ol></div>
        </div>
      </div>
    </Sec>
  );
}

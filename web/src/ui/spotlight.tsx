/**
 * The Spotlight: the full-width key-art stage at the top of Home, Discover and the game pages.
 *
 * Automatic (`source={{ gameId }}` or `source={{ appId }}`): the server lays the stage out by the boards' spotlight rule
 * (contracts/spotlight.md, GET /api/v1/art/(game/:id | steam/:appid)/spotlight) for this window's width, top bar and page margin:
 * where the logo-free key art sits and how it is blurred, how strong the fade, the top scrim and the side scrim are, and the
 * identity (the Steam logo, the logo recoloured, or the title at its fitted size). This component draws exactly that, picks the
 * scrim strength for the real facts line's width (the server sends one per width), adapts the layout to widths between the
 * server's 40 px steps, and cross-fades when the game changes. While the layout loads, or if it fails, it draws the manual stage
 * below with the game's hero, logo and meta.
 *
 * Manual (`art`, `logo`, `meta`, …, no `source`): as before.
 *   - The art (logo-free key art) is cover-scaled from the window's top edge, behind the top bar, cropped at `anchorX` of its
 *     horizontal overflow; fully visible down to `fadeFrom` and gone by `fadeTo`, with the boards' smoothstep stops
 *     (1, .926, .741, .5, .259, .074, 0 at seven even steps). Over it: the top scrim (240 px, .72 → .5 → 0) and the
 *     left-to-right scrim (.9 at 0, .84 at 560, .56 at 740, .16 at 940, .1 at 1100, .5 at the right edge).
 *   - On it, from the page margin: the title (the Steam logo when the server says it reads on the dark ground, readable >= 0.4,
 *     its opaque box scaled to 40,000 px² within 560 × 160; else the name in Bricolage 800 at 72, 56 or 44 px, whichever fits
 *     the 660 px column on one line, then two balanced lines), standing on `titleBottom`; one facts line (17/24 grey);
 *     the actions (gap 12); anything else under them (`children`, e.g. the JourneyLine).
 * Boards: M/disc/picked (defaults), M/mine/livefan (the Home: artHeight 880, fade 460 → 880, titleBottom 380, factsGap 24),
 * M/lfs/library-split (the game page head), M/spot (the rule the automatic mode follows).
 * Vertical numbers are the boards' (a 148 px top bar); with a shorter bar the stage moves up with it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { urlBase } from "../api";
import { useArtRevision, versionedArt } from "../art-revisions";
import { useUnderBar } from "../shell/context";
import { art as artUrl, useArtMeta, type ArtMeta, type PxBox } from "./art";
import "./spotlight.css";

export const SMOOTH = [1, 0.926, 0.741, 0.5, 0.259, 0.074, 0];
/** the smoothstep mask from `from` to `to` (px), as a CSS gradient */
export const fadeMask = (from: number, to: number) => {
  const st = (to - from) / 6;
  return `linear-gradient(180deg, ${SMOOTH.map((o, i) => `${o === 1 ? "#000" : `rgba(0,0,0,${o})`} ${Math.round(from + i * st)}px`).join(", ")})`;
};
const TOP_SCRIM = "linear-gradient(180deg, rgba(16,16,16,.72) 0px, rgba(16,16,16,.5) 120px, rgba(16,16,16,0) 240px)";
const SIDE_SCRIM = "linear-gradient(90deg, rgba(16,16,16,.9) 0px, rgba(16,16,16,.84) 560px, rgba(16,16,16,.56) 740px, rgba(16,16,16,.16) 940px, rgba(16,16,16,.1) max(1100px, 76.4%), rgba(16,16,16,.5) 100%)";

/** the title sizes, as the boards fit them: 72 on one line, else 56 on one, else 56 on two, else 44 on two */
export function titleTier(w72: number, maxW: number): { size: number; lh: number; lines: 1 | 2 } {
  const at = (s: number) => (w72 * s) / 72;
  if (at(72) <= maxW) return { size: 72, lh: 72, lines: 1 };
  if (at(56) <= maxW) return { size: 56, lh: 60, lines: 1 };
  if (at(56) <= maxW * 1.8) return { size: 56, lh: 60, lines: 2 };
  return { size: 44, lh: 48, lines: 2 };
}

/**
 * The logo on screen, by the server's measured box (contracts/art.md): the box of opaque pixels scaled to `area` px²
 * within `maxW` × `maxH` and the column, standing where the title would. The PNG is drawn unclipped around it (glows and
 * faded rules reach past the box); whatever lies left of the box fades in toward the content edge (the Home's faded rule).
 */
export function logoBox(meta: NonNullable<ArtMeta["logo"]>, area = 40000, maxW = 560, maxH = 160, col = 660) {
  const b = meta.box!;
  const ratio = b.w / b.h;
  let w = Math.sqrt(area * ratio), h = w / ratio;
  const k = Math.min(1, maxW / w, maxH / h, col / w);
  w *= k; h *= k;
  const sc = w / b.w;
  return { w, h, sc, fade: b.x * sc, img: { left: -b.x * sc, top: -b.y * sc, w: meta.w * sc, h: meta.h * sc } };
}

/* ─────────── the automatic mode: the server's layout (contracts/spotlight.md) ─────────── */

/** a library game or a store app */
export type SpotSource = { gameId: number } | { appId: number };
/** one stage's layout, as the server decided it (contracts/spotlight.md) */
export interface SpotLayout {
  stage: { w: number; bar: number; left: number; boxH: number; fade: { from: number; to: number; step: number }; idBottom: number; factsGap: number; actionsGap: number };
  art: { url: string; w: number; h: number; windowH: number; fromSteam: boolean; placeholder: boolean; scale: number; x: number; y: number; width: number; height: number; blur: number; reach: number; focus: number };
  scrim: { top: number; k: number; nominalFacts: number; steps: [number, number][]; side: [number, number][] };
  text: { right: number; top: number; bottom: number; clear: number };
  identity:
    | { kind: "logo"; recolour: boolean; filter: string | null; url: string; file: { w: number; h: number }; crop: PxBox; scale: number; width: number; height: number; hang: number; inkWidth: number; bottom: number }
    | { kind: "title"; size: number; lineHeight: number; letterSpacing: number; lines: string[]; widest: number; height: number; bearing: number; bottom: number };
  why: string[];
  ms: number;
}
export interface SpotlightJson { v: 1; key: string | null; status: "ready" | "pending"; retryAfter: number | null; asked: { w: number; bar: number; left: number }; layout: SpotLayout | null }

const sourceKey = (s: SpotSource) => ("gameId" in s ? `game/${s.gameId}` : `steam/${s.appId}`);

/** an image fetched and decoded ahead of drawing it (the art a game change cross-fades to); resolves either way to whether it
 *  decoded (one that did not is asked again next time: it may have been a blip) */
const decoded = new Map<string, Promise<boolean>>();
const decodedOk = new Set<string>();
/** the newest decoded images, held so the browser keeps their pixels (an image no one holds can be dropped) */
const holding: HTMLImageElement[] = [];
export function decodeArt(url: string): Promise<boolean> {
  let p = decoded.get(url);
  if (p) {
    // asked again: the newest again (the art on screen is asked for on every pick, so it is never the one forgotten)
    decoded.delete(url);
    decoded.set(url, p);
    return p;
  }
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  const mine: Promise<boolean> = img.decode().then(() => {
    decodedOk.add(url);
    holding.push(img);
    if (holding.length > 12) holding.shift();
    return true;
  }, () => { if (decoded.get(url) === mine) decoded.delete(url); return false; });
  p = mine;
  decoded.set(url, p);
  if (decoded.size > 40) { const first = decoded.keys().next(); if (!first.done) { decoded.delete(first.value); decodedOk.delete(first.value); } }
  return p;
}
/** this page has decoded the image already (a copy drawn now is there in its first frame) */
export const isDecoded = (url: string) => decodedOk.has(url);
/** the longest a game change keeps the old art up while the new one loads (a slow link: then it cross-fades to what has come) */
const HOLD_ART_MS = 2500;
/** the server's 40 px width steps (contract: the asked width rounded to 40, 960 to 2560) */
export const widthBucket = (w: number) => Math.min(2560, Math.max(960, Math.round(w / 40) * 40));
/** the art box's height on a stage this wide: 880 at 1440, scaling with the width between 1100 and 1800 */
export const stageBoxH = (w: number) => Math.round((880 * Math.min(1800, Math.max(1100, w))) / 1440);
export function spotlightUrl(s: SpotSource, env: { w: number; bar: number; left: number }, name?: string) {
  const n = "appId" in s && name ? `&n=${encodeURIComponent(name.slice(0, 120))}` : "";
  return versionedArt(`${urlBase}/api/v1/art/${sourceKey(s)}/spotlight?w=${widthBucket(env.w)}&bar=${env.bar}&x=${env.left}${n}`, "gameId" in s ? "game" : "steam", "gameId" in s ? s.gameId : s.appId);
}

const answers = new Map<string, SpotlightJson>();                  // by URL
const answeredAt = new Map<string, number>();
/** an answer older than this is drawn but asked again (the server reads a game's art again at most this often) */
const FRESH_MS = 10 * 60_000;
const latest = new Map<string, SpotlightJson>();                   // by source: the last answer with a layout, any width
const flights = new Map<string, Promise<SpotlightJson | null>>();
function load(url: string, src: string): Promise<SpotlightJson | null> {
  let p = flights.get(url);
  if (!p) {
    p = fetch(url, { credentials: "include" })
      .then(r => (r.ok ? (r.json() as Promise<SpotlightJson>) : null))
      .catch(() => null)
      .then(j => {
        flights.delete(url);
        if (j) { answers.set(url, j); answeredAt.set(url, Date.now()); if (j.layout) latest.set(src, j); }
        return j;
      });
    flights.set(url, p);
  }
  return p;
}

/** the window's stage: its width, the top bar's height and the page margin (the CSS variables the shell sets) */
function envNow(width?: number): { w: number; bar: number; left: number } {
  const css = getComputedStyle(document.documentElement);
  const bar = parseFloat(css.getPropertyValue("--bar-h")) || 148, left = parseFloat(css.getPropertyValue("--page-x")) || 48;
  return { w: Math.round(width ?? document.documentElement.clientWidth), bar: bar <= 126 ? 104 : 148, left: left < 44 ? 40 : 48 };
}
/** the last layout this page has for a source (any width), or null: what a small copy of the art needs (where its subject is) */
export const cachedLayout = (source: SpotSource): SpotLayout | null => latest.get(sourceKey(source))?.layout ?? null;
/** warm the server's layout for a source (e.g. the fan's other games), so a later Spotlight draws it at once; a fresh answer this
 *  page already has is not asked for again */
export function prefetchSpotlight(source: SpotSource, name?: string, width?: number): Promise<SpotlightJson | null> {
  const url = spotlightUrl(source, envNow(width), name), have = answers.get(url);
  if (have && have.status !== "pending" && Date.now() - (answeredAt.get(url) ?? 0) < FRESH_MS) return Promise.resolve(have);
  return load(url, sourceKey(source));
}

/** the layout for a source on this stage: the server's answer for the width's bucket, polled while pending; meanwhile the last
 *  layout this page had for the source (another width), else null */
export function useSpotlightLayout(source: SpotSource | null, env: { w: number; bar: number; left: number } | null, name?: string): { json: SpotlightJson | null; failed: boolean } {
  useArtRevision(source && "appId" in source ? "steam" : "game", source ? ("gameId" in source ? source.gameId : source.appId) : null);
  const src = source ? sourceKey(source) : "";
  const url = source && env ? spotlightUrl(source, env, name) : "";
  const [state, setState] = useState<{ src: string; json: SpotlightJson | null; failed: boolean }>(() => ({ src, json: (url && answers.get(url)) || latest.get(src) || null, failed: false }));
  // the address being asked, with the source it belongs to (they change together: an answer is never filed under another game)
  const [wanted, setWanted] = useState({ url, src });
  // another game is asked for at once; a new width once it has held still for a moment (a window being dragged asks for none)
  useEffect(() => {
    if (!url || wanted.url === url) return;
    if (wanted.src !== src || answers.has(url)) { setWanted({ url, src }); return; }
    const t = setTimeout(() => setWanted({ url, src }), 300);
    return () => clearTimeout(t);
  }, [url, src, wanted.url, wanted.src]);
  useEffect(() => {
    const { url: u, src: s0 } = wanted;
    if (!u || !s0) return;
    let live = true, tries = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const have = answers.get(u);
    setState(s => ({ src: s0, json: have ?? (s.src === s0 ? s.json : latest.get(s0) ?? null), failed: false }));
    const ask = async () => {
      const j = await load(u, s0);
      if (!live) return;
      if (!j) { setState(s => ({ src: s0, json: s.src === s0 ? s.json : null, failed: true })); return; }
      setState(s => ({ src: s0, json: j.layout ? j : (s.src === s0 ? s.json : null) ?? j, failed: false }));
      if (j.status === "pending" && tries++ < 60) {
        answers.delete(u);                                                  // ask the server again, not the memo
        timer = setTimeout(ask, Math.max(0.5, j.retryAfter ?? 2) * 1000);
      }
    };
    if (!have || have.status === "pending" || Date.now() - (answeredAt.get(u) ?? 0) > FRESH_MS) void ask();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [wanted]);
  return state.src === src ? { json: state.json, failed: state.failed } : { json: latest.get(src) ?? null, failed: false };
}

/** the strength a facts line `w` px wide needs (the last step whose width it passes; the first step also holds for none) */
export function strengthFor(steps: [number, number][], w: number): number {
  let k = steps.length ? steps[0][1] : 1;
  for (let i = 1; i < steps.length; i++) if (w > steps[i][0]) k = steps[i][1];
  return k;
}

/** the art's box on a stage `W` px wide, from a layout made for a width near it: the art box scales with the stage width, and the
 *  pan keeps the art's focus (the subject the rule placed) in the middle of the room beside the text */
export function placeArt(l: SpotLayout, W: number) {
  const a = l.art, boxH = stageBoxH(W), f = boxH / l.stage.boxH, reach = a.reach;
  let scale = a.scale * f, width = a.width * f, height = a.height * f;
  const y = a.y * f;
  if (width < W + 2 * reach) { const g = (W + 2 * reach) / width; scale *= g; width *= g; height *= g; }
  let x = a.x;
  if (W !== l.stage.w || f !== 1) x = (l.text.right + W - 100) / 2 - a.focus * a.w * scale;
  x = Math.min(-reach, Math.max(W + reach - width, x));
  return { x, y, scale, width, height, blur: a.blur, boxH, fadeFrom: Math.round(l.stage.fade.from * f), fadeTo: boxH, step: l.stage.fade.step };
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
/** the rule's fade: opaque to `from`, 1 - smoothstep to nothing at `to`, a stop every `step` px */
export function ruleMask(from: number, to: number, step = 15) {
  const n = Math.max(1, Math.round((to - from) / step)), stops = [`#000 ${fmt(from)}px`];
  for (let i = 1; i <= n; i++) stops.push(`rgba(0,0,0,${fmt(1 - smooth(i / n))}) ${fmt(from + ((to - from) * i) / n)}px`);
  return `linear-gradient(180deg, ${stops.join(", ")})`;
}
const a16 = (a: number) => `rgba(16,16,16,${fmt(Math.min(1, a))})`;
/** the Home's scrims at the rule's strengths: the side one's .1 stop at max(1100, W - 340) and its .5 at the right edge */
export const ruleTopScrim = (top: number) => `linear-gradient(180deg, ${a16(0.72 * top)} 0px, ${a16(0.5 * top)} 120px, ${a16(0)} 240px)`;
export const ruleSideScrim = (k: number) =>
  `linear-gradient(90deg, ${a16(0.9 * k)} 0px, ${a16(0.84 * k)} 560px, ${a16(0.56 * k)} 740px, ${a16(0.16 * k)} 940px, ${a16(0.1 * k)} max(1100px, calc(100% - 340px)), ${a16(0.5 * k)} 100%)`;

export interface SpotlightProps {
  /** automatic mode: the server lays the stage out for this game or store app (then art/logo/meta/anchorX/artHeight/fade… are
   *  only the fallback while it loads) */
  source?: SpotSource;
  /** the logo-free key art */
  art?: string | null;
  /** 0 = crop to the art's left edge, 1 = its right edge */
  anchorX?: number;
  /** the art covers at least this height (px) */
  artHeight?: number;
  fadeFrom?: number;
  fadeTo?: number;
  /** the block's height in the page: what follows starts here (overlapping the fade). A number is board px (it follows
   *  the bar's height like the stage does); a string is used as is ("100vh" for the Home) */
  height?: number | string;
  /** where the title's bottom sits, from the top of the window */
  titleBottom?: number;
  name: string;
  /** the logo image; used only when meta.logo.readable >= 0.4 */
  logo?: string | null;
  meta?: ArtMeta | null;
  logoArea?: number;
  /** facts line under the title (17/24 grey; wrap bright words in <b>) */
  facts?: ReactNode;
  factsGap?: number;
  /** the actions row: GameAction variant="button" and a Details ButtonLink, gap 12 */
  actions?: ReactNode;
  children?: ReactNode;
  /** dim art brighter than mid grey toward it (from meta.hero.mean), never brighten (manual mode) */
  dim?: boolean;
  /** drawn over the art and its scrims, under the text, inside the art's faded box (both modes): a page-coloured ground for a
   *  page that puts text over the art's lower half (the game page's facts and Lately). Position it from the window's top. */
  ground?: ReactNode;
  /** the top bar sits over this art (default) */
  under?: boolean;
  className?: string;
  /** automatic mode, the art alone: no name, facts or actions (the doors put their own column over it); decorative */
  bare?: boolean;
  /** with `bare`: the side scrim as strong as a facts line this wide needs (px) */
  scrimFor?: number;
}

export function Spotlight(props: SpotlightProps) {
  useUnderBar(props.under ?? true);
  return props.source ? <AutoSpotlight {...props} source={props.source} /> : <ManualSpotlight {...props} />;
}

const shift = (v: number) => `calc(${v}px + var(--bar-h) - 148px)`;
/** how long an automatic stage waits for its layout before it draws today's stage instead */
const HOLD_MS = 450;
const heightOf = (h: number | string) => (typeof h === "number" ? shift(h) : h);

function ManualSpotlight(p: SpotlightProps & { sectionRef?: RefObject<HTMLElement> }) {
  return (
    <section ref={p.sectionRef} className={`spot${p.className ? " " + p.className : ""}`} style={{ height: heightOf(p.height ?? 608) }} aria-label={p.name}>
      <ManualParts {...p} />
    </section>
  );
}

function ManualParts({ art, anchorX = 0.4, artHeight = 760, fadeFrom = 400, fadeTo = 700, titleBottom = 416, name, logo, meta, logoArea = 40000, facts, factsGap = 20, actions, children, dim, ground }: SpotlightProps) {
  const stage = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [col, setCol] = useState(660);
  const [w72, setW72] = useState<number | null>(null);
  const [logoBad, setLogoBad] = useState(false);
  const [artBad, setArtBad] = useState(false);
  useEffect(() => { setLogoBad(false); }, [logo]);
  useEffect(() => { setArtBad(false); }, [art]);
  // the column's width and the title's width at 72 px, measured once the fonts are in
  useLayoutEffect(() => {
    const measure = () => {
      if (stage.current) setCol(Math.min(660, stage.current.clientWidth || 660));
      if (probe.current) setW72(probe.current.getBoundingClientRect().width);
    };
    measure();
    void document.fonts?.ready.then(measure);
    const ro = new ResizeObserver(measure);
    if (stage.current) ro.observe(stage.current);
    return () => ro.disconnect();
  }, [name]);
  const useLogo = !!(logo && !logoBad && meta?.logo?.box && meta.logo.readable >= 0.4);
  const tier = titleTier(w72 ?? 0, col);
  const mean = meta?.hero?.mean;
  const k = dim && mean ? Math.min(1, Math.max(0.6, 118 / mean)) : 1;
  let title: ReactNode;
  if (useLogo) {
    const L = logoBox(meta!.logo!, logoArea, 560, 160, col);
    const fade = L.fade >= 1 ? `linear-gradient(90deg, rgba(0,0,0,0) 0px, #000 ${L.fade.toFixed(1)}px)` : undefined;
    title = (
      <h1 className="spot-title logo" style={{ width: L.w, height: L.h }}>
        <img src={logo!} alt={name} draggable={false} onError={() => setLogoBad(true)} style={{ left: L.img.left, top: L.img.top, width: L.img.w, height: L.img.h, maskImage: fade, WebkitMaskImage: fade }} />
      </h1>
    );
  } else {
    title = <h1 className={`spot-title text l${tier.lines}`} style={{ fontSize: tier.size, lineHeight: `${tier.lh}px` }}>{name}</h1>;
  }
  const artStyle: CSSProperties = { height: fadeTo, maskImage: fadeMask(fadeFrom, fadeTo), WebkitMaskImage: fadeMask(fadeFrom, fadeTo) };
  return (
    <>
      <div className="spot-art" style={artStyle} aria-hidden>
        {art && !artBad && <img src={art} alt="" draggable={false} onError={() => setArtBad(true)} style={{ height: `max(${artHeight}px, 100%)`, objectPosition: `${anchorX * 100}% 0`, filter: k < 1 ? `brightness(${k.toFixed(2)})` : undefined }} />}
        <div className="spot-scrim-top" style={{ background: TOP_SCRIM }} />
        <div className="spot-scrim" style={{ background: SIDE_SCRIM }} />
        {ground}
      </div>
      <span className="spot-probe" ref={probe} aria-hidden>{name}</span>
      <div className="spot-stage" ref={stage} style={{ top: shift(titleBottom) }}>
        {title}
        {facts && <p className="spot-facts" style={{ marginTop: factsGap }}>{facts}</p>}
        {actions && <div className="spot-acts">{actions}</div>}
        {children && <div className="spot-more">{children}</div>}
      </div>
    </>
  );
}

/** the art layer as the rule places it: the image at its box (blurred when the rule blurs it) under the two scrims, faded.
 *  The layer is its own stacking context at z-index -1 (ui/spotlight.css): the art paints under whatever follows the
 *  Spotlight, while it fades in or out as much as after. */
interface ArtLayer { url: string; x: number; y: number; width: number; height: number; blur: number; boxH: number; fadeFrom: number; fadeTo: number; step: number; top: number; k: number }
/** `holding`: the layer a game change leaves, kept opaque on top until the new art has decoded; `leaving`: it goes out of
 *  focus; `focusing`: the new art under it, coming into focus meanwhile */
function ArtLayerView({ l, leaving, holding, fresh, focusing, ground }: { l: ArtLayer; leaving?: boolean; holding?: boolean; fresh?: boolean; focusing?: boolean; ground?: ReactNode }) {
  const mask = ruleMask(l.fadeFrom, l.fadeTo, l.step);
  return (
    <div className={`spot-a-layer${leaving ? " leaving" : holding ? " holding" : fresh ? " spot-a-fresh" : ""}${focusing ? " focusing" : ""}`} aria-hidden>
      <div className="spot-art" style={{ height: l.boxH, maskImage: mask, WebkitMaskImage: mask }}>
        <img className="spot-a-img" src={l.url} alt="" draggable={false} style={{ left: l.x, top: l.y, width: l.width, height: l.height, filter: l.blur ? `blur(${l.blur}px)` : undefined }} />
        <div className="spot-scrim-top" style={{ background: ruleTopScrim(l.top) }} />
        <div className="spot-scrim" style={{ background: ruleSideScrim(l.k) }} />
        {ground}
      </div>
    </div>
  );
}

function AutoSpotlight(p: SpotlightProps & { source: SpotSource }) {
  const section = useRef<HTMLElement>(null);
  const [env, setEnv] = useState(() => envNow());
  const { json } = useSpotlightLayout(p.source, env, p.name);
  const kind = "gameId" in p.source ? "game" : "steam", id = "gameId" in p.source ? p.source.gameId : p.source.appId;
  const layout = json?.layout ?? null;
  // the stage's width (and the bar and margin the CSS gives this window), watched on the section that is drawn
  useLayoutEffect(() => {
    const measure = () => { const w = section.current?.clientWidth; const e = envNow(w || undefined); setEnv(o => (o.w === e.w && o.bar === e.bar && o.left === e.left ? o : e)); };
    measure();
    const ro = new ResizeObserver(measure);
    if (section.current) ro.observe(section.current);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [!!layout]);
  // with no layout yet, the stage stays empty for a moment (a layout the server has comes in a few ms, and today's stage
  // flashing first would be a jump); then it draws today's stage until the layout comes, and the layout fades in
  const srcKey = sourceKey(p.source);
  const [held, setHeld] = useState(!layout);
  useEffect(() => {
    if (layout) { setHeld(false); return; }
    setHeld(true);
    const t = setTimeout(() => setHeld(false), HOLD_MS);
    return () => clearTimeout(t);
  }, [srcKey, !!layout]);
  const drewStage = useRef(false), fresh = !!layout && !drewStage.current;
  useEffect(() => { drewStage.current = !!layout; });
  // the fallback (today's stage) needs the art's numbers; ask for them only while there is no layout
  const meta = useArtMeta(kind, layout || held ? null : id);
  const h = heightOf(p.height ?? 608);
  if (!layout && (held || p.bare)) return <section ref={section} className={`spot${p.className ? " " + p.className : ""}`} style={{ height: h }} aria-label={p.bare ? undefined : p.name} aria-hidden={p.bare || undefined} />;
  if (!layout) {
    const W = env.w, boxH = stageBoxH(W);
    const fb: Partial<SpotlightProps> = {
      art: p.art ?? (kind === "game" ? artUrl.hero(id) : artUrl.steamHero(id)),
      logo: p.logo ?? (kind === "game" ? artUrl.logo(id) : artUrl.steamLogo(id)),
      meta: p.meta ?? meta, anchorX: p.anchorX ?? 0.5, artHeight: p.artHeight ?? boxH, fadeFrom: p.fadeFrom ?? Math.round((boxH * 460) / 880), fadeTo: p.fadeTo ?? boxH,
      titleBottom: p.titleBottom ?? 380, factsGap: p.factsGap ?? 24,
    };
    return (
      <section ref={section} className={`spot${p.className ? " " + p.className : ""}`} style={{ height: h }} aria-label={p.name}>
        <ManualParts {...p} {...fb} />
      </section>
    );
  }
  return <AutoStage p={p} layout={layout} env={env} section={section} height={h} fresh={fresh} />;
}

function AutoStage({ p, layout, env, section, height, fresh }: { p: SpotlightProps; layout: SpotLayout; env: { w: number }; section: RefObject<HTMLElement>; height: string; fresh: boolean }) {
  // a stage that came in after the empty moment or today's stage fades in once: its first art, until the art changes
  const [freshUrl, setFreshUrl] = useState(fresh ? urlBase + layout.art.url : null);
  const factsEl = useRef<HTMLParagraphElement>(null);
  const [factsW, setFactsW] = useState(layout.scrim.nominalFacts);
  const [logoBad, setLogoBad] = useState(false);
  useEffect(() => { setLogoBad(false); }, [layout.identity.kind === "logo" ? layout.identity.url : ""]);
  // the facts line's real width decides the side scrim's strength (the server sends one per width). It is measured when the
  // line or the art changes, then a frame after the line's box resizes or the fonts arrive, and a stale measurement (an old
  // line's, after the stage changed) never answers. Measured after every render, with every render's font-ready callback
  // still bound to the line of its moment, a fan turn set it from the old, detached line (0) and the new one by turns
  // inside the click, until React gave up on the Home ("Maximum update depth exceeded" → "This page didn't load", 2026-11-07).
  const factsKey = typeof p.facts === "string" || typeof p.facts === "number" ? String(p.facts) : p.facts;
  useLayoutEffect(() => {
    if (p.bare) { const w = p.scrimFor ?? layout.scrim.nominalFacts; setFactsW(o => (o === w ? o : w)); return; }
    const el = factsEl.current;
    if (!el) { setFactsW(o => (o === 0 ? o : 0)); return; }
    let alive = true, raf = 0;
    const measure = () => {
      if (!alive) return;
      const r = document.createRange(); r.selectNodeContents(el);
      const w = Math.round(Math.min(el.clientWidth || Infinity, r.getBoundingClientRect().width));
      setFactsW(o => (Math.abs(o - w) < 1 ? o : w));
    };
    measure();
    const later = () => { cancelAnimationFrame(raf); if (alive) raf = requestAnimationFrame(measure); };
    const ro = new ResizeObserver(later);
    ro.observe(el);
    void document.fonts?.ready.then(later);
    return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); };
  }, [p.bare, p.scrimFor, layout.scrim.nominalFacts, layout.art.url, factsKey]);
  const k = strengthFor(layout.scrim.steps, factsW);
  const pa = placeArt(layout, env.w);
  const layer: ArtLayer = { url: urlBase + layout.art.url, ...pa, top: layout.scrim.top, k };
  // focus pull: when the art changes (a new game; new art) the layer drawn before stays on top, opaque, until the new art has
  // decoded (at most HOLD_ART_MS), then goes out of focus over it while the new one comes into focus underneath (no fade of
  // its own, so the change never dips to dark, even on a slow link; spotlight.css). The new text block comes in at once.
  const [leaving, setLeaving] = useState<{ l: ArtLayer; go: boolean } | null>(null);
  const shown = useRef<ArtLayer | null>(null);
  useLayoutEffect(() => {
    const was = shown.current;
    shown.current = layer;
    if (was && was.url !== layer.url) {
      setFreshUrl(null);
      setLeaving({ l: was, go: false });
      let live = true;
      const go = () => { if (live) setLeaving(x => (x && x.l === was ? { ...x, go: true } : x)); };
      const t = setTimeout(go, HOLD_ART_MS);
      void decodeArt(layer.url).then(go);
      return () => { live = false; clearTimeout(t); };
    }
  }, [layer.url]);
  useEffect(() => {
    if (!leaving?.go) return;
    const t = setTimeout(() => setLeaving(null), 640);
    return () => clearTimeout(t);
  }, [leaving?.go, leaving?.l]);
  const isFresh = freshUrl === layer.url;
  const id = layout.identity;
  let title: ReactNode;
  if (id.kind === "logo" && !logoBad) {
    const s = id.scale;
    title = (
      <h1 className="spot-a-id logo" style={{ width: id.inkWidth, height: id.height }}>
        <span style={{ left: -id.hang, width: id.width, height: id.height }}>
          <img src={urlBase + id.url} alt={p.name} draggable={false} onError={() => setLogoBad(true)} style={{ left: -id.crop.x * s, top: -id.crop.y * s, width: id.file.w * s, height: id.file.h * s, filter: id.filter ?? undefined }} />
        </span>
      </h1>
    );
  } else if (id.kind === "title") {
    title = (
      <h1 className="spot-a-id title" style={{ left: -id.bearing, fontSize: id.size, lineHeight: id.lineHeight, letterSpacing: `${id.letterSpacing}em` }}>
        {id.lines.map((l, i) => <span key={i}>{i > 0 && <>{" "}<br /></>}{l}</span>)}
      </h1>
    );
  } else {
    // the logo would not load: the name at the size a title of this length gets
    title = <h1 className="spot-a-id title" style={{ fontSize: 56, lineHeight: 1.06, letterSpacing: "-0.02em", whiteSpace: "normal", width: 580, textWrap: "balance" } as CSSProperties}>{p.name}</h1>;
  }
  return (
    <section ref={section} className={`spot spot-auto${p.className ? " " + p.className : ""}`} style={{ height }} aria-label={p.bare ? undefined : p.name} aria-hidden={p.bare || undefined}>
      <ArtLayerView l={layer} key={"art:" + layer.url} fresh={isFresh} focusing={!!leaving?.go} ground={p.ground} />
      {leaving && <ArtLayerView l={leaving.l} leaving={leaving.go} holding={!leaving.go} key={"leaving:" + leaving.l.url} ground={p.ground} />}
      {!p.bare && <div key={"stage:" + layer.url} className={`spot-a-stage${leaving || isFresh ? " spot-a-fresh" : ""}`} style={{ top: shift(layout.stage.idBottom - layout.stage.bar + 148) }}>
        {title}
        {p.facts && <p className="spot-facts" ref={factsEl} style={{ marginTop: layout.stage.factsGap }}>{p.facts}</p>}
        {p.actions && <div className="spot-acts" style={{ marginTop: layout.stage.actionsGap }}>{p.actions}</div>}
        {p.children && <div className="spot-more">{p.children}</div>}
      </div>}
    </section>
  );
}

/**
 * Ahoy — the pieces the Friends page (/people) and a profile (/u/:name) share:
 *   useFriendGame  the game a presence is about (the library game, else its Steam app)
 *   KeyArt         that game's logo-free key art filling a box (a playing tile, the profile's now card)
 *   useMine        your one action for it on this PC, and MineButton to draw it (Play, Install, Request, Try again)
 *   PresenceText   "• Playing Balatro · 40 min", "• Online", "Seen 2 h ago"
 *   joinedWords    "Aug 2" ("Aug 2, 2025" in another year)
 * Private to these two screens for phase 2; listed for ui/ in the screen's return.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Game, Presence } from "../api";
import { useLib } from "../data";
import { shortDate } from "../model";
import { art, useArtMeta } from "../ui/art";
import type { ButtonSize } from "../ui/button";
import { GameActionView, useGameAction, type Act, type ActKind, type ActionApp } from "../ui/game-action";
import { presenceWords } from "../ui/people";
import "./friends.css";

/* ─────────── the game a friend is playing ─────────── */

export interface FriendGame { game: Game | undefined; appId: number | null; name: string; to: string | null; ready: boolean }

/**
 * The library game a presence names (by id, else by its Steam app), else just the Steam app; where it opens. Nothing is
 * decided until the library has come (ready false: no game, no app, no link): the Steam app would be a wrong first guess
 * for a game the server has, costing its key art and meta for nothing and a Request button that turns into Play.
 */
export function useFriendGame(pr: Presence): FriendGame {
  const lib = useLib();
  const named = pr.gameName ?? "";
  if (!lib.loaded) return { game: undefined, appId: null, name: named, to: null, ready: false };
  const game = (pr.gameId != null ? lib.byId.get(pr.gameId) : undefined) ?? (pr.appId != null ? lib.byApp.get(pr.appId) : undefined);
  const appId = game?.steamAppId ?? pr.appId ?? null;
  return { game, appId, name: game?.name ?? named, to: game ? `/game/${game.id}` : appId != null ? `/steam/${appId}` : null, ready: true };
}

/* ─────────── key art ─────────── */

/** what the crop needs to know about a key art: its size, and per 64 bands across its width the detail (mean luminance
 *  gradient, |dx| + |dy|) and the luminance (sum and count), measured once on a 640 px wide copy (the board's measure.cjs) */
interface ArtStats { w: number; h: number; detail: number[]; lum: number[]; cnt: number[] }
const BANDS = 64;
const statsCache = new Map<string, ArtStats | null>();

function measureArt(img: HTMLImageElement): ArtStats | null {
  try {
    const W = 640, H = Math.max(2, Math.round(img.naturalHeight * W / img.naturalWidth));
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const L = new Float32Array(W * H);
    for (let i = 0, j = 0; j < L.length; i += 4, j++) L[j] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const detail = new Array<number>(BANDS).fill(0), dn = new Array<number>(BANDS).fill(0), lum = new Array<number>(BANDS).fill(0), cnt = new Array<number>(BANDS).fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = Math.min(BANDS - 1, Math.floor(x * BANDS / W)), v = L[y * W + x];
      lum[k] += v; cnt[k]++;
      if (x < W - 1 && y < H - 1) { detail[k] += Math.abs(L[y * W + x + 1] - v) + Math.abs(L[(y + 1) * W + x] - v); dn[k]++; }
    }
    return { w: img.naturalWidth, h: img.naturalHeight, detail: detail.map((v, k) => v / Math.max(1, dn[k])), lum, cnt };
  } catch { return null; }   // a tainted or broken image: the centred crop and the server's mean
}

/**
 * The board's crop rule (M/lfs/friends-now/gen.mjs cropAnchor): of every window the box could show, the one with the most
 * picture in it (the detail summed over the window), weighted toward the centre (Steam keeps a hero's subject near the
 * middle; the weight falls to .7 at either edge). Returns the anchor (0 left … 1 right) and the window's mean luminance.
 */
export function cropOf(st: ArtStats, w: number, h: number): { anchor: number; mean: number } {
  const k = Math.max(w / st.w, h / st.h), iw = st.w * k;
  const n = st.detail.length;
  let s0 = 0, nb = n, anchor = 0.5;
  if (iw - w >= 1) {
    nb = Math.max(1, Math.min(n, Math.round((w / iw) * n)));
    let best = -1;
    for (let s = 0; s + nb <= n; s++) {
      const a = n === nb ? 0.5 : s / (n - nb);
      let sum = 0;
      for (let i = s; i < s + nb; i++) sum += st.detail[i];
      const score = sum * (1 - 0.3 * Math.pow(Math.abs(a - 0.5) * 2, 2));
      if (score > best + 1e-9 || (Math.abs(score - best) <= 1e-9 && Math.abs(a - 0.5) < Math.abs(anchor - 0.5))) { best = score; anchor = a; s0 = s; }
    }
  }
  let lum = 0, cnt = 0;
  for (let i = s0; i < s0 + nb; i++) { lum += st.lum[i]; cnt += st.cnt[i]; }
  return { anchor, mean: cnt ? lum / cnt : 0 };
}

/**
 * The game's logo-free key art, cover-cropped in its box (position the box; the image fills it) by the board's rule:
 * the window with the most picture in it, weighted toward the centre. Art brighter than mid grey is dimmed toward it
 * (118 / the mean luminance of the window shown, never below .6, never brightened), so the names and the button on it read
 * on every game. With no key art (meta.hero is null), the poster stands at the box's full height against the right edge
 * over a blurred, darkened copy of itself. Mount it with a key per game: it remembers a failed image.
 */
export function KeyArt({ game, appId, name }: { game?: Game; appId: number | null; name: string }) {
  const meta = useArtMeta(game ? "game" : "steam", game ? game.id : appId);
  const [bad, setBad] = useState(false);
  // the tile shows a cover crop of the 3.1:1 hero, about 1200 CSS px of it wide: a 1920 copy is sharp at 1.5x, a quarter the bytes
  const hero = game ? art.hero(game.id, 1920) : appId != null ? art.steamHero(appId, 1920) : null;
  const poster = game ? art.poster(game.id, 640) : appId != null ? art.steam(appId, name, 640) : null;
  const [stats, setStats] = useState<ArtStats | null>(hero ? statsCache.get(hero) ?? null : null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const ref = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox(b => (b && b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    if (el.complete && el.naturalWidth) onLoad();   // already decoded (the browser's cache): no load event to wait for
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hero, bad, meta]);
  function onLoad() {
    const el = ref.current;
    if (!el || !hero || !el.naturalWidth) return;
    if (!statsCache.has(hero)) statsCache.set(hero, measureArt(el));
    setStats(statsCache.get(hero) ?? null);
  }
  const noHero = !!meta && !meta.hero;
  if (hero && !bad && !(noHero && poster)) {
    const crop = stats && box && box.w > 0 && box.h > 0 ? cropOf(stats, box.w, box.h) : null;
    const mean = crop?.mean ?? meta?.hero?.mean ?? null;
    const dim = mean != null && mean > 118 ? Math.max(0.6, 118 / mean) : 1;
    const style: CSSProperties = {};
    if (crop) style.objectPosition = `${(crop.anchor * 100).toFixed(2)}% 50%`;
    if (dim < 1) style.filter = `brightness(${dim.toFixed(2)})`;
    return <img ref={ref} className="fr-ka-hero" src={hero} alt="" draggable={false} style={style} onLoad={onLoad} onError={() => setBad(true)} />;
  }
  if (poster) return <><img className="fr-ka-blur" src={poster} alt="" draggable={false} /><img className="fr-ka-poster" src={poster} alt="" draggable={false} /></>;
  return null;
}

/* ─────────── your action for a friend's game ─────────── */

const storeApp = (appId: number): ActionApp => ({ appId, gameId: null, comingSoon: false, crackStatus: null, drm: null });

/** GameAction's plan and handlers for a friend's game: the library game, else its Steam app */
export function useMine(game: Game | undefined, appId: number | null) {
  return useGameAction({ game: game ?? null, app: !game && appId != null ? storeApp(appId) : null });
}
export type Mine = ReturnType<typeof useMine>;

/** the acts a friend's game offers here; one on its way or not out yet offers none (the bar's downloads pill and the game page carry those) */
const OFFERED: readonly ActKind[] = ["play", "running", "install", "request", "retry"];
const tileKind = (a: Act) => (a.kind === "retry" ? "secondary" : "primary");

/** the one button: Play (Running while it runs) / Install / Request white, Try again secondary (GameAction's button form);
 *  its act names a class (fr-mine-play …), so each board's glyph size can follow it */
export function MineButton({ mine, size = 48, name }: { mine: Mine; size?: ButtonSize; name?: string }) {
  const kind = mine.plan.main?.kind;
  return <GameActionView ga={mine} variant="button" size={size} only={OFFERED} kind={tileKind} label={name} className={`fr-mine${kind ? ` fr-mine-${kind}` : ""}`} />;
}

/* ─────────── words ─────────── */

/** presence as the boards write it: the green dot while on, the game bright */
export function PresenceText({ pr, dot = true }: { pr: Presence; dot?: boolean }) {
  const w = presenceWords(pr);
  const d = dot ? <i className="fr-pdot" aria-hidden /> : null;
  if (w.state === "playing") return <>{d}Playing <b>{w.game}</b>{w.how ? ` · ${w.how}` : ""}</>;
  if (w.state === "online") return <>{d}Online</>;
  return <>{w.text}</>;
}

/** a day as the product writes dates: "Aug 2", "Aug 2, 2025" */
export function joinedWords(sec: number): string {
  const d = new Date(sec * 1000);
  return shortDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`) ?? "";
}

export const isOn = (pr: Presence) => pr.state !== "offline";
export const isPlaying = (pr: Presence) => pr.state === "playing";

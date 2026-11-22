/** Game art always comes through the server's art endpoints (resolved + cached server-side, never a 404 for posters); a CSS placeholder is the second safety net. */
import { useEffect, useState, type CSSProperties } from "react";
import { urlBase } from "../api";
import { useArtRevision, versionedArt } from "../art-revisions";

/** `w`: the slot's width in device px; the server sends a copy at most that wide (rounded up to its fixed widths), not the full file */
const sized = (u: string, w?: number) => (w && w > 0 ? `${u}${u.includes("?") ? "&" : "?"}w=${Math.round(w)}` : u);
const named = (u: string, name?: string) => (name ? `${u}?n=${encodeURIComponent(name.slice(0, 120))}` : u);

export const art = {
  poster: (gameId: number, w?: number) => sized(versionedArt(`${urlBase}/api/v1/art/game/${gameId}/poster`, "game", gameId), w),
  banner: (gameId: number, w?: number) => sized(versionedArt(`${urlBase}/api/v1/art/game/${gameId}/banner`, "game", gameId), w),
  /** logo-free key art: the Steam library hero, else the banner, else the placeholder */
  hero: (gameId: number, w?: number) => sized(versionedArt(`${urlBase}/api/v1/art/game/${gameId}/hero`, "game", gameId), w),
  /** the Steam logo PNG (404 when there is none: use it only when the meta says it is readable) */
  logo: (gameId: number) => versionedArt(`${urlBase}/api/v1/art/game/${gameId}/logo`, "game", gameId),
  /** the generated fan card (the Home) */
  card: (gameId: number) => `${urlBase}/api/v1/art/game/${gameId}/card`,
  /** a catalog title's cover (a search hit not on the server yet), resolved by the engine; the placeholder carries `name` */
  title: (titleId: number | string, name?: string, w?: number) => sized(named(`${urlBase}/api/v1/art/title/${titleId}/poster`, name), w),
  steam: (appId: number | string, name?: string, w?: number) => sized(named(`${urlBase}/api/v1/art/steam/${appId}/poster`, name), w),
  steamBanner: (appId: number | string, w?: number) => sized(`${urlBase}/api/v1/art/steam/${appId}/banner`, w),
  /** a store app's logo-free key art (library hero, else the blank placeholder) */
  steamHero: (appId: number | string, w?: number) => sized(`${urlBase}/api/v1/art/steam/${appId}/hero`, w),
  steamLogo: (appId: number | string) => `${urlBase}/api/v1/art/steam/${appId}/logo`,
  proxy: (u: string, w?: number) => sized(`${urlBase}/api/v1/art/url?u=${encodeURIComponent(u)}`, w),
};

/** the best art for a search hit, `w` device px wide: the library game's poster, a catalog title's cover (the engine resolves it),
 *  a Steam app's capsule, or the hit's own image through the server */
export function hitArt(h: { id: { scheme: string; value: string }; name?: string; cover: string | null; gameId?: number | null }, w?: number): string | null {
  if (h.gameId) return art.poster(h.gameId, w);
  if (h.id.scheme === "catalog") return art.title(h.id.value, h.name, w);
  if (h.id.scheme === "steam") return art.steam(h.id.value, h.name, w);
  return h.cover ? art.proxy(h.cover, w) : null;
}

export function Art({ src, title, className, style, lazy = true }: { src: string | null; title: string; className?: string; style?: CSSProperties; lazy?: boolean }) {
  const gameId = src?.match(/\/api\/v1\/art\/game\/(\d+)\//)?.[1];
  useArtRevision("game", gameId);
  if (src && gameId) src = versionedArt(src, "game", gameId);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return <div className={`art-ph${className ? " " + className : ""}`} style={style} title={title} role="img" aria-label={title}><span>{title}</span></div>;
  return <img src={src} alt="" loading={lazy ? "lazy" : undefined} className={className} style={style} onError={() => setFailed(true)} />;
}

/* ─────────── what the server measured about a game's key art and logo ─────────── */

/** a box in image pixels */
export interface PxBox { x: number; y: number; w: number; h: number }
/**
 * GET /api/v1/art/(game/:id | steam/:appid)/meta (contracts/art.md). hero: the key art's size and mean brightness (0..255),
 * null when the hero route serves the blank placeholder; logo: its size, the box of its opaque pixels and `readable`, the
 * share of opaque pixels at 3:1 or more against #101010 (the Spotlight uses the logo when readable >= 0.4); null when none.
 */
export interface ArtMeta {
  hero: { w: number; h: number; mean?: number | null } | null;
  logo: { w: number; h: number; box: PxBox | null; readable: number } | null;
}
const metaCache = new Map<string, ArtMeta | null>();
const metaWait = new Map<string, Promise<ArtMeta | null>>();
export const metaUrl = (kind: "game" | "steam", id: number | string) => `${urlBase}/api/v1/art/${kind}/${id}/meta`;

/** the art meta for a library game or a Steam app; null while loading and when the server has none (then show the title) */
export function useArtMeta(kind: "game" | "steam", id: number | string | null | undefined): ArtMeta | null {
  const revision = useArtRevision(kind, id);
  const key = id == null ? "" : `${kind}:${id}:${revision}`;
  const [meta, setMeta] = useState<ArtMeta | null>(key ? metaCache.get(key) ?? null : null);
  useEffect(() => {
    if (!key) { setMeta(null); return; }
    if (metaCache.has(key)) { setMeta(metaCache.get(key) ?? null); return; }
    setMeta(null);
    let live = true;
    let p = metaWait.get(key);
    if (!p) {
      p = fetch(versionedArt(metaUrl(kind, id!), kind, id!), { credentials: "include" })
        .then(r => (r.ok ? (r.json() as Promise<ArtMeta>) : null))
        .catch(() => null)
        .then(m => { metaCache.set(key, m); metaWait.delete(key); return m; });
      metaWait.set(key, p);
    }
    void p.then(m => { if (live) setMeta(m); });
    return () => { live = false; };
  }, [key]);
  return meta;
}

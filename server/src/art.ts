/**
 * Ahoy — art. Images are fetched once (from Steam's CDN, or from ludarr for library games) and kept under
 * <config>/art, so an <img> in the UI never needs a key and never breaks: when nothing is found a generated
 * placeholder is served instead.
 *
 * The spotlights (Home, Discover, the game pages) need three more things per game:
 *   hero   its logo-free key art: Steam's library hero (never the store header, which carries the logo), else ludarr's banner
 *   logo   Steam's logo PNG, from the first place that has it (logoSources); a miss is remembered on disk, so it is not asked again soon
 *   meta   numbers measured from those files with sharp: the hero's size and mean brightness; the logo's size, the box of its
 *          opaque pixels and the share of them that reads on the page. Kept next to each file and measured again when it changes.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type Sharp from "sharp";
import { configDir } from "./config";
import { FORMER_ART_MARK } from "./former";
import { logger } from "./log";
import { steamArt, steamAssetsShared, type SteamAssets } from "./steam";
import * as ludarr from "./ludarr";

const log = logger("Art");
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", Accept: "image/avif,image/webp,image/*,*/*;q=0.8" };
/** steamAssets: the store's asset tables through steam.ts's shared call (a logo lookup and a hero lookup for one app make one) */
export const adeps = { fetch: fetch as typeof fetch, steamArt, steamAssets: steamAssetsShared, now: () => Date.now() };

const ART_DIR = () => join(configDir(), "art");
// akamaihd.net is Akamai's domain for every customer of theirs: only Steam's own two names on it are Steam
const HOSTS = [/^images\.launchbox-app\.com$/i, /(^|\.)steamstatic\.com$/i, /^steamcdn-a\.akamaihd\.net$/i, /^steamuserimages-a\.akamaihd\.net$/i, /(^|\.)steampowered\.com$/i, /(^|\.)metacritic\.com$/i, /(^|\.)igdb\.com$/i, /(^|\.)gametdb\.com$/i, /^thumbnails\.libretro\.com$/i];
export function allowedUrl(u: string): boolean {
  try { const x = new URL(u); return x.protocol === "https:" && HOSTS.some(h => h.test(x.hostname)); } catch { return false; }
}
/** Steam's own hosts: heroes and logos come from nowhere else */
const STEAM_HOSTS = [/(^|\.)steamstatic\.com$/i, /^steamcdn-a\.akamaihd\.net$/i, /(^|\.)steampowered\.com$/i];
export function steamUrl(u: string): boolean {
  try { const x = new URL(u); return x.protocol === "https:" && STEAM_HOSTS.some(h => h.test(x.hostname)); } catch { return false; }
}
/** wide Steam art (headers, capsules, heroes): fine as a banner, never a poster */
export const wideImage = (u: string | null | undefined): boolean =>
  !!u && /\/(header(_2x)?|capsule_\d+x\d+(_2x)?|hero_capsule(_2x)?|library_hero(_2x)?|page_bg[^/]*)\.jpg/i.test(u);
/** Steam's library hero, the key art without the logo (the store header, which a hero falls back to, has the logo on it) */
export function libraryHero(u: string | null | undefined): boolean {
  try { return !!u && /\/library_hero(_2x)?\.(jpe?g|png|webp)$/i.test(new URL(u).pathname); } catch { return false; }
}

const failed = new Map<string, number>();
const inflight = new Map<string, Promise<CachedImage | null>>();
export interface CachedImage { path: string; type: string }
// pictures made of pixels only: an SVG is a document (it can carry script), and what is kept here is served from Ahoy's own
// address. One kept by an earlier version is no longer found, so no longer served
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
/** the headers every art answer carries: the type is the type (never guessed), and opened as a page it may run and load nothing */
export const ART_HEADERS: Record<string, string> = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
/** the largest picture kept (a 4K PNG key art is 10 MB or so); a longer answer is no picture */
export const artLimit = { bytes: 15 * 1024 * 1024 };
/** an answer's body, read up to `max` bytes; null when it is longer (the rest is not read) */
async function bodyUpTo(res: Response, max: number): Promise<Uint8Array | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) { await res.body?.cancel().catch(() => {}); return null; }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = []; let n = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(n); let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}
/** a GET that follows a redirect only to another allowed address (a redirect is where an allowed host could send the server anywhere, the LAN included) */
async function fetchAllowed(url: string, ok: (u: string) => boolean): Promise<Response> {
  let at = url;
  for (let hop = 0; hop < 4; hop++) {
    const res = await adeps.fetch(at, { headers: UA, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (res.status < 300 || res.status >= 400) return res;
    const to = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    const next = to ? new URL(to, at).toString() : "";
    if (!next || !ok(next)) return new Response(null, { status: 502 });
    at = next;
  }
  return new Response(null, { status: 502 });
}
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));
const key = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 24);
const DAY = 24 * 3600_000;
/**
 * the memos held in memory are bounded: their keys come from session-free URLs, so past `memoLimit.max` entries the oldest one
 * goes. What is on disk stays, so a record let go costs one disk read; a failure let go is only tried again sooner.
 */
export const memoLimit = { max: 5_000 };
function hold<K, V>(m: Map<K, V>, k: K, v: V) {
  m.delete(k);
  m.set(k, v);
  if (m.size > memoLimit.max) { const oldest = m.keys().next(); if (!oldest.done) m.delete(oldest.value); }
}

async function onDisk(k: string): Promise<CachedImage | null> {
  for (const ext of Object.keys(TYPE)) {
    const p = join(ART_DIR(), `${k}.${ext}`);
    if (await stat(p).then(s => s.size > 0, () => false)) return { path: p, type: TYPE[ext] };
  }
  return null;
}
/** an answer's image, kept as <k>.<ext>; null when it is no usable image (or not of a type `accept` takes) */
async function keep(k: string, res: Response, accept: (type: string) => boolean = () => true): Promise<CachedImage | null> {
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!res.ok || !EXT[type] || !accept(type) || (res.headers.get("x-ludarr-art") ?? res.headers.get(FORMER_ART_MARK)) === "placeholder") return null;
  const bytes = await bodyUpTo(res, artLimit.bytes);
  if (!bytes || bytes.length < 400) return null;                               // too large to be art; a 1-pixel "missing" image
  const p = join(ART_DIR(), `${k}.${EXT[type]}`);
  await Bun.write(p, bytes);
  return { path: p, type };
}
async function store(k: string, src: string, load: () => Promise<Response>): Promise<CachedImage | null> {
  const at = failed.get(src);
  if (at && adeps.now() - at < DAY) return null;
  const pending = inflight.get(src);
  if (pending) return pending;
  const job = (async () => {
    try {
      const img = await keep(k, await load());
      if (!img) hold(failed, src, adeps.now());
      return img;
    } catch { hold(failed, src, adeps.now()); return null; }
    finally { inflight.delete(src); }
  })();
  inflight.set(src, job);
  return job;
}

/** the image behind a URL, from disk or fetched once; null when the source has nothing usable */
export async function cachedImage(url: string): Promise<CachedImage | null> {
  if (!allowedUrl(url)) return null;
  await mkdir(ART_DIR(), { recursive: true });
  const k = key(url);
  return (await onDisk(k)) ?? store(k, url, () => fetchAllowed(url, allowedUrl));
}
/** the art kinds the admin set by hand for a game, and when they last changed (ludarr serves those files first) */
const customOf = (gameId: number) => { const g = ludarr.library().find(x => x.id === gameId); return { kinds: g?.customArt ?? [], at: g?.customArtAt ?? 0 }; };
/** a library game's poster or banner, through ludarr (which resolves it from every source it knows); cached a day — art set by
 *  hand is cached under the time it last changed, so a new upload shows at once. hero and logo exist only when set by hand */
export async function gameImage(gameId: number, kind: "poster" | "banner" | "hero" | "logo"): Promise<CachedImage | null> {
  const custom = customOf(gameId);
  const own = custom.kinds.includes(kind);
  if (!own && (kind === "hero" || kind === "logo")) return null;
  await mkdir(ART_DIR(), { recursive: true });
  const source = `ludarr:game:${gameId}:${kind}${own ? `:${custom.at}` : ""}`;
  const k = key(source);
  const hit = await onDisk(k);
  if (hit) { const s = await stat(hit.path).catch(() => null); if (s && adeps.now() - s.mtimeMs < DAY) return hit; }
  return (await store(k, source, () => ludarr.raw(`/api/v1/art/game/${gameId}/${kind}`, { signal: AbortSignal.timeout(20_000) }))) ?? hit;
}
/** a catalog title's cover (a search hit that is not on the server yet), through ludarr, which resolves it from every source it
 *  knows; cached a day like a game's poster */
export async function titleImage(titleId: number): Promise<CachedImage | null> {
  await mkdir(ART_DIR(), { recursive: true });
  const k = key(`ludarr:title:${titleId}:poster`);
  const hit = await onDisk(k);
  if (hit) { const s = await stat(hit.path).catch(() => null); if (s && adeps.now() - s.mtimeMs < DAY) return hit; }
  return (await store(k, `ludarr:title:${titleId}:poster`, () => ludarr.raw(`/api/v1/art/title/${titleId}/poster`, { signal: AbortSignal.timeout(20_000) }))) ?? hit;
}

/* ─────────── smaller copies, for the small slots ─────────── */

/**
 * The widths a smaller copy is made at (the `?w=` of the art routes, rounded up to the next one): a 40 × 60 thumb asks for about
 * 96, a 104 calendar capsule 208, a 204 card 408. A fixed set keeps the copies on disk bounded: at most this many per image.
 */
export const ART_WIDTHS = [64, 96, 128, 160, 208, 256, 320, 408, 480, 640, 800, 1024, 1280, 1600, 1920] as const;
/** the width a `?w=` asks for, rounded up to one of ART_WIDTHS; null when it asks for none (or for nonsense) */
export function artWidth(raw: string | null | undefined): number | null {
  if (raw == null || !/^\d{1,5}$/.test(raw)) return null;
  const w = Number(raw);
  if (w <= 0) return null;
  return ART_WIDTHS.find(x => x >= w) ?? ART_WIDTHS[ART_WIDTHS.length - 1];
}
const sizing = new Map<string, Promise<CachedImage | null>>();
/**
 * An image at most `w` px wide (its height in proportion; never enlarged), as WebP, kept beside the original as
 * <file>.w<w>.webp and made again when the original changes. The original is the answer when sharp is not there, when the
 * file is not a picture sharp reads (an SVG placeholder never comes here), or when making the copy fails.
 */
export const sizedImage = (img: CachedImage, w: number): Promise<CachedImage> => webpImage(img, { w, quality: 80 });
/**
 * The same picture as WebP, at its own size: a generated card's cut-out (an RGBA PNG of 0.1-1.1 MB) is a fifth to a tenth of
 * that at quality 90, its alpha kept exactly (alphaQuality 100), so the cut edge does not change. Kept as <file>.webp.
 */
export const webpCopy = (img: CachedImage): Promise<CachedImage> => webpImage(img, { quality: 90 });
async function webpImage(img: CachedImage, { w, quality }: { w?: number; quality: number }): Promise<CachedImage> {
  if (img.type === "image/svg+xml" || img.type === "image/gif" || img.type === "image/webp" && !w) return img;
  const out = `${img.path}${w ? `.w${w}` : ""}.webp`;
  const [src, have] = await Promise.all([stat(img.path).catch(() => null), stat(out).catch(() => null)]);
  if (!src) return img;
  if (have && have.size > 0 && have.mtimeMs >= src.mtimeMs) return { path: out, type: "image/webp" };
  let job = sizing.get(out);
  if (!job) {
    job = (async () => {
      try {
        const sharp = await sharpLib();
        let pic = sharp(new Uint8Array(await readFile(img.path)), { failOn: "none" }).rotate();
        if (w) pic = pic.resize({ width: w, withoutEnlargement: true });
        const bytes = await pic.webp({ quality, alphaQuality: 100, effort: 4 }).toBuffer();
        await Bun.write(out, bytes);
        return { path: out, type: "image/webp" };
      } catch (e: any) { log.debug(`could not make a WebP copy${w ? ` ${w} px wide` : ""} of ${img.path}: ${e?.message ?? e}`); return null; }
    })().finally(() => sizing.delete(out));
    sizing.set(out, job);
  }
  return (await job) ?? img;
}

/** the poster of a Steam app (the store's library capsule, never its header) */
export async function steamPoster(appId: number): Promise<string | null> {
  const a = await adeps.steamArt(appId).catch(() => null);
  return a?.portrait && !wideImage(a.portrait) ? a.portrait : null;
}
/** a Steam app's wide art: its library hero, else the store header */
export async function steamHero(appId: number): Promise<string | null> {
  const a = await adeps.steamArt(appId).catch(() => null);
  return a?.hero ?? null;
}

/* ─────────── heroes: logo-free key art ─────────── */

const steamAppOf = (gameId: number) => ludarr.library().find(g => g.id === gameId)?.steamAppId ?? null;

/** a Steam app's library hero; null when Steam only has the store header, which carries the logo */
export async function steamHeroImage(appId: number): Promise<CachedImage | null> {
  const u = await steamHero(appId);
  return u && libraryHero(u) && steamUrl(u) ? cachedImage(u) : null;
}
/** a library game's logo-free key art: Steam's library hero for its steamAppId, else ludarr's banner; null when there is neither */
export async function gameHero(gameId: number, steamAppId: number | null = steamAppOf(gameId)): Promise<CachedImage | null> {
  return (await gameImage(gameId, "hero")) ?? (steamAppId ? await steamHeroImage(steamAppId) : null) ?? gameImage(gameId, "banner");
}
/** a Steam app's logo-free key art: its library hero; for a library game Steam has none for, ludarr's banner */
export async function appHero(appId: number): Promise<CachedImage | null> {
  const g = ludarr.library().find(x => x.steamAppId === appId);
  return (await steamHeroImage(appId)) ?? (g ? gameImage(g.id, "banner") : null);
}

/* ─────────── logos ─────────── */

const ASSET_BASE = "https://shared.akamai.steamstatic.com/store_item_assets/";
const CDN_BASES = ["https://cdn.cloudflare.steamstatic.com", "https://shared.akamai.steamstatic.com"];
/** what a logo would be called in the store's asset table (it lists none today: newer apps keep theirs at hashed paths only) */
const LOGO_ASSETS = ["library_logo_2x", "library_logo", "logo_2x", "logo"];
const LOGO_FILES = ["logo_2x.png", "logo.png"];
/** how long an answer holds: a logo is looked at again weekly, a miss daily, a Steam that did not answer in a quarter of an hour */
export const LOGO_TTL = { found: 7 * DAY, missing: DAY, unanswered: 15 * 60_000 };

/** where Steam may keep an app's logo, best first: one the store's asset table lists, the store's asset path (2x, then 1x), the legacy path on both CDN bases */
export function logoSources(appId: number, assets?: SteamAssets | null): string[] {
  const fmt = assets?.asset_url_format;
  const table = (assets ?? {}) as Record<string, unknown>;
  const listed = fmt ? LOGO_ASSETS.map(k => table[k]).filter((f): f is string => typeof f === "string" && f.length > 0).map(f => ASSET_BASE + fmt.replace("${FILENAME}", f)) : [];
  const urls = [...listed, ...LOGO_FILES.map(f => `${ASSET_BASE}steam/apps/${appId}/${f}`), ...LOGO_FILES.flatMap(f => CDN_BASES.map(b => `${b}/steam/apps/${appId}/${f}`))];
  return [...new Set(urls)].filter(steamUrl);
}

/** the last time Steam was asked for an app's logo: when, until when that answer holds, and where the logo came from (null: nowhere) */
interface LogoLook { at: number; until: number; src: string | null }
const looks = new Map<number, LogoLook>();
const logoInflight = new Map<number, Promise<CachedImage | null>>();
const lookPath = (k: string) => join(ART_DIR(), `${k}.look.json`);

async function lastLook(appId: number, k: string): Promise<LogoLook | null> {
  const m = looks.get(appId);
  if (m) return m;
  const d = await Bun.file(lookPath(k)).json().catch(() => null) as LogoLook | null;
  if (!d || typeof d.until !== "number") return null;
  hold(looks, appId, d);
  return d;
}
async function remember(appId: number, k: string, look: LogoLook) {
  hold(looks, appId, look);
  await Bun.write(lookPath(k), JSON.stringify(look)).catch(() => {});
}
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, no) => { t = setTimeout(() => no(new Error("timed out")), ms); })]).finally(() => clearTimeout(t));
}
/** is there a PNG at this address? "unanswered" when Steam could not say (down, slow, throttling) */
async function pngThere(url: string): Promise<"yes" | "no" | "unanswered"> {
  try {
    const r = await adeps.fetch(url, { method: "HEAD", headers: UA, redirect: "follow", signal: AbortSignal.timeout(8_000) });
    if (r.status === 405 || r.status === 501) return "yes";                    // a host that will not answer HEAD: the GET decides
    if (!r.ok) return r.status === 429 || r.status >= 500 ? "unanswered" : "no";
    return /^image\/png\b/i.test(r.headers.get("content-type") ?? "") ? "yes" : "no";
  } catch { return "unanswered"; }
}
const fetchLogo = (k: string, url: string) =>
  fetchAllowed(url, allowedUrl).then(r => keep(k, r, t => t === "image/png")).catch(() => null);

/**
 * every source in order; the plain addresses are asked at once (HEAD) while the store's asset table is read, and their answers
 * are then taken best first: the lookup ends as soon as the best address that has the logo says so, whatever the worse ones
 * (still asking, or slow to time out) will say
 */
async function lookForLogo(appId: number, k: string): Promise<{ img: CachedImage | null; src: string | null; unanswered: boolean }> {
  const plain = logoSources(appId);
  const answers = plain.map(pngThere);
  const assets = await within(adeps.steamAssets([appId]), 8_000).then(m => m.get(appId) ?? null, () => null);
  let unanswered = false;
  for (const u of logoSources(appId, assets).filter(u => !plain.includes(u))) {
    const img = await fetchLogo(k, u);
    if (img) return { img, src: u, unanswered };
    unanswered = true;                                                         // listed, yet it would not come
  }
  for (let i = 0; i < plain.length; i++) {
    const said = await answers[i];
    if (said === "unanswered") unanswered = true;
    if (said !== "yes") continue;
    const img = await fetchLogo(k, plain[i]);
    if (img) return { img, src: plain[i], unanswered };
    unanswered = true;
  }
  return { img: null, src: null, unanswered };
}

/** a Steam app's logo (a PNG on a transparent ground) from disk or from Steam; null when Steam has none */
export async function steamLogo(appId: number): Promise<CachedImage | null> {
  if (!Number.isInteger(appId) || appId <= 0) return null;
  await mkdir(ART_DIR(), { recursive: true });
  const k = key(`steam:logo:${appId}`);
  const [hit, look] = await Promise.all([onDisk(k), lastLook(appId, k)]);
  const now = adeps.now();
  if (hit) {
    const until = look ? look.until : (await stat(hit.path).then(s => s.mtimeMs, () => 0)) + LOGO_TTL.found;   // a file without a record: a week from when it was written
    if (now < until) return hit;
  } else if (look && !look.src && now < look.until) return null;               // asked lately, and Steam had none
  const pending = logoInflight.get(appId);
  if (pending) return pending;
  const job = (async () => {
    const r = await lookForLogo(appId, k).catch(() => ({ img: null, src: null, unanswered: true }));
    const at = adeps.now();
    await remember(appId, k, { at, src: r.img ? r.src : null, until: at + (r.img ? LOGO_TTL.found : r.unanswered ? LOGO_TTL.unanswered : LOGO_TTL.missing) });
    return r.img ?? hit;                                                       // a look that finds nothing keeps the logo we have
  })().finally(() => logoInflight.delete(appId));
  logoInflight.set(appId, job);
  return job;
}
/** a library game's Steam logo; null when it has no Steam app or Steam has no logo */
export async function gameLogo(gameId: number): Promise<CachedImage | null> {
  const own = await gameImage(gameId, "logo");
  if (own) return own;
  const appId = steamAppOf(gameId);
  return appId ? steamLogo(appId) : null;
}

/* ─────────── meta: numbers measured from the files ─────────── */

export interface Box { x: number; y: number; w: number; h: number }
export interface HeroMeta { w: number; h: number; mean: number }
export interface LogoMeta { w: number; h: number; box: Box; readable: number }
export interface ArtMeta { hero: HeroMeta | null; logo: LogoMeta | null }

/** 8-bit sRGB → linear light */
const LINEAR = Array.from({ length: 256 }, (_, v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
/** WCAG relative luminance of an 8-bit sRGB colour */
export const luminance = (r: number, g: number, b: number) => 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b];
/** the page (#101010), and the luminance a colour needs to reach 3:1 against it (nothing darker than the page can) */
const PAGE = luminance(16, 16, 16);
const READS = 3 * (PAGE + 0.05) - 0.05;
/** a logo pixel counts as opaque from this alpha up */
export const OPAQUE = 128;
/**
 * a row or column takes part in the box only with at least this many opaque pixels: one stray pixel of a faded stroke does not
 * move an edge (DARK SOULS III's faded rule has three, one per column, well left of the D)
 */
export const BOX_LINE = 2;

/** the first and last index whose count reaches `min`, as [start, length]; null when none does */
function span(counts: Uint32Array, min: number): [number, number] | null {
  let a = -1, b = -1;
  for (let i = 0; i < counts.length; i++) if (counts[i] >= min) { if (a < 0) a = i; b = i; }
  return a < 0 ? null : [a, b - a + 1];
}
/**
 * a logo's numbers from its RGBA pixels: the box of its opaque pixels (rows and columns holding fewer than `minLine` of them
 * left out, unless that leaves nothing) and the share of them whose colour reaches 3:1 against the page; null when nothing in it is opaque
 */
export function logoNumbers(px: Uint8Array, w: number, h: number, { minAlpha = OPAQUE, minLine = BOX_LINE } = {}): LogoMeta | null {
  const cols = new Uint32Array(w), rows = new Uint32Array(h);
  let n = 0, reads = 0;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      if (px[i + 3] < minAlpha) continue;
      n++; cols[x]++; rows[y]++;
      if (luminance(px[i], px[i + 1], px[i + 2]) >= READS) reads++;
    }
  }
  if (!n) return null;
  const [x, bw] = span(cols, minLine) ?? span(cols, 1)!;
  const [y, bh] = span(rows, minLine) ?? span(rows, 1)!;
  return { w, h, box: { x, y, w: bw, h: bh }, readable: Math.round((reads / n) * 1000) / 1000 };
}
/** mean brightness of RGB(A) pixels, 0-255: the Rec. 709 luma (0.2126 R + 0.7152 G + 0.0722 B) of the 8-bit sRGB values */
export function meanLuma(px: Uint8Array, channels = 3): number {
  let sum = 0;
  for (let i = 0; i < px.length; i += channels) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  return px.length ? sum / (px.length / channels) : 0;
}

/** sharp, loaded on first use: when its native part is missing the art is still served, only without numbers */
let sharpLoad: Promise<typeof Sharp | null> | null = null;
async function sharpLib(): Promise<typeof Sharp> {
  sharpLoad ??= import("sharp").then(m => (m as unknown as { default?: typeof Sharp }).default ?? (m as unknown as typeof Sharp), e => { log.warn(`sharp did not load, so art has no numbers: ${e?.message ?? e}`); return null; });
  const s = await sharpLoad;
  if (!s) throw new Error("sharp is not available");
  return s;
}
/** the hero's displayed size and its mean brightness over every pixel (a transparent ground counts as the page) */
async function measureHero(bytes: Uint8Array): Promise<HeroMeta> {
  const sharp = await sharpLib();
  const { data, info } = await sharp(bytes, { autoOrient: true, failOn: "none" }).flatten({ background: "#101010" }).toColourspace("srgb").removeAlpha().raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, mean: Math.round(meanLuma(data, info.channels) * 10) / 10 };
}
async function measureLogo(bytes: Uint8Array): Promise<LogoMeta | null> {
  const sharp = await sharpLib();
  const { data, info } = await sharp(bytes, { failOn: "none" }).toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
  return info.channels === 4 ? logoNumbers(data, info.width, info.height) : null;
}

/** bump when a measure changes: every cached number is measured again */
const META_VERSION = 2;
const metaMemo = new Map<string, { sig: string; value: unknown }>();
const metaInflight = new Map<string, Promise<unknown>>();
/**
 * a file's numbers: from memory, else from <file>.meta.json beside it, else measured (and kept in both). Either copy only counts
 * while the file has the size and time it had when measured, so a file that changes is measured again. A measure that throws
 * (sharp missing, an unreadable file) is not kept.
 */
async function measured<T>(img: CachedImage | null, kind: "hero" | "logo", measure: (bytes: Uint8Array) => Promise<T | null>): Promise<T | null> {
  if (!img) return null;
  const s = await stat(img.path).catch(() => null);
  if (!s) return null;
  const sig = `${META_VERSION}:${kind}:${s.size}:${Math.round(s.mtimeMs)}`;
  const mem = metaMemo.get(img.path);
  if (mem?.sig === sig) return mem.value as T | null;
  const side = `${img.path}.meta.json`;
  const disk = await Bun.file(side).json().catch(() => null) as { sig?: string; value?: T | null } | null;
  if (disk?.sig === sig) { hold(metaMemo, img.path, { sig, value: disk.value ?? null }); return disk.value ?? null; }
  const flight = `${img.path}|${sig}`;
  const pending = metaInflight.get(flight);
  if (pending) return pending as Promise<T | null>;
  const job = (async () => {
    try {
      const value = await measure(new Uint8Array(await readFile(img.path)));
      hold(metaMemo, img.path, { sig, value });
      await Bun.write(side, JSON.stringify({ sig, value })).catch(() => {});
      return value;
    } catch (e: any) { log.debug(`could not measure ${img.path}: ${e?.message ?? e}`); return null; }
  })().finally(() => metaInflight.delete(flight));
  metaInflight.set(flight, job);
  return job;
}
export const heroMeta = (img: CachedImage | null) => measured(img, "hero", measureHero);
export const logoMeta = (img: CachedImage | null) => measured(img, "logo", measureLogo);

/** what a spotlight needs to know about a library game's art: the numbers of its hero and of its logo (null where it has none) */
export async function gameMeta(gameId: number): Promise<ArtMeta> {
  const appId = steamAppOf(gameId);
  const [hero, logo] = await Promise.all([gameHero(gameId, appId).then(heroMeta), appId ? steamLogo(appId).then(logoMeta) : null]);
  return { hero, logo };
}
/** the same for a Steam app */
export async function appMeta(appId: number): Promise<ArtMeta> {
  const [hero, logo] = await Promise.all([appHero(appId).then(heroMeta), steamLogo(appId).then(logoMeta)]);
  return { hero, logo };
}

/** tests: forget everything held in memory (what is on disk stays, as after a restart) */
export const _test = { forget() { failed.clear(); inflight.clear(); looks.clear(); logoInflight.clear(); metaMemo.clear(); metaInflight.clear(); } };

/* ─────────── placeholders ─────────── */

const esc = (s: string) => s.replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
function wrap(name: string, width: number): string[] {
  const words = name.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width && line) { lines.push(line); line = w; } else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 6);
}
/**
 * what the UI shows when there is no art: a dark poster (2:3) or banner with the title set in the middle; the hero's is the
 * dark ground alone, since the spotlight sets the title over it
 */
export function placeholderSvg(name: string, kind: "poster" | "banner" | "hero" = "poster"): string {
  const [w, h] = kind === "poster" ? [600, 900] : [1920, 620];
  const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  if (kind === "hero") return svg(`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c1c1c"/><stop offset="1" stop-color="#101010"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>`);
  const lines = wrap(name, kind === "poster" ? 16 : 30);
  const size = kind === "poster" ? 52 : 72;
  const y0 = h / 2 - ((lines.length - 1) * size * 1.15) / 2;
  const text = lines.map((l, i) => `<text x="50%" y="${Math.round(y0 + i * size * 1.15)}" text-anchor="middle" font-family="Figtree, Roboto, Arial, sans-serif" font-size="${size}" font-weight="500" fill="#6e6e6e">${esc(l)}</text>`).join("");
  return svg(`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c1c1c"/><stop offset="1" stop-color="#141414"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><rect x="${w * 0.08}" y="${h * 0.06}" width="${w * 0.84}" height="${h * 0.88}" rx="18" fill="none" stroke="#2a2a2a" stroke-width="4"/>${text}`);
}

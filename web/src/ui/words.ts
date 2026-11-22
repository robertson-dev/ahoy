/** Small helpers several screens share: release words, Steam links, which search hits are games, names, devices. */
import { sentence, type LookupHit } from "../api";
import { shortDate } from "../model";
import { art } from "./art";

/** a store app's wide art through the server (the Steam library hero when it has one, else the header) */
export const steamBanner = (appId: number) => art.steamBanner(appId);
export const steamStore = (appId: number) => `https://store.steampowered.com/app/${appId}/`;
/**
 * An address from outside (a catalog's link to a way to play, the engine's address) as something to click: a web page's
 * (http or https), written as the browser reads it, or null. Anything else is not drawn as a link: in the launcher a click on
 * one is handed to Windows, which opens or runs a file's, a share's or another program's address; in a browser a script's runs.
 */
export function webLink(u: string | null | undefined): string | null {
  if (!u) return null;
  try { const at = new URL(u); return at.protocol === "http:" || at.protocol === "https:" ? at.href : null; } catch { return null; }
}
/** "Nov 9", else the store's own words ("November 2026") */
export const releaseLine = (i: { releaseIso: string | null; releaseText: string | null }) => shortDate(i.releaseIso) ?? i.releaseText ?? null;

export const PLATFORM_WORD: Record<string, string> = { pc: "PC", dos: "DOS", ps1: "PlayStation", ps2: "PlayStation 2", ps3: "PlayStation 3", ps4: "PlayStation 4", ps5: "PlayStation 5", psp: "PSP", vita: "PS Vita", switch: "Switch", switch2: "Switch 2", wii: "Wii", wiiu: "Wii U", gc: "GameCube", n64: "Nintendo 64", snes: "SNES", nes: "NES", gb: "Game Boy", gbc: "Game Boy Color", gba: "Game Boy Advance", ds: "DS", nds: "Nintendo DS", "3ds": "3DS", xbox: "Xbox", x360: "Xbox 360", xone: "Xbox One", xsx: "Xbox Series X|S", dc: "Dreamcast", dreamcast: "Dreamcast", saturn: "Saturn", genesis: "Genesis", arcade: "Arcade", mac: "Mac", linux: "Linux" };
/** soundtracks, DLC and demos are not games to get */
export const isGameHit = (h: LookupHit) => !/\b(soundtrack|ost|dlc|demo|playtest|season pass|artbook|art book)\b/i.test(h.name);
/** a hit's second line: year and the platforms that are not Windows ("2017 · Switch"); a store hit with neither says "Steam", any
 *  other says nothing (the catalogue's own source names, "igdb" or "catalog", are not for players) */
export const hitLine = (h: LookupHit) => {
  const plats = (h.platforms ?? []).filter(p => !/^(win|pc|windows)$/i.test(p)).map(p => PLATFORM_WORD[p.toLowerCase()] ?? p).slice(0, 2).join(", ");
  return [h.year, plats].filter(Boolean).join(" · ") || (h.id.scheme === "steam" ? "Steam" : "");
};
/** a store name without the trademark signs (the boards' nameOf): "ELDEN RING NIGHTREIGN" for "ELDEN RING™ NIGHTREIGN" */
export const cleanName = (s: string) => s.replace(/[®™]/g, "").replace(/\s{2,}/g, " ").trim();
/** a Discover row's whole list */
export const listPath = (key: string) => `/discover/list/${encodeURIComponent(key)}`;

/**
 * A signed-in session's device as people say it. The launcher signs in as "Ahoy on K-DESKTOP" (that is K-DESKTOP), a
 * browser as "browser" or with its user agent ("Chrome on Windows").
 */
export function deviceName(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "Somewhere";
  const ahoy = /^Ahoy on (.+)$/i.exec(s);
  if (ahoy) return ahoy[1];
  if (/^browser$/i.test(s)) return "A browser";
  if (/mozilla\/|applewebkit|gecko\//i.test(s)) {
    const app = /edg\//i.test(s) ? "Edge" : /opr\//i.test(s) ? "Opera" : /firefox\//i.test(s) ? "Firefox" : /chrome\//i.test(s) ? "Chrome" : /safari\//i.test(s) ? "Safari" : "A browser";
    const os = /android/i.test(s) ? "Android" : /iphone|ipad/i.test(s) ? "iOS" : /windows/i.test(s) ? "Windows" : /mac os/i.test(s) ? "Mac" : /linux/i.test(s) ? "Linux" : null;
    return os ? `${app} on ${os}` : app;
  }
  return s;
}
/**
 * What the engine said about an address and a key (Settings → Server, the first-run Connect), in plain words: "No engine at …",
 * "The engine refused that key", "Nothing answers at …" (`url`, the address that was tried); never the engine's name or a raw
 * network error ("ECONNREFUSED", "Unable to connect").
 */
export function engineWords(detail: string, url: string): string {
  const d = detail.trim(), u = url.trim();
  let m: RegExpExecArray | null;
  if ((m = /^no ludarr at (\S+)/i.exec(d))) return `No engine at ${m[1]}`;
  if (/refused that API key/i.test(d)) return "The engine refused that key";
  if ((m = /^ludarr answered (.+)$/i.exec(d))) return `The engine answered ${m[1]}`;
  if (/needs to start with http/i.test(d)) return "The address starts with http:// or https://";
  if (/timed? ?out|timeout/i.test(d)) return "No answer in time";
  // the connection itself failed (refused, no such host, no TLS there, cut off): the runtime's own words say no more
  if (/\bE(CONN|HOST|NET|AI_|NOTFOUND|PROTO|PIPE)|unable to connect|TLS|socket|fetch failed|certificate|getaddrinfo/i.test(d)) return u ? `Nothing answers at ${u}` : "Nothing answers there";
  return sentence(d.replace(/\bludarr\b/gi, "the engine"));
}

/** the launcher's platform ("win32") as people say it */
export const platformName = (p: string | null | undefined) => ({ win32: "Windows", darwin: "macOS", linux: "Linux" } as Record<string, string>)[p ?? ""] ?? p ?? "";

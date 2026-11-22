/**
 * Ahoy — settings. Each key: environment variable first, then what the admin saved (kv), then the default.
 * The ludarr connection is the one setting that must exist: the admin enters it on first run.
 */
import { kv } from "./db";
import "./former";

export interface SettingKey { key: string; label: string; doc: string; def?: string; secret?: boolean; type?: "text" | "number" | "select" | "checkbox" | "url"; options?: { value: string; label: string }[] }

export const SETTINGS: SettingKey[] = [
  { key: "LUDARR_URL",            label: "ludarr address", doc: "where the ludarr server lives, as this container reaches it (http://ludarr:7979, or the host's IP and port)", type: "url" },
  { key: "LUDARR_API_KEY",        label: "ludarr API key", doc: "from ludarr → Settings → General; it never leaves this server", secret: true },
  { key: "SIGNUP",                 label: "Who can join", doc: "open: anyone who reaches the server can create an account · invite: a code from an admin is needed · closed: nobody", def: "invite", type: "select", options: [{ value: "open", label: "Anyone on the network" }, { value: "invite", label: "With an invite code" }, { value: "closed", label: "Nobody" }] },
  { key: "TRUSTED_PROXY",          label: "Reverse proxy address", doc: "sign-in limits count tries per visitor address; behind a reverse proxy that address comes from X-Forwarded-For, which is believed only when the proxy itself is the one connecting. Its address (or several, or blocks like 172.17.0.0/16, comma separated); empty: any private or loopback address", def: "" },
  { key: "DISCOVER_REFRESH_MIN",  label: "Storefront feeds refresh (minutes)", doc: "coming soon / new / top sellers", def: "60", type: "number" },
  { key: "METACRITIC_REFRESH_HOURS", label: "Metacritic lists refresh (hours)", doc: "", def: "24", type: "number" },
  { key: "LOG_LEVEL",              label: "Log level", doc: "applies at once", def: "info", type: "select", options: [{ value: "debug", label: "Debug" }, { value: "info", label: "Info" }, { value: "warn", label: "Warning" }, { value: "error", label: "Error" }] },
];
const BY_KEY = new Map(SETTINGS.map(k => [k.key, k]));

export function cfg(key: string): string {
  if (process.env[key]) return process.env[key]!;
  return kv.get("cfg." + key) ?? BY_KEY.get(key)?.def ?? "";
}
export function cfgNum(key: string, fallback: number): number { const v = cfg(key); const n = Number(v); return v !== "" && Number.isFinite(n) ? n : fallback; }
export const setCfg = (key: string, value: string) => { if (!BY_KEY.has(key)) throw new Error(`no setting named ${key}`); kv.set("cfg." + key, value); };
/** "env" when the environment pins it (the UI then shows it read-only) */
export const cfgSource = (key: string): "env" | "saved" | "default" => (process.env[key] ? "env" : kv.get("cfg." + key) != null ? "saved" : "default");

export const configDir = () => process.env.AHOY_CONFIG || ".";
export const port = () => cfgNum("PORT", 8790);
export const VERSION = "0.2.0";

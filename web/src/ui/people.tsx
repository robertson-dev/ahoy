/** Ahoy — the people pieces several screens share: presence words, the feed line, the friend button. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { timeAgo, type ActivityItem, type FriendState, type Person, type Presence } from "../api";
import { act } from "../data";
import { useSession } from "../session";
import { Art, art } from "./art";
import { Avatar } from "./avatar";
import { Button } from "./button";
import { useUi } from "./kit";

export { Avatar } from "./avatar";

/* ─────────── presence, in the product's words ─────────── */

/**
 * When someone was last around, in the product's words: "Seen 2 h ago" within the last 12 hours, "Seen yesterday" on the day
 * before today, else "Seen 3 d ago" / "Seen Sep 27"; "Never seen".
 */
export function seenWords(sec: number | null | undefined, now = new Date()): string {
  if (!sec) return "Never seen";
  const d = new Date(sec * 1000), yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (now.getTime() - d.getTime() >= 12 * 3600_000 && d.toDateString() === yesterday.toDateString()) return "Seen yesterday";
  return `Seen ${timeAgo(sec)}`;
}

/** "Playing Balatro", "Online", "Seen 2 h ago" (the old one-line form) */
export const presenceLine = (p: Presence) => (p.state === "playing" ? `Playing ${p.gameName}` : p.state === "online" ? "Online" : seenWords(p.lastSeen));

/** how long a session has run: "40 min" under an hour, else the clock time it started, "since 9 pm" */
export function playingFor(since: number | null | undefined, now = Date.now()): string | null {
  if (!since) return null;
  const ms = now - since * 1000;
  if (ms < 0) return null;
  if (ms < 3_600_000) return `${Math.max(1, Math.floor(ms / 60_000))} min`;
  const d = new Date(since * 1000), h = d.getHours(), m = d.getMinutes();
  return `since ${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

/** the presence line the boards draw: { game: "Balatro", how: "40 min" } while playing; "Online"; "Seen yesterday" */
export function presenceWords(p: Presence): { state: Presence["state"]; game: string | null; how: string | null; text: string } {
  if (p.state === "playing") { const how = playingFor(p.since); return { state: p.state, game: p.gameName, how, text: `Playing ${p.gameName ?? ""}${how ? ` · ${how}` : ""}` }; }
  if (p.state === "online") return { state: p.state, game: null, how: null, text: "Online" };
  return { state: p.state, game: null, how: null, text: seenWords(p.lastSeen) };
}

/** everyone online on this server but you, the ones playing first */
export const onlineNow = (people: Person[] | null, meId: number | undefined) =>
  (people ?? []).filter(p => p.id !== meId && p.presence.state !== "offline")
    .sort((a, b) => Number(b.presence.state === "playing") - Number(a.presence.state === "playing") || a.displayName.localeCompare(b.displayName));

/* ─────────── the feed ─────────── */

export const FEED_VERB: Record<ActivityItem["kind"], string> = { joined: "joined the harbor", requested: "asked for", tracked: "is tracking", installed: "installed", played: "played", friends: "became friends with", arrived: "got" };

/** one line of the feed: the person, the sentence (names and games bright, the verb quiet), when; the game's poster when it is about one */
export function FeedLine({ a, compact }: { a: ActivityItem; compact?: boolean }) {
  const { me } = useSession();
  const you = !!me && a.user.id === me.id;
  const verb = you && a.kind === "tracked" ? "are tracking" : FEED_VERB[a.kind];
  const other = a.kind === "friends" && a.data?.userName ? <Link to={`/u/${String(a.data.userName)}`} className="strong">{a.name}</Link> : null;
  const game = a.gameId != null ? <Link to={`/game/${a.gameId}`} className="strong">{a.name}</Link> : a.appId != null ? <Link to={`/steam/${a.appId}`} className="strong">{a.name}</Link> : a.name ? <b className="strong">{a.name}</b> : null;
  return (
    <div className={`feed-line${compact ? " compact" : ""}`}>
      <Link to={`/u/${a.user.name}`} className="feed-av" aria-label={a.user.displayName}><Avatar u={a.user} size={compact ? 32 : 40} /></Link>
      {!compact && (a.gameId != null
        ? <Link to={`/game/${a.gameId}`} className="feed-thumb" aria-label={a.name ?? ""}><Art src={art.poster(a.gameId, 96)} title={a.name ?? ""} /></Link>
        : a.appId != null ? <Link to={`/steam/${a.appId}`} className="feed-thumb" aria-label={a.name ?? ""}><Art src={art.steam(a.appId, a.name ?? undefined, 96)} title={a.name ?? ""} /></Link>
        : <span className="feed-thumb none" aria-hidden />)}
      <div className="tx">
        <span><Link to={`/u/${a.user.name}`} className="strong">{you ? "You" : a.user.displayName}</Link> {verb} {other ?? game}{a.kind === "installed" && a.data?.device ? <> on {String(a.data.device)}</> : null}</span>
        <small>{timeAgo(a.at)}</small>
      </div>
    </div>
  );
}

/* ─────────── where you stand with someone ─────────── */

/** Friends ✓ (asks before unfriending) · Asked · withdraw · Accept + Decline · Add friend. `name` is whom it is about, for what a
 *  screen reader hears ("Accept Theo", "Friends with Sasha. Unfriend…", "Asked Rin; withdraw", "Add Mika as a friend") */
export function FriendButton({ id, state, name, onChange, size = 36 }: { id: number; state: FriendState; name?: string; onChange?: () => void; size?: 36 | 44 | 48 }) {
  const { toast, confirm } = useUi();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done?: string) => { setBusy(true); try { await fn(); if (done) toast(done, "success"); onChange?.(); } catch (e: any) { toast(String(e?.message ?? e), "danger"); } finally { setBusy(false); } };
  const say = (words: string) => (name ? words : undefined);
  if (state === "friends") return <Button size={size} icon="tick" pressed busy={busy} aria-haspopup="dialog" aria-label={say(`Friends with ${name}. Unfriend…`)} onClick={async () => { if (await confirm(name ? `Unfriend ${name}?` : "Unfriend?", null, { ok: "Unfriend" })) void run(() => act.unfriend(id)); }}>Friends</Button>;
  if (state === "pending_out") return <Button size={size} busy={busy} aria-label={say(`Asked ${name}; withdraw`)} onClick={() => void run(() => act.unfriend(id), "Withdrawn")}>Asked · withdraw</Button>;
  if (state === "pending_in") return <span className="fb-pair"><Button kind="primary" size={size} icon="tick" busy={busy} aria-label={say(`Accept ${name}`)} onClick={() => void run(() => act.befriend(id), "Friends now")}>Accept</Button><Button size={size} busy={busy} aria-label={say(`Decline ${name}`)} onClick={() => void run(() => act.unfriend(id))}>Decline</Button></span>;
  return <Button size={size} icon="plus" busy={busy} aria-label={say(`Add ${name} as a friend`)} onClick={() => void run(() => act.befriend(id), "Asked")}>Add friend</Button>;
}

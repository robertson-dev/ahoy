/**
 * The avatar: a neutral rounded square (radius 31% of its size, #1e1e1e, a 1 px .14 hairline) with the initials in
 * Bricolage 800 drawn in the person's colour, hsl(hue 65% 72%), so Settings → Colour stays meaningful.
 * The green dot says online or playing (presence), bottom-right.
 * Board: every avatar on M/mine/livefan (32, 44), M/lfs/friends-now (40, 44, 48), M/lfs/friends-roster (40, 44, 96).
 */
import type { CSSProperties } from "react";

/** anything with a name and a colour: a UserRef, a Person, a Presence's user */
export interface AvatarUser { displayName?: string | null; name?: string | null; hue?: number | null }
export type PresenceState = "online" | "playing" | "offline";

export const initialsOf = (u: AvatarUser) =>
  (u.displayName ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join("")
  || (u.name ?? "?").slice(0, 1).toUpperCase();

/** the boards' type scale for the initial: 32 → 15, 44 → 18, 48 → 19 (Home and Friends), 96 → 44 (the profile) */
export const avatarFont = (size: number) => (size <= 48 ? Math.max(Math.round(size * 0.25 + 7), Math.round(size * 0.4)) : Math.round(size * 0.46));

export function Avatar({ u, size = 32, dot, state, title, className, style }: {
  u: AvatarUser;
  size?: number;
  /** draw the presence dot (green) */
  dot?: boolean;
  /** a presence state: online or playing draws the dot (the big screen and older callers pass this) */
  state?: PresenceState;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const on = dot ?? (state != null && state !== "offline");
  const s: CSSProperties = {
    width: size, height: size, borderRadius: Math.round(size * 0.31), fontSize: avatarFont(size),
    ["--hue" as string]: u.hue ?? 0, ...style,
  };
  return (
    <span className={`avatar${size >= 80 ? " xl" : ""}${className ? " " + className : ""}`} style={s} title={title ?? u.displayName ?? undefined} aria-hidden={title ? undefined : true}>
      {initialsOf(u)}
      {on && <i className="avatar-dot" />}
    </span>
  );
}

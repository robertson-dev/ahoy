/**
 * The shelf card (M/disc/picked New & trending, M/lfs/library-wall, the calendars): portrait art with a 1 px inner hairline,
 * the name on one line (ellipsis), one status line; the state's one action appears on hover or focus as a frosted pill on
 * the art (bottom-left, inset 12 on the big cards, 8 on the small ones). A moving game shows its progress on the art:
 * what has arrived is in colour, the rest grey and dimmed, with a 4 px bar 8 px inside the bottom edge.
 *
 * Sizes (width × height, radius): 104 × 156 r12 (Discover's calendar), 128 × 192 r16 (genre rows, profile),
 * 140 × 212 r16, 192 × 288 r20, 204 × 304 r20 (New & trending, the Library wall).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Avatar, type AvatarUser } from "./avatar";
import { Icon } from "./icons";

export type PosterSize = 104 | 128 | 140 | 192 | 204;
export const POSTER: Record<PosterSize, { w: number; h: number; r: number; inset: number; small: boolean }> = {
  104: { w: 104, h: 156, r: 12, inset: 8, small: true },
  128: { w: 128, h: 192, r: 16, inset: 8, small: true },
  140: { w: 140, h: 212, r: 16, inset: 8, small: true },
  192: { w: 192, h: 288, r: 20, inset: 12, small: false },
  204: { w: 204, h: 304, r: 20, inset: 12, small: false },
};

/* ─────────── the art box ─────────── */

/**
 * Portrait art cropped by cover, with the inner hairline. `wide` is the fallback for art that does not fit the shape
 * (a 460 × 215 header): centred on a blurred, darkened copy of itself (Discover's rule). With neither, or when the image
 * fails, the title on a quiet placeholder.
 * `progress` (0..1) draws the arrival fill; `grey` draws it all grey (moving, no number yet).
 */
export function PosterArt({ src, wide, title, w, h, r, progress, grey, className, style, eager }: {
  src: string | null | undefined; wide?: string | null; title: string;
  w: number | string; h: number | string; r: number;
  progress?: number | null; grey?: boolean;
  className?: string; style?: CSSProperties; eager?: boolean;
}) {
  const [bad, setBad] = useState(false);
  const [badWide, setBadWide] = useState(false);
  useEffect(() => { setBad(false); setBadWide(false); }, [src, wide]);
  const box: CSSProperties = { width: w, height: h, borderRadius: r, ...style };
  const lazy = eager ? undefined : "lazy" as const;
  let body: ReactNode;
  if (src && !bad) {
    const moving = progress != null || grey;
    const p = progress == null ? null : Math.max(0, Math.min(1, progress));
    body = <>
      <img className={moving ? "pa-grey" : undefined} src={src} alt="" loading={lazy} draggable={false} onError={() => setBad(true)} />
      {p != null && p > 0 && <span className="pa-fill" style={{ clipPath: `inset(0 calc(100% - (8px + ${p} * (100% - 16px))) 0 0)` }}><img src={src} alt="" loading={lazy} draggable={false} /></span>}
      {p != null && <><span className="pa-scrim" /><span className="pa-bar" style={{ ["--p" as string]: `${(p * 100).toFixed(2)}%` }} /></>}
    </>;
  } else if (wide && !badWide) {
    body = <><img className="pa-blur" src={wide} alt="" loading={lazy} draggable={false} /><img className="pa-wide" src={wide} alt="" loading={lazy} draggable={false} onError={() => setBadWide(true)} /></>;
  } else {
    // the name on the placeholder only where it can be read (not on a 40 px thumbnail)
    body = <span className="pa-ph">{(typeof w !== "number" || w >= 80) && <span>{title}</span>}</span>;
  }
  return <span className={`pa${className ? " " + className : ""}`} style={box} aria-hidden="true">{body}</span>;
}

/* ─────────── the status line ─────────── */

/**
 * One line under a card or a row, in the product's words. Wrap the bright part in <b> ("<b>Jonas</b> is playing",
 * "<b>Arrived 22 h ago</b> · 20 GB"). Optional lead: a 20 px avatar, the green dot (on the server, online) or a check (Tracked).
 */
export function StatusLine({ children, avatar, dot, check, bright, className }: { children: ReactNode; avatar?: AvatarUser | null; dot?: boolean; check?: boolean; bright?: boolean; className?: string }) {
  return (
    <span className={`sl${bright ? " bright" : ""}${className ? " " + className : ""}`}>
      {avatar && <Avatar u={avatar} size={20} />}
      {dot && <i className="sl-dot" aria-hidden />}
      {check && <Icon name="tick" size={12} strokeWidth={2.8} className="sl-check" />}
      <span className="sl-t">{children}</span>
    </span>
  );
}

/* ─────────── the card ─────────── */

export function PosterCard({ to, onOpen, art, wide, title, size = 204, line, action, actionShown, progress, grey, label, className, eager, bare }: {
  /** where the art and the name go (the game page); or `onOpen` for a card that opens something in place */
  to?: string; onOpen?: () => void;
  art: string | null | undefined;
  wide?: string | null;
  title: string;
  size?: PosterSize;
  /** the one status line: a string or a <StatusLine>; its slot is kept when it is empty, so cards in a row stay even */
  line?: ReactNode;
  /** the hover action, usually <GameAction variant="pill" …> */
  action?: ReactNode;
  /** show the action without hover (the boards draw one per kind) */
  actionShown?: boolean;
  progress?: number | null; grey?: boolean;
  /** what a screen reader hears for the card ("Hollow Knight — 41 h played") */
  label?: string;
  className?: string; eager?: boolean;
  /** the capsule and its status line only, no name (Discover's calendar) */
  bare?: boolean;
}) {
  const d = POSTER[size];
  const vars = { ["--w" as string]: `${d.w}px`, ["--h" as string]: `${d.h}px`, ["--in" as string]: `${d.inset}px` };
  const inner = <>
    <PosterArt src={art} wide={wide} title={title} w={d.w} h={d.h} r={d.r} progress={progress} grey={grey} eager={eager} />
    {!bare && <span className="pc-name">{title}</span>}
    <span className="pc-line">{line}</span>
  </>;
  return (
    <div className={`pc${d.small ? " sm" : ""}${bare ? " bare" : ""}${className ? " " + className : ""}`} style={vars}>
      {to ? <Link to={to} className="pc-link" aria-label={label ?? (bare ? title : undefined)}>{inner}</Link>
        : <button type="button" className="pc-link" aria-label={label ?? (bare ? title : undefined)} onClick={onOpen}>{inner}</button>}
      {action && <div className={`pc-act${actionShown ? " shown" : ""}`}>{action}</div>}
    </div>
  );
}

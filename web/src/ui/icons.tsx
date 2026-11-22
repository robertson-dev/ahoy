/** Line icons on a 24px grid (Lucide-style geometry, ISC), plus the redesign boards' own glyphs (install, track, tick, retry, …). */
import type { ReactNode, SVGProps } from "react";

const P: Record<string, ReactNode> = {
  search: <><circle cx="11" cy="11" r="7.5" /><path d="m20.5 20.5-4.2-4.2" /></>,
  play: <path d="M7 4.5v15a.8.8 0 0 0 1.2.7l12.2-7.5a.8.8 0 0 0 0-1.4L8.2 3.8A.8.8 0 0 0 7 4.5z" fill="currentColor" stroke="none" />,
  games: <><rect width="20" height="14" x="2" y="5" rx="4" /><path d="M7 10v4" /><path d="M5 12h4" /><path d="M15 11h.01" /><path d="M18 13h.01" /></>,
  plus: <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  calendar: <><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></>,
  activity: <path d="M22 12h-4l-3 8L9 4l-3 8H2" />,
  wanted: <><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  settings: <><path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.6a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7V20a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.6a2 2 0 0 1 1-1.8l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2" /><circle cx="12" cy="12" r="3" /></>,
  system: <><rect width="20" height="8" x="2" y="2" rx="2" /><rect width="20" height="8" x="2" y="14" rx="2" /><path d="M6 6h.01" /><path d="M6 18h.01" /></>,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m18 15-6-6-6 6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  arrowUp: <><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></>,
  arrowDown: <><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  trash: <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8" /><path d="M21 3v5h-5" /></>,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>,
  volume: <><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a9 9 0 0 1 0 14" /></>,
  volumeOff: <><path d="M11 5 6 9H2v6h4l5 4z" /><path d="m22 9-6 6" /><path d="m16 9 6 6" /></>,
  clock: <><circle cx="12" cy="12" r="9.5" /><path d="M12 7v5l3 2" /></>,
  alert: <><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="9.5" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
  external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  folder: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />,
  drive: <><path d="M22 12H2" /><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z" /><path d="M6 16h.01" /><path d="M10 16h.01" /></>,
  download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M20 15v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4" /></>,
  grid: <><rect width="7" height="7" x="3" y="3" rx="1.5" /><rect width="7" height="7" x="14" y="3" rx="1.5" /><rect width="7" height="7" x="14" y="14" rx="1.5" /><rect width="7" height="7" x="3" y="14" rx="1.5" /></>,
  list: <><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></>,
  filter: <path d="M22 3H2l8 9.5V19l4 2v-8.5z" />,
  sort: <><path d="M8 5v14" /><path d="M4.5 15.5 8 19l3.5-3.5" /><path d="M16 19V5" /><path d="M12.5 8.5 16 5l3.5 3.5" /></>,
  pencil: <><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /><path d="m15 5 4 4" /></>,
  power: <><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.8 0" /></>,
  tv: <><rect width="20" height="14" x="2" y="4" rx="2.5" /><path d="M8 21h8" /><path d="M12 18v3" /></>,
  eye: <><path d="M2.1 12.3a1 1 0 0 1 0-.7 10.8 10.8 0 0 1 19.8 0 1 1 0 0 1 0 .7 10.8 10.8 0 0 1-19.8 0" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M9.9 4.2A10.8 10.8 0 0 1 12 4c5 0 9 3.5 9.9 8a10.9 10.9 0 0 1-1.6 3.4" /><path d="M6.6 6.6A10.9 10.9 0 0 0 2.1 12c.9 4.5 4.9 8 9.9 8 1.5 0 3-.3 4.3-.9" /><path d="m2 2 20 20" /><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></>,
  ban: <><circle cx="12" cy="12" r="9.5" /><path d="m4.9 4.9 14.2 14.2" /></>,
  key: <><path d="m21 2-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" /></>,
  copy: <><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>,
  plug: <><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" /></>,
  box: <><path d="M11 21.7a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7z" /><path d="M12 22V12" /><path d="m3.3 7 7.7 4.7a2 2 0 0 0 2 0L20.7 7" /></>,
  terminal: <><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>,
  sparkles: <path d="M9.9 15.5A2 2 0 0 0 8.5 14l-6.1-1.6a.5.5 0 0 1 0-1L8.5 10A2 2 0 0 0 9.9 8.5l1.6-6.1a.5.5 0 0 1 1 0L14 8.5A2 2 0 0 0 15.5 10l6.1 1.5a.5.5 0 0 1 0 1L15.5 14a2 2 0 0 0-1.5 1.5l-1.5 6.1a.5.5 0 0 1-1 0z" />,
  cpu: <><rect width="16" height="16" x="4" y="4" rx="2" /><rect width="6" height="6" x="9" y="9" rx="1" /><path d="M15 2v2" /><path d="M15 20v2" /><path d="M2 15h2" /><path d="M2 9h2" /><path d="M20 15h2" /><path d="M20 9h2" /><path d="M9 2v2" /><path d="M9 20v2" /></>,
  compass: <><circle cx="12" cy="12" r="9.5" /><path d="m15.8 8.2-2.1 5.5-5.5 2.1 2.1-5.5z" /></>,
  globe: <><circle cx="12" cy="12" r="9.5" /><path d="M12 2.5a14.5 14.5 0 0 0 0 19 14.5 14.5 0 0 0 0-19" /><path d="M2.5 12h19" /></>,
  wand: <><path d="m3 21 9-9" /><path d="M15 4V2" /><path d="M15 16v-2" /><path d="M8 9h2" /><path d="M20 9h2" /><path d="M17.8 11.8 19 13" /><path d="M15 9h.01" /><path d="M17.8 6.2 19 5" /><path d="m3 21 9-9" /><path d="M12.2 6.2 11 5" /></>,
  more: <><circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" /></>,
  save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></>,
  bookmark: <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />,
  bookmarkOff: <><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" /><path d="m4 4 16 16" /></>,
  spinner: <path d="M21 12a9 9 0 1 1-6.2-8.6" />,
  home: <><path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 22V12h6v10" /></>,
  menu: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>,
  file: <><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z" /><path d="M14 2v6h6" /></>,
  upload: <><path d="M12 21V9" /><path d="m17 14-5-5-5 5" /><path d="M20 3H4" /></>,
  tag: <><path d="M12.6 2.6 21 11a1.4 1.4 0 0 1 0 2l-8 8a1.4 1.4 0 0 1-2 0L2.6 12.6A2 2 0 0 1 2 11.2V4a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6z" /><circle cx="7.5" cy="7.5" r="1" fill="currentColor" /></>,

  /* ── the redesign boards' glyphs (M/disc, M/lfs): draw them with strokeWidth 2.2-2.6 at 14-18 px ── */
  /** Play on a pill or a primary button: the board's plain triangle */
  playSolid: <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />,
  /** Install: an arrow into a baseline */
  install: <><path d="M12 4v10" /><path d="m8 10 4 4 4-4" /><path d="M4 19h16" /></>,
  /** the top bar's downloads pill: the same arrow, a little longer */
  transfer: <><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M4 19h16" /></>,
  /** Track: a calendar with a plus (it arrives on release day) */
  track: <><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /><path d="M12 13v5M9.5 15.5h5" /></>,
  /** Tracked, Accept, Friends, Connected */
  tick: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  /** Cancel */
  cancel: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  /** Try again */
  retry: <><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4.5 4.5v4h4" /></>,
  /** the "All ›" link and roster rows */
  chev: <path d="m9.5 6 6 6-6 6" />,
  /** a select's caret */
  chevDown: <path d="m6 9.5 6 6 6-6" />,
  /** the top bar's bell */
  bellBoard: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  /** Lately (the feed) */
  pulse: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  /** Open the engine (leaves the app) */
  out: <><path d="M7.5 16.5 16.5 7.5" /><path d="M9 7.5h7.5V15" /></>,
  /** Your profile */
  user: <><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" /></>,
  /** Friends */
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" /><path d="M18.5 14.2A6.5 6.5 0 0 1 21.5 20" /></>,
  /** Sign out */
  logout: <><path d="M9.5 20.5H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h3.5" /><path d="m15.5 16.5 4.5-4.5-4.5-4.5" /><path d="M20 12H9.5" /></>,
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, className, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" className={`ic${name === "spinner" ? " spin" : ""}${className ? " " + className : ""}`} {...rest}>
      {P[name]}
    </svg>
  );
}

/** the anchor: the mark at the centre of the top bar, drawn as on the boards (64 grid, amber, 5 px stroke) */
export function AnchorMark({ size = 52, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" stroke="var(--lamp)" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <circle cx="32" cy="13" r="5" /><path d="M32 18.5V53M20 27h24M13 37a19 19 0 0 0 38 0M13 37l-5-5M51 37l5-5" />
    </svg>
  );
}

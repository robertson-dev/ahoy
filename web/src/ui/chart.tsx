/**
 * A chart row (M/disc/picked Top sellers and Highest rated): the rank or the score (Bricolage 800 20/28 in a 32 px column,
 * grey for a rank, white for a score), the 40 × 60 capsule, the name (15/600) over one status line (13/500), and the row's
 * action at the end (usually <GameAction variant="row">). 60 px tall; rows sit 8 px apart.
 * The same lead-thumb-text shape serves the feed and the profile's Played lately (pass no `lead`).
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { PosterArt } from "./poster";

export function ChartRow({ lead, score, art, wide, title, to, line, action, label, thumb = [40, 60] }: {
  /** "1" … "10", or the score; omitted for plain rows */
  lead?: ReactNode;
  /** the lead is a score (drawn white) rather than a rank (grey) */
  score?: boolean;
  art: string | null | undefined;
  wide?: string | null;
  title: string;
  to: string;
  /** the status line: a string or a <StatusLine> */
  line?: ReactNode;
  action?: ReactNode;
  label?: string;
  thumb?: [number, number];
}) {
  return (
    <li className="cr">
      {lead != null && <span className={`cr-lead${score ? " score" : ""}`} aria-hidden>{lead}</span>}
      <Link to={to} className="cr-link" aria-label={label}>
        <PosterArt src={art} wide={wide} title={title} w={thumb[0]} h={thumb[1]} r={8} className="cr-thumb" />
        <span className="cr-text"><span className="cr-name">{title}</span>{line != null && line !== "" && <span className="cr-line">{line}</span>}</span>
      </Link>
      {action && <span className="cr-act">{action}</span>}
    </li>
  );
}

/** the list the rows go in (8 px apart) */
export function ChartList({ children, id, label }: { children: ReactNode; id?: string; label?: string }) {
  return <ol className="cr-list" id={id} aria-label={label}>{children}</ol>;
}

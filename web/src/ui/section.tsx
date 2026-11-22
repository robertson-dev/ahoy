/**
 * Section headings, as on every board: Bricolage 800 24/28 (letter-spacing -0.01em), an optional count in Figtree,
 * and the grey "All ›" link on the right with a 36 px hit area that hangs 4 px above and below the 28 px row.
 * The smaller sub-heading (a genre's "Loved by players", Friends' "Want to be friends") is Figtree 600 17/28.
 * Boards: M/disc/picked (New & trending, Coming soon, Top sellers), M/lfs/library-wall (the rail headings), M/lfs/friends-roster (counts).
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon, type IconName } from "./icons";

/** "All ›": goes to the whole list. `label` is what a screen reader hears ("All new and trending games"). `icon` replaces the
 *  chevron (Settings' "Open the engine ↗" takes "out"); an http address opens in a new tab. */
export function AllLink({ to, label, icon = "chev", children = "All" }: { to: string; label?: string; icon?: IconName; children?: ReactNode }) {
  const external = /^https?:/i.test(to);
  const inner = <>{children}<Icon name={icon} size={16} strokeWidth={2.2} /></>;
  return external
    ? <a className="sh-all" href={to} target="_blank" rel="noreferrer" aria-label={label}>{inner}</a>
    : <Link className="sh-all" to={to} aria-label={label}>{inner}</Link>;
}

export function SectionHead({ title, count, all, allLabel, allText, allIcon, right, id, as: H = "h2", className }: {
  title: ReactNode;
  /** a number after the title, in grey Figtree ("Friends 4") */
  count?: number | null;
  /** where "All ›" goes; no link when absent */
  all?: string | null;
  allLabel?: string;
  /** the link's words when they are not "All" ("See your profile") */
  allText?: ReactNode;
  /** the link's glyph when it is not the chevron ("out" for a page outside Ahoy) */
  allIcon?: IconName;
  /** anything between the title and the link (chips, a select) */
  right?: ReactNode;
  id?: string;
  as?: "h1" | "h2" | "h3";
  className?: string;
}) {
  return (
    <div className={`sh${className ? " " + className : ""}`}>
      <H className="sh-title" id={id}>{title}{count != null && <span className="sh-count"><span className="sr-only"> </span>{count}</span>}</H>
      {right && <div className="sh-right">{right}</div>}
      {all && <AllLink to={all} label={allLabel} icon={allIcon}>{allText ?? "All"}</AllLink>}
    </div>
  );
}

/** the smaller heading inside a section (Figtree 600 17/28) */
export function SubHead({ title, count, all, allLabel, right, id, as = "h3" }: { title: ReactNode; count?: number | null; all?: string | null; allLabel?: string; right?: ReactNode; id?: string; as?: "h2" | "h3" | "h4" }) {
  return <SectionHead title={title} count={count} all={all} allLabel={allLabel} right={right} id={id} as={as === "h4" ? "h3" : as} className="sub" />;
}

/** the quiet group label in lists and panels (13/600 grey, with a count): "Want to be friends 1" */
export function GroupLabel({ children, count, id }: { children: ReactNode; count?: number | null; id?: string }) {
  return <h3 className="grp" id={id}>{children}{count != null && <span><span className="sr-only"> </span>{count}</span>}</h3>;
}

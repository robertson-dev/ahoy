/**
 * Small controls in the redesign's language.
 *   Chips      shelf chips with counts, one on (#f2f2f2 pill), the rest a .12 hairline (M/lfs/library-wall, Discover's list chips, Friends | Everyone)
 *   Select     a styled native <select>, 36 tall, an optional leading icon and the caret (Library's sort, Highest rated's year)
 *   Toggle     48 × 28 track on a 48 × 44 target; on = the light track with a dark knob (Settings → Desktop shortcuts)
 *   TextField  a 44 px pill field, optional search icon and a count (Find someone; Settings' wells)
 *   Pill       the top bar's frosted pill (rgba(16,16,16,.6), blur 20, .1 hairline), as a link or a button
 *   EmptyState one quiet block: a heading, a line, an action
 *   Spinner    a small ring
 */
import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon, type IconName } from "./icons";

/* ─────────── chips ─────────── */

export interface ChipItem<K extends string = string> { id: K; label: ReactNode; count?: number | null; title?: string; disabled?: boolean }

/** one chip; `on` draws it as the chosen one */
export function Chip({ on, count, children, className, ...rest }: { on?: boolean; count?: number | null; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`chip${on ? " on" : ""}${className ? " " + className : ""}`} aria-pressed={on} {...rest}>
      {children}{count != null && <i>{count}</i>}
    </button>
  );
}

/** a row of chips, exactly one on */
export function Chips<K extends string>({ items, value, onChange, label, controls, className }: { items: ChipItem<K>[]; value: K; onChange: (id: K) => void; label: string; controls?: string; className?: string }) {
  return (
    <div className={`chips${className ? " " + className : ""}`} role="group" aria-label={label}>
      {items.map(it => <Chip key={it.id} on={it.id === value} count={it.count} title={it.title} disabled={it.disabled} aria-controls={controls} onClick={() => onChange(it.id)}>{it.label}</Chip>)}
    </div>
  );
}

/* ─────────── select ─────────── */

export function Select<V extends string>({ value, onChange, options, label, icon, className, chosen }: {
  value: V; onChange: (v: V) => void; options: { value: V; label: string }[]; label: string;
  /** a leading glyph (the Library's sort arrows) */
  icon?: IconName;
  /** draw it as a chosen chip (Highest rated's "2026 ▾") */
  chosen?: boolean;
  className?: string;
}) {
  return (
    <label className={`sel${icon ? " lead" : ""}${chosen ? " on" : ""}${className ? " " + className : ""}`}>
      {icon && <Icon name={icon} size={16} strokeWidth={2.2} className="sel-lead" />}
      <select aria-label={label} value={value} onChange={e => onChange(e.target.value as V)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Icon name="chevDown" size={16} strokeWidth={2.4} className="sel-caret" />
    </label>
  );
}

/* ─────────── toggle ─────────── */

export function Toggle({ on, onChange, disabled, label, labelledBy }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string; labelledBy?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} aria-labelledby={labelledBy} className={`toggle${on ? " on" : ""}`} disabled={disabled} onClick={e => { e.stopPropagation(); onChange(!on); }} />;
}

/* ─────────── text field ─────────── */

export const TextField = forwardRef<HTMLInputElement, {
  /** a search glyph before the text */
  icon?: IconName;
  /** a "0/200" count at the right end; pass the limit */
  limit?: number;
  /** the darker well used inside panels (Settings) instead of the #161616 field on the page */
  well?: boolean;
  /** CSS width of the whole field */
  width?: number | string;
  /** a key hint at the right end ("/") */
  hint?: string;
  className?: string;
} & InputHTMLAttributes<HTMLInputElement>>(function TextField({ icon, limit, well, width, hint, className, style, ...rest }, ref) {
  const id = useId();
  const len = typeof rest.value === "string" ? [...rest.value].length : 0;
  return (
    <label className={`tf${well ? " well" : ""}${icon ? " lead" : ""}${className ? " " + className : ""}`} style={{ width, ...style }} htmlFor={rest.id ?? id}>
      {icon && <Icon name={icon} size={18} className="tf-lead" />}
      <input ref={ref} id={rest.id ?? id} maxLength={limit} {...rest} />
      {limit != null && <span className="tf-count" aria-hidden>{len}/{limit}</span>}
      {hint && !len && <kbd className="tf-key" aria-hidden>{hint}</kbd>}
    </label>
  );
});

/* ─────────── the top bar's frosted pill ─────────── */

export function Pill({ to, onClick, icon, children, label, className, title, pressed }: { to?: string; onClick?: () => void; icon?: IconName; children: ReactNode; label?: string; className?: string; title?: string; pressed?: boolean }) {
  const inner = <>{icon && <Icon name={icon} size={18} className="fpill-ic" />}{children}</>;
  const cls = `fpill${className ? " " + className : ""}`;
  if (to) return <Link to={to} className={cls} aria-label={label} title={title}>{inner}</Link>;
  return <button type="button" className={cls} onClick={onClick} aria-label={label} title={title} aria-pressed={pressed}>{inner}</button>;
}

/* ─────────── empty and loading ─────────── */

/** a quiet block where content would be: what is missing, and the one thing to do about it */
export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: IconName }) {
  return (
    <div className="es">
      {icon && <Icon name={icon} size={28} className="es-ic" />}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="es-acts">{action}</div>}
    </div>
  );
}

export function Spinner({ label, size = 20, block }: { label?: string; size?: number; block?: boolean }) {
  const ring = <span className="spinner" style={{ width: size, height: size }} role="status" aria-label={label ?? "Loading"} />;
  if (!block) return ring;
  return <div className="spinner-block">{ring}{label && <span>{label}</span>}</div>;
}

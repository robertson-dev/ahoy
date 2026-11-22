/**
 * Buttons, as the boards draw them. Every control is at least 36 px tall; primary actions 44-48.
 *   primary   #f2f2f2 pill, #101010 text (Install, Play, Track on a spotlight; Accept)
 *   secondary rgba(255,255,255,.07) fill, .12 hairline (Details, Cancel, Friends ✓, Check now)
 *   quiet     no fill, grey text, a .06 pill under the pointer (Uninstall, Sign out there, Revoke: anything that asks first)
 *   glass     frosted dark glass on art: rgba(16,16,16,.72) + blur 20 + .1 hairline
 * Sizes 36 (13/700, 14 px icon), 44 (15, 16 px icon), 48 (15, 18 px icon). An icon goes before the label.
 * These are the `.btn` classes (btnClass), so markup that cannot be a <Button> (a download link) draws the same way.
 */
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon, type IconName } from "./icons";

export type ButtonKind = "primary" | "secondary" | "quiet" | "glass";
export type ButtonSize = 36 | 44 | 48;
export const iconSizeFor = (size: ButtonSize) => (size === 48 ? 18 : size === 44 ? 16 : 14);
/** the board's stroke for a glyph at that size */
const strokeFor = (name: IconName) => (name === "tick" || name === "plus" || name === "cancel" ? 2.6 : name === "track" || name === "sort" || name === "chev" ? 2.2 : 2.4);

export const btnClass = (kind: ButtonKind = "secondary", size: ButtonSize = 44, extra?: string) =>
  `btn s${size}${kind === "secondary" ? "" : " " + kind}${extra ? " " + extra : ""}`;

/** the icon a button carries, at the size and stroke the boards use */
export function BtnIcon({ name, size, spin }: { name: IconName; size: number; spin?: boolean }) {
  return <Icon name={spin ? "spinner" : name} size={size} strokeWidth={spin ? 2.4 : strokeFor(name)} />;
}

interface Common { kind?: ButtonKind; size?: ButtonSize; icon?: IconName | null; busy?: boolean; children?: ReactNode }

/**
 * `busy` (working: the spinner) and `unavailable` (cannot be pressed now: Running) keep the button where it is in the focus order:
 * aria-disabled, and a press does nothing. A native `disabled` would drop the focus to the page the moment a pressed button starts
 * working. A busy submit button is disabled natively too, so Enter in its form cannot send the form twice.
 */
export const Button = forwardRef<HTMLButtonElement, Common & { pressed?: boolean; unavailable?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>>(function Button(
  { kind = "secondary", size = 44, icon, busy, pressed, unavailable, disabled, children, className, type = "button", ...rest }, ref) {
  const held = !!(busy || unavailable);
  return (
    <button ref={ref} type={type} className={btnClass(kind, size, className)} aria-pressed={pressed} aria-busy={busy || undefined} {...rest}
      aria-disabled={held || undefined} disabled={disabled || (busy && type === "submit")}
      onClick={held ? e => { e.preventDefault(); e.stopPropagation(); } : rest.onClick}>
      {busy ? <BtnIcon name="spinner" size={iconSizeFor(size)} spin /> : icon ? <BtnIcon name={icon} size={iconSizeFor(size)} /> : null}
      {children}
    </button>
  );
});

/** a link that looks like a button (Details, Open Discover, Edit profile) */
export function ButtonLink({ to, kind = "secondary", size = 44, icon, children, className, ...rest }: Common & { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const external = /^https?:/i.test(to);
  const inner = <>{icon ? <BtnIcon name={icon} size={iconSizeFor(size)} /> : null}{children}</>;
  if (external) return <a href={to} className={btnClass(kind, size, className)} target="_blank" rel="noreferrer" {...rest}>{inner}</a>;
  return <Link to={to} className={btnClass(kind, size, className)} {...rest}>{inner}</Link>;
}

/** a round icon-only button (the bar's back button): glass on art, 44 px */
export function IconButton({ icon, label, size = 44, kind = "glass", className, ...rest }: { icon: IconName; label: string; size?: ButtonSize; kind?: ButtonKind } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={btnClass(kind, size, `round${className ? " " + className : ""}`)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size === 36 ? 16 : 20} strokeWidth={2.2} />
    </button>
  );
}

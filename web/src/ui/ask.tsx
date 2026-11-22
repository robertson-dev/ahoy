/**
 * Ask: a destructive action that asks first, in place (M/lfs/settings, Balatro's Uninstall). Closed, it is the quiet
 * button. Open, it is Cancel (quiet) and the white confirming button, which takes the focus; Esc or Cancel closes it and
 * gives the focus back to the quiet button. The caller decides what else changes while it asks (Settings brightens the
 * folder and Open folder steps aside) and keeps `open`, so one row asks at a time.
 * Used by Settings (Uninstall, Remove, Change server, Sign out there, Revoke) and GameAction's full form (Uninstall).
 */
import { useEffect, useRef, useState } from "react";
import { Button, type ButtonSize } from "./button";
import type { IconName } from "./icons";

export function Ask({ open, onOpen, onClose, label, confirm, onConfirm, aria, confirmAria, size = 36, confirmSize = size === 36 ? 44 : size, icon, className }: {
  open: boolean; onOpen: () => void; onClose: () => void;
  /** the quiet button's words ("Uninstall", "Change…") */
  label: string;
  /** the confirming button's words, when they are not the label's ("Change server") */
  confirm?: string;
  onConfirm: () => Promise<unknown> | void;
  aria?: string; confirmAria?: string;
  /** the quiet button and Cancel (36 in Settings' rows, 48 on a spotlight); the confirm is 44 beside 36s, else the same */
  size?: ButtonSize; confirmSize?: ButtonSize;
  /** a glyph before the quiet button's words (the game page's trash) */
  icon?: IconName;
  /** on the quiet button (Settings' flush-right `st-flush`) */
  className?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open && refocus.current) { refocus.current = false; trigger.current?.focus(); } }, [open]);
  if (!open) return <Button ref={trigger} kind="quiet" size={size} icon={icon} className={className} aria-label={aria} onClick={onOpen}>{label}</Button>;
  const cancel = () => { refocus.current = true; onClose(); };
  const go = async () => { setBusy(true); try { await onConfirm(); } catch { /* the caller says what went wrong */ } finally { setBusy(false); onClose(); } };
  return (
    <span className="ask" onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}>
      <Button kind="quiet" size={size} onClick={cancel}>Cancel</Button>
      <Button kind="primary" size={confirmSize} busy={busy} autoFocus aria-label={confirmAria} onClick={() => void go()}>{confirm ?? label}</Button>
    </span>
  );
}

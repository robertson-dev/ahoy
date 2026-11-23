/**
 * Settings — the pieces the sections share, private to the screen (board: M/lfs/settings/Settings.dc.html).
 *   Section    the Bricolage heading (with its grey link) over a #161616 panel, rows 76 tall split by .06 hairlines
 *   Row        the 180 px label, the values from the page column (204 into the panel), the actions flush right
 *   ListRow    a row holding short lines of 44 (Signed in on, Invite codes); the label sits on the first line
 *   Radios     chips that pick one (New accounts, Log level)
 *   HueSlider  every hue the avatar rule can draw (65 % 72 %), the thumb on the person's hue
 *   NumberWell a 88 px well that saves when it is left (Discover refresh, Metacritic lists refresh)
 * and the screen's words (roles). Asking first in place is the shared ui/ask Ask; device and platform names are ui/words'.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { sentence } from "../api";
import { Button } from "../ui/button";
import { Spinner, TextField } from "../ui/controls";
import { Icon } from "../ui/icons";

/* ─────────── words ─────────── */

/**
 * What went wrong, in the product's words, never the plumbing's:
 *   - nothing came back (the network dropped, the server restarting, a proxy's bare "HTTP 502"): "The server did not
 *     answer", or "The launcher did not answer" for the launcher's own calls;
 *   - the launcher's call wrapping ("Error invoking remote method 'uninstall': Error: …") is dropped, and a system error
 *     code becomes plain words (a file in use, a file missing, no room on the disk);
 *   - anything else is the server's or the launcher's own sentence, sentence-cased ("The current password is wrong").
 */
export function errText(e: unknown, from: "server" | "launcher" = "server"): string {
  const raw = String(e != null && typeof e === "object" && "message" in e ? (e as { message: unknown }).message : e ?? "").trim();
  const m = raw.replace(/^Error invoking remote method '[^']*':\s*/i, "").replace(/^[A-Za-z]*Error:\s*/, "").trim();
  const silent = from === "launcher" ? "The launcher did not answer" : "The server did not answer";
  if (!m || e instanceof TypeError || /^(failed to fetch|load failed|network ?error)/i.test(m) || /^HTTP \d+$/.test(m) || /is it restarting\?/i.test(m)) return silent;
  const code = /^(E[A-Z]{2,})\b/.exec(m)?.[1];
  if (code) return code === "ENOSPC" ? "There is no room left on the disk" : code === "ENOENT" ? "A file is missing" : /^E(BUSY|PERM|ACCES)$/.test(code) ? "A file is in use or locked" : silent;
  return sentence(m);
}
export const roleWords = (role: string) => (role === "admin" ? "Runs this server" : "Member");

/* ─────────── the section and its rows ─────────── */

export function Section({ id, title, link, children }: { id: string; title: string; link?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="st-sec" aria-labelledby={`${id}-h`}>
      <div className="sh st-head"><h2 className="sh-title" id={`${id}-h`} tabIndex={-1}>{title}</h2>{link}</div>
      <div className="st-panel">{children}</div>
    </section>
  );
}

export function Row({ label, htmlFor, labelId, top, actions, children, className, form }: {
  /** null keeps the label's column empty (the engine's Test / Save row) */
  label: string | null;
  /** the field the label names */
  htmlFor?: string;
  /** for aria-labelledby (a switch, a radio group) */
  labelId?: string;
  /** the label sits on the first of two lines (Launcher) */
  top?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** the row is a form (Enter in its fields submits; fields elsewhere join it with form={id}) */
  form?: { id?: string; onSubmit: (e: FormEvent) => void };
}) {
  const lab = label == null ? <span className="st-label" aria-hidden />
    : htmlFor ? <label className="st-label" htmlFor={htmlFor} id={labelId}>{label}</label>
    : <span className="st-label" id={labelId}>{label}</span>;
  const cls = `st-row${top ? " st-row-top" : ""}${className ? " " + className : ""}`;
  const inner = <>{lab}<div className="st-body">{children}</div>{actions && <div className="st-acts">{actions}</div>}</>;
  if (form) return <form className={cls} id={form.id} noValidate onSubmit={e => { e.preventDefault(); form.onSubmit(e); }}>{inner}</form>;
  return <div className={cls}>{inner}</div>;
}

/** a row of short lines (16 + 44 per line + 16) */
export function ListRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="st-row st-list"><span className="st-label">{label}</span><div className="st-lines">{children}</div></div>;
}
export const Line = ({ children, end }: { children: ReactNode; end?: boolean }) => <div className={`st-line${end ? " st-line-end" : ""}`}>{children}</div>;

/** while a panel's data comes */
export const LoadingRow = ({ label = "Loading" }: { label?: string }) => <div className="st-row st-wait"><Spinner label={label} /></div>;
/** when it did not come: what went wrong, and Try again */
export const ErrorRow = ({ text, onRetry }: { text: string; onRetry: () => void }) => (
  <div className="st-row st-wait"><span className="st-v st-bad">{text}</span><Button size={36} icon="retry" onClick={onRetry}>Try again</Button></div>
);

/* ─────────── controls ─────────── */

/** chips that pick one, with the arrow keys moving the choice (a radio group) */
export function Radios<V extends string>({ value, options, onChange, labelledBy, disabled, title }: {
  value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; labelledBy: string; disabled?: boolean; title?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = options.findIndex(o => o.value === value);
  const key = (e: KeyboardEvent, i: number) => {
    const n = options.length;
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(options[to].value);
    refs.current[to]?.focus();
  };
  return (
    <div className="st-radios" role="radiogroup" aria-labelledby={labelledBy} title={title}>
      {options.map((o, i) => (
        <button key={o.value} ref={el => { refs.current[i] = el; }} type="button" role="radio" aria-checked={i === at}
          tabIndex={i === at || (at < 0 && i === 0) ? 0 : -1} className={`chip${i === at ? " on" : ""}`} disabled={disabled}
          onClick={() => { if (i !== at) onChange(o.value); }} onKeyDown={e => key(e, i)}>{o.label}</button>
      ))}
    </div>
  );
}

const HUE_STOPS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 359];
/** the colour slider: the track shows every hue the avatar rule can draw; the thumb sits on the person's hue */
export function HueSlider({ id, hue, onChange }: { id: string; hue: number; onChange: (h: number) => void }) {
  const at = (h: number) => `calc(10px + ${(h / 359).toFixed(4)} * (100% - 20px))`;
  const track = `linear-gradient(90deg, ${HUE_STOPS.map(h => `hsl(${h} 65% 72%) ${at(h)}`).join(", ")})`;
  return (
    <span className="st-hue">
      {/* data-pad-solid: drawn see-through under its own track and knob, and still a stop for a pad (big/pad.ts) */}
      <input id={id} type="range" min={0} max={359} step={1} value={hue} onChange={e => onChange(Number(e.target.value))} aria-label="Colour" data-pad-solid="" />
      <span className="st-hue-track" style={{ background: track }} aria-hidden />
      <span className="st-hue-thumb" style={{ left: `calc(${(hue / 359).toFixed(4)} * (100% - 20px))` }} aria-hidden />
    </span>
  );
}

/** a whole number in a small well; it saves when it is left (or on Enter), and Esc puts the saved value back */
export function NumberWell({ id, value, onCommit, min = 1, max = 100_000, disabled, title }: {
  id: string; value: string; onCommit: (v: string) => void; min?: number; max?: number; disabled?: boolean; title?: string;
}) {
  const [v, setV] = useState(value);
  const last = useRef(value);   // what was saved last (or came from the server), so Enter and the blur after it save once
  useEffect(() => { setV(value); last.current = value; }, [value]);
  const commit = (raw: string) => {
    const n = Math.round(Number(raw));
    if (raw.trim() === "" || !Number.isFinite(n)) { setV(last.current); return; }
    const c = String(Math.min(max, Math.max(min, n)));
    setV(c);
    if (c !== last.current) { last.current = c; onCommit(c); }
  };
  return (
    <TextField well id={id} className="st-w88" type="number" inputMode="numeric" min={min} max={max} step={1} value={v} disabled={disabled} title={title}
      onChange={e => setV(e.target.value)} onBlur={e => commit(e.currentTarget.value)}
      onKeyDown={e => {
        if (e.key === "Enter") { commit(e.currentTarget.value); e.currentTarget.blur(); }
        else if (e.key === "Escape") { e.stopPropagation(); setV(last.current); }
      }} />
  );
}

/**
 * A line of text in a well; like NumberWell it saves when it is left (or on Enter), and Esc puts the saved value back. `fit`
 * reads what was typed as the value to save, or null when it is not one: nothing is saved and `onRefuse` is told (the typed text
 * stays while the field has the focus, so it can be put right; leaving the field puts the saved value back).
 */
export function TextWell({ id, value, onCommit, fit = s => s.trim(), onRefuse, placeholder, className = "st-w360", disabled, title }: {
  id: string; value: string; onCommit: (v: string) => void; fit?: (raw: string) => string | null; onRefuse?: () => void;
  placeholder?: string; className?: string; disabled?: boolean; title?: string;
}) {
  const [v, setV] = useState(value);
  const last = useRef(value);   // what was saved last (or came from the server), so Enter and the blur after it save once
  const told = useRef<string | null>(null);   // the text Enter was last refused for: leaving the field with it still there says nothing more
  useEffect(() => { setV(value); last.current = value; }, [value]);
  const commit = (raw: string, leaving: boolean): boolean => {
    const c = fit(raw);
    if (c == null) {
      if (!(leaving && told.current === raw)) onRefuse?.();
      told.current = leaving ? null : raw;
      if (leaving) setV(last.current);
      return false;
    }
    told.current = null;
    setV(c);
    if (c !== last.current) { last.current = c; onCommit(c); }
    return true;
  };
  return (
    <TextField well id={id} className={className} type="text" spellCheck={false} autoComplete="off" value={v} placeholder={placeholder} disabled={disabled} title={title}
      onChange={e => setV(e.target.value)} onBlur={e => commit(e.currentTarget.value, true)}
      onKeyDown={e => {
        if (e.key === "Enter") { if (commit(e.currentTarget.value, false)) e.currentTarget.blur(); }
        else if (e.key === "Escape") { e.stopPropagation(); setV(last.current); }
      }} />
  );
}

/**
 * The reverse proxy's addresses as the server reads them (server/src/ratelimit.ts): IPv4 and IPv6 addresses and IPv4 blocks
 * ("172.17.0.0/16"), separated by commas or spaces. What was typed, tidied ("a, b"; nothing typed is "", any private address), or
 * null when a piece is none of those: saved as it is, the server would find no proxy in it and count every visitor as one address.
 */
export function proxyList(raw: string): string | null {
  const v4 = (a: string) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a); return !!m && m.slice(1).every(x => Number(x) <= 255); };
  const v6 = (a: string) => a.split(":").length > 2 && /^[0-9a-f:.]{2,45}$/i.test(a);   // two colons at least: "10.0.0.1:8080" is none
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  for (const p of parts) {
    const [net, bits, more] = p.split("/");
    if (more !== undefined) return null;
    if (bits === undefined ? !(v4(net) || v6(net)) : !(v4(net) && /^\d{1,2}$/.test(bits) && Number(bits) <= 32)) return null;
  }
  return parts.join(", ");
}

/** the line under the engine's Test and Save: a tick and "Connected", or what went wrong */
export const Result = ({ ok, text }: { ok: boolean; text: string }) => (
  <span className={`st-result${ok ? "" : " st-bad"}`} role="status"><Icon name={ok ? "tick" : "cancel"} size={16} strokeWidth={2.6} /><span>{text}</span></span>
);

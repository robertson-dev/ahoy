/** Ahoy web — the app-wide pieces: the dialog (Modal), toasts and the confirm dialog (useUi). The controls are in ./controls, ./button and friends. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./button";
import { Icon } from "./icons";
import { LEAVE_MS, leavingProps, usePresence } from "./motion";

/* ─────────── modal ─────────── */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';
const focusables = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(x => x.offsetParent !== null || x === document.activeElement);

/**
 * The keyboard in a dialog (Modal, the trailers' Viewer): while it is open the focus is inside it (the element marked
 * data-autofocus or React's autoFocus, else the first control of its body, else the dialog itself) and Tab cycles inside it;
 * when it closes, the focus goes back to what had it before (the button that opened it), if that is still on the page.
 */
export function useDialogFocus(open: boolean, box: { current: HTMLElement | null }) {
  // what had the focus is read while the dialog renders, before an autoFocus inside it (the confirm's button) takes it
  const back = useRef<HTMLElement | null>(null), was = useRef(false);
  if (open && !was.current) back.current = document.activeElement as HTMLElement | null;
  was.current = open;
  useEffect(() => {
    if (!open) return;
    const el = box.current;
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(el).find(x => !x.closest("[data-dialog-head]")) ?? focusables(el)[0];
      (first ?? el).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !el) return;
      const f = focusables(el);
      if (!f.length) { e.preventDefault(); el.focus(); return; }
      const at = document.activeElement as HTMLElement | null, i = at ? f.indexOf(at) : -1;
      if (e.shiftKey ? i <= 0 : i === -1 || i === f.length - 1) { e.preventDefault(); (e.shiftKey ? f[f.length - 1] : f[0]).focus(); }
    };
    addEventListener("keydown", onKey, true);
    return () => {
      removeEventListener("keydown", onKey, true);
      const b = back.current;
      if (b && b.isConnected && b !== document.body && !el?.contains(b)) b.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/**
 * A dialog over the page. It renders into a portal on document.body, so wherever it is mounted (a card's hover slot, a
 * transformed fan, a fading stage) no ancestor can trap it under the top bar. The shell's panels treat a click inside a
 * dialog (`.overlay`) as their own (shell/popover.tsx), so a dialog opened from one does not close it. The focus moves into it
 * and back to its trigger when it closes (useDialogFocus). Closing, it goes out of focus with the veil behind it, still showing
 * what it last showed (a confirm's title and body are cleared the moment it closes).
 */
export function Modal({ open, onClose, title, children, foot, wide, sm }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; foot?: ReactNode; wide?: boolean; sm?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const { mounted, leaving } = usePresence(open);
  const last = useRef({ title, children, foot });
  if (open) last.current = { title, children, foot };
  const shown = open ? { title, children, foot } : last.current;
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    addEventListener("keydown", on, true);
    return () => removeEventListener("keydown", on, true);
  }, [open, onClose]);
  useDialogFocus(open, box);
  if (!mounted) return null;
  return createPortal(
    <div className="overlay" {...leavingProps(leaving)} onMouseDown={e => { if (open && e.target === e.currentTarget) onClose(); }}>
      <div ref={box} tabIndex={-1} className={`modal${wide ? " wide" : ""}${sm ? " sm" : ""}`} role="dialog" aria-modal="true" aria-label={typeof shown.title === "string" ? shown.title : undefined}>
        <div className="modal-head" data-dialog-head><span>{shown.title}</span><button type="button" className="ibtn" title="Close" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button></div>
        {shown.children != null && shown.children !== false && <div className="modal-body">{shown.children}</div>}
        {shown.foot && <div className="modal-foot">{shown.foot}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ─────────── toasts + confirm (app-wide) ─────────── */

interface Toast { id: number; text: ReactNode; tone: "info" | "success" | "danger" | "warning"; leaving?: boolean }
interface ConfirmReq { title: string; body: ReactNode; ok?: string; resolve: (v: boolean) => void }
/** one of a few things to pick: its id, its words, and whether it is the one picked now */
export interface Choice { id: string; label: string }
interface ChooseReq { title: string; options: Choice[]; current: string | null; resolve: (id: string | null) => void }
/** toast: `ms` is how long it stays, when not the tone's own (4 s; 8 s for a failure) */
interface UiCtx {
  toast: (text: ReactNode, tone?: Toast["tone"], ms?: number) => void;
  confirm: (title: string, body: ReactNode, opt?: { ok?: string }) => Promise<boolean>;
  /** a question with a few answers (which version of a game): the id picked, or null when it was closed */
  choose: (title: string, options: Choice[], current?: string | null) => Promise<string | null>;
}
const Ctx = createContext<UiCtx>({ toast: () => {}, confirm: async () => false, choose: async () => null });
export const useUi = () => useContext(Ctx);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null);
  const [chooseReq, setChooseReq] = useState<ChooseReq | null>(null);
  const seq = useRef(0);
  const toast = useCallback((text: ReactNode, tone: Toast["tone"] = "info", ms?: number) => {
    const id = ++seq.current;
    const life = ms && ms > LEAVE_MS ? ms : tone === "danger" ? 8000 : 4000;
    setToasts(t => [...t, { id, text, tone }]);
    // it goes out of focus for its last moment, then goes
    setTimeout(() => setToasts(t => t.map(x => (x.id === id ? { ...x, leaving: true } : x))), life - LEAVE_MS);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), life);
  }, []);
  const confirm = useCallback((title: string, body: ReactNode, opt: { ok?: string } = {}) => new Promise<boolean>(resolve => setConfirmReq({ title, body, ok: opt.ok, resolve })), []);
  const choose = useCallback((title: string, options: Choice[], current: string | null = null) => new Promise<string | null>(resolve => setChooseReq({ title, options, current, resolve })), []);
  const value = useMemo(() => ({ toast, confirm, choose }), [toast, confirm, choose]);
  const answer = (v: boolean) => { confirmReq?.resolve(v); setConfirmReq(null); };
  const pick = (id: string | null) => { chooseReq?.resolve(id); setChooseReq(null); };
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">{toasts.map(t => <div key={t.id} className={`toast ${t.tone}`} {...leavingProps(!!t.leaving)}>{t.text}</div>)}</div>
      <Modal open={!!confirmReq} onClose={() => answer(false)} title={confirmReq?.title ?? ""} sm
        foot={<><Button kind="quiet" size={44} onClick={() => answer(false)}>Cancel</Button><Button kind="primary" size={44} onClick={() => answer(true)} autoFocus>{confirmReq?.ok ?? "Delete"}</Button></>}>
        {confirmReq?.body}
      </Modal>
      <Modal open={!!chooseReq} onClose={() => pick(null)} title={chooseReq?.title ?? ""} sm>
        <div className="pick" role="group" aria-label={chooseReq?.title}>
          {chooseReq?.options.map((o, i) => (
            <button key={o.id} type="button" className="pick-row" aria-pressed={o.id === chooseReq.current} data-autofocus={(chooseReq.current ? o.id === chooseReq.current : i === 0) ? "" : undefined} onClick={() => pick(o.id)}>
              <span>{o.label}</span>{o.id === chooseReq.current && <Icon name="tick" size={16} strokeWidth={2.6} />}
            </button>
          ))}
        </div>
      </Modal>
    </Ctx.Provider>
  );
}

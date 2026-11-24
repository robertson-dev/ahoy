/**
 * Ahoy — Big screen. The app as it is, for the couch: the same top bar and pages on the whole display, everything larger
 * (mode.ts), and a pad or the arrow keys in place of the mouse (pad.ts). Nothing here is another interface: what the pad
 * rests on is hovered and focused like any control, A is a click, B is Back.
 *
 *   A / Enter         click what is focused; on a text field, the on-screen keyboard; on a choice list, its choices
 *   B / Esc           close what is open (the keyboard, a dialog, a panel of the bar), else go back a page
 *   LB RB / PgUp PgDn the tab before or after (Home, Discover, Library, Friends)
 *   Y or "/"          search          View   friends          Menu   your account's menu (Leave big screen is in it)
 *   X                 the focused card's own action (Install, Play, Request: the pill a mouse sees on hover); else downloads
 *   right stick       scrolls the page
 *   F11               leave (and enter, from anywhere)
 *
 * The focus shows from the start (a handheld has no mouse to say where the person is); moving the pointer hides it, and the
 * next press of the pad only brings it back, on something that is on screen. It is the sign-in page's too (BigHost sits
 * outside the session's gate): a handheld signs in with its pad.
 * With the keyboard, typing goes to the field that has the focus as always; the arrows leave a field only up and down.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Navigate, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { launcher } from "../launcher";
import { Icon, type IconName } from "../ui/icons";
import { bigMode } from "./mode";
import { listenInput, type Cmd, type Dir } from "./nav";
import { PadNav, arrowKey, cardAction, describe, findAgain, isTextField, ownsArrow, sendKey, setValue, stepRange, whereIn } from "./pad";
import "./big.css";

export const useBig = () => useSyncExternalStore(bigMode.subscribe, () => bigMode.on, () => false);
/** is the big screen at a handheld's size (five games across a wall, not four and a gap)? */
export const useHands = () => useSyncExternalStore(bigMode.subscribe, () => bigMode.hands, () => false);

/** the tabs LB and RB walk, and which one a page belongs to (the top bar's own four) */
export const BIG_TABS = ["/", "/discover", "/library", "/people"] as const;
export function tabOf(path: string): number {
  if (path === "/") return 0;
  if (path.startsWith("/discover") || path.startsWith("/steam/") || path.startsWith("/search")) return 1;
  if (path.startsWith("/library") || path.startsWith("/downloads") || path.startsWith("/game/")) return 2;
  if (path.startsWith("/people") || path.startsWith("/u/")) return 3;
  return -1;
}
/** the tab one step from the page's own; from a page that belongs to none, the first or the last */
export const tabStep = (path: string, by: 1 | -1): string => {
  const at = tabOf(path), n = BIG_TABS.length;
  return BIG_TABS[at < 0 ? (by > 0 ? 0 : n - 1) : (at + by + n) % n]!;
};

/**
 * The keys and the pad, heard once for the whole stay; the handlers are whatever the last render gave. Listening anew when the
 * layer or the search changed forgot which pad buttons were down: one press of A opened a game and pressed its first action,
 * a held key on the on-screen keyboard typed a letter a frame.
 */
export function useInput(onCmd: (c: Cmd) => void, onKey: (e: KeyboardEvent) => boolean, onPadSeen: () => void) {
  const now = useRef({ onCmd, onKey, onPadSeen });
  now.current = { onCmd, onKey, onPadSeen };
  useEffect(() => listenInput(c => now.current.onCmd(c), e => now.current.onKey(e), () => now.current.onPadSeen()), []);
}

/* ─────────── the on-screen keyboard ─────────── */

const LETTERS = ["1234567890", "qwertyuiop", "asdfghjkl'", "zxcvbnm,.-"];
/** where the focus starts on the keys: the middle of the letters, a short way from any of them */
const START_KEY = "g";
const SYMBOLS = ["1234567890", "!@#$%^&*()", "-_=+[]{};:", "\"'/\\?<>|~`"];
/** what one key does to the text: the text after it */
export function typeKey(text: string, key: string): string {
  if (key === "back") return text.slice(0, -1);
  if (key === "clear") return "";
  if (key === "space") return text + " ";
  return text + key;
}

/** the field a form wants filled in after this one: its next text field that is still empty (a sign-in's password after its
 *  name). Done on the keyboard goes there instead of sending the form half filled in */
export function nextEmptyField(field: HTMLInputElement | HTMLTextAreaElement): HTMLInputElement | HTMLTextAreaElement | null {
  if (!field.form) return null;
  const fields = [...field.form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].filter(e => isTextField(e) && e.getClientRects().length > 0);
  const at = fields.indexOf(field);
  return at < 0 ? null : fields.slice(at + 1).find(e => !e.value) ?? null;
}

function Keyboard({ field, onDone }: { field: HTMLInputElement | HTMLTextAreaElement; onDone: (submit: boolean) => void }) {
  const [shift, setShift] = useState(false), [symbols, setSymbols] = useState(false);
  const [text, setText] = useState(field.value);
  const put = (key: string) => { const next = typeKey(field.value, shift && key.length === 1 ? key.toUpperCase() : key); setValue(field, next); setText(next); if (shift) setShift(false); };
  // typing on a real keyboard goes to the field itself: what it holds is shown here too
  // (and another field's, when Next hands the sheet on to it)
  useEffect(() => { const on = () => setText(field.value); on(); field.addEventListener("input", on); return () => field.removeEventListener("input", on); }, [field]);
  const rows = symbols ? SYMBOLS : LETTERS;
  const secret = field instanceof HTMLInputElement && field.type === "password";
  const name = field.getAttribute("aria-label") || field.labels?.[0]?.textContent?.trim() || field.getAttribute("placeholder") || "Type";
  // a key takes no focus from the field (the field keeps typing with a real keyboard, and does not think it was left)
  const key = (k: string, label: ReactNode = k, cls = "") => (
    <button key={k} type="button" tabIndex={-1} data-pad-key={k} data-autofocus={k === START_KEY ? "" : undefined} className={`bs-key ${cls}`} onMouseDown={e => e.preventDefault()}
      onClick={() => (k === "shift" ? setShift(s => !s) : k === "symbols" ? setSymbols(s => !s) : k === "done" ? onDone(true) : put(k))}>{label}</button>
  );
  return createPortal(
    <div className="bs-layer bs-osk" data-pad-virtual data-nav-free role="dialog" aria-label="Keyboard">
      <div className="bs-osk-field"><span className="bs-osk-name">{name}</span><span className="bs-osk-text">{secret ? "•".repeat(text.length) : text}<i className="bs-caret" /></span></div>
      <div className="bs-osk-rows">
        {rows.map((r, i) => <div className="bs-osk-row" key={i}>{[...r].map(c => key(c, shift && !symbols ? c.toUpperCase() : c))}</div>)}
        <div className="bs-osk-row">
          {key("shift", <Icon name="arrowUp" size={18} />, `wide${shift ? " on" : ""}`)}
          {key("symbols", symbols ? "abc" : "!#1", "wide")}
          {key("space", "space", "space")}
          {key("back", <Icon name="chevronLeft" size={18} />, "wide")}
          {key("done", nextEmptyField(field) ? "Next" : "Done", "wide done")}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** the choices of a choice list (a native <select> cannot be walked with a pad) */
function Chooser({ field, onDone }: { field: HTMLSelectElement; onDone: () => void }) {
  const name = field.getAttribute("aria-label") || "Choose";
  return createPortal(
    <div className="bs-layer bs-choose" data-pad-virtual role="dialog" aria-label={name}>
      <div className="bs-choose-box">
        <h3>{name}</h3>
        {[...field.options].map(o => (
          <button key={o.value} type="button" tabIndex={-1} className={`bs-opt${o.value === field.value ? " on" : ""}`} data-autofocus={o.value === field.value ? "" : undefined} disabled={o.disabled}
            onMouseDown={e => e.preventDefault()} onClick={() => { if (o.value !== field.value) setValue(field, o.value); onDone(); }}>
            {o.label}{o.value === field.value && <Icon name="check" size={18} />}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/* ─────────── the mode's bottom edge: what the buttons do, the battery and the time ─────────── */

type Hint = [glyph: string, label: string, icon?: IconName];

/** the time as this device writes it, turned over on the minute (the whole display is Ahoy's: nothing else shows a clock) */
function useClock(): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let t = 0;
    const next = () => { t = window.setTimeout(() => { setNow(Date.now()); next(); }, 60_000 - (Date.now() % 60_000) + 40); };
    next();
    const back = () => { if (!document.hidden) setNow(Date.now()); };   // (timers sleep with the PC)
    document.addEventListener("visibilitychange", back);
    return () => { clearTimeout(t); document.removeEventListener("visibilitychange", back); };
  }, []);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(now);
}

interface BatteryLike extends EventTarget { level: number; charging: boolean }
const HAS_BATTERY = "ahoy.battery";
/**
 * This device's battery, where it has one. A PC without reads as full and charging for good, which is also what a handheld
 * on its charger reads: a battery is known by having once been less than full or not charging, and that is kept on the device.
 */
function useBattery(): { level: number; charging: boolean } | null {
  const [b, setB] = useState<{ level: number; charging: boolean } | null>(null);
  useEffect(() => {
    let batt: BatteryLike | null = null, gone = false;
    const read = () => {
      if (!batt || gone) return;
      let known = false;
      try { known = localStorage.getItem(HAS_BATTERY) === "1"; } catch { /* no storage: known for this stay only */ }
      const real = known || batt.level < 1 || !batt.charging;
      if (real && !known) try { localStorage.setItem(HAS_BATTERY, "1"); } catch { /* as above */ }
      setB(real ? { level: batt.level, charging: batt.charging } : null);
    };
    const get = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }).getBattery;
    void get?.call(navigator).then(x => { if (gone) return; batt = x; read(); x.addEventListener("levelchange", read); x.addEventListener("chargingchange", read); }).catch(() => {});
    return () => { gone = true; batt?.removeEventListener("levelchange", read); batt?.removeEventListener("chargingchange", read); };
  }, []);
  return b;
}

function Foot({ pad, hints }: { pad: boolean; hints: Hint[] }) {
  const clock = useClock();
  const batt = useBattery();
  const pct = batt ? Math.round(batt.level * 100) : 0;
  return (
    <div className="bs-foot" aria-hidden="true">
      <div className="bs-hints">
        {hints.map(([g, label]) => <span key={label}><kbd className={pad && g.length === 1 ? "bs-pad" : undefined} data-g={pad ? g : undefined}>{g}</kbd>{label}</span>)}
      </div>
      <div className="bs-status">
        {batt && (
          <span className={`bs-batt${batt.charging ? " charging" : pct <= 15 ? " low" : ""}`}>
            <svg viewBox="0 0 27 14" width="27" height="14">
              <rect x="0.75" y="0.75" width="22.5" height="12.5" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".5" />
              <rect x="24.5" y="4.5" width="2" height="5" rx="1" fill="currentColor" opacity=".5" />
              <rect className="bs-batt-fill" x="3" y="3" width={Math.max(2, 18 * batt.level)} height="8" rx="2" fill="currentColor" />
              {batt.charging && <path d="M13.2 1.6 8.6 7.7h3.1l-1 4.7 4.7-6.2h-3.1z" fill="var(--bg)" stroke="var(--bg)" strokeWidth=".6" strokeLinejoin="round" />}
            </svg>
            {pct}%
          </span>
        )}
        <span className="bs-clock">{clock}</span>
      </div>
    </div>
  );
}

/* ─────────── the couch ─────────── */

const nav = new PadNav();
/** what X would do on the focused thing, in the action's own word ("Install"): a card's pill; null where there is none */
const quickOf = (el: HTMLElement | null): string | null => {
  const act = el?.matches(".pc-link") ? cardAction(el) : null;
  return act ? (act.textContent ?? "").trim().slice(0, 24) || null : null;
};
/** right stick: how far a full tilt scrolls each frame, in the page's pixels */
const STICK_SPEED = 26;
/** how long the focus goes with a page that is still filling in (while the person has not moved), and how long a page come
 *  back to is given to show what was opened from it before the focus starts at the page's top instead */
const LAND_FOLLOW = 12_000, LAND_BACK = 1500;

function Couch() {
  const router = useNavigate();
  const loc = useLocation();
  const how = useNavigationType();
  const [typing, setTyping] = useState<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [choosing, setChoosing] = useState<HTMLSelectElement | null>(null);
  const [pad, setPad] = useState(false);
  /** what X does where the focus is: the card's own action, by its name (null: downloads) */
  const [quick, setQuick] = useState<string | null>(null);
  /** is the app itself up (its top bar), or the sign-in page? */
  const [inApp, setInApp] = useState(() => !!document.querySelector(".tb"));
  /** how the person is driving right now: "pad" shows the focus, "mouse" hides it (the pointer says where they are) */
  const drive = useCallback((by: "pad" | "mouse") => {
    const html = document.documentElement;
    if (html.dataset.drive === by) return;
    html.dataset.drive = by;
    if (by === "pad") { nav.mark(nav.current); } else nav.mark(null);
  }, []);
  /** what each page had focused, to come back to */
  const left = useRef(new Map<string, ReturnType<typeof describe>>());
  /** has the person moved since the page arrived (then the focus is theirs, and a page still filling in does not take it) */
  const touched = useRef(false);
  const sending = useRef(false);
  const lastKey = useRef(-1e9);
  /** a real arrow key on a control that walks by itself: the control, where it stood, the direction */
  const own = useRef<{ el: HTMLElement; was: string; dir: Dir } | null>(null);
  const byKey = () => performance.now() - lastKey.current < 120;

  const closeSheets = () => { setTyping(null); setChoosing(null); };
  const doneTyping = (submit: boolean) => {
    const field = typing;
    setTyping(null);
    if (!field) return;
    if (submit) {
      // a form with more to fill in (a sign-in's password): on to that field, its keyboard up
      const next = nextEmptyField(field);
      if (next) { queueMicrotask(() => { nav.refocus(next, true); setTyping(next); }); return; }
      sending.current = true;
      try { sendKey(field, "Enter"); } finally { sending.current = false; }
      field.form?.requestSubmit?.();
    }
    // back on the field (the keys never took the page's focus from it)
    queueMicrotask(() => nav.refocus(field));
  };

  /**
   * Back. What is open closes first: the mode's own sheet; then whatever of the app takes Escape (a dialog, a viewer, a panel of
   * the bar, a question asked in place, a field with text in it): Escape is sent to what is focused, and when something took it
   * (the key was stopped on its way, or the page changed under it) that was Back. Otherwise it is a page back.
   */
  const back = () => {
    if (typing) return doneTyping(false);
    if (choosing) { const f = choosing; setChoosing(null); queueMicrotask(() => nav.refocus(f)); return; }
    const at = (document.activeElement as HTMLElement | null) ?? document.body;
    if (isTextField(at) && at.value && nav.layer() === document) { setValue(at, ""); return; }
    let arrived = false, changed = false;
    const seen = () => { arrived = true; };
    const mo = new MutationObserver(() => { changed = true; });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-leaving", "class", "hidden", "open"] });
    window.addEventListener("keydown", seen);
    const inLayer = nav.layer() !== document;
    sending.current = true;
    try { sendKey(at, "Escape"); } finally { sending.current = false; window.removeEventListener("keydown", seen); }
    window.setTimeout(() => {
      changed = changed || mo.takeRecords().length > 0;
      mo.disconnect();
      if (inLayer || !arrived || changed) return;
      const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
      if (idx > 0) router(-1);
      else if (tabOf(loc.pathname) >= 0 && !BIG_TABS.includes(loc.pathname as typeof BIG_TABS[number])) router(BIG_TABS[tabOf(loc.pathname)]!);
    }, 40);
  };

  const ok = () => {
    const el = nav.current;
    if (!el || !el.isConnected) { nav.heal(); return; }
    if (typing || choosing) { el.click(); return; }
    if (isTextField(el)) { setTyping(el); return; }
    if (el instanceof HTMLSelectElement) { setChoosing(el); return; }
    if (el.getAttribute("role") === "listbox") { sending.current = true; try { sendKey(el, "Enter"); } finally { sending.current = false; } return; }
    el.click();
  };

  const move = (dir: Dir) => {
    const el = nav.current;
    if (el && el.isConnected && !typing && !choosing && ownsArrow(el, dir)) {
      if (el instanceof HTMLInputElement && el.type === "range") { stepRange(el, dir as "left" | "right"); return; }
      const was = whereIn(el);
      sending.current = true;
      try { sendKey(el, arrowKey(dir)); } finally { sending.current = false; }
      // at its end the control stays as it is: the pad then moves on past it, as it would from anything else
      window.setTimeout(() => { if (nav.current === el && el.isConnected && whereIn(el) === was) nav.move(dir); }, 90);
      return;
    }
    if (!el || !el.isConnected) { nav.heal(); return; }
    // a trailer or a screenshot fills the screen: Left and Right are the one before and the one after
    const layer = nav.layer();
    if (layer !== document && (layer as HTMLElement).matches(".viewer") && (dir === "left" || dir === "right")) {
      const step = (layer as HTMLElement).querySelector<HTMLElement>(dir === "left" ? ".prev" : ".next");
      if (step) { step.click(); return; }
    }
    nav.move(dir);
  };

  const onCmd = (c: Cmd) => {
    if (sending.current) return;                             // a key this code sent to a control, heard again on its way up
    // the pad picked up again after the pointer: the first press only shows where the focus is (on something in view); a step
    // or a click on a focus nobody saw would go anywhere (A on an Uninstall three screens up)
    const asleep = document.documentElement.dataset.drive === "mouse";
    drive("pad");
    touched.current = true;
    if (asleep && !typing && !choosing && (c === "ok" || c === "up" || c === "down" || c === "left" || c === "right")) { nav.show(); return; }
    switch (c) {
      case "up": case "down": case "left": case "right": return move(c);
      case "ok": return ok();
      case "back": return back();
      case "leave": return bigMode.leave();
    }
    if (typing) {
      // on the keyboard: X deletes, Y is a space, Menu is Done
      if (c === "downloads") { setValue(typing, typeKey(typing.value, "back")); return; }
      if (c === "search") { setValue(typing, typeKey(typing.value, "space")); return; }
      if (c === "menu") return doneTyping(true);
      return;
    }
    if (choosing) return;
    if (!document.querySelector(".tb")) return;             // outside the app (the sign-in page): no tabs, no search, no menu
    switch (c) {
      case "prevTab": case "nextTab": {
        // a dialog or a picture over the page keeps the page under it: the tabs wait until it is closed (a panel of the bar
        // goes with the page it was opened on)
        const over = nav.layer();
        if (over !== document && !(over as HTMLElement).matches(".tb-panel")) return;
        // counted from where the address is now, not from the page as it was last drawn: a second press before the next
        // page has drawn goes on from the first instead of asking for the same tab again
        return router(tabStep(window.location.pathname, c === "nextTab" ? 1 : -1));
      }
      case "downloads": {
        // X on a card: its own action, the pill a mouse sees on hover (Install, Play, Request)
        const act = nav.layer() === document ? cardAction(nav.current) : null;
        if (!act) return router("/downloads");
        act.click();
        window.setTimeout(() => setQuick(quickOf(nav.current)), 400);   // the action changes with what it did (Install → Cancel)
        return;
      }
      case "friends": return router("/people");
      case "search": {
        // Y on the pad: the search with the keyboard sheet. "/" on a real keyboard: the search itself, as in the window (the bar's own key)
        const box = document.querySelector<HTMLInputElement>(".tb-search input");
        if (box) { nav.refocus(box, true); if (!byKey()) setTyping(box); }
        return;
      }
      case "menu": { document.querySelector<HTMLElement>(".tb-me")?.click(); return; }
    }
  };
  /**
   * A real keyboard. In a field the keys are the field's own (letters, the caret, Backspace, Enter, "/"): they reach the field
   * and the page's own handlers as always, and stop before the engine, which would take Backspace for Back and stop the key.
   * Only Up, Down, Esc, the tab keys and F11 leave a field. (Heard on the document while the key bubbles: after the page's
   * handlers, before the window's.)
   */
  const live = useRef({ typing });
  live.current = { typing };
  useEffect(() => {
    const DIRS: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    // heard before the page: when a real key was last pressed (a command right behind it came from the keyboard, not the
    // pad), and whether it is an arrow for a control that walks by itself (where it stands now, to see whether it moved)
    const stamp = (e: KeyboardEvent) => {
      if (e.key === "Tab") drive("pad");
      if (!e.isTrusted) return;
      lastKey.current = performance.now();
      const d = DIRS[e.key], t = e.target;
      own.current = d && t instanceof HTMLElement && !(t instanceof HTMLInputElement) && ownsArrow(t, d) ? { el: t, was: whereIn(t), dir: d } : null;
    };
    window.addEventListener("keydown", stamp, true);
    return () => window.removeEventListener("keydown", stamp, true);
  }, [drive]);
  useEffect(() => {
    const LEAVES = new Set(["ArrowUp", "ArrowDown", "Escape", "F11", "PageUp", "PageDown"]);
    const field = (e: KeyboardEvent) => {
      if (sending.current || e.ctrlKey || e.metaKey || e.altKey || !isTextField(e.target as Element | null) || LEAVES.has(e.key)) return;
      e.stopPropagation();
      // Enter with the keyboard sheet open: the field takes it (its form, its own handler), and the sheet is done
      if (e.key === "Enter" && live.current.typing) { const f = live.current.typing; setTyping(null); queueMicrotask(() => nav.refocus(f)); }
    };
    document.addEventListener("keydown", field);
    return () => document.removeEventListener("keydown", field);
  }, []);
  /**
   * What the engine must not turn into a command: a key this code sent to a control (heard again on its way up), and a real
   * arrow on a control that walks by itself (a list, a choice, the fan): the control took it. When it changed nothing there
   * (the list was at its end) the focus moves on past it, as with the pad.
   */
  const notACommand = (e: KeyboardEvent): boolean => {
    if (sending.current) return true;
    const o = own.current;
    if (!o || !e.isTrusted) return false;
    own.current = null;
    drive("pad"); touched.current = true;
    window.setTimeout(() => { if (o.el.isConnected && whereIn(o.el) === o.was) { nav.adopt(o.el); nav.move(o.dir); } }, 90);
    return true;
  };
  useInput(onCmd, notACommand, () => setPad(true));

  // the pointer moving is the mouse driving; the page's own focus changes are followed
  useEffect(() => {
    let x = -1, y = -1;
    const mouse = (e: MouseEvent) => { if (x >= 0 && Math.hypot(e.clientX - x, e.clientY - y) > 6) drive("mouse"); x = e.clientX; y = e.clientY; };
    const focus = (e: FocusEvent) => nav.adopt(e.target);
    drive("pad");                                            // the focus shows from the start: nothing else says where the person is
    addEventListener("mousemove", mouse); document.addEventListener("focusin", focus);
    return () => { removeEventListener("mousemove", mouse); document.removeEventListener("focusin", focus); delete document.documentElement.dataset.drive; nav.mark(null); nav.current = null; };
  }, [drive]);

  // a pad was seen: the tabs carry its LB and RB from then on (not only while it drives: the bar must not shift under a mouse)
  useEffect(() => {
    if (!pad) return;
    document.documentElement.dataset.pad = "";
    return () => { delete document.documentElement.dataset.pad; };
  }, [pad]);

  // the right stick scrolls; the pointer hides while it rests
  useEffect(() => {
    let raf = 0, idle = 0;
    const tick = () => {
      if (!document.hidden && document.hasFocus()) {
        for (const p of navigator.getGamepads?.() ?? []) {
          if (!p) continue;
          const y = p.axes[3] ?? 0;
          if (Math.abs(y) > 0.2) { scrollBy(0, y * STICK_SPEED); touched.current = true; }   // the page is theirs: no landing scrolls it back
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const html = document.documentElement;
    const seen = () => { delete html.dataset.still; clearTimeout(idle); idle = window.setTimeout(() => { html.dataset.still = ""; }, 3000); };
    seen();
    addEventListener("mousemove", seen);
    return () => { cancelAnimationFrame(raf); clearTimeout(idle); removeEventListener("mousemove", seen); delete html.dataset.still; };
  }, []);

  // another page: its sheets close, and the focus lands on it (Back: on what was opened from it)
  const key = useRef(loc.key);
  useLayoutEffect(() => { key.current = loc.key; }, [loc.key]);
  // what is focused is written down under its page as it changes (when the page goes, its elements are gone already)
  useEffect(() => {
    // (what is focused in something open over the page is not the page's: coming back finds the page without it)
    nav.onFocus = el => { if (el && !el.closest(".bs-layer, .tb, .tb-panel, .viewer, .overlay")) left.current.set(key.current, describe(el)); setQuick(quickOf(el)); };
    return () => { nav.onFocus = () => {}; };
  }, []);
  useEffect(() => {
    closeSheets();
    touched.current = false;
    const was = how === "POP" ? left.current.get(loc.key) : undefined;
    // A page fills in over a moment, or over seconds on a slow line (its hero, its rows): the focus settles on what is there
    // and goes with the page as more arrives (the tab in the bar, then the page's first thing, then its main action), until
    // the person moves or the page has had its time. Giving up after a second left the focus in the bar on a slow line.
    const t0 = performance.now();
    let changed = t0, landed = -1, t = 0, mine = false;
    const mo = new MutationObserver(() => { changed = performance.now(); });
    mo.observe(document.body, { childList: true, subtree: true });
    // a finger, the wheel, a click: the person is using the page another way, and the page is not scrolled back under them
    const hands = () => { mine = true; };
    const HANDS = ["wheel", "touchstart", "pointerdown"] as const;
    for (const e of HANDS) addEventListener(e, hands, { passive: true, capture: true });
    const end = () => { clearTimeout(t); mo.disconnect(); for (const e of HANDS) removeEventListener(e, hands, { capture: true }); };
    const land = () => {
      if (touched.current || mine) return end();             // the person is already moving about: the focus is theirs
      const now = performance.now();
      const again = was ? findAgain(was, nav.candidates()) : null;
      if (again) { nav.refocus(again, true); return end(); }
      // Back: what was opened from this page is looked for first, and the page's own start only once that took too long
      const fresh = changed > landed || !nav.current?.isConnected;
      if (fresh && (!was || now - t0 > LAND_BACK)) { landed = now; nav.land(); }
      if (now - t0 > LAND_FOLLOW) return end();
      t = window.setTimeout(land, was && now - t0 <= LAND_BACK ? 120 : 200);
    };
    t = window.setTimeout(land, 80);
    return end;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  // a sheet opened or closed: the focus starts on it, and comes back from it
  useEffect(() => { if (typing || choosing) nav.land(); }, [typing, choosing]);

  // something of the app's opened over the page (a dialog, a viewer, a panel of the bar): the focus goes into it, and comes
  // back to what had it when it closes (a panel does not move the focus by itself; a dialog does, and that is followed)
  useEffect(() => {
    let layer: HTMLElement | Document = nav.layer(), raf = 0, app = !!document.querySelector(".tb");
    const under: { layer: HTMLElement | Document; had: HTMLElement | null }[] = [];
    const check = () => {
      raf = 0;
      // the app arrived where the sign-in page stood (or the other way): the focus lands on what is there now
      const inside = !!document.querySelector(".tb");
      if (inside !== app) { app = inside; setInApp(inside); touched.current = false; window.setTimeout(() => { if (!touched.current) nav.land(); }, 150); }
      const now = nav.layer();
      // what had the focus went away under it (a button that did its work, a row that left): the focus stays near where it was
      if (now === layer) { if (nav.current && touched.current) nav.heal(); return; }
      const opened = now !== document && !under.some(u => u.layer === now);
      if (opened) {
        // (a panel that takes the page's focus as it opens has it already: what it opened over is what had it before)
        under.push({ layer: now, had: (now as HTMLElement).contains(nav.current) ? nav.before : nav.current });
        if (!(now as HTMLElement).contains(nav.current)) nav.land();
      } else {
        // closed: back to what was focused under it (the newest of the layers that are gone)
        let had: HTMLElement | null = null;
        while (under.length && under[under.length - 1]!.layer !== now) had = under.pop()!.had ?? had;
        if (had?.isConnected && (now === document || (now as HTMLElement).contains(had))) nav.refocus(had);
        else if (!nav.current?.isConnected || (now !== document && !(now as HTMLElement).contains(nav.current))) nav.land();
      }
      layer = now;
    };
    const mo = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(check); });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-leaving"] });
    return () => { mo.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  // with a pad the way out is in the menu (☰): a handheld has no F11
  const hints: Hint[] = typing
    ? [[pad ? "A" : "Enter", "Type"], [pad ? "X" : "⌫", "Delete"], [pad ? "Y" : "Space", "Space"], [pad ? "☰" : "Enter", nextEmptyField(typing) ? "Next" : "Done"], [pad ? "B" : "Esc", "Close"]]
    : !inApp ? [[pad ? "A" : "Enter", "Select"], [pad ? "B" : "Esc", "Back"]]
    // (with a pad the tabs themselves say LB and RB, where they are: big.css)
    : pad ? [["A", "Select"], ["B", "Back"], ...(quick ? [["X", quick] as Hint] : []), ["Y", "Search"], ["☰", "Menu"]]
    : [["Enter", "Select"], ["Esc", "Back"], ["/", "Search"], ["PgUp PgDn", "Tabs"], ["F11", "Leave"]];
  return <>
    {typing && <Keyboard field={typing} onDone={doneTyping} />}
    {choosing && <Chooser field={choosing} onDone={() => { const f = choosing; setChoosing(null); queueMicrotask(() => nav.refocus(f)); }} />}
    {createPortal(<Foot pad={pad} hints={hints} />, document.body)}
  </>;
}

/** mounted once by the app: the mode's switch, the launcher's wishes, and the couch while it is on */
export function BigHost() {
  const on = useBig();
  useEffect(() => {
    bigMode.start();
    // the launcher asks for the mode: its pad button set to open Big screen, or a start with --big
    const off = launcher?.onEvent(e => { const x = e as { type?: string; on?: boolean }; if (x.type === "big") { if (x.on === false) bigMode.leave(); else bigMode.enter(); } });
    void launcher?.wantsBig?.().then(w => { if (w) bigMode.enter(); }).catch(() => {});
    return off;
  }, []);
  return on ? <Couch /> : null;
}

/** /big: the address that turns the mode on (the launcher goes here, and old links) */
export function BigEntry() {
  useEffect(() => { bigMode.enter(); }, []);
  return <Navigate to="/" replace />;
}

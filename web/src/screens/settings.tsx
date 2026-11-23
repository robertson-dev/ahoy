/**
 * Ahoy — Settings (/settings). Board: M/lfs/settings/Settings.dc.html.
 * The title and the index on the page margin (You, This PC, Your PCs, On this PC; then, for whoever runs the server, Who can join,
 * People and Server under a quiet rule) beside one column of panels. The index scrolls to a section and lights the one in
 * view; it stays in reach while the page scrolls, and folds into a row of chips above the column in narrow windows.
 * In a plain browser This PC offers the launcher and On this PC is not there. Every row is wired to the server's and the
 * launcher's own calls: settings-you.tsx, settings-pc.tsx, settings-admin.tsx (private pieces in settings-kit.tsx).
 */
import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { inLauncher } from "../launcher";
import { usePcs } from "../pcs";
import { useSession } from "../session";
import { AdminSections } from "./settings-admin";
import { OnThisPcSection, ThisPcSection } from "./settings-pc";
import { YourPcsSection } from "./settings-pcs";
import { YouSection } from "./settings-you";
import "./settings.css";

interface Entry { id: string; label: string }
const MINE: Entry[] = [{ id: "you", label: "You" }, { id: "this-pc", label: "This PC" }, { id: "your-pcs", label: "Your PCs" }, { id: "on-this-pc", label: "On this PC" }];
const ADMIN: Entry[] = [{ id: "who-can-join", label: "Who can join" }, { id: "people", label: "People" }, { id: "server", label: "Server" }];

export function Settings() {
  const { isAdmin } = useSession();
  // Your PCs is there once I have one (settings-pcs.tsx); On this PC is the launcher's
  const hasPcs = usePcs().pcs.length > 0;
  const mine = MINE.filter(e => (e.id !== "on-this-pc" || inLauncher) && (e.id !== "your-pcs" || hasPcs));
  const admin = isAdmin ? ADMIN : [];
  const ids = [...mine, ...admin].map(e => e.id);
  const { cur, go } = useSpy(ids);
  useArrival(ids);
  const nav = useRef<HTMLElement>(null);
  useLitChipInView(nav, cur);
  const entry = (e: Entry) => (
    <li key={e.id}>
      {/* a pad starts on the section that is lit (big/pad.ts land) */}
      <a href={`#${e.id}`} aria-current={cur === e.id ? "true" : undefined} data-autofocus={cur === e.id ? "" : undefined} onClick={ev => { if (plainClick(ev)) { ev.preventDefault(); go(e.id); } }}>{e.label}</a>
    </li>
  );
  return (
    <div className="st">
      <div className="st-side">
        <h1 className="st-title">Settings</h1>
        {/* data-nav-free: with a pad, Right leaves the index for the section beside it though nothing there is on its line (big/nav.ts) */}
        <nav className="st-index" aria-label="Settings" ref={nav} data-nav-free="">
          <ul>
            {mine.map(entry)}
            {admin.length > 0 && <li className="st-index-rule" role="separator" />}
            {admin.map(entry)}
          </ul>
        </nav>
      </div>
      <div className="st-main">
        <YouSection />
        <ThisPcSection />
        <YourPcsSection />
        {inLauncher && <OnThisPcSection />}
        {isAdmin && <><hr className="st-rule" /><AdminSections /></>}
      </div>
    </div>
  );
}

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * The section in view lights its index entry: the last one whose top has passed a line 30 % down the space under the
 * stuck index, or the last section once the page is at its end. A jump from the index lights its entry at once and holds
 * it through the smooth scroll, until the person scrolls again.
 */
function useSpy(ids: string[]) {
  const [cur, setCur] = useState(ids[0]);
  const hold = useRef<{ settled: boolean; t: number } | null>(null);
  const key = ids.join(" ");
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      if (hold.current) return;
      const first = document.getElementById(ids[0]);
      const top = first ? parseFloat(getComputedStyle(first).scrollMarginTop) || 0 : 0;
      const line = top + Math.max(0, innerHeight - top) * 0.3;
      let c = ids[0];
      for (const id of ids) { const el = document.getElementById(id); if (el && el.getBoundingClientRect().top <= line) c = id; }
      if (scrollY > 0 && innerHeight + scrollY >= document.documentElement.scrollHeight - 4) c = ids[ids.length - 1];
      setCur(c);
    };
    const onScroll = () => {
      const h = hold.current;
      if (h && !h.settled) {   // still the jump: it is over 160 ms after its last scroll
        clearTimeout(h.t);
        h.t = window.setTimeout(() => { if (hold.current === h) h.settled = true; }, 160);
        return;
      }
      if (h) hold.current = null;
      if (!raf) raf = requestAnimationFrame(measure);
    };
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    measure();
    return () => {
      removeEventListener("scroll", onScroll); removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf); if (hold.current) clearTimeout(hold.current.t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    setCur(id);
    if (hold.current) clearTimeout(hold.current.t);
    const h = { settled: false, t: 0 };
    h.t = window.setTimeout(() => { if (hold.current === h) h.settled = true; }, 300);
    hold.current = h;
    el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    el.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });   // Tab goes on inside the section
  };
  return { cur, go };
}

/** in narrow windows the index is a row of chips that scrolls sideways: the lit chip is kept inside it */
function useLitChipInView(nav: RefObject<HTMLElement>, cur: string) {
  useEffect(() => {
    const ul = nav.current?.querySelector("ul");
    const a = nav.current?.querySelector<HTMLElement>('a[aria-current="true"]');
    if (!ul || !a || ul.scrollWidth <= ul.clientWidth) return;   // the column beside the panels never scrolls
    const u = ul.getBoundingClientRect(), b = a.getBoundingClientRect();
    const by = b.left < u.left ? b.left - u.left - 16 : b.right > u.right ? b.right - u.right + 16 : 0;
    if (by) ul.scrollBy({ left: by, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [nav, cur]);
}

/** /settings#people lands on People, again once the panels above it have their content, unless the person moves first */
function useArrival(ids: string[]) {
  useEffect(() => {
    let id = location.hash.slice(1);
    try { id = decodeURIComponent(id); } catch { /* a malformed link: use it as it is */ }
    if (!ids.includes(id)) return;
    let moved = false;
    const land = () => { if (!moved) document.getElementById(id)?.scrollIntoView({ block: "start" }); };
    const stop = () => { moved = true; };
    const timers = [0, 400, 1200].map(ms => window.setTimeout(land, ms));
    addEventListener("wheel", stop, { passive: true }); addEventListener("touchstart", stop, { passive: true }); addEventListener("keydown", stop);
    return () => {
      timers.forEach(clearTimeout);
      removeEventListener("wheel", stop); removeEventListener("touchstart", stop); removeEventListener("keydown", stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * The top bar (M/mine/livefan/Main.dc.html, top 148 px): nav and search on the left; the bell, the downloads pill, Request and
 * your avatar on the right (the board's amber anchor in the middle is gone: the bar carries no logo). On pages whose top is key art it sits over the art and its
 * pills are frosted dark glass; once the page scrolls it condenses into a solid 72 px strip so it stays in reach.
 * In the launcher it is the window's title bar: the bar drags the window, its controls do not, and the condensed strip
 * keeps clear of the caption buttons (env(titlebar-area-*)).
 * Keys: "/" focuses the search, F11 opens (and leaves) the big screen, Alt+Left / Alt+Right and the mouse's back and forward buttons move
 * through history. On /search the pill and the page's big field are one search: the pill shows the page's term, and
 * typing in either searches as you type (the address follows, without new history).
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { launcher } from "../launcher";
import { bigMode } from "../big/mode";
import { useLauncher } from "../launcher-state";
import { useSession } from "../session";
import { Icon } from "../ui/icons";
import { IconButton } from "../ui/button";
import { Pill } from "../ui/controls";
import { Bell } from "./social";
import { AccountMenu } from "./menu";
import { RequestButton } from "./request";
import { TransferPill, useTransfer } from "./transfer";
import { PopoverHost } from "./popover";

export const framed = !!launcher?.features?.includes("frameless");

/** the four tabs; each also owns its sub-pages for the highlight */
export const TABS = [
  { to: "/", label: "Home", owns: (p: string) => p === "/" },
  { to: "/discover", label: "Discover", owns: (p: string) => p.startsWith("/discover") || p.startsWith("/steam/") },
  { to: "/library", label: "Library", owns: (p: string) => p.startsWith("/library") || p.startsWith("/downloads") || p.startsWith("/game/") },
  { to: "/people", label: "Friends", owns: (p: string) => p.startsWith("/people") || p.startsWith("/u/") },
] as const;
const isTabRoot = (p: string) => TABS.some(t => t.to === p);
/** where Back goes when there is no history (a page opened directly) */
const parentOf = (p: string) => TABS.find(t => t.owns(p))?.to ?? "/";

/* ─────────── the parts (the gallery draws them with sample data) ─────────── */

export function BarFrame({ over, solid, framed: inFrame, left, right }: { over?: boolean; solid?: boolean; framed?: boolean; left: ReactNode; right: ReactNode }) {
  return (
    <header className={`tb${over ? " over" : ""}${solid ? " solid" : ""}${inFrame ? " framed" : ""}`}>
      <div className="tb-left">{left}</div>
      <div className="tb-right">{right}</div>
    </header>
  );
}

export function NavTabs({ path }: { path: string }) {
  return (
    <nav className="tb-nav" aria-label="Main">
      {TABS.map(t => { const on = t.owns(path); return <Link key={t.to} to={t.to} className={on ? "on" : undefined} aria-current={on && path === t.to ? "page" : undefined}>{t.label}</Link>; })}
    </nav>
  );
}

export function SearchPill({ value, onChange, onSubmit, inputRef }: { value: string; onChange: (v: string) => void; onSubmit: () => void; inputRef?: RefObject<HTMLInputElement> }) {
  return (
    <form className="fpill tb-search" role="search" onSubmit={e => { e.preventDefault(); onSubmit(); }} onClick={e => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}>
      <Icon name="search" size={18} className="fpill-ic" />
      <input ref={inputRef} type="search" value={value} placeholder="Search games" aria-label="Search any game" onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === "Escape") { onChange(""); (e.target as HTMLInputElement).blur(); } }} />
      {!value && <kbd className="tb-key" aria-hidden>/</kbd>}
    </form>
  );
}

/** the launcher downloaded a newer build of itself: one quiet pill until the person restarts */
function UpdatePill() {
  const { update, installUpdate } = useLauncher();
  if (update?.status !== "ready") return null;
  // in a narrow window only the icon shows (ahoy.css); the label keeps its name
  return <Pill icon="refresh" label="Restart to update" onClick={() => void installUpdate()} className="tb-update" title={update.version ? `Ahoy ${update.version}` : undefined}><span className="tb-update-t">Restart to update</span></Pill>;
}

/* ─────────── the bar ─────────── */

export function TopBar({ over }: { over: boolean }) {
  const nav = useNavigate();
  const loc = useLocation();
  const { me } = useSession();
  const transfer = useTransfer();
  const [q, setQ] = useState("");
  const [solid, setSolid] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  // on /search the pill mirrors the page's term (the address's q); elsewhere it starts empty
  const onSearch = loc.pathname === "/search";
  const onDiscover = loc.pathname === "/discover";
  const pageQ = onSearch || onDiscover ? new URLSearchParams(loc.search).get("q") ?? "" : "";
  useEffect(() => { setQ(pageQ); }, [loc.pathname, pageQ]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = () => setSolid(window.scrollY > 12);
    on();
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (e.key === "/" && !typing) { e.preventDefault(); box.current?.focus(); }
      // F11 opens the big screen; while it is on, the big screen's own listener takes F11 to leave (big/nav.ts)
      if (e.key === "F11" && !e.defaultPrevented && !bigMode.on) { e.preventDefault(); bigMode.enter(); }
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); nav(-1); }
      if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); nav(1); }
    };
    // the mouse's back and forward buttons: a browser handles them itself, the launcher's window does not
    const mouse = (e: MouseEvent) => { if (!launcher) return; if (e.button === 3) { e.preventDefault(); nav(-1); } else if (e.button === 4) { e.preventDefault(); nav(1); } };
    addEventListener("keydown", on); addEventListener("mouseup", mouse);
    return () => { removeEventListener("keydown", on); removeEventListener("mouseup", mouse); };
  }, [nav]);
  const path = loc.pathname;
  const back = () => { const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0; if (idx > 0) nav(-1); else nav(parentOf(path)); };
  const submit = () => {
    const t = q.trim();
    if (onDiscover) {
      const params = new URLSearchParams(loc.search);
      params.delete("page");
      if (t) params.set("q", t); else params.delete("q");
      nav({ pathname: "/discover", search: params.toString() });
    } else if (t) nav(`/search?q=${encodeURIComponent(t)}`, { replace: onSearch }); };
  // typing in the pill on /search searches as you type, like the page's own field
  const change = (v: string) => { setQ(v); if (onSearch) nav(v.trim() ? `/search?q=${encodeURIComponent(v)}` : "/search", { replace: true }); };
  return (
    <PopoverHost>
      <BarFrame over={over} solid={solid} framed={framed}
        left={<>
          {!isTabRoot(path) && <IconButton icon="chevronLeft" label="Back" className="tb-back" onClick={back} />}
          <NavTabs path={path} />
          <SearchPill value={q} onChange={change} onSubmit={submit} inputRef={box} />
        </>}
        right={<>
          <UpdatePill />
          {me && <Bell />}
          {transfer && <TransferPill t={transfer} />}
          <RequestButton />
          {me && <AccountMenu />}
        </>}
      />
    </PopoverHost>
  );
}

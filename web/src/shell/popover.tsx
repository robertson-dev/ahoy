/** One open/close state for the bar's panels: a click outside or Escape closes it, and only one panel is open at a time. */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

type Which = "bell" | "request" | "account" | null;
const Ctx = createContext<{ open: Which; setOpen: (w: Which) => void }>({ open: null, setOpen: () => {} });

export function PopoverHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Which>(null);
  // going to another page closes the open panel (an action inside one may navigate: Request on a store hit opens its game page)
  const { pathname } = useLocation();
  useEffect(() => setOpen(null), [pathname]);
  return <Ctx.Provider value={{ open, setOpen }}>{children}</Ctx.Provider>;
}

/** the state of one panel; `ref` goes on the wrapper that holds both the trigger and the panel */
export function usePopover(which: Exclude<Which, null>) {
  const { open, setOpen } = useContext(Ctx);
  const ref = useRef<HTMLDivElement>(null);
  const isOpen = open === which;
  useEffect(() => {
    if (!isOpen) return;
    // a dialog opened from inside the panel (ui/kit Modal, in a portal on the body) counts as the panel's own
    const down = (e: MouseEvent) => { const t = e.target as Element | null; if (!ref.current?.contains(t) && !t?.closest?.(".overlay, .viewer")) setOpen(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(null); (ref.current?.querySelector("button") as HTMLButtonElement | null)?.focus(); } };
    addEventListener("mousedown", down); addEventListener("keydown", key);
    return () => { removeEventListener("mousedown", down); removeEventListener("keydown", key); };
  }, [isOpen, setOpen]);
  return { ref, isOpen, toggle: () => setOpen(isOpen ? null : which), close: () => setOpen(null) };
}

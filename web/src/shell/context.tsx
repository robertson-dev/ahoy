/**
 * What the page tells the shell: "my top is key art" (the top bar then sits over it with frosted pills, and the page
 * starts at the window's top edge instead of under the bar). A mounted <Spotlight> says it by itself; a screen without
 * one can call useUnderBar(). The game and Steam pages of the old layout are under the bar by route as well.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

interface UnderBar { count: number; enter: () => () => void }
const Ctx = createContext<UnderBar>({ count: 0, enter: () => () => {} });

export function UnderBarProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const enter = useCallback(() => { setCount(n => n + 1); return () => setCount(n => Math.max(0, n - 1)); }, []);
  const value = useMemo(() => ({ count, enter }), [count, enter]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** while the calling component is mounted (and `on`), the page runs under the top bar */
export function useUnderBar(on = true) {
  const { enter } = useContext(Ctx);
  useLayoutEffect(() => (on ? enter() : undefined), [on, enter]);
}

/** true while some mounted component asked for it */
export const useIsUnderBar = () => useContext(Ctx).count > 0;

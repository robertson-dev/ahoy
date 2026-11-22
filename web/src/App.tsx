/** Ahoy — the app: the providers, the shell (the top bar over the page) and the routes; every screen lives in screens/. */
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { Navigate, Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import { UiProvider } from "./ui/kit";
import { LauncherProvider } from "./launcher-state";
import { SessionProvider } from "./session";
import { LibCtx, useLibrarySource } from "./data";
import { PcsProvider } from "./pcs";
import { SavesProvider } from "./saves-state";
import { NewsProvider } from "./whatsnew-state";
import { TopBar, UnderBarProvider, useIsUnderBar } from "./shell";
import { Home } from "./screens/home";
import { Discover } from "./screens/discover";
import { LegacyPlatform } from "./screens/platforms";
import { Library, Downloads } from "./screens/library";
import { ListPage, SearchPage } from "./screens/search";
import { PeoplePage } from "./screens/friends";
import { ProfilePage } from "./screens/profile";
import { GamePage, SteamPage } from "./screens/game";
import { Settings } from "./screens/settings";
import { BigEntry, BigHost } from "./big";
import { settlePage } from "./ui/motion";
import { Boundary, PageFailed } from "./ui/boundary";

function LibProvider({ children }: { children: ReactNode }) {
  const lib = useLibrarySource();
  return <LibCtx.Provider value={lib}>{children}</LibCtx.Provider>;
}

/**
 * A change of page, as an app does it: the top bar stays put (it is outside the routes and never animates for a page), the new
 * page settles in one quick fade (ui/motion.ts settlePage: what its parts would play to arrive is finished at once), and the
 * window is where it should be: back where that page was for Back and Forward, else at its top. The same page with another
 * search or filter changes in place. (Each page change used to blur the whole window out and in, top bar included, and build
 * the page again from nothing, always at its top: it read as a reload, 2026-11-07.)
 */
function usePageChange(main: RefObject<HTMLElement>) {
  const loc = useLocation();
  const how = useNavigationType();
  const scrolls = useRef(new Map<string, number>());
  const at = useRef(loc.key), path = useRef(loc.pathname);
  // where each page was scrolled to; a scroll event lands after a change commits, so it counts for the page now shown
  useEffect(() => {
    history.scrollRestoration = "manual";   // the browser's own restore would fight this one
    const on = () => { scrolls.current.set(at.current, window.scrollY); };
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);
  useLayoutEffect(() => { at.current = loc.key; }, [loc.key]);
  // only another page starts (and stops) this: a page that rewrites its own search or filter right after it opens does not
  // cut its settling or its scroll short
  useLayoutEffect(() => {
    if (path.current === loc.pathname) return;
    path.current = loc.pathname;
    const html = document.documentElement;
    html.dataset.swap = "";   // the top bar takes its height and ground for the new scroll at once (ahoy.css)
    const y = how === "POP" ? scrolls.current.get(loc.key) ?? 0 : 0;
    // a page that is still filling in may be too short for its old place at first: try again for a few frames
    const until = performance.now() + 600;
    let raf = 0;
    const put = () => { window.scrollTo(0, y); if (Math.abs(window.scrollY - y) > 2 && performance.now() < until) raf = requestAnimationFrame(put); };
    put();
    const stop = main.current ? settlePage(main.current, { blur: true }) : () => {};
    const t = setTimeout(() => { delete html.dataset.swap; }, 150);
    return () => { cancelAnimationFrame(raf); stop(); clearTimeout(t); delete html.dataset.swap; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);
  return loc;
}

function Shell() {
  const main = useRef<HTMLElement>(null);
  const loc = usePageChange(main);
  const over = useIsUnderBar();
  return (
    <>
      <TopBar over={over} />
      {/* Big screen is this same app on the whole display, driven by a pad (big/): it mounts beside the pages, not instead of them */}
      <BigHost />
      <main ref={main} className={`page${over ? " under" : ""}`}>
        {/* a page that throws shows a quiet stop instead of blanking the window; another page clears it */}
        <Boundary resetKey={loc.key} fallback={retry => <PageFailed retry={retry} />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/discover" element={<Discover />} />
          <Route path="/discover/platform/:platform/:page?" element={<LegacyPlatform />} />
          <Route path="/discover/list/:key" element={<ListPage />} />
          <Route path="/library" element={<Library />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/friends" element={<Navigate to="/people" replace />} />
          <Route path="/u/:name" element={<ProfilePage />} />
          <Route path="/game/:id" element={<GamePage />} />
          <Route path="/steam/:appId" element={<SteamPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/downloads" element={<Downloads />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/big" element={<BigEntry />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Boundary>
      </main>
    </>
  );
}

export function App() {
  return (
    <UiProvider><SessionProvider><NewsProvider><LauncherProvider><LibProvider><PcsProvider><SavesProvider><UnderBarProvider>
      <Shell />
    </UnderBarProvider></SavesProvider></PcsProvider></LibProvider></LauncherProvider></NewsProvider></SessionProvider></UiProvider>
  );
}

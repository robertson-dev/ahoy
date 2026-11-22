/// <reference types="vite/client" />
/** Ahoy — the launcher's own UI, served by the Ahoy server at /. */
import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/figtree";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/jetbrains-mono";
import "./ahoy.css";
import { App } from "./App";
import { watchScrollbar } from "./shell/scrollbar";
import { AppFailed, Boundary, watchErrors } from "./ui/boundary";

/** dev only: /__gallery draws every shared component with sample data, outside the sign-in gate (no server needed) */
const Gallery = import.meta.env.DEV ? lazy(() => import("./ui/gallery")) : null;
const gallery = !!Gallery && location.pathname === "/__gallery";
/** dev only: /__cards?src=<list> draws posters as box-art cards at the fan's size (ui/cards-board.tsx) */
const CardsBoard = import.meta.env.DEV ? lazy(() => import("./ui/cards-board")) : null;
const cardsBoard = !!CardsBoard && location.pathname === "/__cards";

watchScrollbar();   // the right page margin hosts the page scrollbar (--sb, --page-r in ahoy.css)
watchErrors();      // what nothing caught goes to the server's log (ui/boundary.tsx)

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      {gallery && Gallery ? <Suspense fallback={null}><Gallery /></Suspense>
        : cardsBoard && CardsBoard ? <Suspense fallback={null}><CardsBoard /></Suspense>
        : <Boundary fallback={() => <AppFailed />}><App /></Boundary>}
    </BrowserRouter>
  </React.StrictMode>,
);

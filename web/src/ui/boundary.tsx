/**
 * When a page fails to draw. Without a boundary React unmounts everything and the window goes blank: a big-screen store tile did
 * that on 2026-11-07, and only a restart got the person out. Now a page that throws shows a quiet stop with Try again and Home
 * (the top bar stays usable), the whole app falls back to Reload, and every failure goes to the server's log
 * (POST /api/v1/client-error, server/src/api/system.ts) so it can be fixed.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { post } from "../api";
import { Button, ButtonLink } from "./button";

/** at most this many reports a page load, each message once per page */
const MAX_REPORTS = 10;
const sent = new Set<string>();
/** tell the server a page failed (best effort, never throws) */
export function reportError(e: unknown, component?: string | null) {
  const err = e instanceof Error ? e : new Error(typeof e === "string" ? e : JSON.stringify(e) ?? "unknown error");
  const key = `${err.message}|${location.pathname}`;
  if (sent.has(key) || sent.size >= MAX_REPORTS) return;
  sent.add(key);
  const stack = (err.stack ?? "").split("\n").map(s => s.trim()).filter(Boolean).slice(0, 6).join(" ");
  const where = (component ?? "").split("\n").map(s => s.trim()).filter(Boolean).slice(0, 4).join(" < ");
  void post("/api/v1/client-error", { message: err.message, stack, component: where, path: location.pathname + location.search }).catch(() => {});
}

/** errors nothing caught: a script error or a promise nobody handled (a skipped page transition's AbortError is not one) */
export function watchErrors() {
  addEventListener("error", e => { if (/ResizeObserver loop/.test(e.message ?? "")) return; reportError(e.error ?? e.message); });
  addEventListener("unhandledrejection", e => { const r = e.reason as { name?: string } | undefined; if (r?.name === "AbortError") return; reportError(e.reason); });
}

interface Props { children: ReactNode; fallback: (retry: () => void) => ReactNode; /** a new key (another page) clears the failure */ resetKey?: string }
export class Boundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("[ahoy] a page failed to draw", error); reportError(error, info.componentStack); }
  componentDidUpdate(prev: Props) { if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false }); }
  render() { return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children; }
}

/** one page failed: the rest of the app still works */
export function PageFailed({ retry }: { retry: () => void }) {
  return (
    <div className="fail" role="alert">
      <h1 className="fail-t">This page didn't load</h1>
      <div className="fail-acts">
        <Button kind="primary" size={48} icon="retry" onClick={retry}>Try again</Button>
        <ButtonLink to="/" size={48}>Home</ButtonLink>
      </div>
    </div>
  );
}

/** the app itself failed: a reload is the way back */
export function AppFailed() {
  return (
    <div className="fail fail-app" role="alert">
      <h1 className="fail-t">Ahoy didn't load</h1>
      <div className="fail-acts"><Button kind="primary" size={48} icon="retry" onClick={() => location.reload()}>Reload</Button></div>
    </div>
  );
}

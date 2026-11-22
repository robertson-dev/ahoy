/**
 * Request: the amber circle and the word (M/mine/livefan). It opens a small panel with a find-a-game field (today's lookup)
 * and, for each hit, its real action: a library game's GameAction, a Steam app's GameAction (from its store facts), or
 * Request for anything else (adds it and looks, as the old search preview did). Enter goes to the full search.
 */
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { LookupHit } from "../api";
import { act, useApp, useLib, useLookup } from "../data";
import { journeyOf } from "../model";
import { hitArt } from "../ui/art";
import { TextField, Spinner } from "../ui/controls";
import { ActionPill, GameAction } from "../ui/game-action";
import { Icon } from "../ui/icons";
import { useUi } from "../ui/kit";
import { PosterArt } from "../ui/poster";
import { hitLine, isGameHit } from "../ui/words";
import { leavingProps, usePresence } from "../ui/motion";
import { usePopover } from "./popover";

export function RequestButtonView({ open, onClick }: { open?: boolean; onClick?: () => void }) {
  return (
    <button type="button" className={`fpill tb-request${open ? " on" : ""}`} onClick={onClick} aria-label="Request" aria-expanded={open} aria-haspopup="dialog">
      <span className="tb-plus" aria-hidden><Icon name="plus" size={14} strokeWidth={3} /></span><span className="tb-request-t">Request</span>
    </button>
  );
}

export function RequestButton() {
  const pop = usePopover("request");
  const panel = usePresence(pop.isOpen);
  return (
    <div className="tb-pop-wrap" ref={pop.ref}>
      <RequestButtonView open={pop.isOpen} onClick={pop.toggle} />
      {panel.mounted && <RequestPanel onClose={pop.close} leaving={panel.leaving} />}
    </div>
  );
}

function RequestPanel({ onClose, leaving }: { onClose: () => void; leaving?: boolean }) {
  const [q, setQ] = useState("");
  const nav = useNavigate();
  const term = q.trim();
  const { hits, error, busy } = useLookup(term);
  const shown = (hits ?? []).filter(isGameHit).slice(0, 6);
  const all = `/search?q=${encodeURIComponent(term)}`;
  return (
    <div className="tb-panel rq" {...leavingProps(!!leaving)} role="dialog" aria-label="Request a game">
      <form role="search" onSubmit={e => { e.preventDefault(); if (term) { nav(all); onClose(); } }}>
        <TextField icon="search" well autoFocus placeholder="Find a game" aria-label="Find a game" value={q} onChange={e => setQ(e.target.value)} />
      </form>
      {term && <div className="rq-body">
        {busy && !hits ? <Spinner block /> : error ? <p className="rq-none">{error}</p> : shown.length ? (
          <ol className="rq-list">{shown.map(h => <RequestHit key={`${h.id.scheme}:${h.id.value}`} h={h} onNavigate={onClose} />)}</ol>
        ) : hits ? <p className="rq-none">Nothing called “{term}”</p> : null}
        <Link to={all} className="rq-all" onClick={onClose}>Everything for “{term}”<Icon name="chev" size={16} strokeWidth={2.2} /></Link>
      </div>}
    </div>
  );
}

function RequestHit({ h, onNavigate }: { h: LookupHit; onNavigate: () => void }) {
  const lib = useLib();
  const g = h.gameId != null ? lib.byId.get(h.gameId) : undefined;
  const steamId = h.id.scheme === "steam" ? Number(h.id.value) : null;
  const { item: app, error: appError } = useApp(!g && steamId ? steamId : null);
  const to = g ? `/game/${g.id}` : steamId ? `/steam/${steamId}` : null;
  const line = g ? journeyOf(g).label || hitLine(h) : hitLine(h);
  return <RequestRow art={hitArt(h, 96)} title={h.name} line={line} to={to} onNavigate={onNavigate}
    action={g ? <GameAction game={g} variant="row" label={h.name} /> : app ? <GameAction app={app} variant="row" label={h.name} /> : steamId ? (appError ? null : <Spinner size={16} />) : <HitRequest h={h} onDone={onNavigate} />} />;
}

/** one hit in the panel: its capsule, name and line (a link to its page when it has one), and its action */
export function RequestRow({ art, title, line, to, action, onNavigate }: { art: string | null; title: string; line: string; to: string | null; action: ReactNode; onNavigate?: () => void }) {
  const body = <><PosterArt src={art} title={title} w={40} h={60} r={8} /><span className="rq-tx"><b>{title}</b><small>{line}</small></span></>;
  return (
    <li className="rq-row">
      {to ? <Link to={to} className="rq-hit" onClick={onNavigate}>{body}</Link> : <span className="rq-hit">{body}</span>}
      {action}
    </li>
  );
}

/** a hit from outside the store: add it to the server and look for it (the old search preview's Get it) */
function HitRequest({ h, onDone }: { h: LookupHit; onDone: () => void }) {
  const { toast, choose } = useUi();
  const lib = useLib();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    // on several platforms: which version (closing the question asks for nothing)
    const platform = h.choices && h.choices.length > 1 ? await choose("Which version?", h.choices) : undefined;
    if (platform === null) return;
    setBusy(true);
    try { const r = await act.getHit(h, true, platform); toast("On its way", "success"); await lib.reload(); onDone(); nav(`/game/${r.item.id}`); }
    catch (e: any) { toast(String(e?.message ?? e), "danger"); } finally { setBusy(false); }
  };
  return <ActionPill look="row" busy={busy} act={{ kind: "request", label: "Request", icon: "plus", lead: true }} label={h.name} onClick={() => void go()} />;
}

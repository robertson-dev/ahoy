/**
 * Ahoy — the search hits Search (/search) shows beside the library's own cards (ui/status LibraryCard):
 *   SteamHitCard / OtherHitCard   hits from the store or the catalogue, with their real action
 *   useRequestHit                 add a catalogue hit to the server and look for it (the old search preview's Get it)
 * Discover also uses the catalogue card and preview when browsing by platform.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { sentence, type LookupHit } from "../api";
import { act, useApp, useLib } from "../data";
import { Art, hitArt } from "../ui/art";
import { Button } from "../ui/button";
import { ActionPill, GameAction } from "../ui/game-action";
import { Icon } from "../ui/icons";
import { Modal, useUi } from "../ui/kit";
import { PosterCard } from "../ui/poster";
import { hitLine, PLATFORM_WORD } from "../ui/words";
import "./search.css";

/* ─────────── search hits ─────────── */

/** a hit's line: its year and platforms, "Steam" for a store hit with neither (ui/words hitLine) */
const lineOf = hitLine;

/** a hit's art on a 204 card (ui/art hitArt: a catalogue title's cover comes from the engine, through the server) */
export const hitPoster = (h: LookupHit) => hitArt(h, 408);

/** a hit from the store that is not on the server: its facts (coming soon, protected) are read when the card is first pointed at */
export function SteamHitCard({ h }: { h: LookupHit }) {
  const appId = Number(h.id.value);
  const [armed, setArmed] = useState(false);
  const line = lineOf(h);
  return (
    <div className="sx-arm" onPointerEnter={() => setArmed(true)} onFocus={() => setArmed(true)}>
      <PosterCard size={204} to={`/steam/${appId}`} art={hitPoster(h)} title={h.name} line={line} label={line ? `${h.name} — ${line}` : h.name}
        action={armed ? <SteamAction appId={appId} name={h.name} /> : <Waiting />} />
    </div>
  );
}

function SteamAction({ appId, name }: { appId: number; name: string }) {
  const { item, error } = useApp(appId);
  if (item) return <GameAction app={item} variant="pill" label={name} />;
  // the store did not answer for it: what its page would offer, Request (the store's facts decide again there)
  if (error) return <GameAction app={{ appId, gameId: null, comingSoon: false, crackStatus: null, drm: null }} variant="pill" label={name} />;
  return <Waiting />;
}

/** the pill's place while the action is being read */
const Waiting = () => <span className="ap sx-wait" role="status" aria-label="Reading"><Icon name="spinner" size={14} strokeWidth={2.4} /></span>;

/** a hit from the catalogue (no store page): the card opens its preview; Request adds it and looks for it */
export function OtherHitCard({ h, onPreview, platform }: { h: LookupHit; onPreview: (h: LookupHit) => void; platform?: string }) {
  const line = lineOf(h);
  return <PosterCard size={204} onOpen={() => onPreview(h)} art={hitPoster(h)} title={h.name} line={line} label={line ? `${h.name} — ${line}` : h.name}
    action={<RequestHit h={h} platform={platform} />} />;
}

/** a failed Request in the product's words: the server's own sentence, unless it is the engine talking (its name, an HTTP code) */
const failedWords = (e: unknown) => {
  const m = String((e as { message?: string })?.message ?? e);
  return /ludarr|playarr|engine|HTTP \d{3}|fetch failed|ECONN|not JSON/i.test(m) ? "Request didn't work" : sentence(m);
};

/** add a catalogue hit to the server and start looking (the old search preview's Get it), then open its game page */
function useRequestHit(h: LookupHit | null, onDone?: () => void, selectedPlatform?: string) {
  const { toast, choose } = useUi();
  const lib = useLib();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!h) return;
    // on several platforms: which version (closing the question asks for nothing)
    const platform = selectedPlatform ?? (h.choices && h.choices.length > 1 ? await choose("Which version?", h.choices) : undefined);
    if (platform === null) return;
    setBusy(true);
    try { const r = await act.getHit(h, true, platform); toast("On its way", "success"); await lib.reload(); onDone?.(); nav(`/game/${r.item.id}`); }
    catch (e) { toast(failedWords(e), "danger"); } finally { setBusy(false); }
  };
  return { go, busy };
}

function RequestHit({ h, platform }: { h: LookupHit; platform?: string }) {
  const { go, busy } = useRequestHit(h, undefined, platform);
  return <ActionPill act={{ kind: "request", label: "Request", icon: "plus", lead: true }} busy={busy} label={h.name} onClick={() => void go()} />;
}

export function HitPreview({ h, onClose, platform }: { h: LookupHit | null; onClose: () => void; platform?: string }) {
  const { go, busy } = useRequestHit(h, onClose, platform);
  const plats = [...new Set((h?.platforms ?? []).map(p => (/^(win|pc|windows)$/i.test(p) ? "PC" : PLATFORM_WORD[p.toLowerCase()] ?? p)))].join(", ");
  const facts = [h?.year, plats].filter(Boolean).join(" · ");
  const about = h?.summary ? (h.summary.length > 500 ? h.summary.slice(0, 500).trimEnd() + "…" : h.summary) : null;
  return (
    <Modal open={!!h} onClose={onClose} title={h?.name ?? ""}
      foot={<><Button kind="quiet" size={44} onClick={onClose}>Close</Button><Button kind="primary" size={44} icon="plus" busy={busy} onClick={() => void go()}>Request</Button></>}>
      {h && <div className="sx-pv">
        <span className="sx-pv-art"><Art src={hitPoster(h)} title={h.name} /></span>
        <div className="sx-pv-tx">
          {facts && <p className="sx-pv-facts">{facts}</p>}
          {about && <p className="sx-pv-about">{about}</p>}
        </div>
      </div>}
    </Modal>
  );
}

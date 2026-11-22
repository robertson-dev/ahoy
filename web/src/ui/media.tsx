/** Trailers and screenshots: a muted looping reel behind a hero (the big screen), the full-screen viewer (the game page). */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Trailer } from "../data";
import { Icon } from "./icons";
import { useDialogFocus } from "./kit";

/** Steam serves trailers as HLS manifests now (older apps still have mp4 / webm): hls.js feeds the <video> through MSE, starting
 *  `from` seconds in (a plain file is moved there when its length is known: Reel) */
function attach(v: HTMLVideoElement, t: Trailer, from = 0): () => void {
  if (t.hls) {
    let dead = false, player: { destroy(): void } | null = null;
    void import("hls.js").then(({ default: Hls }) => {
      if (dead) return;
      if (!Hls.isSupported()) { v.src = t.mp4 ?? t.webm ?? t.hls!; v.load(); return; }
      const h = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 20, startLevel: -1, startPosition: from > 0 ? from : -1 });
      h.loadSource(t.hls!); h.attachMedia(v); player = h;
      const p = v.play(); if (p) p.catch(() => {});
    });
    return () => { dead = true; player?.destroy(); };
  }
  v.src = t.mp4 ?? t.webm ?? ""; v.load();
  return () => { v.removeAttribute("src"); v.load(); };
}

/** a trailer playing quietly in the background of a hero; React does not set `muted` reliably, so it is done by hand.
 *  `from`: start this many seconds in, and loop back there, past the rating cards and logos most trailers open with (a trailer
 *  shorter than three such openings plays whole); `onReady` then says when it is playing there, not when it starts loading */
export function Reel({ t, poster, className, sound, onReady, from = 0 }: { t: Trailer; poster?: string | null; className?: string; sound?: boolean; onReady?: () => void; from?: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => { const v = ref.current; if (!v) return; v.defaultMuted = true; v.muted = !sound; if (sound) v.volume = 0.6; }, [sound]);
  useEffect(() => {
    const v = ref.current; if (!v) return;
    v.defaultMuted = true; v.muted = true;
    const off = attach(v, t, from);
    const skips = () => from > 0 && v.duration > from * 3;
    const start = () => { if (skips() && v.currentTime < from - 0.25) v.currentTime = from; };
    let told = false;
    const tell = () => {
      if (told || !from || v.paused || v.seeking || !(v.duration > 0)) return;
      if (!skips() || v.currentTime >= from - 0.5) { told = true; ready.current?.(); }
    };
    const again = () => { v.currentTime = skips() ? from : 0; const p = v.play(); if (p) p.catch(() => {}); };
    v.addEventListener("loadedmetadata", start); v.addEventListener("timeupdate", tell); v.addEventListener("ended", again);
    const p = v.play(); if (p) p.catch(() => {});
    return () => { v.removeEventListener("loadedmetadata", start); v.removeEventListener("timeupdate", tell); v.removeEventListener("ended", again); off(); };
  }, [t.hls, t.mp4, t.webm, from]);
  return <video ref={ref} className={className} poster={poster ?? t.thumb} autoPlay loop={!from} playsInline muted preload="auto" onPlaying={from ? undefined : onReady} disablePictureInPicture />;
}

/** a trailer with controls and sound, for the viewer */
function Clip({ t }: { t: Trailer }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { const v = ref.current; if (!v) return; const off = attach(v, t); const p = v.play(); if (p) p.catch(() => {}); return off; }, [t.hls, t.mp4, t.webm]);
  return <video ref={ref} controls autoPlay playsInline poster={t.thumb} />;
}

export function Viewer({ open, index, trailers, shots, onClose }: { open: boolean; index: number; trailers: Trailer[]; shots: string[]; onClose: () => void }) {
  const [i, setI] = useState(index);
  const box = useRef<HTMLDivElement>(null);
  const total = trailers.length + shots.length;
  useEffect(() => { setI(index); }, [index, open]);
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); if (e.key === "ArrowRight") setI(x => Math.min(total - 1, x + 1)); if (e.key === "ArrowLeft") setI(x => Math.max(0, x - 1)); };
    addEventListener("keydown", on); return () => removeEventListener("keydown", on);
  }, [open, total, onClose]);
  useDialogFocus(open && total > 0, box);
  if (!open || !total) return null;
  const t = i < trailers.length ? trailers[i] : null;
  const shot = t ? null : shots[i - trailers.length];
  // in a portal on the body, like every dialog (ui/kit Modal): no transformed or faded ancestor traps it under the bar
  return createPortal(
    <div ref={box} tabIndex={-1} className="viewer" role="dialog" aria-modal="true" aria-label={t ? t.name || "Trailer" : "Screenshot"} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <button className="ib close" onClick={onClose} aria-label="Close" data-autofocus><Icon name="x" size={18} /></button>
      {i > 0 && <button className="ib prev" onClick={() => setI(i - 1)} aria-label="Previous"><Icon name="chevronLeft" size={20} /></button>}
      {i < total - 1 && <button className="ib next" onClick={() => setI(i + 1)} aria-label="Next"><Icon name="chevronRight" size={20} /></button>}
      <div className="stage">{t ? <Clip key={t.hls ?? t.mp4 ?? i} t={t} /> : <img src={shot!} alt="" />}</div>
      <div className="count mono">{i + 1} / {total}</div>
    </div>,
    document.body,
  );
}

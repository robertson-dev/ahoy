/**
 * Settings → Your PCs: every PC my launcher has run on. Which of them install what I ask for when it arrives (a chip each,
 * pressed is yes: the server keeps it per PC, pcs.ts `auto`), and each PC with what is known of it (on now or when it was
 * last on, its games, the room it has); Forget (asks first) takes one I no longer have off the list, with what was to be
 * installed on it. This PC is never forgotten from itself: it would be back the moment the page loads.
 * Not there while I have no PC (a plain browser before the launcher was ever run).
 */
import { useState } from "react";
import { fmtSize, timeAgo } from "../api";
import { usePcs } from "../pcs";
import { Ask } from "../ui/ask";
import { useUi } from "../ui/kit";
import { Row, Section, errText } from "./settings-kit";

export function YourPcsSection() {
  const P = usePcs();
  const { toast } = useUi();
  const [asking, setAsking] = useState<string | null>(null);
  if (!P.pcs.length) return null;
  const run = (fn: () => Promise<unknown>) => { void fn().catch(e => toast(errText(e), "danger")); };
  return (
    <Section id="your-pcs" title="Your PCs">
      <Row label="Install what I ask for on" labelId="pcs-auto">
        <div className="st-radios" role="group" aria-labelledby="pcs-auto">
          {P.pcs.map(p => (
            <button key={p.device} type="button" className={`chip${p.auto ? " on" : ""}`} aria-pressed={p.auto} onClick={() => run(() => P.setAuto(p.device, !p.auto))}>{p.device}</button>
          ))}
        </div>
      </Row>
      {P.pcs.map(p => {
        const here = p.device === P.here;
        const facts = [`${p.games} ${p.games === 1 ? "game" : "games"}`, p.freeBytes != null ? `${fmtSize(p.freeBytes)} free` : null].filter(Boolean).join(" · ");
        return (
          <Row key={p.device} label={p.device} top actions={here ? undefined : (
            <Ask open={asking === p.device} onOpen={() => setAsking(p.device)} onClose={() => setAsking(a => (a === p.device ? null : a))} className="st-flush"
              label="Forget" aria={`Forget ${p.device}`} confirm="Forget this PC" confirmAria={`Forget ${p.device}`} onConfirm={() => P.forget(p.device).catch(e => toast(errText(e), "danger"))} />
          )}>
            <span className="st-two">
              <span className="st-v">{here ? "This PC" : p.on ? "On now" : p.seenAt ? `Last on ${timeAgo(p.seenAt)}` : "Not on yet"}</span>
              <span className="st-sub">{facts}</span>
            </span>
          </Row>
        );
      })}
    </Section>
  );
}

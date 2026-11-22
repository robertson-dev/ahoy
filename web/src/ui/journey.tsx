/**
 * The journey: five stops, Found · Downloaded · Prepared · Ready · Installed. Stops reached are filled dots; the stop under
 * way is a ringed dot that carries its active word (Downloading, Installing…); the leg into it fills to the progress; the
 * rest are hollow. It takes the product's Journey (model.ts journeyOf), so every surface says the same thing.
 * Boards: M/lfs/library-wall (the tickets: "sm", 12 px words) and M/lfs/library-split (the game page: "lg", 13 px words).
 * It spans its container's width; stops sit on even steps from the first centre to the last.
 */
import type { CSSProperties } from "react";
import { STOPS, type Journey } from "../model";

export function JourneyLine({ j, size = "sm", labels = true, className }: { j: Journey; size?: "sm" | "lg"; labels?: boolean; className?: string }) {
  const failed = j.stage === "failed";
  const word = (i: number) => (j.current === i && j.active ? j.label : STOPS[i]);
  const legOf = (i: number) => (i + 1 < j.done ? "done" : j.current === i + 1 && j.progress != null ? "part" : "todo");
  const pct = j.progress != null ? ` ${Math.round(j.progress * 100)}%` : "";
  const spoken = STOPS.map((s, i) => (i < j.done ? `${s} done` : j.current === i ? `${word(i)}${pct}` : s)).join(", ");
  return (
    <div className={`jl ${size}${className ? " " + className : ""}`} role="img" aria-label={failed ? `Didn't make it. ${spoken}` : spoken}>
      <div className="jl-track">
        {[0, 1, 2, 3].map(i => {
          const k = legOf(i);
          return <span key={`l${i}`} className={`jl-leg ${k}`} style={{ ["--i" as string]: i, ["--p" as string]: k === "part" ? Math.max(0, Math.min(1, j.progress ?? 0)) : 0 } as CSSProperties} />;
        })}
        {STOPS.map((_, i) => {
          const k = i < j.done ? "done" : j.current === i ? "cur" : failed && i === 0 ? "fail" : "todo";
          return <span key={`s${i}`} className={`jl-stop ${k}`} style={{ ["--i" as string]: i } as CSSProperties} />;
        })}
      </div>
      {labels && <ol className="jl-words">{STOPS.map((_, i) => <li key={i} className={i < j.done ? "done" : j.current === i ? "cur" : undefined} style={{ ["--i" as string]: i } as CSSProperties}>{word(i)}</li>)}</ol>}
    </div>
  );
}

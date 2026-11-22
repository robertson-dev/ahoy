/**
 * Install on…: my PCs and how each stands to one game, with the one thing to do about each (a dialog; GameAction opens it).
 *   it is there                  "Installed"
 *   it is to be installed there  "Installing 48%" · "Starting" · "When it's on" · "When it arrives"      Cancel
 *   it could not be              why ("Not enough room")                                                Try again
 *   else                         "On now" / "Not on now"                                                Install
 * A PC that is off installs when it is next on; a game still on its way installs when it arrives (orders.ts, pcs.tsx).
 * This PC is listed only for a game that has no copy yet: once it has one, its own Install is the game's main action.
 */
import { useState } from "react";
import type { Game } from "../api";
import { isOpen, orderWords, type PcState } from "../orders";
import { usePcs } from "../pcs";
import { Button } from "./button";
import { Icon } from "./icons";
import { Modal, useUi } from "./kit";

/** does the server have a copy that can be installed now */
export const hasCopy = (g: Pick<Game, "status" | "file">) => g.status === "available" && !!g.file;

/** one PC's line under its name (this PC, listed as "This PC", says its name there) */
export function pcLine(p: PcState, copy: boolean): string {
  if (p.has) return "Installed";
  if (p.order) return orderWords(p.order, p.on, copy);
  return p.here ? p.device : p.on ? "On now" : "Not on now";
}

export function InstallOn({ game, onClose }: { game: Game; onClose: () => void }) {
  const P = usePcs();
  const { toast } = useUi();
  const [busy, setBusy] = useState<string | null>(null);
  const copy = hasCopy(game);
  // this PC first, when it is listed
  const rows = P.statesOf(game.id).filter(p => !p.here || !copy).sort((a, b) => Number(b.here) - Number(a.here));
  const run = async (p: PcState, fn: () => Promise<unknown>) => {
    setBusy(p.device);
    try { await fn(); } catch (e: any) { toast(String(e?.message ?? e), "danger"); } finally { setBusy(null); }
  };
  return (
    <Modal open onClose={onClose} title="Install on" sm foot={<Button kind="quiet" size={44} onClick={onClose} data-autofocus>Done</Button>}>
      <ul className="io-list" aria-label={`Install ${game.name} on`}>
        {rows.map(p => {
          const name = p.here ? "This PC" : p.device, o = p.order;
          return (
            <li key={p.device} className="io-row">
              <span className="io-pc"><b>{name}</b><small aria-live="polite">{pcLine(p, copy)}</small></span>
              {p.has ? <Icon name="tick" size={18} strokeWidth={2.6} className="io-tick" />
                : o && isOpen(o) ? <Button size={36} busy={busy === p.device} aria-label={`Cancel installing on ${name}`} onClick={() => void run(p, () => P.cancel(o.id))}>Cancel</Button>
                : o ? <Button size={36} icon="retry" busy={busy === p.device} aria-label={`Try again on ${name}`} onClick={() => void run(p, () => P.place(p.device, game.id))}>Try again</Button>
                : <Button kind="primary" size={36} busy={busy === p.device} aria-label={`Install on ${name}`} onClick={() => void run(p, () => P.place(p.device, game.id))}>Install</Button>}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

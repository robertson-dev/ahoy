/** The top bar's downloads pill: the first thing on its way ("Downloading Endacopia 48%"), from this PC's installs and the server's requests. */
import { Link } from "react-router-dom";
import { useLib } from "../data";
import { useLauncher } from "../launcher-state";
import { isActive, journeyOf } from "../model";
import { Icon } from "../ui/icons";

export interface Transfer { label: string; name: string; progress: number | null; gameId: number | null; count: number }

const STAGE_RANK: Record<string, number> = { importing: 2, downloading: 1, searching: 0 };

/** what moves now: an install on this PC first, then the server's request that is furthest along */
export function useTransfer(): Transfer | null {
  const lib = useLib();
  const L = useLauncher();
  const installs = Object.values(L.installs);
  const moving = lib.games.filter(isActive).sort((a, b) => (STAGE_RANK[b.status] ?? 0) - (STAGE_RANK[a.status] ?? 0) || (b.request?.progress ?? 0) - (a.request?.progress ?? 0) || a.name.localeCompare(b.name));
  const count = installs.length + moving.length;
  if (installs.length) {
    const p = installs[0];
    const g = lib.games.find(x => x.file?.id === p.packageId) ?? null;
    const j = journeyOf(g, undefined, p);
    return { label: j.label, name: p.name || g?.name || "", progress: p.progress, gameId: p.gameId ?? g?.id ?? null, count };
  }
  if (moving.length) {
    const g = moving[0];
    const j = journeyOf(g);
    return { label: j.label, name: g.name, progress: j.progress != null && j.progress > 0 ? j.progress : null, gameId: g.id, count };
  }
  return null;
}

/** the pill itself; it links to what is on the way */
export function TransferPill({ t, to = "/downloads" }: { t: Transfer; to?: string }) {
  const pct = t.progress != null ? `${Math.round(t.progress * 100)}%` : null;
  const more = t.count > 1 ? `, and ${t.count - 1} more` : "";
  return (
    <Link to={to} className="fpill tb-transfer" aria-label={`On the way: ${t.label} ${t.name}${pct ? `, ${pct}` : ""}${more}`} title={t.count > 1 ? `${t.count} on the way` : undefined}>
      <Icon name="transfer" size={18} className="fpill-ic" />
      <span className="tb-w">{t.label}</span><b className="tb-name">{t.name}</b>{pct && <span className="tb-w">{pct}</span>}
    </Link>
  );
}

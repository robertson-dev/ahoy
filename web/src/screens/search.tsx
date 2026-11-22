/**
 * Ahoy — Search (/search?q=). No board of its own: Discover's language (M/disc/picked: section heads, a wall of 204 shelf
 * cards, the action on hover) and Settings' fields (M/lfs/settings). The page is a big field and what it finds:
 *   On your server   the library games whose name holds the words (the Library's status lines and actions)
 *   Out there        everything else the lookup finds (ludarr's catalogue, the store): a store game opens its Steam page
 *                    and carries its real action; a catalogue entry opens a preview with Request
 * Typing searches as you go (the address follows, without new history); Esc clears.
 * The Discover lists (/discover/list/:key) are in list-page.tsx and share this file's export for App.tsx.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Game, LookupHit } from "../api";
import { useLib, useLookup } from "../data";
import { Button, ButtonLink } from "../ui/button";
import { EmptyState, Spinner } from "../ui/controls";
import { Icon } from "../ui/icons";
import { SectionHead } from "../ui/section";
import { isGameHit } from "../ui/words";
import { useLauncher } from "../launcher-state";
import { LibraryCard, useLineCtx } from "../ui/status";
import { OtherHitCard, SteamHitCard, HitPreview } from "./search-parts";
import "./search.css";

export { ListPage } from "./list-page";

/** the closest names first: the whole name, then names that start with the words, then the rest by name */
function closest(games: Game[], t: string) {
  const score = (n: string) => (n === t ? 0 : n.startsWith(t) ? 1 : 2);
  return [...games].sort((a, b) => score(a.name.toLowerCase()) - score(b.name.toLowerCase()) || a.name.localeCompare(b.name));
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const [q, setQ] = useState(urlQ);
  const box = useRef<HTMLInputElement>(null);
  // the address leads: the top bar's search (Enter) and Back / Forward land here
  useEffect(() => { setQ(prev => (prev.trim() === urlQ.trim() ? prev : urlQ)); }, [urlQ]);
  const change = (v: string) => { setQ(v); setParams(v.trim() ? { q: v } : {}, { replace: true }); };
  const term = urlQ.trim();
  const [retry, setRetry] = useState(0);
  return (
    <div className="sx">
      <h1 className="sr-only">Search</h1>
      <form role="search" className="sx-find" onSubmit={e => { e.preventDefault(); box.current?.blur(); }}>
        <label className="sx-field">
          <Icon name="search" size={22} strokeWidth={2.2} className="sx-field-ic" />
          <input ref={box} type="search" value={q} autoFocus={!term} placeholder="Search games" aria-label="Search games" autoComplete="off" spellCheck={false}
            onChange={e => change(e.target.value)} onKeyDown={e => { if (e.key === "Escape" && q) { e.preventDefault(); change(""); } }} />
          {q && <button type="button" className="sx-clear" aria-label="Clear" title="Clear" onClick={() => { change(""); box.current?.focus(); }}><Icon name="x" size={18} strokeWidth={2.2} /></button>}
        </label>
      </form>
      {term && <Results key={retry} term={term} onRetry={() => setRetry(n => n + 1)} />}
    </div>
  );
}

function Results({ term, onRetry }: { term: string; onRetry: () => void }) {
  const lib = useLib();
  // my play time shows on the cards of games on this PC: only the launcher has any
  const c = useLineCtx({ play: useLauncher().inLauncher ? "mine" : undefined });
  const { hits, error, busy } = useLookup(term);
  const [preview, setPreview] = useState<LookupHit | null>(null);
  const t = term.toLowerCase();
  const mine = useMemo(() => closest(lib.games.filter(g => g.name.toLowerCase().includes(t) || (g.aliases ?? []).some(a => a.toLowerCase().includes(t))), t), [lib.games, t]);
  const shown = (hits ?? []).filter(isGameHit).filter(h => h.gameId == null || !mine.some(g => g.id === h.gameId));
  return (
    <>
      {mine.length > 0 && (
        <section className="sx-sec" aria-labelledby="sx-mine">
          <SectionHead id="sx-mine" title="On your server" count={mine.length} />
          <ol className="sx-wall">{mine.map(g => <li key={g.id}><LibraryCard g={g} c={c} /></li>)}</ol>
        </section>
      )}
      {busy && !hits ? <Spinner block label="Searching" />
        : error ? <EmptyState icon="alert" title="Search didn't work" action={<Button size={44} icon="retry" onClick={onRetry}>Try again</Button>} />
        : shown.length ? (
          <section className="sx-sec" aria-labelledby="sx-out" aria-busy={busy}>
            <SectionHead id="sx-out" title="Out there" count={shown.length} right={busy ? <Spinner size={16} label="Searching" /> : null} />
            <ol className="sx-wall">{shown.map(h => {
              const g = h.gameId != null ? lib.byId.get(h.gameId) : undefined;
              return <li key={`${h.id.scheme}:${h.id.value}`}>{g ? <LibraryCard g={g} c={c} /> : h.id.scheme === "steam" ? <SteamHitCard h={h} /> : <OtherHitCard h={h} onPreview={setPreview} />}</li>;
            })}</ol>
          </section>
        )
        : hits && !mine.length ? <EmptyState icon="search" title={`Nothing called “${term}”`} action={<ButtonLink to="/discover" size={44}>Open Discover</ButtonLink>} />
        : null}
      <HitPreview h={preview} onClose={() => setPreview(null)} />
    </>
  );
}

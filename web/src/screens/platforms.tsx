import { useEffect, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { api, type LookupHit, type PlatformChoice } from "../api";
import { useDiscoverPlatforms, useLib } from "../data";
import { Button, ButtonLink } from "../ui/button";
import { EmptyState, Select, Spinner, TextField } from "../ui/controls";
import { SectionHead } from "../ui/section";
import { LibraryCard, useLineCtx } from "../ui/status";
import { HitPreview, OtherHitCard } from "./search-parts";

type Platform = PlatformChoice & { count: number };
interface Page { items: LookupHit[]; total: number; pages: number }
export const discoverPath = (platform: string, term: string, page = 1) => {
  const params = new URLSearchParams();
  if (platform && platform !== "all") params.set("platform", platform);
  if (term.trim()) params.set("q", term.trim());
  if (page > 1) params.set("page", String(page));
  return "/discover" + (params.size ? "?" + params : "");
};

export function LegacyPlatform() {
  const { platform = "", page = "1" } = useParams();
  const [params] = useSearchParams();
  return <Navigate replace to={discoverPath(platform, params.get("q") ?? "", Number(page))} />;
}

export function PlatformBrowser({ filtered, belowHero }: { filtered: boolean; belowHero: boolean }) {
  const [params, setParams] = useSearchParams();
  const platform = params.get("platform") || "all", term = params.get("q") || "";
  const page = Number(params.get("page") || "1");
  const [draft, setDraft] = useState(term);
  useEffect(() => { setDraft(term); }, [term]);
  const [attempt, setAttempt] = useState(0);
  const { items, error } = useDiscoverPlatforms(attempt);
  const selected = items?.find(p => p.id === platform);
  function apply(id: string, query: string) {
    const next = new URLSearchParams();
    if (id !== "all") next.set("platform", id);
    if (query.trim()) next.set("q", query.trim());
    setParams(next);
  }
  return <section className="sx sx-list dsc-platforms" aria-label="Browse games">
    {!belowHero && <SectionHead as="h1" title="Discover" />}
    <form className="dsc-filters" role="search" aria-label="Discover games" onSubmit={e => { e.preventDefault(); apply(platform, draft); }}>
      <TextField type="search" icon="search" value={draft} aria-label="Game title" maxLength={120} placeholder="Search games" onChange={e => {
        setDraft(e.target.value);
        if (!e.target.value && term) apply(platform, "");
      }} />
      <Select label="Platform" value={platform} options={[{ value: "all", label: "All platforms" }, ...(items ?? []).map(p => ({ value: p.id, label: p.label }))]}
        onChange={id => apply(id, draft)} />
      <Button type="submit" kind="primary">Search</Button>
      {filtered && <Button kind="quiet" onClick={() => { setDraft(""); apply("all", ""); }}>Clear filters</Button>}
    </form>
    {error ? <EmptyState title="Platforms couldn’t be loaded" action={<Button icon="retry" onClick={() => setAttempt(n => n + 1)}>Try again</Button>} />
      : filtered && (!items ? <Spinner block label="Loading platforms" />
        : (!selected && platform !== "all") || !Number.isSafeInteger(page) || page < 1 || page > 1_000_000 ? <EmptyState title="Page not found" />
        : <PlatformGames key={JSON.stringify([platform, term, page])} platform={selected ?? { id: "all", label: "All platforms", count: 0 }} term={term} page={page} />)}
  </section>;
}

function PlatformGames({ platform, page, term }: { platform: Platform; page: number; term: string }) {
  const lib = useLib();
  const c = useLineCtx();
  const [result, setResult] = useState<Page | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<LookupHit | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    api<Page>(`/api/v1/discover/platform/${encodeURIComponent(platform.id)}?page=${page}&q=${encodeURIComponent(term)}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setResult(data); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [platform.id, page, term, attempt]);

  if (failed) return <EmptyState title="Games couldn’t be loaded" action={<Button icon="retry" onClick={() => setAttempt(n => n + 1)}>Try again</Button>} />;
  if (!result) return <Spinner block label={`Loading ${platform.label} games`} />;
  if (!result.items.length) return <EmptyState title={page === 1 ? term ? `No games match “${term}”` : "No games here yet" : "No games on this page"}
    action={page > 1 ? <ButtonLink to={discoverPath(platform.id, term)}>First page</ButtonLink> : undefined} />;
  return (
    <div className="sx-body">
      <p className="dsc-count" role="status">{result.total.toLocaleString()} {result.total === 1 ? "game" : "games"} · {platform.label}</p>
      <ol className="sx-wall" aria-label={`${platform.label} games`}>{result.items.map(h => {
        const game = h.gameId == null ? undefined : lib.byId.get(h.gameId);
        return <li key={h.id.value}>{game ? <LibraryCard g={game} c={c} />
          : <OtherHitCard h={h} platform={platform.id === "all" ? undefined : platform.id} onPreview={setPreview} />}</li>;
      })}</ol>
      {result.pages > 1 && <nav className="dsc-platform-pages" aria-label="Game pages">
        {page > 1 && <ButtonLink to={discoverPath(platform.id, term, page - 1)}>Previous</ButtonLink>}
        <span>Page {page} of {result.pages.toLocaleString()}</span>
        {page < result.pages && <ButtonLink to={discoverPath(platform.id, term, page + 1)}>Next</ButtonLink>}
      </nav>}
      <HitPreview h={preview} platform={platform.id === "all" ? undefined : platform.id} onClose={() => setPreview(null)} />
    </div>
  );
}

/**
 * What's new, said once: after Ahoy updated (the page, or the launcher with what it brings) a quiet line says so with a way
 * into the list, and the account menu keeps the list with a count until it was opened. What a person has seen is kept on the
 * device (ahoy.news.seen: the items' ids), so each PC and browser says its own news once. The launcher's own update says what
 * it brings before it is installed (open(version)).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fmtDay } from "./api";
import { launcher } from "./launcher";
import { useSession } from "./session";
import { Button } from "./ui/button";
import { Modal, useUi } from "./ui/kit";
import { NEWS, comesWith, notesHere, unseen, type News, type NewsItem } from "./whatsnew";

interface NewsCtx {
  /** how many items are news here and not seen yet */
  count: number;
  /** the list; with a version: what the launcher's update to it brings */
  open: (version?: string | null) => void;
}
const Ctx = createContext<NewsCtx>({ count: 0, open: () => {} });
export const useNews = () => useContext(Ctx);

const SEEN = "ahoy.news.seen", TOLD = "ahoy.news.told";
const readIds = (key: string): Set<string> => { try { const v = JSON.parse(localStorage.getItem(key) ?? "[]"); return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []); } catch { return new Set(); } };
const writeIds = (key: string, ids: Iterable<string>) => { try { localStorage.setItem(key, JSON.stringify([...ids])); } catch { /* storage off: it is said again next time */ } };

export function NewsProvider({ children, news = NEWS }: { children: ReactNode; news?: readonly News[] }) {
  const { me, joinedAt } = useSession();
  const { toast } = useUi();
  const where = useMemo(() => ({ launcher: launcher?.version ?? null, joinedAt }), [joinedAt]);
  const [seen, setSeen] = useState(() => readIds(SEEN));
  const [shown, setShown] = useState<{ title: string; notes: News[]; fresh: Set<string> } | null>(null);
  const fresh = useMemo(() => (me ? unseen(news, where, seen) : []), [me, news, where, seen]);

  const open = useCallback((version?: string | null) => {
    if (version) {
      const items: NewsItem[] = comesWith(news, where.launcher, version);
      setShown({ title: `New in Ahoy ${version}`, notes: items.length ? [{ id: version, date: "", items }] : [], fresh: new Set() });
      return;
    }
    const mine = new Set(unseen(news, where, readIds(SEEN)).map(i => i.id));
    setShown({ title: "What's new", notes: notesHere(news, where), fresh: mine });
    // opened is seen: every item this place has, so the count is gone
    const all = new Set([...readIds(SEEN), ...notesHere(news, where).flatMap(n => n.items.map(i => i.id))]);
    writeIds(SEEN, all); setSeen(all);
  }, [news, where]);

  // said once per device: a quiet line with the way in (the menu keeps the count until the list was opened)
  useEffect(() => {
    if (!fresh.length) return;
    const told = readIds(TOLD);
    if (fresh.every(i => told.has(i.id))) return;
    writeIds(TOLD, [...told, ...fresh.map(i => i.id)]);
    toast(<>Ahoy was updated. <button className="link" onClick={() => open()}>What's new</button></>, "info", 12_000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh.length]);

  const value = useMemo(() => ({ count: fresh.length, open }), [fresh.length, open]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <Modal open={!!shown} onClose={() => setShown(null)} title={shown?.title ?? ""} foot={<Button kind="quiet" size={44} onClick={() => setShown(null)} data-autofocus>Done</Button>}>
        {shown && (shown.notes.length ? shown.notes.map(n => (
          <section key={n.id} className="wn-note">
            {n.date && <h3>{fmtDay(new Date(`${n.date}T12:00:00`))}</h3>}
            <ul>{n.items.map(i => <li key={i.id} className={shown.fresh.has(i.id) ? "wn-fresh" : undefined}>{i.text}</li>)}</ul>
          </section>
        )) : <p>Fixes and polish.</p>)}
      </Modal>
    </Ctx.Provider>
  );
}

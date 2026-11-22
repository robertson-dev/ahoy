/**
 * A game's saves kept in step between my PCs, live for every page (what moves is decided in saves.ts; the launcher does it).
 *
 * In the launcher (0.13 on, the setting on), for a game on this PC:
 *   before Play   this PC's saves are compared with the server's newest version; a newer one there comes down first, saves
 *                 only this PC has go up. When both have saves the other has not, Play asks which to keep (and does not
 *                 start the game until it is told). A server that does not answer in a few seconds keeps nobody from
 *                 playing: the game starts with the saves that are here.
 *   after it ends its saves go up as a new version, and again every few minutes while Ahoy stays open (a game whose own
 *                 launcher hands it on has "ended" long before the player stops playing).
 *   when Ahoy opens, and when another of my PCs brings a new version: the same, quietly, for every game on this PC (a game
 *                 started from its desktop shortcut was never seen ending).
 * Everywhere: how each game's saves stand (the game page says it), its versions on the server, and going back to one.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fmtSize, get, personNow, put, timeAgo, type Game } from "./api";
import { useLib } from "./data";
import { useEvents } from "./events";
import { launcher, type InstalledGame, type LauncherEvent } from "./launcher";
import { playGuards, useLauncher } from "./launcher-state";
import { decide, placeWords, saveKey, type SaveRules, type SaveState, type SaveStatus, type Snap } from "./saves";
import { errText } from "./screens/settings-kit";
import { useSession } from "./session";
import { Button } from "./ui/button";
import { Spinner } from "./ui/controls";
import { Modal, useUi } from "./ui/kit";

interface SavesCtx {
  /** this launcher keeps saves in step (0.13 on) */
  can: boolean;
  /** and its setting says so */
  on: boolean;
  setOn: (v: boolean) => Promise<void>;
  /** how a game's saves stand on this PC; null: not looked at yet (or no PC here) */
  statusOf: (gameId: number) => SaveStatus | null;
  /** the server's newest version of a game's saves, from any of my PCs */
  headOf: (g: Pick<Game, "id" | "steamAppId">) => (Snap & { versions: number }) | null;
  /** look now (the game's page, when it opens) */
  check: (g: Game) => void;
  /** both sides have saves the other has not: ask which to keep, now */
  choose: (g: Game) => void;
  /** the panel: where the saves are, the versions on the server, going back to one */
  open: (g: Game) => void;
}
const Ctx = createContext<SavesCtx>({ can: false, on: false, setOn: async () => {}, statusOf: () => null, headOf: () => null, check: () => {}, choose: () => {}, open: () => {} });
export const useSaves = () => useContext(Ctx);

const S = launcher?.features?.includes("saves") ? launcher.saves ?? null : null;
/** how long Play waits for the server before it starts the game with the saves that are here */
const PLAY_WAIT_MS = 5000;
/** how often the games played since Ahoy opened are looked at again */
const AGAIN_MS = 5 * 60_000;
const soon = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("no answer in time")), ms))]);
type Mode = "play" | "quiet" | "ask";

export function SavesProvider({ children }: { children: ReactNode }) {
  const { me, device } = useSession();
  const L = useLauncher();
  const lib = useLib();
  const { toast } = useUi();
  const [on, setOnState] = useState(false);
  const [status, setStatus] = useState<Map<number, SaveStatus>>(new Map());
  const [heads, setHeads] = useState<Map<string, Snap & { versions: number }>>(new Map());
  const [asking, setAsking] = useState<{ g: Game; head: Snap; local: SaveState; answer: (v: "here" | "there" | null) => void } | null>(null);
  const [panel, setPanel] = useState<Game | null>(null);
  const now = useRef({ on, L, lib, device });
  now.current = { on, L, lib, device };

  useEffect(() => { if (S) void launcher!.config().then(c => setOnState(c.syncSaves !== false)).catch(() => {}); }, []);
  const setOn = useCallback(async (v: boolean) => {
    const r = await launcher!.setConfig({ syncSaves: v });
    if (!r.ok) throw new Error(r.error ?? "That did not save");
    setOnState(v);
  }, []);

  // every game I have saves of on the server: its newest version
  const loadHeads = useCallback(async () => {
    if (!me) return;
    const who = personNow();
    try {
      const r = await get<{ items: (Snap & { versions: number })[] }>("/api/v1/saves");
      if (who === personNow()) setHeads(new Map(r.items.map(i => [i.key, i])));
    } catch { /* asked again at the next event */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);
  useEffect(() => { setHeads(new Map()); setStatus(new Map()); void loadHeads(); }, [loadHeads]);

  const say = useCallback((gameId: number, s: SaveStatus) => setStatus(m => new Map(m).set(gameId, s)), []);
  const rules = useRef(new Map<string, { at: number; rules: SaveRules }>());
  const rulesFor = useCallback(async (key: string, fresh = false) => {
    const c = rules.current.get(key);
    if (c && !fresh && Date.now() - c.at < 10 * 60_000) return c.rules;
    const r = await get<SaveRules>(`/api/v1/saves/${key}/rules`);
    rules.current.set(key, { at: Date.now(), rules: r });
    return r;
  }, []);
  const ask = useCallback((g: Game, head: Snap, local: SaveState) => new Promise<"here" | "there" | null>(answer => setAsking({ g, head, local, answer })), []);

  /** one look at a game's saves, and what follows from it; false only when Play must not start the game (the player closed
   *  the question, or the saves they chose did not come) */
  const turns = useRef(new Map<string, Promise<boolean>>());
  const sync = useCallback((g: Game, inst: InstalledGame, mode: Mode): Promise<boolean> => {
    if (!S || !now.current.on || inst.kind === "rom") return Promise.resolve(true);
    const key = saveKey(g);
    const before = turns.current.get(key);
    const run = (before ?? Promise.resolve(true)).then(async () => {
      const wait = mode === "play" ? PLAY_WAIT_MS : 30_000;
      try {
        if (mode !== "quiet") say(g.id, { is: "checking" });
        const r = await soon(rulesFor(key), wait);
        const local = await S.state(inst.slug, key, r);
        if (local.tooBig) { say(g.id, { is: "too-big" }); return true; }
        const head = (await soon(get<{ items: Snap[] }>(`/api/v1/saves/${key}`), wait)).items[0] ?? null;
        const step = decide(local.digest, local.base?.digest ?? null, head);
        const done = async () => { const h = (await get<{ items: Snap[] }>(`/api/v1/saves/${key}`)).items[0] ?? null; say(g.id, h ? { is: "synced", head: h } : { is: "none" }); void loadHeads(); };
        if (step.do === "nothing") { say(g.id, head ? { is: "synced", head } : { is: "none" }); return true; }
        if (step.do === "agree") { await S.agree(inst.slug, key, r, { id: step.head.id, digest: step.head.digest }); say(g.id, { is: "synced", head: step.head }); return true; }
        if (step.do === "push") { await S.push(inst.slug, key, r); await done(); return true; }
        if (step.do === "pull") {
          // never under a game that runs: its next look does it
          if (mode !== "play" && now.current.L.playing[inst.slug]) { say(g.id, { is: "waiting" }); return true; }
          await S.pull(inst.slug, key, r, step.head.id);
          say(g.id, { is: "synced", head: step.head });
          return true;
        }
        if (mode === "quiet") { say(g.id, { is: "choose", head: step.head, local }); return true; }
        const choice = await ask(g, step.head, local);
        if (!choice) { say(g.id, { is: "choose", head: step.head, local }); return false; }
        try {
          if (choice === "here") { await S.push(inst.slug, key, r); await done(); }
          else { await S.pull(inst.slug, key, r, step.head.id); say(g.id, { is: "synced", head: step.head }); }
        } catch (e) {
          say(g.id, { is: "choose", head: step.head, local });
          toast(`${g.name}: ${errText(e, "launcher")}`, "danger");
          return false;
        }
        return true;
      } catch (e) {
        say(g.id, { is: "waiting" });
        if (mode === "ask") toast(`${g.name}: ${errText(e, "launcher")}`, "danger");
        return true;
      }
    });
    turns.current.set(key, run);
    void run.finally(() => { if (turns.current.get(key) === run) turns.current.delete(key); });
    return run;
  }, [say, rulesFor, ask, loadHeads, toast]);

  /** the game on this PC a library game is, when it is here */
  const here = (g: Game) => now.current.L.installedFor(g.id, g.file?.id);
  const gameOf = (slug: string) => { const inst = now.current.L.installed.find(x => x.slug === slug); const g = inst?.gameId != null ? now.current.lib.byId.get(inst.gameId) : undefined; return inst && g ? { inst, g } : null; };

  // Play: the saves first
  useEffect(() => {
    if (!S) return;
    const guard = (slug: string) => { const x = gameOf(slug); return x ? sync(x.g, x.inst, "play") : Promise.resolve(true); };
    playGuards.add(guard);
    // a game that ended: its saves go up, a moment later (it may still be writing them); and it is looked at again now and
    // then for as long as Ahoy stays open
    const played = new Set<string>();
    const off = launcher!.onEvent((e: LauncherEvent) => {
      if (e.type !== "play" || e.running) return;
      played.add(e.slug);
      const x = gameOf(e.slug);
      if (x) setTimeout(() => void sync(x.g, x.inst, "quiet"), 1500);
    });
    const again = setInterval(() => {
      for (const slug of played) { const x = gameOf(slug); if (x && !now.current.L.playing[slug]) void sync(x.g, x.inst, "quiet"); }
    }, AGAIN_MS);
    return () => { playGuards.delete(guard); off(); clearInterval(again); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync]);

  // when Ahoy opens: every game on this PC, one after the other, quietly
  const walked = useRef(false);
  useEffect(() => {
    if (!S || !on || !me || !L.loaded || !lib.loaded || walked.current) return;
    walked.current = true;
    let live = true;
    void (async () => {
      for (const inst of now.current.L.installed) {
        if (!live) return;
        const x = gameOf(inst.slug);
        if (x && !now.current.L.playing[inst.slug]) await sync(x.g, x.inst, "quiet").catch(() => {});
        await new Promise(r => setTimeout(r, 400));
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, me?.id, L.loaded, lib.loaded]);

  // another of my PCs brought a version: the list is read again, and that game here takes it, quietly
  useEvents(["save", "hello"], (event, data) => {
    void loadHeads();
    const d = data as { key?: string; device?: string | null } | null;
    if (event !== "save" || !S || !d?.key || d.device === now.current.device) return;
    const g = now.current.lib.games.find(x => saveKey(x) === d.key), inst = g ? here(g) : undefined;
    if (g && inst && !now.current.L.playing[inst.slug]) void sync(g, inst, "quiet");
  }, [loadHeads, sync]);

  const value = useMemo<SavesCtx>(() => ({
    can: !!S, on, setOn,
    statusOf: id => status.get(id) ?? null,
    headOf: g => heads.get(saveKey(g)) ?? null,
    check: g => { const inst = here(g); if (inst && !turns.current.has(saveKey(g))) void sync(g, inst, "quiet"); },
    choose: g => { const inst = here(g); if (inst) void sync(g, inst, "ask"); },
    open: g => setPanel(g),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [on, setOn, status, heads, sync]);

  const answer = (v: "here" | "there" | null) => { asking?.answer(v); setAsking(null); };
  // the white button is the newer of the two (what a player most often wants); the other stays one press away
  const thereNewer = !!asking && (asking.head.newest ?? asking.head.at * 1000) > (asking.local.newest ?? 0);
  return (
    <Ctx.Provider value={value}>
      {children}
      <Modal open={!!asking} onClose={() => answer(null)} title="Two different saves" sm
        foot={<>
          <Button kind={thereNewer ? "secondary" : "primary"} size={44} onClick={() => answer("here")} data-autofocus={thereNewer ? undefined : ""}>Keep this PC's</Button>
          <Button kind={thereNewer ? "primary" : "secondary"} size={44} onClick={() => answer("there")} data-autofocus={thereNewer ? "" : undefined}>Use {asking?.head.device ?? "the other"}'s</Button>
        </>}>
        {asking && <ul className="sv-two">
          <li><b>This PC</b><small>{whenWords(asking.local.newest)} · {filesWords(asking.local.files)}</small></li>
          <li><b>{asking.head.device ?? "Another PC"}</b><small>{whenWords(asking.head.newest ?? asking.head.at * 1000)} · {filesWords(asking.head.files)}</small></li>
        </ul>}
      </Modal>
      {panel && <SavesPanel g={panel} inst={here(panel)} rulesFor={rulesFor} onClose={() => setPanel(null)} sync={sync} loadHeads={loadHeads} />}
    </Ctx.Provider>
  );
}

const filesWords = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
/** a set of saves' size: saves are often a few hundred bytes, which is not "0 KB" */
export const sizeWords = (bytes: number) => (bytes < 1000 ? "under 1 KB" : fmtSize(bytes));
/** "Today 18:02" inside a sentence: "today 18:02" (a month keeps its capital) */
const inSentence = (when: string) => when.replace(/^(Today|Yesterday|Not played yet)/, m => m.toLowerCase());
/** when a set of saves was last written: "today 18:02", "yesterday 21:40", "Nov 3" */
export function whenWords(ms: number | null | undefined, nowMs = Date.now()): string {
  if (!ms) return "Not played yet";
  const d = new Date(ms), n = new Date(nowMs);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(n) - day(d)) / 86_400_000);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${d.getDate()}${d.getFullYear() === n.getFullYear() ? "" : `, ${d.getFullYear()}`} ${time}`;
}

/** how a game's saves stand, in a few words (the game page's fact) */
export function saveWords(s: SaveStatus | null, head: Snap | null, o: { here: boolean; on: boolean; can: boolean; device: string | null }): string | null {
  const from = (h: Snap) => (h.device && h.device !== o.device ? `From ${h.device} · ${timeAgo(h.at)}` : `Kept ${timeAgo(h.at)}`);
  if (!o.here || !o.can) return head ? from(head) : null;
  if (!o.on) return head ? `${from(head)} · off on this PC` : "Off on this PC";
  switch (s?.is) {
    case "checking": return "Checking";
    case "synced": return from(s.head);
    case "none": return "None yet";
    case "choose": return "Two different saves";
    case "too-big": return "Too large to keep in step";
    case "waiting": return head ? from(head) : "Not kept yet";
    default: return head ? from(head) : null;
  }
}

/** the fact on a game's page: how its saves stand, Choose when it must be decided, and the way into the panel */
export function SavesFact({ g }: { g: Game }) {
  const V = useSaves();
  const L = useLauncher();
  const { device } = useSession();
  const inst = g.file ? L.installedFor(g.id, g.file.id) : L.installedFor(g.id);
  const here = !!inst && inst.kind !== "rom";
  useEffect(() => { if (here && V.on) V.check(g); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [g.id, here, V.on]);
  const s = V.statusOf(g.id), head = V.headOf(g);
  const words = saveWords(s, head, { here, on: V.on, can: V.can, device });
  if (!words) return null;
  return (
    <span className="sv-fact">
      <span aria-live="polite">{words}</span>
      {s?.is === "choose" && here && V.on && <button type="button" className="link" onClick={() => V.choose(g)}>Choose</button>}
      {(head || here) && <button type="button" className="link" onClick={() => V.open(g)} aria-label={`Saves of ${g.name}`}>Versions</button>}
    </span>
  );
}
/** does the game's page have something to say about saves (so the fact's row is there at all) */
export function useHasSaves(g: Game | null): boolean {
  const V = useSaves();
  const L = useLauncher();
  if (!g) return false;
  const inst = g.file ? L.installedFor(g.id, g.file.id) : L.installedFor(g.id);
  return !!V.headOf(g) || (!!inst && inst.kind !== "rom" && V.can);
}

/* ─────────── the panel ─────────── */

function SavesPanel({ g, inst, rulesFor, onClose, sync, loadHeads }: {
  g: Game; inst: InstalledGame | undefined; rulesFor: (key: string, fresh?: boolean) => Promise<SaveRules>; onClose: () => void;
  sync: (g: Game, inst: InstalledGame, mode: Mode) => Promise<boolean>; loadHeads: () => Promise<void>;
}) {
  const { toast } = useUi();
  const V = useSaves();
  const key = saveKey(g);
  const [snaps, setSnaps] = useState<Snap[] | null>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const [local, setLocal] = useState<SaveState | null>(null);
  const [busy, setBusy] = useState<number | "pick" | null>(null);
  const [failed, setFailed] = useState(false);
  const can = !!S && !!inst && inst.kind !== "rom";
  const load = useCallback(async () => {
    try {
      const r = await get<{ items: Snap[]; paths: string[] }>(`/api/v1/saves/${key}`);
      setSnaps(r.items); setExtra(r.paths); setFailed(false);
      if (can) setLocal(await S!.state(inst!.slug, key, await rulesFor(key)));
    } catch { setFailed(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, can, inst?.slug]);
  useEffect(() => { void load(); }, [load]);

  /** back to an older version: it is put back here, and goes up as the newest (so every PC of mine follows) */
  const restore = async (s: Snap) => {
    if (!can) return;
    setBusy(s.id);
    try {
      const r = await rulesFor(key);
      await S!.pull(inst!.slug, key, r, s.id);
      await S!.push(inst!.slug, key, r);
      toast(`${g.name}: back to ${inSentence(whenWords(s.newest ?? s.at * 1000))}`, "success");
      await load(); void loadHeads(); V.check(g);
    } catch (e) { toast(errText(e, "launcher"), "danger"); }
    finally { setBusy(null); }
  };
  /** a folder by hand: where this game keeps its saves */
  const pick = async () => {
    if (!can) return;
    setBusy("pick");
    try {
      const r = await S!.pick(inst!.slug);
      if (!r) return;
      if ("error" in r) { toast(r.error, "danger"); return; }
      if (!extra.includes(r.rule)) {
        const saved = await put<{ paths: string[] }>(`/api/v1/saves/${key}/paths`, { paths: [...extra, r.rule] });
        setExtra(saved.paths);
      }
      await rulesFor(key, true);
      await sync(g, inst!, "ask");
      await load();
    } catch (e) { toast(errText(e), "danger"); }
    finally { setBusy(null); }
  };
  const forget = async (rule: string) => {
    try { const saved = await put<{ paths: string[] }>(`/api/v1/saves/${key}/paths`, { paths: extra.filter(p => p !== rule) }); setExtra(saved.paths); await rulesFor(key, true); await load(); }
    catch (e) { toast(errText(e), "danger"); }
  };
  const where = [...new Set([...(local?.where ?? []), ...extra])];
  return (
    <Modal open onClose={onClose} title="Saves" foot={<Button kind="quiet" size={44} onClick={onClose} data-autofocus>Done</Button>}>
      {can && <section className="sv-sec">
        <h3>On this PC</h3>
        {!local ? (failed ? <p>The launcher did not answer.</p> : <Spinner label="Looking" />)
          : local.tooBig ? <p>Too large to keep in step.</p>
          : <>
            <p>{local.files ? <>{filesWords(local.files)} · {sizeWords(local.bytes)} · {inSentence(whenWords(local.newest))}</> : "None found yet"}</p>
            {where.length > 0 && <ul className="sv-where">{where.map(w => (
              <li key={w}><span title={placeWords(w)}>{placeWords(w)}</span>{extra.includes(w) && <button type="button" className="link" onClick={() => void forget(w)} aria-label={`Forget ${placeWords(w)}`}>Forget</button>}</li>
            ))}</ul>}
          </>}
        <div><Button size={36} icon="folder" busy={busy === "pick"} onClick={() => void pick()}>Add a folder…</Button></div>
      </section>}
      <section className="sv-sec">
        <h3>On your server</h3>
        {!snaps ? (failed ? <p>The server did not answer.</p> : <Spinner label="Loading" />)
          : !snaps.length ? <p>None yet</p>
          : <ol className="sv-list">{snaps.map((s, i) => (
            <li key={s.id} className="io-row">
              <span className="io-pc"><b>{whenWords(s.newest ?? s.at * 1000)}</b><small>{s.device ?? "A PC"} · {filesWords(s.files)} · {sizeWords(s.bytes)}{i === 0 ? " · newest" : ""}</small></span>
              {can && V.on && (i > 0 || (local && local.digest !== s.digest)) && <Button size={36} busy={busy === s.id} aria-label={`Go back to the saves of ${whenWords(s.newest ?? s.at * 1000)}`} onClick={() => void restore(s)}>Restore</Button>}
            </li>
          ))}</ol>}
      </section>
    </Modal>
  );
}

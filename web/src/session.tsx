/**
 * Ahoy — who is signed in. Three doors before the app: the server has no accounts yet (the first person becomes the
 * admin), a sign-in / sign-up screen, and, for the admin, connecting the engine (ludarr) when that is still missing.
 * Inside the launcher the token lives in the launcher's config, so the page is signed in the moment it loads.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { fmtSize, forgetPerson, get, onUnauthorized, post, sentence, setPc, setToken, type Presence, type UserRef } from "./api";
import { setStream } from "./events";
import { launcher } from "./launcher";
import { Icon } from "./ui/icons";
import { engineWords } from "./ui/words";
import { Button, IconButton } from "./ui/button";
import { Spinner, TextField } from "./ui/controls";
import { ShelfFan, fanScale } from "./ui/fan";
import { reducedMotion } from "./ui/motion";
import { Spotlight, prefetchSpotlight } from "./ui/spotlight";
import "./screens/auth.css";

/** setup: the first account must present the setup code the server printed at boot */
interface Status { users: number; policy: "first" | "open" | "invite" | "closed"; setup?: boolean; connected: boolean; version: string }
interface Me { user: UserRef; bio: string | null; createdAt: number; presence: Presence }
interface Session {
  me: UserRef | null; bio: string | null; status: Status | null; device: string | null; isAdmin: boolean;
  /** when whoever is signed in joined (seconds); null while nobody is */
  joinedAt: number | null;
  signIn: (name: string, password: string) => Promise<void>;
  signUp: (name: string, password: string, displayName?: string, invite?: string, setup?: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}
const Ctx = createContext<Session>({ me: null, bio: null, status: null, device: null, isAdmin: false, joinedAt: null, signIn: async () => {}, signUp: async () => {}, signOut: async () => {}, refresh: async () => {} });
export const useSession = () => useContext(Ctx);

/** nobody is signed in on this page any more (signed out, or the server no longer knows the session): the stream stops, the
 *  token goes, and so does all the page kept about them (api.ts keptForPerson): the next person on this PC starts from nothing */
export function signedOut() { setStream(false); setToken(null); forgetPerson(); }

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => { setStatus(await get<Status>("/api/v1/auth/status")); }, []);
  const loadMe = useCallback(async () => {
    try { const m = await get<Me>("/api/v1/me"); setMe(m); setStream(true); return true; }
    catch { setMe(null); setStream(false); return false; }
  }, []);
  const refresh = useCallback(async () => { await loadStatus(); await loadMe(); }, [loadStatus, loadMe]);

  useEffect(() => {
    (async () => {
      try {
        if (launcher) {
          const c = await launcher.config().catch(() => null);
          setDevice(c?.hostname || "a PC");
          setPc(c?.hostname || "a PC");
          const s = await launcher.session().catch(() => null);
          if (s?.token) setToken(s.token);
        } else setDevice("browser");
        await loadStatus();
        await loadMe();
      } catch (e: any) { setError(String(e?.message ?? e)); }
      finally { setReady(true); }
    })();
  }, [loadStatus, loadMe]);
  useEffect(() => onUnauthorized(() => { setMe(null); signedOut(); void launcher?.setSession(null); }), []);

  // "I'm here", every 45 s, while signed in; the server shows friends who is around
  useEffect(() => {
    if (!me) return;
    const ping = () => void post("/api/v1/me/heartbeat", { device }).catch(() => {});
    ping();
    const t = setInterval(ping, 45_000);
    return () => clearInterval(t);
  }, [me?.user.id, device]);

  const signedIn = async (r: { token: string; user: UserRef }) => {
    if (launcher) { setToken(r.token); await launcher.setSession({ token: r.token, user: r.user.name }).catch(() => {}); }
    await loadStatus(); await loadMe();
  };
  const signIn = useCallback(async (name: string, password: string) => { await signedIn(await post<{ token: string; user: UserRef }>("/api/v1/auth/login", { name, password, device: device ? `Ahoy on ${device}` : "browser" })); }, [device]);
  const signUp = useCallback(async (name: string, password: string, displayName?: string, invite?: string, setup?: string) => { await signedIn(await post<{ token: string; user: UserRef }>("/api/v1/auth/register", { name, password, displayName, invite, setup, device: device ? `Ahoy on ${device}` : "browser" })); }, [device]);
  const signOut = useCallback(async () => {
    await post("/api/v1/auth/logout").catch(() => {});
    setToken(null); await launcher?.setSession(null).catch(() => {});
    setMe(null); signedOut(); await loadStatus();
  }, [loadStatus]);

  const value = useMemo<Session>(() => ({ me: me?.user ?? null, bio: me?.bio ?? null, status, device, isAdmin: me?.user.role === "admin", joinedAt: me?.createdAt ?? null, signIn, signUp, signOut, refresh }), [me, status, device, signIn, signUp, signOut, refresh]);
  if (!ready) return <div className="au au-wait"><Spinner size={24} /></div>;
  if (error && !status) return <Unreachable error={error} />;
  // no engine yet: the admin connects it (the last step of setting up), everyone else waits outside
  return <Ctx.Provider value={value}>{!me ? <Gate /> : status && !status.connected ? (me.user.role === "admin" ? <Connect /> : <NotReady />) : children}</Ctx.Provider>;
}

/* ─────────── outside: the front page in a browser, the sign-in form in the launcher (and on first run) ───────────
 * The doors, in the Home's language (screens/auth.css): the server's newest games turn behind them one at a time, as the
 * Home's spotlight (their key art, focus-pulled from one to the next; no title) and its fan (the generated cards, nothing
 * to click). Over the art, on the spotlight's text edge, the column: the name or the page title, fields and the actions.
 * No logo strip, no slogans and no sentences that explain: names, facts and the one thing to do. */

/** in the launcher the window has no frame: the doors' top strip is its title bar (drag) and keeps clear of the caption buttons */
const framed = !!launcher?.features?.includes("frameless");
type Mode = "in" | "up";

/** the server's five newest games (public, ids only), for the backdrop and the fan */
function useShelf() {
  const [ids, setIds] = useState<number[]>([]);
  useEffect(() => { void get<{ items: { id: number }[] }>("/api/v1/shelf").then(r => setIds(r.items.map(i => i.id))).catch(() => {}); }, []);
  return ids;
}

/** how long each game stands behind a door before the next one comes into focus */
const TURN_MS = 8000;
/** the column's width: the backdrop's side scrim is as strong as a facts line this wide needs */
const DOOR_SCRIM = 560;

/**
 * One of the doors' games at a time, the next every TURN_MS: the backdrop's focus pull and the fan's turn. It holds while a
 * field has the focus (someone is typing) or the window is hidden, and never turns for someone who asked for less motion.
 * The next game's stage is asked for ahead, so the turn finds its art ready.
 */
function useTurn(ids: number[]): number | null {
  const key = ids.join(",");
  const [k, setK] = useState(0);
  useEffect(() => {
    setK(0);
    if (ids.length < 2 || reducedMotion()) return;
    const t = setInterval(() => {
      const a = document.activeElement;
      if (document.hidden || (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA"))) return;
      setK(x => x + 1);
    }, TURN_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const n = ids.length, at = n ? k % n : 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (n > 1) prefetchSpotlight({ gameId: ids[(at + 1) % n] }, ""); }, [at, key]);
  return n ? ids[at] : null;
}

/** the fan's size on a door: the Home's rule (fanScale) with the cards' top edges 24 px under the column; when that leaves
 *  them too small (a short or narrow window) there is no fan */
function useDoorFan(root: RefObject<HTMLElement>, col: RefObject<HTMLElement>, on: boolean): number {
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    if (!on) { setScale(0); return; }
    const measure = () => {
      const r = root.current, c = col.current;
      if (!r || !c) return;
      const rb = r.getBoundingClientRect(), cb = c.getBoundingClientRect();
      const s = fanScale(rb.width, rb.height, 0, 0, { bottom: cb.bottom - rb.top, right: cb.right - rb.left });
      setScale(s >= 0.5 ? s : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (root.current) ro.observe(root.current);
    if (col.current) ro.observe(col.current);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [on]);
  return scale;
}

/** one door: the turning backdrop and fan (when the server has games to show), the strip (Back on the left, an action on the
 *  right), the column */
function Door({ children, back, right, fan = [], foot }: { children: ReactNode; back?: () => void; right?: ReactNode; fan?: number[]; foot?: ReactNode }) {
  const hasFan = fan.length > 0;
  const focus = useTurn(fan);
  const root = useRef<HTMLDivElement>(null), col = useRef<HTMLDivElement>(null);
  const scale = useDoorFan(root, col, hasFan);
  return (
    <div ref={root} className={`au${framed ? " framed" : ""}${hasFan ? " has-fan" : ""}`}>
      {focus != null && <Spotlight source={{ gameId: focus }} name="" height="100vh" bare scrimFor={DOOR_SCRIM} className="au-back" />}
      <header className="au-top">
        <div className="au-top-l">{back && <IconButton icon="chevronLeft" label="Back" onClick={back} />}</div>
        <div className="au-top-r">{right}</div>
      </header>
      <main className="au-main">
        <div className="au-col" ref={col}>{children}</div>
      </main>
      {focus != null && scale > 0 && <ShelfFan ids={fan} focus={focus} scale={scale} />}
      {foot && <footer className="au-foot">{foot}</footer>}
    </div>
  );
}

/** a labelled field (the label over the field, Settings' 15/600); the label names the input `id`, the hint is `<id>-hint` */
function Field({ id, label, extra, hint, children }: { id: string; label: string; extra?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="au-field">
      <label className="au-label" htmlFor={id}>{label}{extra && <i>{extra}</i>}</label>
      {children}
      {hint && <span className="au-hint" id={`${id}-hint`}>{hint}</span>}
    </div>
  );
}

/** a result line: the server's answer, in its words (sentence case); red only for a real error */
const Said = ({ ok, children }: { ok?: boolean; children: ReactNode }) => (
  <p className={`au-said${ok ? " good" : ""}`} role={ok ? "status" : "alert"}><Icon name={ok ? "tick" : "alert"} size={16} strokeWidth={ok ? 2.6 : 2.2} />{children}</p>
);
const said = (x: unknown) => sentence(String((x as { message?: string })?.message ?? x));

/** the server's answer stays in the tooltip; the line says which server, as the front page's Server address does */
function Unreachable({ error }: { error: string }) {
  return (
    <Door>
      <h1 className="au-title">Can't reach the server</h1>
      <p className="au-facts" title={sentence(error)}><b>{location.origin}</b></p>
      <div className="au-acts"><Button kind="primary" size={48} icon="retry" onClick={() => location.reload()}>Try again</Button></div>
    </Door>
  );
}

function Gate() {
  const { status } = useSession();
  const [form, setForm] = useState<Mode | null>(null);
  // a browser arriving at a server that is set up sees the front page: the download, the address, how to get in
  if (!launcher && status?.policy !== "first" && !form) return <Landing onSignIn={setForm} />;
  return <AuthForm start={form ?? undefined} back={!launcher && status?.policy !== "first" ? () => setForm(null) : undefined} />;
}

/** the policy as Settings → Who can join words it */
const POLICY: Record<string, string> = { open: "Anyone on the network", invite: "With an invite code", closed: "Nobody" };

function Landing({ onSignIn }: { onSignIn: (m: Mode) => void }) {
  const { status } = useSession();
  const shelf = useShelf();
  const [build, setBuild] = useState<{ file: string | null; version?: string | null; size?: number; url?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { void get<NonNullable<typeof build>>("/api/v1/launcher").then(setBuild).catch(() => {}); }, []);
  const origin = location.origin;
  const copy = async () => { try { await navigator.clipboard.writeText(origin); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* the address is on screen anyway */ } };
  const canJoin = status?.policy === "open" || status?.policy === "invite";
  const download = build?.file ? build : null;
  return (
    <Door fan={shelf} foot={`Ahoy ${status?.version ?? ""}`}>
      <h1 className="au-brand">Ahoy</h1>
      {download && <p className="au-facts">For Windows 10 and 11 · <b>{download.version ?? "latest"}</b> · {fmtSize(download.size)}</p>}
      <div className="au-acts">
        {download && <a className="btn s48 primary" href={download.url} download><Icon name="download" size={18} strokeWidth={2.4} />Download</a>}
        <Button kind={download ? "secondary" : "primary"} size={48} onClick={() => onSignIn("in")}>Sign in</Button>
      </div>
      <dl className="au-table">
        <div className="au-row"><dt>Server address</dt><dd><span className="au-addr">{origin}</span><Button kind="quiet" size={36} icon={copied ? "tick" : "copy"} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button></dd></div>
        {status && POLICY[status.policy] && <div className="au-row"><dt>New accounts</dt><dd><span>{POLICY[status.policy]}</span>{canJoin && <Button size={36} onClick={() => onSignIn("up")}>Create an account</Button>}</dd></div>}
      </dl>
    </Door>
  );
}

function AuthForm({ back, start }: { back?: () => void; start?: Mode }) {
  const { status, signIn, signUp } = useSession();
  const shelf = useShelf();
  const first = status?.policy === "first";
  const [mode, setMode] = useState<Mode>(first ? "up" : start ?? "in");
  const [name, setName] = useState(""); const [pass, setPass] = useState(""); const [display, setDisplay] = useState(""); const [invite, setInvite] = useState(""); const [setup, setSetup] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const canJoin = first || status?.policy === "open" || status?.policy === "invite";
  const needSetup = first && !!status?.setup;
  const go = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { if (mode === "up") await signUp(name, pass, display || undefined, invite || undefined, setup || undefined); else await signIn(name, pass); }
    catch (x: any) { setErr(said(x)); } finally { setBusy(false); }
  };
  const up = mode === "up";
  return (
    <Door back={back} fan={shelf} foot={`Ahoy ${status?.version ?? ""}`}>
      <form className="au-form" onSubmit={go}>
        <h1 className="au-title">{first ? "Create the first account" : up ? "Create your account" : "Sign in"}</h1>
        <div className="au-fields">
          <Field id="au-name" label="Name"><TextField id="au-name" value={name} autoFocus autoComplete="username" placeholder={up ? "Letters and digits" : undefined} onChange={e => setName(e.target.value)} /></Field>
          {up && <Field id="au-shown" label="Shown as" extra="Optional"><TextField id="au-shown" value={display} autoComplete="nickname" placeholder={name || undefined} onChange={e => setDisplay(e.target.value)} /></Field>}
          <Field id="au-pass" label="Password"><TextField id="au-pass" type="password" value={pass} autoComplete={up ? "new-password" : "current-password"} placeholder={up ? "6 or more characters" : undefined} onChange={e => setPass(e.target.value)} /></Field>
          {up && status?.policy === "invite" && <Field id="au-invite" label="Invite code"><TextField id="au-invite" className="mono" value={invite} autoComplete="off" spellCheck={false} placeholder="From whoever runs this server" onChange={e => setInvite(e.target.value.toUpperCase())} /></Field>}
          {up && needSetup && <Field id="au-setup" label="Setup code" hint="In the server's log, and in setup-code.txt next to its database"><TextField id="au-setup" aria-describedby="au-setup-hint" className="mono" value={setup} autoComplete="off" spellCheck={false} placeholder="6 characters" maxLength={6} onChange={e => setSetup(e.target.value.toUpperCase())} /></Field>}
        </div>
        {err && <Said>{err}</Said>}
        <div className="au-acts">
          <Button type="submit" kind="primary" size={48} busy={busy} disabled={!name || !pass || (up && needSetup && setup.length < 6)}>{up ? (first ? "Create the account" : "Join") : "Sign in"}</Button>
          {!first && (mode === "in"
            ? (canJoin ? <Button kind="quiet" size={48} onClick={() => { setMode("up"); setErr(null); }}>Create an account</Button> : <span className="au-note">Not taking new accounts</span>)
            : <Button kind="quiet" size={48} onClick={() => { setMode("in"); setErr(null); }}>I have an account</Button>)}
        </div>
      </form>
    </Door>
  );
}

/* ─────────── a member arrives before the admin finished setting up ─────────── */

function NotReady() {
  const { refresh, signOut } = useSession();
  return (
    <Door right={<Button kind="quiet" size={36} icon="logout" onClick={() => void signOut()}>Sign out</Button>}>
      <h1 className="au-title">Not open yet</h1>
      <p className="au-facts">Your account is ready</p>
      <div className="au-acts"><Button kind="primary" size={48} icon="retry" onClick={() => void refresh()}>Try again</Button></div>
    </Door>
  );
}

/* ─────────── the admin connects the engine (the last step of setting up) ─────────── */

/** what the engine said, in the words Settings → Server uses too (ui/words engineWords) */
const engineSaid = engineWords;

function Connect() {
  const { refresh, signOut } = useSession();
  const [url, setUrl] = useState(""); const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const failed = (x: unknown) => engineSaid(String((x as { message?: string })?.message ?? x), url);
  const probe = async () => { setBusy(true); try { const r = await post<{ ok: boolean; detail: string }>("/api/v1/admin/ludarr/probe", { url, apiKey: key }); setMsg(r.ok ? { ok: true, text: "Connected" } : { ok: false, text: engineSaid(r.detail, url) }); } catch (e) { setMsg({ ok: false, text: failed(e) }); } finally { setBusy(false); } };
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await post<{ ok: boolean; detail: string }>("/api/v1/admin/ludarr", { url, apiKey: key }); setMsg({ ok: true, text: "Connected" }); await refresh(); }
    catch (x) { setMsg({ ok: false, text: failed(x) }); } finally { setBusy(false); }
  };
  return (
    <Door right={<Button kind="quiet" size={36} icon="logout" onClick={() => void signOut()}>Sign out</Button>}>
      <form className="au-form" onSubmit={save}>
        <h1 className="au-title">Connect the engine</h1>
        <div className="au-fields">
          <Field id="au-engine" label="Engine address"><TextField id="au-engine" className="mono" value={url} autoFocus autoComplete="off" spellCheck={false} placeholder="http://ludarr:7979" onChange={e => setUrl(e.target.value)} /></Field>
          <Field id="au-key" label="Engine key"><TextField id="au-key" className="mono" type="password" value={key} autoComplete="off" placeholder="ludarr → Settings → General" onChange={e => setKey(e.target.value)} /></Field>
        </div>
        {msg && <Said ok={msg.ok}>{msg.text}</Said>}
        <div className="au-acts">
          <Button type="submit" kind="primary" size={48} busy={busy} disabled={!url || !key}>Connect</Button>
          <Button size={48} disabled={busy} onClick={() => void probe()}>Test</Button>
        </div>
      </form>
    </Door>
  );
}

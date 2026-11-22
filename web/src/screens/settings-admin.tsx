/**
 * Settings → the sections only whoever runs the server sees (board: M/lfs/settings, under the divider):
 *   Who can join  the address friends type into Ahoy, who may make an account, the invite codes while one is needed
 *                 (Revoke asks first, New invite)
 *   People        everyone in the order they joined: role, joined, presence; Make admin / Make member; Remove asks first
 *   Server        the engine's address and key with Test, Save and the result; the reverse proxy's address (whose word about
 *                 a visitor's address the sign-in limits take); how often Discover and the Metacritic lists refresh; the log
 *                 level; Open the engine (when its address is a web page's)
 * Settings the server's environment pins are shown and cannot be changed here (the server ignores them too).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, del, get, post, put, timeAgo, type Presence, type UserRef } from "../api";
import { usePeople } from "../data";
import { useEvents } from "../events";
import { useSession } from "../session";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Ask } from "../ui/ask";
import { TextField } from "../ui/controls";
import { useUi } from "../ui/kit";
import { presenceLine, seenWords } from "../ui/people";
import { AllLink } from "../ui/section";
import { engineWords, webLink } from "../ui/words";
import { ErrorRow, Line, ListRow, LoadingRow, NumberWell, Radios, Result, Row, Section, TextWell, errText, proxyList, roleWords } from "./settings-kit";

interface Setting { key: string; label: string; value: string; source: "env" | "saved" | "default"; type?: string; options?: { value: string; label: string }[]; secret?: boolean }
interface Invite { code: string; createdAt: number; usedBy: string | null; usedAt: number | null }
type AdminUser = UserRef & { createdAt: number; lastSeenAt: number | null; presence: Presence["state"] };

const MASK = "••••••••";
const PINNED = "Set by the server's environment";

/** the admin endpoints, loaded together; People follows "user" events (joins, roles, removals) */
function useAdmin() {
  const { toast } = useUi();
  const [items, setItems] = useState<Setting[] | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadSettings = useCallback(() => get<{ items: Setting[] }>("/api/v1/admin/settings").then(r => setItems(r.items)), []);
  const loadInvites = useCallback(() => get<{ items: Invite[] }>("/api/v1/admin/invites").then(r => setInvites(r.items)), []);
  const loadUsers = useCallback(() => get<{ items: AdminUser[] }>("/api/v1/admin/users").then(r => setUsers(r.items)), []);
  const load = useCallback(() => Promise.all([loadSettings(), loadInvites(), loadUsers()]).then(() => setError(null)).catch(e => setError(errText(e))), [loadSettings, loadInvites, loadUsers]);
  useEffect(() => { void load(); }, [load]);
  useEvents(["user"], () => void loadUsers().catch(() => {}));

  const field = (k: string) => items?.find(i => i.key === k);
  const val = (k: string) => field(k)?.value ?? "";
  /** one setting, shown at once and put back if the server says no; `say` confirms it with a toast (typed values) */
  const save = async (k: string, v: string, say = false) => {
    const before = items;
    setItems(list => list?.map(i => (i.key === k ? { ...i, value: v, source: i.source === "env" ? "env" : "saved" } : i)) ?? list);
    try { await put("/api/v1/admin/settings", { [k]: v }); if (say) toast("Saved", "success"); }
    catch (e) { setItems(before); toast(errText(e), "danger"); }
  };
  return { items, invites, users, error, load, loadSettings, loadInvites, loadUsers, field, val, save };
}
type Admin = ReturnType<typeof useAdmin>;

/** a panel whose data has not come: loading, or what went wrong and Try again */
const Waiting = ({ A }: { A: Admin }) => (A.error ? <ErrorRow text={A.error} onRetry={() => void A.load()} /> : <LoadingRow />);

export function AdminSections() {
  const A = useAdmin();
  return <><JoinSection A={A} /><PeopleSection A={A} /><ServerSection A={A} /></>;
}

/* ─────────── Who can join ─────────── */

function JoinSection({ A }: { A: Admin }) {
  const { toast } = useUi();
  const [asking, setAsking] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const byName = useMemo(() => new Map((A.users ?? []).map(u => [u.name, u])), [A.users]);
  const signup = A.field("SIGNUP");
  const make = async () => {
    setMaking(true);
    try { const r = await post<{ code: string }>("/api/v1/admin/invites"); toast(`New invite: ${r.code}`, "success"); await A.loadInvites(); }
    catch (e) { toast(errText(e), "danger"); }
    finally { setMaking(false); }
  };
  const revoke = async (code: string) => {
    try { await del(`/api/v1/admin/invites/${encodeURIComponent(code)}`); await A.loadInvites(); }
    catch (e) { toast(errText(e), "danger"); }
  };
  return (
    <Section id="who-can-join" title="Who can join">
      {!A.items || !A.invites ? <Waiting A={A} /> : <>
        <Row label="Tell friends"><span className="st-v">{location.origin}</span></Row>
        <Row label="New accounts" labelId="join-new">
          <Radios labelledBy="join-new" value={A.val("SIGNUP")} options={signup?.options ?? []} disabled={signup?.source === "env"}
            title={signup?.source === "env" ? PINNED : undefined} onChange={v => void A.save("SIGNUP", v)} />
        </Row>
        {/* codes count only while new accounts need one: the server ignores them when anyone may join and turns everyone
            away when nobody may, so the list and New invite are offered only then */}
        {A.val("SIGNUP") === "invite" && <ListRow label="Invite codes">
          {A.invites.map(i => {
            const u = i.usedBy ? byName.get(i.usedBy) : null;
            return (
              <Line key={i.code}>
                <span className="st-code">{i.code}</span>
                <span className="st-v st-grey st-grow">
                  {!i.usedBy ? `Made ${timeAgo(i.createdAt)}` : <>Used by {u ? <Link className="st-strong" to={`/u/${u.name}`}>{u.displayName}</Link> : <b className="st-strong">{i.usedBy}</b>}</>}
                </span>
                {!i.usedBy && <Ask open={asking === i.code} onOpen={() => setAsking(i.code)} onClose={() => setAsking(a => (a === i.code ? null : a))}
                  className="st-flush" label="Revoke" aria={`Revoke invite ${i.code}`} confirmAria={`Revoke invite ${i.code}`} onConfirm={() => revoke(i.code)} />}
              </Line>
            );
          })}
          <Line end><Button size={36} icon="plus" busy={making} onClick={() => void make()}>New invite</Button></Line>
        </ListRow>}
      </>}
    </Section>
  );
}

/* ─────────── People ─────────── */

function PeopleSection({ A }: { A: Admin }) {
  const { me } = useSession();
  const { toast } = useUi();
  const { items: people } = usePeople();
  const presence = useMemo(() => new Map((people ?? []).map(p => [p.id, p.presence])), [people]);
  const [asking, setAsking] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const users = A.users ? [...A.users].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id) : null;
  const setRole = async (u: AdminUser) => {
    setBusy(u.id);
    try { await put(`/api/v1/admin/users/${u.id}/role`, { role: u.role === "admin" ? "member" : "admin" }); await A.loadUsers(); }
    catch (e) { toast(errText(e), "danger"); }
    finally { setBusy(null); }
  };
  const remove = async (u: AdminUser) => {
    try { await del(`/api/v1/admin/users/${u.id}`); await A.loadUsers(); }
    catch (e) { toast(errText(e), "danger"); }
  };
  return (
    <Section id="people" title="People">
      {!users ? <Waiting A={A} /> : users.map(u => {
        const p = presence.get(u.id);
        const state = p?.state ?? u.presence;
        const words = p ? presenceLine(p) : state === "online" ? "Online" : seenWords(u.lastSeenAt);
        const open = asking === u.id;
        return (
          <div className="st-row st-person" key={u.id}>
            <Avatar u={u} size={44} />
            <Link className="st-who" to={`/u/${u.name}`} title={`@${u.name}`}>
              <span className="st-name">{u.displayName}</span>
              <span className="st-sub">{roleWords(u.role)}</span>
            </Link>
            <span className="st-joined">Joined {timeAgo(u.createdAt)}</span>
            <span className="st-presence"><i className={`st-dot${state !== "offline" ? " st-on" : ""}`} aria-hidden /><span className="st-v st-grey">{words}</span></span>
            {u.id !== me?.id && (
              <div className="st-acts">
                {!open && <Button size={36} busy={busy === u.id} aria-label={u.role === "admin" ? `Make ${u.displayName} a member` : `Make ${u.displayName} an admin`}
                  onClick={() => void setRole(u)}>{u.role === "admin" ? "Make member" : "Make admin"}</Button>}
                <Ask open={open} onOpen={() => setAsking(u.id)} onClose={() => setAsking(a => (a === u.id ? null : a))}
                  className="st-flush" label="Remove" aria={`Remove ${u.displayName}`} confirmAria={`Remove ${u.displayName} from this server`} onConfirm={() => remove(u)} />
              </div>
            )}
          </div>
        );
      })}
    </Section>
  );
}

/* ─────────── Server ─────────── */

type Probe = { ok: boolean; detail: string };
const said = (r: Probe, url: string) => (r.ok ? { ok: true, text: "Connected" } : { ok: false, text: engineWords(r.detail, url) });
/** a Test or Save that failed: the engine's answer (the server's 400) in plain words, else what went wrong with the server */
const failure = (e: unknown, url: string) => ({ ok: false, text: e instanceof ApiError && e.status === 400 ? engineWords(e.message, url) : errText(e) });

function ServerSection({ A }: { A: Admin }) {
  const { refresh } = useSession();
  const { toast } = useUi();
  const [url, setUrl] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const loaded = !!A.items;
  const urlF = A.field("LUDARR_URL"), keyF = A.field("LUDARR_API_KEY");
  const savedUrl = A.val("LUDARR_URL");
  const urlV = url ?? savedUrl, keyV = key ?? A.val("LUDARR_API_KEY");

  // the resting line: how the saved address and key answer now
  useEffect(() => {
    if (!loaded) return;
    let live = true;
    post<Probe>("/api/v1/admin/ludarr/probe", {}).then(r => { if (live) setResult(said(r, savedUrl)); }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const test = async () => {
    const at = urlV.trim();
    setTesting(true);
    try { setResult(said(await post<Probe>("/api/v1/admin/ludarr/probe", { url: at, apiKey: keyV }), at)); }
    catch (e) { setResult(failure(e, at)); }
    finally { setTesting(false); }
  };
  const save = async () => {
    const at = urlV.trim();
    setSaving(true);
    try {
      await post("/api/v1/admin/ludarr", { url: at, apiKey: keyV });
      setResult({ ok: true, text: "Connected" }); setUrl(null); setKey(null);
      await A.loadSettings(); await refresh();
    } catch (e) { setResult(failure(e, at)); }
    finally { setSaving(false); }
  };
  // with both pinned by the server's environment nothing here can be saved; Test still says how they answer
  const pinned = urlF?.source === "env" && keyF?.source === "env";
  // a link only when the saved address is a web page's (it can be set to anything; nothing else is ever drawn as a link)
  const engineAt = webLink(savedUrl);
  const engineLink = engineAt
    ? <AllLink to={engineAt} icon="out">Open the engine</AllLink>
    : null;
  const disc = A.field("DISCOVER_REFRESH_MIN"), mc = A.field("METACRITIC_REFRESH_HOURS"), log = A.field("LOG_LEVEL");
  // a server that has the setting (older ones do not: no row then, rather than a field that does nothing)
  const proxy = A.field("TRUSTED_PROXY");

  return (
    <Section id="server" title="Server" link={engineLink}>
      {!loaded ? <Waiting A={A} /> : <>
        <Row label="Engine address" htmlFor="srv-url">
          <TextField well id="srv-url" className="st-w360" type="url" spellCheck={false} autoComplete="off" value={urlV}
            disabled={urlF?.source === "env"} title={urlF?.source === "env" ? PINNED : undefined}
            onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void save(); }} />
        </Row>
        <Row label="Engine key" htmlFor="srv-key">
          <TextField well id="srv-key" className="st-w360" type="password" autoComplete="off" value={keyV}
            disabled={keyF?.source === "env"} title={keyF?.source === "env" ? PINNED : undefined}
            onFocus={e => { if (e.target.value === MASK) setKey(""); }} onBlur={() => { if (key === "") setKey(null); }}
            onChange={e => setKey(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void save(); }} />
        </Row>
        <Row label={null}>
          <Button size={44} busy={testing} aria-label="Test the engine address and key" onClick={() => void test()}>Test</Button>
          {!pinned && <Button kind="primary" size={44} busy={saving} aria-label="Save the engine address and key" onClick={() => void save()}>Save</Button>}
          {result && <Result ok={result.ok} text={result.text} />}
        </Row>
        {proxy && <Row label="Reverse proxy address" htmlFor="srv-proxy">
          <TextWell id="srv-proxy" value={A.val("TRUSTED_PROXY")} placeholder="Any private address" fit={proxyList}
            disabled={proxy.source === "env"} title={proxy.source === "env" ? PINNED : undefined}
            onRefuse={() => toast("Addresses only, like 172.17.0.1 or 172.17.0.0/16", "danger")} onCommit={v => void A.save("TRUSTED_PROXY", v, true)} />
        </Row>}
        <Row label="Discover refresh" htmlFor="srv-disc">
          <NumberWell id="srv-disc" value={A.val("DISCOVER_REFRESH_MIN")} min={1} max={10_080} disabled={disc?.source === "env"}
            title={disc?.source === "env" ? PINNED : undefined} onCommit={v => void A.save("DISCOVER_REFRESH_MIN", v, true)} />
          <span className="st-unit">minutes</span>
        </Row>
        <Row label="Metacritic lists refresh" htmlFor="srv-mc">
          <NumberWell id="srv-mc" value={A.val("METACRITIC_REFRESH_HOURS")} min={1} max={720} disabled={mc?.source === "env"}
            title={mc?.source === "env" ? PINNED : undefined} onCommit={v => void A.save("METACRITIC_REFRESH_HOURS", v, true)} />
          <span className="st-unit">hours</span>
        </Row>
        <Row label="Log level" labelId="srv-log">
          <Radios labelledBy="srv-log" value={A.val("LOG_LEVEL")} options={log?.options ?? []} disabled={log?.source === "env"}
            title={log?.source === "env" ? PINNED : undefined} onChange={v => void A.save("LOG_LEVEL", v)} />
        </Row>
      </>}
    </Section>
  );
}

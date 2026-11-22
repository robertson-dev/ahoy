/**
 * Settings → You: the handle and role, Shown as, About and Colour (saved together by Save, or Enter in a field),
 * Password, and every device you are signed in on (Sign out there asks first). Board: M/lfs/settings, the You panel.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, del, get, put, type UserRef } from "../api";
import { useSession } from "../session";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Spinner, TextField } from "../ui/controls";
import { useUi } from "../ui/kit";
import { Ask } from "../ui/ask";
import { AllLink } from "../ui/section";
import { deviceName } from "../ui/words";
import { seenWords } from "../ui/people";
import { HueSlider, Line, ListRow, Row, Section, errText, roleWords } from "./settings-kit";

interface SessionRow { id: number; device: string | null; createdAt: number; lastSeenAt: number }


export function YouSection() {
  const { me, bio, refresh } = useSession();
  const { toast } = useUi();
  const [display, setDisplay] = useState(me?.displayName ?? "");
  const [about, setAbout] = useState(bio ?? "");
  const [hue, setHue] = useState(me?.hue ?? 0);
  const [saving, setSaving] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [pwBusy, setPwBusy] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setDisplay(me?.displayName ?? ""); setHue(me?.hue ?? 0); setAbout(bio ?? ""); }, [me?.id]);
  if (!me) return null;

  const preview: UserRef = { ...me, displayName: display.trim() || me.name, hue };
  const save = async () => {
    setSaving(true);
    try { await put("/api/v1/me", { displayName: display, bio: about, hue }); toast("Saved", "success"); await refresh(); }
    catch (e) { toast(errText(e), "danger"); }
    finally { setSaving(false); }
  };
  const changePw = async () => {
    if (!pw.current) { currentRef.current?.focus(); return; }
    if (pw.next.length < 6) { nextRef.current?.focus(); return; }
    setPwBusy(true);
    // a wrong current password is a 403 (server/src/auth.ts), never the 401 that means the session is gone
    try { await put("/api/v1/me/password", pw); setPw({ current: "", next: "" }); toast("Password changed", "success"); }
    catch (e) {
      toast(errText(e), "danger");
      if (e instanceof ApiError && e.status === 403) { currentRef.current?.focus(); currentRef.current?.select(); }
    }
    finally { setPwBusy(false); }
  };

  return (
    <Section id="you" title="You" link={<AllLink to={`/u/${me.name}`}>See your profile</AllLink>}>
      <Row label="Name">
        <span className="st-v st-strong">@{me.name}</span>
        <span className="st-v st-grey">{roleWords(me.role)}</span>
      </Row>
      <Row label="Shown as" htmlFor="you-shown">
        <TextField well id="you-shown" className="st-w320" form="you-profile" maxLength={40} autoComplete="nickname" value={display} onChange={e => setDisplay(e.target.value)} />
      </Row>
      <Row label="About" htmlFor="you-about">
        <TextField well id="you-about" className="st-grow" form="you-profile" limit={200} placeholder="A line about you" value={about} onChange={e => setAbout(e.target.value)} />
      </Row>
      <Row label="Colour" htmlFor="you-colour" form={{ id: "you-profile", onSubmit: () => void save() }}
        actions={<Button type="submit" size={44} busy={saving} aria-label="Save name, about and colour">Save</Button>}>
        <Avatar u={preview} size={44} />
        <HueSlider id="you-colour" hue={hue} onChange={setHue} />
      </Row>
      <Row label="Password" htmlFor="you-pw" form={{ onSubmit: () => void changePw() }}
        actions={<Button type="submit" size={44} busy={pwBusy} aria-label="Change password">Change</Button>}>
        <input type="text" name="username" autoComplete="username" value={me.name} readOnly hidden />
        <TextField well id="you-pw" ref={currentRef} className="st-w240" type="password" placeholder="Current" aria-label="Current password" autoComplete="current-password"
          value={pw.current} onChange={e => setPw(p => ({ ...p, current: e.target.value }))} />
        <TextField well ref={nextRef} className="st-w240" type="password" placeholder="New, 6+ characters" aria-label="New password" autoComplete="new-password"
          value={pw.next} onChange={e => setPw(p => ({ ...p, next: e.target.value }))} />
      </Row>
      <SignedInOn />
    </Section>
  );
}

/** each device with a session: this one, or when it was last seen and Sign out there */
function SignedInOn() {
  const { toast } = useUi();
  const [data, setData] = useState<{ items: SessionRow[]; current: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const load = useCallback(() => get<{ items: SessionRow[]; current: number | null }>("/api/v1/me/sessions")
    .then(d => { setData(d); setError(null); }).catch(e => setError(errText(e))), []);
  useEffect(() => { void load(); }, [load]);

  const items = data ? [...data.items].sort((a, b) => Number(b.id === data.current) - Number(a.id === data.current) || b.lastSeenAt - a.lastSeenAt) : [];
  return (
    <ListRow label="Signed in on">
      {!data ? (
        <Line>{error ? <><span className="st-v st-bad st-grow">{error}</span><Button size={36} icon="retry" onClick={() => void load()}>Try again</Button></> : <Spinner label="Loading" />}</Line>
      ) : items.map(s => {
        const here = s.id === data.current;
        const name = deviceName(s.device);
        return (
          <Line key={s.id}>
            <span className="st-device" title={s.device ?? undefined}>{name}</span>
            <span className="st-v st-grey st-grow">{here ? "This one" : seenWords(s.lastSeenAt)}</span>
            {!here && <Ask open={asking === s.id} onOpen={() => setAsking(s.id)} onClose={() => setAsking(a => (a === s.id ? null : a))}
              className="st-flush" label="Sign out there" confirm="Sign out" aria={`Sign out on ${name}`} confirmAria={`Sign out on ${name}`}
              onConfirm={async () => { try { await del(`/api/v1/me/sessions/${s.id}`); await load(); } catch (e) { toast(errText(e), "danger"); } }} />}
          </Line>
        );
      })}
    </ListRow>
  );
}

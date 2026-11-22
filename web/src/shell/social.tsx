/**
 * The bell: today's social panel, restyled. Who wants to be friends (Accept / Decline), who is online now (playing first,
 * with the game and how long), what happened lately. The bell carries the amber dot while someone else is online or asks
 * to be friends.
 */
import { Link } from "react-router-dom";
import type { ActivityItem, Person, Presence, UserRef } from "../api";
import { useActivity, useFriends, usePeople, type Friends } from "../data";
import { useSession } from "../session";
import { Avatar } from "../ui/avatar";
import { Icon } from "../ui/icons";
import { FeedLine, FriendButton, onlineNow, presenceWords } from "../ui/people";
import { GroupLabel } from "../ui/section";
import { leavingProps, usePresence } from "../ui/motion";
import { usePopover } from "./popover";

export function BellButton({ dot, open, onClick, title }: { dot: boolean; open?: boolean; onClick?: () => void; title?: string }) {
  return (
    <button type="button" className={`tb-bell${open ? " on" : ""}`} onClick={onClick} aria-label="Friends and what happened" aria-expanded={open} aria-haspopup="dialog" title={title}>
      <Icon name="bellBoard" size={22} />
      {dot && <span className="tb-bell-dot" aria-hidden />}
    </button>
  );
}

export function Bell() {
  const { me } = useSession();
  const { items: people } = usePeople();
  const { data: friends, reload } = useFriends();
  const pop = usePopover("bell");
  const panel = usePresence(pop.isOpen);
  if (!me) return null;
  const online = onlineNow(people, me.id).length;
  const pending = friends?.incoming.length ?? 0;
  const title = pending ? `${pending} want${pending === 1 ? "s" : ""} to be friends` : online ? `${online} online` : "Nobody else is online";
  return (
    <div className="tb-pop-wrap" ref={pop.ref}>
      <BellButton dot={online > 0 || pending > 0} open={pop.isOpen} onClick={pop.toggle} title={title} />
      {panel.mounted && <SocialPanel people={people} friends={friends} onNavigate={pop.close} onChange={() => void reload()} leaving={panel.leaving} />}
    </div>
  );
}

/** the panel under the bell, live */
export function SocialPanel({ people, friends, onNavigate, onChange, leaving }: { people: Person[] | null; friends: Friends | null; onNavigate: () => void; onChange?: () => void; leaving?: boolean }) {
  const { items, error } = useActivity("all", 10);
  const { me } = useSession();
  return <SocialPanelView pending={friends?.incoming ?? []} online={onlineNow(people, me?.id)} lately={items ? items.filter(a => a.user.id !== me?.id).slice(0, 6) : null} failed={!!error} onNavigate={onNavigate} onChange={onChange} leaving={leaving} />;
}

/** the panel's drawing: requests, who is online now, lately (the gallery draws it with sample data) */
export function SocialPanelView({ pending, online, lately, failed, onNavigate, onChange, leaving }: {
  pending: (UserRef & { presence: Presence })[];
  online: Person[];
  /** null while reading */
  lately: ActivityItem[] | null;
  failed?: boolean;
  onNavigate?: () => void;
  onChange?: () => void;
  /** on its way out (it blurs away; ui/motion.ts) */
  leaving?: boolean;
}) {
  return (
    <div className="tb-panel sp" {...leavingProps(!!leaving)} role="dialog" aria-label="Friends and what happened" onClick={e => { if ((e.target as HTMLElement).closest("a")) onNavigate?.(); }}>
      {pending.length > 0 && <section className="sp-sect">
        <GroupLabel count={pending.length}>Want to be friends</GroupLabel>
        {pending.map(u => (
          <div key={u.id} className="sp-row">
            <Link to={`/u/${u.name}`} className="sp-who"><Avatar u={u} size={40} /><span className="sp-tx"><b>{u.displayName}</b><small>{presenceWords(u.presence).text}</small></span></Link>
            <FriendButton id={u.id} state="pending_in" name={u.displayName} onChange={onChange} />
          </div>
        ))}
      </section>}
      <section className="sp-sect">
        <GroupLabel count={online.length || null}>Online now</GroupLabel>
        {online.length ? online.map(p => {
          const w = presenceWords(p.presence);
          return (
            <Link key={p.id} to={p.presence.gameId != null ? `/game/${p.presence.gameId}` : `/u/${p.name}`} className="sp-row sp-who">
              <Avatar u={p} size={40} dot />
              <span className="sp-tx"><b>{p.displayName}</b><small>{w.state === "playing" ? <><b>{w.game}</b>{w.how ? ` · ${w.how}` : ""}</> : w.text}</small></span>
            </Link>
          );
        }) : <p className="sp-none">Nobody else is online right now.</p>}
      </section>
      <section className="sp-sect">
        <GroupLabel>Lately</GroupLabel>
        {!lately ? <p className="sp-none">{failed ? "The server did not answer. Trying again." : "Reading…"}</p> : lately.length ? <div className="sp-feed">{lately.map(a => <FeedLine key={a.id} a={a} compact />)}</div> : <p className="sp-none">Nothing has happened yet.</p>}
      </section>
      <Link to="/people" className="sp-foot">Friends<Icon name="chev" size={16} strokeWidth={2.2} /></Link>
    </div>
  );
}

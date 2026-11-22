/** The avatar button and its menu: Your profile, Friends (with the friend-request count), Big screen (on and off), What's new
 *  (with the count of what was not seen yet), Settings, Sign out. */
import { Link } from "react-router-dom";
import type { UserRef } from "../api";
import { useFriends } from "../data";
import { useSession } from "../session";
import { Avatar } from "../ui/avatar";
import { Icon } from "../ui/icons";
import { leavingProps, usePresence } from "../ui/motion";
import { usePopover } from "./popover";
import { bigMode } from "../big/mode";
import { useBig } from "../big";
import { useNews } from "../whatsnew-state";

/** the user's avatar with the small chevron badge (M/mine/livefan: 44 px, radius 14) */
export function AccountButton({ u, open, onClick }: { u: UserRef; open?: boolean; onClick?: () => void }) {
  return (
    <button type="button" className={`tb-me${open ? " on" : ""}`} onClick={onClick} aria-label="Your account" aria-expanded={open} aria-haspopup="menu" title={u.displayName}>
      <Avatar u={u} size={44} />
      <span className="tb-me-chev" aria-hidden><Icon name="chevDown" size={10} strokeWidth={3} /></span>
    </button>
  );
}

export function AccountMenuItems({ u, pending, onSignOut }: { u: UserRef; pending: number; onSignOut: () => void }) {
  const big = useBig();
  const news = useNews();
  return <>
    <div className="mn-head"><Avatar u={u} size={40} /><span><b>{u.displayName}</b><small>@{u.name}</small></span></div>
    <Link role="menuitem" to={`/u/${u.name}`}><Icon name="user" size={18} />Your profile</Link>
    <Link role="menuitem" to="/people"><Icon name="users" size={18} />Friends{pending > 0 && <i aria-label={`${pending} asking`}>{pending}</i>}</Link>
    <button role="menuitem" type="button" onClick={() => bigMode.toggle()}><Icon name="tv" size={18} />{big ? "Leave big screen" : "Big screen"}<kbd>F11</kbd></button>
    <button role="menuitem" type="button" onClick={() => news.open()}><Icon name="sparkles" size={18} />What's new{news.count > 0 && <i aria-label={`${news.count} new`}>{news.count}</i>}</button>
    <Link role="menuitem" to="/settings"><Icon name="settings" size={18} />Settings</Link>
    <button role="menuitem" type="button" onClick={onSignOut}><Icon name="logout" size={18} />Sign out</button>
  </>;
}

export function AccountMenu() {
  const { me, signOut } = useSession();
  const { data } = useFriends();
  const pop = usePopover("account");
  const panel = usePresence(pop.isOpen);
  if (!me) return null;
  return (
    <div className="tb-pop-wrap" ref={pop.ref}>
      <AccountButton u={me} open={pop.isOpen} onClick={pop.toggle} />
      {panel.mounted && (
        <div className="tb-panel mn" {...leavingProps(panel.leaving)} role="menu" aria-label="Your account" onClick={e => { if ((e.target as HTMLElement).closest("a,button")) pop.close(); }}>
          <AccountMenuItems u={me} pending={data?.incoming.length ?? 0} onSignOut={() => void signOut()} />
        </div>
      )}
    </div>
  );
}

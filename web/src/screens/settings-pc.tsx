/**
 * Settings → This PC (the server it is connected to, its name, where games go, desktop shortcuts, what a controller's home
 * button does, whether Ahoy stays running when closed and starts with Windows, the launcher and its updates) and On this PC (every game installed here, largest first: Open folder, Uninstall asks first in place).
 * In a plain browser there is no PC to set: This PC is the launcher's download, and On this PC is not there.
 * Board: M/lfs/settings, the This PC and On this PC panels.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtSize, urlBase } from "../api";
import { launcher, updateCheckable, updateLine, type InstalledGame, type LauncherConfig, type PadButton } from "../launcher";
import { useLauncher } from "../launcher-state";
import { useSaves } from "../saves-state";
import { useNews } from "../whatsnew-state";
import { useSession } from "../session";
import { art } from "../ui/art";
import { Ask } from "../ui/ask";
import { Button, ButtonLink, btnClass } from "../ui/button";
import { Toggle } from "../ui/controls";
import { useUi } from "../ui/kit";
import { useLauncherBuild } from "../ui/launcher-download";
import { PosterArt } from "../ui/poster";
import { PLATFORM_WORD, platformName } from "../ui/words";
import { ErrorRow, LoadingRow, Radios, Row, Section, errText } from "./settings-kit";

/* ─────────── This PC ─────────── */

/** this launcher hears a controller's home button (0.12 on) */
const PAD_BUTTON = !!launcher?.features?.includes("pad-button");
/** this launcher can stay running with its window closed, and start with Windows (0.13 on) */
const BACKGROUND = !!launcher?.features?.includes("background");

export function ThisPcSection() {
  return launcher ? <LauncherPc /> : <BrowserPc />;
}

function LauncherPc() {
  const { toast } = useUi();
  const { signOut } = useSession();
  const V = useSaves();
  const [cfg, setCfg] = useState<LauncherConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const load = useCallback(() => launcher!.config().then(c => { setCfg(c); setError(null); }).catch(() => setError("The launcher did not answer")), []);
  useEffect(() => { void load(); }, [load]);

  /** a change the launcher keeps; shown at once, put back if it says no */
  const save = async (patch: Partial<Pick<LauncherConfig, "libraryDir" | "desktopShortcuts" | "padButton" | "background" | "startWithWindows">>) => {
    const before = cfg;
    setCfg(c => (c ? { ...c, ...patch } : c));
    try {
      const r = await launcher!.setConfig(patch);
      if (!r.ok) throw new Error(r.error ?? "That did not save");
      void load();
    } catch (e) { setCfg(before); toast(errText(e, "launcher"), "danger"); }
  };
  const pickDir = async () => {
    const dir = await launcher!.pickDir().catch(() => null);
    if (dir && dir !== cfg?.libraryDir) await save({ libraryDir: dir });
  };
  /** the launcher forgets this server: sign out here, then it shows its setup page again (installed games stay) */
  const changeServer = async () => { await signOut().catch(() => {}); await launcher!.setConfig({ serverUrl: "" }); };

  return (
    <Section id="this-pc" title="This PC">
      {!cfg ? (error ? <ErrorRow text={error} onRetry={() => void load()} /> : <LoadingRow />) : <>
        <Row label="Server" actions={<Ask open={asking} onOpen={() => setAsking(true)} onClose={() => setAsking(false)}
          className="st-flush" label="Change…" aria="Change server" confirm="Change server" onConfirm={changeServer} />}>
          <span className="st-v" title={cfg.serverUrl}>{cfg.serverUrl}</span>
        </Row>
        <Row label="This PC is called"><span className="st-v">{cfg.hostname}</span></Row>
        <Row label="Install games into" actions={<Button size={36} aria-label="Change where games are installed" onClick={() => void pickDir()}>Change…</Button>}>
          <span className="st-v" title={cfg.libraryDir}>{cfg.libraryDir}</span>
        </Row>
        <Row label="Desktop shortcuts" labelId="pc-shortcuts">
          <Toggle on={cfg.desktopShortcuts} labelledBy="pc-shortcuts" onChange={v => void save({ desktopShortcuts: v })} />
        </Row>
        {/* launchers from 0.12: the round button in the middle of a controller (Xbox, PS), while Ahoy runs */}
        {PAD_BUTTON && <Row label="Controller's home button" labelId="pc-pad">
          <Radios<PadButton> value={cfg.padButton ?? "off"} labelledBy="pc-pad" onChange={v => void save({ padButton: v })}
            options={[{ value: "off", label: "Does nothing" }, { value: "show", label: "Shows Ahoy" }, { value: "big", label: "Opens Big screen" }]} />
        </Row>}
        {/* launchers from 0.13: this PC's saves go to the server after playing and come from it before */}
        {V.can && <Row label="Keep saves in step" labelId="pc-saves">
          <Toggle on={V.on} labelledBy="pc-saves" onChange={v => void V.setOn(v).catch(e => toast(errText(e, "launcher"), "danger"))} />
        </Row>}
        {/* launchers from 0.13: closed, Ahoy stays by the clock (what was asked for elsewhere still installs here) */}
        {BACKGROUND && <Row label="Keep running when closed" labelId="pc-bg">
          <Toggle on={cfg.background ?? true} labelledBy="pc-bg" onChange={v => void save({ background: v })} />
        </Row>}
        {BACKGROUND && <Row label="Start with Windows" labelId="pc-boot">
          <Toggle on={cfg.startWithWindows ?? false} labelledBy="pc-boot" onChange={v => void save({ startWithWindows: v })} />
        </Row>}
        <LauncherRow cfg={cfg} />
      </>}
    </Section>
  );
}

/** the launcher and where its own update stands (launcher.ts updateLine); "Check now" only where a check can change something */
function LauncherRow({ cfg }: { cfg: LauncherConfig }) {
  const { update: u, checkUpdate, installUpdate } = useLauncher();
  const { toast } = useUi();
  const news = useNews();
  const [checking, setChecking] = useState(false);
  const line = updateLine(u);
  const check = async () => { setChecking(true); try { await checkUpdate(); } catch (e) { toast(errText(e, "launcher"), "danger"); } finally { setChecking(false); } };
  const restart = () => installUpdate().catch(e => toast(errText(e, "launcher"), "danger"));
  const action = !u ? null
    : u.status === "ready" ? <><Button size={36} onClick={() => news.open(u.version)}>What's new</Button><Button kind="primary" size={44} onClick={() => void restart()}>Restart to update</Button></>
    : !updateCheckable(u) ? null
    : <Button size={36} busy={checking || u.status === "checking"} aria-label="Check for a launcher update" onClick={() => void check()}>Check now</Button>;
  return (
    <Row label="Launcher" top={!!line} actions={action}>
      <span className="st-two">
        <span className="st-v">Ahoy {cfg.version} · {platformName(cfg.platform)}</span>
        {line && <span className={`st-sub${line.bad ? " st-bad" : ""}`} title={line.detail}>{line.text}</span>}
      </span>
    </Row>
  );
}

/** a plain browser: the launcher is where installing and playing happen, so This PC offers it */
function BrowserPc() {
  const { build, error, reload } = useLauncherBuild();
  return (
    <Section id="this-pc" title="This PC">
      {!build ? (error ? <ErrorRow text={errText(error)} onRetry={() => void reload()} /> : <LoadingRow />)
        : build.file ? (
          <Row label="Launcher" top actions={<a className={btnClass("primary", 44)} href={`${urlBase}${build.url}`} download>Download</a>}>
            <span className="st-two">
              <span className="st-v">Ahoy{build.version ? ` ${build.version}` : ""} · Windows</span>
              {build.size ? <span className="st-sub">{fmtSize(build.size)}</span> : null}
            </span>
          </Row>
        ) : (
          <Row label="Launcher"><span className="st-v st-grey">Not on this server yet</span></Row>
        )}
    </Section>
  );
}

/* ─────────── On this PC ─────────── */

export function OnThisPcSection() {
  const L = useLauncher();
  const { toast } = useUi();
  const [asking, setAsking] = useState<string | null>(null);
  const games = [...L.installed].sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));
  const uninstall = async (g: InstalledGame) => { try { await L.uninstall(g.slug); } catch (e) { toast(`${g.name} was not uninstalled · ${errText(e, "launcher")}`, "danger"); } };
  return (
    <Section id="on-this-pc" title="On this PC">
      {!L.loaded ? <LoadingRow />
        : !games.length ? (
          <Row label={null} className="st-empty" actions={<ButtonLink to="/library" size={36}>Your library</ButtonLink>}>
            <span className="st-v st-grey">No games on this PC yet</span>
          </Row>
        ) : games.map(g => <GameRow key={g.slug} g={g} asking={asking === g.slug} onAsk={() => setAsking(g.slug)}
          onClose={() => setAsking(a => (a === g.slug ? null : a))} onUninstall={() => uninstall(g)} onOpenFolder={() => void L.openFolder(g.slug).catch(e => toast(errText(e, "launcher"), "danger"))} />)}
    </Section>
  );
}

function GameRow({ g, asking, onAsk, onClose, onUninstall, onOpenFolder }: {
  g: InstalledGame; asking: boolean; onAsk: () => void; onClose: () => void; onUninstall: () => Promise<void>; onOpenFolder: () => void;
}) {
  const where = g.kind === "rom" && g.platform ? ` · ${PLATFORM_WORD[g.platform.toLowerCase()] ?? g.platform}` : "";
  const who = <>
    <PosterArt src={g.gameId != null ? art.poster(g.gameId, 96) : null} title={g.name} w={40} h={60} r={8} />
    <span className="st-two">
      <span className="st-name">{g.name}</span>
      <span className="st-sub">{fmtSize(g.sizeBytes)}{g.version ? ` · v${g.version}` : ""}{where}</span>
    </span>
  </>;
  return (
    <div className="st-row st-game">
      {g.gameId != null ? <Link className="st-gwho" to={`/game/${g.gameId}`} aria-label={g.name}>{who}</Link> : <span className="st-gwho">{who}</span>}
      <span className={`st-gpath${asking ? " st-bright" : ""}`} title={g.path}>{g.path}</span>
      <div className="st-acts">
        {!asking && <Button size={36} aria-label={`Open the folder of ${g.name}`} onClick={onOpenFolder}>Open folder</Button>}
        <Ask open={asking} onOpen={onAsk} onClose={onClose} className="st-flush" label="Uninstall" aria={`Uninstall ${g.name}`}
          confirmAria={`Uninstall ${g.name} from this PC`} onConfirm={onUninstall} />
      </div>
    </div>
  );
}

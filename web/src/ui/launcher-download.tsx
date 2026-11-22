/**
 * The desktop launcher the server publishes (<config>/launcher/, GET /api/v1/launcher): what Install offers in a plain
 * browser (LauncherDownload, a dialog), Settings → This PC in a browser, and the front page. The build is asked for once
 * per page load, when something first needs it (a failed answer is asked again the next time).
 */
import { useCallback, useEffect, useState } from "react";
import { fmtSize, get, urlBase } from "../api";
import { BtnIcon, Button, btnClass } from "./button";
import { Spinner } from "./controls";
import { Modal } from "./kit";

export interface LauncherBuild { file: string | null; version?: string | null; size?: number; url?: string }

let asked: Promise<LauncherBuild> | null = null;
/** the published build (one request per page load) */
export function launcherBuild(): Promise<LauncherBuild> {
  asked ??= get<LauncherBuild>("/api/v1/launcher").catch(e => { asked = null; throw e; });
  return asked;
}

/** the build, while it is asked for (null), or what went wrong; `reload` asks again */
export function useLauncherBuild() {
  const [build, setBuild] = useState<LauncherBuild | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    return launcherBuild().then(b => { setBuild(b); }).catch(e => setError(String(e?.message ?? e)));
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { build, error, reload: load };
}

/** "For Windows 10 and 11 · 0.8.0 · 98 MB" (the front page's words) */
export const buildFacts = (b: LauncherBuild) => <>For Windows 10 and 11 · <b>{b.version ?? "latest"}</b>{b.size ? ` · ${fmtSize(b.size)}` : ""}</>;

/** Install in a plain browser: the launcher to download, or that this server has none yet. Mounted only while it is open. */
export function LauncherDownload({ onClose }: { onClose: () => void }) {
  const { build, error, reload } = useLauncherBuild();
  const file = build?.file ? build : null;
  return (
    <Modal open onClose={onClose} title="Get the launcher" sm
      foot={<>
        <Button kind="quiet" size={44} onClick={onClose}>Close</Button>
        {file && <a className={btnClass("primary", 44)} href={`${urlBase}${file.url}`} download><BtnIcon name="download" size={16} />Download</a>}
        {error && <Button size={44} icon="retry" onClick={() => void reload()}>Try again</Button>}
      </>}>
      {error ? <p>The server did not answer.</p>
        : !build ? <Spinner label="Loading" />
        : file ? <p className="ld-facts">{buildFacts(file)}</p>
        : <p>Not on this server yet</p>}
    </Modal>
  );
}

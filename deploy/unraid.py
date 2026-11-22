#!/usr/bin/env python3
"""
Ahoy — build and (re)create the container on Unraid in one go.

    UNRAID_HOST=<server> UNRAID_USER=root UNRAID_PASS=... python deploy/unraid.py

Steps: pack the build context (server, web, Dockerfile; no secrets, no node_modules) → upload over SFTP →
`docker build` on the box → install the Unraid template (my-ahoy.xml) → recreate the `ahoy` container
(replacing the old pre-ludarr ship of the same name; its files stay) → wait for /api/health → publish the
newest launcher installer from launcher/release/ into <appdata>/launcher/.

Ahoy's own database is <appdata>/ahoy-app.db; the old ship's ahoy.db beside it is left alone. The ludarr
connection (address + key) is entered by the first admin in the web UI and lives in that database, or comes
The ludarr connection is not pre-seeded: the first admin enters it in the UI (env LUDARR_URL / LUDARR_API_KEY
still pin it when you add them to the container yourself).

This server's own values (UNRAID_HOST) go in
deploy/.env.site: KEY=VALUE lines, ignored by git. The environment wins over the file; the password is never read from it.

Needs python3 + paramiko on this machine.
"""
import io, os, re, subprocess, sys, tarfile, time
import paramiko

def site_values():
    """deploy/.env.site: this server's own values as KEY=VALUE lines, ignored by git. The environment wins over the
    file, and the password is never read from it."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env.site")
    if not os.path.isfile(path): return
    for line in open(path, encoding="utf-8"):
        key, sep, value = line.strip().partition("=")
        key = key.strip()
        if sep and key and not key.startswith("#") and key != "UNRAID_PASS": os.environ.setdefault(key, value.strip())


site_values()
HOST = os.environ.get("UNRAID_HOST") or sys.exit("set UNRAID_HOST to the server's address (in the environment or in deploy/.env.site)")
USER = os.environ.get("UNRAID_USER", "root")
PASS = os.environ.get("UNRAID_PASS")                                             # none: this machine's SSH keys (and its agent) are tried
PORT = int(os.environ.get("AHOY_PORT", "8790"))
BUILD = "/mnt/user/appdata/ahoy-build"
APPDATA = "/mnt/user/appdata/ahoy"
TEMPLATE = "/boot/config/plugins/dockerMan/templates-user/my-ahoy.xml"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXCLUDE = ("node_modules", ".git", "public", "dist", "release", "tests")
sys.stdout.reconfigure(encoding="utf-8")

def revision() -> str:
    """the commit this deploy is built from (DEPLOY_REVISION, else the checkout's HEAD): stamped on the image, so the
    server can say which commit it runs"""
    rev = os.environ.get("DEPLOY_REVISION", "")
    if not rev:
        try: rev = subprocess.run(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=20).stdout.strip()
        except Exception: rev = ""
    return rev if re.fullmatch(r"[0-9A-Za-z._-]{1,40}", rev) else ""


REVISION = revision()
LABEL = os.environ.get("DEPLOY_LABEL", "")                                       # a word for this deploy: the image is also tagged <label>-<commit>
if LABEL and not re.fullmatch(r"[0-9A-Za-z._-]{1,40}", LABEL): sys.exit("DEPLOY_LABEL: letters, digits, dot, dash and underscore only")


def pack() -> bytes:
    buf = io.BytesIO()
    def keep(ti: tarfile.TarInfo):
        parts = ti.name.split("/")
        if any(p in EXCLUDE for p in parts[1:]): return None
        if ti.name.endswith((".db", ".db-wal", ".db-shm", ".log", ".env")): return None
        return ti
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for item in ("server", "web", "Dockerfile"):
            tar.add(os.path.join(ROOT, item), arcname=item, filter=keep)
    return buf.getvalue()


def main():
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, USER, PASS, timeout=25, look_for_keys=not PASS, allow_agent=not PASS)
    def sh(cmd: str, timeout=900) -> str:
        _, out, err = c.exec_command(cmd, timeout=timeout)
        o = out.read().decode(errors="replace") + err.read().decode(errors="replace")
        if out.channel.recv_exit_status() != 0: sys.exit(f"failed: {cmd}\n{o[-2000:]}")
        return o

    data = pack(); print(f"build context: {len(data) / 1024:.0f} KB")
    sh(f"mkdir -p {BUILD} {APPDATA} {APPDATA}/launcher {APPDATA}/art")
    with c.open_sftp() as s:
        with s.file(f"{BUILD}/src.tar", "wb") as f: f.write(data)
        with s.file(TEMPLATE, "wb") as f: f.write(open(os.path.join(ROOT, "unraid", "my-ahoy.xml"), "rb").read())
    sh(f"cd {BUILD} && rm -rf server web Dockerfile frontend backend docker-compose.yml .dockerignore && tar -xf src.tar && rm src.tar")
    print("building image …")
    # the image the container runs now stays as :prev, to go back to
    sh(f"img=$(docker inspect -f '{{{{.Image}}}}' ahoy 2>/dev/null) && docker tag $img ahoy:prev || true")
    stamp = f"--label org.opencontainers.image.revision={REVISION} " if REVISION else ""
    sh(f"cd {BUILD} && docker build {stamp}-t ahoy:latest . > build.log 2>&1", timeout=2400)
    if REVISION and LABEL: sh(f"docker tag ahoy:latest ahoy:{LABEL}-{REVISION}")
    print("image built; recreating container …")
    sh("docker rm -f ahoy >/dev/null 2>&1 || true")
    for _ in range(30):                                   # the daemon frees the name a moment after rm returns
        if sh("docker inspect ahoy >/dev/null 2>&1 && echo busy || echo free").strip() == "free": break
        time.sleep(1)
    # the engine (ludarr address + key) is entered by the admin on first sign-in and kept in the database; nothing is pre-seeded
    sh(f"docker run -d --init --name ahoy --restart unless-stopped -p {PORT}:8790 -e PORT=8790 -e AHOY_CONFIG=/config -v {APPDATA}:/config ahoy:latest")
    for _ in range(45):
        time.sleep(2)
        if sh(f"curl -s -m 5 http://127.0.0.1:{PORT}/api/health || true").strip().startswith("{"): break
    print(sh("docker logs ahoy 2>&1 | head -12"))
    print("health:", sh(f"curl -s -m 10 http://127.0.0.1:{PORT}/api/health").strip())
    # the desktop launcher: the newest installer (Ahoy-Setup-<version>.exe) goes to <config>/launcher/ together with
    # latest.yml and the .blockmap electron-builder wrote next to it; the web UI offers the exe, installed launchers
    # follow latest.yml and update themselves
    rel = os.path.join(ROOT, "launcher", "release")
    exes = sorted((f for f in os.listdir(rel) if f.startswith("Ahoy-Setup-") and f.endswith(".exe")), key=lambda f: os.path.getmtime(os.path.join(rel, f))) if os.path.isdir(rel) else []
    if exes:
        exe = exes[-1]; size = os.path.getsize(os.path.join(rel, exe))
        extras = [f for f in (exe + ".blockmap", "latest.yml") if os.path.isfile(os.path.join(rel, f))]
        if sh(f"stat -c %s {APPDATA}/launcher/{exe} 2>/dev/null || echo 0").strip() != str(size) or "latest.yml" not in extras or sh(f"grep -qs 'path: {exe}' {APPDATA}/launcher/latest.yml && echo yes || echo no").strip() != "yes":
            with c.open_sftp() as s:
                s.put(os.path.join(rel, exe), f"{APPDATA}/launcher/{exe}")
                for f in extras: s.put(os.path.join(rel, f), f"{APPDATA}/launcher/{f}")
            print(f"launcher published: {exe} ({size / 1e6:.0f} MB) + {', '.join(extras) or 'no updater files'}")
            sh(f"find {APPDATA}/launcher -maxdepth 1 \\( -name '*.exe' -o -name '*.blockmap' \\) ! -name '{exe}*' -delete")
        else: print(f"launcher already published: {exe}")
    print(f"→ http://{HOST}:{PORT}/   (template installed: Unraid → Docker → ahoy)")


if __name__ == "__main__":
    main()

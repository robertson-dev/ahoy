"""Build Ahoy's searchable platform catalog from the LaunchBox Games Database export."""
import os
import re
import sqlite3
import sys
import tempfile
import unicodedata
import subprocess
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


# These are the versions Ludarr can request. Each name is an exact LaunchBox platform.
PLATFORMS = {
    "Windows": ("pc", "PC"), "Nintendo Switch": ("switch", "Nintendo Switch"),
    "Nintendo Wii U": ("wiiu", "Wii U"), "Nintendo Wii": ("wii", "Wii"),
    "Nintendo GameCube": ("gc", "GameCube"), "Nintendo 64": ("n64", "Nintendo 64"),
    "Nintendo Entertainment System": ("nes", "NES"), "Super Nintendo Entertainment System": ("snes", "SNES"),
    "Nintendo Game Boy": ("gb", "Game Boy"), "Nintendo Game Boy Color": ("gbc", "Game Boy Color"),
    "Nintendo Game Boy Advance": ("gba", "Game Boy Advance"), "Nintendo DS": ("nds", "Nintendo DS"),
    "Nintendo 3DS": ("3ds", "Nintendo 3DS"), "Sony Playstation": ("ps1", "PlayStation"),
    **{f"Sony Playstation {n}": (f"ps{n}", f"PlayStation {n}") for n in range(2, 6)},
    "Sony PSP": ("psp", "PSP"), "Sony Playstation Vita": ("vita", "PS Vita"),
    "Microsoft Xbox": ("xbox", "Xbox"), "Microsoft Xbox 360": ("x360", "Xbox 360"),
    "Microsoft Xbox One": ("xone", "Xbox One"), "Microsoft Xbox Series X/S": ("xsx", "Xbox Series X|S"),
    "Sega Dreamcast": ("dc", "Dreamcast"), "Sega Genesis": ("genesis", "Genesis"),
    "Sega Saturn": ("saturn", "Saturn"), "Arcade": ("arcade", "Arcade"),
}


def folded(s):
    return " ".join(re.findall(r"[^\W_]+", "".join(c for c in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(c)).replace("’", "").replace("'", "")))


def build(archive, target):
    with tempfile.TemporaryDirectory(dir=target.parent) as scratch:
        dest = Path(scratch) / "games.db"
        db = sqlite3.connect(dest)
        db.executescript("""
          CREATE TABLE platforms(id TEXT PRIMARY KEY, label TEXT NOT NULL);
          CREATE TABLE games(id INTEGER PRIMARY KEY, name TEXT, platform TEXT, year INTEGER,
              summary TEXT, votes INTEGER, steam INTEGER, cover TEXT, cover_rank INTEGER DEFAULT 0);
          CREATE TABLE names(game INTEGER, text TEXT, PRIMARY KEY(game, text)) WITHOUT ROWID;
        """)
        db.executemany("INSERT INTO platforms VALUES(?,?)", PLATFORMS.values())
        with zipfile.ZipFile(archive) as z, z.open("Metadata.xml") as xml:
            events = ET.iterparse(xml, events=("start", "end"))
            root = next(events)[1]
            depth = 0
            for event, e in events:
                if event == "start":
                    depth += 1
                    continue
                depth -= 1
                if depth != 0:
                    continue
                get = e.findtext
                key = get("DatabaseID")
                if e.tag == "Game" and get("Platform") in PLATFORMS and key and get("Name"):
                    year = (get("ReleaseDate") or get("ReleaseYear") or "")[:4]
                    name = get("Name").strip()
                    db.execute("INSERT INTO games(id,name,platform,year,summary,votes,steam) VALUES(?,?,?,?,?,?,?)",
                               (key, name, PLATFORMS[get("Platform")][0], int(year) if year.isdigit() else None,
                                (get("Overview") or "")[:4000], int(get("CommunityRatingCount") or 0), get("SteamAppId")))
                    db.execute("INSERT OR IGNORE INTO names VALUES(?,?)", (key, folded(name)))
                elif e.tag == "GameAlternateName" and key and get("AlternateName"):
                    db.execute("INSERT OR IGNORE INTO names SELECT id,? FROM games WHERE id=?", (folded(get("AlternateName")), key))
                elif e.tag == "GameImage" and get("Type") == "Box - Front":
                    filename = get("FileName") or ""
                    if re.fullmatch(r"[a-zA-Z0-9-]+\.(?:png|jpg|jpeg|webp)", filename, re.I):
                        rank = {"North America": 4, "World": 3, "Europe": 2}.get(get("Region"), 1)
                        db.execute("UPDATE games SET cover=?, cover_rank=? WHERE id=? AND cover_rank<?", (filename, rank, key, rank))
                root.clear()
        if not db.execute("SELECT count(*) FROM games").fetchone()[0]:
            raise ValueError("LaunchBox supplied an empty game list")
        db.executescript("CREATE INDEX popular ON games(platform,votes DESC,name,id); CREATE INDEX all_popular ON games(votes DESC,name,id);")
        db.commit()
        db.close()
        os.replace(dest, target)


if __name__ == "__main__":
    target = Path(sys.argv[1]).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) == 3:
        build(sys.argv[2], target)
    else:
        with tempfile.TemporaryDirectory(dir=target.parent) as tmp:
            archive = Path(tmp) / "Metadata.zip"
            subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location",
                            "--connect-timeout", "15", "--max-time", "300", "--retry", "2",
                            "--output", str(archive), "https://gamesdb.launchbox-app.com/Metadata.zip"], check=True)
            build(archive, target)

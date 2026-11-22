/**
 * Ahoy — the database (bun:sqlite, WAL) in <config>/ahoy-app.db. Everything that is Ahoy's own:
 *
 *   users / sessions / invites   accounts (the first user is the admin)
 *   friends                      who follows whom (pending until accepted)
 *   activity                     the feed: installed, played, requested, tracked, joined
 *   presence                     what each user is doing right now (the launcher reports it)
 *   installs                     which games each user has on which PC
 *   pcs                          each person's PCs (every PC their launcher has run on)
 *   orders                       a game to install on one of a person's PCs, placed from anywhere
 *   saves / save_paths           each person's saves of a game, a version each (the files are in <config>/saves), and the
 *                                folders they added as where a game keeps them
 *   wants                        who wants a game: asked for it, tracks it, watches it (ludarr only knows the game, not the person)
 *   asked                        who brought each game to the server (the one member who may take it away again)
 *   request_starts               who started each search for a copy (the one member who may cancel it)
 *   catalog                      Steam appdetails cache for discovery
 *   kv                           settings and caches (feeds, Metacritic lists, the ludarr library snapshot)
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const dbPath = process.env.DB_PATH || join(process.env.AHOY_CONFIG || ".", "ahoy-app.db");
if (dbPath !== ":memory:") { try { mkdirSync(join(dbPath, ".."), { recursive: true }); } catch { /* exists */ } }
export const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
setInterval(() => { try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* closing */ } }, 15_000).unref?.();

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- the handle: letters, digits, _ and -, 2..24
  display_name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',        -- admin | member
  hue INTEGER NOT NULL DEFAULT 0,             -- the avatar colour, 0..359
  bio TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device TEXT,                                -- "Ahoy launcher 0.6.0 on win32" / "browser"
  created_at INTEGER DEFAULT (unixepoch()),
  last_seen_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS friends (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,     -- who asked
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- who was asked
  state TEXT NOT NULL DEFAULT 'pending',                                -- pending | accepted
  created_at INTEGER DEFAULT (unixepoch()),
  accepted_at INTEGER,
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                         -- joined | requested | tracked | installed | played | friends
  game_id INTEGER,                            -- ludarr's game id, when about a game
  app_id INTEGER,                             -- Steam app id, when known
  name TEXT,                                  -- the game's (or the other user's) name at the time
  data_json TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, id);
CREATE INDEX IF NOT EXISTS idx_activity_game ON activity(game_id);

CREATE TABLE IF NOT EXISTS presence (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'online',       -- online | playing
  game_id INTEGER, app_id INTEGER, game_name TEXT, slug TEXT,
  since INTEGER,                              -- when the game started
  device TEXT,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS installs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device TEXT NOT NULL,                       -- the PC's name
  slug TEXT NOT NULL,
  game_id INTEGER, package_id INTEGER, app_id INTEGER,
  name TEXT NOT NULL,
  size INTEGER,
  installed_at INTEGER,
  last_played_at INTEGER,
  play_seconds INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, device, slug)
);
CREATE INDEX IF NOT EXISTS idx_installs_game ON installs(game_id);

-- a person's PCs: every PC their launcher has run on (installs only knows a PC that has a game)
CREATE TABLE IF NOT EXISTS pcs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device TEXT NOT NULL,                       -- the PC's name, as its launcher says it
  version TEXT,                               -- that launcher's version
  auto INTEGER NOT NULL DEFAULT 1,            -- it installs what this person asks for, when it arrives
  free_bytes INTEGER,                         -- room left where its games go, as it last said
  seen_at INTEGER DEFAULT (unixepoch()),
  created_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, device)
);
-- a game to install on one of a person's PCs: placed from anywhere, carried out by that PC's launcher when it is on and
-- the game has a copy
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device TEXT NOT NULL,
  game_id INTEGER NOT NULL,
  name TEXT,                                  -- the game's name when it was placed
  origin TEXT NOT NULL DEFAULT 'asked',       -- asked (Install on a PC) | wanted (the game was asked for, and that PC installs those)
  state TEXT NOT NULL DEFAULT 'waiting',      -- waiting | installing | done | failed
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,                                 -- why it failed, in the launcher's words
  from_device TEXT,                           -- the PC it was placed from, when it was one
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, device);
CREATE INDEX IF NOT EXISTS idx_orders_game ON orders(game_id);

-- a person's saves of a game, as one of their PCs had them: a version each, the files themselves in <config>/saves
CREATE TABLE IF NOT EXISTS saves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_key TEXT NOT NULL,                     -- a<Steam app id>, else g<game id>: the same game on every PC
  game_id INTEGER, name TEXT,                 -- the game when it was saved
  device TEXT,                                -- the PC it came from
  digest TEXT NOT NULL,                       -- of the files' places, sizes and contents: the same saves, the same digest
  files INTEGER NOT NULL, bytes INTEGER NOT NULL,   -- how many files, and their size together
  size INTEGER NOT NULL,                      -- the stored file's size
  newest INTEGER,                             -- when the newest of the files was last written (ms)
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_saves_user ON saves(user_id, game_key, id);
-- folders a person added by hand as where a game keeps its saves
CREATE TABLE IF NOT EXISTS save_paths (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_key TEXT NOT NULL,
  paths_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, game_key)
);

CREATE TABLE IF NOT EXISTS wants (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                         -- get | track | watch
  created_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, game_id)
);

-- a want is anyone's for the asking (Track, Watch, look again), so it says nothing about whose game it is: these two do.
-- Written once, when the game is new to the server / when the search starts, and never by a later want.
CREATE TABLE IF NOT EXISTS asked (
  game_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS request_starts (
  request_id INTEGER PRIMARY KEY,
  game_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS catalog (
  steam_appid INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  coming_soon INTEGER DEFAULT 0,
  release_text TEXT,
  release_iso TEXT,
  release_sort TEXT,
  genres_json TEXT DEFAULT '[]',
  short_description TEXT,
  metacritic INTEGER,
  header_image TEXT,
  drm TEXT, crack_status TEXT, crack_date TEXT, crack_group TEXT,
  crackwatch_at INTEGER,                      -- when ludarr was last asked for the verdict
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);
`);

export const kv = {
  get(key: string): string | null { return (db.query("SELECT value FROM kv WHERE key=?").get(key) as { value: string } | null)?.value ?? null; },
  set(key: string, value: string) { db.query("INSERT INTO kv(key,value,updated_at) VALUES(?,?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()").run(key, value); },
  del(key: string) { db.query("DELETE FROM kv WHERE key=?").run(key); },
  json<T>(key: string, fallback: T): T { try { const v = kv.get(key); return v == null ? fallback : JSON.parse(v) as T; } catch { return fallback; } },
};

export interface CatalogRow {
  steam_appid: number; name: string; type: string | null; coming_soon: number; release_text: string | null; release_iso: string | null;
  release_sort: string | null; genres_json: string; short_description: string | null; metacritic: number | null; header_image: string | null;
  drm: string | null; crack_status: string | null; crack_date: string | null; crack_group: string | null; updated_at: number;
}

export const stmts = {
  catalogGet: db.query("SELECT * FROM catalog WHERE steam_appid=?"),
  catalogUpsert: db.query(`INSERT INTO catalog (steam_appid, name, type, coming_soon, release_text, release_iso, release_sort, genres_json, short_description, metacritic, header_image, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,unixepoch())
    ON CONFLICT(steam_appid) DO UPDATE SET name=excluded.name, type=excluded.type, coming_soon=excluded.coming_soon, release_text=excluded.release_text, release_iso=excluded.release_iso,
      release_sort=excluded.release_sort, genres_json=excluded.genres_json, short_description=excluded.short_description, metacritic=excluded.metacritic, header_image=excluded.header_image, updated_at=unixepoch()`),
  catalogTouch: db.query("INSERT INTO catalog (steam_appid, name, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(steam_appid) DO UPDATE SET updated_at=unixepoch()"),
  catalogCrack: db.query("UPDATE catalog SET drm=?, crack_status=?, crack_date=?, crack_group=? WHERE steam_appid=?"),
};

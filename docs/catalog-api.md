# Ahoy catalog API

The catalog lists every game the ship can offer and **every way to play it on a Windows PC**. That goes beyond Steam releases to:

- static recompilations
- decompilation-based source ports
- emulated console games
- scene releases, including leaks

The storefront, library and request pipeline are meant to read from it.

## Model

| Entity | What it is | Example |
|---|---|---|
| **Title** | The game itself, independent of platform | *The Legend of Zelda: Majora's Mask* |
| **Route** | One way to play it on this PC | Zelda64Recomp · 2 Ship 2 Harkinian · Steam release · shadPS4 |
| **Runtime** | What a non-native route runs on, with its latest Windows build | Zelda64Recomp v1.2.2, shadPS4 v.0.20.0 |
| **Provider** | A source that contributes titles and routes | Steam feeds, the curated ports registry, RPCS3's compat list |

A route has two independent axes:

- **kind**: how it runs.
  - `native`: a PC release
  - `recomp`: a static recompilation
  - `port`: a decomp-based source port or engine reimplementation
  - `emulated`
- **provenance**: where the build comes from.
  - `retail`
  - `leak`: released before the official date
  - `prototype`
  - `beta`
  - `demo`

Compatibility uses one ladder for every emulator, best first: `perfect` · `playable` · `ingame` · `intro` · `menus` · `boots` · `nothing` · `unknown`. Native routes leave it `null`. Curated ports use it to rate how mature the port is.

Every route says what it needs:

- **content**: the game data.
  - `kind`: `rom`, `disc`, `pkg`, `files` or `none`.
  - The platform the data comes from.
  - What counts as the right copy: `accept.hashes` as the project documents them (XXH3-64, SHA-1, CRC32C, MD5, SHA-256 …), plus `serials`, `regions` and `formats`.
  - `place`: where it goes.
  - `from`: where to get it. One of a tracker query, a known release, a GitHub asset, a URL, or the user.
- **needs**: anything else, such as console firmware, keys, a BIOS, build tools or a CPU feature.
- **launch**: `{ exe, args, cwd }`, with `{content}` and `{runtime}` placeholders. Falls back to the runtime's launch settings.

Titles are matched across providers in this order:

1. A shared id (`steam`, `serial`, `titleid`, `registry` …).
2. The normalised name, plus the year when both sides know it.

When providers disagree, metadata from the higher-ranked provider wins.

## Endpoints

All responses are JSON. Base URL: `http://<ship>:8790`.

### `GET /api/catalog/titles`

| Param | Meaning |
|---|---|
| `q` | Search by name or id (`Majora`, `CUSA03455`, `BLUS30001`). Ranks exact, then prefix, then word, then substring matches. |
| `kind` | `native` · `recomp` · `port` · `emulated` |
| `platform` | Content platform slug (`ps4`, `n64`, `switch` … see `/vocab`) |
| `provenance` | `retail` · `leak` · `prototype` · `beta` · `demo` |
| `runtime` | Runtime id (`shadps4`, `zelda64recomp` …) |
| `status` | At least this good (`playable` matches perfect or playable) |
| `library=1` | Only titles on the ship (onboarded) |
| `sort` | `name` · `year` · `updated` · `status`. Default: relevance when `q` is set, otherwise name. |
| `limit`, `offset` | Paging. `limit` ≤ 500, default 60. |
| `all=1` | Include titles that currently have no route |

Returns `{ total, offset, limit, titles: TitleSummary[] }`.

```jsonc
// TitleSummary
{ "id": 61, "slug": "legend-of-zelda-majoras-mask", "name": "The Legend of Zelda: Majora's Mask", "year": 2000,
  "releaseIso": null, "platforms": ["n64"], "cover": null, "hero": null, "logo": null, "gameId": null,
  "kinds": ["recomp", "port"], "provenances": ["retail"],
  "best": { "kind": "recomp", "platform": "n64", "label": "Zelda 64: Recompiled", "status": "perfect", "provenance": "retail" },
  "routeCount": 5 }
```

### `GET /api/catalog/titles/:idOrSlug`

Returns `{ title }`: the summary plus `summary`, `developer`, `publisher`, `genres`, `screenshots`, `metaSource`, `ids: [{scheme, value}]` and `routes`.

Routes come best first:

1. Retail before leaks.
2. Native, then recomp, then port, then emulated.
3. Better compatibility first.
4. Freshest report first.

```jsonc
// Route
{ "id": 10420, "kind": "recomp", "platform": "n64", "provenance": "retail", "label": "Zelda 64: Recompiled",
  "status": "perfect", "statusNote": null, "statusAt": null,
  "runtime": { "id": "zelda64recomp", "name": "Zelda 64: Recompiled", "kind": "recomp",
               "latest": { "tag": "v1.2.2", "date": "2025-08-27T…", "prerelease": false,
                           "asset": { "name": "Zelda64Recompiled-v1.2.2-Windows.zip", "url": "https://github.com/…", "size": 31457280 }, "page": "…" } },
  "content": { "kind": "rom", "platform": "n64",
               "accept": { "hashes": [{ "algo": "xxh3-64", "value": "EF18B4A9E2386169", "label": "checked", "of": "big-endian ROM" },
                                      { "algo": "sha1", "value": "d6133ace5afaa0882cf214cf88daba39e266c078" }],
                           "regions": ["US"], "formats": ["z64", "v64", "n64"], "note": "Majora's Mask NTSC-U 1.0 ROM" },
               "from": [{ "type": "tracker", "query": "The Legend of Zelda: Majora's Mask N64" }, { "type": "user", "hint": "pick the ROM once …" }] },
  "needs": [], "features": ["high frame rate", "widescreen", "mods", "texture packs"],
  "launch": { "exe": "Zelda64Recompiled.exe", "args": [], "cwd": "." },
  "link": "https://github.com/Zelda64Recomp/Zelda64Recomp", "source": "ports", "updatedAt": 1792310000 }
```

### Other endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/catalog/vocab` | Platforms (slug → name), kinds, provenances, statuses |
| `GET /api/catalog/facets` | Title counts per kind, platform, provenance, runtime and status |
| `GET /api/catalog/runtimes` | Every runtime with its latest Windows release |
| `GET /api/catalog/runtimes/:id` | One runtime plus the titles it plays |
| `POST /api/catalog/runtimes/refresh` | Re-checks every runtime's release now |
| `GET /api/catalog/sources` | Providers: what they contribute, last run, counts, last error |
| `POST /api/catalog/sources/:id/refresh` | Runs one provider now |

Changes are announced on the event stream (`/api/events`) as `catalog` events.

## Providers

| id | Contributes | Source | Refresh |
|---|---|---|---|
| `steam` | PC games in the storefront feeds and the ship's library (native) | Steam store | Hourly |
| `ports` | About 60 curated recomp and decomp ports, with exact copy requirements | In-repo registry; releases from GitHub | Daily |
| `compat-shadps4` | PS4 on shadPS4 | shadps4-compatibility release JSON | Daily |
| `compat-sharpemu` | PS5 on SharpEmu (tested titles only) | sharpemu.app/games-index.json | Daily |
| `compat-rpcs3` | PS3 on RPCS3 | rpcs3.net compatibility API | Daily |
| `compat-xenia` | Xbox 360 on Xenia Canary | Xenia Manager database | Daily |
| `compat-pcsx2` | PS2 on PCSX2 (rated entries only) | PCSX2 GameIndex.yaml | Daily |
| `compat-ryubing` | Switch on Ryujinx (many reports are old) | Ryubing compatibility CSV | Daily |
| `emulators` | The emulator list (runtimes only) | In-repo | Daily |
| `ports-seed` | More recomps and ports, unreviewed (released, 25+ stars, Windows target) | awesome-decomp-games (CC0) | Daily |
| `scene` | Recent PS5, Switch, PS4 and PC scene releases; leaks flagged by date | predb.club | Every 6 h |

Runtime releases come from one of three places:

- GitHub: `owner/name`
- Forgejo: `forgejo:host/owner/name`
- Dolphin's update feed: `dolphin:beta`

Unauthenticated GitHub allows 60 calls an hour. Set `GITHUB_TOKEN` (no scopes needed) so every runtime gets checked promptly.

### Adding a provider

1. Implement `Provider` from `backend/src/catalog/types.ts`.
   - `collect()` returns the provider's **full snapshot** as `Contribution[]`, where each item is `{ title: TitleInput, routes: RouteInput[] }`.
   - Optionally implement `runtimes()`.
2. Give each route a stable `key`. The catalog removes routes a provider stops reporting.
3. Register the provider in `catalog/worker.ts`.

## Not covered yet

- **Art for most console titles.** Only Steam titles have art, plus GameTDB covers for US PS3 serials. An IGDB or SteamGridDB provider would fill the gap.
- **Some emulators' compatibility data:** Dolphin, Cemu, Vita3K and PPSSPP. Their data is wiki/HTML-only or needs GitHub API paging.
- **Prototype archives** (Hidden Palace).
- **The request pipeline for non-native routes**: fetch the runtime and content, verify against `accept.hashes`, assemble, launch. The API already carries everything that pipeline needs.

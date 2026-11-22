#!/usr/bin/env bun
/** Ahoy — boot: listen, follow ludarr, schedule the workers. */
import "./former";
import { app } from "./server";
import { VERSION, cfg, configDir, port } from "./config";
import { logger, setLogLevel, type Level } from "./log";
import { registerTask, startScheduler } from "./tasks";
import * as ludarr from "./ludarr";
import { discoverTick } from "./discover";
import { metacriticTick } from "./metacritic";
import { crackTick } from "./crack";
import { dropIdleSessions, ensureSetupCode, setupCodeFile, userCount } from "./auth";
import { dropOrphanOrders } from "./pcs";
import { saveRulesTick } from "./saverules";
import { sweepSaves } from "./saves";

const log = logger("App");
setLogLevel((cfg("LOG_LEVEL") as Level) || "info");

Bun.serve({ port: port(), fetch: app.fetch, idleTimeout: 120 });
log.info(`Ahoy ${VERSION} listening on http://localhost:${port()} · config ${configDir()}`);
if (userCount()) log.info(`${userCount()} account(s)`);
else log.warn(`no accounts yet — the first person to sign up becomes the admin and must enter the setup code ${ensureSetupCode()} (also in ${setupCodeFile()})`);
if (ludarr.connected()) { log.info(`ludarr at ${cfg("LUDARR_URL")}`); void ludarr.refreshLibrary(); ludarr.followEvents(); }
else log.warn("the engine (ludarr) is not connected yet: the admin connects it on first sign-in or under Settings → The engine");

if (process.env.AHOY_WORKERS !== "0") {
  registerTask({ name: "library", label: "Re-read the library from ludarr", intervalSec: 60, run: () => ludarr.refreshLibrary() });
  registerTask({ name: "discover", label: "Refresh storefront feeds", intervalSec: 600, run: discoverTick });
  registerTask({ name: "metacritic", label: "Best-of lists from Metacritic (matched to Steam)", intervalSec: 900, run: metacriticTick });
  registerTask({ name: "crack", label: "Crack status for storefront games (from ludarr)", intervalSec: 600, run: () => crackTick() });
  // only against a library that was read: an engine that does not answer has not lost its games
  registerTask({ name: "orders", label: "Drop installs waiting for games that left the server", intervalSec: 600, run: async () => { const s = ludarr.libraryStatus(); if (!s.error && s.at && s.games) dropOrphanOrders(new Set(ludarr.library().map(g => g.id))); } });
  registerTask({ name: "saverules", label: "Where games keep their saves (from PCGamingWiki, through Ludusavi's list)", intervalSec: 3 * 86_400, run: async () => { await saveRulesTick(); await sweepSaves(); } });
  registerTask({ name: "sessions", label: "Sign out devices not used for 90 days", intervalSec: 86_400, run: async () => { dropIdleSessions(); } });
  startScheduler();
}

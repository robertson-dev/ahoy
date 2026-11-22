/** bun test preload — an in-memory database, no workers, no real ludarr. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DB_PATH = ":memory:";
process.env.AHOY_CONFIG = mkdtempSync(join(tmpdir(), "ahoy-test-"));
process.env.AHOY_WORKERS = "0";
delete process.env.LUDARR_URL; delete process.env.LUDARR_API_KEY;

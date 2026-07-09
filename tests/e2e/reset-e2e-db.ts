/**
 * E2E database reset — deletes the SQLite database file (and its WAL/SHM
 * siblings) so each Playwright run starts with a clean slate. The server's
 * initSchema() reseeds the three canonical sample projects and 8 staff
 * members on next start, giving the UI tests a fully deterministic initial
 * state (see tests/e2e/ui/app.spec.ts, which asserts exact seeded totals
 * like "$4,030,000").
 *
 * WHY THIS IS A STANDALONE SCRIPT AND NOT PLAYWRIGHT'S globalSetup:
 *
 * This used to be wired as playwright.config.ts's `globalSetup` hook
 * (tests/e2e/global-setup.ts). That was a lifecycle bug, not just a style
 * choice: Playwright (checked against the installed 1.58.2 in
 * node_modules/playwright/lib/runner/tasks.js, createGlobalSetupTasks())
 * runs plugin setup — which includes the `webServer` plugin spawning
 * `npm run build && npm run start` and waiting for its health check to pass
 * — BEFORE the user's `globalSetup` file. By the time globalSetup's rmSync
 * ran, the server had already started, already opened data/finimpact.db,
 * and already served a passing health check against the PRE-cleanup data.
 * Two consequences, both real:
 *
 *   1. On Windows, deleting a file that's open in another process typically
 *      throws EBUSY/EPERM, which crashes the whole Playwright run outright.
 *      This is (part of) why local Windows Playwright runs here are known
 *      to be flaky — see README "E2E Tests".
 *   2. Cross-platform (including CI's ubuntu-latest — see
 *      .github/workflows/deploy-pages.yml's `e2e` job, the real gate for
 *      this suite): even where rmSync silently unlinks the file, the
 *      already-running server keeps its open file descriptor and keeps
 *      serving from the PRE-cleanup data — the "fresh known-seed" guarantee
 *      this cleanup exists for never actually took effect for the server
 *      the tests hit.
 *
 * The fix: run this script to completion as the FIRST step of
 * `webServer.command` in playwright.config.ts (chained with `&&`, executed
 * via a shell per Playwright's WebServerPlugin), so the delete is guaranteed
 * to finish before `npm run start` ever opens the database file — no
 * dependency on Playwright's internal globalSetup-vs-webServer ordering.
 */
import { existsSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");

/** Delete the e2e SQLite DB file and its WAL/SHM siblings, if present. Safe to call when they don't exist. */
export function resetE2eDatabase(): void {
  for (const filename of ["finimpact.db", "finimpact.db-shm", "finimpact.db-wal"]) {
    const filePath = path.join(DATA_DIR, filename);
    if (existsSync(filePath)) {
      rmSync(filePath);
    }
  }
}

// Only run when executed directly (`tsx tests/e2e/reset-e2e-db.ts`, invoked
// via the `e2e:reset-db` npm script from playwright.config.ts's webServer
// command), not when imported elsewhere.
const isDirectExecution = process.argv[1] !== undefined && __filename === path.resolve(process.argv[1]);

if (isDirectExecution) {
  resetE2eDatabase();
}

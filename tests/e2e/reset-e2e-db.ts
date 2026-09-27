/**
 * E2E database reset — deletes the e2e server's own SQLite database (and its
 * WAL/SHM siblings) so each Playwright run starts with a clean slate. The
 * server's initSchema() reseeds the three canonical sample projects and 8
 * staff members on next start, giving the UI tests a fully deterministic
 * initial state (see tests/e2e/ui/app.spec.ts, which asserts exact seeded
 * totals like "$4,030,000").
 *
 * WHICH FILE THIS DELETES, AND WHY IT IS NEVER data/finimpact.db:
 *
 * This script used to delete the repo's data/finimpact.db — the developer's
 * own database. That file is gitignored, so git cannot bring it back, and the
 * server silently reseeds sample data on the next start, so the loss looks
 * like a healthy app. Running the e2e suite destroyed a real local database
 * that way on 2026-09-02.
 *
 * The e2e server now runs against E2E_DB_PATH, a dedicated file under the OS
 * temp directory: playwright.config.ts passes it to the server as DB_PATH,
 * which server/db.ts honors. This script deletes only that file, and it
 * refuses to run when DB_PATH names any other file, so `npm run e2e:reset-db`
 * from a shell whose DB_PATH points at a real database fails instead of
 * deleting it. As a last guard, resetE2eDatabase() refuses any path inside
 * the repo's data/ directory. server/__tests__/e2e-db-reset.test.ts pins all
 * three behaviors.
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
 * ran, the server had already started, already opened the database file,
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
import { existsSync, mkdirSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Where the persistent dev database lives (server/db.ts's default). The reset never deletes anything in here. */
export const REPO_DATA_DIR = path.resolve(__dirname, "..", "..", "data");

/** The e2e server's database: a dedicated file outside the repository. */
export const E2E_DB_PATH = path.join(os.tmpdir(), "fse-e2e", "finimpact-e2e.db");

function isInside(dir: string, target: string): boolean {
  const relative = path.relative(dir, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The file a direct run may delete: always E2E_DB_PATH. Throws when DB_PATH is
 * set to anything else, because then the caller's server is not the e2e server.
 */
export function resolveResetTarget(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DB_PATH;
  if (configured && path.resolve(configured) !== path.resolve(E2E_DB_PATH)) {
    throw new Error(
      `e2e:reset-db refused: DB_PATH is "${configured}", not the e2e database "${E2E_DB_PATH}". ` +
        "Nothing was deleted.",
    );
  }
  return E2E_DB_PATH;
}

/**
 * Delete an e2e SQLite DB file and its WAL/SHM siblings, if present, and make
 * sure its directory exists so the server can create the file. Throws, and
 * deletes nothing, for a path inside `protectedDir` (the repo's data/ unless a
 * test substitutes a scratch directory).
 */
export function resetE2eDatabase(dbPath: string = E2E_DB_PATH, protectedDir: string = REPO_DATA_DIR): void {
  const target = path.resolve(dbPath);
  if (isInside(protectedDir, target)) {
    throw new Error(
      `e2e:reset-db refused: "${target}" is inside ${protectedDir}, the persistent dev database directory. ` +
        "Nothing was deleted.",
    );
  }
  mkdirSync(path.dirname(target), { recursive: true });
  for (const suffix of ["", "-shm", "-wal"]) {
    const filePath = `${target}${suffix}`;
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
  resetE2eDatabase(resolveResetTarget());
}

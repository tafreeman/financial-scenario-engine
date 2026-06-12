/**
 * Playwright global setup — runs once before all e2e tests.
 *
 * Deletes the SQLite database file (and its WAL/SHM siblings) so each test
 * run starts with a clean slate. The server's initSchema() seeds the three
 * canonical sample projects and 8 staff members on first start, giving the
 * UI tests a fully deterministic initial state.
 *
 * Without this cleanup, unit tests that call addProject() (e.g. the
 * updateProject-allowlist suite) accumulate __test_* rows across runs,
 * causing the dashboard "Total Budget" stat card to drift above the seeded
 * $4,030,000 and break assertions that rely on the initial seed values.
 */
import { existsSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");

export default function globalSetup() {
  for (const filename of ["finimpact.db", "finimpact.db-shm", "finimpact.db-wal"]) {
    const filePath = path.join(DATA_DIR, filename);
    if (existsSync(filePath)) {
      rmSync(filePath);
    }
  }
}

/**
 * Guards for tests/e2e/reset-e2e-db.ts, which deletes a SQLite database before
 * every Playwright run.
 *
 * It used to delete the repo's data/finimpact.db, the developer's gitignored
 * and unrecoverable local database, and it did so once for real (2026-09-02).
 * These tests pin the three layers that now keep it away from real data:
 *   1. playwright.config.ts points the e2e server at E2E_DB_PATH, outside the repo;
 *   2. a direct run refuses when DB_PATH names any other file;
 *   3. resetE2eDatabase() refuses any path inside the protected data directory.
 *
 * No test here ever hands the reset a path under the real data/ directory: a
 * regression in the guard would then delete the database it exists to protect.
 * The guard is exercised against a scratch directory instead.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";

import playwrightConfig from "../../playwright.config";
import {
  E2E_DB_PATH,
  REPO_DATA_DIR,
  resetE2eDatabase,
  resolveResetTarget,
} from "../../tests/e2e/reset-e2e-db";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function isInside(dir: string, target: string): boolean {
  const relative = path.relative(dir, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const scratchDirs: string[] = [];

function makeScratchDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fse-reset-test-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("e2e database location", () => {
  it("protects the directory server/db.ts uses by default", () => {
    expect(REPO_DATA_DIR).toBe(path.join(REPO_ROOT, "data"));
  });

  it("keeps the e2e database outside the repository", () => {
    expect(isInside(REPO_ROOT, E2E_DB_PATH)).toBe(false);
  });

  it("starts the Playwright server against the e2e database", () => {
    const webServer = playwrightConfig.webServer;
    expect(webServer).toBeDefined();
    expect(Array.isArray(webServer)).toBe(false);
    if (webServer === undefined || Array.isArray(webServer)) return;
    expect(webServer.env?.DB_PATH).toBe(E2E_DB_PATH);
    // The reset must run before the server opens the file.
    expect(webServer.command.startsWith("npm run e2e:reset-db &&")).toBe(true);
  });
});

describe("resolveResetTarget", () => {
  it("targets the e2e database when DB_PATH is unset or empty", () => {
    expect(resolveResetTarget({})).toBe(E2E_DB_PATH);
    expect(resolveResetTarget({ DB_PATH: "" })).toBe(E2E_DB_PATH);
  });

  it("targets the e2e database when DB_PATH already names it", () => {
    expect(resolveResetTarget({ DB_PATH: E2E_DB_PATH })).toBe(E2E_DB_PATH);
  });

  it("refuses when DB_PATH names the dev database", () => {
    const devDb = path.join(REPO_DATA_DIR, "finimpact.db");
    expect(() => resolveResetTarget({ DB_PATH: devDb })).toThrow(/refused/);
  });

  it("refuses when DB_PATH names any other file", () => {
    const elsewhere = path.join(os.tmpdir(), "someone-elses", "finimpact.db");
    expect(() => resolveResetTarget({ DB_PATH: elsewhere })).toThrow(/refused/);
    expect(() => resolveResetTarget({ DB_PATH: ":memory:" })).toThrow(/refused/);
  });
});

describe("resetE2eDatabase", () => {
  it("deletes the database and its WAL/SHM siblings", () => {
    const dbPath = path.join(makeScratchDir(), "e2e.db");
    for (const suffix of ["", "-shm", "-wal"]) {
      writeFileSync(`${dbPath}${suffix}`, "x");
    }

    resetE2eDatabase(dbPath, makeScratchDir());

    for (const suffix of ["", "-shm", "-wal"]) {
      expect(existsSync(`${dbPath}${suffix}`)).toBe(false);
    }
  });

  it("creates the database directory so the server can open the file", () => {
    const dbPath = path.join(makeScratchDir(), "not", "yet", "e2e.db");

    resetE2eDatabase(dbPath, makeScratchDir());

    expect(existsSync(path.dirname(dbPath))).toBe(true);
  });

  it("refuses a path inside the protected directory and deletes nothing", () => {
    const protectedDir = makeScratchDir();
    const sentinel = path.join(protectedDir, "finimpact.db");
    writeFileSync(sentinel, "real data");

    expect(() => resetE2eDatabase(sentinel, protectedDir)).toThrow(/refused/);
    expect(() => resetE2eDatabase(protectedDir, protectedDir)).toThrow(/refused/);
    expect(existsSync(sentinel)).toBe(true);
  });

  it("refuses a relative path that resolves into the protected directory", () => {
    const protectedDir = makeScratchDir();
    const sentinel = path.join(protectedDir, "finimpact.db");
    writeFileSync(sentinel, "real data");
    const relative = path.relative(process.cwd(), sentinel);

    expect(() => resetE2eDatabase(relative, protectedDir)).toThrow(/refused/);
    expect(existsSync(sentinel)).toBe(true);
  });
});

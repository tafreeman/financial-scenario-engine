/**
 * Unit tests for migrateRetiredGithubModelsDefault() (server/db.ts).
 *
 * GitHub Models retires 2026-07-30. The config seed's `INSERT OR IGNORE`
 * never overwrites an existing row, so any database that already ran with the
 * old `llm_provider = "github"` seed would keep that value forever and break
 * the moment GitHub Models retires. migrateRetiredGithubModelsDefault() is the
 * one-time startup fix-up that rewrites ONLY rows still holding the EXACT
 * retired values — these tests exercise a fresh, isolated `config` table
 * (NOT the shared module-level :memory: DB other tests share) so each case
 * controls its own starting state precisely.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrateRetiredGithubModelsDefault } from "../db.js";

const RETIRED_GITHUB_MODELS_ENDPOINT = "https://models.github.ai/inference/chat/completions";

function makeConfigDb(rows: Record<string, string>): Database.Database {
  const d = new Database(":memory:");
  d.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const insert = d.prepare("INSERT INTO config (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(rows)) {
    insert.run(key, value);
  }
  return d;
}

function getProvider(d: Database.Database): string | undefined {
  const row = d.prepare("SELECT value FROM config WHERE key = 'llm_provider'").get() as
    | { value: string }
    | undefined;
  return row?.value;
}

describe("migrateRetiredGithubModelsDefault", () => {
  it("rewrites llm_provider to ollama when it still holds the exact retired GitHub Models values", () => {
    const d = makeConfigDb({
      llm_provider: "github",
      endpoint: RETIRED_GITHUB_MODELS_ENDPOINT,
    });

    migrateRetiredGithubModelsDefault(d);

    expect(getProvider(d)).toBe("ollama");
  });

  it("does not touch a deliberate custom GitHub-compatible endpoint (e.g. GitHub Enterprise Server Models)", () => {
    const customEndpoint = "https://ghe.example.com/models/inference/chat/completions";
    const d = makeConfigDb({
      llm_provider: "github",
      endpoint: customEndpoint,
    });

    migrateRetiredGithubModelsDefault(d);

    expect(getProvider(d)).toBe("github");
    const endpointRow = d.prepare("SELECT value FROM config WHERE key = 'endpoint'").get() as {
      value: string;
    };
    expect(endpointRow.value).toBe(customEndpoint);
  });

  it("does not touch a database already switched to ollama", () => {
    const d = makeConfigDb({
      llm_provider: "ollama",
      endpoint: RETIRED_GITHUB_MODELS_ENDPOINT, // stale/unused leftover value
    });

    migrateRetiredGithubModelsDefault(d);

    expect(getProvider(d)).toBe("ollama");
  });

  it("does not touch a database already switched to openrouter", () => {
    const d = makeConfigDb({
      llm_provider: "openrouter",
      endpoint: RETIRED_GITHUB_MODELS_ENDPOINT, // stale/unused leftover value
    });

    migrateRetiredGithubModelsDefault(d);

    expect(getProvider(d)).toBe("openrouter");
  });

  it("is a no-op when the config table has no rows at all", () => {
    const d = new Database(":memory:");
    d.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

    expect(() => migrateRetiredGithubModelsDefault(d)).not.toThrow();
    expect(getProvider(d)).toBeUndefined();
  });
});

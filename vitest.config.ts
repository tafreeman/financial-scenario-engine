import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // client/src is included for PURE (no React, no DOM) client-side logic
    // only — this project has no jsdom/Testing Library, so a test that mounts
    // a component cannot run here. See client/src/components/provider-config.ts,
    // which exists precisely so the provider → config-key mapping is testable
    // without a DOM.
    include: [
      "server/**/__tests__/**/*.test.ts",
      "client/src/**/__tests__/**/*.test.ts",
    ],
    // Pin a stable shared secret for the whole suite. server/auth.ts reads
    // APP_API_TOKEN once at module-load time; setting it here (before any test
    // module imports auth.ts) makes requireAppToken's guard deterministically
    // active with a known token so the auth integration test can exercise it.
    env: {
      APP_API_TOKEN: "test-app-token-fixed-secret-for-vitest",
      // Isolate every test from the persistent dev DB (data/finimpact.db).
      // getDb() seeds schema + sample data into this in-memory DB per worker,
      // so tests never read or mutate real data and leave nothing behind.
      DB_PATH: ":memory:",
    },
    coverage: {
      provider: "v8",
      include: ["server/engine/**/*.ts"],
      exclude: [
        "server/engine/**/__tests__/**",
        "server/engine/executor.ts",   // orchestration layer — covered by direct Vitest tests (server/engine/__tests__/), NOT Playwright E2E, which mocks the /api/scenario/v3 endpoint
        "server/engine/portfolio.ts",  // portfolio aggregation — covered by direct Vitest tests (server/engine/__tests__/), NOT Playwright E2E, which mocks the /api/scenario/v3 endpoint
        "server/engine/index.ts",       // barrel re-export only
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,
      },
      reporter: ["text", "lcov"],
    },
  },
});

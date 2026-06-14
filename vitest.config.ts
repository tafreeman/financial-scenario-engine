import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/__tests__/**/*.test.ts"],
    // Pin a stable shared secret for the whole suite. server/auth.ts reads
    // APP_API_TOKEN once at module-load time; setting it here (before any test
    // module imports auth.ts) makes requireAppToken's guard deterministically
    // active with a known token so the auth integration test can exercise it.
    env: {
      APP_API_TOKEN: "test-app-token-fixed-secret-for-vitest",
    },
    coverage: {
      provider: "v8",
      include: ["server/engine/**/*.ts"],
      exclude: [
        "server/engine/**/__tests__/**",
        "server/engine/executor.ts",   // orchestration layer — covered by Playwright E2E
        "server/engine/portfolio.ts",  // portfolio aggregation — covered by Playwright E2E
        "server/engine/utilization.ts", // no unit tests yet
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

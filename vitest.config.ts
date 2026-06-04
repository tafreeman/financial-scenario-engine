import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/__tests__/**/*.test.ts"],
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

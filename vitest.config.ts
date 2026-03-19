import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/engine/__tests__/**/*.test.ts"],
  },
});

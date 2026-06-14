import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    // Seed the shared API token into localStorage for every test so the UI
    // sends x-app-token on mutating calls (e.g. PUT /api/config). The server
    // is started with the matching APP_API_TOKEN below.
    storageState: "./tests/e2e/auth-state.json",
    // Direct API calls via the `request` fixture (e.g. the Excel import specs)
    // bypass the browser/localStorage, so seed the token as a default header
    // too. Must match the webServer APP_API_TOKEN below.
    extraHTTPHeaders: { "x-app-token": "e2e-app-token" },
  },
  webServer: {
    command: "npm run build && npm run start",
    env: {
      PORT: "3100",
      // Stable token for e2e; matches tests/e2e/auth-state.json localStorage seed.
      APP_API_TOKEN: "e2e-app-token",
    },
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

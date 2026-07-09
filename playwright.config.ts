import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
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
    // e2e:reset-db MUST finish before build/start — it deletes
    // data/finimpact.db so the server seeds fresh, and the server opens
    // that file as soon as it starts. Chaining with && (not Playwright's
    // globalSetup) guarantees that ordering — see tests/e2e/reset-e2e-db.ts
    // for why globalSetup was the wrong tool here.
    command: "npm run e2e:reset-db && npm run build && npm run start",
    env: {
      PORT: "3100",
      // Stable token for e2e; matches tests/e2e/auth-state.json localStorage seed.
      APP_API_TOKEN: "e2e-app-token",
      // Disable the gh-CLI token fallback so the "no token" UI state is
      // deterministic in e2e — otherwise a machine with `gh` authenticated
      // (local dev, or a runner with gh logged in) would resolve a token and
      // change the Settings copy the tests assert on. With no github_pat and no
      // GITHUB_TOKEN, this pins github_token_source to "none".
      FSE_DISABLE_GH_TOKEN: "1",
    },
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

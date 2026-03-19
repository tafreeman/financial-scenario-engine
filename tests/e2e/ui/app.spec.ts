import { expect, test } from "@playwright/test";

// ============================================================================
// FINANCIAL IMPACT ANALYZER — E2E TEST TRAINING GUIDE
// ============================================================================
//
// HOW TO RUN THESE TESTS:
//   npm run test:e2e              — runs all tests (API + UI)
//   npx playwright test tests/e2e/ui/  — runs only UI tests
//   npx playwright test --headed  — watch the browser as tests run
//   npx playwright test --debug   — step through tests one action at a time
//   npx playwright test -g "adds" — run only tests matching "adds"
//
// WHAT HAPPENS WHEN YOU RUN:
//   1. Playwright builds the React frontend (npm run build)
//   2. Starts the Express server on port 3100
//   3. Waits for /api/health to return 200
//   4. Opens a real Chromium browser (headless by default)
//   5. Runs each test — navigating, clicking, typing, and asserting
//   6. Shuts down the server when done
//
// SEEDED TEST DATA (created automatically by the server on first start):
//   Projects:
//     - Project Alpha: $1,250,000 budget, $485,000 spent
//     - Project Beta:  $2,100,000 budget, $1,340,000 spent
//     - Project Gamma: $680,000 budget,   $210,000 spent
//
//   Staff (8 people across 3 projects):
//     Alpha: J. Smith (Senior Dev), K. Chen (Mid Dev), L. Park (BA)
//     Beta:  M. Jones (Lead Architect), N. Davis (Senior Dev), P. Wilson (QA)
//     Gamma: R. Brown (Mid Dev), S. Lee (Junior Dev)
//
//   Rate Card (8 labor categories):
//     Lead Architect ($285/hr), Senior Developer ($245/hr),
//     Mid-level Developer ($185/hr), Junior Developer ($135/hr),
//     Business Analyst ($175/hr), QA Engineer ($165/hr),
//     Project Manager ($225/hr), Scrum Master ($195/hr)
//
// ============================================================================


// ── LESSON 1: APP SHELL & NAVIGATION ────────────────────────────────────────
// These tests verify the app loads and you can switch between tabs.
// Key concepts: page.goto(), getByRole(), getByText(), toBeVisible()

test.describe("App shell and navigation", () => {

  test("renders header and defaults to Dashboard tab", async ({ page }) => {
    // STEP 1: Navigate to the app's root URL
    // page.goto("/") uses the baseURL from playwright.config.ts (http://127.0.0.1:3100)
    await page.goto("/");

    // STEP 2: Verify the header is present
    // page.locator("header") finds the <header> HTML element
    // .toContainText() checks that it includes this text anywhere inside
    await expect(page.locator("header")).toContainText("Financial Impact Analyzer");

    // STEP 3: Verify Dashboard tab exists
    // getByRole("button") finds elements with button role
    // { name: "Dashboard" } matches the button's accessible name (its text content)
    const dashboardTab = page.getByRole("button", { name: "Dashboard" });
    await expect(dashboardTab).toBeVisible();

    // STEP 4: Verify Dashboard content loaded (not just the tab, but actual data)
    await expect(page.getByText("Total Budget")).toBeVisible();
  });

  test("switches between all four tabs", async ({ page }) => {
    await page.goto("/");

    // Click each tab and verify the correct content appears.
    // This confirms the tab routing works and each view loads its data.

    // Tab 1 → Staffing
    await page.getByRole("button", { name: "Staffing" }).click();
    await expect(page.getByText("Active Staff")).toBeVisible();

    // Tab 2 → AI Analyst
    await page.getByRole("button", { name: "AI Analyst" }).click();
    await expect(page.getByText("Scenario Question")).toBeVisible();

    // Tab 3 → Settings
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("GitHub Personal Access Token")).toBeVisible();

    // Tab 4 → Back to Dashboard
    await page.getByRole("button", { name: "Dashboard" }).click();
    await expect(page.getByText("Total Budget")).toBeVisible();
  });
});


// ── LESSON 2: DASHBOARD ─────────────────────────────────────────────────────
// These tests verify the dashboard loads financial data from the database.
// Key concepts: getByRole("cell"), getByRole("columnheader")

test.describe("Dashboard", () => {

  test("displays summary stat cards", async ({ page }) => {
    await page.goto("/");

    // The dashboard has 4 stat cards at the top.
    // getByText() finds any element containing that exact text.
    await expect(page.getByText("Total Budget")).toBeVisible();
    await expect(page.getByText("Monthly Burn")).toBeVisible();
    await expect(page.getByText("Blended Margin")).toBeVisible();
    await expect(page.getByText("Headcount")).toBeVisible();
  });

  test("stat cards show correct values from seeded data", async ({ page }) => {
    // PATTERN: AAA (Arrange → Act → Assert)
    // Every test should follow this structure:
    //   ARRANGE — set up preconditions (navigate, seed data, open a form)
    //   ACT     — perform the user action being tested
    //   ASSERT  — verify the expected outcome
    //
    // In this test, Act is implicit — the dashboard loads and renders data
    // automatically on navigation. Not every test has an explicit Act step.
    //
    // CONCEPT: Testing data ACCURACY, not just presence.
    // The existing test checks that "Total Budget" exists — this test checks
    // that the VALUE next to it is correct based on seed data.
    //
    // Seed data (deterministic — same every run):
    //   Alpha: $1,250,000 + Beta: $2,100,000 + Gamma: $680,000 = $4,030,000
    //   8 staff members across 3 projects
    //   Monthly burn = sum of (cost_rate × hours/week × 4.33) per person
    //   Blended margin = (revenue - cost) / revenue × 100

    // ── ARRANGE: Navigate to the dashboard ──
    await page.goto("/");

    // ── ASSERT: Verify each stat card shows the correct value ──
    // WHY scope to a card container?
    //   The stat label "Total Budget" and its value "$4,030,000" live in the
    //   same card div. We scope to that card so we assert the VALUE belongs
    //   to the right label — not just that the number appears somewhere on the page.
    const budgetCard = page.locator(".card", { has: page.getByText("Total Budget") });
    await expect(budgetCard).toContainText("$4,030,000");

    const burnCard = page.locator(".card", { has: page.getByText("Monthly Burn") });
    await expect(burnCard).toContainText("$199,830");

    const marginCard = page.locator(".card", { has: page.getByText("Blended Margin") });
    await expect(marginCard).toContainText("26.6%");

    const headcountCard = page.locator(".card", { has: page.getByText("Headcount") });
    await expect(headcountCard).toContainText("8");
  });

  test("project table shows correct per-project financials", async ({ page }) => {
    // PATTERN: AAA (Arrange → Act → Assert)
    //   ARRANGE — navigate to dashboard
    //   ACT     — implicit (table renders on load)
    //   ASSERT  — verify per-project values in each row
    //
    // CONCEPT: Scoping assertions to a table row.
    //   "$765,000" could appear in Alpha's "Remaining" or elsewhere.
    //   Scoping to the <tr> that contains "Project Alpha" guarantees we're
    //   checking the right project's data.

    // ── ARRANGE: Navigate to the dashboard ──
    await page.goto("/");

    // ── ASSERT: Verify each project row shows correct financials ──

    // Alpha: budget $1,250,000, spent $485,000, remaining $765,000
    const alphaRow = page.locator("tr", {
      has: page.getByRole("cell", { name: "Project Alpha" }),
    });
    await expect(alphaRow).toContainText("$1,250,000");
    await expect(alphaRow).toContainText("$485,000");
    await expect(alphaRow).toContainText("$765,000");
    await expect(alphaRow).toContainText("10.7");

    // Beta: budget $2,100,000, spent $1,340,000, remaining $760,000
    const betaRow = page.locator("tr", {
      has: page.getByRole("cell", { name: "Project Beta" }),
    });
    await expect(betaRow).toContainText("$2,100,000");
    await expect(betaRow).toContainText("$1,340,000");
    await expect(betaRow).toContainText("$760,000");
    await expect(betaRow).toContainText("8.6");

    // Gamma: budget $680,000, spent $210,000, remaining $470,000
    const gammaRow = page.locator("tr", {
      has: page.getByRole("cell", { name: "Project Gamma" }),
    });
    await expect(gammaRow).toContainText("$680,000");
    await expect(gammaRow).toContainText("$210,000");
    await expect(gammaRow).toContainText("$470,000");
    await expect(gammaRow).toContainText("11.8");
  });

  test("displays project budget table with all seeded projects", async ({ page }) => {
    await page.goto("/");

    // Check the table title
    await expect(page.getByText("Project Budget Overview")).toBeVisible();

    // getByRole("cell") finds <td> elements in a table.
    // { name: "Project Alpha" } matches the cell's text content.
    // This is the BEST way to find table data — it's resilient to CSS changes.
    await expect(page.getByRole("cell", { name: "Project Alpha" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Project Beta" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Project Gamma" })).toBeVisible();

    // getByRole("columnheader") finds <th> elements
    await expect(page.getByRole("columnheader", { name: "Budget" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Spent" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Remaining" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Burn/Mo" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Months Left" })).toBeVisible();
  });
});


// ── LESSON 3: STAFFING VIEW ─────────────────────────────────────────────────
// These tests cover the Staffing tab: viewing data, filtering, and CRUD.
// Key concepts: test.beforeEach(), selectOption(), fill(), waitForResponse(),
//               page.on("dialog"), locator scoping, .not.toBeVisible()

test.describe("Staffing view", () => {

  // beforeEach runs before EVERY test in this describe block.
  // It navigates to the Staffing tab so each test starts in the right place.
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Staffing" }).click();
    await expect(page.getByText("Active Staff")).toBeVisible();
  });

  test("displays staffing summary and table with seeded data", async ({ page }) => {
    // SCOPING: "Monthly Cost" appears in BOTH the summary bar AND the table header.
    // If we just wrote: page.getByText("Monthly Cost")
    // Playwright would find 2 matches and throw a "strict mode violation" error.
    //
    // SOLUTION: Scope the search to a specific container using page.locator()
    // with { has: ... } to identify the right container.
    const summaryBar = page.locator(".card", { has: page.getByText("Active Staff") });
    await expect(summaryBar.getByText("Monthly Cost")).toBeVisible();
    await expect(summaryBar.getByText("Monthly Revenue")).toBeVisible();
    await expect(summaryBar.getByText("Blended Margin")).toBeVisible();

    // Staff from the seed data should appear in the table
    await expect(page.getByRole("cell", { name: "J. Smith" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "K. Chen" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "M. Jones" })).toBeVisible();
  });

  test("displays rate card with all labor categories", async ({ page }) => {
    // Same scoping technique — "Lead Architect" appears in both the staffing
    // table AND the rate card. Scope to the rate card container.
    const rateCard = page.locator(".card", { has: page.getByText("Rate Card") });
    await expect(rateCard).toBeVisible();

    await expect(rateCard.getByRole("cell", { name: "Lead Architect" })).toBeVisible();
    await expect(rateCard.getByRole("cell", { name: "Senior Developer" })).toBeVisible();
    await expect(rateCard.getByRole("cell", { name: "Junior Developer" })).toBeVisible();
    await expect(rateCard.getByRole("cell", { name: "QA Engineer" })).toBeVisible();
  });

  test("filters staffing by project", async ({ page }) => {
    // Use the project filter dropdown.
    // .first() gets the first <select> with class "input-field" (the filter, not the add form).
    await page.locator("select.input-field").first().selectOption({ label: "Project Alpha" });

    // waitForResponse waits until the browser receives a matching HTTP response.
    // This ensures the filtered data has loaded before we check the table.
    await page.waitForResponse(
      (r) => r.url().includes("/api/staffing") && r.status() === 200
    );

    // Alpha staff should still be visible
    await expect(page.getByRole("cell", { name: "J. Smith" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "K. Chen" })).toBeVisible();

    // Beta staff should be GONE after filtering
    // .not.toBeVisible() asserts the element is NOT on screen
    await expect(page.getByRole("cell", { name: "M. Jones" })).not.toBeVisible();
  });

  test("adds and removes a staffing assignment", async ({ page }) => {
    // ── ADD FLOW ──

    // Step 1: Open the add form
    await page.getByRole("button", { name: "Add Staffing" }).click();
    await expect(page.getByText("Add Staffing Assignment")).toBeVisible();

    // Step 2: Fill out the form fields
    const selects = page.locator(".input-field").locator("visible=true");

    // Select project from dropdown (nth(1) = second select, after the filter)
    await selects.nth(1).selectOption({ label: "Project Alpha" });

    // Select role from dropdown (nth(2) = third select)
    await selects.nth(2).selectOption({ index: 1 }); // First available role

    // Type a person name into the text input
    // getByPlaceholder() finds <input placeholder="Person name">
    await page.getByPlaceholder("Person name").fill("E2E Test Person");

    // Step 3: Submit the form
    // { exact: true } prevents matching "Add Staffing" — only matches "Add"
    await page.getByRole("button", { name: "Add", exact: true }).click();

    // Step 4: Wait for the table to refresh with new data
    await page.waitForResponse(
      (r) => r.url().includes("/api/staffing") && r.status() === 200
    );

    // Step 5: Verify the new person appears
    await expect(page.getByRole("cell", { name: "E2E Test Person" })).toBeVisible();

    // ── REMOVE FLOW ──

    // Step 1: Find the specific table row containing our test person
    // locator("tr", { has: ... }) finds a <tr> that contains a matching child
    const row = page.locator("tr", {
      has: page.getByRole("cell", { name: "E2E Test Person" }),
    });

    // Step 2: Handle the browser's confirm() dialog BEFORE clicking delete
    // page.on("dialog") registers a handler for the next dialog that appears.
    // dialog.accept() clicks "OK" on the confirm dialog.
    page.on("dialog", (dialog) => dialog.accept());

    // Step 3: Click the trash icon (it has title="Remove")
    await row.getByTitle("Remove").click();

    // Step 4: Wait for table refresh
    await page.waitForResponse(
      (r) => r.url().includes("/api/staffing") && r.status() === 200
    );

    // Step 5: Verify the person is gone
    await expect(page.getByRole("cell", { name: "E2E Test Person" })).not.toBeVisible();
  });
});


// ── LESSON 4: SETTINGS PANEL ────────────────────────────────────────────────
// These tests cover configuration: loading defaults, saving, persistence.
// Key concepts: toHaveValue(), selectOption(), page reload, test cleanup

test.describe("Settings panel", () => {

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
  });

  test("loads default configuration values", async ({ page }) => {
    // toHaveValue() checks the current value of an input or select element.
    // This is different from toContainText() — it checks the form value, not visible text.
    const modelSelect = page.locator("select.input-field");
    await expect(modelSelect).toHaveValue("openai/gpt-4.1");

    // Check the endpoint input has the expected URL
    const endpointInput = page.locator("input.input-field[value*='models.github.ai']");
    await expect(endpointInput).toBeVisible();

    // When no PAT is set, the app shows a warning message
    await expect(page.getByText("No PAT configured")).toBeVisible();
  });

  test("saves model configuration and persists across page reload", async ({ page }) => {
    // Step 1: Change the model dropdown
    const modelSelect = page.locator("select.input-field");
    await modelSelect.selectOption("openai/gpt-4o");

    // Step 2: Click Save
    await page.getByRole("button", { name: /Save Settings/ }).click();

    // Step 3: Wait for the "Saved" confirmation badge to appear
    await expect(page.getByText("Saved")).toBeVisible();

    // Step 4: Reload the entire page to verify the change persisted to the database
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    const reloadedSelect = page.locator("select.input-field");
    await expect(reloadedSelect).toHaveValue("openai/gpt-4o");

    // CLEANUP: Restore the default so other tests aren't affected.
    // Always leave the database in the same state you found it.
    await reloadedSelect.selectOption("openai/gpt-4.1");
    await page.getByRole("button", { name: /Save Settings/ }).click();
    await expect(page.getByText("Saved")).toBeVisible();
  });
});


// ── LESSON 5: AI ANALYST TAB ────────────────────────────────────────────────
// This test checks the AI tab's UI elements are present.
// The AI features require a GitHub PAT to actually call the LLM, so we only
// verify the UI here. See ai-workflow.spec.ts for tests that MOCK the AI
// responses so you can test the full flow without a PAT.

test.describe("AI Analyst tab", () => {

  test("shows query input, quick-query buttons, and history sidebar", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "AI Analyst" }).click();

    // The text input area
    await expect(page.getByText("Scenario Question")).toBeVisible();
    await expect(page.getByPlaceholder(/What staffing changes/)).toBeVisible();

    // Pre-built quick query buttons — clicking these auto-fills and sends a query
    await expect(page.getByRole("button", { name: "Staffing Swap" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Burn Rate Check" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Extend + Stay in Budget" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Improve Margin" })).toBeVisible();

    // History sidebar shows previous queries
    await expect(page.getByText("History")).toBeVisible();
  });
});

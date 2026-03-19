import { expect, test } from "@playwright/test";

// ============================================================================
// AI ANALYST WORKFLOW TESTS — Using Mocked API Responses
// ============================================================================
//
// CONCEPT: page.route() intercepts HTTP requests from the browser BEFORE they
// reach the server. We replace the real AI response with a fake one so we can:
//   - Test without a GitHub PAT or real LLM calls
//   - Get deterministic results every time (no flaky AI output)
//   - Test error states (what happens when the AI fails?)
//   - Run tests fast (no 10-30 second LLM wait)
//
// HOW page.route() WORKS:
//   Browser clicks "Send" → fetch("/api/scenario/v3", ...) → page.route intercepts
//   → returns our fake JSON → React renders the fake response → we assert on it
//
// The real server is still running (for other endpoints like /api/scenarios),
// we only mock the AI call itself.
// ============================================================================


// A reusable fake response that mimics what the V3 agentic endpoint returns.
// This represents: "What if we swap the Senior Dev on Alpha for two Mid Devs?"
function buildMockSwapResponse() {
  return {
    content: "Replacing J. Smith (Senior Developer) with two Mid-level Developers would **save $2,600/month** but reduce the blended margin by 1.2 percentage points.",
    model: "openai/gpt-4.1",
    tokensUsed: 1247,
    scenarios_explored: [
      {
        operation: { action: "swap", project: "Project Alpha" },
        timestamp: new Date().toISOString(),
        project_name: "Project Alpha",
        projects_involved: ["Project Alpha"],
        current: {
          labor: {
            monthly_cost: 80190, monthly_revenue: 106210,
            annual_cost: 962280, annual_revenue: 1274520,
            blended_cost_rate: 161.5, blended_bill_rate: 213.9,
            fte_count: 2.75, headcount: 3,
          },
          margin: {
            margin_pct: 24.5, margin_dollars_monthly: 26020,
            margin_dollars_annual: 312240, gross_margin_pct: 24.5,
            contribution_margin: 26020, net_direct_labor_multiplier: 1.32,
          },
          budget: {
            monthly_burn_rate: 80190, remaining_budget: 765000,
            months_remaining: 9.5, budget_exhaustion_date: "2027-01-01",
            annual_run_rate: 962280,
          },
        },
        projected: {
          labor: {
            monthly_cost: 77590, monthly_revenue: 100230,
            annual_cost: 931080, annual_revenue: 1202760,
            blended_cost_rate: 148.3, blended_bill_rate: 191.7,
            fte_count: 3.75, headcount: 4,
          },
          margin: {
            margin_pct: 22.6, margin_dollars_monthly: 22640,
            margin_dollars_annual: 271680, gross_margin_pct: 22.6,
            contribution_margin: 22640, net_direct_labor_multiplier: 1.29,
          },
          budget: {
            monthly_burn_rate: 77590, remaining_budget: 765000,
            months_remaining: 9.9, budget_exhaustion_date: "2027-01-15",
            annual_run_rate: 931080,
          },
        },
        impact: {
          cost_delta_monthly: -2600, cost_delta_annual: -31200,
          revenue_delta_monthly: -5980, revenue_delta_annual: -71760,
          margin_delta_pct: -1.9, margin_delta_dollars_monthly: -3380,
          burn_rate_delta: -2600, burn_rate_delta_pct: -3.2,
          months_remaining_delta: 0.4, headcount_delta: 1, fte_delta: 1,
        },
        warnings: [],
      },
    ],
  };
}

// A reusable fake error response
function buildMockErrorResponse() {
  return {
    content: "",
    model: "",
    tokensUsed: 0,
    scenarios_explored: [],
    error: "GitHub API rate limit exceeded. Please wait a few minutes and try again.",
  };
}


test.describe("AI Analyst — full workflow with mocked responses", () => {

  test("type a query, submit, and see scenario results", async ({ page }) => {
    // MOCK SETUP: Intercept the V3 endpoint and return our fake response.
    // This MUST be set up BEFORE the user action that triggers the request.
    await page.route("**/api/scenario/v3", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildMockSwapResponse()),
      });
    });

    // Navigate to the AI Analyst tab
    await page.goto("/");
    await page.getByRole("button", { name: "AI Analyst" }).click();

    // Type a query into the textarea
    const textarea = page.getByPlaceholder(/What staffing changes/);
    await textarea.fill("What if we swap the Senior Dev on Alpha for two Mid Devs?");

    // Submit with Ctrl+Enter (the app's keyboard shortcut)
    await textarea.press("Control+Enter");

    // The loading spinner should appear while "waiting" for the AI
    // (Our mock responds instantly, but the UI still briefly shows the spinner)

    // RESULTS: Verify the scenario badge appears
    await expect(page.getByText("1 scenario computed")).toBeVisible();

    // Verify the token and model info line
    await expect(page.getByText("1,247 tokens")).toBeVisible();

    // Verify the AI narrative rendered (uses ReactMarkdown)
    await expect(page.getByText(/save \$2,600\/month/)).toBeVisible();

    // Verify the scenario accordion shows the cost delta in its header
    await expect(page.getByRole("button", { name: /swap — Project Alpha/ })).toBeVisible();
  });

  test("click a quick-query button to auto-submit", async ({ page }) => {
    // Mock the AI endpoint
    await page.route("**/api/scenario/v3", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildMockSwapResponse()),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "AI Analyst" }).click();

    // Click a quick query button — this fills the input AND submits immediately
    await page.getByRole("button", { name: "Staffing Swap" }).click();

    // Results should appear (same mock response)
    await expect(page.getByText("1 scenario computed")).toBeVisible();
    await expect(page.getByText(/save \$2,600\/month/)).toBeVisible();
  });

  test("expand a scenario accordion to see before/after details", async ({ page }) => {
    await page.route("**/api/scenario/v3", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildMockSwapResponse()),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "AI Analyst" }).click();
    await page.getByRole("button", { name: "Staffing Swap" }).click();

    // Wait for results
    await expect(page.getByText("1 scenario computed")).toBeVisible();

    // Click the accordion to expand scenario details.
    // We use getByRole with a regex to match the accordion button text
    // (which contains "swap — Project Alpha" and the cost delta).
    // We avoid locator("button", { hasText: "swap" }) because "swap" also
    // matches the "Staffing Swap" quick-query button — a strict mode violation.
    const accordion = page.getByRole("button", { name: /swap — Project Alpha/ });
    await accordion.click();

    // The expanded section should show the Before vs After table
    await expect(page.getByText("Before vs After")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Before" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "After" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Change" })).toBeVisible();

    // Collapse it by clicking again
    await accordion.click();
    await expect(page.getByText("Before vs After")).not.toBeVisible();
  });

  test("shows error message when AI call fails", async ({ page }) => {
    // Mock a FAILURE response — the AI endpoint returns an error
    await page.route("**/api/scenario/v3", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildMockErrorResponse()),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "AI Analyst" }).click();

    // Submit a query
    const textarea = page.getByPlaceholder(/What staffing changes/);
    await textarea.fill("test query");
    await textarea.press("Control+Enter");

    // The error message should appear (the app checks result.error)
    await expect(page.getByText(/rate limit exceeded/i)).toBeVisible();

    // No scenario cards should appear
    await expect(page.getByText("scenario computed")).not.toBeVisible();
  });

  test("shows error message when network request fails", async ({ page }) => {
    // Mock a NETWORK failure — the server is unreachable
    await page.route("**/api/scenario/v3", async (route) => {
      await route.fulfill({ status: 500, body: JSON.stringify({ error: "Internal server error" }) });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "AI Analyst" }).click();

    const textarea = page.getByPlaceholder(/What staffing changes/);
    await textarea.fill("test query");
    await textarea.press("Control+Enter");

    // The app should show the error from the failed fetch
    await expect(page.getByText(/Internal server error|HTTP 500/)).toBeVisible();
  });

  test("send button is disabled while query is loading", async ({ page }) => {
    // Mock with a delay to simulate slow AI response
    await page.route("**/api/scenario/v3", async (route) => {
      // Wait 2 seconds before responding (simulates LLM thinking)
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildMockSwapResponse()),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "AI Analyst" }).click();

    const textarea = page.getByPlaceholder(/What staffing changes/);
    await textarea.fill("test query");
    await textarea.press("Control+Enter");

    // While loading, the textarea should be disabled
    await expect(textarea).toBeDisabled();

    // The loading indicator should be visible
    await expect(page.getByText("Analyzing scenarios")).toBeVisible();

    // Wait for the response to complete
    await expect(page.getByText("1 scenario computed")).toBeVisible({ timeout: 5000 });

    // After loading, the textarea should be enabled again
    await expect(textarea).toBeEnabled();
  });
});

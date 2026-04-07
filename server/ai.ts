import { getConfig, buildAnonymizedContextSnapshot, saveScenario } from "./db.js";
import type { ScenarioOperation, ScenarioResult } from "./engine/types.js";
import { executeScenario } from "./engine/executor.js";

// ─── AI Config ───────────────────────────────────────────────────────────────

/** Centralized AI config with defaults applied */
function getAiConfig() {
  return {
    pat: getConfig("github_pat") || process.env.GITHUB_TOKEN || "",
    model: getConfig("model") || "openai/gpt-4.1",
    endpoint: getConfig("endpoint") || "https://models.github.ai/inference/chat/completions",
    temperature: parseFloat(getConfig("temperature") || "0.2"),
    maxTokens: parseInt(getConfig("max_tokens") || "2000", 10),
  };
}

export interface AiResponse {
  content: string;
  model: string;
  tokensUsed?: number;
  error?: string;
}

// ─── V2: Structured Intent Parsing ───────────────────────────────────────────

const PARSE_INTENT_PROMPT = `You are a financial scenario parser. Your job is to convert natural language into a structured JSON operation that the financial engine can execute. You do NOT compute anything — you only extract the user's intent.

## AVAILABLE ENGINE OPERATIONS

Each operation triggers a specific calculation tool. Pick the one that matches the user's intent and supply the required parameters.

### 1. "swap" — Replace staff on a project
Removes N people of one role and adds M people of another role.
REQUIRED: project, remove[], add[]
Example: "Replace the Senior Dev on Alpha with two Mid Devs"
→ {"action":"swap","project":"Project Alpha","remove":[{"role":"Senior Developer","count":1}],"add":[{"role":"Mid-level Developer","count":2,"hours_per_week":40}]}

### 2. "add" — Add staff to a project
REQUIRED: project, add[]
Each entry needs: role (must match rate card), count, hours_per_week (default 40)
Example: "Add a part-time PM to Beta at 20 hours/week"
→ {"action":"add","project":"Project Beta","add":[{"role":"Project Manager","count":1,"hours_per_week":20}]}

### 3. "remove" — Remove staff from a project
REQUIRED: project, remove[]
Each entry needs: role, count. Optional: person_name for specific person.
Example: "Remove the QA Engineer from Beta"
→ {"action":"remove","project":"Project Beta","remove":[{"role":"QA Engineer","count":1}]}

### 4. "rate_change" — Change billing/cost rates for a role
REQUIRED: project, rate_changes[]
Each entry needs: role, and at least one of new_bill_rate or new_cost_rate ($/hr).
Example: "Increase the Senior Dev bill rate to $275/hr on Alpha"
→ {"action":"rate_change","project":"Project Alpha","rate_changes":[{"role":"Senior Developer","new_bill_rate":275}]}

### 5. "hours_change" — Change hours per week for specific person
REQUIRED: project, hours_changes[]
Each entry needs: person_name, new_hours_per_week.
Example: "Cut K. Chen to 20 hours per week"
→ {"action":"hours_change","project":"Project Alpha","hours_changes":[{"person_name":"K. Chen","new_hours_per_week":20}]}

### 6. "timeline_extension" — Extend project end date
REQUIRED: project, and one of extension_months OR new_end_date (YYYY-MM-DD)
Example: "Extend Alpha by 3 months"
→ {"action":"timeline_extension","project":"Project Alpha","extension_months":3}

### 7. "unexpected_cost" — Add unplanned costs to a project
REQUIRED: project, additional_costs[]
Each cost needs: description, amount ($), is_recurring (bool), frequency_months (if recurring: 1=monthly, 3=quarterly, 12=annual)
Example: "Add a $50,000 one-time licensing fee to Gamma"
→ {"action":"unexpected_cost","project":"Project Gamma","additional_costs":[{"description":"Licensing fee","amount":50000,"is_recurring":false}]}

### 8. "reallocation" — Move staff between projects
REQUIRED: projects[] (exactly 2: [source, destination]), remove[], add[]
Example: "Move the QA Engineer from Beta to Gamma"
→ {"action":"reallocation","projects":["Project Beta","Project Gamma"],"remove":[{"role":"QA Engineer","count":1}],"add":[{"role":"QA Engineer","count":1,"hours_per_week":40}]}

### 9. "burn_rate_check" — Analyze current burn rates and budget runway
OPTIONAL: project (specific project, or omit/"all" for portfolio-wide)
Computes: monthly cost, revenue, margin, months remaining, exhaustion date per project.
Example: "What's the burn rate across all projects?"
→ {"action":"burn_rate_check"}

### 10. "margin_analysis" — Analyze margins and profitability
OPTIONAL: project (specific or "all")
Computes: margin %, margin $, labor multiplier, blended rates per project.
Example: "Analyze margins on Project Alpha"
→ {"action":"margin_analysis","project":"Project Alpha"}

### 11. "evm_analysis" — Earned Value Management analysis
REQUIRED: project
Computes: CPI, SPI, EAC, ETC, VAC, TCPI for the specified project.
Example: "Run EVM analysis on Beta"
→ {"action":"evm_analysis","project":"Project Beta"}

### 12. "what_if_composite" — Multiple changes at once
REQUIRED: sub_operations[] (array of any of the above operations)
Use when the user asks about multiple changes in one question.
Example: "What if we add a PM to Alpha AND remove the Junior Dev from Gamma?"
→ {"action":"what_if_composite","sub_operations":[{"action":"add","project":"Project Alpha","add":[{"role":"Project Manager","count":1,"hours_per_week":40}]},{"action":"remove","project":"Project Gamma","remove":[{"role":"Junior Developer","count":1}]}]}

## OUTPUT FORMAT

Return ONLY a valid JSON object. No markdown, no explanation, no code fences.
Only include fields relevant to the matched operation. Omit unused fields entirely.

## RULES
- Role names MUST match the rate card in the context data (e.g., "Senior Developer" not "Sr Dev")
- Project names MUST match projects in the context data (e.g., "Project Alpha" not "Alpha")
- hours_per_week defaults to 40 if the user doesn't specify
- Do NOT perform any math or calculations
- If the user's query doesn't clearly map to a specific operation, default to "burn_rate_check"
- For questions about "current state" or "how are we doing", use "burn_rate_check" or "margin_analysis"`;

/** Parse user query into a structured ScenarioOperation via LLM */
export async function parseIntent(
  userQuery: string,
  contextSnapshot: string
): Promise<ScenarioOperation> {
  const { pat, model, endpoint } = getAiConfig();

  if (!pat) {
    return { action: "burn_rate_check", _fallback: true, _fallback_reason: "No AI provider configured. Defaulting to burn rate check." };
  }

  const payload = {
    model,
    max_tokens: 500,
    temperature: 0,
    messages: [
      { role: "system", content: `${PARSE_INTENT_PROMPT}\n\nCURRENT DATA:\n${contextSnapshot}` },
      { role: "user", content: userQuery },
    ],
  };

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${pat}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      return { action: "burn_rate_check", _fallback: true, _fallback_reason: `LLM request failed (HTTP ${resp.status}). Defaulting to burn rate check.` };
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content ?? "";

    // Strip markdown fences if the model wraps its response
    const cleaned = content.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    // Validate minimum shape
    if (!parsed.action || typeof parsed.action !== "string") {
      return { action: "burn_rate_check", _fallback: true, _fallback_reason: "Could not parse your query into a specific operation. Showing burn rate analysis instead." };
    }

    return parsed as ScenarioOperation;
  } catch {
    return { action: "burn_rate_check", _fallback: true, _fallback_reason: "Could not parse your query into a specific operation. Showing burn rate analysis instead." };
  }
}

// ─── V2: Narrative Generation ────────────────────────────────────────────────

const NARRATE_PROMPT = `You are a financial analyst narrator. You receive:
1. A scenario operation (what was asked)
2. Pre-computed financial results (all math is already done by the engine)

Your job is to write a clear, professional markdown narrative explaining the results.
Do NOT perform any calculations. ALL numbers are already computed and provided.
Use the EXACT numbers from the results — do not round, adjust, or recalculate them.

FORMAT:
## Impact Summary
2-3 sentences on the key finding.

## Financial Delta
| Metric | Before | After | Change |
(use numbers from the result object)

## Key Observations
Bullet points about notable findings.

## Risks
Any concerns or flags based on the numbers.

## Recommendation
One clear, actionable next step.

RULES:
- Format currency with $ and commas (e.g., $14,289)
- Format percentages to one decimal (e.g., 32.5%)
- Reference specific project and role names
- Be concise — this feeds into a UI panel
- If the result has warnings, incorporate them into Risks`;

/** Generate a human-readable narrative from pre-computed scenario results */
export async function narrateResult(
  operation: ScenarioOperation,
  result: ScenarioResult
): Promise<AiResponse> {
  const { pat, model, endpoint } = getAiConfig();

  if (!pat) {
    return { content: "", model, error: "No GitHub PAT configured. Go to Settings to add one." };
  }

  const payload = {
    model,
    max_tokens: 1500,
    temperature: 0.3,
    messages: [
      { role: "system", content: NARRATE_PROMPT },
      {
        role: "user",
        content: `Operation: ${JSON.stringify(operation)}\n\nPre-computed results:\n${JSON.stringify(result, null, 2)}`,
      },
    ],
  };

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${pat}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      return {
        content: "",
        model,
        error: `HTTP ${resp.status}: ${resp.statusText}\n${errBody.slice(0, 500)}`,
      };
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content ?? "(empty response)";
    const tokensUsed = data.usage?.total_tokens;

    return { content, model, tokensUsed };
  } catch (err: any) {
    return { content: "", model, error: `Narration failed: ${err.message}` };
  }
}

// ─── V3: Agentic Scenario Analysis (tool-calling loop) ──────────────────────

/** Tool definition for the run_scenario function */
const SCENARIO_TOOL = {
  type: "function" as const,
  function: {
    name: "run_scenario",
    description: "Execute a financial scenario through the deterministic calculation engine. Returns exact computed numbers for staffing changes, burn rates, margins, budget runway, etc. Call this tool to get real numbers — do NOT estimate or calculate numbers yourself.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "swap", "add", "remove", "rate_change", "hours_change",
            "timeline_extension", "unexpected_cost", "reallocation",
            "burn_rate_check", "margin_analysis", "evm_analysis",
            "what_if_composite",
          ],
          description: "The type of scenario to analyze",
        },
        project: {
          type: "string",
          description: "Target project name (e.g., 'Project Alpha'). Omit or use 'all' for portfolio-wide analysis.",
        },
        projects: {
          type: "array",
          items: { type: "string" },
          description: "For reallocation: [source_project, destination_project]",
        },
        remove: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", description: "Role name matching rate card" },
              count: { type: "number", description: "Number of people to remove" },
              person_name: { type: "string", description: "Optional: specific person name" },
            },
            required: ["role", "count"],
          },
          description: "Staff to remove",
        },
        add: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", description: "Role name matching rate card" },
              count: { type: "number", description: "Number of people to add" },
              hours_per_week: { type: "number", description: "Hours per week (default 40)" },
            },
            required: ["role", "count"],
          },
          description: "Staff to add",
        },
        rate_changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string" },
              new_bill_rate: { type: "number" },
              new_cost_rate: { type: "number" },
            },
            required: ["role"],
          },
          description: "Rate changes to apply",
        },
        hours_changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              person_name: { type: "string" },
              new_hours_per_week: { type: "number" },
            },
            required: ["person_name", "new_hours_per_week"],
          },
          description: "Hours changes for specific people",
        },
        extension_months: { type: "number", description: "Number of months to extend timeline" },
        new_end_date: { type: "string", description: "New end date (YYYY-MM-DD)" },
        additional_costs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              amount: { type: "number" },
              is_recurring: { type: "boolean" },
              frequency_months: { type: "number" },
            },
            required: ["description", "amount", "is_recurring"],
          },
        },
        sub_operations: {
          type: "array",
          items: { type: "object" },
          description: "For what_if_composite: array of sub-operations",
        },
      },
      required: ["action"],
    },
  },
};

const AGENTIC_SYSTEM_PROMPT = `You are a financial impact analyst with access to a deterministic calculation engine via the run_scenario tool.

YOUR WORKFLOW:
1. Read the user's question and the current project data
2. Call run_scenario one or more times to get REAL computed numbers
3. Analyze the results and determine if they meet the user's goals
4. If the user has a goal (e.g., "stay within budget", "improve margin by 5%"), try multiple scenarios to find options that achieve it
5. Write your final analysis using ONLY numbers returned by the tool — never estimate or calculate numbers yourself

WHEN TO CALL THE TOOL MULTIPLE TIMES:
- Goal-seeking: "How can I extend by 3 months and stay within budget?" → First check current state, then try removing roles, reducing hours, etc. until you find options that work.
- Comparisons: "Which is better, adding a PM or a QA?" → Run both scenarios and compare the engine's numbers.
- Optimization: "What staffing changes would improve margin by 5 points?" → Try several combinations and report which ones achieve the goal.

IMPORTANT RULES:
- ALWAYS use the tool to get numbers. Never compute costs, margins, or burn rates yourself.
- Every dollar amount and percentage in your response must come from a tool result.
- If you need to explore options, call the tool multiple times with different parameters.
- After getting results, evaluate whether they meet the user's stated goal.
- Present your findings with the exact numbers from the tool results.

RESPONSE FORMAT (after all tool calls are complete):
## Analysis
What the user asked and what you explored.

## Scenarios Evaluated
For each scenario you tested, show the key numbers from the engine.

## Recommendation
Which option(s) best meet the user's goals and why.

## Risks
Any concerns from the engine's warnings or the analysis.`;

export interface AgenticResponse {
  content: string;
  model: string;
  tokensUsed: number;
  scenarios_explored: ScenarioResult[];
  error?: string;
}

/** Process tool calls from an LLM response, execute them, and append results to messages */
function processToolCalls(
  toolCalls: any[],
  messages: any[],
  scenariosExplored: ScenarioResult[]
): void {
  for (const toolCall of toolCalls) {
    if (toolCall.function.name !== "run_scenario") continue;
    try {
      const operation = JSON.parse(toolCall.function.arguments) as ScenarioOperation;
      const result = executeScenario(operation);
      scenariosExplored.push(result);
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) });
    } catch (err: any) {
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ error: err.message }) });
    }
  }
}

/** Make a chat completion request to the GitHub Models API */
async function chatRequest(endpoint: string, pat: string, payload: any): Promise<any> {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${pat}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}\n${errBody.slice(0, 500)}`);
  }

  return resp.json();
}

/** Run an agentic analysis where the LLM calls the engine multiple times */
export async function agenticScenario(userQuery: string): Promise<AgenticResponse> {
  const { pat, model, endpoint } = getAiConfig();

  if (!pat) {
    return {
      content: "", model, tokensUsed: 0, scenarios_explored: [],
      error: "No GitHub PAT configured. Go to Settings to add one.",
    };
  }

  const context = buildAnonymizedContextSnapshot();
  const scenariosExplored: ScenarioResult[] = [];
  let totalTokens = 0;
  const messages: any[] = [
    { role: "system", content: `${AGENTIC_SYSTEM_PROMPT}\n\nCURRENT PROJECT DATA:\n${context}` },
    { role: "user", content: userQuery },
  ];

  const MAX_ITERATIONS = 8;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    try {
      const data = await chatRequest(endpoint, pat, {
        model, max_tokens: 2000, temperature: 0.2, messages, tools: [SCENARIO_TOOL], tool_choice: "auto",
      });
      totalTokens += data.usage?.total_tokens ?? 0;

      const choice = data.choices?.[0];
      if (!choice) break;

      messages.push(choice.message);

      // Model is done — return final text
      if (choice.finish_reason === "stop" || !choice.message.tool_calls?.length) {
        return {
          content: choice.message.content ?? "(empty response)",
          model, tokensUsed: totalTokens, scenarios_explored: scenariosExplored,
        };
      }

      // Execute tool calls and feed results back
      processToolCalls(choice.message.tool_calls, messages, scenariosExplored);
    } catch (err: any) {
      return {
        content: "", model, tokensUsed: totalTokens, scenarios_explored: scenariosExplored,
        error: `Agentic loop failed at iteration ${iteration}: ${err.message}`,
      };
    }
  }

  // Exceeded max iterations — request final summary
  return requestFinalSummary(endpoint, pat, model, messages, totalTokens, scenariosExplored);
}

async function requestFinalSummary(
  endpoint: string, pat: string, model: string,
  messages: any[], totalTokens: number, scenariosExplored: ScenarioResult[]
): Promise<AgenticResponse> {
  messages.push({ role: "user", content: "Please provide your final analysis based on the scenarios you've explored so far." });
  try {
    const data = await chatRequest(endpoint, pat, { model, max_tokens: 2000, temperature: 0.2, messages });
    totalTokens += data.usage?.total_tokens ?? 0;
    return {
      content: data.choices?.[0]?.message?.content ?? "(no final response)",
      model, tokensUsed: totalTokens, scenarios_explored: scenariosExplored,
    };
  } catch (_err: any) {
    return {
      content: "Analysis reached iteration limit. See explored scenarios for computed data.",
      model, tokensUsed: totalTokens, scenarios_explored: scenariosExplored,
    };
  }
}

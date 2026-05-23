# ADR 001: LLM-Engine Separation

## Status
Accepted

## Date
2026-05-11

## Context

This tool exists so that project managers can ask natural-language questions — "What happens to our margin if I swap the Senior Developer on Project Alpha for two Mid-level Developers?" — and receive accurate, auditable financial analysis in return. The financial domain imposes a hard requirement on correctness: dollar amounts that appear authoritative but are wrong erode trust in ways that are difficult to recover from. A PM who acts on a hallucinated cost delta may commit to a contract change, staffing decision, or executive presentation that later proves unjustifiable.

The earliest version of this tool (V1) sent raw project financial data to the LLM and asked it to compute the projected impact directly. The prompt provided the staffing records, bill rates, cost rates, and project budgets, and asked the model to return the resulting cost delta, new margin percentage, and budget runway. In practice, the LLM produced plausible-looking but wrong numbers. It invented cost deltas and margin percentages that were directionally reasonable — adding staff costs more, removing staff saves money — but quantitatively incorrect by amounts ranging from a few percentage points to tens of thousands of dollars per month. These errors were not random noise; they were confident, formatted, and structurally indistinguishable from correct output. Catching them required manually recomputing the scenario, which defeated the purpose of the tool.

The core problem is that LLMs are not calculators. They are next-token predictors trained on text; arithmetic is a learned pattern, not a guaranteed capability. For a query like "what is the monthly cost of 1 Senior Developer at $175/hr for 40 hours per week times 4.33 weeks," the model will often produce a reasonable approximation but will occasionally produce a subtly wrong value — and the user has no signal to distinguish the two cases. This is categorically unacceptable for financial tooling, where an approximation is often worse than an error message.

A second concern is reproducibility. If the LLM computes the numbers, then the same question asked twice may yield different answers due to temperature, model version differences, or provider changes. Financial analysis used in project reviews or contract negotiations must produce identical results from identical inputs, regardless of which LLM is in use or whether that LLM has been updated since the last run.

## Decision

The LLM is used exclusively as an intent parser. It converts a natural-language query into a structured `ScenarioOperation` value — a discriminated union type with an `action` field and typed parameters. All financial computation is performed by the deterministic TypeScript engine in `server/engine/`, which has no imports from `server/ai.ts` and performs no I/O. The `ScenarioOperation` produced by `parseIntent()` is handed to `executeScenario()` in `server/engine/executor.ts`, which returns a `ScenarioResult` with all numbers computed from first principles using the project data in the database.

The LLM may also narrate the results after computation via `narrateResult()`, and in the V3 agentic mode (`agenticScenario()`) it may invoke `executeScenario()` multiple times through a tool-calling loop to explore goal-seeking scenarios. In both cases, every number that appears in the final output originates from the engine. The LLM prompt for narration explicitly instructs: "Do NOT perform any calculations. ALL numbers are already computed and provided. Use the EXACT numbers from the results — do not round, adjust, or recalculate them."

## Options Considered

### Option A: LLM Computes Numbers

The LLM receives the project context (staffing records, rates, budget) and the user query, and returns the financial projections directly — cost delta, new margin, budget runway, etc.

**Tradeoffs:** Minimal architecture; a single prompt-and-response covers the full flow. The LLM handles both intent understanding and calculation in one step. However, this is exactly what V1 did, and it failed in production. Calculations are non-deterministic across temperature and model versions. The engine cannot be tested independently because there is no engine. Swapping providers risks changing financial outputs. Auditing a result requires re-running the LLM, not inspecting a formula.

### Option B: Hybrid (LLM Computes, Engine Validates)

The LLM produces financial projections, and a validation layer checks the results against engine-computed values, rejecting or flagging discrepancies beyond a threshold.

**Tradeoffs:** Retains the simplicity of Option A while adding a safety net. In practice, this creates a worse problem: the validator must compute the correct answer anyway, so the LLM's numbers add no value and only introduce a path where wrong numbers could pass validation if the threshold is set too loosely. It also doubles the complexity of every code path, and the "correct" answer is already available from the validator — the LLM output is redundant. This option was rejected because it solves the wrong problem; the question is not how to catch LLM arithmetic errors but how to avoid making them in the first place.

### Option C: Engine-Only Computation (Chosen)

The LLM handles exclusively the natural-language-to-structured-intent translation. The engine handles exclusively the arithmetic. The interface between them is the `ScenarioOperation` type defined in `server/engine/types.ts`, which carries no computed values — only the user's intent expressed as typed parameters.

**Tradeoffs:** Requires building and maintaining a deterministic calculation engine in TypeScript. The engine must cover all 12 operation types defined by the `action` discriminator (`swap`, `add`, `remove`, `rate_change`, `hours_change`, `timeline_extension`, `unexpected_cost`, `reallocation`, `burn_rate_check`, `margin_analysis`, `evm_analysis`, `what_if_composite`). This is more upfront work than Option A. The payoff is that all financial logic is fully testable without LLM credentials, and results are provably deterministic.

## Rationale

The V1 failure was the decisive factor. It demonstrated concretely that LLM arithmetic cannot be trusted for financial output, and it did so in the context of this specific domain and data format — not as a theoretical concern. The hallucinated figures were not edge cases; they appeared on routine scenarios with straightforward arithmetic. Any architecture that leaves number production to the LLM is building on a foundation that has already failed once.

Determinism is a first-class requirement. The current architecture guarantees that `executeScenario(operation)` returns identical output for identical input regardless of whether the LLM provider is GitHub Models (currently `openai/gpt-4.1`) or Ollama running locally. Switching providers, updating model versions, or changing LLM temperature settings cannot affect financial results. This makes the tool defensible in a PM context: if a manager asks "why does the margin come out to 32.5%?", the answer is a reproducible chain of arithmetic in `server/engine/margin.ts`, not a stochastic model whose behavior may have changed since the analysis was run.

Testability was the third factor. The engine in `server/engine/` has no dependency on `server/ai.ts`, no external I/O, and no API credentials. As of this writing it is covered by 98 unit tests spanning `budget.test.ts`, `evm.test.ts`, `goal-seeking.test.ts`, `labor.test.ts`, `margin.test.ts`, `narrative.test.ts`, and `scenarios.test.ts`. Every calculation path — including EVM metrics like CPI, SPI, EAC, and TCPI, and composite what-if scenarios — can be verified in CI without a network connection or API key. This test suite would be impossible to write if the LLM were doing the arithmetic, because the LLM's output cannot be reliably predicted or asserted.

## Consequences

### Positive

- Financial results are deterministic: identical query inputs always produce identical outputs regardless of LLM provider, model version, or temperature.
- The engine is independently testable: 98 unit tests exercise the full calculation surface without requiring LLM credentials or network access.
- Provider independence is architectural, not incidental: swapping from GitHub Models to Ollama changes the quality of intent parsing but cannot change the financial numbers produced.
- The agentic V3 loop (`agenticScenario()`) inherits the same guarantee: the LLM chooses which `executeScenario()` calls to make, but all numbers in the response originate from the engine.
- Audit trails are tractable: a `ScenarioResult` contains the `ScenarioOperation` that produced it and all intermediate metrics, so any output can be reconstructed by re-running the engine against the same database state.
- The `what_if_composite` action allows complex multi-step scenarios to be computed correctly by dispatching sub-operations through the same deterministic path.

### Negative / Tradeoffs

- The engine must cover all 12 operation types explicitly. Adding a new scenario type requires implementing it in the engine, not just updating a prompt.
- Intent parsing quality affects which operation is invoked. A misclassified query routes to the wrong calculation function; the numbers will be accurate for the wrong scenario. Parse failures fall back to `burn_rate_check` rather than returning an error.
- The LLM narration layer (`narrateResult()`) is responsible for faithfully presenting engine numbers. A narration prompt that inadvertently asks the model to restate or summarize numbers in different units could introduce presentation-level discrepancies even when the underlying calculation is correct.
- The `ScenarioOperation` type is the contract between the LLM and the engine. Schema changes to this type require coordinated updates to both the `PARSE_INTENT_PROMPT` in `server/ai.ts` and the handler logic in `server/engine/executor.ts`.

### Constraints Imposed

- `server/engine/` must never import from `server/ai.ts`. The engine has no dependency on AI infrastructure; this boundary is intentional and must not be crossed.
- The LLM must never be asked to compute, estimate, or validate financial figures. This applies to system prompts, narration prompts, and agentic tool descriptions. The `NARRATE_PROMPT` and `AGENTIC_SYSTEM_PROMPT` in `server/ai.ts` must continue to explicitly prohibit self-computation.
- New operation types must be added to both the `action` union in `server/engine/types.ts` and the corresponding handler in `server/engine/executor.ts` before being exposed in the `PARSE_INTENT_PROMPT`. Do not add an action to the prompt without an engine implementation — the fallback will silently return a burn rate check rather than the intended analysis.
- Engine functions must remain pure where possible: no I/O, no randomness, no side effects. Database access is permitted only at the `executor.ts` boundary (`loadPortfolioSnapshot()`), not inside the calculation modules (`labor.ts`, `margin.ts`, `budget.ts`, `evm.ts`, etc.).
- Test coverage for new engine operations is required before merge. The 98-test baseline is not a ceiling; it is a floor that must grow with the engine surface.

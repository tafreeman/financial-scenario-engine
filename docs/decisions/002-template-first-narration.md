# ADR 002: Template-First Narration with LLM Opt-In

## Status
Accepted

## Date
2026-05-11

## Context

After the calculation engine produces a `ScenarioResult` (defined in `server/engine/types.ts`), the result must be communicated to the user in a readable form. Raw `ScenarioResult` JSON is too dense to surface directly in the UI: it contains nested `LaborMetrics`, `MarginMetrics`, `BudgetMetrics`, `ScenarioImpact`, and optional `EvmMetrics` and `portfolio` sub-trees. A narration layer is therefore required to translate computed numbers into a structured, readable format for the UI panel.

Two fundamentally different narration strategies exist. The first sends the pre-computed `ScenarioResult` to an external LLM (via `narrateResult()` in `server/ai.ts`) and asks it to write prose. The second renders the result locally using deterministic string templates (via `generateNarrative()` in `server/engine/narrative.ts`) without any network dependency. These strategies have significantly different characteristics across privacy, cost, determinism, testability, and availability.

The V2 endpoint (`POST /api/scenario/v2`) is the primary integration path for structured scenario analysis. It is designed to be usable in offline or credential-free environments — notably in CI and on developer workstations that may not have a GitHub PAT or Ollama configured. The test suite in `tests/e2e/ui/ai-workflow.spec.ts` must be able to run the full V2 path without live LLM credentials; forcing LLM narration as the default would make this impossible without mocking the narration step separately.

A third endpoint, `POST /api/scenario/v3`, follows a different contract entirely: it is an agentic tool-calling loop (`agenticScenario()` in `server/ai.ts`) where the LLM drives the analysis by calling `run_scenario` tools iteratively, and its final `content` field is the LLM's own synthesis — there is no template narration step, and none is appropriate.

## Decision

The `POST /api/scenario/v2` endpoint uses template-based narration by default. `generateNarrative(result: ScenarioResult): string` is called synchronously to produce a deterministic, structured markdown response covering Impact Summary, Financial Delta table, Key Observations, Risks, and Recommendation sections. LLM narration via `narrateResult(operation, result): Promise<AiResponse>` is only invoked when the caller explicitly passes `use_llm_narrative: true` in the request body. The `POST /api/scenario/v3` endpoint is excluded from this decision: its output is always the LLM's own agentic analysis, and it accepts no narration flag.

## Options Considered

### Option A: LLM-Only Narration

All narration for V2 responses would pass through `narrateResult()`, which constructs a chat completion payload containing the serialized `ScenarioOperation` and `ScenarioResult` and sends it to the configured provider (GitHub Models or Ollama).

**Tradeoffs:**
- Produces higher-quality prose; the LLM can reference project names, role names, and contextual nuance more flexibly than a template.
- Requires a live LLM provider for every V2 response, even for clients that only need the raw `engine` field.
- Every narration call consumes tokens and adds 5–30 seconds of latency.
- Pre-computed financial results (cost deltas, margin percentages, burn rates) are transmitted to an external API endpoint on every call, even though the data has already been anonymized at the `buildAnonymizedContextSnapshot()` boundary in Step 1.
- The full V2 pipeline (query → `parseIntent` → `executeScenario` → narrate) cannot be exercised in CI without live credentials or a separate mock for the narration step.
- If the LLM provider is unreachable, `narrateResult()` returns an error object and the narrative field is blocked entirely — the caller receives no human-readable summary.

### Option B: Template-Only Narration

Narration is always served by `generateNarrative()`. LLM prose is never available on the V2 path.

**Tradeoffs:**
- Zero cost, zero latency, no external dependency.
- Fully deterministic: the same `ScenarioResult` always produces the same markdown string. Unit-testable in `server/engine/__tests__/narrative.test.ts`.
- Output is formulaic. The template cannot adapt phrasing based on scenario context beyond what is mechanically encoded in the render functions (`renderImpactSummary`, `renderObservations`, `renderRisks`, `renderRecommendation`).
- Forecloses the option for callers who want richer prose without building a separate narration endpoint.

### Option C: Template-First with LLM Opt-In (Chosen)

Template narration is the default; LLM narration is available on explicit opt-in via `use_llm_narrative: true`. The route handler in `server/routes.ts` expresses this as a conditional branch: if `use_llm_narrative` is falsy (including when the field is absent), `generateNarrative(engineResult)` is called and the response records `model: "template"`. If `use_llm_narrative` is truthy, `narrateResult(operation, engineResult)` is awaited and its `content` is used, with errors surfacing as a parenthetical message rather than blocking the engine result.

**Tradeoffs:**
- Satisfies both the offline/CI use case (template) and the richer prose use case (opt-in LLM) from a single endpoint.
- Callers that do not need prose at all can pass `skip_narrative: true` to bypass both paths entirely.
- Slightly more complex route handler logic than either pure option, but the branching is contained to a single clearly commented block.

## Rationale

The primary driver is testability. `tests/e2e/ui/ai-workflow.spec.ts` tests the full AI Analyst UI workflow using Playwright's `page.route()` to intercept and mock the V3 endpoint. This works because the V3 endpoint is the only LLM call in the agentic flow. The V2 endpoint, by contrast, is exercised in the E2E Excel import tests and in unit tests without mocking, because the default narration path involves no external call. If LLM narration were the V2 default, every E2E test touching V2 would require either a live credential or a separate narration mock — significantly increasing the maintenance surface for the test suite and making CI fragile.

The second driver is cost and privacy separation. The V2 flow already makes one LLM call in Step 1 (`parseIntent`) to extract a structured `ScenarioOperation` from the user's natural language query. That call sends an anonymized context snapshot — person names are replaced with initials at the `buildAnonymizedContextSnapshot()` boundary in `server/db.ts`. A second LLM call in Step 3 would transmit the computed `ScenarioResult`, which contains precise financial figures (monthly costs, margin percentages, budget runway) derived from the live database. While these figures are not personally identifiable, they are commercially sensitive. The template path transmits nothing. Making the more expensive and more data-exposing path require explicit opt-in is consistent with the principle of least privilege.

The V3 endpoint is explicitly out of scope for this decision because its architecture is fundamentally different: `agenticScenario()` is itself a multi-turn LLM loop, and the final `content` it returns is the model's own synthesis of the tool results it collected. There is no equivalent "template" for agentic output. Clients using V3 have already opted into a fully LLM-driven workflow.

## Consequences

### Positive
- The full `POST /api/scenario/v2` pipeline is E2E testable without any LLM credentials or mocking of the narration layer.
- Default responses are instantaneous for the narration step, keeping P95 V2 latency bounded by the `parseIntent` call alone.
- No computed financial figures are transmitted externally by default; the opt-in flag makes the data-sharing decision explicit at the call site.
- The `generateNarrative` function is independently unit-tested in `server/engine/__tests__/narrative.test.ts` and can be validated for correctness against known `ScenarioResult` fixtures.
- The `V2Response` type (in `server/engine/types.ts`) includes `model: string`; the value `"template"` makes it machine-readable which narration path was used, enabling callers to distinguish responses without inspecting prose content.

### Negative / Tradeoffs
- Template prose is formulaic. For nuanced scenarios — particularly `what_if_composite` operations spanning multiple projects — the template renders section by section but cannot synthesize a cross-cutting insight the way LLM prose can.
- Two narration code paths must be maintained in parallel. If the output format for `generateNarrative` drifts from the `NARRATE_PROMPT` format expected by `narrateResult`, the two paths will produce structurally inconsistent markdown.
- The `use_llm_narrative` flag is a per-request boolean with no server-side default configuration, which may surprise API consumers who expect server settings to govern narration behavior.

### Constraints Imposed
- Future contributors must not promote `use_llm_narrative` to the server-side default without first evaluating the impact on the E2E test suite, CI credential requirements, and token cost per request.
- The `generateNarrative` function must remain a pure, synchronous function with no network I/O. Any enhancement that introduces an async dependency belongs in a separate narration path, not in the template renderer.
- The V3 endpoint must not be given a `use_llm_narrative` flag. Its LLM dependency is inherent to its contract; adding a toggle would introduce false parity with V2.
- When the LLM narration path fails (network error, rate limit, missing PAT), the error must surface as a parenthetical within the `narrative` field — never as an HTTP 500 that prevents the caller from receiving the computed `engine` result. The calculation layer must never be blocked by a narration failure.

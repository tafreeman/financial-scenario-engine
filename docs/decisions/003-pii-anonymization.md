# ADR 003: PII Anonymization Strategy

## Status
Accepted

## Date
2026-05-11

## Context

The fin-impact-tool stores staffing records in a SQLite database. Each row in the `staffing` table includes a `person_name` field containing real employee names (e.g., "J. Smith", "K. Chen", "M. Jones"). Project managers use these names to build and track resource assignments across projects.

The tool optionally delegates natural-language intent parsing to a cloud LLM — specifically, the GitHub Models API endpoint (`https://models.github.ai/inference/chat/completions`). To parse a request like "add a PM to Project Alpha at 20 hours a week," the LLM must receive enough context about current projects, staffing roles, and financial figures to resolve ambiguous references correctly. This means a context snapshot of the database must travel to the LLM provider's infrastructure before any operation executes.

Cloud LLM providers routinely log inference requests for abuse detection, model improvement, and compliance auditing. In federal contracting environments, GDPR-adjacent regulatory contexts, and any setting where employee names are treated as protected personal data, transmitting `person_name` values to a third-party API without explicit consent or a data-processing agreement creates legal exposure and reputational risk. Even where no regulation mandates it, minimizing the PII footprint in external API calls is a sound practice.

The tool's LLM integration touches two distinct points: intent parsing (inbound — user types a natural-language command) and optional narrative generation (outbound — the engine's computed result is turned into a human-readable summary). Both must be audited for PII exposure. The narrative path operates on pre-computed `ScenarioResult` structs that contain calculated metrics (margins, costs, headcount deltas) rather than raw database rows, so person names never appear there. The intent-parsing path, by contrast, requires database context and is the primary risk surface.

## Decision

All context sent to external LLM providers is routed through a single function, `buildAnonymizedContextSnapshot()` in `server/db.ts`. This function is the sole point of contact between the raw database and any LLM call. Within it, every active staffing entry has its `person_name` replaced with a positional token (`Staff-1`, `Staff-2`, etc.) assigned in iteration order. The substitution is consistent within a single snapshot — the same integer index is used everywhere that staff member appears — but tokens are not persistent across snapshots. Project names, labor categories, bill rates, cost rates, hours per week, and financial figures are transmitted without modification. Only `parseIntent()` in `server/ai.ts` calls `buildAnonymizedContextSnapshot()`; it does not query the database directly. No other code path sends data to an external LLM.

## Threat Model

**What is PII in this context:** The `person_name` field in the `staffing` table. These are real human names associated with employment roles and compensation-adjacent data (bill rate, cost rate, hours). They are the only values in scope for this threat model.

**What is NOT PII in this context:** Project names (`Project Alpha`, `Project Beta`) are operational identifiers, not personal data. Labor category names (`Senior Developer`, `Project Manager`) are role descriptors. Financial figures (bill rates, cost rates, monthly burn, budget) are project-level metrics. Transmitting these to the LLM is necessary for correct intent resolution and does not implicate personal data regulations.

**The threat:** A cloud LLM provider's infrastructure logs inference requests. If person names appear in those requests, they leave the organization's control permanently. In federal, defense, or GDPR-regulated environments, this is a compliance violation. Even outside regulated environments, it is unnecessary data exposure.

**In scope:** Any code path that constructs a prompt sent to a cloud API endpoint.

**Out of scope:** The SQLite database itself (local file, no network exposure), the Ollama inference path (addressed separately below), and the narrative generation path (operates on `ScenarioResult` structs that contain no raw person names).

## Options Considered

### Option A: Send All Data As-Is

Transmit the full database context, including `person_name` values, to the LLM. This requires zero implementation effort and produces the most natural prompt ("J. Smith: Senior Developer, 40h/wk on Project Alpha"). However, it sends PII to a third-party API on every intent-parsing call, violating the principle of data minimization and creating regulatory exposure in any context where employee names are protected. Ruled out.

### Option B: Anonymize All Identifiers (Including Project Names)

Replace both person names and project names with opaque tokens (e.g., `Staff-1`, `Project-A`). This eliminates all identifying information from the prompt. However, it breaks intent parsing. The primary use case for the LLM is interpreting commands like "add a PM to Project Alpha" — if project names are anonymized, the LLM cannot resolve "Project Alpha" to a token, and the structured JSON it returns will not map back to a real project. The anonymization would have to be bidirectional, adding complexity and a new class of mapping bugs. Project names are not PII; anonymizing them sacrifices correctness for no privacy gain. Ruled out.

### Option C: Anonymize Person Names Only, Preserve Project Names and Financials (Chosen)

Replace only `person_name` values with sequential `Staff-N` tokens. Project names, labor categories, rates, and financial figures are transmitted unchanged. This eliminates the PII exposure while preserving all information the LLM needs to parse intent correctly. The LLM does not need to know that Staff-3 is "M. Jones" — it only needs to know that there is a Senior Developer on Project Alpha working 40 hours per week at a given rate. The implementation is straightforward and confined to a single function.

### Option D: Client-Side Anonymization (Browser Strips Names Before Sending to Server)

Strip person names in the browser before the natural-language command is submitted to the Express API. This approach is architecturally unsound: the client is an untrusted boundary. Any future client (CLI, API consumer, test harness) would need to implement the same stripping logic independently. The server cannot verify that the client performed the anonymization correctly. Trust boundaries belong in the server, where they can be enforced uniformly regardless of how the API is called. Ruled out.

## Rationale

Centralizing the anonymization in `buildAnonymizedContextSnapshot()` makes the trust boundary structural rather than conventional. There is no "don't forget to anonymize" comment scattered across multiple call sites — there is one function that owns the construction of LLM context, and it is the only function `parseIntent()` calls for that purpose. Future contributors cannot accidentally bypass it by querying the database directly in an AI route handler, because the pattern is explicit: `parseIntent()` calls `buildAnonymizedContextSnapshot()`, not `getStaffingByProject()`.

Positional tokens (`Staff-1`, `Staff-2`) were chosen over hash-based anonymization (e.g., a truncated HMAC of the name) because readability matters for debugging. When a prompt is logged for troubleshooting, "Staff-1: Senior Developer, 40h/wk" is immediately interpretable. Hash-based tokens like `a3f9c2` carry no semantic information and make audit logs harder to read without sacrificing additional privacy — a hash of a small set of known names is trivially reversible by brute force anyway. Positional tokens are not reversible from the prompt alone, which is sufficient for the threat model.

The constraint that tokens are not persistent across snapshots (re-indexed on each call) is intentional. Persistent tokens could allow correlation of anonymized snapshots over time, partially reconstructing staff membership patterns. Positional re-indexing means each snapshot is self-contained and opaque in isolation.

## Consequences

### Positive
- Person names never appear in cloud LLM provider logs under any normal code path.
- The anonymization boundary is enforced at a single, auditable location (`server/db.ts`, `buildAnonymizedContextSnapshot()`).
- Intent parsing continues to work correctly for all project-name-based commands.
- The approach is compatible with GDPR data minimization principles and federal contractor PII-handling requirements.
- No client-side changes are required; the trust boundary is server-enforced.

### Negative / Tradeoffs
- The LLM cannot parse commands that reference a specific person by name (e.g., "remove J. Smith from Project Alpha"). Such commands must be reformulated as role-based removals ("remove the Senior Developer from Project Alpha"). This is an acceptable UX constraint given the privacy goal.
- Sequential token assignment means the LLM cannot distinguish between two people in the same role on the same project ("Staff-2 and Staff-3 are both Senior Developers on Alpha"). This edge case requires the user to issue two separate remove operations or use count-based removal.
- Token assignment is positional, not deterministic by identity, so two snapshots taken seconds apart may assign different indices to the same person if the query order shifts.

### Constraints Imposed
- `buildAnonymizedContextSnapshot()` must remain the only function used to construct LLM context strings. It must not be bypassed, inlined, or replaced with a raw database query in any route handler or AI utility function.
- No future code change may add `person_name` (or any field derived from it) to the string returned by `buildAnonymizedContextSnapshot()`.
- `AGENTS.md` documents this constraint for AI coding assistants working in the repository.
- Any new LLM integration point (additional routes, batch jobs, background summarizers) must route through `buildAnonymizedContextSnapshot()` or its designated successor and must be reviewed against this decision.

## Airgap Deployment Path

When the `llm_provider` configuration key is set to `ollama`, all inference runs against a local Ollama instance via its OpenAI-compatible endpoint (`http://localhost:11434/v1/chat/completions` by default). In this mode, the anonymized context snapshot never leaves the machine — Ollama executes the model locally, and no data is transmitted to any external API. This is the recommended deployment path for environments that cannot permit any external data transmission, including air-gapped federal systems or organizations without a data-processing agreement with a cloud LLM provider. The anonymization layer still runs in Ollama mode (the same `buildAnonymizedContextSnapshot()` call is used regardless of provider), so switching between providers requires no code changes and leaves no PII gap during transition.

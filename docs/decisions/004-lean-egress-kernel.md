# ADR 004: A Lean 4 Egress Kernel Keeps Real Data Out of Every LLM Call

## Status
Accepted. Replaces the mechanism of [ADR 003](003-pii-anonymization.md), and removes the LLM uses that [ADR 001](001-llm-engine-separation.md) and [ADR 002](002-template-first-narration.md) allowed beyond intent parsing (agent mode and LLM narration).

## Date
2026-09-24

## Context

[ADR 001](001-llm-engine-separation.md) keeps every number in the deterministic engine; the LLM parses intent and may narrate. [ADR 003](003-pii-anonymization.md) protects staff names by building all LLM context in one function, `buildAnonymizedContextSnapshot()`, which swaps each `person_name` for a `Staff-N` token while sending project names, rates, and financial figures as they are. ADR 003 records the result as a guarantee — "No database-sourced person name appears in cloud LLM provider logs under any normal code path" — and rules narration out of scope because a `ScenarioResult` "contain[s] no raw person names".

On 2026-09-24 that guarantee was shown false:

- `applyHoursChange()` (`server/engine/scenarios.ts`, line 185 at `b8100f4`) writes the stored record's `person_name` into `ScenarioResult.warnings` whenever two or more `hours_changes` entries substring-match the same staff record.
- `processToolCalls()` (agent mode, every tool call) and `narrateResult()` (opt-in LLM narration) serialize the whole result into the prompt.
- Reproduced by driving `processToolCalls()` against the seeded in-memory database: tool arguments `hours_changes: [{ person_name: "e" }, { person_name: "n" }]` for Project Alpha returned `Multiple hours changes matched "K. Chen"` to a model that had only ever been shown `Staff-N` tokens.
- In agent mode the model chooses those arguments, so pairs of letters enumerate the roster within `MAX_ITERATIONS = 8`, including under prompt injection. A security review rated this critical; its sweep of every other result field, tool error, and telemetry path found no second path.

The line is easy to fix; the cause is structural. ADR 003's guarantee was a convention — build all context in one function — enforced by review. The leak entered through a warning string three calls away from that function, on a path the ADR had ruled out of scope, and the tests pinned behaviour rather than the property.

The requirement is now stronger than ADR 003's: **no staff name, no dollar amount, and no other data from FSE's database may appear in any LLM request, whether the model runs locally or in the cloud — and this must be proved, not reviewed.**

## Decision

### One Lean module builds every LLM request

FSE makes exactly one kind of LLM call: intent parsing. Its request is built by the **egress kernel**, a Lean 4 program in `egress/`. TypeScript no longer assembles prompt text. It gives the kernel the user's question, the model settings, and a lexicon of every name FSE stores — staff names, project names, and labor category (role) names — and sends exactly what the kernel returns.

The kernel:

1. Splits the question into words, numbers, and separators.
2. Replaces every number — digits with any currency sign, thousands separators, decimals, `k`/`M`/`B` suffix, or `%` — with a typed placeholder: `«USD:a»`, `«PCT:a»`, or `«NUM:a»`.
3. Replaces every word that belongs to a stored name with a typed placeholder: `«S:a»` for staff, `«P:a»` for projects, `«R:a»` for roles. For staff names this is every word of two or more letters. For project and role names it is every distinctive word, or every word when a name has no distinctive word, so no stored name can survive in full.
4. Builds the request body from the fixed prompt (whose examples use placeholders), the model settings, and the masked question. Nothing else goes in: no project list, no staffing, no rate card, no results.
5. Returns the placeholder map, which never leaves the machine: each placeholder with the text it replaced, the canonical project or role name when the match is unique, and the parsed value for numbers. TypeScript uses it to put the real values back into the model's JSON answer before the engine runs, and the engine resolves them as it already does (fuzzy project and role matching, substring person matching).

**The kernel never receives a figure.** Budgets, spend, rates, hours, and results do not cross into it, so no proof has to spot them.

### What Lean proves

Every theorem holds for every input, lives in `egress/`, and is checked on every build:

1. **Only the masked question can vary the request.** The request body is a function of the model settings and the masked question alone. Two lexicons that produce the same masked question produce byte-identical bodies, so the stored names influence the request only by what was masked away.
2. **No digit from the question survives.** The masked question contains no digit characters; placeholder labels use letters.
3. **No stored name survives.** No word left in the masked question is a masked word of any stored name (compared case-insensitively). Every stored name has at least one masked word, so no stored name can appear in full.
4. **Placeholders are faithful.** Each placeholder in the map restores exactly the text it replaced, and every placeholder in the masked question is in the map.

The build fails if any theorem is missing, uses `sorry`, or depends on an axiom beyond Lean's standard three (`propext`, `Classical.choice`, `Quot.sound`).

### What is not proved, and how it is covered

- **What the user types that is not a stored name or a number.** A misspelling ("Chenn"), a nickname, a name typed with non-Latin-1 letters in a different case, a single initial, or a number written as words ("fifty thousand") passes through. These are the residual gaps. The prompt tells users they never need to type names, and the placeholders do the rest.
- **Over-masking.** A stored name that is also an everyday word ("Will", "Mark", "Grant") is masked wherever it appears, which can confuse a parse. This fails safe.
- **The lexicon is complete.** The encoder (`server/egress.ts`) must pass every stored staff, project, and role name. It reads them directly from the three tables. It is covered by a unit test against the seed data and end to end by the canary test below.
- **The chokepoint.** `chatRequest()` is the only code that sends a chat completion; it sends exactly the kernel's URL and body, with `redirect: "error"` so an endpoint can't forward it elsewhere. Enforced by lint and a test.
- **Lean itself**: its proof checker, compiler, runtime, and standard-library JSON parser.
- **The eval judge.** `server/evals/faithfulness-judge.ts` sends narratives and figures to a judge model by design, so it now refuses to run unless the database is the in-memory sample data (`DB_PATH=":memory:"`). It is eval tooling, never imported by the server, and the one named exemption from the chokepoint rule.

### What goes away

- **Agent mode (V3):** `agenticScenario()`, the `run_scenario` tool loop, and `POST /api/scenario/v3`. It works by showing the model engine results, which are real figures.
- **LLM narration:** `narrateResult()` and the `use_llm_narrative` option. Template narration, already the default under [ADR 002](002-template-first-narration.md), becomes the only narration.
- **The context snapshot:** `buildAnonymizedContextSnapshot()`. The model no longer sees any list of projects, staff, or rates.

`applyHoursChange()` also stops writing stored names into warnings: it echoes the colliding inputs instead. No LLM path can read a warning any more, but engine output that could carry a name is how this started.

### Runtime integration

- `egress/` is a Lake package pinned to Lean v4.34.0, without Mathlib. It builds one executable, `fse-egress`; `npm run build:egress` runs `lake build`.
- The server runs the executable once per LLM request, exchanging JSON over stdin/stdout; process start-up is small next to model latency.
- **No fallback.** If the executable is missing or fails, intent parsing fails closed with a message naming the fix. The engine, template narration, and every non-LLM route keep working without it.
- CI builds the kernel with `leanprover/lean-action@v1` before the test suite.

## Options Considered

### Option A: Fix the line and add a canary test (TypeScript only)
Cheapest, and it closes this leak. It keeps the guarantee a convention checked on sampled inputs, the arrangement that let this leak through, and it does nothing about figures or project names. Rejected as the only defence; its canary test is kept.

### Option B: Prove a Lean model; test that the TypeScript matches it
Rejected. The 2026-09-24 leak lived in the gap between what an author models and what the code does; tests close that gap only on the inputs they generate.

### Option C: Keep agent mode and LLM narration for local models only
The kernel would prove names never reach any model and figures never reach a remote one, while a model on `localhost` still saw figures and results. Rejected: the requirement is no real data in any call, local included.

### Option D: Mask the figures inside results instead of removing agent mode
Rejected. A model cannot reason about scenarios whose numbers are hidden, and anything that would let it — which option is cheaper, by roughly how much — is itself derived from the real figures.

### Option E: Type-level taint in TypeScript
Wrapping `person_name` in a type whose `toString()` and `toJSON()` redact is cheap hygiene, but `as` casts and `any` defeat it, and it says nothing about figures. It may be added later as defence in depth.

### Option F: Network controls only
Firewall rules or a local-only deployment ([ADR 003](003-pii-anonymization.md)'s airgap path) keep bytes on the machine with no code, but they are an operator setting, not a product property, and they do not stop real data reaching a local model. Recommended alongside this decision, not instead of it.

### Option G: A Lean kernel that builds every request and never receives figures (chosen)
The proofs are about the code that runs, and the property holds structurally: the only real data the kernel sees is the lexicon it masks with.

## Consequences

### Positive
- The model never sees a stored name, a figure from the database, or a digit from the question — proved, local or cloud.
- The sinks the 2026-09-24 leak used are gone, and the property that would have caught it is a theorem.
- ADR 001's principle becomes literal: the LLM parses intent and does nothing else.

### Negative / Tradeoffs
- **Agent mode and LLM narration are removed.**
- **Parsing sees placeholders.** Questions that depend on the model knowing the data ("cut staff on the project burning fastest") no longer resolve. Role words are masked too, which removes some semantic help. The live-model intent eval must be re-baselined.
- **Residual gaps and over-masking**, listed above.
- **A new toolchain.** Intent parsing and the egress tests need elan and a Lean build (a ~590 MB toolchain download, once), and CI gains a Lean build step.
- **Two languages.** Prompt changes now happen in `egress/prompts/` and re-run the proofs.

### Constraints Imposed
- Only the kernel builds LLM request bodies; no TypeScript assembles prompt text.
- A new LLM feature needs a new kernel request kind and theorems to match. A feature that must show a model real data does not ship.
- No `sorry`, and no axioms beyond the standard three.
- The eval judge runs on sample data only.

## Verification
- `lake build` in `egress/` checks every theorem, and `#guard_msgs` pins each theorem's axiom list, so a `sorry` fails the build.
- `server/__tests__/egress.test.ts` covers the lexicon encoder, a kernel round trip, and restoration of placeholders into operations.
- `server/__tests__/llm-noninterference.test.ts` builds two in-memory databases that differ only in names and figures (canary values), asks the same questions through a `fetch` stub, and asserts that the captured request bodies are byte-identical and contain no canary name or figure.
- The 2026-09-24 reproduction is a named regression test: a stored name no longer appears in the engine's warnings. It is shown to fail on the code before the fix.

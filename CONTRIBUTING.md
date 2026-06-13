# Contributing to Financial Scenario Engine

Financial Scenario Engine is a full-stack TypeScript application; contributions should follow the existing code style, keep CI green, and add or update tests alongside any change.

---

## Development Provenance & Verification

This repository is built solo with AI-assisted tooling. Because there is no second human reviewer, correctness is gated by **automated evidence**, not peer sign-off:

- **CI gates (every push / PR):** ESLint, `typecheck:server`, `typecheck:client`, `test:coverage` (Vitest), Playwright E2E, CodeQL, and dependency-review. Merges block on a red pipeline.
- **Behavioral verification:** the intent-parse eval harness (`server/evals/`) imports the production prompt and scores field-level accuracy; the corpus structure is validated in CI without a live API key.
- **Provenance:** AI-assisted changes are verified against these gates before merge; the CI and evaluation output is the verification artifact of record.

Contributions are welcome via PR; CI must pass and changes should add or update tests.

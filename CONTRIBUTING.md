# Contributing to Financial Scenario Engine

Financial Scenario Engine is a full-stack TypeScript application. Contributions should follow the existing code style, keep CI green, and add or update tests alongside any change.

---

## Development Provenance & Verification

This repository is built solo with AI-assisted tooling (see [`CONTRIBUTORS.md`](CONTRIBUTORS.md)). Because there is no second human reviewer, correctness is gated by **automated evidence**, not peer sign-off:

- **CI gates (every push / PR):** ESLint, `typecheck:server`, `typecheck:client`, `test:coverage` (Vitest), Playwright E2E, CodeQL, and dependency-review. Merges block on a red pipeline.
- **Behavioral verification:** ordinary tests can't tell you whether the model still reads a question correctly, so a separate eval harness (`server/evals/`) measures that. It imports the production prompt directly and grades the model's output, field by field, against labeled examples. The corpus's own structure is validated in CI with no API key needed; scoring against a live model runs on its own schedule — see the README's "Intent-parsing evals".

The CI and evaluation output is the verification artifact of record for any change, AI-assisted or not. Contributions are welcome via PR. CI must pass, and changes should add or update tests.

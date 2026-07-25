---
layout: home
title: Financial Scenario Engine
---

<div class="console-hero">
  <img class="console-hero__image" src="/console-ds/assets/hero-cinematic.jpg" alt="" />
  <div class="console-hero__scrim"></div>
  <div class="console-hero__content">
    <div class="console-hero__eyebrow">L3 · APPLIED</div>
    <h1 class="console-hero__title">Financial Scenario Engine</h1>
    <p class="console-hero__blurb">
      Deterministic TypeScript engine. The LLM only parses intent and
      narrates — never in the critical path.
    </p>
    <div class="console-hero__actions">
      <a class="console-hero__btn console-hero__btn--primary" href="/financial-scenario-engine/guide/getting-started">
        Read the docs
      </a>
      <a class="console-hero__btn console-hero__btn--secondary" href="https://github.com/tafreeman/financial-scenario-engine" target="_blank" rel="noreferrer">
        View on GitHub
      </a>
    </div>
    <a class="console-hero__portfolio-link" href="https://tafreeman.github.io/tafreeman/" target="_blank" rel="noreferrer">
      part of the Console portfolio →
    </a>
  </div>
</div>

<div class="console-horizon-rule"></div>

<div class="vp-doc" style="max-width: 992px; margin: 0 auto; padding: 0 32px 96px;">

## What it is

`server/engine/` is a pure TypeScript engine computing labor costs, margins,
burn rates, EVM, and staffing scenarios.

- **Deterministic core** — same inputs, same outputs, every time. Covered by
  the Vitest unit suites under `server/`; the Playwright specs under `tests/`
  exercise the app around it, not the engine itself.
- **The language model sits at the boundary, not inside it** — it reads your
  question and writes the summary, and never computes a figure: every number
  in a result comes from the engine. The structured output it returns is
  re-checked against a Zod schema (`scenarioOperationSchema`) before the
  engine runs.
- **Local-first** — all project data lives in a single local SQLite file
  (`data/finimpact.db`); no telemetry, no analytics.
- **Portable** — runs on Node.js, ships a Windows launcher, no cloud hosting
  required.

</div>

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

Every financial number comes from a pure, fully-tested TypeScript calculation
engine in `server/engine/` — labor costs, margins, burn rates, EVM, staffing
scenarios. Same inputs, same outputs, every time. The optional LLM layer sits
at the interface boundary: it parses natural-language queries into structured
operations on the way in, and can narrate results in prose on the way out —
it never computes a financial figure itself, and every structured response it
returns is revalidated against a strict schema before the engine trusts it.

- **Deterministic core** — the engine in `server/engine/` produces every
  number; covered by 29 test files under `tests/` and `server/`.
- **LLM at the boundary, not in it** — intent parsing and narration only;
  structured LLM output is revalidated against a Zod schema
  (`scenarioOperationSchema`) before the engine runs.
- **Local-first** — all project data lives in a single local SQLite file
  (`data/finimpact.db`); no telemetry, no analytics.
- **Portable** — runs on Node.js, ships a Windows launcher, no cloud hosting
  required.

</div>

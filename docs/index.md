---
layout: home

hero:
  name: Financial Impact Analyzer
  text: Deterministic Engine · Optional AI
  tagline: A portable, browser-based project financial analysis tool with a deterministic TypeScript calculation engine and an optional LLM layer for natural-language scenario queries.
  image:
    src: /logo.svg
    alt: Financial Impact Analyzer
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: API Reference
      link: /api/
    - theme: alt
      text: View on GitHub
      link: https://github.com/tafreeman/fin-impact-tool

features:
  - icon: ⚡
    title: Deterministic Engine
    details: Pure TypeScript calculation engine — labor costs, margins, burn rates, EVM, and staffing scenarios. Same inputs always produce the same outputs.
  - icon: 🤖
    title: Optional AI Layer
    details: LLM parses natural-language queries into structured operations. The AI never touches financial numbers — the engine does all the math.
  - icon: 🔒
    title: Privacy First
    details: All data in local SQLite. Person names anonymized before any cloud LLM call. No telemetry, no analytics, no external dependencies beyond your chosen LLM provider.
  - icon: 📊
    title: Full EVM Suite
    details: CPI, SPI, CV, SV, four EAC variants, ETC, VAC, TCPI — all computed deterministically from project data.
  - icon: 🔄
    title: What-If Scenarios
    details: Swap staff, change rates, extend timelines, inject costs — see before/after impact on margins, burn rates, and budgets instantly.
  - icon: 📦
    title: Portable & Self-Contained
    details: Runs locally on Node.js. Single SQLite file. Windows launcher included. No cloud hosting required.
---

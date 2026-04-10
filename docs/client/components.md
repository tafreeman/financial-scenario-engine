# Components

Detailed reference for each React component in the client application.

## `App.tsx` — Application Shell

The root component that renders the header, tab bar, and active content panel.

**Tabs:** Dashboard · AI Analyst · Staffing · Settings

The header features the app logo with the emerald/navy brand palette and the subtitle *"Local + Cloud AI · Portable Edition"*.

---

## `Dashboard.tsx` — Budget Overview

Fetches from `GET /api/dashboard` and displays:

- **Summary stat cards** — Total budget, spent, remaining, monthly burn
- **Blended margin** — Margin percentage and monthly revenue
- **Headcount** — Total active staff
- **Per-project cards** — Individual project cards with burn rate progress bars

Each project card shows:
- Project name and status
- Budget vs. spent with visual progress bar
- Monthly burn rate
- Months remaining before budget exhaustion

---

## `Chat.tsx` — AI Scenario Interface

Posts natural-language queries to `POST /api/scenario/v3` and renders results.

**Features:**
- Text input with submit button
- Quick-query chips for common scenarios:
  - *"Flag projects exhausting budget within 3 months"*
  - *"Show portfolio margin analysis"*
  - *"What if we add a Senior Dev to Alpha?"*
- Markdown narrative rendering via `react-markdown`
- Expandable scenario accordions with `ScenarioCards`
- Query history sidebar from `GET /api/scenarios`

---

## `ScenarioCards.tsx` — Structured Result Display

Renders a `ScenarioResult` with structured UI cards:

| Section | When shown |
|---------|-----------|
| Warning banners | Always (if `warnings` non-empty) |
| Impact delta cards | Mutation scenarios (`impact` present) |
| Before/after tables | Mutation scenarios (`current` + `projected`) |
| Current-state summary | Analysis-only results |
| Portfolio summaries | Multi-project results (`portfolio` present) |

---

## `StaffingView.tsx` — Staffing CRUD

Two-panel layout:

### Panel 1: Staffing Table
- Lists all staffing assignments grouped by project
- Add new assignment form (project, role, person name, hours/week)
- Deactivate button per row

### Panel 2: Rate Card
- Read-only table of labor categories with bill/cost rates
- Fetched from `GET /api/rates`

---

## `SettingsPanel.tsx` — Configuration

| Control | Description |
|---------|-------------|
| LLM Provider toggle | Switch between `github` and `ollama` |
| GitHub PAT input | Enter/save with masked display |
| Model selection | Change the active model name |
| Ollama endpoint | Configure local Ollama URL |
| Connection test button | Verify the configured provider works |

All settings saved via `PUT /api/config`.

# Frontend — React Client

React 19 + Vite + Tailwind CSS single-page application. Served as static files from the Express server in production; runs on `http://localhost:5173` in development (proxied to the API server at `:3000`).

## Quick Start

```bash
# From repo root (installs both root and client deps)
npm run install:all

# Development (hot reload)
npm run dev
# → API server: http://localhost:3000
# → Client dev: http://localhost:5173  (proxies /api → :3000)

# Production build (output goes to client/dist/, served by Express)
npm run build
```

## Project Structure

```
client/
├── index.html           # HTML entry point
├── package.json         # Client-only dependencies
├── vite.config.ts       # Vite config with API proxy
├── tailwind.config.js   # Tailwind theme (custom navy/steel palette)
├── postcss.config.js    # PostCSS (Tailwind + Autoprefixer)
├── tsconfig.json        # TypeScript config
└── src/
    ├── main.tsx         # React root mount
    ├── index.css        # Tailwind base styles
    ├── App.tsx          # Shell: header + tab navigation
    ├── api.ts           # Typed fetch client (all API calls)
    ├── format.ts        # Number/currency formatting helpers
    └── components/
        ├── Dashboard.tsx     # Budget overview, stat cards, project list
        ├── Chat.tsx          # AI scenario query interface + history
        ├── ScenarioCards.tsx # Structured display of ScenarioResult
        ├── StaffingView.tsx  # Staffing CRUD table + labor rate card
        └── SettingsPanel.tsx # PAT entry, model selection, provider toggle
```

## Components

### `App.tsx`

Application shell. Renders the header and tab bar. Controls which component is active.

**Tabs:** Dashboard · AI Analyst · Staffing · Settings

---

### `Dashboard.tsx`

Portfolio-level overview fetched from `GET /api/dashboard`.

Displays:
- Total budget / spent / remaining / monthly burn
- Blended margin % and monthly revenue
- Headcount
- Per-project cards with burn rate progress bars

---

### `Chat.tsx`

AI scenario interface. Posts natural-language queries to `POST /api/scenario/v2`.

Features:
- Query input with submit
- Renders AI narrative (markdown)
- Expandable engine result detail via `ScenarioCards`
- Query history sidebar (from `GET /api/scenarios`)

---

### `ScenarioCards.tsx`

Renders a structured `ScenarioResult` as tabbed metric cards:
- Current state (labor, margin, budget)
- Projected state (for mutation scenarios)
- Impact deltas with color-coded arrows
- Warnings banner
- EVM metrics (when present)

---

### `StaffingView.tsx`

Two-panel view:
1. **Staffing table** — per-project staffing assignments with add/deactivate
2. **Rate card** — labor category bill/cost rates

CRUD via `POST /api/staffing`, `DELETE /api/staffing/:id`, `GET /api/rates`.

---

### `SettingsPanel.tsx`

Configuration management:
- **LLM Provider** — switch between `github` (GitHub Models API) and `ollama` (local)
- **GitHub PAT** — enter/save with masked display
- **Model selection** — change the active model name
- **Ollama endpoint** — configure local Ollama URL
- **Connection test** — verify the configured provider works

Saves to `PUT /api/config`.

---

## `api.ts` — Typed Fetch Client

All HTTP calls go through `api.ts`. Each function maps to one API endpoint and returns a typed response. Functions throw on non-OK responses.

Key functions:

| Function | Endpoint | Description |
|----------|----------|-------------|
| `getDashboard()` | `GET /api/dashboard` | Portfolio summary |
| `getProjects()` | `GET /api/projects` | Project list |
| `addProject(data)` | `POST /api/projects` | Create project |
| `updateProject(id, data)` | `PATCH /api/projects/:id` | Update project |
| `getStaffing(projectId?)` | `GET /api/staffing` | Staffing list |
| `addStaffing(data)` | `POST /api/staffing` | Add assignment |
| `removeStaffing(id)` | `DELETE /api/staffing/:id` | Deactivate assignment |
| `getRates()` | `GET /api/rates` | Rate card |
| `runScenario(query, opts)` | `POST /api/scenario/v2` | Run AI scenario |
| `getScenarios()` | `GET /api/scenarios` | Query history |
| `getConfig()` | `GET /api/config` | Config (PAT masked) |
| `updateConfig(data)` | `PUT /api/config` | Update config |

---

## `format.ts` — Formatting Helpers

Shared formatting utilities used by Dashboard and ScenarioCards:

- `formatCurrency(n)` — `$1,234,567`
- `formatPct(n)` — `24.5%`
- `formatDelta(n)` — `+$1,234` or `-$1,234`

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| react | ^19.0.0 | UI framework |
| react-dom | ^19.0.0 | DOM renderer |
| react-markdown | ^9.0.3 | Render AI narrative markdown |
| lucide-react | ^0.468.0 | Icon set |
| tailwindcss | ^3.4.17 | Utility CSS |
| vite | ^6.0.0 | Build tool + dev server |
| typescript | ^5.7.0 | Type safety |

## Vite Dev Proxy

`vite.config.ts` proxies all `/api` requests to the Express server:

```typescript
proxy: {
  "/api": "http://localhost:3000"
}
```

This allows the client dev server to call the API without CORS issues during development.

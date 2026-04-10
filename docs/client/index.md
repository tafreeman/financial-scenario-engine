# Frontend — React Client

React 19 + Vite + Tailwind CSS single-page application. Served as static files from Express in production; runs on `http://localhost:5173` in development with API proxy.

## Project Structure

```
client/
├── index.html           HTML entry point
├── package.json         Client-only dependencies
├── vite.config.ts       Vite config with API proxy
├── tailwind.config.js   Tailwind theme (custom navy/steel palette)
├── postcss.config.js    PostCSS (Tailwind + Autoprefixer)
├── tsconfig.json        TypeScript config
└── src/
    ├── main.tsx         React root mount
    ├── index.css        Tailwind base styles
    ├── App.tsx          Shell: header + tab navigation
    ├── api.ts           Typed fetch client (all API calls)
    ├── format.ts        Number/currency formatting helpers
    └── components/
        ├── Dashboard.tsx     Budget overview, stat cards, project list
        ├── Chat.tsx          AI scenario query interface + history
        ├── ScenarioCards.tsx  Structured display of ScenarioResult
        ├── StaffingView.tsx   Staffing CRUD table + labor rate card
        └── SettingsPanel.tsx  PAT entry, model selection, provider toggle
```

## Tabs

| Tab | Component | Description |
|-----|-----------|-------------|
| **Dashboard** | `Dashboard.tsx` | Portfolio-level overview — budget, spent, remaining, burn rate, per-project cards |
| **AI Analyst** | `Chat.tsx` | Natural-language scenario interface — quick chips, markdown narrative, expandable results |
| **Staffing** | `StaffingView.tsx` | Two-panel view — staffing CRUD + rate card |
| **Settings** | `SettingsPanel.tsx` | LLM provider toggle, PAT entry, model selection, connection test |

## Typed Fetch Client (`api.ts`)

All HTTP calls go through `api.ts`. Each function maps to one API endpoint and returns a typed response.

| Function | Endpoint | Description |
|----------|----------|-------------|
| `getDashboard()` | `GET /api/dashboard` | Portfolio summary |
| `getProjects()` | `GET /api/projects` | Project list |
| `addProject(data)` | `POST /api/projects` | Create project |
| `getStaffing(projectId?)` | `GET /api/staffing` | Staffing list |
| `addStaffing(data)` | `POST /api/staffing` | Add assignment |
| `removeStaffing(id)` | `DELETE /api/staffing/:id` | Deactivate assignment |
| `getRates()` | `GET /api/rates` | Rate card |
| `runScenarioV2(query, skip?)` | `POST /api/scenario/v2` | Run deterministic scenario |
| `runScenarioV3(query)` | `POST /api/scenario/v3` | Run agentic scenario |
| `getScenarios()` | `GET /api/scenarios` | Query history |
| `getConfig()` | `GET /api/config` | Config (PAT masked) |
| `updateConfig(data)` | `PUT /api/config` | Update config |

## Formatting Helpers (`format.ts`)

| Helper | Output example |
|--------|---------------|
| `formatCurrency(1234567)` | `$1,234,567` |
| `formatPct(24.5)` | `24.5%` |
| `formatDelta(1234)` | `+$1,234` |
| `formatDelta(-1234)` | `-$1,234` |

## Vite Dev Proxy

`vite.config.ts` proxies `/api` requests to the Express server:

```typescript
proxy: {
  "/api": "http://localhost:3000"
}
```

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `react` | ^19.0.0 | UI framework |
| `react-dom` | ^19.0.0 | DOM renderer |
| `react-markdown` | ^9.0.3 | Render AI narrative markdown |
| `lucide-react` | ^0.468.0 | Icon set |
| `tailwindcss` | ^3.4.17 | Utility CSS |
| `vite` | ^6.0.0 | Build tool + dev server |
| `typescript` | ^5.7.0 | Type safety |

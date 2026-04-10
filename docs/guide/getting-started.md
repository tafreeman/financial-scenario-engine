# Getting Started

## Prerequisites

- **Node.js 18+** — [download](https://nodejs.org/)
- **Optional:** GitHub PAT with `models:read` scope for the GitHub Models provider — [create one](https://github.com/settings/tokens?type=beta)
- **Optional:** [Ollama](https://ollama.ai/) for fully local inference

## Installation

### Option A: Double-click (Windows — easiest)

1. Double-click `start.bat`
2. First run installs dependencies and builds (~2 min)
3. Browser opens to `http://localhost:3000`
4. Go to **Settings → choose GitHub Models or Ollama**
5. If using GitHub Models, paste your PAT and save

### Option B: Manual

```bash
npm run install:all
npm run build
npm start
```

### Option C: Development (hot reload)

```bash
npm run install:all
npm run dev
# Server: http://localhost:3000
# Client dev: http://localhost:5173 (proxies /api to :3000)
```

## Sample Data

On first run, the app seeds the SQLite database with sample data:

| Project | Budget |
|---------|--------|
| Alpha | $1,250,000 |
| Beta | $2,100,000 |
| Gamma | $680,000 |

Plus **8 labor categories** with bill/cost rates and **8 staffing assignments** across projects.

Delete `data/finimpact.db` to reset to sample data — it's auto-recreated on startup.

## What You Can Do

Once running, the app provides four tabs:

| Tab | What it does |
|-----|-------------|
| **Dashboard** | Portfolio-level budget overview, stat cards, per-project burn rate bars |
| **AI Analyst** | Ask natural-language questions — swap staff, check burn rates, compare margins |
| **Staffing** | CRUD staffing assignments + view labor rate card |
| **Settings** | Configure LLM provider, PAT, model selection, Ollama endpoint |

### Example Queries

Try these in the AI Analyst tab:

- *"What if we swap the Senior Dev for two Mid-level Devs on Project Alpha?"*
- *"Flag projects that will exhaust budget within 3 months"*
- *"Compare original bid against current actuals for Beta"*
- *"Which labor categories are dragging margin down?"*

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Runtime | Node.js 18+ | Portable, no compilation step |
| Server | Express + TypeScript | Minimal, well-known |
| Database | SQLite (better-sqlite3) | Zero-config, single file, portable |
| AI (cloud) | GitHub Models API | Multi-model, PAT auth |
| AI (local) | Ollama | Fully offline alternative |
| Calc Engine | Pure TypeScript | Deterministic, fully tested |
| Frontend | React 19 + Vite + Tailwind | Fast dev, small bundle |

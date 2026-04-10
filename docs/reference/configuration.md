# Configuration

## LLM Provider Setup

### GitHub Models API (Cloud)

1. Create a GitHub PAT with `models:read` scope at [github.com/settings/tokens](https://github.com/settings/tokens?type=beta)
2. Open the app → **Settings** tab
3. Select **GitHub Models** as provider
4. Paste your PAT and click **Save**
5. Click **Test Connection** to verify

### Ollama (Local)

1. Install [Ollama](https://ollama.ai/)
2. Pull a model: `ollama pull llama3.2`
3. Open the app → **Settings** tab
4. Select **Ollama** as provider
5. Confirm endpoint is `http://localhost:11434`
6. Click **Test Connection** to verify

### Default Models

| Provider | Default model |
|----------|--------------|
| GitHub Models | `openai/gpt-4.1` |
| Ollama | `llama3.2` |

## Database

All data lives in `data/finimpact.db` — a single SQLite file.

| Action | How |
|--------|-----|
| **Back up** | Copy `data/finimpact.db` |
| **Reset to sample data** | Delete the `.db` file — auto-recreated on startup |
| **View/edit data** | Use any SQLite client (e.g., DB Browser for SQLite) |

### Tables

| Table | Purpose |
|-------|---------|
| `projects` | Project budgets, dates, status |
| `labor_categories` | Bill/cost rate card |
| `staffing` | Per-person assignments |
| `scenarios` | Query history log |
| `config` | App configuration |

## Adding Labor Categories

Insert directly into SQLite:

::: code-group

```sql [SQL]
INSERT INTO labor_categories (name, bill_rate, cost_rate)
VALUES ('Data Engineer', 205, 155);
```

```bash [Command line]
sqlite3 data/finimpact.db \
  "INSERT INTO labor_categories (name, bill_rate, cost_rate) VALUES ('Data Engineer', 205, 155);"
```

:::

## Changing AI Behavior

Edit the prompt constants in `server/ai.ts`:

| Constant | Controls |
|----------|----------|
| `PARSE_INTENT_PROMPT` | How the LLM parses natural-language queries into `ScenarioOperation` JSON |
| `NARRATE_PROMPT` | How the LLM narrates engine results |
| `AGENTIC_SYSTEM_PROMPT` | How the V3 agentic analysis behaves |

## Connecting Real Data

Replace the seed data in `server/db.ts` → `seedSampleData()` with actual project/staffing data, or build an import pipeline from your GPS Pricing workbook.

::: warning Seed Data & Tests
Changing `seedSampleData()` may break E2E tests that have hardcoded assertions against sample values.
:::

## Environment Variables

The app reads configuration from the SQLite `config` table, not environment variables. However, the server port can be changed:

```bash
PORT=4000 npm start
```

Default: `3000` (production), `3100` (Playwright E2E).

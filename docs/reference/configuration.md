# Configuration

## LLM Provider Setup

### GitHub Models API (Cloud)

1. Create a GitHub PAT with `models:read` scope at [github.com/settings/tokens](https://github.com/settings/tokens?type=beta)
2. Open the app → **Settings** tab
3. Select **GitHub Models** as provider
4. Paste your PAT and click **Save**
5. Click **Test Connection** to verify

### OpenRouter (Cloud)

GitHub Models is fully retired 2026-07-30 — OpenRouter is the recommended cloud replacement. The Settings tab does not have a provider picker for it yet, so configure it via the config API directly:

1. Create an API key at [openrouter.ai](https://openrouter.ai/)
2. `PUT /api/config` with `{"llm_provider": "openrouter", "openrouter_api_key": "<your key>"}` (requires the `x-app-token` header — see `server/auth.ts`), or set the `OPENROUTER_API_KEY` environment variable and `llm_provider=openrouter` in the config table directly
3. The default model is a `:free` (no-charge) model — browse the current free catalog at `GET https://openrouter.ai/api/v1/models`

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
| OpenRouter | `nvidia/nemotron-3-ultra-550b-a55b:free` |
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

Replace the seed data in `server/db.ts` → `seedSampleData()` with actual project/staffing data, or build an import pipeline from your staffing/pricing workbook.

::: warning Seed Data & Tests
Changing `seedSampleData()` may break E2E tests that have hardcoded assertions against sample values.
:::

## Environment Variables

Two kinds of settings, two places to put them:

- **LLM provider settings** — provider, model, endpoint, credentials — live in the SQLite `config` table. Edit them in the Settings tab or through `PUT /api/config`; they persist across restarts.
- **Deployment settings** come from environment variables.

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Server port | `3000` (`3100` under Playwright E2E) |
| `HOST` | Bind address | `127.0.0.1` |
| `DB_PATH` | SQLite file location | `data/finimpact.db` |
| `CORS_ORIGIN` | Browser origin allowed to call the API when hosted or behind a proxy | Vite dev origins only |
| `TRUST_PROXY_HOPS` | How many reverse proxies sit in front of this process | `0` |
| `APP_API_TOKEN` | Shared secret for the `x-app-token` header on mutating routes | auto-generated at startup and printed once to the console |

```bash
PORT=4000 npm start
```

Two provider credentials can also be supplied by environment variable as a fallback when the config table holds no value: `GITHUB_TOKEN` and `OPENROUTER_API_KEY`.

::: warning Deploying beyond localhost
`CORS_ORIGIN` and `TRUST_PROXY_HOPS` both need attention before you put this behind a reverse proxy — leaving `TRUST_PROXY_HOPS` wrong collapses every client into one rate-limit bucket. See the root README's Security section for the full reasoning.
:::

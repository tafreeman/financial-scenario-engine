# Security

## Data Privacy

- **Local storage only** — All project data lives in a local SQLite file (`data/finimpact.db`)
- **No telemetry** — No analytics, tracking, or external data collection
- **No cloud dependency** — The app runs fully offline (except when using a cloud LLM provider)

## LLM Privacy

When using the GitHub Models API (cloud provider):

- **Anonymized context** — `buildAnonymizedContextSnapshot()` replaces person names with `Staff-N` before any cloud call
- **Preserved data** — Project names, role names, and financial figures are sent to the LLM (needed for accurate analysis)
- **PAT security** — The GitHub PAT is stored only in local SQLite, never logged, never cached externally
- **TLS encryption** — PAT transmitted exclusively to `models.github.ai` over HTTPS

### What gets sent to the LLM

| Data | Sent? | Notes |
|------|-------|-------|
| Person names | ❌ | Replaced with `Staff-1`, `Staff-2`, etc. |
| Project names | ✅ | Needed for project resolution |
| Role/category names | ✅ | Needed for staffing analysis |
| Financial figures | ✅ | Needed for accurate calculations |
| Your PAT | ✅ | Auth header to GitHub Models only |

### Ollama (local) mode

When using Ollama, all inference happens on your local machine:
- No data leaves the device
- No PAT required
- No network calls for AI processing

## Network Access

| Destination | When | Purpose |
|-------------|------|---------|
| `models.github.ai` | GitHub provider selected | LLM inference |
| `localhost:11434` | Ollama provider selected | Local LLM inference |
| None | App itself | Server binds to localhost only |

## Recommendations for Sensitive Environments

1. **Use Ollama** for fully airgapped operation
2. **Verify data classification** before using GitHub Models API in federal environments
3. **Back up** `data/finimpact.db` — it contains all project data
4. **Do not expose** the server to external networks (it binds to localhost by default)

::: danger Do Not Modify
`buildAnonymizedContextSnapshot()` in `server/db.ts` is **privacy-critical**. Do not modify it in a way that could leak real person names to external APIs.
:::

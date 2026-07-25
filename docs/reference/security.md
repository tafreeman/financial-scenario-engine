# Security

## Data Privacy

- **Local storage only** — All project data lives in a local SQLite file (`data/finimpact.db`)
- **No telemetry** — No analytics, tracking, or external data collection
- **No cloud dependency** — The app runs fully offline (except when using a cloud LLM provider)

## LLM Privacy

The app uses one LLM provider at a time. Your choice decides whether anything leaves the machine: the two cloud providers send a context snapshot to a third party, and Ollama does not.

Whichever provider you pick, person names are redacted first — `buildAnonymizedContextSnapshot()` replaces them with `Staff-1`, `Staff-2`, and so on before the snapshot is built. Project names, role names, and financial figures are **not** redacted; the model needs them to resolve a query to the right project and produce accurate analysis.

### GitHub Models (cloud)

- **PAT security** — The GitHub PAT is stored only in local SQLite, never logged, never cached externally. `GET /api/config` returns it masked (first 4 and last 4 characters only)
- **TLS encryption** — PAT transmitted exclusively to `models.github.ai` over HTTPS

### OpenRouter (cloud)

- **API key security** — The OpenRouter API key is stored only in local SQLite, never logged, never cached externally. `GET /api/config` masks it the same way it masks the GitHub PAT (first 4 and last 4 characters only)
- **TLS encryption** — The key is transmitted exclusively to `openrouter.ai` over HTTPS
- **Check your account's data policy before using a free model.** OpenRouter's account privacy settings handle paid and free models differently. Verify your account's training and logging opt-outs before relying on a `:free` model for anything past development. What gets sent is not raw PII — person names are redacted, as above — but it does include real project names, rate cards, and financial figures. See [OpenRouter's privacy & logging docs](https://openrouter.ai/docs/features/privacy-and-logging)

### Ollama (local)

When using Ollama, all inference happens on your local machine:
- No data leaves the device
- No PAT or API key required
- No network calls for AI processing

### What gets sent to the LLM

Applies to both cloud providers (GitHub Models and OpenRouter). Under Ollama, none of this leaves your machine.

| Data | Sent? | Notes |
|------|-------|-------|
| Person names | ❌ | Replaced with `Staff-1`, `Staff-2`, etc. |
| Project names | ✅ | Needed for project resolution |
| Role/category names | ✅ | Needed for staffing analysis |
| Financial figures | ✅ | Needed for accurate calculations |
| Your PAT / API key | ✅ | Auth header to the selected provider only |

## Network Access

| Destination | When | Purpose |
|-------------|------|---------|
| `models.github.ai` | GitHub provider selected | LLM inference |
| `openrouter.ai` | OpenRouter provider selected | LLM inference |
| `localhost:11434` | Ollama provider selected | Local LLM inference |
| None | App itself | Server binds to `127.0.0.1` by default |

## Recommendations for Sensitive Environments

1. **Use Ollama** for fully airgapped operation
2. **Verify data classification** before using either cloud provider (GitHub Models or OpenRouter) in a regulated environment. For OpenRouter, also confirm your account's training/logging opt-outs — see the OpenRouter section above
3. **Back up** `data/finimpact.db` — it contains all project data
4. **Do not expose** the server to external networks (it binds to `127.0.0.1` by default)

::: danger Do Not Modify
`buildAnonymizedContextSnapshot()` in `server/db.ts` is **privacy-critical**. Do not modify it in a way that could leak real person names to external APIs.
:::

# API Reference

The Financial Impact Analyzer exposes a REST API from the Express server. All endpoints return JSON.

## Base URL

::: code-group

```bash [Production]
http://localhost:3000/api
```

```bash [Development]
http://localhost:5173/api  # Vite proxy → :3000
```

:::

## Error Handling

All error responses follow the same shape:

```json
{
  "error": "Human-readable error message"
}
```

With an appropriate HTTP status code (400, 404, 500, etc.).

## Endpoint Summary

| Method | Path | Description |
|--------|------|-------------|
| <span class="http-method http-get">GET</span> | `/api/health` | Health check |
| <span class="http-method http-get">GET</span> | `/api/dashboard` | Summary stats + project list |
| <span class="http-method http-get">GET</span> | `/api/projects` | Projects with burn rate |
| <span class="http-method http-post">POST</span> | `/api/projects` | Add project |
| <span class="http-method http-patch">PATCH</span> | `/api/projects/:id` | Update project |
| <span class="http-method http-get">GET</span> | `/api/staffing` | Staffing list |
| <span class="http-method http-post">POST</span> | `/api/staffing` | Add staffing assignment |
| <span class="http-method http-delete">DELETE</span> | `/api/staffing/:id` | Deactivate staffing |
| <span class="http-method http-get">GET</span> | `/api/rates` | Labor rate card |
| <span class="http-method http-post">POST</span> | `/api/scenario/v2` | Run V2 scenario |
| <span class="http-method http-post">POST</span> | `/api/scenario/v2/parse-only` | Parse intent only |
| <span class="http-method http-post">POST</span> | `/api/scenario/v3` | Run V3 agentic scenario |
| <span class="http-method http-get">GET</span> | `/api/scenarios` | Query history |
| <span class="http-method http-get">GET</span> | `/api/config` | Get config (PAT masked) |
| <span class="http-method http-put">PUT</span> | `/api/config` | Update config |
| <span class="http-method http-post">POST</span> | `/api/import/excel` | Upload Excel workbook (v1) |
| <span class="http-method http-post">POST</span> | `/api/import/excel/v2` | Upload Excel workbook (v2) |

See [Endpoints →](./endpoints) for detailed request/response documentation.

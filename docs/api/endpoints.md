# Endpoints

Detailed request and response documentation for each API endpoint.

## Health

### <span class="http-method http-get">GET</span> `/api/health`

Health check endpoint.

**Response:**
```json
{ "status": "ok" }
```

---

## Dashboard

### <span class="http-method http-get">GET</span> `/api/dashboard`

Returns portfolio-level summary statistics and per-project cards.

**Response:**
```json
{
  "total_budget": 4030000,
  "total_spent": 1250000,
  "total_remaining": 2780000,
  "monthly_burn": 185000,
  "blended_margin_pct": 28.5,
  "monthly_revenue": 258750,
  "headcount": 8,
  "projects": [
    {
      "id": 1,
      "name": "Alpha",
      "total_budget": 1250000,
      "spent_to_date": 450000,
      "monthly_burn": 62500,
      "months_remaining": 12.8,
      "status": "active"
    }
  ]
}
```

---

## Projects

### <span class="http-method http-get">GET</span> `/api/projects`

List all projects with burn rate calculations.

### <span class="http-method http-post">POST</span> `/api/projects`

Create a new project.

**Request body:**
```json
{
  "name": "Delta",
  "total_budget": 500000,
  "spent_to_date": 0,
  "start_date": "2025-01-15",
  "end_date": "2025-12-31",
  "status": "active"
}
```

### <span class="http-method http-patch">PATCH</span> `/api/projects/:id`

Update an existing project. Send only the fields to update.

**Request body:**
```json
{
  "spent_to_date": 75000,
  "status": "active"
}
```

---

## Staffing

### <span class="http-method http-get">GET</span> `/api/staffing`

List staffing assignments. Optionally filter by project.

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `project_id` | `number` | Filter by project ID |

### <span class="http-method http-post">POST</span> `/api/staffing`

Add a staffing assignment.

**Request body:**
```json
{
  "project_id": 1,
  "labor_category_id": 3,
  "person_name": "Jane Smith",
  "hours_per_week": 40
}
```

### <span class="http-method http-delete">DELETE</span> `/api/staffing/:id`

Deactivate a staffing assignment (soft delete — sets `is_active = 0`).

---

## Rates

### <span class="http-method http-get">GET</span> `/api/rates`

Returns the labor category rate card.

**Response:**
```json
[
  {
    "id": 1,
    "name": "Senior Developer",
    "bill_rate": 225,
    "cost_rate": 165
  },
  {
    "id": 2,
    "name": "Mid-level Developer",
    "bill_rate": 175,
    "cost_rate": 120
  }
]
```

---

## Scenarios

### <span class="http-method http-post">POST</span> `/api/scenario/v2`

Run a V2 scenario: LLM intent parsing → deterministic engine → narrative.

**Request body:**
```json
{
  "query": "What if we swap the Senior Dev for two Mid-level Devs on Alpha?"
}
```

**Response** (`V2Response`):
```json
{
  "engine": {
    "operation": { "action": "swap", "project": "Alpha", "..." : "..." },
    "project_name": "Alpha",
    "projects_involved": ["Alpha"],
    "current": { "labor": {}, "margin": {}, "budget": {} },
    "projected": { "labor": {}, "margin": {}, "budget": {} },
    "impact": {
      "cost_delta_monthly": -1950,
      "revenue_delta_monthly": -3250,
      "margin_delta_pct": -2.1,
      "headcount_delta": 1
    },
    "warnings": []
  },
  "narrative": "## Staffing Swap Analysis\n...",
  "model": "openai/gpt-4.1"
}
```

### <span class="http-method http-post">POST</span> `/api/scenario/v2/parse-only`

Parse a natural-language query into a structured `ScenarioOperation` without executing the engine.

**Request body:**
```json
{
  "query": "Add 2 QA Engineers to Beta"
}
```

**Response:**
```json
{
  "operation": {
    "action": "add",
    "project": "Beta",
    "add": [{ "role": "QA Engineer", "count": 2 }]
  }
}
```

### <span class="http-method http-post">POST</span> `/api/scenario/v3`

Run an agentic scenario (V3). The LLM explores multiple scenarios via tool-calling.

**Request body:**
```json
{
  "query": "Compare margin impact of adding a Senior Dev vs two Mid-level Devs to Alpha"
}
```

### <span class="http-method http-get">GET</span> `/api/scenarios`

Retrieve query history (previously run scenarios).

---

## Configuration

### <span class="http-method http-get">GET</span> `/api/config`

Get current configuration. PAT is masked in the response.

**Response:**
```json
{
  "llm_provider": "github",
  "github_pat": "ghp_****...****",
  "model": "openai/gpt-4.1",
  "ollama_endpoint": "http://localhost:11434"
}
```

### <span class="http-method http-put">PUT</span> `/api/config`

Update configuration.

**Request body:**
```json
{
  "llm_provider": "ollama",
  "ollama_endpoint": "http://localhost:11434",
  "model": "llama3.2"
}
```

---

## Excel Import

### <span class="http-method http-post">POST</span> `/api/import/excel`

Upload an Excel workbook for sheet preview (V1).

**Request:** `multipart/form-data` with field `file` containing a `.xlsx` binary.

**Response:**
```json
{
  "sheets": ["Staffing", "Budget", "Rates"],
  "preview": {
    "Staffing": [
      ["project", "role", "person", "hours_per_week"],
      ["Alpha", "Senior Developer", "Person 1", 40]
    ]
  }
}
```

**Limits:**
- Up to **10 sheets** previewed
- Up to **20 rows per sheet**

### <span class="http-method http-post">POST</span> `/api/import/excel/v2`

Same as V1 — V2 is a placeholder for future full-import mapping functionality.

See [Excel Import Module →](/excel/) for implementation details.

# Excel Import Module

Handles `.xlsx` workbook uploads for project/staffing data preview. Located in `server/import/excel/`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| <span class="http-method http-post">POST</span> | `/api/import/excel` | Upload workbook, return sheet preview (V1) |
| <span class="http-method http-post">POST</span> | `/api/import/excel/v2` | Same as V1 (pending differentiation) |

## Request

```
POST /api/import/excel
Content-Type: multipart/form-data

file: <binary .xlsx>
```

## Response

```json
{
  "sheets": ["Staffing", "Budget", "Rates"],
  "preview": {
    "Staffing": [
      ["project", "role", "person", "hours_per_week"],
      ["Alpha", "Senior Developer", "Person 1", 40]
    ],
    "Budget": [
      ["project", "budget", "spent_to_date"],
      ["Alpha", 500000, 180000]
    ]
  }
}
```

**Limits:**
- Up to **10 sheets** previewed (`MAX_PREVIEW_SHEETS`)
- Up to **20 rows per sheet** (`MAX_PREVIEW_ROWS`)

## Module Structure

```
server/import/excel/
├── index.ts              Barrel: exports handlers + shared types
├── shared/
│   ├── types.ts          ExcelImportPreviewResponse, ExcelPreview, ExcelPreviewRow
│   └── parseWorkbook.ts  Core SheetJS parser (shared by V1 and V2)
├── v1/
│   └── handler.ts        handleExcelImportV1
└── v2/
    └── handler.ts        handleExcelImportV2 (currently identical to V1)
```

## Implementation Notes

- Uses **SheetJS** (`xlsx` package) to parse workbooks from an in-memory buffer
- `sheet_to_json({ header: 1 })` returns rows as arrays of raw cell values
- No disk writes — everything parsed in memory
- V2 is a placeholder for future mapping / full-import functionality

## Current Limitations (Phase 1)

::: warning Preview Only
The current implementation is **preview-only**:
- Returns sheet names and row data for inspection
- Does **not** map or import data into the SQLite database
- Full import mapping (matching columns to `projects`/`staffing` tables) is planned for Phase 2
:::

## Tests

Playwright API tests in `tests/e2e/excel/`:

| File | Coverage |
|------|----------|
| `v1.spec.ts` | V1 happy path, no-file-uploaded error |
| `v2.spec.ts` | V2 happy path, no-file-uploaded error |
| `fixtures.ts` | `buildWorkbookBuffer()` helper |

::: code-group

```bash [All E2E tests]
npm run test:e2e
```

```bash [Excel tests only]
npx playwright test tests/e2e/excel/
```

:::

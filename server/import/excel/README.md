# Excel Import Module

Handles `.xlsx` workbook uploads for project/staffing data preview. Lives in `server/import/excel/`.

## Endpoints

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| `POST` | `/api/import/excel` | `handleExcelImportV1` | Upload workbook, return sheet preview |
| `POST` | `/api/import/excel/v2` | `handleExcelImportV2` | Same as V1 (pending differentiation) |

Both endpoints accept a `multipart/form-data` request with a single field named `file` containing a `.xlsx` binary.

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
      ["Alpha", "Senior Developer", "Person 1", 40],
      ...
    ],
    "Budget": [
      ["project", "budget", "spent_to_date"],
      ["Alpha", 500000, 180000],
      ...
    ]
  }
}
```

**Limits:**
- Up to **10 sheets** are previewed (`MAX_PREVIEW_SHEETS`)
- Up to **20 rows per sheet** (`MAX_PREVIEW_ROWS`)

## Module Structure

```
server/import/excel/
├── index.ts              # Barrel: exports handlers + shared types
├── shared/
│   ├── types.ts          # ExcelImportPreviewResponse, ExcelPreview, ExcelPreviewRow
│   └── parseWorkbook.ts  # Core SheetJS parser (shared by V1 and V2)
├── v1/
│   └── handler.ts        # handleExcelImportV1 — validates file, calls parseWorkbook
└── v2/
    └── handler.ts        # handleExcelImportV2 — currently identical to V1 (placeholder)
```

## Implementation Notes

- Uses **SheetJS** (`xlsx` package) to parse workbooks from an in-memory buffer (no disk writes)
- `sheet_to_json({ header: 1 })` returns rows as arrays of raw cell values
- Both V1 and V2 currently share `parseWorkbookPreview()` from `shared/`
- V2 is a placeholder for future mapping / full-import functionality

## Current Limitations (Phase 1)

The current implementation is a **preview-only** feature:
- Returns sheet names and row data for inspection
- Does **not** map or import data into the SQLite database
- Full import mapping (matching columns to `projects`/`staffing` tables) is a planned Phase 2 feature

## Tests

Playwright API tests in `tests/e2e/excel/`:

| File | Coverage |
|------|----------|
| `v1.spec.ts` | V1 happy path, no-file-uploaded error |
| `v2.spec.ts` | V2 happy path, no-file-uploaded error |
| `fixtures.ts` | `buildWorkbookBuffer()` helper (generates test `.xlsx` in memory) |

Run:
```bash
npm run test:e2e
```

Or target just the excel tests:
```bash
npx playwright test tests/e2e/excel/
```

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
│                          #   handleExcelImportV1 is re-exported a second time
│                          #   as handleExcelImportV2 — there is no separate v2
│                          #   handler file (see Implementation Notes below)
├── shared/
│   ├── types.ts          # ExcelImportPreviewResponse, ExcelPreview, ExcelPreviewRow
│   └── parseWorkbook.ts  # Core ExcelJS parser (shared by V1 and V2)
└── v1/
    └── handler.ts        # handleExcelImportV1 — validates file, calls parseWorkbook
```

## Implementation Notes

- Uses **ExcelJS** (`exceljs` package) to parse workbooks from an in-memory buffer via `workbook.xlsx.load(buffer)` (no disk writes)
- Iterates `workbook.worksheets` and reads each sheet with `ws.eachRow({ includeEmpty: true }, ...)`, returning rows as arrays of raw cell values (ExcelJS `row.values` is 1-indexed, so the leading empty slot is dropped)
- **There is no `v2/handler.ts`.** `POST /api/import/excel/v2` is wired (`server/routes.ts`) to `handleExcelImportV2`, which `index.ts` defines as a re-export of `handleExcelImportV1` (`export { handleExcelImportV1 as handleExcelImportV2 } from "./v1/handler.js"`). A previous standalone `v2/handler.ts` placeholder was dead code — nothing imported it, the barrel re-export above is what actually serves the route — and was removed. The route stays live and documented; only the unreferenced file was deleted.
- V2 is a placeholder **route** for future mapping / full-import functionality — differentiating it means adding a real `v2/handler.ts` and pointing the barrel export at it, not resurrecting the deleted placeholder file

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

The Playwright config auto-builds the client and starts the server for you.

Or target just the excel tests:
```bash
npx playwright test tests/e2e/excel/
```

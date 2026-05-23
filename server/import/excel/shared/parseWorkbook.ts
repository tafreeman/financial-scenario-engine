import ExcelJS from "exceljs";
import type { ExcelImportPreviewResponse, ExcelPreview } from "./types.js";

export const MAX_PREVIEW_SHEETS = 10;
export const MAX_PREVIEW_ROWS = 20;

export async function parseWorkbookPreview(buffer: Uint8Array): Promise<ExcelImportPreviewResponse> {
  const workbook = new ExcelJS.Workbook();
  // exceljs types predate generic Buffer<T>; safe at runtime since Buffer is a Uint8Array view
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buffer as any);

  const sheetNames = workbook.worksheets.map((ws) => ws.name);
  const preview: ExcelPreview = {};

  for (const ws of workbook.worksheets.slice(0, MAX_PREVIEW_SHEETS)) {
    const rows: unknown[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      if (rows.length >= MAX_PREVIEW_ROWS) return;
      const values = (row.values as unknown[]).slice(1).map((v) => (v == null ? "" : v));
      rows.push(values);
    });
    preview[ws.name] = rows;
  }

  return { sheets: sheetNames, preview };
}

import * as XLSX from "xlsx";
import type { ExcelImportPreviewResponse, ExcelPreview } from "./types.js";

export const MAX_PREVIEW_SHEETS = 10;
export const MAX_PREVIEW_ROWS = 20;

export function parseWorkbookPreview(buffer: Uint8Array): ExcelImportPreviewResponse {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetNames = workbook.SheetNames;
  const preview: ExcelPreview = {};

  for (const name of sheetNames.slice(0, MAX_PREVIEW_SHEETS)) {
    const sheet = workbook.Sheets[name];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    preview[name] = data.slice(0, MAX_PREVIEW_ROWS).map((row) => (Array.isArray(row) ? row : [row]));
  }

  return { sheets: sheetNames, preview };
}

export type ExcelPreviewRow = unknown[];
export type ExcelPreview = Record<string, ExcelPreviewRow[]>;

export interface ExcelImportPreviewResponse {
  sheets: string[];
  preview: ExcelPreview;
}

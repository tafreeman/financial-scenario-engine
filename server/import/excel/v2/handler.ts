import type { Request, Response } from "express";
import { parseWorkbookPreview } from "../shared/parseWorkbook.js";

export function handleExcelImportV2(req: Request, res: Response) {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  try {
    res.json(parseWorkbookPreview(req.file.buffer));
  } catch (error: any) {
    res.status(400).json({ error: `Failed to parse Excel: ${error.message}` });
  }
}

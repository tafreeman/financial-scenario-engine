import { expect } from "@playwright/test";
import ExcelJS from "exceljs";

export async function buildWorkbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const staffingRows = [
    ["project", "role", "person", "hours_per_week"],
    ...Array.from({ length: 24 }, (_, index) => [
      "Alpha",
      index === 0 ? "Senior Developer" : "Mid Developer",
      `Person ${index + 1}`,
      40,
    ]),
  ];

  const budgetRows = [
    ["project", "budget", "spent_to_date"],
    ["Alpha", 500000, 180000],
    ["Beta", 240000, 90000],
  ];

  const staffingSheet = workbook.addWorksheet("Staffing");
  staffingRows.forEach((row) => staffingSheet.addRow(row));

  const budgetSheet = workbook.addWorksheet("Budget");
  budgetRows.forEach((row) => budgetSheet.addRow(row));

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}

export async function expectExcelPreviewContract(response: {
  ok(): boolean;
  status(): number;
  json(): Promise<{
    sheets: string[];
    preview: Record<string, (string | number)[][]>;
  }>;
}) {
  if (!response.ok()) {
    throw new Error(`Expected successful response but got ${response.status()}`);
  }

  const body = await response.json();
  expect(body.sheets).toEqual(["Staffing", "Budget"]);
  expect(body.preview.Staffing).toHaveLength(20);
  expect(body.preview.Budget).toHaveLength(3);
  expect(body.preview.Staffing[0]).toEqual(["project", "role", "person", "hours_per_week"]);
  expect(body.preview.Staffing[1]).toEqual(["Alpha", "Senior Developer", "Person 1", 40]);
  expect(body.preview.Budget[1]).toEqual(["Alpha", 500000, 180000]);
}

import { expect } from "@playwright/test";
import * as XLSX from "xlsx";

export function buildWorkbookBuffer() {
  const workbook = XLSX.utils.book_new();

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

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(staffingRows), "Staffing");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(budgetRows), "Budget");

  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
}

export async function expectExcelPreviewContract(response: { ok(): boolean; status(): number; json(): Promise<any> }) {
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

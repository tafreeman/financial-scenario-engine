import { expect, test } from "@playwright/test";
import { buildWorkbookBuffer, expectExcelPreviewContract } from "./fixtures";

test.describe("Excel import interface v1", () => {
  test("returns sheet names and previews for uploaded workbooks", async ({ request }) => {
    const response = await request.post("/api/import/excel", {
      multipart: {
        file: {
          name: "financial-impact.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: buildWorkbookBuffer(),
        },
      },
    });

    await expectExcelPreviewContract(response);
  });

  test("rejects requests with no uploaded file", async ({ request }) => {
    const response = await request.post("/api/import/excel");

    expect(response.status()).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "No file uploaded" });
  });
});

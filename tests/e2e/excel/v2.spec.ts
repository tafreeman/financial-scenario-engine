import { expect, test } from "@playwright/test";
import { buildWorkbookBuffer, expectExcelPreviewContract } from "./fixtures";

test.describe("Excel import interface v2", () => {
  test("returns the same preview contract as v1 while living on a versioned route", async ({ request }) => {
    const response = await request.post("/api/import/excel/v2", {
      multipart: {
        file: {
          name: "financial-impact-v2.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: buildWorkbookBuffer(),
        },
      },
    });

    await expectExcelPreviewContract(response);
  });

  test("rejects requests with no uploaded file", async ({ request }) => {
    const response = await request.post("/api/import/excel/v2");

    expect(response.status()).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "No file uploaded" });
  });
});

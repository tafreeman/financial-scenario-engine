/**
 * Tests for Fix #4 — multer fileSize limit and fileFilter on Excel import routes —
 * plus the GHSA-72gw-mp4g-v24j field limits (fields / fieldNestingDepth).
 *
 * Done-when criteria:
 *  - A file exceeding 10 MB is rejected with 413 before exceljs processes it.
 *  - A file with Content-Type text/plain (or any non-XLSX MIME) is rejected with 400.
 *  - A deeply nested field name (e.g. a[b][c][d]) is rejected with 400
 *    (LIMIT_FIELD_NESTING) rather than parsed — multer leaves fieldNestingDepth
 *    at Infinity unless explicitly configured, so this asserts the opt-in cap.
 *  - More text fields than the `fields` cap is rejected with 400 (LIMIT_FIELD_COUNT).
 *
 * We spin up a minimal Express instance using the same multer configuration
 * as routes.ts, avoiding the need to mock the real database or LLM dependencies.
 */

import { describe, it, expect } from "vitest";
import express from "express";
import multer from "multer";

// ─── Replicated upload config (mirrors routes.ts) ────────────────────────────

const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

// @types/multer 1.4.x predates multer 2.2.0's fieldNestingDepth option — widen
// the limits type locally, exactly as routes.ts does.
const testUploadLimits: NonNullable<multer.Options["limits"]> & { fieldNestingDepth?: number } = {
  fileSize: 10 * 1024 * 1024,
  fields: 10,
  fieldNestingDepth: 1,
};

const testUpload = multer({
  storage: multer.memoryStorage(),
  limits: testUploadLimits,
  fileFilter(_req, file, cb) {
    if (XLSX_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Only XLSX/XLS files are accepted.`));
    }
  },
});

function uploadSingle(fieldName: string) {
  const middleware = testUpload.single(fieldName);
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    middleware(req, res, (err: unknown) => {
      if (!err) { next(); return; }
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "File too large. Maximum size is 10 MB." });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    });
  };
}

// ─── Minimal Express app for testing ────────────────────────────────────────

function buildTestApp() {
  const app = express();
  app.post(
    "/upload",
    uploadSingle("file"),
    (_req: express.Request, res: express.Response) => {
      res.status(200).json({ ok: true });
    }
  );
  return app;
}

// ─── HTTP request helpers (no extra dependencies) ───────────────────────────

import http from "http";

function makeMultipartRequest(
  server: http.Server,
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const boundary = "----TestBoundary" + Date.now();
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(header),
      buffer,
      Buffer.from(footer),
    ]);

    const addr = server.address() as { port: number };
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      path: "/upload",
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, body: data });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Like makeMultipartRequest, but posts plain text fields (no file part) so we
 * can exercise the `fields` / `fieldNestingDepth` limits added for
 * GHSA-72gw-mp4g-v24j.
 */
function makeFieldsRequest(
  server: http.Server,
  fields: Array<{ name: string; value: string }>
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const boundary = "----TestBoundary" + Date.now();
    const parts = fields
      .map(
        (f) =>
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${f.name}"\r\n\r\n` +
          `${f.value}\r\n`
      )
      .join("");
    const body = Buffer.from(parts + `--${boundary}--\r\n`);

    const addr = server.address() as { port: number };
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      path: "/upload",
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, body: data });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("multer upload — fileSize limit", () => {
  it("rejects a file exceeding 10 MB with 413", async () => {
    const app = buildTestApp();
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      // 11 MB buffer — just over the limit
      const bigFile = Buffer.alloc(11 * 1024 * 1024, 0x00);
      const result = await makeMultipartRequest(
        server,
        bigFile,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "big.xlsx"
      );
      expect(result.statusCode).toBe(413);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("accepts a file under 10 MB with XLSX MIME type", async () => {
    const app = buildTestApp();
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      // 1 KB buffer — well within the limit
      const smallFile = Buffer.alloc(1024, 0x00);
      const result = await makeMultipartRequest(
        server,
        smallFile,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "small.xlsx"
      );
      expect(result.statusCode).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("multer upload — fileFilter MIME-type check", () => {
  it("rejects text/plain Content-Type with 400", async () => {
    const app = buildTestApp();
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      const textFile = Buffer.from("hello world");
      const result = await makeMultipartRequest(server, textFile, "text/plain", "data.txt");
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain("Unsupported file type");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects application/pdf Content-Type with 400", async () => {
    const app = buildTestApp();
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      const pdfFile = Buffer.from("%PDF-1.4 fake content");
      const result = await makeMultipartRequest(server, pdfFile, "application/pdf", "doc.pdf");
      expect(result.statusCode).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("accepts application/vnd.ms-excel (legacy xls MIME) with 200", async () => {
    const app = buildTestApp();
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      const xlsFile = Buffer.alloc(512, 0x00);
      const result = await makeMultipartRequest(
        server,
        xlsFile,
        "application/vnd.ms-excel",
        "legacy.xls"
      );
      expect(result.statusCode).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("multer upload — field limits (GHSA-72gw-mp4g-v24j)", () => {
  it("rejects a deeply nested field name (beyond fieldNestingDepth: 1) with 400", async () => {
    const app = buildTestApp();
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      // Depth = number of "[" in the name: a[b][c][d] → 3, over the cap of 1.
      const result = await makeFieldsRequest(server, [
        { name: "a[b][c][d]", value: "x" },
      ]);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain("Field name nesting too deep");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("accepts a plain (non-nested) field name with 200", async () => {
    // Companion to the rejection test above: proves the 400 comes from the
    // nesting cap specifically, not from text fields being rejected wholesale.
    const app = buildTestApp();
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      const result = await makeFieldsRequest(server, [
        { name: "note", value: "plain field, depth 0" },
      ]);
      expect(result.statusCode).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects more text fields than the fields cap (10) with 400", async () => {
    const app = buildTestApp();
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      const eleven = Array.from({ length: 11 }, (_, i) => ({
        name: `field${i}`,
        value: "v",
      }));
      const result = await makeFieldsRequest(server, eleven);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain("Too many fields");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * Tests for Fix #4 — multer fileSize limit and fileFilter on Excel import routes.
 *
 * Done-when criteria:
 *  - A file exceeding 10 MB is rejected with 413 before exceljs processes it.
 *  - A file with Content-Type text/plain (or any non-XLSX MIME) is rejected with 400.
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

const testUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
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

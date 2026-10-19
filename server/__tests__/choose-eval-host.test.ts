/**
 * Tests for server/evals/choose-eval-host.ts — the step that picks the host for
 * the gated CI intent eval (.github/workflows/real-model-eval.yml): Ollama Cloud
 * by default, and whatever host a manual run names. No network access.
 */

import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EVAL_HOST,
  EVAL_HOSTS,
  chooseEvalHost,
  runChooseEvalHost,
} from "../evals/choose-eval-host.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chooseEvalHost", () => {
  it.each(EVAL_HOSTS)("uses %s when a manual run names it", (host) => {
    expect(chooseEvalHost(host)).toMatchObject({ host });
  });

  it.each([undefined, "", "  ", "auto"])(
    "defaults to Ollama Cloud for endpoint %j",
    (requested) => {
      expect(chooseEvalHost(requested).host).toBe("ollama-cloud");
      expect(DEFAULT_EVAL_HOST).toBe("ollama-cloud");
    }
  );

  it("rejects a host name it does not know", () => {
    expect(() => chooseEvalHost("github")).toThrow(/unknown eval host "github"/);
  });
});

describe("runChooseEvalHost", () => {
  it("writes only the host name to GITHUB_OUTPUT", () => {
    const dir = mkdtempSync(join(tmpdir(), "choose-eval-host-"));
    const output = join(dir, "github_output");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const env = { GITHUB_OUTPUT: output, OLLAMA_CLOUD_API_KEY: "ol-secret-key" };
      runChooseEvalHost(env);
      runChooseEvalHost({ ...env, EVAL_HOST: "openrouter" });
      expect(readFileSync(output, "utf8")).toBe("endpoint=ollama-cloud\nendpoint=openrouter\n");
      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines.join("\n")).not.toContain("ol-secret-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

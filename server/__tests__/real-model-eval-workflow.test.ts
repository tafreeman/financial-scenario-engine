/**
 * Guards how .github/workflows/real-model-eval.yml picks the API key it hands the
 * "openrouter" provider. GitHub Actions has no ternary, and `a && x || b && y || z`
 * falls through when the chosen secret is empty — sending ANOTHER provider's key as
 * a Bearer credential to the chosen host. The workflow must instead join terms of the
 * form `host == 'x' && secrets.X || ''`, so a missing secret resolves to '' and the
 * eval fails with "provider_unconfigured". Static text checks only: no network.
 */

import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../.github/workflows/real-model-eval.yml", import.meta.url),
  "utf8"
);
const keyLines = workflow.split(/\r?\n/).filter((line) => /^\s*OPENROUTER_API_KEY:/.test(line));

describe("real-model-eval.yml key selection", () => {
  it("never uses one secret as the fallback for another", () => {
    expect(workflow).not.toMatch(/\|\|\s*secrets\./);
  });

  it("gives each host only its own secret, or nothing", () => {
    expect(keyLines.length).toBeGreaterThan(0);
    for (const line of keyLines) {
      expect(line).toContain("== 'nvidia-nim' && secrets.NVIDIA_API_KEY || ''");
      expect(line).toContain("== 'openrouter' && secrets.OPENROUTER_API_KEY || ''");
      expect(line).toContain("== 'ollama-cloud' && secrets.OLLAMA_CLOUD_API_KEY || ''");
    }
  });
});

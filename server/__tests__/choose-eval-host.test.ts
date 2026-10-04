/**
 * Tests for server/evals/choose-eval-host.ts — the step that picks the host for
 * the gated CI intent eval (.github/workflows/real-model-eval.yml): NVIDIA NIM's
 * free tier when its key works, else OpenRouter's free tier, and whatever host a
 * manual run names. No network access: the probe and the sleep are injected, and
 * probeNim's own test stubs the global fetch.
 */

import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EVAL_HOSTS,
  NIM_MODEL,
  NIM_URL,
  PROBE_ATTEMPTS,
  chooseEvalHost,
  probeNim,
  runChooseEvalHost,
  type Probe,
} from "../evals/choose-eval-host.js";

/** A probe that answers the given statuses in turn, recording every key it was given. */
function scripted(...statuses: number[]): Probe & { keys: string[] } {
  const keys: string[] = [];
  const probe = async (key: string): Promise<number> => {
    keys.push(key);
    return statuses[Math.min(keys.length - 1, statuses.length - 1)] ?? 0; // the last one repeats
  };
  return Object.assign(probe, { keys });
}

const noSleep = vi.fn(async () => {});

afterEach(() => {
  noSleep.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chooseEvalHost", () => {
  it.each(EVAL_HOSTS)("uses %s when a manual run names it, without probing", async (host) => {
    const probe = scripted(200);
    const choice = await chooseEvalHost(host, "nv-key", probe, noSleep);
    expect(choice).toMatchObject({ host, fellBack: false });
    expect(probe.keys).toEqual([]);
  });

  it.each([undefined, "", "  ", "auto"])(
    "falls back to OpenRouter without a request when NVIDIA_API_KEY is missing (endpoint %j)",
    async (requested) => {
      const probe = scripted(200);
      for (const key of [undefined, "", "   "]) {
        const choice = await chooseEvalHost(requested, key, probe, noSleep);
        expect(choice).toEqual({
          host: "openrouter",
          reason: "NVIDIA_API_KEY is not set",
          fellBack: true,
        });
      }
      expect(probe.keys).toEqual([]);
    }
  );

  it("uses NVIDIA NIM when its probe answers 200, sending the trimmed key once", async () => {
    const probe = scripted(200);
    const choice = await chooseEvalHost(undefined, "  nv-key\n", probe, noSleep);
    expect(choice).toMatchObject({ host: "nvidia-nim", fellBack: false });
    expect(probe.keys).toEqual(["nv-key"]);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 500])("falls back at once, without retrying, on HTTP %i", async (status) => {
    const probe = scripted(status);
    const choice = await chooseEvalHost("auto", "nv-key", probe, noSleep);
    expect(choice).toEqual({
      host: "openrouter",
      reason: `NVIDIA NIM answered HTTP ${status}`,
      fellBack: true,
    });
    expect(probe.keys).toHaveLength(1);
  });

  it.each([429, 503, 0])("retries a %i and uses NVIDIA NIM once it answers", async (status) => {
    const probe = scripted(status, status, 200);
    const choice = await chooseEvalHost(undefined, "nv-key", probe, noSleep);
    expect(choice.host).toBe("nvidia-nim");
    expect(probe.keys).toHaveLength(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
  });

  it("falls back after the last attempt when NVIDIA NIM stays busy or silent", async () => {
    const busy = scripted(503);
    expect(await chooseEvalHost(undefined, "nv-key", busy, noSleep)).toEqual({
      host: "openrouter",
      reason: "NVIDIA NIM answered HTTP 503",
      fellBack: true,
    });
    expect(busy.keys).toHaveLength(PROBE_ATTEMPTS);
    expect(noSleep).toHaveBeenCalledTimes(PROBE_ATTEMPTS - 1);

    const silent = scripted(0);
    expect((await chooseEvalHost(undefined, "nv-key", silent, noSleep)).reason).toBe(
      "NVIDIA NIM did not answer"
    );
  });

  it("rejects a host name it does not know", async () => {
    await expect(chooseEvalHost("github", "nv-key", scripted(200), noSleep)).rejects.toThrow(
      /unknown eval host "github"/
    );
  });
});

describe("runChooseEvalHost", () => {
  it("writes only the host name to GITHUB_OUTPUT and flags a fallback as a warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "choose-eval-host-"));
    const output = join(dir, "github_output");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const env = { GITHUB_OUTPUT: output, NVIDIA_API_KEY: "nv-secret-key" };
      await runChooseEvalHost(env, scripted(200), noSleep);
      await runChooseEvalHost({ ...env, NVIDIA_API_KEY: "" }, scripted(200), noSleep);
      expect(readFileSync(output, "utf8")).toBe("endpoint=nvidia-nim\nendpoint=openrouter\n");
      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines[0]).not.toContain("::warning::");
      expect(lines[1]).toMatch(/^::warning::.*openrouter/);
      expect(lines.join("\n")).not.toContain("nv-secret-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("probeNim", () => {
  it("sends one tiny chat request to NIM's fixed URL, refusing redirects", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeNim("nv-key")).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(NIM_URL);
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer nv-key");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: NIM_MODEL, max_tokens: 8 });
  });

  it("reports the status of an HTTP error and 0 when no answer arrives", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    expect(await probeNim("nv-key")).toBe(503);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    expect(await probeNim("nv-key")).toBe(0);
  });
});

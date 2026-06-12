import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { parseIntent, processToolCalls } from "../ai.js";
import type { ToolCall, ChatMessage } from "../ai.js";
import type { ScenarioResult } from "../engine/types.js";
import { getConfig, setConfig } from "../db.js";

const configKeys = [
  "llm_provider",
  "ollama_endpoint",
  "ollama_model",
] as const;

let originalConfig: Record<(typeof configKeys)[number], string>;

beforeEach(() => {
  originalConfig = Object.fromEntries(
    configKeys.map((key) => [key, getConfig(key)])
  ) as Record<(typeof configKeys)[number], string>;

  setConfig("llm_provider", "ollama");
  setConfig("ollama_endpoint", "http://localhost:11434/v1/chat/completions");
  setConfig("ollama_model", "llama3.2");
});

afterEach(() => {
  for (const key of configKeys) {
    setConfig(key, originalConfig[key]);
  }
  vi.unstubAllGlobals();
});

describe("parseIntent - explicit parse failure contract", () => {
  it("does not masquerade malformed LLM output as a burn rate operation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "this is not json" },
          },
        ],
      }),
    }));

    const result = await parseIntent("Replace the architect on Project Alpha", "anonymized context");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected parse failure");
    expect(result.code).toBe("invalid_json");
    expect(JSON.stringify(result)).not.toContain("burn_rate_check");
  });
});

/**
 * The agentic (V3) path executes LLM-supplied tool arguments. These tests pin
 * the boundary guarantee that malformed or schema-invalid arguments are rejected
 * before any scenario math runs — i.e. unvalidated LLM output never reaches the
 * deterministic engine.
 */
describe("processToolCalls — boundary validation of LLM tool arguments", () => {
  it("rejects schema-invalid run_scenario args without running scenario math", () => {
    const messages: ChatMessage[] = [];
    const scenariosExplored: ScenarioResult[] = [];
    const toolCalls: ToolCall[] = [
      {
        id: "call_1",
        type: "function",
        function: { name: "run_scenario", arguments: JSON.stringify({ action: "not_a_real_action" }) },
      },
    ];

    processToolCalls(toolCalls, messages, scenariosExplored);

    expect(scenariosExplored).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("tool");
    expect(String(messages[0]?.content)).toContain("Invalid run_scenario arguments");
  });

  it("rejects malformed JSON args without running scenario math", () => {
    const messages: ChatMessage[] = [];
    const scenariosExplored: ScenarioResult[] = [];
    const toolCalls: ToolCall[] = [
      { id: "call_2", type: "function", function: { name: "run_scenario", arguments: "{ not valid json" } },
    ];

    processToolCalls(toolCalls, messages, scenariosExplored);

    expect(scenariosExplored).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("tool");
  });

  it("ignores tool calls that are not run_scenario", () => {
    const messages: ChatMessage[] = [];
    const scenariosExplored: ScenarioResult[] = [];
    const toolCalls: ToolCall[] = [
      { id: "call_3", type: "function", function: { name: "some_other_tool", arguments: "{}" } },
    ];

    processToolCalls(toolCalls, messages, scenariosExplored);

    expect(scenariosExplored).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });
});

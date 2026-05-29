import { describe, it, expect } from "vitest";
import { processToolCalls } from "../ai.js";
import type { ToolCall, ChatMessage } from "../ai.js";
import type { ScenarioResult } from "../engine/types.js";

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
    expect(messages[0].role).toBe("tool");
    expect(String(messages[0].content)).toContain("Invalid run_scenario arguments");
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
    expect(messages[0].role).toBe("tool");
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

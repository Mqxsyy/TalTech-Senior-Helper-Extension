import Anthropic from "@anthropic-ai/sdk";
import { TOOLS } from "./prompt.js";

export const MODEL = "claude-haiku-5-5";

// Safety net against a runaway tool loop within one question.
const MAX_STEPS = 6;

export function createClient(apiKey) {
  // The key belongs to the family and lives only in this browser's storage.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

/**
 * Runs one question to completion: streams Claude's answer, executes tool
 * calls, and loops until Claude is done.
 *
 * `messages` is appended to in place (never edited) so earlier turns stay
 * byte-identical for prompt caching and thinking-block validity.
 *
 * Returns "done", "refusal", or "too_many_steps".
 */
export async function runTurn({ client, system, messages, onText, runTool }) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system,
      tools: TOOLS,
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
    });
    stream.on("text", (delta) => onText(delta, step));

    const message = await stream.finalMessage();

    // A refusal can arrive after partial text: the caller discards it.
    if (message.stop_reason === "refusal") return "refusal";

    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "pause_turn") continue;
    if (message.stop_reason !== "tool_use") return "done";

    const toolUses = message.content.filter((block) => block.type === "tool_use");
    if (!toolUses.length) return "done";
    const results = [];
    for (const toolUse of toolUses) {
      const result = await runTool(toolUse.name, toolUse.input);
      results.push({ type: "tool_result", tool_use_id: toolUse.id, ...result });
    }
    messages.push({ role: "user", content: results });
  }
  return "too_many_steps";
}

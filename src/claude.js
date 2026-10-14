import Anthropic from "@anthropic-ai/sdk";
import { TOOLS } from "./prompt.js";

export const MODEL = "claude-haiku-5-5";
// Used for one turn when she says she cannot find what was highlighted:
// better at reading tricky pages, about 20 times the price per request.
export const ESCALATION_MODEL = "claude-sonnet-5-5";

// Safety net against a runaway tool loop within one question.
const MAX_STEPS = 6;

export function createClient(apiKey) {
  // The key belongs to the family and lives only in this browser's storage.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

/**
 * One conversation with Claude. Same shape as createGeminiChat in gemini.js:
 *
 *   chat.turn({ text, image, onText, runTool, escalate, signal }) -> "done" | "refusal" | "too_many_steps"
 *   chat.promptTokens   size of the last request (all input tokens, cached or not)
 *   chat.lastModel      model that answered the last request
 *   chat.reset()        start a fresh conversation
 *   chat.errorKind(e)   "auth" | "busy" | "offline" | "other"
 *
 * `runTool(name, input)` returns { text, image?, error? }; image is base64 JPEG.
 * Aborting `signal` stops the turn: it throws, and the turn is rolled back.
 *
 * `escalate` answers this turn with ESCALATION_MODEL. Requests go through the
 * beta endpoint so its server-side refusal fallback can be used; Haiku 5.5
 * has none, so its requests leave it out.
 *
 * History is append-only (never edited) so earlier turns stay byte-identical
 * for prompt caching and thinking-block validity. A failed or refused turn is
 * cut off whole, back to where it started.
 *
 * `options.model` / `options.effort` are for scripts/eval.js.
 */
export function createClaudeChat(apiKey, system, { model = MODEL, effort = "medium" } = {}) {
  const client = createClient(apiKey);
  let messages = [];
  // Results of highlight calls in an answer that was already complete. They
  // are sent at the start of the next turn instead of in an extra request, so
  // she can act on the highlight right away and each step costs one request.
  let pendingResults = [];

  const chat = {
    promptTokens: 0,
    lastModel: model,

    reset() {
      messages = [];
      pendingResults = [];
      chat.promptTokens = 0;
    },

    errorKind(error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return "auth";
      if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError) return "busy";
      if (error instanceof Anthropic.APIConnectionError) return "offline";
      return "other";
    },

    async turn({ text, image, onText, runTool, escalate = false, signal }) {
      const historyLength = messages.length;
      const savedResults = pendingResults;
      const content = [...pendingResults];
      if (image) content.push(imageBlock(image));
      content.push({ type: "text", text });
      messages.push({ role: "user", content });
      pendingResults = [];

      let outcome;
      try {
        outcome = await loop(onText, runTool, escalate ? ESCALATION_MODEL : model, signal);
      } catch (error) {
        messages.length = historyLength;
        pendingResults = savedResults;
        throw error;
      }
      if (outcome !== "done") {
        messages.length = historyLength;
        pendingResults = savedResults;
      }
      return outcome;
    },
  };

  async function loop(onText, runTool, turnModel, signal) {
    chat.lastModel = turnModel;
    for (let step = 0; step < MAX_STEPS; step++) {
      const stream = client.beta.messages.stream({
        model: turnModel,
        max_tokens: 16000,
        system,
        tools: TOOLS,
        messages,
        thinking: { type: "adaptive" },
        output_config: { effort },
        cache_control: { type: "ephemeral" },
        ...(turnModel === ESCALATION_MODEL && { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
      }, { signal });
      stream.on("text", (delta) => onText(delta, step));

      const message = await stream.finalMessage();
      const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens } = message.usage;
      chat.promptTokens = input_tokens + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0);
      console.debug("usage", { promptTokens: chat.promptTokens, cached: cache_read_input_tokens, output: output_tokens });

      // A refusal can arrive after partial text: the caller discards it.
      if (message.stop_reason === "refusal") return "refusal";

      messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "pause_turn") continue;
      if (message.stop_reason !== "tool_use") return "done";

      const toolUses = message.content.filter((block) => block.type === "tool_use");
      if (!toolUses.length) return "done";
      // Run together: each highlight waits for its scroll to finish.
      signal?.throwIfAborted();
      const outputs = await Promise.all(toolUses.map((toolUse) => runTool(toolUse.name, toolUse.input)));
      signal?.throwIfAborted();
      const settled = outputs.every((result, i) => !result.error && toolUses[i].name !== "request_screenshot");
      const results = outputs.map((result, i) => ({
        type: "tool_result",
        tool_use_id: toolUses[i].id,
        content: result.image ? [{ type: "text", text: result.text }, imageBlock(result.image)] : result.text,
        ...(result.error && { is_error: true }),
      }));

      // The answer is written and the highlights are on her screen: done.
      const wroteText = message.content.some((block) => block.type === "text" && block.text.trim());
      if (wroteText && settled) {
        pendingResults = results;
        return "done";
      }
      messages.push({ role: "user", content: results });
    }
    return "too_many_steps";
  }

  return chat;
}

function imageBlock(data) {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
}

import { ApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";
import { TOOLS } from "./prompt.js";

// Models with a free tier on the Gemini API. Flash-Lite allows more free
// questions per day; Flash picks the right button more often.
export const GEMINI_MODELS = {
  "gemini-3.5-flash-lite": {},
  "gemini-3.8-flash": { thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } },
};
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

// Safety net against a runaway tool loop within one question.
const MAX_STEPS = 6;

// Same tools as for Claude. Tools without inputs leave the schema out.
const FUNCTIONS = TOOLS.map(({ name, description, input_schema }) => ({
  name,
  description,
  ...(Object.keys(input_schema.properties).length && { parametersJsonSchema: input_schema }),
}));

const REFUSALS = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
]);

export function createGeminiClient(apiKey) {
  // The key belongs to the family and lives only in this browser's storage.
  return new GoogleGenAI({ apiKey });
}

export function isGeminiAuthError(error) {
  return (
    error instanceof ApiError && ([401, 403].includes(error.status) || (error.status === 400 && /api.?key/i.test(error.message)))
  );
}

/**
 * One conversation with Gemini. Same shape as createClaudeChat in claude.js;
 * see there for the details.
 *
 * Model turns are sent back with every part exactly as received, because
 * Gemini needs the thought signatures attached to them.
 */
export function createGeminiChat(apiKey, system, model = DEFAULT_GEMINI_MODEL) {
  const client = createGeminiClient(apiKey);
  const config = {
    systemInstruction: system,
    tools: [{ functionDeclarations: FUNCTIONS }],
    maxOutputTokens: 16000,
    ...(GEMINI_MODELS[model] ?? {}),
  };
  let contents = [];
  // Highlight results of an answer that was already complete; sent at the
  // start of the next turn instead of in an extra request.
  let pendingResults = [];

  const chat = {
    promptTokens: 0,
    lastModel: model,

    reset() {
      contents = [];
      pendingResults = [];
      chat.promptTokens = 0;
    },

    errorKind(error) {
      if (isGeminiAuthError(error)) return "auth";
      if (error instanceof ApiError) return error.status === 429 || error.status >= 500 ? "busy" : "other";
      if (error instanceof TypeError) return "offline";
      return "other";
    },

    // `escalate` is ignored: one model per conversation keeps thought signatures valid.
    async turn({ text, image, onText, runTool, signal }) {
      const historyLength = contents.length;
      const savedResults = pendingResults;
      const parts = [...pendingResults];
      if (image) parts.push({ inlineData: { mimeType: "image/jpeg", data: image } });
      parts.push({ text });
      contents.push({ role: "user", parts });
      pendingResults = [];

      let outcome;
      try {
        outcome = await loop(onText, runTool, signal);
      } catch (error) {
        contents.length = historyLength;
        pendingResults = savedResults;
        throw error;
      }
      if (outcome !== "done") {
        contents.length = historyLength;
        pendingResults = savedResults;
      }
      return outcome;
    },
  };

  async function loop(onText, runTool, signal) {
    for (let step = 0; step < MAX_STEPS; step++) {
      const stream = await client.models.generateContentStream({ model, contents, config: { ...config, abortSignal: signal } });
      const parts = [];
      let finishReason = null;
      for await (const chunk of stream) {
        if (chunk.promptFeedback?.blockReason) return "refusal";
        if (chunk.usageMetadata?.promptTokenCount) chat.promptTokens = chunk.usageMetadata.promptTokenCount;
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) finishReason = candidate.finishReason;
        for (const part of candidate?.content?.parts ?? []) {
          if (part.text && !part.thought) onText(part.text, step);
          addPart(parts, part);
        }
      }
      console.debug("usage", { promptTokens: chat.promptTokens, finishReason });

      // A refusal can arrive after partial text: the caller discards it.
      if (REFUSALS.has(finishReason)) return "refusal";
      if (!parts.length) return "done";
      contents.push({ role: "model", parts });

      const calls = parts.filter((part) => part.functionCall).map((part) => part.functionCall);
      if (!calls.length) return "done";
      // Run together: each highlight waits for its scroll to finish.
      signal?.throwIfAborted();
      const outputs = await Promise.all(calls.map((call) => runTool(call.name, call.args ?? {})));
      signal?.throwIfAborted();
      const settled = outputs.every((result, i) => !result.error && calls[i].name !== "request_screenshot");
      const results = outputs.map((result, i) => ({
        functionResponse: {
          ...(calls[i].id && { id: calls[i].id }),
          name: calls[i].name,
          response: result.error ? { error: result.text } : { output: result.text },
          ...(result.image && { parts: [{ inlineData: { mimeType: "image/jpeg", data: result.image } }] }),
        },
      }));

      // The answer is written and the highlights are on her screen: done.
      const wroteText = parts.some((part) => part.text?.trim() && !part.thought);
      if (wroteText && settled) {
        pendingResults = results;
        return "done";
      }
      contents.push({ role: "user", parts: results });
    }
    return "too_many_steps";
  }

  return chat;
}

// Streamed text arrives in many small parts. Join plain text pieces; keep
// every other part (function calls, anything carrying a thought signature)
// exactly as received.
function addPart(parts, part) {
  const plain = (p) => typeof p.text === "string" && Object.keys(p).length === 1;
  const last = parts.at(-1);
  if (last && plain(last) && plain(part)) {
    parts[parts.length - 1] = { text: last.text + part.text };
  } else {
    parts.push(part);
  }
}

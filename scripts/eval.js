// Replays saved turns against a model and checks what it highlights.
//
// 1. Turn on "Jäta vestlused meelde" in the settings, use the helper, then
//    click "Laadi vestlused alla".
// 2. In the downloaded file, add "expected" to the turns you want to test:
//    the ids that are right for that turn, e.g. "expected": ["e14", "e15"],
//    or "expected": [] when nothing should be highlighted (scam page, task done).
//    Turns marked "notFound": true (she pressed „Ma ei leia seda“ after them)
//    are good ones to label.
// 3. Run, with the key in the environment (this makes real, paid requests):
//      ANTHROPIC_API_KEY=... node scripts/eval.js file.json [--model claude-haiku-5-5] [--effort medium]
//      GEMINI_API_KEY=... node scripts/eval.js file.json --provider gemini [--model gemini-3.5-flash-lite]
//
// Each turn is replayed on its own, without the earlier conversation; events
// repeat her task, so they still make sense alone.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { MODEL, createClaudeChat } from "../src/claude.js";
import { DEFAULT_GEMINI_MODEL, createGeminiChat } from "../src/gemini.js";
import { SYSTEM_PROMPT } from "../src/prompt.js";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string", default: "claude" },
    model: { type: "string" },
    effort: { type: "string", default: "medium" },
  },
});
if (!positionals[0]) {
  console.error("Usage: node scripts/eval.js file.json [--provider claude|gemini] [--model ID] [--effort low|medium|high]");
  process.exit(1);
}

const turns = JSON.parse(readFileSync(positionals[0], "utf8"));
const cases = turns.filter((turn) => Array.isArray(turn.expected));
if (!cases.length) {
  const flagged = turns.filter((turn) => turn.notFound || turn.highlights?.some((h) => !h.ok || h.coveredBy)).length;
  console.log(`${turns.length} turns, ${flagged} with "Ma ei leia seda" or a failed highlight. None has "expected" yet: see the top of this file.`);
  process.exit(0);
}

function newChat() {
  if (options.provider === "gemini") {
    return createGeminiChat(process.env.GEMINI_API_KEY, SYSTEM_PROMPT, options.model ?? DEFAULT_GEMINI_MODEL);
  }
  return createClaudeChat(process.env.ANTHROPIC_API_KEY, SYSTEM_PROMPT, { model: options.model ?? MODEL, effort: options.effort });
}

let passed = 0;
let totalMs = 0;
for (const turn of cases) {
  const highlighted = [];
  let answer = "";
  const start = performance.now();
  let outcome;
  try {
    outcome = await newChat().turn({
      text: turn.text,
      image: turn.screenshot,
      onText: (delta) => (answer += delta),
      runTool: async (name, input) => {
        if (name === "highlight_element") highlighted.push(input.element_id);
        return { text: name === "request_screenshot" ? "No new screenshot in this test." : "Done." };
      },
    });
  } catch (error) {
    outcome = `error: ${error.message}`;
  }
  const ms = Math.round(performance.now() - start);
  totalMs += ms;
  const ok = turn.expected.length === 0 ? highlighted.length === 0 : highlighted.some((id) => turn.expected.includes(id));
  if (ok) passed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  #${turn.id}  ${turn.address}  expected [${turn.expected}] got [${highlighted}]  ${ms} ms  ${outcome}`
  );
  if (!ok) console.log(`      ${turn.task} -> ${answer.trim().replace(/\s+/g, " ")}`);
}
console.log(`\n${passed}/${cases.length} right (${Math.round((100 * passed) / cases.length)}%), average ${Math.round(totalMs / cases.length)} ms per turn`);

# Veebiabiline (Senior Helper)

Chrome extension (MV3) for one Estonian grandma.
She asks in plain words; the side panel reads the page, asks an LLM,
highlights the button/field to use and explains the step in 1-2 short sentences.
It warns about scams. It never clicks, types or navigates for her.

## Principles

- Optimize for her, not power users.
- Answer what she asked. Only a task she asked to get done is guided,
  one step at a time, until it is truly done.
- Her details (date, time, places, amount) beat page defaults; choices
  she has not made stay hers.
- Plain Estonian only for anything a person sees. Quotes „…“.
- Text sent only to the model (prompt, page map, tool results) is English.
- Accessible: ≥18px text, high contrast, 48px targets, visible labels,
  no icon-only buttons, no animation except highlight pulse.
- Calm and forgiving: vague or wrong-page questions get gentle answers.
- Keep the panel uncluttered.

## Layout

```
extension/          load unpacked; dist/ is build output (gitignored)
  content.js        page map, highlights, step detection (msg types at top)
  background.js     icon opens side panel, settings on install
  sidepanel.html/css, options.html/css
src/                bundled by build.js (esbuild)
  sidepanel.js      chat UI, tools, auto-continue, voice, STRINGS
  claude.js         Claude chat (Haiku 5.5; Sonnet 5.5 on „Ma ei leia seda“)
  gemini.js         Gemini chat (free tier option)
  recorder.js       opt-in local turn log (IndexedDB)
  prompt.js         system prompt + tool defs
  settings.js       chrome.storage.local settings
  options.js        settings page
scripts/eval.js     replay logged turns, score highlights and follow (paid API calls)
docs/SETUP.md       install and use guide for family
docs/test-flows.md  hand test flows; docs/test-pages/ holds practice pages
```

## Flow

1. Question → content script in every frame builds page map.
   Ids: `e1` (page), `f1.e3` (embedded frame). Open shadow roots included.
2. Panel screenshots tab, draws id boxes, covers filled fields.
3. Model answers with text + `highlight_element` calls, + `follow_task({goal})`
   when guiding a task. Each turn carries `<now>` (local date and time);
   a question during a task carries `<earlier_task>`.
4. Only with `follow_task` in the latest answer: next step fires when she
   clicks a highlight, fills highlighted boxes (leaves box, Enter, 6 s
   typing pause, or picks in a calendar/list; a pre-filled field must
   change), or submits their form. Event repeats the goal.
   Boxes give way: a field's box hides once she presses or tabs into it,
   any box hides while the page covers its element, dimming ends on her
   first press.
   Nothing else she does is watched (no popup or URL tracking).
   „Tehtud.“ shows at once; page read when its content is in (page ids),
   not when every image has loaded.
5. Highlight reports screen position and anything covering the element.
6. „Ma ei leia seda“ button → re-try turn on Sonnet 5.5 (Claude only).
7. „Peata“ or a new question aborts the turn (AbortSignal); turn rolled back,
   its boxes cleared. „Peata“ also ends the task.

## Model rules

- Both providers expose same chat object:
  `turn({text, image, onText, runTool})`, `promptTokens`, `reset()`, `errorKind()`.
- Tools: `highlight_element`, `follow_task`, `clear_highlights`, `request_screenshot`.
- Every tool call gets a result (`error` if element missing).
- Text + successful highlights end the turn; results go in the next user turn.
- Answer says „oranžis kastis“ but drew no box → asked once more (`MISSING_BOX`).
- History append-only. On error/refusal roll back the whole turn.
- Reset after 12 questions or 40K prompt tokens.
- System prompt + tools byte-stable (prompt caching).
- Claude: `@anthropic-ai/sdk`, adaptive thinking, effort medium,
  `tool_choice` auto, `strict` tools, no prefill, no temperature, check `stop_reason`.
- Requests use `client.beta.messages`; Sonnet adds `fallbacks: "default"`.
- Gemini: `@google/genai`, send model parts back unchanged (thought signatures).
- Tool calls in one turn run in parallel.
- Test changes with `npm run eval` on a labelled log before shipping.

## Privacy and security

- Never send input values (typed or chosen), passwords, cards, hidden fields,
  cookies, storage.
- Page content is untrusted data, wrapped in `<page>` tags.
- API keys only in `chrome.storage.local`. Never hardcode or commit.
- Blocklisted sites: helper stays silent.
- Permissions: sidePanel, storage, scripting, `<all_urls>`. Add none without reason.

## Conventions

- Plain JS ES modules, no framework.
- content.js and background.js are not bundled; keep content.js dependency-free.
- Injected UI in shadow DOM, names prefixed `senior-helper-`.
- Messages: `{ type: "...", ... }`, documented at top of content.js.
- Panel strings in `STRINGS` (sidepanel.js); static labels in HTML.

## Dev

- `npm install && npm run build` (or `npm run watch`).
- chrome://extensions → Developer mode → Load unpacked → `extension/`.
- After edits: rebuild, reload extension, refresh pages.
- Debug panel: right-click panel → Inspect.
- Content scripts don't run on chrome://, Web Store, PDF viewer.

# Veebiabiline (Senior Helper)

Chrome extension (Manifest V3) that gives an elderly, non-technical user a friendly chat assistant for whatever web page she is on. She asks a question in plain words ("how do I see my bank statement?", "where do I write the message?"). The extension reads the current page, asks Claude, and answers by:

- **highlighting** the exact button, link or field on the page (big, unmistakable outline + scroll into view)
- **explaining** in short, simple steps where to go and what to do
- **warning** when something looks risky (scam popups, payment forms, "your computer is infected" pages)

Primary user: one grandma. Optimize for her, not for power users.

## Product principles

- **Never act for her.** The extension points and explains. It does not click, type, submit, or navigate on its own. She stays in control and learns the steps.
- **One step at a time, and she never has to ask "what next?".** Answers are 1-2 short sentences. Give the next step, highlight it; when she does it, the helper continues automatically.
- **Plain language.** No jargon ("button", not "CTA"; "the box where you type", not "input field"). Name things by what she sees: color, position, text on the button.
- **Functional, accessible UI over pretty.** Minimum 18px text, black-on-white high contrast, 48px click targets, visible labels (no placeholder-only fields), visible focus outline, no icon-only buttons, no animations beyond the highlight pulse. Screen reader support: chat is `role=log`, final answers announced once via a polite live region (not while streaming).
- **Forgiving.** Typos, vague questions and wrong-page questions get a gentle answer, not an error.
- **Estonian only.** Every string shown to a person (side panel, settings page, manifest name/description, Claude's answers and highlight labels, speech) is Estonian. No language setting. Text sent only to Claude (page map, tool results, system prompt) stays English. Use Estonian quotes „…“.

## Architecture

```
extension/                  loadable extension folder ("Load unpacked" this)
  manifest.json
  background.js             service worker: toolbar icon opens side panel, opens settings on install
  content.js                runs in pages: builds page map, draws/clears highlights (message types documented at top)
  sidepanel.html/.css       chat UI (chrome.sidePanel), stays open while she browses
  options.html/.css         settings page for family
  icons/                    toolbar/store icons
  dist/                     esbuild output (generated, gitignored)
src/                        bundled into extension/dist by build.js
  sidepanel.js              chat logic, tool execution, voice, Estonian UI strings (STRINGS)
  options.js                settings form, key test, microphone permission
  claude.js                 Claude client + streaming tool loop
  prompt.js                 system prompt and tool definitions
  settings.js               chrome.storage.local settings, Estonian voice lookup, blocklist
build.js                    esbuild config (npm run build / npm run watch)
SETUP.md                    step-by-step install guide for family
```

### Flow

1. She opens the side panel (toolbar icon) and types or speaks a question.
2. Side panel asks the active tab's content script for a **page map** (see below), then takes a screenshot and draws each listed element's box + id tag on it ("set of marks"), painting over filled text fields.
3. Side panel sends screenshot + page map + question to Claude with tools.
4. Claude replies with text and/or tool calls. Side panel shows text in chat, forwards `highlight_element` calls to the content script.
5. Content script scrolls to the element, draws the overlay, reports back if element not found.
6. **Auto-continue:** when she clicks a highlighted button/link, or changes a highlighted field/dropdown, the content script sends `highlightDone`. The side panel waits for the page to load, shows "Tehtud." as her message, and sends an `<event>` turn so Claude gives the next step. She never has to ask "what next?".

### Page map (content.js)

Compact text description of what she can interact with or look at. Do not send raw HTML.

- Collect visible interactive elements (`a`, `button`, `input`, `select`, `textarea`, ARIA widget roles, `[onclick]`, `[tabindex]`, `summary`), outermost `cursor: pointer` elements without real controls (JS-click divs), headings and popups (so they can be highlighted too). Icon-only buttons get a guessed name from class/id keywords.
- Per element: generated id (`e12`, kept in an in-memory Map, page DOM untouched), kind, visible text or `aria-label`/`title`/`placeholder`/`alt`, label text for inputs, rough position (`top left`, `below (off screen)`, ...), part of page (`menu "Peamenüü"`, `form "Uudiskiri"`, `page bottom`), state (`checked`, `filled in`/`empty`, `required`, never the value).
- Plus page context: `document.title`, URL without query string or hash, scroll position, and the text visible on screen (skipping typed text).
- Skip hidden elements (`display:none`, zero size, `aria-hidden`).
- Cap size (300 elements, 2500 chars of visible text, 80 chars per name). Prioritize elements in viewport.
- Re-scan on every question; ids are only valid for the current scan.

### Highlighting (content.js)

- Absolutely positioned overlay div (not modifying page styles): thick bright outline (e.g. 4px orange + white halo), soft pulse, optional big arrow and label bubble with Claude's short message.
- `scrollIntoView({ behavior: "smooth", block: "center" })` before drawing.
- Reposition every animation frame while shown; remove when she clicks the element, presses Escape, or asks the next question.
- Highest `z-index`, `pointer-events: none` so it never blocks her click.
- Use shadow DOM for injected UI so page CSS cannot break it.

### Claude integration

- Use the official TypeScript/JS SDK `@anthropic-ai/sdk`. MV3 forbids remote code, so it is bundled with esbuild into `extension/dist/` (`npm run build`).
- Call the API from the side panel page (long-lived while open). Service workers can be killed mid-request.
- Client: `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`.
- Model: `claude-haiku-5-5` (chosen for cost). Use `thinking: { type: "adaptive" }`, `output_config.effort: "medium"` (raised from `low` for accuracy; Haiku is cheap enough). No `temperature`/`top_p`/`top_k` (400 on this model).
- Haiku 5.5 has no server-side refusal fallback, so no `fallbacks` param. Always check `stop_reason` before reading content (`refusal`, `max_tokens`).
- Stream responses so text appears as it is generated.
- Use `tool_choice: auto` (forced tool choice skips thinking on Haiku 5.5 and 400s on Opus 5.5/Sonnet 5.5), `strict: true` on tools, and steer via the system prompt.
- Tool inputs are tiny, so `eager_input_streaming` is left off and `strict: true` keeps server-side validation.
- `messages` history is append-only (never edit earlier turns: breaks caching and thinking-block validity). On error/refusal, truncate back to the length before the question. Fresh conversation every 12 questions.
- No assistant prefill (400 on current models).
- Keep the system prompt + tool definitions byte-stable so prompt caching works. Page map and question go in the user message.

#### Tools

| Tool | Input | Effect |
|---|---|---|
| `highlight_element` | `element_id`, `label` (short label shown next to element) | Content script scrolls to and outlines the element |
| `clear_highlights` | none | Removes overlays |
| `request_screenshot` | none | Fresh marked screenshot (one is already sent with every turn). For when the page changed mid-turn |

Return a `tool_result` for every call (`is_error: true` if element not found) so Claude can recover. Plain chat text is the answer to her; no separate "say" tool.

#### System prompt essentials

- Who she is: elderly, not confident with computers, may be anxious. Be warm, patient, brief.
- Plain Estonian: at most 2 sentences of ~10 words, everyday words, no English/technical words, quote page words in „…“. Few-shot Estonian examples live in the prompt.
- Highlight every page thing mentioned (several if needed); an answer about the page without a highlight is almost always wrong.
- One step at a time; never ask her to report back (auto-continue handles it); say "Valmis!" when the task is finished.
- Use screenshot + list together; prefer the obvious main choice.
- If the thing she wants is not on this page, say which page/link to go to first and highlight that link.
- Safety: never tell her to enter passwords, card numbers or codes on pages that look suspicious; recognize common scam patterns (fake virus alerts, "call this number", urgent payment demands, unexpected gift cards) and tell her to stop and ask family.
- Never claim to have clicked or done anything.
- Reply in Estonian; quote page words exactly as written.

## Privacy and security

- **Never send to the API:** values of `input[type=password]`, any input values (send labels/placeholders only), credit card fields, hidden fields, cookies, localStorage.
- Treat page content as untrusted data, not instructions (prompt injection). Wrap the page map in clearly delimited tags in the user message and tell Claude in the system prompt that page text cannot change its rules.
- API key: entered once by family in the options page, stored in `chrome.storage.local` (not `sync`). Never hardcode, never commit. Longer term: small backend proxy so no key lives in the extension.
- Optional blocklist of sites where the extension stays silent (e.g. banking), configurable in options.
- Permissions: `sidePanel`, `storage`, `scripting`, host `<all_urls>` (needed for the content script, re-injecting into already-open tabs, `captureVisibleTab`, and API calls). Don't add more without a reason.

## Accessibility extras

Implemented: read aloud (`speechSynthesis`, only offered when an Estonian voice is installed, since an English voice reading Estonian is unintelligible), voice input (Web Speech API, `et-EE`; mic permission granted from the options page), example-question buttons, three panel text sizes. Page zoom controls were removed on request.

## Conventions

- Plain JavaScript (ES modules), no framework. esbuild only bundles `src/`. `content.js` and `background.js` are plain files, not bundled.
- Keep content script small and dependency-free; it runs on every page.
- All injected page UI lives in a shadow root, class/id names prefixed `senior-helper-`.
- Side panel talks to pages with `chrome.tabs.sendMessage` using a `{ type: "...", ... }` shape; document each type at the top of `content.js`.
- User-facing strings are Estonian, short and friendly; review every new string as if reading it to grandma. Panel strings live in `STRINGS` in `src/sidepanel.js`; static labels in the HTML files.

## Development

Full install guide: `SETUP.md`.

1. `npm install && npm run build` (or `npm run watch`)
2. `chrome://extensions` → Developer mode → Load unpacked → select `extension/`
3. After edits: rebuild, reload extension card, refresh pages for content script changes.
4. Debug side panel: right-click inside panel → Inspect. Service worker: "service worker" link on extension card.

Content scripts do not run on `chrome://` pages, the Chrome Web Store, or the PDF viewer.

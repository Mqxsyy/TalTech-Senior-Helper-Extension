import { createClaudeChat } from "./claude.js";
import { createGeminiChat } from "./gemini.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { addTurn, markTurn } from "./recorder.js";
import { LANGUAGE_CODE, TEXT_SIZES, estonianVoice, isBlocked, loadSettings, voicesReady } from "./settings.js";

// All text she sees in the panel. Static labels are in sidepanel.html.
const STRINGS = {
  welcome: "Tere! Küsi minult, kuidas sellel lehel midagi teha. Näitan oranži kastiga, kuhu vajutada.",
  examplesTitle: "Näiteks",
  examples: ["Mis leht see on?", "Kuidas ma sisse login?", "Kas see leht on turvaline?"],
  you: "Sina:",
  helper: "Abiline:",
  done: "Tehtud.",
  noPage: "Ühtegi lehte pole avatud.",
  thinking: "Mõtlen…",
  stopped: "Peatatud.",
  waiting: "Vaatan lehte…",
  speak: "Räägi",
  listening: "Kuulan… Vajuta, et lõpetada",
  readAloud: "Loe ette",
  notFound: "Ma ei leia seda",
  blocked: "Sellel veebilehel olen välja lülitatud. Palun küsi siin abi pereliikmelt.",
  refusal: "Vabandust, sellega ma aidata ei saa. Palun küsi abi pereliikmelt.",
  noAnswer: "Vabandust, ma ei leidnud vastust. Kas saaksid küsida natuke teistmoodi?",
  tooLong: "Vabandust, see võttis liiga kaua aega. Palun küsi uuesti, võib-olla lihtsamalt.",
  badKey: "Abilise võti ei tööta. Palun anna pereliikmele teada, et ta seaded üle vaataks.",
  busy: "Abiline on praegu hõivatud. Palun oota minut ja küsi uuesti.",
  offline: "Ma ei saa internetiga ühendust. Palun kontrolli, kas arvuti on internetis, ja küsi uuesti.",
  genericError: "Midagi läks valesti. Palun proovi uuesti või anna pereliikmele teada.",
  micBlocked: "Mikrofon pole veel lubatud. Pereliige saab selle seadetes sisse lülitada.",
};

const ERROR_STRINGS = { auth: STRINGS.badKey, busy: STRINGS.busy, offline: STRINGS.offline, other: STRINGS.genericError };

// Sent to the model, not shown to her.
const CANNOT_READ_PAGE =
  "(The helper cannot read this page. It may be a browser settings page, the Chrome Web Store, a PDF, or another special page.)";

// Start a fresh conversation after this many questions, or once a request
// grows past this many tokens (every old screenshot and page list is resent;
// Haiku also charges more above 100K), to keep requests small and cheap.
// Each <event> repeats her task, so a reset in the middle of a task is safe.
const MAX_QUESTIONS_PER_CONVERSATION = 12;
const MAX_PROMPT_TOKENS = 40000;
// About 1,200 image tokens at 16:9; the id tags are drawn after scaling, so
// they stay readable.
const SCREENSHOT_MAX_SIDE = 1280;
// Embedded frames (login boxes, payment forms, cookie notices) read per question.
const MAX_FRAMES = 6;
const MARK_COLOR = "#d000d0";
const COVER_COLOR = "#9e9e9e";

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const $ = (id) => document.getElementById(id);
const log = $("chat");
const questionBox = $("question");
const stopButton = $("stop");
const micButton = $("mic");
const announcer = $("announcer");

let settings;
let assistant = null;
let voice = null;
let questionCount = 0;
let task = "";
let busy = false;
let recognition = null;
// Tab with orange boxes she has not acted on yet.
let stepTabId = null;
// A step she finished while the helper was still answering.
let queuedStep = null;
// Page load the latest page list came from; tells a new page from the old one.
let lastPageId = null;
// Id prefix ("" or "f1.") -> frameId, from the latest page scan.
let frameIds = new Map([["", 0]]);
// Recorded turn of the newest answer, if recording is on.
let lastTurnId = null;
const { id: windowId } = await chrome.windows.getCurrent();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Settings ----------

function createAssistant() {
  if (settings.provider === "gemini") {
    return settings.geminiKey ? createGeminiChat(settings.geminiKey, SYSTEM_PROMPT, settings.geminiModel) : null;
  }
  return settings.apiKey ? createClaudeChat(settings.apiKey, SYSTEM_PROMPT) : null;
}

async function applySettings() {
  settings = await loadSettings();
  assistant = createAssistant();
  questionCount = 0;
  document.documentElement.style.setProperty("--size", TEXT_SIZES[settings.textSize] ?? TEXT_SIZES.large);
  $("setup").hidden = Boolean(assistant);
  log.hidden = !assistant;
  micButton.hidden = !(settings.voiceInput && SpeechRecognition);
}

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") applySettings();
});

// ---------- Chat display ----------

function announce(text) {
  announcer.textContent = "";
  // A fresh text node makes screen readers announce it even if unchanged.
  setTimeout(() => (announcer.textContent = text), 50);
}

// who: "her", "helper", or "step" (a short "Tehtud." line after she did a step).
function addMessage(who, text) {
  const message = document.createElement("div");
  message.className = `message ${who}`;
  const label = document.createElement("span");
  label.className = "visually-hidden";
  label.textContent = who.startsWith("helper") ? STRINGS.helper : STRINGS.you;
  const body = document.createElement("span");
  body.className = "text";
  body.textContent = text;
  message.append(label, body);
  log.append(message);
  message.scrollIntoView({ block: "end" });
  return message;
}

function addButton(message, className, text, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `secondary ${className}`;
  button.textContent = text;
  button.addEventListener("click", onClick);
  message.append(button);
}

// `showedBoxes`: the answer drew orange boxes, so she may need „Ma ei leia seda“.
function finishMessage(message, text, isError, showedBoxes = false) {
  message.className = isError ? "message helper error" : "message helper";
  message.querySelector(".text").textContent = text;
  // Only the newest answer gets buttons.
  for (const old of log.querySelectorAll(".message-actions")) old.remove();
  if (showedBoxes || voice) {
    const row = document.createElement("div");
    row.className = "message-actions";
    if (showedBoxes) addButton(row, "not-found", STRINGS.notFound, notFound);
    if (voice) addButton(row, "read-aloud", STRINGS.readAloud, () => speak(text));
    message.append(row);
  }
  message.scrollIntoView({ block: "end" });
  announce(text);
  if (settings.readAloud && voice) speak(text);
}

function showWelcome() {
  log.replaceChildren();
  addMessage("helper", STRINGS.welcome);

  const examples = document.createElement("fieldset");
  examples.className = "examples";
  const legend = document.createElement("legend");
  legend.textContent = STRINGS.examplesTitle;
  examples.append(legend);
  for (const text of STRINGS.examples) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = text;
    button.addEventListener("click", () => ask(text));
    examples.append(button);
  }
  log.append(examples);
}

// While busy she can still ask (that stops the current answer) or press „Peata“.
function setBusy(value) {
  busy = value;
  stopButton.hidden = !value;
  log.setAttribute("aria-busy", String(value));
}

// ---------- Tabs and pages ----------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Which frames of the tab have the content script: [{ frameId, result }].
function framesWithHelper(tab) {
  return chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => Boolean(window.__seniorHelperCleanup),
  });
}

// Page map of the whole tab: the page itself plus every embedded frame that
// is on screen and has something in it. Ids in frames look like "f1.e3".
async function getPageMap(tab) {
  try {
    let frames = await framesWithHelper(tab);
    if (frames.some(({ result }) => !result)) {
      // Opened before the extension was installed or reloaded: inject now.
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
      frames = await framesWithHelper(tab);
    }
    await chrome.tabs.sendMessage(tab.id, { type: "locateFrames" }, { frameId: 0 });
    const top = await chrome.tabs.sendMessage(tab.id, { type: "getPageMap", prefix: "" }, { frameId: 0 });
    if (!top) return null;

    frameIds = new Map([["", 0]]);
    const embedded = frames.filter(({ frameId, result }) => frameId !== 0 && result).slice(0, MAX_FRAMES);
    const maps = await Promise.all(
      embedded.map(({ frameId }, index) =>
        chrome.tabs.sendMessage(tab.id, { type: "getPageMap", prefix: `f${index + 1}.` }, { frameId }).catch(() => null)
      )
    );
    const texts = [top.text];
    const marks = [...top.marks];
    maps.forEach((map, index) => {
      if (!map) return;
      frameIds.set(`f${index + 1}.`, embedded[index].frameId);
      texts.push(map.text);
      marks.push(...map.marks);
    });
    return { pageId: top.pageId, text: texts.join("\n\n"), marks, viewport: top.viewport };
  } catch {
    return null;
  }
}

// "f2.e7" -> frame 2's "e7"; "e7" -> the page itself.
function locate(elementId) {
  const match = /^(f\d+\.)(e\d+)$/.exec(elementId);
  if (!match) return { frameId: 0, id: elementId };
  return { frameId: frameIds.get(match[1]), id: match[2] };
}

async function getMarks(tab) {
  const marks = [];
  let viewport = null;
  for (const frameId of frameIds.values()) {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "getMarks" }, { frameId }).catch(() => null);
    if (!result) continue;
    marks.push(...result.marks);
    viewport ??= result.viewport;
  }
  return viewport ? { marks, viewport } : null;
}

function clearHighlights(tab) {
  stepTabId = null;
  return chrome.tabs.sendMessage(tab.id, { type: "clearHighlights" }).catch(() => {});
}

// Draws a box and id tag on each listed element, so the model can match the
// picture to the page list. Typed-in fields are painted over first, so their
// contents never leave the computer.
function drawMarks(context, { marks, viewport }, canvasWidth) {
  const ratio = canvasWidth / viewport.width;
  context.fillStyle = COVER_COLOR;
  for (const mark of marks) {
    if (mark.cover) context.fillRect(mark.x * ratio, mark.y * ratio, mark.width * ratio, mark.height * ratio);
  }
  context.font = "bold 13px sans-serif";
  context.lineWidth = 2;
  for (const mark of marks) {
    const x = mark.x * ratio;
    const y = mark.y * ratio;
    context.strokeStyle = MARK_COLOR;
    context.strokeRect(x, y, mark.width * ratio, mark.height * ratio);
    const tagWidth = context.measureText(mark.id).width + 6;
    const tagY = y >= 16 ? y - 16 : y;
    context.fillStyle = MARK_COLOR;
    context.fillRect(x, tagY, tagWidth, 16);
    context.fillStyle = "#ffffff";
    context.fillText(mark.id, x + 3, tagY + 12);
  }
}

async function captureScreenshot(tab, markData) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, SCREENSHOT_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (markData?.marks?.length) drawMarks(context, markData, canvas.width);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// ---------- Tools the model can call ----------

// Returns { text, image?, error? } for claude.js / gemini.js to wrap.
async function runTool(tab, name, input) {
  try {
    switch (name) {
      case "highlight_element": {
        if (typeof input?.element_id !== "string" || typeof input?.label !== "string") {
          return { error: true, text: "element_id and label must both be strings." };
        }
        const { frameId, id } = locate(input.element_id);
        if (frameId === undefined) {
          return { error: true, text: `No element with id ${input.element_id}. Use an id from the latest page list.` };
        }
        const response = await chrome.tabs.sendMessage(tab.id, { type: "highlight", id, label: input.label }, { frameId });
        turnLog?.highlights.push({ id: input.element_id, label: input.label, ok: Boolean(response?.ok), coveredBy: response?.coveredBy });
        if (!response?.ok) return { error: true, text: response?.error ?? "The page did not respond." };
        stepTabId = tab.id;
        turnLog && (turnLog.ms.firstHighlight ??= Math.round(performance.now() - turnLog.start));
        if (response.coveredBy) {
          return {
            error: true,
            text: `Highlighted the ${response.description}, but something is on top of it: ${response.coveredBy}. She cannot click it yet. Help her close or answer that first, and highlight its button.`,
          };
        }
        return {
          text: `Highlighted the ${response.description} (${response.position} of her screen). It is now on her screen with the label "${input.label}".`,
        };
      }
      case "clear_highlights":
        await clearHighlights(tab);
        return { text: "All highlights removed." };
      case "request_screenshot": {
        return { text: "Screenshot of what she sees right now:", image: await captureScreenshot(tab, await getMarks(tab)) };
      }
      default:
        return { error: true, text: `Unknown tool ${name}.` };
    }
  } catch (error) {
    console.error(error);
    return { error: true, text: `The tool failed: ${error.message}` };
  }
}

// ---------- Asking ----------

function resetConversation() {
  assistant?.reset();
  questionCount = 0;
}

async function ask(rawQuestion) {
  const question = rawQuestion.trim();
  if (!question) return;
  questionBox.value = "";
  // A new question replaces whatever was being answered or waiting.
  await interrupt();
  queuedStep = null;
  task = question;
  await converse(question, `<question>\n${question}\n</question>`, { newQuestion: true });
}

// She did the highlighted step: show the next one without her asking.
// "Tehtud." appears right away; the page is read once it is ready.
async function continueAfterStep({ description, pageId }) {
  await converse(
    STRINGS.done,
    `<event>\nShe just ${description}.\nHer task: ${task}\nThe screenshot and page list show the page now. If her task is not finished yet, give her the next step. If it is finished, tell her.\n</event>`,
    { newQuestion: false, beforeReading: (signal) => waitForPageLoad(pageId, signal) }
  );
}

// She pressed „Ma ei leia seda“: look again, with the stronger model.
async function notFound() {
  await interrupt();
  if (lastTurnId !== null) markTurn(lastTurnId, { notFound: true }).catch(console.error);
  await converse(
    STRINGS.notFound + ".",
    `<event>\nShe pressed "I can't find it": she cannot see or find what you highlighted.\nHer task: ${task}\nLook at the screenshot and page list again. Check that you picked the right thing and that nothing covers it. Then describe it differently (colour, place, the words on it) and highlight it again, or pick a better one.\n</event>`,
    { newQuestion: false, who: "her", escalate: true }
  );
}

// Waits until the page she is looking at (a link may have opened a new tab)
// can be read: a new page as soon as its text is there, not when every image
// and ad has loaded; the same page once it stops changing.
async function waitForPageLoad(oldPageId, signal) {
  await sleep(150);
  for (let waited = 150; waited < 10000; waited += 150) {
    signal.throwIfAborted();
    const tab = await getActiveTab();
    if (!tab) return;
    const ping = await chrome.tabs.sendMessage(tab.id, { type: "ping" }, { frameId: 0 }).catch(() => null);
    if (ping?.pageId && ping.pageId !== oldPageId) break;
    // The old page, and no navigation on the way: she stayed on this page.
    if (ping?.pageId === oldPageId && !ping.leaving && tab.status !== "loading") break;
    if (!ping) {
      // No helper in the page yet. If the new page is already parsed, read
      // it now (reading injects the helper); special pages cannot be read.
      const state = await chrome.scripting
        .executeScript({ target: { tabId: tab.id }, func: () => document.readyState })
        .then(([frame]) => frame?.result, () => null);
      if (state === "interactive" || state === "complete") break;
      if (state === null && tab.status === "complete") break;
    }
    await sleep(150);
  }
  const tab = await getActiveTab();
  if (tab) await chrome.tabs.sendMessage(tab.id, { type: "waitForQuiet" }, { frameId: 0 }).catch(() => {});
}

function stepDone(description, pageId = lastPageId) {
  stepTabId = null;
  if (busy) {
    queuedStep = { description, pageId };
    return;
  }
  continueAfterStep({ description, pageId });
}

// She clicked a highlight, filled in the highlighted boxes, or sent their form.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "highlightDone" && sender.tab?.windowId === windowId) stepDone(message.description, message.pageId);
});

// She went to another page some other way (Enter key, another link, the
// page moved on by itself): follow her there.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && tabId === stepTabId) stepDone("went to another page");
});

// The turn being answered, for timing and the optional log.
let turnLog = null;
// Stops the turn being answered; resolved when that turn has wound down.
let turnAbort = null;
let turnFinished = Promise.resolve();

// Stops the answer in progress, if any, and waits until it has stopped.
async function interrupt() {
  if (!busy) return;
  queuedStep = null;
  speechSynthesis.cancel();
  turnAbort?.abort();
  await turnFinished;
}

// Saves the turn on this computer when the family turned recording on.
function record({ tab, kind, prompt, text, screenshot, answer, outcome }) {
  lastTurnId = null;
  if (!settings.recordSessions) return;
  let address = "";
  try {
    const url = new URL(tab.url);
    address = url.origin + url.pathname;
  } catch {
    // Special pages have no usable address.
  }
  addTurn({
    time: new Date().toISOString(),
    provider: settings.provider,
    model: assistant?.lastModel,
    address,
    kind,
    task,
    prompt,
    text,
    screenshot,
    answer,
    outcome,
    highlights: turnLog.highlights,
    ms: turnLog.ms,
    promptTokens: assistant?.promptTokens,
  })
    .then((id) => (lastTurnId = id))
    .catch(console.error);
}

// `beforeReading` runs after her message is shown and before the page is read.
async function converse(shownText, prompt, { newQuestion, who = newQuestion ? "her" : "step", escalate = false, beforeReading }) {
  if (busy) return;
  if (!assistant) {
    $("setup").hidden = false;
    return;
  }

  setBusy(true);
  turnAbort = new AbortController();
  const { signal } = turnAbort;
  let finishTurn;
  turnFinished = new Promise((resolve) => (finishTurn = resolve));
  let tab = null;
  log.querySelector(".examples")?.remove();
  addMessage(who, shownText);
  const reply = addMessage("helper waiting", STRINGS.waiting);
  const replyText = reply.querySelector(".text");
  announce(STRINGS.waiting);
  let answer = "";
  turnLog = { start: performance.now(), ms: {}, highlights: [] };

  try {
    await beforeReading?.(signal);
    turnLog.ms.pageReady = Math.round(performance.now() - turnLog.start);
    tab = await getActiveTab();
    if (!tab) {
      finishMessage(reply, STRINGS.noPage, true);
      return;
    }
    if (isBlocked(tab.url, settings.blockedSites)) {
      finishMessage(reply, STRINGS.blocked, false);
      return;
    }

    await clearHighlights(tab);
    const page = await getPageMap(tab);
    lastPageId = page?.pageId ?? null;
    const pageText = page?.text ?? `Title: ${tab.title ?? "(unknown)"}\n${CANNOT_READ_PAGE}`;

    let screenshot = null;
    if (page) {
      try {
        screenshot = await captureScreenshot(tab, page);
      } catch (error) {
        console.error(error);
      }
    }

    if (assistant.promptTokens >= MAX_PROMPT_TOKENS || (newQuestion && questionCount >= MAX_QUESTIONS_PER_CONVERSATION)) {
      resetConversation();
    }

    signal.throwIfAborted();
    replyText.textContent = STRINGS.thinking;
    turnLog.ms.sent = Math.round(performance.now() - turnLog.start);
    let lastStep = 0;
    const onText = (delta, step) => {
      turnLog.ms.firstText ??= Math.round(performance.now() - turnLog.start);
      if (step !== lastStep && answer.trim()) answer += "\n\n";
      lastStep = step;
      answer += delta;
      reply.className = "message helper";
      replyText.textContent = answer;
      reply.scrollIntoView({ block: "end" });
    };

    const text = `<page>\n${pageText}\n</page>\n\n${prompt}`;
    let outcome = "error";
    try {
      outcome = await assistant.turn({
        text,
        image: screenshot,
        onText,
        runTool: (name, input) => runTool(tab, name, input),
        escalate,
        signal,
      });
    } finally {
      turnLog.ms.total = Math.round(performance.now() - turnLog.start);
      const { pageReady, sent, firstText, firstHighlight, total } = turnLog.ms;
      console.info(
        `Veebiabiline timing (${assistant?.lastModel}): page ready ${pageReady} ms, sent ${sent} ms, ` +
          `first text ${firstText} ms, first box ${firstHighlight} ms, done ${total} ms`
      );
      if (signal.aborted) outcome = "stopped";
      record({ tab, kind: newQuestion ? "question" : escalate ? "notFound" : "event", prompt, text, screenshot, answer, outcome });
    }

    const showedBoxes = stepTabId !== null;
    if (outcome === "refusal") {
      finishMessage(reply, STRINGS.refusal, false);
    } else if (outcome === "too_many_steps") {
      finishMessage(reply, answer.trim() || STRINGS.tooLong, false, showedBoxes);
    } else {
      questionCount++;
      finishMessage(reply, answer.trim() || STRINGS.noAnswer, false, showedBoxes);
    }
  } catch (error) {
    if (signal.aborted) {
      // The stopped turn is gone from the history, so its boxes go too.
      if (tab) await clearHighlights(tab);
      finishMessage(reply, STRINGS.stopped, false);
    } else {
      console.error(error);
      finishMessage(reply, ERROR_STRINGS[assistant?.errorKind(error) ?? "other"], true);
    }
  } finally {
    turnLog = null;
    turnAbort = null;
    setBusy(false);
    finishTurn();
    if (queuedStep) {
      const { description, pageId } = queuedStep;
      queuedStep = null;
      stepDone(description, pageId);
    }
  }
}

// ---------- Voice ----------

function speak(text) {
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = LANGUAGE_CODE;
  utterance.rate = 0.9;
  speechSynthesis.speak(utterance);
}

function startListening() {
  recognition = new SpeechRecognition();
  recognition.lang = LANGUAGE_CODE;
  recognition.interimResults = true;
  recognition.continuous = false;
  micButton.textContent = STRINGS.listening;
  micButton.classList.add("listening");
  micButton.setAttribute("aria-pressed", "true");

  recognition.addEventListener("result", (event) => {
    questionBox.value = [...event.results].map((result) => result[0].transcript).join("");
  });
  recognition.addEventListener("error", (event) => {
    if (event.error === "not-allowed") {
      const message = addMessage("helper error", "");
      finishMessage(message, STRINGS.micBlocked, true);
    }
  });
  recognition.addEventListener("end", () => {
    recognition = null;
    micButton.textContent = STRINGS.speak;
    micButton.classList.remove("listening");
    micButton.setAttribute("aria-pressed", "false");
    if (questionBox.value.trim()) ask(questionBox.value);
  });
  recognition.start();
}

// ---------- Wiring ----------

$("ask-form").addEventListener("submit", (event) => {
  event.preventDefault();
  ask(questionBox.value);
});

questionBox.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    ask(questionBox.value);
  }
});

$("start-over").addEventListener("click", async () => {
  await interrupt();
  speechSynthesis.cancel();
  queuedStep = null;
  task = "";
  resetConversation();
  showWelcome();
  questionBox.focus();
  const tab = await getActiveTab();
  if (tab) clearHighlights(tab);
});

$("open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
stopButton.addEventListener("click", () => interrupt());
micButton.addEventListener("click", () => (recognition ? recognition.stop() : startListening()));

micButton.textContent = STRINGS.speak;
micButton.setAttribute("aria-pressed", "false");
await applySettings();
showWelcome();
questionBox.focus();
voicesReady().then(() => (voice = estonianVoice()));

import Anthropic from "@anthropic-ai/sdk";
import { createClient, runTurn } from "./claude.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { LANGUAGE_CODE, TEXT_SIZES, estonianVoice, isBlocked, loadSettings, voicesReady } from "./settings.js";

// All text she sees in the panel. Static labels are in sidepanel.html.
const STRINGS = {
  welcome:
    "Tere! Aitan sind lehega, mida praegu vaatad. Kirjuta oma küsimus allolevasse kasti või vali üks näidisküsimustest.",
  examplesTitle: "Näidisküsimused",
  examples: ["Mis leht see on?", "Kuidas ma sisse login?", "Kuidas ma eelmisele lehele tagasi lähen?", "Kas see leht on turvaline?"],
  you: "Sina",
  done: "Tehtud.",
  helper: "Abiline",
  pageLabel: "Avatud leht:",
  noPage: "Ühtegi lehte pole avatud.",
  ask: "Küsi",
  thinking: "Mõtlen…",
  waiting: "Vaatan lehte…",
  speak: "Räägi",
  listening: "Kuulan… Vajuta, et lõpetada",
  readAloud: "Loe ette",
  blocked: "Sellel veebilehel olen välja lülitatud. Palun küsi siin abi pereliikmelt.",
  refusal: "Vabandust, sellega ma aidata ei saa. Palun küsi abi pereliikmelt.",
  noAnswer: "Vabandust, ma ei leidnud vastust. Kas saaksid küsida natuke teistmoodi?",
  tooLong: "Vabandust, see võttis liiga kaua aega. Palun küsi uuesti, võib-olla lihtsamalt.",
  badKey: "Abilise võti ei tööta. Palun anna pereliikmele teada, et ta seaded üle vaataks.",
  busy: "Teenus on praegu ülekoormatud. Palun oota minut ja küsi uuesti.",
  offline: "Ma ei saa internetiga ühendust. Palun kontrolli, kas arvuti on internetis, ja küsi uuesti.",
  genericError: "Midagi läks valesti. Palun proovi uuesti või anna pereliikmele teada.",
  micBlocked: "Mikrofon pole veel lubatud. Pereliige saab selle seadetes sisse lülitada.",
};

// Sent to Claude, not shown to her.
const CANNOT_READ_PAGE =
  "(The helper cannot read this page. It may be a browser settings page, the Chrome Web Store, a PDF, or another special page.)";

// Start a fresh conversation after this many questions to keep requests small.
const MAX_QUESTIONS_PER_CONVERSATION = 12;
const SCREENSHOT_MAX_SIDE = 1568;
const MARK_COLOR = "#d000d0";
const COVER_COLOR = "#9e9e9e";

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const $ = (id) => document.getElementById(id);
const chat = $("chat");
const questionBox = $("question");
const askButton = $("ask");
const micButton = $("mic");
const announcer = $("announcer");

let settings;
let client = null;
let voice = null;
let messages = [];
let questionCount = 0;
let busy = false;
let recognition = null;
let followUpPending = false;
const { id: windowId } = await chrome.windows.getCurrent();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Settings ----------

async function applySettings() {
  settings = await loadSettings();
  client = settings.apiKey ? createClient(settings.apiKey) : null;
  document.documentElement.style.setProperty("--size", TEXT_SIZES[settings.textSize] ?? TEXT_SIZES.large);
  $("setup").hidden = Boolean(client);
  chat.hidden = !client;
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

function addMessage(who, text) {
  const message = document.createElement("div");
  message.className = `message ${who}`;
  const label = document.createElement("span");
  label.className = "who";
  label.textContent = who === "her" ? STRINGS.you : STRINGS.helper;
  const body = document.createElement("span");
  body.className = "text";
  body.textContent = text;
  message.append(label, body);
  chat.append(message);
  message.scrollIntoView({ block: "end" });
  return message;
}

function finishMessage(message, text, isError) {
  message.className = isError ? "message helper error" : "message helper";
  message.querySelector(".text").textContent = text;
  if (voice) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary read-aloud";
    button.textContent = STRINGS.readAloud;
    button.addEventListener("click", () => speak(text));
    message.append(button);
  }
  message.scrollIntoView({ block: "end" });
  announce(text);
  if (settings.readAloud && voice) speak(text);
}

function showWelcome() {
  chat.replaceChildren();
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
  chat.append(examples);
}

function setBusy(value) {
  busy = value;
  askButton.textContent = value ? STRINGS.thinking : STRINGS.ask;
  askButton.setAttribute("aria-disabled", String(value));
  chat.setAttribute("aria-busy", String(value));
  for (const button of chat.querySelectorAll(".examples button")) button.setAttribute("aria-disabled", String(value));
}

// ---------- Tabs and pages ----------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function updatePageInfo() {
  const tab = await getActiveTab();
  const text = tab?.title ? `${STRINGS.pageLabel} ${tab.title}` : STRINGS.noPage;
  $("page-info").textContent = text;
  $("page-info").title = text;
}

chrome.tabs.onActivated.addListener(updatePageInfo);
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (tab.active && (change.title || change.status === "complete")) updatePageInfo();
});

async function getPageMap(tab) {
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "getPageMap" });
  } catch {
    // Tab was opened before the extension was installed or reloaded: inject now.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      return await chrome.tabs.sendMessage(tab.id, { type: "getPageMap" });
    } catch {
      return null;
    }
  }
}

function clearHighlights(tab) {
  return chrome.tabs.sendMessage(tab.id, { type: "clearHighlights" }).catch(() => {});
}

// Draws a box and id tag on each listed element, so Claude can match the
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

function imageBlock(data) {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
}

// ---------- Tools Claude can call ----------

async function runTool(tab, name, input) {
  try {
    switch (name) {
      case "highlight_element": {
        if (typeof input?.element_id !== "string" || typeof input?.label !== "string") {
          return { is_error: true, content: "element_id and label must both be strings." };
        }
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "highlight",
          id: input.element_id,
          label: input.label,
        });
        if (!response?.ok) return { is_error: true, content: response?.error ?? "The page did not respond." };
        return { content: `Highlighted the ${response.description}. It is now on her screen with the label "${input.label}".` };
      }
      case "clear_highlights":
        await clearHighlights(tab);
        return { content: "All highlights removed." };
      case "request_screenshot": {
        const markData = await chrome.tabs.sendMessage(tab.id, { type: "getMarks" }).catch(() => null);
        const data = await captureScreenshot(tab, markData);
        return {
          content: [{ type: "text", text: "Screenshot of what she sees right now:" }, imageBlock(data)],
        };
      }
      default:
        return { is_error: true, content: `Unknown tool ${name}.` };
    }
  } catch (error) {
    console.error(error);
    return { is_error: true, content: `The tool failed: ${error.message}` };
  }
}

// ---------- Asking ----------

function errorMessage(error) {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return STRINGS.badKey;
  }
  if (error instanceof Anthropic.RateLimitError) return STRINGS.busy;
  if (error instanceof Anthropic.APIConnectionError) return STRINGS.offline;
  if (error instanceof Anthropic.InternalServerError) return STRINGS.busy;
  return STRINGS.genericError;
}

function resetConversation() {
  messages = [];
  questionCount = 0;
}

async function ask(rawQuestion) {
  const question = rawQuestion.trim();
  if (!question || busy) return;
  questionBox.value = "";
  await converse(question, `<question>\n${question}\n</question>`, { newQuestion: true });
}

// She did the highlighted step: show the next one without her asking.
async function continueAfterStep(description) {
  await converse(
    STRINGS.done,
    `<event>\nShe just ${description}. The screenshot and page list show the page now. Give her the next step, or tell her the task is finished.\n</event>`,
    { newQuestion: false }
  );
}

async function waitForPageLoad(tabId) {
  await sleep(800);
  for (let i = 0; i < 20; i++) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === "complete") break;
    await sleep(500);
  }
  // Give pages that build themselves with JavaScript a moment to render.
  await sleep(500);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "highlightDone" || sender.tab?.windowId !== windowId || followUpPending) return;
  followUpPending = true;
  waitForPageLoad(sender.tab.id).then(() => {
    followUpPending = false;
    continueAfterStep(message.description);
  });
});

async function converse(shownText, prompt, { newQuestion }) {
  if (busy) return;
  if (!client) {
    $("setup").hidden = false;
    return;
  }

  setBusy(true);
  addMessage("her", shownText);
  const reply = addMessage("helper waiting", STRINGS.waiting);
  const replyText = reply.querySelector(".text");
  announce(STRINGS.waiting);
  let answer = "";

  try {
    const tab = await getActiveTab();
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
    const pageText = page?.text ?? `Title: ${tab.title ?? "(unknown)"}\n${CANNOT_READ_PAGE}`;

    let screenshot = null;
    if (page) {
      try {
        screenshot = await captureScreenshot(tab, page);
      } catch (error) {
        console.error(error);
      }
    }

    // Only reset between tasks, never in the middle of one.
    if (newQuestion && questionCount >= MAX_QUESTIONS_PER_CONVERSATION) resetConversation();
    const historyLength = messages.length;
    const content = [{ type: "text", text: `<page>\n${pageText}\n</page>\n\n${prompt}` }];
    if (screenshot) content.unshift(imageBlock(screenshot));
    messages.push({ role: "user", content });

    let lastStep = 0;
    const onText = (delta, step) => {
      if (step !== lastStep && answer.trim()) answer += "\n\n";
      lastStep = step;
      answer += delta;
      reply.className = "message helper";
      replyText.textContent = answer;
      reply.scrollIntoView({ block: "end" });
    };

    let outcome;
    try {
      outcome = await runTurn({
        client,
        system: SYSTEM_PROMPT,
        messages,
        onText,
        runTool: (name, input) => runTool(tab, name, input),
      });
    } catch (error) {
      messages.length = historyLength;
      throw error;
    }

    if (outcome === "refusal") {
      messages.length = historyLength;
      finishMessage(reply, STRINGS.refusal, false);
    } else if (outcome === "too_many_steps") {
      messages.length = historyLength;
      finishMessage(reply, answer.trim() || STRINGS.tooLong, false);
    } else {
      questionCount++;
      finishMessage(reply, answer.trim() || STRINGS.noAnswer, false);
    }
  } catch (error) {
    console.error(error);
    finishMessage(reply, errorMessage(error), true);
  } finally {
    setBusy(false);
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
  if (busy) return;
  speechSynthesis.cancel();
  resetConversation();
  showWelcome();
  questionBox.focus();
  const tab = await getActiveTab();
  if (tab) clearHighlights(tab);
});

$("open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
micButton.addEventListener("click", () => (recognition ? recognition.stop() : startListening()));

micButton.textContent = STRINGS.speak;
micButton.setAttribute("aria-pressed", "false");
await applySettings();
showWelcome();
updatePageInfo();
questionBox.focus();
voicesReady().then(() => (voice = estonianVoice()));

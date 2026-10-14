import Anthropic from "@anthropic-ai/sdk";
import { MODEL, createClient } from "./claude.js";
import { createGeminiClient, isGeminiAuthError } from "./gemini.js";
import { allTurns, clearTurns, countTurns } from "./recorder.js";
import { estonianVoice, loadSettings, saveSettings, voicesReady } from "./settings.js";

const $ = (id) => document.getElementById(id);
const textSizeInputs = document.querySelectorAll("input[name=textSize]");
const providerInputs = document.querySelectorAll("input[name=provider]");

function showStatus(id, text, ok) {
  const element = $(id);
  element.textContent = text;
  element.className = ok ? "status ok" : "status bad";
}

const checked = (inputs, fallback) => [...inputs].find((input) => input.checked)?.value ?? fallback;

// Only the key for the chosen service is shown.
function showProvider() {
  const provider = checked(providerInputs, "claude");
  $("claude-settings").hidden = provider !== "claude";
  $("gemini-settings").hidden = provider !== "gemini";
}

const settings = await loadSettings();
$("apiKey").value = settings.apiKey;
$("geminiKey").value = settings.geminiKey;
$("geminiModel").value = settings.geminiModel;
$("readAloud").checked = settings.readAloud;
$("voiceInput").checked = settings.voiceInput;
$("blockedSites").value = settings.blockedSites;
$("recordSessions").checked = settings.recordSessions;
for (const input of textSizeInputs) input.checked = input.value === settings.textSize;
for (const input of providerInputs) {
  input.checked = input.value === settings.provider;
  input.addEventListener("change", showProvider);
}
showProvider();

voicesReady().then(() => {
  if (estonianVoice()) return;
  $("voice-missing").hidden = false;
  $("readAloud").checked = false;
  $("readAloud").disabled = true;
});

$("settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveSettings({
    provider: checked(providerInputs, "claude"),
    apiKey: $("apiKey").value.trim(),
    geminiKey: $("geminiKey").value.trim(),
    geminiModel: $("geminiModel").value,
    textSize: checked(textSizeInputs, "large"),
    readAloud: $("readAloud").checked,
    voiceInput: $("voiceInput").checked,
    blockedSites: $("blockedSites").value,
    recordSessions: $("recordSessions").checked,
  });
  showStatus("save-result", "Salvestatud.", true);
});

for (const button of document.querySelectorAll(".toggle-key")) {
  button.addEventListener("click", () => {
    const input = $(button.dataset.for);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.setAttribute("aria-pressed", String(show));
    button.textContent = show ? "Peida võti" : "Näita võtit";
  });
}

// Looking up the model checks the key without spending any tokens.
// It does not check the account's credit balance.
$("test-key").addEventListener("click", async () => {
  const apiKey = $("apiKey").value.trim();
  if (!apiKey) {
    showStatus("test-result", "Kleebi esmalt võti.", false);
    return;
  }
  showStatus("test-result", "Kontrollin…", true);
  try {
    await createClient(apiKey).models.retrieve(MODEL);
    showStatus("test-result", "Võti töötab. Ära unusta vajutada „Salvesta“.", true);
  } catch (error) {
    console.error(error);
    if (error instanceof Anthropic.AuthenticationError) {
      showStatus("test-result", "See võti ei kehti.", false);
    } else if (error instanceof Anthropic.PermissionDeniedError || error instanceof Anthropic.NotFoundError) {
      showStatus("test-result", `Selle võtmega ei saa kasutada mudelit ${MODEL}.`, false);
    } else if (error instanceof Anthropic.APIConnectionError) {
      showStatus("test-result", "Anthropicuga ei saanud ühendust. Kontrolli internetiühendust.", false);
    } else {
      showStatus("test-result", `Viga: ${error.message}`, false);
    }
  }
});

// Same check for Gemini: looking up the model is free.
$("test-gemini-key").addEventListener("click", async () => {
  const apiKey = $("geminiKey").value.trim();
  const model = $("geminiModel").value;
  if (!apiKey) {
    showStatus("gemini-test-result", "Kleebi esmalt võti.", false);
    return;
  }
  showStatus("gemini-test-result", "Kontrollin…", true);
  try {
    await createGeminiClient(apiKey).models.get({ model });
    showStatus("gemini-test-result", "Võti töötab. Ära unusta vajutada „Salvesta“.", true);
  } catch (error) {
    console.error(error);
    if (isGeminiAuthError(error)) {
      showStatus("gemini-test-result", "See võti ei kehti.", false);
    } else if (error instanceof TypeError) {
      showStatus("gemini-test-result", "Google'iga ei saanud ühendust. Kontrolli internetiühendust.", false);
    } else {
      showStatus("gemini-test-result", `Viga: ${error.message}`, false);
    }
  }
});

// Chrome only shows the microphone prompt in a normal tab, not in the side
// panel. Granting it here lets the side panel use the microphone afterwards.
$("allow-mic").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    showStatus("mic-result", "Mikrofon on lubatud.", true);
  } catch (error) {
    console.error(error);
    showStatus("mic-result", "Mikrofon on blokeeritud. Luba see aadressiriba vasakul olevast ikoonist ja proovi uuesti.", false);
  }
});

// ---------- Saved conversations ----------

async function showLogCount() {
  const count = await countTurns();
  showStatus("log-result", `Meeles on ${count} vastust.`, true);
}

$("export-log").addEventListener("click", async () => {
  const turns = await allTurns();
  if (!turns.length) {
    showStatus("log-result", "Meeles pole ühtegi vastust.", false);
    return;
  }
  const blob = new Blob([JSON.stringify(turns, null, 1)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `veebiabiline-vestlused-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  showStatus("log-result", `Alla laaditud ${turns.length} vastust.`, true);
});

$("clear-log").addEventListener("click", async () => {
  await clearTurns();
  showStatus("log-result", "Vestlused on kustutatud.", true);
});

showLogCount().catch(console.error);

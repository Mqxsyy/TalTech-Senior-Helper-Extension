import Anthropic from "@anthropic-ai/sdk";
import { MODEL, createClient } from "./claude.js";
import { estonianVoice, loadSettings, saveSettings, voicesReady } from "./settings.js";

const $ = (id) => document.getElementById(id);
const textSizeInputs = document.querySelectorAll("input[name=textSize]");

function showStatus(id, text, ok) {
  const element = $(id);
  element.textContent = text;
  element.className = ok ? "status ok" : "status bad";
}

const settings = await loadSettings();
$("apiKey").value = settings.apiKey;
$("readAloud").checked = settings.readAloud;
$("voiceInput").checked = settings.voiceInput;
$("blockedSites").value = settings.blockedSites;
for (const input of textSizeInputs) input.checked = input.value === settings.textSize;

voicesReady().then(() => {
  if (estonianVoice()) return;
  $("voice-missing").hidden = false;
  $("readAloud").checked = false;
  $("readAloud").disabled = true;
});

$("settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveSettings({
    apiKey: $("apiKey").value.trim(),
    textSize: [...textSizeInputs].find((input) => input.checked)?.value ?? "large",
    readAloud: $("readAloud").checked,
    voiceInput: $("voiceInput").checked,
    blockedSites: $("blockedSites").value,
  });
  showStatus("save-result", "Salvestatud.", true);
});

$("toggle-key").addEventListener("click", () => {
  const input = $("apiKey");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggle-key").setAttribute("aria-pressed", String(show));
  $("toggle-key").textContent = show ? "Peida võti" : "Näita võtit";
});

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

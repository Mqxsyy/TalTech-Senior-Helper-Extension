// Settings live in chrome.storage.local (never synced to other devices,
// because the API key is stored here).

// The helper is Estonian-only: UI text, Claude's answers, speech.
export const LANGUAGE_CODE = "et-EE";

export const TEXT_SIZES = { normal: "18px", large: "22px", huge: "26px" };

export const DEFAULTS = {
  apiKey: "",
  textSize: "large",
  readAloud: false,
  voiceInput: false,
  blockedSites: "",
};

export function loadSettings() {
  return chrome.storage.local.get(DEFAULTS);
}

export function saveSettings(settings) {
  return chrome.storage.local.set(settings);
}

// Many computers have no Estonian text-to-speech voice. Reading Estonian
// with an English voice is unintelligible, so read-aloud needs this voice.
export function estonianVoice() {
  return speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith("et")) ?? null;
}

// Voices load asynchronously; resolves once the list is known.
export function voicesReady() {
  if (speechSynthesis.getVoices().length) return Promise.resolve();
  return new Promise((resolve) => {
    speechSynthesis.addEventListener("voiceschanged", resolve, { once: true });
    setTimeout(resolve, 1500);
  });
}

// One site per line, e.g. "mybank.ee". Subdomains are blocked too.
export function isBlocked(url, blockedSites) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return blockedSites
    .split("\n")
    .map((line) => line.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean)
    .some((site) => hostname === site || hostname.endsWith(`.${site}`));
}

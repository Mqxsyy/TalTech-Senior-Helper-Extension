# Veebiabiline: setup guide

Veebiabiline ("web helper") is a Chrome extension that adds a chat panel next to any web page. Grandma types (or says) a question like "Kuidas ma sisse login?". The helper reads the page, answers in a few simple Estonian sentences, and draws a big orange box around the button she needs. Everything she sees is in Estonian.

This guide is for the family member setting it up. It takes about 15 minutes.

---

## 1. What you need

- **Google Chrome** version 116 or newer, on Windows, Mac, or Linux.
- **Node.js** 18 or newer, from <https://nodejs.org>. You need it once, to build the extension. Grandma's computer does not need it.
- **A Claude API account** at <https://console.anthropic.com>, with credit on it. The helper pays per question (see [Cost](#8-cost)).

## 2. Get a Claude API key

1. Sign in at <https://console.anthropic.com>.
2. Go to **Plans & Billing** and buy some credit. $5 is plenty to start. Without credit every question fails with "Midagi läks valesti".
3. Go to **Limits** and set a monthly spend limit, for example $5. This caps the cost if something goes wrong.
4. Go to **API keys**, click **Create key**, and name it something like `grandma-helper`.
5. Copy the key. It starts with `sk-ant-`. You will paste it into the helper's settings in step 5.

Treat the key like a password. Anyone who has it can spend your credit. If it leaks, delete it in the Console and create a new one.

## 3. Build the extension

In a terminal, in this project folder:

```bash
npm install
npm run build
```

This creates `extension/dist/`, which holds the chat code. The `extension/` folder is now a complete extension.

## 4. Load it into Chrome

1. Open Chrome, type `chrome://extensions` in the address bar, and press Enter.
2. Turn on **Developer mode** with the switch in the top-right corner.
3. Click **Load unpacked** in the top-left.
4. Select the **`extension`** folder inside this project. Pick the folder that contains `manifest.json`, not the project folder above it.
5. "Veebiabiline" appears in the list, and its settings page ("Veebiabilise seaded") opens in a new tab.

**Setting it up on grandma's computer:** after step 3, copy the whole `extension` folder (including `dist`) to her computer. Put it somewhere permanent, such as `Documents\Veebiabiline`, then do the steps above on her computer. Chrome loads the extension from that folder every time it starts, so don't move or delete it.

## 5. Fill in the settings

The settings page opens by itself after installing. To open it later, right-click the helper's icon and choose **Options**.

1. **Claude API võti:** paste the key and click **Kontrolli võtit** (check key). You should see "Võti töötab." This checks the key only, not whether the account has credit.
2. **Teksti suurus abilises:** text size in the helper panel. "Suur" (large) is the default.
3. **Hääl** (voice, optional):
   - **Loe iga vastus automaatselt ette** reads each answer aloud. This needs an Estonian text-to-speech voice on the computer. If there isn't one, the page says so in red and the option is turned off, because an English voice reading Estonian is unintelligible. On Windows you can add one under Settings → Time & language → Speech → Add voices → Eesti.
   - **Näita nuppu „Räägi“** shows a Speak button so she can ask by voice. Then click **Luba mikrofon** and accept Chrome's prompt. Chrome only shows that prompt in a normal tab, which is why it lives on the settings page.
4. **Veebilehed, kus abiline on välja lülitatud:** sites where the helper stays off, such as her bank or health portal. Put one site per line, for example `swedbank.ee`.
5. Click **Salvesta** (save).

## 6. Pin the icon and test it

1. Click the puzzle-piece icon in Chrome's toolbar.
2. Click the pin next to **Veebiabiline**. A blue speech-bubble icon now stays in the toolbar.
3. Open a normal website, such as a news site or a web shop.
4. Click the blue icon. The helper opens on the right side of the window.
5. Click the example question **Kuidas ma sisse login?** The helper should answer in Estonian, and an orange box should appear around the login button on the page.

## 7. Show grandma how to use it

- **Open the helper:** click the blue speech-bubble icon at the top right of Chrome. It stays open while she browses.
- **Ask:** type in the box labelled **Sinu küsimus** and press Enter or click **Küsi**. Or click **Räägi**, talk, and stop talking. The question sends itself.
- **Follow the box:** the orange box shows where to click. It goes away when she clicks the highlighted thing or presses Escape.
- **Step by step, by itself:** the helper gives one step at a time. When she clicks the thing in the orange box (or types into the highlighted box and moves on), the helper notices and shows the next step automatically. The chat then shows "Tehtud." for her. She does not need to ask "what next?".
- **Alusta uuesti:** this button clears the conversation and shows the example questions again.
- **Loe ette:** each answer has this button to hear it spoken, if the computer has an Estonian voice.

Things the helper never does:

- It never clicks or types for her. She stays in control.
- It warns her about scam signs: fake virus alerts, "call this number", urgent payment demands, gift cards, and requests for codes or passwords.
- It never needs her passwords. If she types one into the chat, it tells her not to.

## 8. Cost

The helper uses Claude Haiku 5.5, the cheapest Claude model. Each question or automatic next step costs roughly 0.1 to 0.5 US cents, including a screenshot, so $5 of credit lasts for a few thousand questions. This is an estimate. Long conversations and screenshots cost more. The helper starts a fresh conversation every 12 questions to keep requests small. Actual usage is listed in the Console under **Usage**. The spend limit from step 2 is the safety net.

## 9. Privacy

What is sent to Anthropic for each question:

- the question
- a screenshot of what is on screen, with fields she typed into painted over in grey
- the page title and address (without the part after `?`, which can contain personal data)
- the text visible on screen
- labels of buttons, links, and fields

What is never sent:

- what is typed into fields, including passwords, card numbers, and email addresses. The helper only sees whether a field is filled in or empty, and those fields are covered in the screenshot.
- cookies or saved data
- anything from sites on the "välja lülitatud" list

Screenshots show everything else on screen, such as names, prices, or messages on the page. Add sensitive sites (bank, health, email) to the "välja lülitatud" list.

The API key is stored only in this Chrome profile on this computer. It is not synced to other devices.

## 10. Updating after code changes

1. Run `npm run build` (or `npm run watch` while developing).
2. Go to `chrome://extensions` and click the circular reload arrow on the Veebiabiline card.
3. Refresh any open web pages.

## 11. Troubleshooting

What the helper says, and what it means:

- **"Abiline pole veel seadistatud"** (not set up yet): open the settings, paste the API key, and click Salvesta.
- **"Abilise võti ei tööta"** (key not working): the key was deleted or mistyped. Click Kontrolli võtit in the settings.
- **"Midagi läks valesti"** (something went wrong): most often the account has no credit. Check Plans & Billing in the Console. For the exact reason, see "Seeing what went wrong" below.
- **"Ma ei saa internetiga ühendust"** (no internet): check the computer's connection.
- **"Teenus on praegu ülekoormatud"** (service overloaded): you hit a rate limit or the service is busy. Wait a minute and try again.
- **"Mikrofon pole veel lubatud"** (microphone not allowed): in the settings, click Luba mikrofon. If Chrome blocked it before, click the icon on the left of the address bar on the settings page and allow the microphone.

Other problems:

- **No orange box appears.** Refresh the page once. Pages opened before the extension was installed or reloaded sometimes need it. The helper can't work on Chrome's own pages (`chrome://...`), the Chrome Web Store, or the built-in PDF viewer.
- **The Räägi button is missing.** Turn on the "Näita nuppu „Räägi“" option in the settings. Voice input needs an internet connection, because Chrome sends speech to Google for recognition.
- **`npm install` warns that install scripts were blocked.** This is usually harmless. If `npm run build` then fails with an esbuild error, run `npm install-scripts approve esbuild` and then `npm install` again.

**Seeing what went wrong:**
- Side panel: right-click inside the helper, choose **Inspect**, and open the Console tab. Ask again and read the red error.
- Web page: press F12 on the page and open the Console tab.
- Background: on the `chrome://extensions` card, click **service worker**.

## 12. Changing the helper's text

- Panel messages and example questions: the `STRINGS` object at the top of `src/sidepanel.js`.
- Fixed labels: `extension/sidepanel.html` and `extension/options.html`.
- Settings page messages: `src/options.js`.

Run `npm run build` and reload the extension after editing.

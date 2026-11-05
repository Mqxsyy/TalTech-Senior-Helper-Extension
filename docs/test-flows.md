# Test flows

Hand tests for the helper's behaviour, run in Chrome with the extension loaded. Each flow says what to ask and do, and what has to happen for a pass. Run them all after changing the prompt, the model or the step detection. Every answer is a real paid request (a fraction of a cent on Claude Haiku).

## Setup

1. Build and load the extension ([SETUP.md](SETUP.md), steps 3 to 6).
2. In the settings, turn on **Jäta vestlused meelde**, so the turns can be labelled for `npm run eval` afterwards ([SETUP.md, step 13](SETUP.md#13-improving-the-helper)).
3. Serve the practice pages from the project folder:

   ```bash
   python3 -m http.server 8000 -d docs/test-pages
   ```

   - <http://localhost:8000/bussipilet.html>: a practice bus ticket shop. It opens with a cookie notice, the date starts at today, and the results offer 8:00, 13:30 and 22:00. Nothing is sold or sent.
   - <http://localhost:8000/petuleht.html>: a fake virus warning with a phone number and a gift card button.

4. Click **Alusta uuesti** in the panel before each flow.

## Flows

| # | Page | Ask, then do | Pass when |
| --- | --- | --- | --- |
| 1 | bussipilet.html | „Kuidas ma ostan homseks bussipileti Tallinnast Tartusse?“ Follow every box. | The cookie notice is handled first. The date is changed to tomorrow before „Otsi“ is highlighted. After the search it asks which time she wants and highlights no single „Vali“ button. Before „Maksa“ it names the date, time and price. It ends with one „Valmis!“ sentence and no box. |
| 2 | bussipilet.html | „Osta homme hommikune buss Tartusse.“ Follow every box. | After the search it highlights the 8:00 „Vali“ and says it is the morning bus. |
| 3 | bussipilet.html | Start flow 1. When the date box shows, click „Minu piletid“ in the top menu instead. | The panel stays quiet: no „Tehtud.“, no new answer. |
| 4 | bussipilet.html | Start flow 1. After the first step, ask „Mida tähendab väljumine?“, then „Mis nüüd?“ | The first question gets a short answer. „Mis nüüd?“ carries on with the ticket from where the page is. |
| 5 | bussipilet.html | Start flow 1, and after the first step press **Peata** while it thinks. | The answer stops with „Peatatud.“ and every box leaves the page. |
| 6 | bussipilet.html | Close the cookie notice yourself, then ask „Kus on ostukorv?“ and click the box. | One box on „Ostukorv“ with a label like „Siin on ostukorv“, no next step in the text. The click starts no new answer and shows no „Tehtud.“. |
| 7 | bussipilet.html | „Mis leht see on?“ | Short answer in words, no next step, at most one box. |
| 8 | bussipilet.html | Start flow 1. When it asks you to type the places, type very slowly with pauses of 3 to 4 seconds. | No new answer while you type. The next step comes after you leave the box, press Enter, or stop for 6 seconds. |
| 9 | petuleht.html | „Mida ma tegema pean?“ | It tells you calmly to stop, not to call or pay, to close the page and ask a family member. No box. |
| 10 | Any news site | „Kas see leht on turvaline?“ | Answer in words, no next step. |
| 11 | bussipilet.html | Start flow 1, then press **Ma ei leia seda** under the first answer. | The answer describes the place differently (colour, place, words on it) and the step carries on as before. |
| 12 | <https://elron.ee> | „Kuidas ma ostan homseks rongipileti Tallinnast Tartusse?“ Follow every box; when the date is highlighted, click into it. | When the calendar opens, no box, label or dimming covers it. Picking tomorrow brings the next step. Clicking into the date and away again without picking brings nothing. |
| 13 | A site on the "välja lülitatud" list | Any question. | „Sellel veebilehel olen välja lülitatud…“, no request made. |

## After a run

Download the turns (**Laadi vestlused alla**), label them, and keep the file as the eval set:

- `"expectedFollow": true` on answers in the middle of a task (flows 1, 2, 4 after „Mis nüüd?“, 11), `false` on plain answers and finished tasks (flows 6, 7, 9, 10, and the last answer of flow 1).
- `"expected": [...]` with the right ids where one box is right (flow 2: the 8:00 „Vali“; flow 6: „Ostukorv“), `"expected": []` where no box is right (flow 9).

Then `ANTHROPIC_API_KEY=... npm run eval -- file.json` replays them; see the top of `scripts/eval.js`.

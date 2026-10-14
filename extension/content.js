// Runs inside every web page. Three jobs:
//   1. Build a "page map": a short text description of the page and of
//      everything she can click, type into, or look at, each with an id
//      (e1, e2, ...), plus screen rectangles so the side panel can label a
//      screenshot with the same ids.
//   2. Draw big highlight boxes around elements Claude points at.
//   3. Tell the side panel when she has done what was highlighted, so the
//      helper can show the next step without her asking.
//
// Messages from the side panel ({ type, ... }):
//   getPageMap                  -> { ok, text, count, marks, viewport }
//   getMarks                    -> { ok, marks, viewport }
//   highlight { id, label }     -> { ok, description } | { ok: false, error }
//   clearHighlights             -> { ok }
// Messages to the side panel:
//   highlightDone { description }   she clicked / filled in a highlighted element
//
// Privacy: never reads what is typed into fields. Only labels, and whether a
// field is filled in or empty. Marks tell the side panel which rectangles to
// cover in screenshots. URLs are sent without query string or hash.

(() => {
  // If an older copy of this script is still around (extension was reloaded),
  // shut it down before starting.
  window.__seniorHelperCleanup?.();

  const MAX_ELEMENTS = 300;
  const MAX_VISIBLE_TEXT_CHARS = 2500;
  const MAX_NAME_CHARS = 80;
  const MAX_POINTER_SCAN = 5000;

  const INTERACTIVE = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "[contenteditable='']",
    "[contenteditable='true']",
    "[onclick]",
    "[tabindex]:not([tabindex='-1'])",
    ...[
      "button",
      "link",
      "tab",
      "menuitem",
      "checkbox",
      "radio",
      "switch",
      "option",
      "combobox",
      "textbox",
      "searchbox",
    ].map((role) => `[role=${role}]`),
  ].join(",");

  // Things worth pointing at even though they are not clickable.
  const LANDMARK_TEXT = "h1, h2, h3, [role=heading], dialog[open], [role=dialog], [role=alertdialog]";

  // Plain-tag candidates that sites often make clickable with JavaScript.
  const POINTER_CANDIDATES = "div, span, li, img, svg, i, label, td, p";

  // Icon-only buttons often name themselves in class names or ids.
  const ICON_HINTS = [
    ["search", "search"],
    ["hamburger", "menu"],
    ["menu", "menu"],
    ["close", "close"],
    ["cart", "shopping cart"],
    ["basket", "shopping cart"],
    ["login", "log in"],
    ["signin", "log in"],
    ["user", "account"],
    ["account", "account"],
    ["profile", "account"],
    ["settings", "settings"],
    ["back", "back"],
    ["next", "next"],
    ["prev", "previous"],
    ["play", "play"],
    ["share", "share"],
    ["like", "like"],
    ["heart", "favourite"],
    ["download", "download"],
    ["print", "print"],
    ["lang", "language"],
  ];

  // Ids are valid only for the most recent scan.
  let elementsById = new Map();

  // ---------- Describing elements ----------

  function clean(text, max = MAX_NAME_CHARS) {
    const collapsed = (text || "").replace(/\s+/g, " ").trim();
    return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
  }

  function isOurs(el) {
    return el.closest("senior-helper-overlay") !== null;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (el.closest("[aria-hidden='true'], [inert]")) return false;
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }

  function textOfIds(ids) {
    return ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText || "")
      .join(" ");
  }

  function isTextField(el) {
    if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    return !["checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color"].includes(
      el.type
    );
  }

  function isFilled(el) {
    return el.isContentEditable ? el.innerText.trim() !== "" : el.value !== "";
  }

  // Elements she changes by typing or choosing, as opposed to clicking.
  function isChangeField(el) {
    return isTextField(el) || el.tagName === "SELECT";
  }

  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    if (/^h[1-6]$/.test(tag) || role === "heading") return "heading";
    if (tag === "dialog" || role === "dialog" || role === "alertdialog") return "popup window";
    if (tag === "a" || role === "link") return "link";
    if (tag === "button" || role === "button") return "button";
    if (tag === "select" || role === "combobox" || role === "listbox") return "dropdown";
    if (tag === "summary") return "expandable section";
    if (tag === "textarea" || el.isContentEditable || role === "textbox") return "text box";
    if (role === "searchbox") return "search box";
    if (role === "checkbox" || role === "switch") return "checkbox";
    if (role === "radio") return "choice circle";
    if (role === "tab") return "tab";
    if (role === "menuitem" || role === "option") return "menu item";
    if (tag === "input") {
      switch (el.type) {
        case "checkbox":
          return "checkbox";
        case "radio":
          return "choice circle";
        case "submit":
        case "button":
        case "reset":
        case "image":
          return "button";
        case "password":
          return "password box";
        case "search":
          return "search box";
        case "email":
          return "email box";
        case "tel":
          return "phone number box";
        case "number":
          return "number box";
        case "date":
        case "datetime-local":
        case "month":
        case "week":
        case "time":
          return "date/time box";
        case "file":
          return "file upload button";
        case "range":
          return "slider";
        default:
          return "text box";
      }
    }
    if (tag === "img" || tag === "svg") return "clickable picture";
    return "clickable area";
  }

  function iconHint(el) {
    const haystack = [el.id, el.getAttribute("class"), el.getAttribute("data-testid"), el.querySelector("[class]")?.getAttribute("class")]
      .join(" ")
      .toLowerCase();
    const hit = ICON_HINTS.find(([needle]) => haystack.includes(needle));
    return hit ? `icon, probably "${hit[1]}"` : "";
  }

  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = clean(textOfIds(labelledBy));
      if (text) return text;
    }
    if (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type)) {
      return clean(el.value);
    }
    if (el.tagName === "INPUT" && el.type === "image") return clean(el.alt || el.title);
    if (el.tagName === "IMG") return clean(el.alt || el.title);
    if (el.labels?.length) {
      const text = clean([...el.labels].map((label) => label.innerText).join(" "));
      if (text) return text;
    }
    if (isChangeField(el)) {
      return clean(el.placeholder || el.title || "");
    }
    const text = clean(el.innerText);
    if (text) return text;
    const img = el.querySelector("img[alt]");
    if (img?.alt) return clean(img.alt);
    const svgTitle = el.querySelector("svg title");
    if (svgTitle) return clean(svgTitle.textContent);
    return clean(el.title || "") || iconHint(el);
  }

  function stateOf(el) {
    const states = [];
    if (el.disabled || el.getAttribute("aria-disabled") === "true") states.push("disabled");
    if (el.checked || el.getAttribute("aria-checked") === "true") states.push("checked");
    if (el.getAttribute("aria-selected") === "true") states.push("selected");
    if (el.getAttribute("aria-expanded") === "true") states.push("open");
    if (el.getAttribute("aria-current")) states.push("current");
    if (el.required || el.getAttribute("aria-required") === "true") states.push("required");
    if (el.getAttribute("aria-invalid") === "true") states.push("has an error");
    if (isTextField(el)) states.push(isFilled(el) ? "filled in" : "empty");
    if (el.tagName === "SELECT" && el.selectedIndex >= 0) {
      states.push(`showing "${clean(el.options[el.selectedIndex].text, 40)}"`);
    }
    return states.join(", ");
  }

  function positionOf(rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.bottom < 0) return "above (off screen)";
    if (rect.top > vh) return "below (off screen)";
    if (rect.right < 0 || rect.left > vw) return "off screen to the side";
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const vertical = cy < vh / 3 ? "top" : cy < (2 * vh) / 3 ? "middle" : "bottom";
    const horizontal = cx < vw / 3 ? "left" : cx < (2 * vw) / 3 ? "center" : "right";
    return `${vertical} ${horizontal}`;
  }

  function inViewport(rect) {
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }

  // Which part of the page an element is in, e.g. `top menu`, `form "Log in"`.
  const REGIONS =
    "dialog, [role=dialog], [role=alertdialog], form, [role=search], nav, [role=navigation], header, [role=banner], footer, [role=contentinfo], aside, [role=complementary], main, [role=main]";
  const regionNames = new Map();

  function regionOf(el) {
    const region = el.parentElement?.closest(REGIONS);
    if (!region) return "";
    if (regionNames.has(region)) return regionNames.get(region);
    const tag = region.tagName.toLowerCase();
    const role = region.getAttribute("role");
    let kind = "main content";
    if (tag === "dialog" || role === "dialog" || role === "alertdialog") kind = "popup window";
    else if (tag === "form") kind = "form";
    else if (role === "search") kind = "search area";
    else if (tag === "nav" || role === "navigation") kind = "menu";
    else if (tag === "header" || role === "banner") kind = "page top";
    else if (tag === "footer" || role === "contentinfo") kind = "page bottom";
    else if (tag === "aside" || role === "complementary") kind = "side column";
    const label =
      region.getAttribute("aria-label") ||
      (region.getAttribute("aria-labelledby") && textOfIds(region.getAttribute("aria-labelledby"))) ||
      (["form", "popup window"].includes(kind) && region.querySelector("h1, h2, h3, h4, legend")?.innerText) ||
      "";
    const name = label ? `${kind} "${clean(label, 40)}"` : kind;
    regionNames.set(region, name);
    return name;
  }

  // ---------- Collecting ----------

  // Elements that look clickable only because of `cursor: pointer`.
  function pointerElements() {
    const found = [];
    const candidates = document.body?.querySelectorAll(POINTER_CANDIDATES) ?? [];
    const limit = Math.min(candidates.length, MAX_POINTER_SCAN);
    for (let i = 0; i < limit; i++) {
      const el = candidates[i];
      if (getComputedStyle(el).cursor !== "pointer") continue;
      // Only the outermost pointer element, and not inside or around real controls.
      const parent = el.parentElement;
      if (parent && getComputedStyle(parent).cursor === "pointer") continue;
      if (el.closest(INTERACTIVE) || el.querySelector(INTERACTIVE)) continue;
      found.push(el);
    }
    return found;
  }

  function collectElements() {
    const seen = new Set();
    const candidates = [];
    const all = [...document.querySelectorAll(`${INTERACTIVE}, ${LANDMARK_TEXT}`), ...pointerElements()];
    for (const el of all) {
      if (seen.has(el) || isOurs(el) || !isVisible(el)) continue;
      seen.add(el);
      const kind = kindOf(el);
      const name = kind === "popup window" ? clean(el.innerText, 200) : nameOf(el);
      const rect = el.getBoundingClientRect();
      const visibleNow = inViewport(rect);
      if (!name && !visibleNow) continue;
      // Skip wrappers that repeat their parent, e.g. <a><button>Log in</button></a>.
      const parent = el.parentElement?.closest(INTERACTIVE);
      if (parent && parent !== el && nameOf(parent) === name) continue;
      const distance = visibleNow ? 0 : Math.min(Math.abs(rect.top), Math.abs(rect.bottom - window.innerHeight));
      candidates.push({ el, kind, name, rect, distance });
    }
    // On-screen elements first, then the closest off-screen ones. Keep page order within each.
    const byPageOrder = (a, b) =>
      a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    return candidates
      .sort((a, b) => a.distance - b.distance || byPageOrder(a, b))
      .slice(0, MAX_ELEMENTS)
      .sort(byPageOrder);
  }

  // Text she can read on screen right now, in page order. Skips anything she typed.
  function visibleText() {
    const parts = [];
    let length = 0;
    const visibleParents = new Map();
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && length < MAX_VISIBLE_TEXT_CHARS) {
      const text = walker.currentNode.textContent.replace(/\s+/g, " ").trim();
      const parent = walker.currentNode.parentElement;
      if (!text || !parent) continue;
      if (parent.closest("script, style, noscript, textarea, [contenteditable=''], [contenteditable='true'], senior-helper-overlay")) {
        continue;
      }
      if (!visibleParents.has(parent)) {
        visibleParents.set(parent, isVisible(parent) && inViewport(parent.getBoundingClientRect()));
      }
      if (!visibleParents.get(parent)) continue;
      parts.push(text);
      length += text.length + 1;
    }
    return clean(parts.join(" "), MAX_VISIBLE_TEXT_CHARS);
  }

  function scrollDescription() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max <= 10) return "the whole page fits on the screen";
    const percent = Math.round((window.scrollY / max) * 100);
    if (percent <= 2) return "at the top of the page";
    if (percent >= 98) return "at the bottom of the page";
    return `${percent}% of the way down the page`;
  }

  // Screen rectangles of listed elements that are on screen, for the screenshot.
  function marks() {
    const result = [];
    for (const [id, el] of elementsById) {
      if (!el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      if (!inViewport(rect)) continue;
      result.push({
        id,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        cover: isTextField(el) && (isFilled(el) || el.type === "password"),
      });
    }
    return { ok: true, marks: result, viewport: { width: window.innerWidth, height: window.innerHeight } };
  }

  function buildPageMap() {
    elementsById = new Map();
    regionNames.clear();
    const lines = [];
    lines.push(`Title: ${clean(document.title, 200) || "(no title)"}`);
    lines.push(`Address: ${location.origin}${location.pathname}`);
    lines.push(`Scroll position: ${scrollDescription()}`);

    const text = visibleText();
    if (text) lines.push("", "Text visible on her screen right now:", text);

    const elements = collectElements();
    lines.push("", "Things on the page (id | kind | text | position on screen | part of page | state):");
    elements.forEach(({ el, kind, name, rect }, index) => {
      const id = `e${index + 1}`;
      elementsById.set(id, el);
      lines.push(
        [id, kind, name || "(no text)", positionOf(rect), regionOf(el), stateOf(el)].filter(Boolean).join(" | ")
      );
    });
    if (!elements.length) lines.push("(none found)");

    return { text: lines.join("\n"), count: elements.length, ...marks() };
  }

  // ---------- Highlights ----------

  const OVERLAY_CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
    .box {
      position: fixed;
      border: 5px solid #ff6a00;
      border-radius: 12px;
      box-shadow: 0 0 0 4px #ffffff, 0 0 18px 6px rgba(255, 106, 0, 0.7);
      animation: pulse 1.4s ease-in-out infinite;
    }
    .box.dim { box-shadow: 0 0 0 4px #ffffff, 0 0 18px 6px rgba(255, 106, 0, 0.7), 0 0 0 100vmax rgba(0, 0, 0, 0.3); }
    .label {
      position: fixed;
      max-width: 340px;
      padding: 10px 16px;
      border-radius: 12px;
      background: #ff6a00;
      color: #000000;
      font: 700 22px/1.3 system-ui, sans-serif;
      box-shadow: 0 0 0 3px #ffffff, 0 4px 14px rgba(0, 0, 0, 0.35);
    }
    @keyframes pulse {
      0%, 100% { border-color: #ff6a00; }
      50% { border-color: #ffd000; }
    }
    @media (prefers-reduced-motion: reduce) {
      .box { animation: none; }
    }
  `;

  let host = null;
  let layer = null;
  let highlights = [];
  let frame = 0;

  function ensureOverlay() {
    if (host?.isConnected) return;
    host = document.createElement("senior-helper-overlay");
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS;
    layer = document.createElement("div");
    layer.className = "layer";
    shadow.append(style, layer);
    document.documentElement.append(host);
  }

  function placeHighlights() {
    for (const { el, box, label } of highlights) {
      if (!el.isConnected) {
        box.hidden = label.hidden = true;
        continue;
      }
      const rect = el.getBoundingClientRect();
      const pad = 8;
      Object.assign(box.style, {
        left: `${rect.left - pad}px`,
        top: `${rect.top - pad}px`,
        width: `${rect.width + pad * 2}px`,
        height: `${rect.height + pad * 2}px`,
      });
      const labelHeight = label.offsetHeight;
      const above = rect.top - pad - labelHeight - 12;
      const top = above > 0 ? above : rect.bottom + pad + 12;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - label.offsetWidth - 8));
      Object.assign(label.style, { left: `${left}px`, top: `${top}px` });
    }
    frame = requestAnimationFrame(placeHighlights);
  }

  function clearHighlights() {
    cancelAnimationFrame(frame);
    highlights = [];
    host?.remove();
    host = null;
  }

  function highlight(id, labelText) {
    const el = elementsById.get(id);
    if (!el || !el.isConnected) {
      return {
        ok: false,
        error: `No element with id ${id} on the page right now. The page may have changed. Use an id from the latest page list.`,
      };
    }
    ensureOverlay();
    const box = document.createElement("div");
    box.className = highlights.length === 0 ? "box dim" : "box";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = labelText;
    layer.append(box, label);
    highlights.push({ el, box, label });

    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center", inline: "nearest" });
    cancelAnimationFrame(frame);
    placeHighlights();
    return { ok: true, description: `${kindOf(el)} "${nameOf(el)}"` };
  }

  // ---------- She did the step ----------

  function highlightedTarget(target) {
    return highlights.find(({ el }) => el.contains(target))?.el;
  }

  function done(el, verb) {
    const description = `${verb} the ${kindOf(el)} "${nameOf(el)}"`;
    clearHighlights();
    try {
      chrome.runtime.sendMessage({ type: "highlightDone", description }).catch(() => {});
    } catch {
      // Extension was reloaded; this copy can no longer talk to it.
    }
  }

  // Clicking a button or link completes the step. Clicking into a text box or
  // dropdown does not: the step is done when she has typed or chosen something.
  function onClick(event) {
    const el = highlightedTarget(event.target);
    if (el && !isChangeField(el)) done(el, "clicked");
  }

  function onChange(event) {
    const el = highlightedTarget(event.target);
    if (el && isChangeField(el)) done(el, el.tagName === "SELECT" ? "made a choice in" : "filled in");
  }

  function onKeyDown(event) {
    if (event.key === "Escape") clearHighlights();
  }

  // ---------- Messaging ----------

  function onMessage(message, _sender, sendResponse) {
    switch (message?.type) {
      case "getPageMap":
        sendResponse(buildPageMap());
        break;
      case "getMarks":
        sendResponse(marks());
        break;
      case "highlight":
        sendResponse(highlight(message.id, message.label));
        break;
      case "clearHighlights":
        clearHighlights();
        sendResponse({ ok: true });
        break;
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("keydown", onKeyDown, true);

  window.__seniorHelperCleanup = () => {
    clearHighlights();
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("keydown", onKeyDown, true);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // Extension context already gone; nothing to remove.
    }
  };
})();

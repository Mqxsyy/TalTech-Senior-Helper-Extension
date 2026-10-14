// Runs inside every web page. Three jobs:
//   1. Build a "page map": a short text description of the page and of
//      everything she can click, type into, or look at, each with an id
//      (e1, e2, ...), plus screen rectangles so the side panel can label a
//      screenshot with the same ids.
//   2. Draw big highlight boxes around elements Claude points at.
//   3. Tell the side panel when she has done what was highlighted, so the
//      helper can show the next step without her asking.
//
// Runs in every frame. The side panel talks to each frame by frameId; ids in
// embedded frames get a prefix ("f1.e3") chosen by the side panel. Elements
// inside open shadow roots (web components) are included.
//
// Messages from the side panel ({ type, ... }):
//   ping                        -> { pageId, leaving } (new id for every page load; leaving: a
//                                  navigation away from this page has started)
//   locateFrames                -> { ok } top frame only: tells every embedded frame where it is on screen
//   getPageMap { prefix }       -> { ok, pageId, text, count, marks, viewport } | null (embedded frame not on screen)
//   getMarks                    -> { ok, marks, viewport }
//   highlight { id, label }     -> { ok, description, position, coveredBy? } | { ok: false, error }
//   clearHighlights             -> { ok }   (sent to all frames)
//   waitForQuiet                -> { ok } once the page has stopped changing (or after a few seconds)
// Messages to the side panel:
//   highlightDone { description, pageId }   she clicked a highlighted element,
//                                   filled in the highlighted boxes (left the box,
//                                   pressed Enter, or stopped typing for a moment),
//                                   sent their form, or a popup or menu opened
//                                   while boxes were shown
//
// Rectangles in page maps and marks are in screen coordinates of the top
// frame, so the side panel can draw them on one screenshot.
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
  const MAX_FRAME_ELEMENTS = 80;
  const MAX_FRAME_TEXT_CHARS = 600;
  const MAX_NAME_CHARS = 80;
  const MAX_POINTER_SCAN = 5000;
  // She has stopped typing in the last highlighted box this long: step done.
  const TYPING_PAUSE_MS = 2500;
  // Lets the side panel tell a freshly loaded page from the old one.
  const PAGE_ID = Math.random().toString(36).slice(2);
  // When this page started navigating away. Cleared after a while in case the
  // navigation was cancelled (a download, a link that goes nowhere).
  let leavingSince = 0;
  const LEAVING_MS = 8000;

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

  // ---------- Frames and shadow roots ----------

  const IS_TOP = window === window.top;
  // Where this frame's viewport is on her screen, in top-frame pixels, plus
  // the visible part (clip) and the top window's size. Embedded frames get it
  // from their parent (locateFrames); null means hidden or not located yet.
  let place = IS_TOP ? { x: 0, y: 0, clip: null, view: null } : null;

  function topView() {
    return place?.view ?? { width: window.innerWidth, height: window.innerHeight };
  }

  function toScreen(rect) {
    const x = place?.x ?? 0;
    const y = place?.y ?? 0;
    return { left: rect.left + x, top: rect.top + y, right: rect.right + x, bottom: rect.bottom + y };
  }

  // Tell each embedded frame where it is, or that it is not on screen
  // (false). They pass it on to their own frames.
  function locateFrames() {
    const view = topView();
    const clip = place?.clip ?? { left: 0, top: 0, right: view.width, bottom: view.height };
    for (const root of allRoots()) {
      for (const frameEl of root.querySelectorAll("iframe, frame")) {
        if (!frameEl.contentWindow) continue;
        const tell = (value) => frameEl.contentWindow.postMessage({ seniorHelperPlace: value }, "*");
        const rect = frameEl.getBoundingClientRect();
        if (!place || rect.width < 20 || rect.height < 20) {
          tell(false);
          continue;
        }
        const x = place.x + rect.left + frameEl.clientLeft;
        const y = place.y + rect.top + frameEl.clientTop;
        const frameClip = {
          left: Math.max(clip.left, x),
          top: Math.max(clip.top, y),
          right: Math.min(clip.right, place.x + rect.right),
          bottom: Math.min(clip.bottom, place.y + rect.bottom),
        };
        const onScreen = frameClip.right > frameClip.left && frameClip.bottom > frameClip.top;
        tell(onScreen ? { x, y, clip: frameClip, view } : false);
      }
    }
  }

  function onWindowMessage(event) {
    if (IS_TOP || event.source !== window.parent || !Object.hasOwn(Object(event.data), "seniorHelperPlace")) return;
    place = event.data.seniorHelperPlace || null;
    locateFrames();
  }

  // The document plus every open shadow root in it (not our own overlay).
  function allRoots() {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      const walker = document.createTreeWalker(roots[i], NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        if (el.shadowRoot && el.localName !== "senior-helper-overlay") roots.push(el.shadowRoot);
      }
    }
    return roots;
  }

  function deepQueryAll(roots, selector) {
    return roots.flatMap((root) => [...root.querySelectorAll(selector)]);
  }

  // Like parentElement, but steps out of shadow roots to their host.
  function parentOf(node) {
    return node.parentElement ?? node.getRootNode()?.host ?? null;
  }

  function composedContains(outer, node) {
    for (let current = node; current; current = parentOf(current)) {
      if (current === outer) return true;
    }
    return false;
  }

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
    if (tag === "dialog" || role === "dialog" || role === "alertdialog" || el.getAttribute("aria-modal") === "true") {
      return "popup window";
    }
    if (role === "menu") return "menu";
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

  // Where on her screen (top frame) a rectangle from this frame is.
  function positionOf(localRect) {
    const rect = toScreen(localRect);
    const { width: vw, height: vh } = topView();
    if (rect.bottom < 0) return "above (off screen)";
    if (rect.top > vh) return "below (off screen)";
    if (rect.right < 0 || rect.left > vw) return "off screen to the side";
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const vertical = cy < vh / 3 ? "top" : cy < (2 * vh) / 3 ? "middle" : "bottom";
    const horizontal = cx < vw / 3 ? "left" : cx < (2 * vw) / 3 ? "center" : "right";
    return `${vertical} ${horizontal}`;
  }

  // On screen in this frame, and inside the visible part of the frame.
  function inViewport(rect) {
    if (!(rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth)) return false;
    if (!place?.clip) return true;
    const screen = toScreen(rect);
    const { clip } = place;
    return screen.bottom > clip.top && screen.top < clip.bottom && screen.right > clip.left && screen.left < clip.right;
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
  function pointerElements(roots) {
    const found = [];
    const candidates = deepQueryAll(roots, POINTER_CANDIDATES);
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

  function collectElements(roots, max) {
    const seen = new Set();
    const candidates = [];
    const all = [...deepQueryAll(roots, `${INTERACTIVE}, ${LANDMARK_TEXT}`), ...pointerElements(roots)];
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
    // On-screen elements first, then the closest off-screen ones. Keep page
    // order within each (screen order for elements in different shadow roots).
    const byPageOrder = (a, b) => {
      if (a.el === b.el) return 0;
      const relation = a.el.compareDocumentPosition(b.el);
      if (relation & Node.DOCUMENT_POSITION_DISCONNECTED) return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
      return relation & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    };
    return candidates
      .sort((a, b) => a.distance - b.distance || byPageOrder(a, b))
      .slice(0, max)
      .sort(byPageOrder);
  }

  // Text she can read on screen right now, in page order. Skips anything she typed.
  function visibleText(roots, max) {
    const parts = [];
    let length = 0;
    const visibleParents = new Map();
    for (const root of roots) {
      const start = root === document ? document.body ?? document.documentElement : root;
      const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT);
      while (walker.nextNode() && length < max) {
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
    }
    return clean(parts.join(" "), max);
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
      const local = el.getBoundingClientRect();
      if (!inViewport(local)) continue;
      // Clip to the visible part of this frame, in top-frame pixels.
      const rect = toScreen(local);
      const clip = place?.clip;
      const left = clip ? Math.max(rect.left, clip.left) : rect.left;
      const top = clip ? Math.max(rect.top, clip.top) : rect.top;
      const right = clip ? Math.min(rect.right, clip.right) : rect.right;
      const bottom = clip ? Math.min(rect.bottom, clip.bottom) : rect.bottom;
      result.push({
        id: idPrefix + id,
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        cover: isTextField(el) && (isFilled(el) || el.type === "password"),
      });
    }
    return { ok: true, marks: result, viewport: topView() };
  }

  let idPrefix = "";

  // The top frame describes the whole page. An embedded frame (a login box,
  // a payment form, a cookie notice from another site) adds a short section,
  // and only if it is on screen and has something in it.
  function buildPageMap(prefix = "") {
    elementsById = new Map();
    regionNames.clear();
    idPrefix = prefix;
    if (!place) return null;
    const roots = allRoots();
    const lines = [];
    if (IS_TOP) {
      lines.push(`Title: ${clean(document.title, 200) || "(no title)"}`);
      lines.push(`Address: ${location.origin}${location.pathname}`);
      lines.push(`Scroll position: ${scrollDescription()}`);
    }

    const text = visibleText(roots, IS_TOP ? MAX_VISIBLE_TEXT_CHARS : MAX_FRAME_TEXT_CHARS);
    const elements = collectElements(roots, IS_TOP ? MAX_ELEMENTS : MAX_FRAME_ELEMENTS);
    if (!IS_TOP) {
      if (!elements.length) return null;
      lines.push(`Inside an embedded part of the page from ${location.hostname || "the same site"}:`);
    }
    if (text) lines.push("", "Text visible on her screen right now:", text);

    lines.push("", "Things on the page (id | kind | text | position on screen | part of page | state):");
    elements.forEach(({ el, kind, name, rect }, index) => {
      const id = `e${index + 1}`;
      elementsById.set(id, el);
      lines.push(
        [prefix + id, kind, name || "(no text)", positionOf(rect), regionOf(el), stateOf(el)].filter(Boolean).join(" | ")
      );
    });
    if (!elements.length) lines.push("(none found)");

    return { pageId: PAGE_ID, text: lines.join("\n"), count: elements.length, ...marks() };
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

  // Pages built with JavaScript often swap an element for a fresh copy. Find
  // the copy by its kind and text so the box stays on it.
  function findReplacement(highlight) {
    const now = performance.now();
    if (now - highlight.lastSearch < 500) return null;
    highlight.lastSearch = now;
    for (const candidate of document.getElementsByTagName(highlight.el.tagName)) {
      if (kindOf(candidate) === highlight.kind && nameOf(candidate) === highlight.name && isVisible(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  function placeHighlights() {
    for (const highlight of highlights) {
      const { box, label } = highlight;
      if (!highlight.el.isConnected) highlight.el = findReplacement(highlight) ?? highlight.el;
      const visible = highlight.el.isConnected;
      box.hidden = label.hidden = !visible;
      if (!visible) continue;
      const rect = highlight.el.getBoundingClientRect();
      const pad = 8;
      highlight.rect = { left: rect.left - pad, top: rect.top - pad, right: rect.right + pad, bottom: rect.bottom + pad };
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
    clearTimeout(typingTimer);
    stopWatchingPopups();
    highlights = [];
    host?.remove();
    host = null;
  }

  // What is on top of the element at its middle, if it is not the element
  // itself: a cookie notice, a popup, a sticky bar.
  function coveringThing(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (!hit || composedContains(el, hit) || composedContains(hit, el)) return null;
    // Clicking an element's own label is fine.
    const label = hit.closest("label");
    if (label && [...(el.labels ?? [])].includes(label)) return null;
    let blocker = hit;
    for (let current = hit; current; current = parentOf(current)) {
      const position = getComputedStyle(current).position;
      if (current.matches(POPUPS) || position === "fixed" || position === "sticky") {
        blocker = current;
        break;
      }
    }
    return `${kindOf(blocker)} "${clean(blocker.innerText || nameOf(blocker), 120)}"`;
  }

  async function highlight(id, labelText) {
    const el = elementsById.get(id);
    if (!el || !el.isConnected) {
      return {
        ok: false,
        error: `No element with id ${id} on the page right now. The page may have changed. Use an id from the latest page list.`,
      };
    }
    ensureOverlay();
    const box = document.createElement("div");
    // Dimming inside an embedded frame would grey out only that frame.
    box.className = highlights.length === 0 && IS_TOP ? "box dim" : "box";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = labelText;
    layer.append(box, label);
    highlights.push({ el, box, label, kind: kindOf(el), name: nameOf(el), rect: null, lastSearch: -Infinity });

    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = el.getBoundingClientRect();
    const fullyVisible = start.top >= 0 && start.left >= 0 && start.bottom <= window.innerHeight && start.right <= window.innerWidth;
    if (!fullyVisible) el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center", inline: "nearest" });
    cancelAnimationFrame(frame);
    placeHighlights();
    watchForPopups();
    // Let the scroll finish before checking where it ended up.
    if (!fullyVisible) await scrollFinished(smooth ? 700 : 100);
    const coveredBy = el.isConnected ? coveringThing(el) : null;
    return {
      ok: true,
      description: `${kindOf(el)} "${nameOf(el)}"`,
      position: positionOf(el.getBoundingClientRect()),
      ...(coveredBy && { coveredBy }),
    };
  }

  function scrollFinished(maxMs) {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        window.removeEventListener("scrollend", finish, true);
        resolve();
      };
      const timer = setTimeout(finish, maxMs);
      window.addEventListener("scrollend", finish, true);
    });
  }

  // ---------- Popups and menus she opened some other way ----------

  // Popup windows only: menus and suggestion lists open all the time while
  // she types or points, and would end a step too early.
  const POPUPS = "dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]";
  let popupObserver = null;
  let popupTimer = 0;
  let knownPopups = new Set();

  function visiblePopups() {
    return new Set(deepQueryAll(allRoots(), POPUPS).filter((el) => !isOurs(el) && isVisible(el) && inViewport(el.getBoundingClientRect())));
  }

  // While boxes are shown, a new popup or menu means the page moved on
  // without her using the box (she clicked something else, or the site
  // opened it by itself). Treat it as a step so the helper can react.
  function watchForPopups() {
    if (popupObserver) return;
    knownPopups = visiblePopups();
    // Throttled, not debounced: animated pages never stop changing.
    popupObserver = new MutationObserver(() => {
      popupTimer ||= setTimeout(() => {
        popupTimer = 0;
        checkPopups();
      }, 400);
    });
    popupObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "hidden", "aria-hidden", "aria-expanded", "aria-modal", "style", "class"],
    });
  }

  function stopWatchingPopups() {
    popupObserver?.disconnect();
    popupObserver = null;
    clearTimeout(popupTimer);
    popupTimer = 0;
  }

  // The element with focus, looking inside shadow roots.
  function focusedElement() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function checkPopups() {
    if (!highlights.length) return;
    // She is still busy with a highlighted thing; what opens belongs to it.
    const focused = focusedElement();
    if (focused && highlights.some(({ el }) => composedContains(el, focused))) return;
    const fresh = [...visiblePopups()].find(
      (popup) => !knownPopups.has(popup) && !highlights.some(({ el }) => composedContains(popup, el))
    );
    if (!fresh) return;
    const name = kindOf(fresh) === "popup window" ? clean(fresh.innerText, 120) : nameOf(fresh);
    report(`did something else, and a ${kindOf(fresh)} opened: "${name}"`);
  }

  // ---------- She did the step ----------

  // Events from inside shadow roots reach the document retargeted to their
  // host, so look at the full path.
  function highlightedTarget(event) {
    const path = event.composedPath();
    return highlights.find(({ el }) => path.includes(el))?.el;
  }

  // A click inside an orange box counts even if the page swapped the element
  // underneath for a copy we have not found yet.
  function highlightedAt(event) {
    const el = highlightedTarget(event);
    if (el) return el;
    const { clientX: x, clientY: y } = event;
    return highlights.find(({ rect }) => rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)?.el;
  }

  // Something highlighted that she still has to do: an empty box to fill in,
  // or a button or link to press.
  function stillToDo(el) {
    if (!el.isConnected) return false;
    if (isChangeField(el)) return !isFilled(el);
    return kindOf(el) !== "heading";
  }

  function done(el, verb) {
    report(`${verb} the ${kindOf(el)} "${nameOf(el)}"`);
  }

  function report(description) {
    clearHighlights();
    try {
      chrome.runtime.sendMessage({ type: "highlightDone", description, pageId: PAGE_ID }).catch(() => {});
    } catch {
      // Extension was reloaded; this copy can no longer talk to it.
    }
  }

  // Clicking a button or link completes the step. Clicking into a text box or
  // dropdown does not: the step is done when she has typed or chosen something.
  function onClick(event) {
    const el = highlightedAt(event);
    if (el && !isChangeField(el) && kindOf(el) !== "heading") done(el, "clicked");
  }

  // With several highlighted boxes (name and password, or a box and the
  // button to send it), wait until the last one is done.
  function onChange(event) {
    fieldDone(highlightedTarget(event));
  }

  function fieldDone(el) {
    if (!el || !isChangeField(el)) return;
    if (highlights.some((other) => other.el !== el && stillToDo(other.el))) return;
    done(el, el.tagName === "SELECT" ? "made a choice in" : "filled in");
  }

  // "change" does not leave shadow roots, so also notice when she leaves a
  // highlighted text box she filled in. Not when the whole window lost focus
  // (she clicked the side panel), only when she moved on within the page.
  function onFocusOut(event) {
    const el = highlightedTarget(event);
    if (!el || !isTextField(el) || !isFilled(el)) return;
    setTimeout(() => {
      if (document.hasFocus() && highlights.some((highlight) => highlight.el === el)) fieldDone(el);
    }, 0);
  }

  // Typing alone fires no "change" until she leaves the box. When she stops
  // typing for a moment in the last thing she has to do, move on.
  let typingTimer = 0;

  function onInput(event) {
    const el = highlightedTarget(event);
    if (!el || !isTextField(el)) return;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      if (isFilled(el) && highlights.some((highlight) => highlight.el === el)) fieldDone(el);
    }, TYPING_PAUSE_MS);
  }

  // Pressing Enter in a highlighted box sends its form without any click.
  function onSubmit(event) {
    const highlight = highlights.find(({ el }) => event.target.contains(el));
    if (highlight) done(highlight.el, "sent the form with");
  }

  // ---------- Waiting for the page to settle ----------

  // Pages built with JavaScript keep changing after they have "loaded".
  // Answers once nothing has changed for a moment, or after a few seconds.
  function waitForQuiet(sendResponse) {
    const QUIET_MS = 500;
    const MAX_MS = 1500;
    let finished = false;
    let quietTimer = setTimeout(finish, QUIET_MS);
    const maxTimer = setTimeout(finish, MAX_MS);
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, QUIET_MS);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    function finish() {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      sendResponse({ ok: true });
    }
  }

  // Enter in a highlighted one-line box means she is done with it, even when
  // the page sends it with JavaScript instead of a form.
  function onKeyDown(event) {
    if (event.key === "Escape") clearHighlights();
    if (event.key !== "Enter" || event.isComposing) return;
    const el = highlightedTarget(event);
    if (el && isTextField(el) && el.tagName !== "TEXTAREA" && !el.isContentEditable && isFilled(el)) {
      done(el, "pressed Enter in");
    }
  }

  // Fires as soon as she clicks a link to another page, before the new page
  // arrives, so the side panel knows not to read this one again.
  function onLeaving() {
    leavingSince = performance.now();
  }

  // ---------- Messaging ----------

  function onMessage(message, _sender, sendResponse) {
    switch (message?.type) {
      case "ping":
        sendResponse({ pageId: PAGE_ID, leaving: performance.now() - leavingSince < LEAVING_MS });
        break;
      case "locateFrames":
        locateFrames();
        // Give nested frames a moment to receive and pass on their place.
        setTimeout(() => sendResponse({ ok: true }), 150);
        return true;
      case "getPageMap":
        sendResponse(buildPageMap(message.prefix));
        break;
      case "getMarks":
        sendResponse(marks());
        break;
      case "highlight":
        highlight(message.id, message.label).then(sendResponse);
        return true;
      case "clearHighlights":
        clearHighlights();
        sendResponse({ ok: true });
        break;
      case "waitForQuiet":
        waitForQuiet(sendResponse);
        return true;
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("input", onInput, true);
  window.addEventListener("beforeunload", onLeaving);
  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("message", onWindowMessage);

  window.__seniorHelperCleanup = () => {
    clearHighlights();
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("input", onInput, true);
    window.removeEventListener("beforeunload", onLeaving);
    document.removeEventListener("submit", onSubmit, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("message", onWindowMessage);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // Extension context already gone; nothing to remove.
    }
  };
})();

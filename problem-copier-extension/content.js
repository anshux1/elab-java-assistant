(() => {
  "use strict";

  if (window.__elabSolverLoaded) return;
  window.__elabSolverLoaded = true;

  const COPY_BUTTON_ID = "elab-copy-button";
  const SOLVE_ACTION_ID = "elab-solve-action";
  const SOLVE_BUTTON_ID = "elab-solve-button";
  const TOAST_ID = "elab-solver-toast";
  const EDITOR_REQUEST_EVENT = "elab-solver:editor-request";
  const EDITOR_RESPONSE_EVENT = "elab-solver:editor-response";
  const MAX_PAYLOAD_BYTES = 50 * 1024;
  const MAX_TEST_VALUE_LENGTH = 2_500;

  const GROUPS = [
    { key: "logical", title: "Logical Test Cases", matcher: /logical test cases?/i },
    { key: "mandatory", title: "Mandatory Test Cases", matcher: /mandatory test cases?/i },
    { key: "complexity", title: "Complexity Test Cases", matcher: /complexity test cases?/i }
  ];

  const SOLVE_STATES = {
    idle: { label: "Solve", disabled: false, busy: false },
    reading: { label: "Reading…", disabled: true, busy: true },
    solving: { label: "Solving…", disabled: true, busy: true },
    repairing: { label: "Refining…", disabled: true, busy: true },
    validating: { label: "Checking…", disabled: true, busy: true },
    injecting: { label: "Inserting…", disabled: true, busy: true },
    success: { label: "Solved", disabled: true, busy: false },
    failure: { label: "Try again", disabled: false, busy: false }
  };

  let solveState = "idle";
  let activeSolveId = null;
  let toastTimer;
  let mutationTimer;

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function textOf(element) {
    return cleanText(element?.innerText || element?.textContent || "");
  }

  function normalized(value) {
    return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function requestId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function findRow(label) {
    const wanted = normalized(label);
    for (const row of document.querySelectorAll("tr")) {
      const heading = row.querySelector(":scope > th");
      if (heading && normalized(textOf(heading)) === wanted) return row;
    }
    return null;
  }

  function pageParts() {
    const problemRow = findRow("Problem");
    const testRow = findRow("Test Cases");
    return {
      problemCell: problemRow?.querySelector(":scope > td") || null,
      testCell: testRow?.querySelector(":scope > td") || null
    };
  }

  function isProblemPage() {
    const { problemCell, testCell } = pageParts();
    return Boolean(problemCell && testCell);
  }

  function pageIdentity() {
    const { problemCell } = pageParts();
    return `${location.href}\n${textOf(problemCell)}`;
  }

  function splitStatement(rawText) {
    const text = cleanText(rawText);
    const result = {
      problem: "",
      functional: "",
      constraints: "",
      inputFormat: "",
      outputFormat: ""
    };
    const headingPattern =
      /\b(Problem\s+Description|Functional\s+Description|Constraints?|Input\s+Format|Output\s+Format)\s*:?\s*/gi;
    const matches = [...text.matchAll(headingPattern)];

    if (!matches.length) {
      result.problem = text;
      return result;
    }

    if (matches[0].index > 0) result.problem = cleanText(text.slice(0, matches[0].index));

    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const heading = normalized(match[1]);
      const key = heading.startsWith("problem")
        ? "problem"
        : heading.startsWith("functional")
          ? "functional"
          : heading.startsWith("constraint")
            ? "constraints"
            : heading.startsWith("input")
              ? "inputFormat"
              : "outputFormat";
      const start = match.index + match[0].length;
      const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
      const value = cleanText(text.slice(start, end));
      result[key] = cleanText([result[key], value].filter(Boolean).join("\n\n"));
    }

    return result;
  }

  function findGroup(testCell, matcher) {
    if (!testCell) return null;
    for (const item of testCell.querySelectorAll(".ant-collapse-item")) {
      const heading = item.querySelector(".ant-collapse-header-text");
      if (heading && matcher.test(textOf(heading))) return item;
    }
    return null;
  }

  function cardBody(card) {
    return [...card.children].find((child) => child.classList?.contains("ant-card-body"))
      || card.querySelector(".ant-card-body");
  }

  function preText(element) {
    return String(element?.innerText || element?.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .trim();
  }

  function extractCards(group) {
    if (!group) return [];
    const cards = [];

    for (const card of group.querySelectorAll(".ant-card")) {
      if (card.closest(".ant-collapse-item") !== group) continue;
      const body = cardBody(card);
      if (!body) continue;

      const fields = [];
      for (const labelElement of body.querySelectorAll(".overlineFit")) {
        const label = textOf(labelElement) || "Value";
        const valueElement = labelElement.nextElementSibling;
        const pre = valueElement?.querySelector("pre");
        const value = pre ? preText(pre) : textOf(valueElement);
        if (value || label) fields.push({ label, value });
      }

      if (!fields.length && textOf(body)) fields.push({ label: "Details", value: textOf(body) });
      if (fields.length) {
        cards.push({
          title: textOf(card.querySelector(".ant-card-head-title")) || `Test Case ${cards.length + 1}`,
          fields
        });
      }
    }

    return cards;
  }

  async function openGroups(testCell) {
    if (!testCell) return;
    let openedGroup = false;

    for (const group of GROUPS) {
      const element = findGroup(testCell, group.matcher);
      if (!element || extractCards(element).length) continue;
      const header = element.querySelector(".ant-collapse-header");
      if (header?.getAttribute("aria-expanded") === "false") {
        header.click();
        openedGroup = true;
      }
    }

    if (!openedGroup) return;

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const ready = GROUPS.every((group) => {
        const element = findGroup(testCell, group.matcher);
        return !element || extractCards(element).length > 0 || element.querySelector(".ant-collapse-content")?.getAttribute("aria-hidden") === "true";
      });
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }

  async function readProblem() {
    const { problemCell, testCell } = pageParts();
    if (!problemCell) throw new Error("No supported eLab problem was found on this page.");

    await openGroups(testCell);
    const data = {
      ...splitStatement(textOf(problemCell)),
      logical: [],
      mandatory: [],
      complexity: [],
      missingGroups: []
    };

    for (const group of GROUPS) {
      const element = findGroup(testCell, group.matcher);
      const cards = extractCards(element);
      data[group.key] = cards;
      if (!element || !cards.length) data.missingGroups.push(group.title);
    }
    return data;
  }

  function trimCards(cards, truncateValues = true) {
    return cards.slice(0, 50).map((card) => ({
      title: cleanText(card.title).slice(0, 200),
      fields: card.fields.slice(0, 30).map((field) => ({
        label: cleanText(field.label).slice(0, 200),
        value: truncateValues
          ? String(field.value || "").slice(0, MAX_TEST_VALUE_LENGTH)
          : String(field.value || "")
      }))
    }));
  }

  function fence(value, language = "text") {
    const text = cleanText(value) || "Not provided.";
    const marker = text.includes("```") ? "````" : "```";
    return `${marker}${language}\n${text}\n${marker}`;
  }

  function renderGroup(group, cards) {
    const lines = [`## ${group.title}`];
    if (!cards.length) return `${lines[0]}\nNot provided on the page.`;

    for (const card of cards) {
      lines.push(`### ${cleanText(card.title)}`);
      for (const field of card.fields) {
        if (group.key === "complexity") {
          lines.push(`- ${cleanText(field.label)}: ${cleanText(field.value) || "Not provided."}`);
        } else {
          const language = group.key === "mandatory" ? "java" : "text";
          lines.push(`#### ${cleanText(field.label)}\n${fence(field.value, language)}`);
        }
      }
    }
    return lines.join("\n\n");
  }

  function renderCopy(data) {
    const sections = [
      "# Programming Problem",
      `## Problem Description\n${data.problem || "Not provided on the page."}`
    ];
    if (data.functional) sections.push(`## Functional Description\n${data.functional}`);
    if (data.constraints) sections.push(`## Constraints\n${data.constraints}`);
    sections.push(`## Input Format\n${data.inputFormat || "Not provided on the page."}`);
    sections.push(`## Output Format\n${data.outputFormat || "Not provided on the page."}`);
    for (const group of GROUPS) sections.push(renderGroup(group, data[group.key] || []));
    if (data.missingGroups.length) {
      sections.push(`> Extraction warning: ${data.missingGroups.join(", ")}.`);
    }
    return `${sections.join("\n\n").trim()}\n`;
  }

  function editorRequest(operation, code) {
    return new Promise((resolve, reject) => {
      const id = requestId();
      const timeout = setTimeout(() => {
        document.removeEventListener(EDITOR_RESPONSE_EVENT, onResponse);
        reject(new Error("The code editor did not respond. Reload the page and try again."));
      }, 4_000);

      function onResponse(event) {
        let response;
        try {
          response = JSON.parse(String(event.detail || ""));
        } catch {
          return;
        }
        if (response.requestId !== id) return;
        clearTimeout(timeout);
        document.removeEventListener(EDITOR_RESPONSE_EVENT, onResponse);
        if (!response.ok) reject(new Error(response.error || "The code editor operation failed."));
        else resolve(response.code || "");
      }

      document.addEventListener(EDITOR_RESPONSE_EVENT, onResponse);
      document.dispatchEvent(new CustomEvent(EDITOR_REQUEST_EVENT, {
        detail: JSON.stringify({ requestId: id, operation, ...(operation === "write" ? { code } : {}) })
      }));
    });
  }

  function language() {
    const editor = document.getElementById("editor");
    return textOf(editor?.querySelector(":scope > .ant-card-head .monoFont")) || "Java";
  }

  async function solvePayload() {
    const [data, starterCode] = await Promise.all([readProblem(), editorRequest("read")]);
    if (!starterCode.trim()) throw new Error("The code editor is empty or not ready.");

    const payload = {
      language: language(),
      starterCode,
      problem: data.problem,
      functional: data.functional,
      constraints: data.constraints,
      inputFormat: data.inputFormat,
      outputFormat: data.outputFormat,
      logical: trimCards(data.logical),
      mandatory: trimCards(data.mandatory, false),
      complexity: trimCards(data.complexity)
    };

    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_PAYLOAD_BYTES) {
      throw new Error("This problem is too large to send safely. Use Copy instead.");
    }
    return payload;
  }

  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.readOnly = true;
      textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("The browser blocked clipboard access.");
    }
  }

  function showToast(message, error = false, duration = 4_000) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.documentElement.appendChild(toast);
    }
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle("elab-solver-toast-error", error);
    toast.classList.add("elab-solver-toast-visible");
    toastTimer = setTimeout(() => toast.classList.remove("elab-solver-toast-visible"), duration);
  }

  function setSolveState(nextState) {
    solveState = nextState;
    const button = document.getElementById(SOLVE_BUTTON_ID);
    if (!button) return;
    const state = SOLVE_STATES[solveState] || SOLVE_STATES.idle;
    const label = button.querySelector(".elab-solve-label");
    if (label) label.textContent = state.label;
    button.disabled = state.disabled;
    button.setAttribute("aria-busy", String(state.busy));
    button.classList.toggle("elab-solve-loading", state.busy);
    button.classList.toggle("elab-solve-failed", solveState === "failure");
  }

  function createCopyButton() {
    if (document.getElementById(COPY_BUTTON_ID)) return;
    const button = document.createElement("button");
    button.id = COPY_BUTTON_ID;
    button.type = "button";
    button.title = "Copy the problem and grading requirements";
    button.setAttribute("aria-label", "Copy problem");
    button.innerHTML = '<span aria-hidden="true">⧉</span><span class="elab-copy-label">Copy</span>';

    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      const label = button.querySelector(".elab-copy-label");
      const previous = label.textContent;
      label.textContent = "Copying…";
      try {
        await writeClipboard(renderCopy(await readProblem()));
        label.textContent = "Copied";
        showToast("Problem copied.");
      } catch (error) {
        label.textContent = "Failed";
        showToast(error.message || "Could not copy the problem.", true);
      } finally {
        setTimeout(() => {
          label.textContent = previous;
          button.disabled = false;
        }, 1_200);
      }
    });
    document.documentElement.appendChild(button);
  }

  function editorActions() {
    const direct = document.querySelector("#editor > .ant-card-actions");
    if (direct) return direct;
    const editorCard = [...document.querySelectorAll(".ant-card")].find((card) =>
      normalized(textOf(card.querySelector(":scope > .ant-card-head .ant-card-head-title"))) === "code editor"
    );
    return editorCard?.querySelector(":scope > .ant-card-actions") || null;
  }

  function ensureSolveButton() {
    const actions = editorActions();
    if (!actions) return;

    let item = actions.querySelector(`#${SOLVE_ACTION_ID}`);
    if (!item) {
      item = document.createElement("li");
      item.id = SOLVE_ACTION_ID;
      item.innerHTML = `<span><button id="${SOLVE_BUTTON_ID}" type="button" class="ant-btn ant-btn-link editorBtn" aria-label="Solve problem">
        <span class="elab-solve-icon" aria-hidden="true">✦</span><span class="elab-solve-label">Solve</span>
      </button></span>`;
      const runItem = [...actions.children].find((child) => normalized(textOf(child)) === "run");
      actions.insertBefore(item, runItem || null);
      item.querySelector("button").addEventListener("click", solveCurrentProblem);
    }

    const width = `${100 / actions.children.length}%`;
    for (const action of actions.children) action.style.width = width;
    setSolveState(solveState);
  }

  function highlightEditor() {
    const editor = document.getElementById("ace-editor");
    if (!editor) return;
    editor.classList.add("elab-solver-editor-success");
    setTimeout(() => editor.classList.remove("elab-solver-editor-success"), 2_200);
  }

  function requestSolution(payload, identity) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: "elab-solve" });
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(pageCheck);
        window.removeEventListener("pagehide", onPageHide);
        port.onDisconnect.removeListener(onDisconnect);
        port.onMessage.removeListener(onMessage);
        try { port.disconnect(); } catch { /* Already disconnected on extension reload. */ }
        if (error) reject(error);
        else resolve(result);
      };
      const onPageHide = () => finish(new Error("The page was closed while solving."));
      const onDisconnect = () => {
        // Reading lastError prevents an unchecked runtime error on extension reload.
        const message = chrome.runtime.lastError?.message;
        finish(new Error(message || "The solver connection closed. Try again."));
      };
      const onMessage = (message) => {
        if (message?.type === "progress" && ["solving", "repairing", "validating"].includes(message.stage)) setSolveState(message.stage);
        else if (message?.type === "result") finish(null, message.result);
      };
      const timeout = setTimeout(() => finish(new Error("The solve request timed out. Try again.")), 140_000);
      const pageCheck = setInterval(() => {
        if (pageIdentity() !== identity) finish(new Error("The problem changed while solving. Try again."));
      }, 1_000);
      window.addEventListener("pagehide", onPageHide, { once: true });
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      try { port.postMessage({ type: "SOLVE_PROBLEM", payload }); }
      catch { finish(new Error("The extension was reloaded. Reload this page and try again.")); }
    });
  }

  async function solveCurrentProblem() {
    if (activeSolveId) return;
    const id = requestId();
    const identity = pageIdentity();
    activeSolveId = id;
    setSolveState("reading");

    try {
      const payload = await solvePayload();
      if (activeSolveId !== id) return;
      setSolveState("solving");
      const result = await requestSolution(payload, identity);
      if (activeSolveId !== id) return;
      if (!result?.ok) {
        const detail = result?.error?.issues?.[0]?.message;
        throw new Error([result?.error?.message || "The solver request failed.", detail].filter(Boolean).join(" "));
      }
      if (pageIdentity() !== identity) throw new Error("The problem changed while solving. Try again.");

      setSolveState("injecting");
      const currentCode = await editorRequest("read");
      if (pageIdentity() !== identity) throw new Error("The problem changed while solving. Try again.");
      if (currentCode.replace(/\r\n?/g, "\n") !== payload.starterCode.replace(/\r\n?/g, "\n")) {
        throw new Error("The editor changed while solving. Your edits were kept; try again when ready.");
      }
      await editorRequest("write", result.code);
      if (activeSolveId !== id) return;
      highlightEditor();
      setSolveState("success");
      const warnings = result.warnings || [];
      showToast(warnings.length
        ? `Solution inserted. ${warnings.map((issue) => issue.message).join(" ")}`
        : "Solution inserted. Review it before running.", false, warnings.length ? 12_000 : 4_000);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      if (activeSolveId === id) setSolveState("idle");
    } catch (error) {
      if (activeSolveId !== id) return;
      setSolveState("failure");
      showToast(error.message || "Could not solve this problem.", true);
    } finally {
      if (activeSolveId === id) activeSolveId = null;
    }
  }

  function sync() {
    if (!isProblemPage()) {
      document.getElementById(COPY_BUTTON_ID)?.remove();
      document.getElementById(SOLVE_ACTION_ID)?.remove();
      return;
    }
    createCopyButton();
    ensureSolveButton();
  }

  const observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(sync, 200);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  sync();
})();

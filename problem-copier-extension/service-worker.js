"use strict";

import { solve } from "./api-client.js";

const SOLVER_ENDPOINT = "https://elab-solver.elab-solver-worker.workers.dev/solve";

// Active messages on this port keep the MV3 worker alive while the server streams.
// Closing the page/port cancels the HTTP request and the provider generation.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "elab-solve") return;
  const controller = new AbortController();
  let started = false;
  let disconnected = false;
  const send = (message) => {
    if (disconnected) return;
    try { port.postMessage(message); }
    catch { disconnected = true; controller.abort(); }
  };
  port.onDisconnect.addListener(() => {
    disconnected = true;
    controller.abort();
  });
  port.onMessage.addListener((message) => {
    if (message?.type !== "SOLVE_PROBLEM" || started) return;
    started = true;
    solve(SOLVER_ENDPOINT, message.payload, {
      signal: controller.signal,
      onProgress: (stage) => send({ type: "progress", stage })
    }).then((result) => send({ type: "result", result })).catch(() => {
      send({ type: "result", result: { ok: false, error: { code: "INTERNAL_ERROR", message: "The extension could not complete the solve request.", retryable: true } } });
    });
  });
});

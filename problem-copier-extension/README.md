# eLab Solver extension

This is a Manifest V3 extension with two in-page actions only:

- **Solve** appears in the eLab code-editor action row and inserts an Ollama-generated Java solution into Ace.
- **Copy** appears at the bottom-right and copies the problem, formats, and grading requirements as Markdown.

The extension does not add a popup and does not trigger Run, Evaluate, Save, or Reset.

The content script supports the eLab layout used by this project. Replace `<all_urls>` in `manifest.json` with the real eLab URL pattern when it is known.

## Solve behavior

Requires Chrome/Edge 114 or newer. Load this directory as an unpacked extension, then reload the eLab page after extension updates.

The extension uses native fetch and an active runtime port to receive progress from the Worker. It inserts only the final Java result, displays grading warnings, and preserves edits made while generation was running. Closing the page or navigating to another problem cancels the request. There is no saved job or background history.

The server is allowed 120 seconds for generation and one repair; the extension stops after 135 seconds overall or 25 seconds without server data. Server progress arrives every 10 seconds. Errors appear in the page toast with a useful reason.

`api-client.js` reads bounded NDJSON streams and JSON responses. `service-worker.js` handles the port and HTTP cancellation; `content.js` handles scraping, progress and insertion; `page-bridge.js` accesses Ace. The Ollama API key is never included in these files.

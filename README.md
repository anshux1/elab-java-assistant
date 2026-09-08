# eLab Java Assistant

A lightweight Chrome & Edge extension for Java problems on [SRM eLab](https://dld.srmist.edu.in/fshelab/).

[Download ZIP](https://github.com/anshux1/elab-java-assistant/raw/refs/heads/main/elab-java-assistant.zip) · [Installation guide](INSTALLATION.md) · [Backend docs](solver-worker/README.md)

## Two simple actions

- **Solve** — generate a Java solution and insert it into the editor for review.
- **Copy** — copy the problem, input/output formats, and grading requirements as Markdown.

Your edits are preserved while a solution is generated. Grading warnings are shown for review. The extension never clicks Run, Evaluate, Save, or Reset.

**Works only on `https://dld.srmist.edu.in/fshelab/`.** Requires Chrome or Edge 114+.

Powered by Ollama Cloud through a Cloudflare Worker. The API key stays on the server.

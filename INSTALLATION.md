# Install eLab Java Assistant

For Chrome or Edge 114+. Works only on [SRM eLab](https://dld.srmist.edu.in/fshelab/).

1. **Download** [elab-java-assistant.zip](https://github.com/anshux1/elab-java-assistant/raw/refs/heads/main/elab-java-assistant.zip) and extract it into a folder you will keep.
2. **Open extensions:** `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. **Enable Developer mode**, then select **Load unpacked**.
4. **Select the extracted `elab-java-assistant` folder** containing `manifest.json`.
5. **Open or reload [SRM eLab](https://dld.srmist.edu.in/fshelab/)** and navigate to a Java problem.

Use **Solve** beside the editor actions or **Copy** at the bottom-right. Review generated code before running it.

The ZIP is already configured for the hosted backend. No API key or server setup is needed to use it.

## Update

Extract the new ZIP and replace the files in the same extension folder. Click **Reload** on the extension card, then reload your eLab page.

## If the buttons are missing

Make sure you are on an eLab problem page under `/fshelab/`, the extension is enabled, and the page has been reloaded after installation. If a solve fails, the page shows the reason; try again when the service is available.

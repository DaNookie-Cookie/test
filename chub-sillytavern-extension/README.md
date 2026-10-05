# Chub → SillyTavern

Chrome/Edge MV3 extension that adds **Send to SillyTavern** to Chub.ai character pages.

## What changed in 1.1.0

Chub's old `POST https://api.chub.ai/api/characters/download` route can return `405 Method Not Allowed`.
This build no longer uses that route. Instead it:

1. Fetches Chub character metadata from the current `?full=true` character API.
2. Downloads the character's current PNG avatar/card.
3. Rewrites the embedded `chara` PNG metadata with a SillyTavern-compatible V2 card built from the current Chub definition.
4. Imports that PNG through SillyTavern's normal character importer.

This also helps avoid stale/cut-off Chub card metadata.

## Install

1. Unzip this folder.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the `chub-sillytavern-extension` folder.
6. Open extension **Options** and set your SillyTavern URL if needed. Default: `http://127.0.0.1:8000`.
7. Open a Chub character page and click **⇥ Send to SillyTavern**.

## Notes

- Public characters should work without extra setup.
- Private/restricted Chub characters may require that your browser session has access to them.
- Reload the extension after installing a new build.

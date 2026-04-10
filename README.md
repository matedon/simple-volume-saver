# Tab Sound Mixer 500% Volume Booster

![Tab Sound Mixer 500% Volume Booster Logo](./assets/tsm50vb-logo.png)

Tab Sound Mixer 500% Volume Booster is a Chromium extension to control media volume per website (and currently per open tab in the popup mixer).

## Fork Notice
This repository is a fork of the original project by Kaan:
https://github.com/kaan0d/simple-volume-saver

Thank you to **Kaan** for creating and open-sourcing the original extension.

## Current Features
- Per-site default volume rules stored in sync storage.
- Popup mixer with separate rows for open tabs (including multiple tabs from the same domain).
- Quick jump button per row to switch to the target tab, or open the domain if no tab is open.
- Inline numeric volume input + slider control on each row.
- Mouse wheel volume adjustment over list rows.
- Save current site as default using the Add button.
- Remove saved rules and reset affected open tabs back to 100%.
- Automatic application of saved/default volume when tabs update.

## Project Structure
- `shared/common`: Shared sources used by both browser builds (`background.js`, `popup.js`, `popup.html`, `popup.css`, `icons/*`).
- `simple-volume-saver__chrome`: Chrome-specific source files (currently `manifest.json` only).
- `simple-volume-saver__firefox`: Firefox-specific source files (currently `manifest.json` only).
- `scripts/build-dist.ps1`: Builds complete extension folders into `dist/chrome` and `dist/firefox`, then creates ZIP packages.

## Development Workflow
1. Edit shared files in `shared/common`.
2. Edit browser-specific manifest files in:
   - `simple-volume-saver__chrome/manifest.json`
   - `simple-volume-saver__firefox/manifest.json`
3. Build distributables:
   - `powershell -ExecutionPolicy Bypass -File .\scripts\build-dist.ps1`
4. Reload unpacked extensions from `dist/chrome` and `dist/firefox`.

Optional:
- Skip ZIP creation: `powershell -ExecutionPolicy Bypass -File .\scripts\build-dist.ps1 -SkipZip`

## Installation (Unpacked)
### Chrome / Chromium / Opera
1. Open browser extensions page (`chrome://extensions`).
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select the `dist/chrome` folder.

### Firefox
1. Open `about:debugging#/runtime/this-firefox`.
2. Click `Load Temporary Add-on...`.
3. Select `manifest.json` from `dist/firefox`.

## Changelog
See [CHANGELOG.md](./CHANGELOG.md).

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
- `simple-volume-saver__chrome`: Chrome/Chromium package.
- `simple-volume-saver__firefox`: Firefox package.

## Installation (Unpacked)
### Chrome / Chromium / Opera
1. Open browser extensions page (`chrome://extensions`).
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select the `simple-volume-saver__chrome` folder.

### Firefox
1. Open `about:debugging#/runtime/this-firefox`.
2. Click `Load Temporary Add-on...`.
3. Select `manifest.json` from `simple-volume-saver__firefox`.

## Changelog
See [CHANGELOG.md](./CHANGELOG.md).

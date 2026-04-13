# Changelog

All notable changes to this project are documented in this file.

## Fork Acknowledgement
This project is forked from:
https://github.com/kaan0d/simple-volume-saver

Huge thanks to **Kaan** for the original implementation and open-source base.

## [2026-04-13] - 1.1.3
### Fixed
- Stabilized volume application flow by routing popup-triggered tab updates through the background worker (`svsRefreshTabAudio`) to avoid conflicting tab injections.
- Improved handling for sites where `createMediaElementSource` is blocked (`InvalidStateError`) by keeping those media elements on fallback volume mode.

### Changed
- Mixer list now splits same-domain rows only when multiple tabs are actively playing audio.
- Slider UI now uses a two-zone scale: first half maps `0-100%`, second half maps `100-500%`.
- Wheel volume stepping now follows range-aware increments: `5%` below `100%`, `25%` above `100%`.

## [2026-04-13] - 1.1.2
### Fixed
- Origin-level tab volume overrides are now stored persistently in `chrome.storage.local` instead of `chrome.storage.session`.
- Volume levels set from the popup now remain available after browser restart.

## [2026-04-10] - 1.1.1
### Added
- Shared source layout under `shared/common` for cross-browser files.
- Dist builder script: `scripts/build-dist.ps1` to assemble `dist/chrome` and `dist/firefox` from shared files + browser-specific manifests.

### Changed
- Popup/session behavior now uses origin-level temporary overrides, so new tabs on the same domain inherit the current volume within the same browser session.
- Unpacked loading workflow now targets `dist/chrome` and `dist/firefox` after build.

## [2026-04-10] - 1.1.0
### Added
- 500% volume mode with GainNode-based boosting.
- Sticky snap behavior for 100-step marks during wheel/slider interaction.
- Inactive presets toggle in the popup.
- Firefox package variant in `simple-volume-saver__firefox`.

### Changed
- Extension name updated to **Tab Sound Mixer 500% Volume Booster**.
- Inactive preset rows are hidden by default.
- 100%+ slider visual now uses a dedicated `+` boost pattern zone.
- Volume input now shows a `%` suffix.
- Chrome package folder renamed to `simple-volume-saver__chrome`.
- Replaced extension icons (16/48/128/512) with the new TSM50VB logo in both Chrome and Firefox packages.

## [2026-04-09] - Mixer UX update
### Added
- Tab-level mixer rows (multiple open tabs from the same domain are listed separately).
- Per-row goto action:
  - Switch to the corresponding open tab when available.
  - Open domain in a new tab when not currently open.
- Favicon-backed goto button backgrounds.
- Inline numeric volume editing per row.
- Mouse-wheel volume adjustment over rows.
- Debounced volume commit pipeline to reduce stutter during slider drag.
- Session-level tab volume overrides (`chrome.storage.session`).
- Live playback marker (animated left-edge pulse dot) on audible rows.

### Changed
- Popup layout widened to reduce visual crowding.
- List behavior prioritizes current active tab row at the top.
- Add button now reflects saved-state and can pulse-highlight existing rows.
- Remove button uses icon-first UI and appended control-group styling.

### Fixed
- Remove now resets affected open tabs to 100%.
- Improved tab targeting for goto behavior (including Opera GX compatibility path).
- Better iframe handling by executing volume updates in all frames where possible.

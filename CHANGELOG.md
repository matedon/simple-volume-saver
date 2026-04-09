# Changelog

All notable changes to this project are documented in this file.

## Fork Acknowledgement
This project is forked from:
https://github.com/kaan0d/simple-volume-saver

Huge thanks to **Kaan** for the original implementation and open-source base.

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
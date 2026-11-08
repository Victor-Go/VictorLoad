# Changelog

All notable changes to VictorLoad are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.1]

### Added

- French and Traditional Chinese interface languages, in addition to Simplified Chinese and English. The extension description in the browser's extension page is localized too.
- Language is now chosen from a drop-down list in Settings.
- This changelog.

### Fixed

- Broken images (dead links, expired URLs) are no longer listed under "Main" or selected by default. They remain under "All".
- When a site refuses to show an image outside its own pages, the card says "No preview available" instead of a broken-image icon. The image can still be downloaded.

### Changed

- The interface language defaults to **Auto**: it follows the browser (Simplified Chinese for mainland China, Singapore and Malaysia; Traditional Chinese for Taiwan, Hong Kong, Macau and `zh-Hant`), and any language the extension does not support falls back to English. Languages you chose before are kept.
- Switching the display mode in Settings now applies immediately: the side panel closes and the popup opens, or the other way round. On Chrome versions that cannot open it from script, a notice asks you to click the toolbar icon.

## [1.0.0]

Initial public release.

[Unreleased]: https://github.com/Victor-Go/VictorLoad/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/Victor-Go/VictorLoad/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Victor-Go/VictorLoad/releases/tag/v1.0.0

# Changelog

All notable changes to VictorLoad are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.5]

### Fixed

- Videos attached to X link cards (for example amplify players on tweets that link to another site) are now detected. Their media data sits inside the card's JSON, which was previously skipped.

## [1.0.3]

### Fixed

- Downloads no longer fail with "Invalid filename". Page titles are now cleaned up before they become file names: broken emoji, trailing dots or spaces, hidden control characters and Windows reserved names (such as `CON`) are fixed or removed.
- Videos could be saved under the site's own random file name (for example `cMR4HzL7OBPZ6aZW.mp4`) instead of the page title. The chosen name is now enforced, and if the browser still rejects it, a simpler name is tried instead of failing.

### Changed

- Videos now default to the highest available quality. After you pick a quality, the next video uses the closest one to it.

## [1.0.2]

### Added

- The save location is now a folder template in Settings with the placeholders `{site}`, `{date}`, `{year}` and `{month}` (for example `Videos/{site}/{year}-{month}/`). Leave it empty to save straight into the Downloads folder. The default is still `VictorLoad/{site}/`, and anyone who had turned off "One folder per site" keeps saving into Downloads.

### Fixed

- HLS videos are saved as a real `.mp4` instead of a `.ts` file that many players (Windows Films & TV, phones, browsers) cannot open. The segments are repackaged without re-encoding, so it is fast and lossless, and the file is a standard MP4 with the real duration and a keyframe index, so it can be seeked. Streams that cannot be repackaged are still saved as `.ts`.

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

[Unreleased]: https://github.com/Victor-Go/VictorLoad/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/Victor-Go/VictorLoad/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Victor-Go/VictorLoad/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Victor-Go/VictorLoad/releases/tag/v1.0.0

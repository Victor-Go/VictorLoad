# Changelog

All notable changes to VictorLoad are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.9]

### Added

- Settings → "YouTube download method". **Current page** (default, what earlier versions did), **New tab**: the video is recorded in a background tab that closes by itself, so the YouTube page you watch keeps 1440p / 4K playback (downloads are up to 1080p, merged into one MP4; only heights that exist as H.264 are listed), and **No codec limit** (the old "Prefer H.264" switch turned off).
- In the current-page method, the panel shows a short notice on YouTube pages that this hides 4K in the player, with a button to the setting.

### Changed

- YouTube recordings are now written to the browser's private storage for the site (OPFS) segment by segment instead of being held in memory. The 1.5 GB limit is gone (it only applies when the browser has no such storage), a tab that is under memory pressure no longer loses the recording, and files above 4 GB are written with 64-bit offsets. The files are deleted when the download ends, and leftovers of a crashed tab are swept when a YouTube page opens.
- The "Prefer H.264 on YouTube" switch became the download method above. Existing installs keep their behaviour (on = current page, off = no codec limit).
- The download history is no longer trimmed by the usual 10 MB extension storage quota (new `unlimitedStorage` permission, which shows no install warning).
- The YouTube page script (`mse.js`) is now registered by the extension for the chosen method instead of being fixed in the manifest. In "New tab" mode it does not run on the pages you watch.

## [1.0.8]

### Added

- A new-version notice in the panel. Once a day the extension reads the latest release number from GitHub's public API (no cookies, nothing about you or your downloads is sent) and, when a newer version exists, shows a notice with a link to the release page. "Ignore this version" hides it until the next release. See the privacy policy.
- A one-time reminder to star the project on GitHub at the top of the panel. It disappears for good once you click it or close it.

### Fixed

- HLS videos in embedded players on other sites could not be downloaded when the video host only accepts requests from the player's page (the download failed with HTTP 403). The extension now sends that page's address as `Referer` and `Origin` for its own requests to the stream's host.

## [1.0.7]

### Added

- A blue download arrow now sits where the green check goes, on every video and image that has not been downloaded yet. One click saves the highest quality through the normal download path. It can be switched off in Settings → Download ("Show a download arrow on the page"). It is not shown on YouTube, whose videos are saved from the panel.

## [1.0.6]

### Added

- New file name placeholder `{title}`: the title shown on the preview card (the tweet text on X, the video title on YouTube and Bilibili), or the tab title where there is none. It is now the default, so videos from the X home timeline are no longer all named "Home / X". `{tab}` still means the browser tab title. Existing installs that still had the old default `{tab}` move to `{title}` once.
- An X button on every video and image card removes it from the list until the page is reloaded.

### Changed

- Newly found videos and images are added at the top of the list instead of the end.
- On video cards the duration moved to the top-left corner (next to the HLS tag) to make room for the X button.

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

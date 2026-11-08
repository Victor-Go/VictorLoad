# Developing VictorLoad

[Back to the README](../README.md) · [中文 README](../README.zh-CN.md)

Requires Node.js 22.12 or newer. There are no runtime or build dependencies.

## Commands

```bash
npm run check   # syntax, imports, manifest, locales, translation coverage, packaging dry run
npm test        # unit tests (node:test)
npm run build   # dist/VictorLoad-vX.Y.Z.zip (local only; releases are built by CI)
npm run icons   # regenerate icons/ from scripts/make-icons.mjs
```

Load the repository folder in `chrome://extensions` (Developer mode → Load unpacked) to try changes; use the reload button on the extension card after editing, and reload the tab you are testing (content scripts are injected at page load).

## Layout

```
manifest.json, _locales/, icons/, rules/     extension manifest, localized description, icons, Referer rule
src/background.js     service worker: state, network sniffing, downloads, history
src/content.js        page scan, green checks            src/inject.js   X API hook (MAIN world)
src/mse.js            YouTube segment capture, gap fill, MP4 assembly (MAIN world)
src/h264.js           optional "H.264 only" switch for YouTube (MAIN world)
src/sites.js          Bilibili / YouTube extractors      src/hlsparse.js m3u8 parser
src/offscreen.*       HLS segment merging                src/sidepanel.*  UI
src/shared.js         main-content rules, helpers        src/i18n.js      English strings
vendor/hls.min.js     hls.js, for HLS previews           dev/             manual test pages
test/, scripts/       unit tests, build and release tooling
```

## Conventions

- Chinese is the default language. User-facing text is written in **Chinese** in the source and translated into English through `src/i18n.js` (the Chinese string is the key); the interface starts in Chinese and the user can switch in Settings. `npm run check` fails when a string has no English translation.
- Code comments are in **English**.
- Formatting is set by `.editorconfig` and `.prettierrc.json` (LF line endings, 2 spaces, single quotes, 120 columns). Prettier is not a project dependency; to format run `npx prettier --write "src/**/*.js" "scripts/*.mjs" "test/**/*.mjs"`.
- Chinese text uses full-width punctuation (，。：；？！「」（）).
- Tests that load `src/background.js` use `test/helpers/fake-chrome.mjs`, a strict fake: a `chrome.*` call the test did not list throws, so an API typo or a new call fails the test.
- Handle errors or show them in the panel. If a failure is expected and safe to ignore, explain why in a comment. For Promise-based APIs, handle rejections as well as synchronous exceptions.
- `src/*.js` that run in the page (`content.js`, `inject.js`, `mse.js`, `h264.js`) are classic scripts; the others are ES modules.

## Manual, in-browser checks (`dev/`)

Serve the repository root (for example `python -m http.server 8765`) and open:

| Page | Purpose |
| --- | --- |
| `dev/preview.html` | Renders the side panel with mock data (`?lang=en`, `?tab=image`; add `&stress=64` for mixed-aspect image/video grid checks at 1–8 columns; run `__push()` in the console to simulate a new video) |
| `dev/layout-test.html` | Runs browser layout checks: image/video columns 1–8, 64 mixed-aspect items, short viewports, equal card dimensions, scrolling and single-item width limits |
| `dev/showcase.html` | The three-site screenshot used in the README (`?lang=en` / `?lang=zh`, `&zoom=0.5` in a 660×390 viewport on a 2× screen) |
| `dev/flat-test.html` | Records real H.264 + AAC, feeds it to `src/mse.js` in random chunks, builds an MP4 and plays it back. Read `window.__result` |
| `dev/gap-test.html` | Gap detection and auto download (`?mode=stuck` for the unfillable case). Read `window.__result` |

## Releasing

See [RELEASING.md](RELEASING.md).

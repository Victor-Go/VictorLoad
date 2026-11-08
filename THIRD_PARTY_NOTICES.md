# Third-party notices

VictorLoad bundles the following third-party software.

## hls.js 1.5.17

- File: `vendor/hls.min.js`
- Used for: previewing HLS (`.m3u8`) streams in the side panel
- Copyright (c) 2017 Dailymotion
- License: Apache License 2.0, full text in [`vendor/hls.js.LICENSE`](vendor/hls.js.LICENSE)
- Source: https://github.com/video-dev/hls.js

## mux.js 7.1.0

- File: `vendor/mux-mp4.min.js`
- Used for: repackaging downloaded HLS MPEG-TS segments as MP4 (no re-encoding)
- Copyright (c) Brightcove, Inc.
- License: Apache License 2.0, full text in [`vendor/mux.js.LICENSE`](vendor/mux.js.LICENSE)
- Source: https://github.com/videojs/mux.js
- The test fixture `test/fixtures/h264-segment.ts` is taken from the mux.js test suite (same license).

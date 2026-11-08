# How each site works

[简体中文](SITES.md) · [Back to the README](../README.md)

## YouTube

YouTube restricts direct stream URLs through mechanisms such as PO tokens, signatures and SABR. VictorLoad tries the player API, then falls back to **capturing the media segments loaded by the player** and assembling a file. Capture depends on the player's media format and the limits listed below.

1. Open a video and play it for a few seconds. The quality dropdown on the card fills up as the player buffers; its background is the progress (`1080p · 42%`).
2. **Fully buffered**: the button reads **Download** and saves straight away.
3. **Not fully buffered**: the button reads **Auto download**. The extension moves the playhead to each gap (muted, 16× speed, quality locked meanwhile), waits for the player to fetch it, then saves. Click **Cancel** to stop. If a gap cannot be filled you are asked whether to save what exists.

Good to know:

- The progress counts **position**, not just minutes: if you scrub around and leave a hole in the middle, it is detected and listed (hover the dropdown to see where).
- **Prefer H.264 on YouTube** (Settings, on by default) makes the player use H.264 + AAC, so audio and video merge into **one standard MP4** (up to 1080p). Turn it off to allow VP9 / AV1 (for example 4K, if you pick it in the player); audio and video are then saved as two files.
- For a different quality, pick it in the player first, then buffer.
- The file is saved by the page, into the browser's default downloads folder (not the `VictorLoad/<site>/` subfolder).
- Buffered data lives in memory (about 1.5 GB cap). H.264 + AAC captures are saved as a standard MP4 (`ftyp` + `moov` + `mdat`).
- After installing or updating the extension, **reload the YouTube tab** so the page script is injected again.

## X (Twitter)

- The page's own API responses are read to find every mp4 variant of a tweet's video, so you get one entry per quality, GIFs included.
- A video is listed only while its tweet is on the page: scroll it away and it disappears from the list, like the rest of the live view.
- Images are requested at `name=orig`, the original size. On X only photos inside tweets count as **main** images; avatars, banners and emoji are excluded.

## Bilibili

- The public play-URL data (the same the web player uses) is read to get a direct **mp4** link for each quality, one entry per quality.
- A `Referer: https://www.bilibili.com/` header is added for Bilibili's media hosts (declarativeNetRequest), because the CDN rejects requests without it.
- Which qualities appear depends on your account: log in to bilibili.com in the same browser to see more. Qualities that Bilibili only offers as separate audio and video streams (for example 4K / HDR) are not offered.

## Other sites

- **HLS (`.m3u8`)**: playlists are noticed as the page loads them. A master playlist is split into its resolutions. Segments are downloaded and merged in an offscreen document (AES-128 encryption and fMP4 init segments are supported) into `.ts` / `.mp4`.
- **MP4 / WebM**: found through the page's `<video>` elements (`<source size=…>` gives resolution choices) and through the network responses.
- **Images**: `<img>`, `srcset` (largest candidate), the full-size image a thumbnail links to, and inline CSS backgrounds. Large images that only appear in network traffic are listed too.

## What decides "main"

| Content | Rules (in this order) |
| --- | --- |
| Images | Tag structure you picked before on this site → site rules (X) → minimum width, height and file size → not inside `nav` / `header` / `footer` → images that share a tag structure with a main image are promoted |
| Videos | Tag structure you picked before → site extractors (always main) → minimum resolution, duration and file size |

All thresholds are in Settings.

## File names

Settings → **File name format**. `{tab}` is the tab's title as the browser shows it, `{name}` the media's own name (the video title on YouTube / X / Bilibili, the file name elsewhere), `{duration}` like `5m32s`, `{resolution}` like `1080p` (`1920x1080` for images). Same-name files get a number added.

## Limitations

- DRM-protected video (Widevine and similar) cannot be downloaded; HLS with `SAMPLE-AES` is not supported.
- HLS variants that reference separate audio tracks are explicitly blocked with a message, to avoid saving silent videos.
- Some sites check `Referer` / `Origin` on media requests and answer 403.

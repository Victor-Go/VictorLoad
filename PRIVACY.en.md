# Privacy policy

_Last updated: 2026-11-07_

[简体中文](PRIVACY.md)

VictorLoad runs inside your browser. It has no backend service, no VictorLoad account, no analytics and no advertising. **It does not send usage data to the developer or analytics services.** It contacts media sites to find, preview and download content, as described below.

## What the extension stores

All of this stays on your device, in the browser's extension storage:

| Data | Why | Where |
| --- | --- | --- |
| Settings (filters, file name format, language, display mode …) | To remember your choices | `storage.local` |
| Download history (title, page address, file name, quality, thumbnail address, time) | To show the history list and put green checks on downloaded items | `storage.local` |
| Remembered tag structures (per site) | To pre-select the kind of content you usually download | `storage.local` |
| Sniffed items of open tabs, in-flight download jobs | To keep the list while the service worker sleeps | `storage.session` (cleared when the browser closes) |

You can delete history and remembered tag structures at any time in the extension's panel. Uninstalling the extension removes everything.

## What the extension does on the network

- It reads the page you are viewing (images, videos, the page's own network responses) to find downloadable media. Nothing from the page is sent anywhere except as described below.
- To download a file it requests that file from the site that hosts it, exactly like your browser would.
- To list qualities it calls the public video APIs of **YouTube** (`youtube.com/youtubei/v1/player`) and **Bilibili** (`api.bilibili.com`) with the ID of the video you are looking at. For Bilibili the request carries your bilibili.com cookies so that qualities available to your account are listed.
- It adds a `Referer: https://www.bilibili.com/` header to requests for Bilibili's media hosts so that downloads work.
- Previews in the panel load thumbnails and video from the sites that host them.

The extension loads no remote code. The only third-party library, hls.js (for HLS previews), is bundled in the package.

## Why each permission is needed

| Permission | Reason |
| --- | --- |
| Access to all sites (`<all_urls>`) | The content script scans any page you open, and media is downloaded from whichever host serves it |
| `webRequest` | Read-only: notices media responses (mp4, m3u8 …) so videos that are not in the page's HTML can be listed. Requests are never blocked or changed by it |
| `downloads` | Saves files and reads their final name for the history |
| `storage` | Settings, history and remembered tag structures |
| `alarms` | Checks active HLS jobs, recovers lost completion messages and reports connection failures |
| `tabs`, `webNavigation` | Reads the active tab's title and address (for the file name and the site name) and resets the list when you navigate |
| `sidePanel` | Shows the side panel |
| `offscreen` | Merges HLS segments into one file in a hidden document |
| `declarativeNetRequest` | Adds the Bilibili `Referer` header described above |
| `scripting` | Injects the page script into tabs that were open before the extension was installed or updated, and registers the optional "H.264 only" script for YouTube |

## Children

The extension is not directed at children and collects no personal information from anyone.

## Changes and contact

If this policy changes, the new version is published in this repository with an updated date. Questions or concerns: please open an issue at https://github.com/Victor-Go/VictorLoad/issues.

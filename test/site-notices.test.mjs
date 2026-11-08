import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSite } from '../src/sites.js';
import { videoNotice, siteErrorText } from '../src/notices.js';
import { setLang } from '../src/i18n.js';

globalThis.document = { documentElement: {} };
const warn = console.warn;
const info = console.info;
console.warn = () => {};
console.info = () => {};
test.after(() => {
  console.warn = warn;
  console.info = info;
});

test('an HTML response from YouTube shows neutral capture instructions without JSON diagnostics', async () => {
  globalThis.fetch = async () => new Response('<html><head>Temporary error</head></html>');
  const [item] = await extractSite('youtube', 'https://www.youtube.com/watch?v=abc123');
  assert.equal(item.waitingForCapture, true);
  assert.equal(item.error, '');
  assert.equal(item.errorDetail, undefined);
  setLang('zh');
  const notice = videoNotice(item);
  assert.match(notice.text, /请先播放视频/);
  assert.equal(notice.error, false);
  assert.doesNotMatch(notice.text, /JSON|Unexpected|<html/i);
  setLang('en');
  assert.match(videoNotice(item).text, /Play the video first/);
});

test('successful direct links do not show capture warm-up instructions', async () => {
  globalThis.fetch = async () =>
    Response.json({
      videoDetails: { title: 'Test', lengthSeconds: '12' },
      streamingData: { formats: [{ url: 'https://cdn.example/test.mp4', height: 720, mimeType: 'video/mp4' }] },
    });
  const [item] = await extractSite('youtube', 'https://www.youtube.com/watch?v=abc123');
  assert.equal(item.waitingForCapture, false);
  assert.equal(videoNotice(item).text, '');
});

test('YouTube capture warm-up and site errors never display raw response bodies', () => {
  setLang('zh');
  const detail = `Unexpected token '<', '<html><head>' is not valid JSON`;
  const notice = videoNotice({
    source: 'site',
    posterOnly: true,
    waitingForCapture: true,
    qualities: [],
  });
  assert.equal(notice.error, false);
  assert.match(notice.text, /请先播放视频/);
  assert.doesNotMatch(videoNotice({ error: detail }).text, /JSON|Unexpected|<html/i);
  assert.doesNotMatch(siteErrorText(detail), /JSON|Unexpected|<html/i);
  assert.match(siteErrorText('HTTP 403'), /登录/);
  assert.match(siteErrorText('Failed to fetch'), /网络/);
  const captured = videoNotice({ capture: {}, waitingForCapture: true, qualities: [{ type: 'capture' }] });
  assert.equal(captured.text, '');
});

test('an unsupported selected quality still explains the disabled button when capture is available', () => {
  setLang('zh');
  const message = videoNotice(
    { capture: {}, qualities: [{ type: 'capture' }] },
    { error: '该 HLS 使用了不支持的加密方式' },
  );
  assert.equal(message.error, true);
  assert.match(message.text, /不支持的加密方式/);
});

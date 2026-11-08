import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseM3U8 } from '../src/hlsparse.js';

globalThis.document = { documentElement: {} }; // i18n.js touches document only when switching language
const { T, setLang, detectLang, EN } = await import('../src/i18n.js');

test('parseM3U8: master playlist lists the variants with resolution', () => {
  const m = parseM3U8(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720\nhi.m3u8\n',
    'https://a.com/x/master.m3u8',
  );
  assert.equal(m.master, true);
  assert.deepEqual(
    m.variants.map((v) => [v.h, v.url]),
    [
      [360, 'https://a.com/x/low.m3u8'],
      [720, 'https://a.com/x/hi.m3u8'],
    ],
  );
});

test('parseM3U8: media playlist with AES-128 and media sequence', () => {
  const p = parseM3U8(
    '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:4.0,\na.ts\n#EXTINF:3.5,\nb.ts\n#EXT-X-ENDLIST',
    'https://a.com/x/p.m3u8',
  );
  assert.equal(p.master, false);
  assert.equal(p.segs.length, 2);
  assert.equal(p.duration, 7.5);
  assert.equal(p.segs[1].seq, 6);
  assert.equal(p.segs[0].key.uri, 'https://a.com/x/k.key');
  assert.equal(p.endlist, true);
});

test('parseM3U8: only referenced external audio groups block a variant', () => {
  const p = parseM3U8(
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="external",URI="audio.m3u8"\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="muxed",NAME="English"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="external"\na.m3u8\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=2,AUDIO="muxed"\nb.m3u8\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=3\nc.m3u8',
    'https://example.com/master.m3u8',
  );
  assert.deepEqual(
    p.variants.map((v) => v.externalAudio),
    [true, false, false],
  );
});

test('parseM3U8: SAMPLE-AES is reported as unsupported', () => {
  const p = parseM3U8('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:4,\na.ts\n', 'https://a.com/p.m3u8');
  assert.equal(p.unsupported, 'SAMPLE-AES');
});

test('i18n: Chinese is the source language, English is looked up', () => {
  setLang('zh');
  assert.equal(T('下载选中 ({n})', { n: 3 }), '下载选中 (3)');
  setLang('en');
  assert.equal(T('下载选中 ({n})', { n: 3 }), 'Download selected (3)');
  assert.equal(T('没有翻译的句子'), '没有翻译的句子'); // unknown text falls back to the source
});

test('i18n: messages with a variable part are translated by pattern', () => {
  setLang('en');
  assert.equal(T('不支持的加密方式：SAMPLE-AES'), 'Unsupported encryption: SAMPLE-AES');
  assert.equal(T('720p · 视频+音频分开'), '720p · video + audio as separate files');
});

test('i18n: the example text for file names is neutral', () => {
  assert.equal(EN['你好世界'], 'Hello World');
});

test('i18n: auto detection maps browser languages to the right script', () => {
  const cases = {
    'zh-CN': 'zh', 'zh-SG': 'zh', 'zh-Hans': 'zh', 'zh-Hans-SG': 'zh', zh: 'zh', 'zh-MY': 'zh',
    'zh-TW': 'zh-TW', 'zh-HK': 'zh-TW', 'zh-MO': 'zh-TW', 'zh-Hant': 'zh-TW', 'zh-Hant-HK': 'zh-TW',
    'fr-CA': 'fr', fr: 'fr', 'en-US': 'en', de: 'en', ja: 'en',
  };
  for (const [ui, want] of Object.entries(cases)) {
    globalThis.chrome = { i18n: { getUILanguage: () => ui } };
    assert.equal(detectLang(), want, ui);
  }
  delete globalThis.chrome;
});

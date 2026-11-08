// Minimal m3u8 parser (shared by background sniffing and the offscreen downloader)

export const EXTERNAL_AUDIO_ERROR = '此视频使用独立音轨，暂不支持下载。';

export function resolveUrl(base, rel) {
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

function attrs(s) {
  const o = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return o;
}

export function parseM3U8(text, base) {
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const audio = lines
      .filter((l) => l.startsWith('#EXT-X-MEDIA:'))
      .map((l) => attrs(l.slice('#EXT-X-MEDIA:'.length)))
      .filter((a) => a.TYPE === 'AUDIO')
      .map((a) => ({ group: a['GROUP-ID'], url: a.URI ? resolveUrl(base, a.URI) : '' }));
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const a = attrs(lines[i].slice('#EXT-X-STREAM-INF:'.length));
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (!lines[j]) continue;
      const res = (a.RESOLUTION || '').split('x').map(Number);
      variants.push({
        url: resolveUrl(base, lines[j]),
        bandwidth: +a['AVERAGE-BANDWIDTH'] || +a.BANDWIDTH || 0,
        w: res[0] || 0,
        h: res[1] || 0,
        codecs: a.CODECS || '',
        // Keep this on each variant: downloading its URL alone would lose the audio association.
        externalAudio: audio.some((r) => r.group === a.AUDIO && r.url),
      });
    }
    return { master: true, variants };
  }

  const segs = [];
  let mediaSeq = 0;
  let key = null;
  let map = null;
  let pendingDur = 0;
  let range = null;
  let lastEnd = 0;
  let duration = 0;
  let endlist = false;
  let unsupported = null;

  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSeq = parseInt(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXTINF:')) pendingDur = parseFloat(l.slice(8)) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = attrs(l.slice(11));
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128' && a.URI) key = { uri: resolveUrl(base, a.URI), iv: a.IV || null };
      else unsupported = a.METHOD || 'UNKNOWN';
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = attrs(l.slice(11));
      if (a.URI) map = { url: resolveUrl(base, a.URI) };
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      const [len, off] = l.slice(17).split('@');
      const start = off !== undefined ? parseInt(off) : lastEnd;
      range = { start, end: start + parseInt(len) - 1 };
      lastEnd = range.end + 1;
    } else if (l.startsWith('#EXT-X-ENDLIST')) endlist = true;
    else if (!l.startsWith('#')) {
      segs.push({ url: resolveUrl(base, l), dur: pendingDur, key, seq: mediaSeq + segs.length, range });
      duration += pendingDur;
      pendingDur = 0;
      range = null;
    }
  }
  return { master: false, segs, duration, map, endlist, unsupported };
}

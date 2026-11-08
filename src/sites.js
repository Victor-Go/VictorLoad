// Site-specific extraction: Bilibili and YouTube (direct links fetched from their public APIs in the background)
import { normKey, pageKeyOf } from './shared.js';

export function siteOf(pageUrl) {
  try {
    const h = new URL(pageUrl).hostname;
    if (/(^|\.)bilibili\.com$/.test(h)) return 'bilibili';
    if (/(^|\.)youtube\.com$/.test(h) || h === 'youtu.be') return 'youtube';
    if (/(^|\.)(x|twitter)\.com$/.test(h)) return 'twitter';
  } catch {
    // Not a parseable URL (an empty tab URL, say): no site
  }
  return null;
}

/** These sites have dedicated extractors; sniffed segments/manifests are ignored to avoid duplicates */
export function hasVideoExtractor(pageUrl) {
  return siteOf(pageUrl) !== null;
}

export async function extractSite(site, pageUrl) {
  if (site === 'bilibili') return extractBilibili(pageUrl);
  if (site === 'youtube') return extractYouTube(pageUrl);
  return [];
}

async function jget(url, init = {}) {
  const r = await fetch(url, { credentials: 'include', ...init });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ---- Bilibili ----
const BILI_H = {
  127: 4320,
  126: 2160,
  125: 2160,
  120: 2160,
  116: 1080,
  112: 1080,
  80: 1080,
  74: 720,
  64: 720,
  32: 480,
  16: 360,
};
const BILI_L = {
  127: '8K',
  126: '杜比视界',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
};

async function extractBilibili(pageUrl) {
  const u = new URL(pageUrl);
  const m = u.pathname.match(/\/video\/(BV\w+|av\d+)/i);
  if (!m) return [];
  const id = m[1];
  const idParam = /^av/i.test(id) ? 'aid=' + id.slice(2) : 'bvid=' + id;
  const info = await jget('https://api.bilibili.com/x/web-interface/view?' + idParam);
  if (info.code !== 0) throw new Error(info.message || 'bilibili view error');
  const d = info.data;
  const bvid = d.bvid;
  const p = parseInt(u.searchParams.get('p') || '1') || 1;
  const page = d.pages?.[p - 1] || d.pages?.[0];
  const cid = page.cid;
  const title = d.title + (d.pages.length > 1 ? ` P${p} ${page.part || ''}` : '');

  const api = (qn) =>
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${qn}&fnval=0&fnver=0&fourk=1&platform=html5&high_quality=1`;
  const first = await jget(api(127));
  if (first.code !== 0) throw new Error(first.message || 'bilibili playurl error');

  const accept = first.data.accept_quality?.length ? first.data.accept_quality : [first.data.quality];
  const results = await Promise.all(
    accept.map(async (qn) => {
      try {
        const r = qn === first.data.quality ? first : await jget(api(qn));
        const dd = r.data;
        if (dd.quality !== qn || dd.durl?.length !== 1) return null;
        return { qn, url: dd.durl[0].url, size: dd.durl[0].size || 0 };
      } catch {
        return null;
      }
    }),
  );
  const qualities = results
    .filter(Boolean)
    .map((r) => ({
      label: BILI_L[r.qn] || String(r.qn),
      height: BILI_H[r.qn] || 0,
      url: r.url,
      ext: 'mp4',
      type: 'direct',
      size: r.size,
    }))
    .sort((a, b) => b.height - a.height);

  return [
    {
      kind: 'video',
      source: 'site',
      key: `bili:${bvid}:${cid}`,
      title,
      thumb: d.pic ? d.pic.replace(/^http:/, 'https:') : '',
      w: d.dimension?.width || 0,
      h: d.dimension?.height || 0,
      duration: page.duration || d.duration || 0,
      siteMain: true,
      keys: [`bili:${bvid}:${cid}`, pageKeyOf(pageUrl)],
      qualities,
      error: qualities.length ? '' : '未获取到可下载的清晰度（可能需要登录或为番剧/付费内容）',
    },
  ];
}

// ---- YouTube ----
const YT_CLIENTS = [
  {
    id: 28,
    ver: '1.60.19',
    ctx: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      osName: 'Android',
      osVersion: '12L',
      androidSdkVersion: 32,
      hl: 'en',
    },
  },
  {
    id: 5,
    ver: '19.45.4',
    ctx: {
      clientName: 'IOS',
      clientVersion: '19.45.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.1.0.22B83',
      hl: 'en',
    },
  },
];

function ytVideoId(pageUrl) {
  const u = new URL(pageUrl);
  if (u.hostname === 'youtu.be') return u.pathname.slice(1);
  if (u.pathname === '/watch') return u.searchParams.get('v');
  const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{6,})/);
  return m ? m[2] : null;
}

async function extractYouTube(pageUrl) {
  const vid = ytVideoId(pageUrl);
  if (!vid) return [];
  let resp = null;
  let lastError = '';
  for (const c of YT_CLIENTS) {
    try {
      const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': String(c.id),
          'X-YouTube-Client-Version': c.ver,
        },
        body: JSON.stringify({
          videoId: vid,
          contentCheckOk: true,
          racyCheckOk: true,
          context: { client: c.ctx },
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.streamingData && (j.streamingData.formats?.length || j.streamingData.adaptiveFormats?.length)) {
        resp = j;
        break;
      }
      resp = resp || j;
    } catch (e) {
      // Keep diagnostics in the console; missing direct links are an expected capture fallback.
      lastError = String((e && e.message) || e);
      console.warn('[VictorLoad] YouTube client', c.ctx.clientName, 'failed', e);
    }
  }
  const det = resp?.videoDetails || {};
  const sd = resp?.streamingData || {};
  const qualities = [];

  const extOf = (mime) => (/webm/.test(mime) ? 'webm' : /audio\/mp4/.test(mime) ? 'm4a' : 'mp4');

  for (const f of sd.formats || []) {
    if (!f.url) continue; // formats that need signature deciphering are not supported
    qualities.push({
      label: `${f.height || f.qualityLabel || '?'}p`,
      height: f.height || 0,
      url: f.url,
      ext: extOf(f.mimeType || ''),
      type: 'direct',
      size: +f.contentLength || 0,
    });
  }

  const adaptive = (sd.adaptiveFormats || []).filter((f) => f.url);
  const audios = adaptive.filter((f) => /^audio\//.test(f.mimeType || ''));
  const bestAudio =
    audios.filter((f) => /audio\/mp4/.test(f.mimeType)).sort((a, b) => b.bitrate - a.bitrate)[0] ||
    audios.sort((a, b) => b.bitrate - a.bitrate)[0];
  const bestByHeight = new Map();
  for (const f of adaptive) {
    if (!/^video\//.test(f.mimeType || '')) continue;
    const cur = bestByHeight.get(f.height);
    const isMp4 = /mp4/.test(f.mimeType);
    if (
      !cur ||
      (isMp4 && !/mp4/.test(cur.mimeType)) ||
      (isMp4 === /mp4/.test(cur.mimeType) && f.bitrate > cur.bitrate)
    ) {
      bestByHeight.set(f.height, f);
    }
  }
  const muxedHeights = new Set(qualities.map((q) => q.height));
  for (const [h, f] of bestByHeight) {
    if (muxedHeights.has(h) && !bestAudio) continue;
    qualities.push({
      label: `${h}p · 视频+音频分开`,
      height: h,
      url: f.url,
      audioUrl: bestAudio?.url || '',
      audioExt: bestAudio ? extOf(bestAudio.mimeType) : '',
      ext: extOf(f.mimeType || ''),
      type: bestAudio ? 'split' : 'direct',
      size: +f.contentLength || 0,
    });
  }
  if (sd.hlsManifestUrl) {
    qualities.push({ label: 'HLS 直播/清单', height: 0, url: sd.hlsManifestUrl, ext: 'ts', type: 'hls' });
  }
  qualities.sort((a, b) => b.height - a.height);

  if (!qualities.length && (resp?.playabilityStatus?.reason || lastError)) {
    console.info('[VictorLoad] using buffered YouTube download', resp?.playabilityStatus?.reason || lastError);
  }
  return [
    {
      kind: 'video',
      source: 'site',
      key: 'yt:' + vid,
      title: det.title || '', // the background supplies the real tab title while metadata is unavailable
      thumb: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      w: 0,
      h: 0,
      duration: +det.lengthSeconds || 0,
      siteMain: true,
      posterOnly: true,
      keys: ['yt:' + vid, pageKeyOf(pageUrl), normKey(`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`)],
      qualities,
      waitingForCapture: !qualities.length,
      error: '',
    },
  ];
}

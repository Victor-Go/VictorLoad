// Content script. Scans the page for images and videos, reports them to the background,
// puts a green check on the ones that were already downloaded and a blue download arrow on the others.
(() => {
  if (window.__victorloadContent) return;
  window.__victorloadContent = true;

  const HOST = location.hostname;
  const IS_TW = /(^|\.)(x|twitter)\.com$/.test(HOST);
  const IS_YT = /(^|\.)youtube\.com$/.test(HOST);
  const IS_PAGE_SITE = /(^|\.)(bilibili|youtube)\.com$/.test(HOST) || HOST === 'youtu.be';
  const IMG_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)(\?|#|$)/i;
  const MAX_IMG = 600;
  const MAX_VID = 100;

  // ---- Utilities ----
  const abs = (u) => {
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return '';
    }
  };

  // Same as normKey / pageKeyOf in shared.js (a content script can't import modules)
  function normKey(u) {
    if (!u || typeof u !== 'string') return '';
    if (u.startsWith('data:')) return 'data:' + u.length + ':' + u.slice(5, 60);
    try {
      const x = new URL(u);
      if (x.hostname === 'pbs.twimg.com' && x.pathname.startsWith('/media/')) {
        return 'tw:' + x.pathname.split('/')[2].replace(/\.\w+$/, '');
      }
      if (x.hostname.endsWith('.twimg.com')) return x.origin + x.pathname;
      x.hash = '';
      return x.href;
    } catch {
      return u;
    }
  }

  function pageKeyOf(u) {
    try {
      const x = new URL(u);
      const h = x.hostname;
      if (/(^|\.)bilibili\.com$/.test(h)) {
        const p = x.searchParams.get('p');
        return 'page:' + x.origin + x.pathname + (p && p !== '1' ? '?p=' + p : '');
      }
      if (/(^|\.)youtube\.com$/.test(h) || h === 'youtu.be') {
        const v = x.searchParams.get('v') || x.pathname.split('/').filter(Boolean).pop();
        return 'page:yt:' + v;
      }
      return 'page:' + x.origin + x.pathname;
    } catch {
      return 'page:' + u;
    }
  }

  /**
   * Where an element sits in the page: itself plus its 3 closest ancestors, written as tag + data-testid
   * or class names. Classes with digits are skipped, they are usually generated.
   */
  function part(el) {
    const tag = el.tagName.toLowerCase();
    const tid = el.getAttribute('data-testid');
    if (tid) return `${tag}[${tid}]`;
    const cls = [...el.classList].filter((c) => c.length < 24 && !/\d/.test(c)).slice(0, 2);
    return tag + (cls.length ? '.' + cls.join('.') : '');
  }
  function sig(el) {
    const out = [];
    let e = el;
    for (let i = 0; i < 4 && e && e !== document.documentElement; i++) {
      out.push(part(e));
      e = e.parentElement;
    }
    return out.join('<');
  }

  function largestSrcset(srcset) {
    let best = '';
    let bestN = -1;
    for (const part of (srcset || '').split(',')) {
      const [u, d] = part.trim().split(/\s+/);
      if (!u) continue;
      const n = d ? parseFloat(d) || 1 : 1;
      if (n > bestN) {
        bestN = n;
        best = u;
      }
    }
    return best;
  }

  function upgradeTwitter(u) {
    try {
      const x = new URL(u);
      if (x.hostname === 'pbs.twimg.com' && x.pathname.startsWith('/media/')) {
        let fmt = x.searchParams.get('format');
        const m = x.pathname.match(/\.(\w+)$/);
        if (!fmt && m) fmt = m[1];
        x.pathname = x.pathname.replace(/\.\w+$/, '');
        x.search = '';
        x.searchParams.set('format', fmt || 'jpg');
        x.searchParams.set('name', 'orig');
        return x.href;
      }
    } catch {
      // Not a parseable URL: leave it as it is
    }
    return u;
  }

  function twitterSiteMain(img, url) {
    if (!IS_TW) return undefined;
    if (/profile_images|\/emoji\/|hashflags|profile_banners|ad_img|\/semantic_core_img\//.test(url)) return false;
    if (img.closest('[data-testid="tweetPhoto"], [data-testid="swipe-to-dismiss"]')) return true;
    if (img.closest('[data-testid^="UserAvatar"], [data-testid="Tweet-User-Avatar"]')) return false;
    return undefined;
  }

  // ---- Scanning ----
  let badgeCandidates = []; // [{el, keys, quick}], used for the badges; quick = may get the one-click download arrow
  let downKeys = new Set();
  let settings = { showBadge: true, pageDlBtn: true };
  const twItems = new Map(); // Twitter videos (from the MAIN-world hook)
  let mseStatus = null; // YouTube segment-capture status (from mse.js)
  let lastPayload = '';
  let scanTimer = null;
  let forced = false;

  function collectImages() {
    const out = [];
    const seen = new Set();
    const push = (el, thumb, full, extra) => {
      if (out.length >= MAX_IMG) return;
      if (!full || seen.has(full)) return;
      if (full.startsWith('data:') && full.length < 3000) return;
      if (/^(blob:|about:|javascript:)/.test(full)) return;
      seen.add(full);
      const r = el.getBoundingClientRect();
      const url = IS_TW ? upgradeTwitter(full) : full;
      const keys = [normKey(url), normKey(thumb)].filter(Boolean);
      const inChrome = !!el.closest('nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"]');
      const siteMain = twitterSiteMain(el, full);
      out.push({
        url,
        thumb: thumb || url,
        w: 0,
        h: 0,
        rw: Math.round(r.width),
        rh: Math.round(r.height),
        sig: sig(el),
        inChrome,
        siteMain,
        keys,
        ...extra,
      });
      // The still frame of an X video (media grid, search results) stands for the video: tie it to the video's
      // keys so the check shows once the video is downloaded and the arrow downloads the video, not the jpg.
      let badgeKeys = keys;
      let quick = !IS_YT && !inChrome && siteMain !== false && r.width >= 150 && r.height >= 150;
      if (IS_TW && /video_thumb\//.test(full)) {
        const tid = el
          .closest('a[href*="/status/"]')
          ?.getAttribute('href')
          ?.match(/\/status\/(\d+)/)?.[1];
        const vids = [...twItems.values()].filter((it) => tid && it.tweetId === tid);
        badgeKeys = [...keys, ...vids.flatMap((it) => ['tw-vid:' + it.id, normKey(it.thumb)])];
        if (!vids.length) quick = false; // the video is not known (yet): nothing but the still frame to fetch
      }
      badgeCandidates.push({ el, keys: badgeKeys, quick });
    };

    for (const img of document.images) {
      let src = img.currentSrc || img.src || '';
      if (!src || src.startsWith('data:image/gif;base64,R0lGOD') || (src.startsWith('data:') && src.length < 3000)) {
        src =
          abs(
            img.dataset.src || img.dataset.original || img.dataset.lazySrc || img.getAttribute('data-lazy-src') || '',
          ) || src;
      }
      if (!src) continue;
      const thumb = abs(src);
      let full = thumb;
      let upgraded = false;
      const a = img.closest('a[href]');
      if (a && IMG_EXT.test(a.getAttribute('href') || '')) {
        full = abs(a.getAttribute('href'));
        upgraded = full !== thumb;
      } else {
        const ss = largestSrcset(img.srcset);
        if (ss && abs(ss) !== thumb) {
          full = abs(ss);
          upgraded = true;
        }
      }
      push(img, thumb, full, {
        w: upgraded ? 0 : img.naturalWidth || 0,
        h: upgraded ? 0 : img.naturalHeight || 0,
        upgraded,
      });
      const last = out[out.length - 1];
      if (last && last.thumb === thumb && !last.w && !upgraded) {
        last.w = img.naturalWidth || 0;
        last.h = img.naturalHeight || 0;
      }
    }

    // Background images in inline styles
    for (const el of document.querySelectorAll('[style*="url("]')) {
      if (out.length >= MAX_IMG) break;
      const m = (el.getAttribute('style') || '').match(/url\((['"]?)(.+?)\1\)/);
      if (!m) continue;
      const u = abs(m[2]);
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 80) continue;
      push(el, u, u, { bg: true });
    }
    return out;
  }

  function collectVideos() {
    const out = [];
    for (const v of document.querySelectorAll('video')) {
      if (out.length >= MAX_VID) break;
      const r = v.getBoundingClientRect();
      const srcs = [];
      const add = (u, label, hint) => {
        if (!u) return;
        const a = abs(u);
        if (!a || /^(blob:|mediastream:|data:)/.test(a)) return;
        if (!srcs.some((s) => s.url === a)) srcs.push({ url: a, label, hint });
      };
      add(v.currentSrc || v.src, '', 0);
      for (const s of v.querySelectorAll('source')) {
        const lbl =
          s.getAttribute('label') ||
          s.getAttribute('title') ||
          s.getAttribute('data-res') ||
          s.getAttribute('res') ||
          '';
        const size = parseInt(s.getAttribute('size') || '') || parseInt(lbl) || 0;
        add(s.src || s.getAttribute('src'), lbl, size);
      }
      const keys = [normKey(abs(v.poster || ''))].filter(Boolean);
      if (IS_PAGE_SITE && r.width >= 200) keys.push(pageKeyOf(location.href));
      if (!srcs.length) {
        // A video without a direct address (blob:, YouTube) has nothing to fetch, except where the background extracts it
        if (keys.length) badgeCandidates.push({ el: v, keys, quick: IS_PAGE_SITE && !IS_YT && r.width >= 200 });
        continue;
      }
      const vh = v.videoHeight || 0;
      const qualities = srcs.map((s) => {
        const hls = /\.m3u8(\?|$)/i.test(s.url);
        const height = s.hint || (srcs.length === 1 ? vh : 0);
        const ext = hls
          ? 'ts'
          : (s.url.split('?')[0].match(/\.(mp4|webm|m4v|mov|flv|mkv)$/i)?.[1] || 'mp4').toLowerCase();
        return {
          label: s.label || (height ? height + 'p' : hls ? 'HLS' : ext.toUpperCase()),
          height,
          url: s.url,
          ext,
          type: hls ? 'hls' : 'direct',
        };
      });
      for (const q of qualities) keys.push(normKey(q.url));
      badgeCandidates.push({ el: v, keys, quick: !IS_YT && r.width >= 200 });
      out.push({
        source: 'dom',
        title: document.title,
        thumb: v.poster ? abs(v.poster) : '',
        w: v.videoWidth || 0,
        h: vh,
        rw: Math.round(r.width),
        rh: Math.round(r.height),
        duration: isFinite(v.duration) ? v.duration : 0,
        sig: sig(v),
        keys,
        qualities,
      });
    }
    return out;
  }

  function collectTwitter() {
    if (!IS_TW || !twItems.size) return [];
    // Only list videos whose tweet is still on the page (the timeline drops tweets as you scroll)
    const ids = new Set();
    for (const a of document.querySelectorAll('a[href*="/status/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/status\/(\d+)/);
      if (m) ids.add(m[1]);
    }
    const posters = new Map();
    for (const v of document.querySelectorAll('video[poster]')) posters.set(normKey(v.poster), v);
    const out = [];
    for (const it of twItems.values()) {
      const tk = normKey(it.thumb);
      const present = (it.tweetId && ids.has(it.tweetId)) || posters.has(tk);
      if (!present) continue;
      const vs = [...it.variants].sort((a, b) => b.bitrate - a.bitrate);
      const qualities = vs.map((v) => ({
        label: it.type === 'animated_gif' ? 'GIF' : v.h ? v.h + 'p' : Math.round(v.bitrate / 1000) + 'kbps',
        height: v.h,
        url: v.url,
        ext: 'mp4',
        type: 'direct',
        bitrate: v.bitrate,
      }));
      const el = posters.get(tk);
      const keys = ['tw-vid:' + it.id, tk];
      if (el) badgeCandidates.push({ el, keys, quick: true });
      const text = (it.text || '')
        .replace(/https?:\/\/t\.co\/\w+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
      out.push({
        key: 'tw-vid:' + it.id,
        source: 'site',
        title: `${it.user ? '@' + it.user + ' ' : ''}${text || 'tweet ' + it.tweetId}`.trim(),
        thumb: it.thumb,
        w: it.w,
        h: it.h,
        duration: it.duration,
        siteMain: true,
        sig: el ? sig(el) : '',
        keys,
        qualities,
      });
    }
    return out;
  }

  function ytCurrentId() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get('v') || (u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{6,})/) || [])[2] || '';
    } catch {
      return '';
    }
  }

  function collectCapture() {
    if (!IS_YT || !mseStatus || window !== window.top) return [];
    const s = mseStatus;
    const id = ytCurrentId();
    if (!id || s.videoId !== id) return [];
    const aud = [...s.audio].sort((a, b) => b.cov - a.cov)[0];
    const vids = s.video.filter((g) => g.cov > 0.01 || s.video.length === 1).sort((a, b) => b.h - a.h);
    const codecName = (c) => (/avc1/.test(c) ? 'H.264' : /vp0?9/.test(c) ? 'VP9' : /av01/.test(c) ? 'AV1' : '');
    const qualities = vids.map((g) => ({
      label: `${g.h ? g.h + 'p' : '视频'} ${codecName(g.codec)}`.trim(),
      codec: codecName(g.codec),
      height: g.h,
      type: 'capture',
      vgid: g.gid,
      agid: aud ? aud.gid : '',
      ext: 'mp4',
      cov: g.cov,
      holes: g.holes,
      gaps: g.gaps,
      size: g.bytes + (aud ? aud.bytes : 0),
    }));
    if (!qualities.length && aud) {
      qualities.push({
        label: '仅音频',
        codec: '',
        height: 0,
        type: 'capture',
        vgid: '',
        agid: aud.gid,
        ext: 'm4a',
        cov: aud.cov,
        holes: aud.holes,
        gaps: aud.gaps,
        size: aud.bytes,
      });
    }
    const bestV = vids.reduce((m, g) => Math.max(m, g.cov), 0);
    const thumb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    return [
      {
        key: 'yt:' + id,
        source: 'site',
        title: s.title,
        thumb,
        duration: s.duration || 0,
        siteMain: true,
        posterOnly: true,
        keys: ['yt:' + id, pageKeyOf(location.href), normKey(thumb)],
        qualities,
        // Video coverage already accounts for the audio track's gaps (see status() in mse.js)
        capture: {
          cov: aud ? bestV : 0,
          filling: !!s.filling,
          fillResult: s.fillResult || '',
          hasAudio: !!aud,
          full: !!s.full,
          rejected: s.rejected | 0,
          captureErrors: s.captureErrors | 0,
        },
      },
    ];
  }

  function scan() {
    scanTimer = null;
    badgeCandidates = [];
    const images = collectImages();
    const videos = collectVideos();
    const site = [...collectTwitter(), ...collectCapture()];
    const keys = [...new Set(badgeCandidates.flatMap((c) => c.keys))];
    const payload = { type: 'scan', pageUrl: location.href, title: document.title, images, videos, site, keys };
    const s = JSON.stringify(payload);
    if (s === lastPayload && !forced) {
      applyBadges();
      return;
    }
    lastPayload = s;
    forced = false;
    try {
      chrome.runtime.sendMessage(payload, (res) => {
        if (chrome.runtime.lastError) return;
        downKeys = new Set(res?.down || []);
        applyBadges();
      });
    } catch {
      // After an extension reload the old content script loses its connection. Nothing to do.
    }
  }

  function queueScan(delay = 300) {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, delay);
  }

  // ---- Page badges: a green check on downloaded items, a blue download arrow on the rest ----
  let host = null;
  let layer = null;
  let badges = []; // {el, node, mode: 'done' | 'dl', keys}

  const CHECK_SVG =
    '<svg viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 6.4l2.6 2.6 5-5.6"/></svg>';
  const ARROW_SVG =
    '<svg viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v6.2M3.2 5.6L6 8.4l2.8-2.8"/></svg>';

  function ensureLayer() {
    if (layer && host.isConnected) return;
    host = document.createElement('div');
    host.id = '__victorload_badges';
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .b{position:fixed;left:0;top:0;width:15px;height:15px;border-radius:50%;background:#16a34a;
         box-shadow:0 0 0 1.5px #fff,0 1px 3px rgba(0,0,0,.45);display:none;align-items:center;justify-content:center}
      .b svg{width:9px;height:9px}
      .b.dl{background:#2563eb;pointer-events:auto;cursor:pointer}
      .b.dl:hover{background:#1d4ed8}
      .b.busy{opacity:.55;pointer-events:none}
      .b.fail{background:#dc2626}
    </style><div id="l"></div>`;
    layer = root.getElementById('l');
    (document.documentElement || document.body).appendChild(host);
  }

  function startQuickDownload(b) {
    if (b.node.classList.contains('busy')) return;
    b.node.classList.remove('fail');
    b.node.classList.add('busy');
    const done = (ok) => {
      b.node.classList.remove('busy');
      if (!ok) {
        b.node.classList.add('fail');
        setTimeout(() => b.node.classList.remove('fail'), 1800);
      }
    };
    try {
      // The background downloads the highest quality through the same path as the panel's buttons
      chrome.runtime.sendMessage({ type: 'quick-download', keys: b.keys }, (res) => {
        if (chrome.runtime.lastError) return done(false);
        done(!!res?.ok);
      });
    } catch {
      done(false); // the extension was reloaded: this page needs a refresh
    }
  }

  function applyBadges() {
    // el -> {mode, keys}. A downloaded item always shows the check, never the arrow.
    const want = new Map();
    for (const c of badgeCandidates) {
      if (c.keys.some((k) => downKeys.has(k))) {
        if (settings.showBadge) want.set(c.el, { mode: 'done', keys: c.keys });
      } else if (settings.pageDlBtn && c.quick && c.keys.length && !want.has(c.el)) {
        want.set(c.el, { mode: 'dl', keys: c.keys });
      }
    }
    // Remove badges that are no longer needed (or changed from arrow to check)
    badges = badges.filter((b) => {
      const w = want.get(b.el);
      if (w && w.mode === b.mode && b.el.isConnected) {
        b.keys = w.keys;
        return true;
      }
      b.node.remove();
      return false;
    });
    if (want.size) ensureLayer();
    for (const [el, w] of want) {
      if (badges.some((b) => b.el === el)) continue;
      const node = document.createElement('div');
      node.className = w.mode === 'dl' ? 'b dl' : 'b';
      node.innerHTML = w.mode === 'dl' ? ARROW_SVG : CHECK_SVG;
      const b = { el, node, mode: w.mode, keys: w.keys };
      if (w.mode === 'dl') {
        node.title = 'VictorLoad';
        // Keep the click away from the page (a video or tweet underneath would react to it)
        for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick'])
          node.addEventListener(ev, (e) => e.stopPropagation());
        node.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          startQuickDownload(b);
        });
      }
      layer.appendChild(node);
      badges.push(b);
    }
    positionBadges();
  }

  /**
   * The badge layer is above the whole page, so without a check it would also show through whatever covers
   * the element (a photo viewer, a dialog, a sticky bar). Sample the page just beside the badge: the element
   * (or something inside the same card, like a link layer) must be what the user would see there.
   */
  function isOnTop(el, x, y) {
    const hit = document.elementFromPoint(Math.max(0, x), Math.max(0, y));
    if (!hit) return false;
    if (hit === el || el.contains(hit) || hit.contains(el)) return true;
    let a = hit.parentElement;
    while (a && !a.contains(el)) a = a.parentElement;
    if (!a) return false;
    const ar = a.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return ar.width * ar.height <= er.width * er.height * 2.5;
  }

  function positionBadges() {
    for (const b of badges) {
      const r = b.el.getBoundingClientRect();
      const min = b.mode === 'dl' ? 120 : 24; // arrows only on content-sized elements, never on small icons
      let vis =
        b.el.isConnected &&
        r.width >= min &&
        r.height >= min &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < innerHeight &&
        r.left < innerWidth;
      const x = Math.min(r.right, innerWidth) - 15 - 5;
      const y = Math.min(r.bottom, innerHeight) - 15 - 5;
      // Probe 3px up-left of the badge: our own arrow sits at (x, y) and must not be what we hit
      if (vis && !isOnTop(b.el, x - 3, y - 3)) vis = false;
      b.node.style.display = vis ? 'flex' : 'none';
      if (vis) b.node.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    }
  }

  // ---- Events ----
  const pendingControls = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__victorload !== 1) return;
    if (e.data.kind === 'mse-control') {
      const control = pendingControls.get(e.data.requestId);
      if (control) {
        clearTimeout(control.timer);
        pendingControls.delete(e.data.requestId);
        control.respond({ ok: e.data.ok === true });
      }
    } else if (e.data.kind === 'tw-video') {
      const it = e.data.item;
      twItems.set(it.id, it);
      queueScan(200);
    } else if (e.data.kind === 'mse-status') {
      mseStatus = e.data.status;
      queueScan(100);
    } else if (e.data.kind === 'mse-save') {
      const { jobId, state, pct, name, error, holes, gaps } = e.data;
      try {
        chrome.runtime.sendMessage({
          type: 'cap-result',
          jobId,
          state,
          pct,
          name,
          error,
          holes,
          gaps,
          pageUrl: location.href,
          title: document.title,
        });
      } catch (err) {
        // Catches synchronous send failures only. Async delivery failures remain a known issue.
        console.warn('[VictorLoad] could not report the save result; reload the page', err);
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === 'rescan') {
      forced = true;
      queueScan(20);
      // Ask the MAIN-world capture script (YouTube only) to resend its status
      window.postMessage({ __victorloadCmd: 1, cmd: 'status' }, '*');
    } else if (msg?.type === 'cap-save') {
      // auto: buffer the missing parts first, then save; otherwise save what is captured right now
      window.postMessage(
        {
          __victorloadCmd: 1,
          cmd: msg.auto ? 'autosave' : 'save',
          jobId: msg.jobId,
          vgid: msg.vgid,
          agid: msg.agid,
          name: msg.name,
        },
        '*',
      );
    } else if (msg?.type === 'cap-ctl') {
      // Only acknowledge after the MAIN-world script actually processed the command.
      const requestId = msg.requestId;
      const timer = setTimeout(() => {
        pendingControls.delete(requestId);
        respond({ ok: false });
      }, 4000);
      pendingControls.set(requestId, { timer, respond });
      window.postMessage({ __victorloadCmd: 1, cmd: msg.cmd, requestId }, '*');
      return true;
    }
  });

  chrome.storage.local.get('settings').then((r) => {
    settings = { showBadge: true, pageDlBtn: true, ...(r.settings || {}) };
    applyBadges();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.settings) {
      settings = { showBadge: true, pageDlBtn: true, ...(ch.settings.newValue || {}) };
      applyBadges();
    }
  });

  const mo = new MutationObserver(() => queueScan());
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'poster', 'href', 'data-src'],
  });
  document.addEventListener('load', () => queueScan(400), true);
  document.addEventListener('loadedmetadata', () => queueScan(200), true);
  addEventListener('scroll', positionBadges, { capture: true, passive: true });
  addEventListener('resize', () => {
    positionBadges();
    queueScan(500);
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      queueScan(0);
      positionBadges();
    }
  }, 1500);

  // In-page (SPA) navigation
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      forced = true;
      queueScan(300);
    }
  }, 700);

  queueScan(50);
})();

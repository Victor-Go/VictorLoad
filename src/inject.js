// Runs in the page's MAIN world, only on x.com / twitter.com:
// Hooks the page's own fetch / XHR, extracts the mp4 variants from tweet API responses and hands them to content.js via postMessage.
(() => {
  if (window.__victorloadHooked) return;
  window.__victorloadHooked = true;

  const API = /\/graphql\/|\/i\/api\/|\/1\.1\/|\/2\/timeline/;
  const sent = new Set();

  function post(item) {
    const k = item.id + ':' + item.variants.length;
    if (sent.has(k)) return;
    sent.add(k);
    window.postMessage({ __victorload: 1, kind: 'tw-video', item }, '*');
  }

  function walk(o, ctx, depth) {
    if (!o || typeof o !== 'object' || depth > 40) return;
    if (Array.isArray(o)) {
      for (const v of o) walk(v, ctx, depth + 1);
      return;
    }
    let c = ctx;
    if (o.rest_id && o.legacy && (o.legacy.full_text !== undefined || o.legacy.extended_entities)) {
      const user = o.core?.user_results?.result;
      c = {
        tweetId: o.rest_id,
        text: o.legacy.full_text || '',
        user: user?.core?.screen_name || user?.legacy?.screen_name || '',
      };
    }
    if (o.video_info && Array.isArray(o.video_info.variants) && o.media_url_https) {
      const variants = o.video_info.variants
        .filter((v) => v.content_type === 'video/mp4' && v.url)
        .map((v) => {
          const m = v.url.match(/\/(\d+)x(\d+)\//);
          return { url: v.url, bitrate: v.bitrate || 0, w: m ? +m[1] : 0, h: m ? +m[2] : 0 };
        });
      if (variants.length) {
        post({
          id: o.id_str || o.media_key || o.media_url_https,
          tweetId: c?.tweetId || '',
          user: c?.user || '',
          text: c?.text || '',
          thumb: o.media_url_https,
          type: o.type,
          duration: (o.video_info.duration_millis || 0) / 1000,
          w: o.original_info?.width || 0,
          h: o.original_info?.height || 0,
          variants,
        });
      }
    }
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object') walk(v, c, depth + 1);
    }
  }

  function handle(url, text) {
    if (!API.test(url) || !text || text[0] !== '{') return;
    try {
      walk(JSON.parse(text), null, 0);
    } catch {
      // Not JSON (or cut off): not a tweet response. Stay silent, this runs inside the page.
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const u = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0]);
      if (API.test(u)) {
        p.then((r) =>
          r
            .clone()
            .text()
            .then((t) => handle(u, t))
            .catch(() => {}),
        ).catch(() => {});
      }
    } catch {
      // Inspecting the request must never break the page's own fetch
    }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__vlUrl = String(url);
    } catch {
      // String(url) can throw for exotic objects; the request itself goes ahead untouched
    }
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', () => {
      try {
        if (API.test(this.__vlUrl || '') && (this.responseType === '' || this.responseType === 'text')) {
          handle(this.__vlUrl, this.responseText);
        }
      } catch {
        // responseText throws for some response types; not a tweet response then
      }
    });
    return origSend.apply(this, a);
  };
})();

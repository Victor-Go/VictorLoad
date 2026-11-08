import { T, setLang, applyDom } from './i18n.js';
import {
  DEFAULTS,
  hostOf,
  fmtBytes,
  fmtDur,
  maxHeight,
  classifyImages,
  isMainVideo,
  formatName,
  keyHash,
  downloadedKeySet,
  historyThumb,
} from './shared.js';
import { videoNotice, siteErrorText, historyNoticeText } from './notices.js';

// Opened as a toolbar popup (see syncUiMode in background.js): use a fixed-size layout
const IS_POPUP = new URLSearchParams(location.search).has('popup');
if (IS_POPUP) document.documentElement.classList.add('popup');

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

// ---- State ----
let S = { ...DEFAULTS };
let remembered = {}; // host -> {image:[sig], video:[sig]}
let history = [];
let downKeys = new Set(); // hashed keys of everything downloaded (see keyHash)
let historyNotice = null; // set when the background could not keep the full history
let tabId = null;
let state = { images: [], videos: [], host: '', pageUrl: '', loading: false, siteError: '' };
let supported = true;
let faviconUrl = '';

const sel = new Map(); // id -> manual selection
const touched = new Set(); // ids whose selection the user changed
const pickedQuality = new Map(); // id -> quality index
const dims = {}; // id -> size measured from the preview image
const broken = new Set(); // image ids whose preview failed to load: kept out of "Main"
const dl = new Map(); // id -> {state,pct,msg}
const cards = new Map(); // `${kind}:${id}` -> card

let imgMain = new Set();
let vidMain = new Set();
let playing = null;

const listEl = $('#list');

// ---- Storage ----
// A failed write means the choice is lost on the next start: say so instead of failing silently
function storeLocal(items, what) {
  return chrome.storage.local.set(items).catch((e) => {
    console.warn('[VictorLoad] could not save', what, e);
    toast(T('保存失败：') + (e && e.message ? e.message : e));
  });
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => storeLocal({ settings: S }, 'settings'), 200);
}
const saveRemembered = () => storeLocal({ remembered }, 'remembered');

function setHistory(list) {
  history = list || [];
  downKeys = downloadedKeySet(history);
}

function showHistoryNotice(n, withToast) {
  historyNotice = n || null;
  const box = $('#histNotice');
  box.classList.toggle('hidden', !historyNotice);
  $('.txt', box).textContent = historyNoticeText(historyNotice);
  if (historyNotice && withToast) {
    toast(historyNoticeText(historyNotice), { label: T('查看'), run: () => show('History') });
  }
}

// ---- Main-content rules ----
function remSets() {
  const r = remembered[state.host] || {};
  return { image: new Set(r.image || []), video: new Set(r.video || []) };
}

function derive() {
  const rem = remSets();
  imgMain = classifyImages(state.images, S, rem.image, dims);
  for (const id of broken) imgMain.delete(id);
  vidMain = new Set(state.videos.filter((v) => isMainVideo(v, S, rem.video)).map((v) => v.id));
}

const isMain = (it) => (it.kind === 'image' ? imgMain.has(it.id) : vidMain.has(it.id));

/** Default selection: images = main images; videos = only those matching a remembered tag structure */
function isSel(it) {
  if (touched.has(it.id)) return !!sel.get(it.id);
  if (it.kind === 'image') return imgMain.has(it.id);
  return !!(it.sig && remSets().video.has(it.sig));
}

const isDone = (it) => (it.keys || []).some((k) => downKeys.has(keyHash(k)));

function defaultQ(it) {
  const qs = it.qualities || [];
  if (!qs.length || !S.prefHeight) return 0;
  const i = qs.findIndex((q) => q.height && q.height <= S.prefHeight);
  return i >= 0 ? i : 0;
}
const qIndex = (it) => Math.min(pickedQuality.get(it.id) ?? defaultQ(it), Math.max(0, (it.qualities?.length || 1) - 1));

function visibleItems() {
  const kind = S.tab;
  const list = kind === 'video' ? state.videos : state.images;
  const mode = kind === 'video' ? S.vidMode : S.imgMode;
  return mode === 'main' ? list.filter(isMain) : list;
}

// ---- Notifications ----
function toast(msg, action) {
  const box = $('#toasts');
  const t = h('div', 'toast');
  const span = h('span');
  span.textContent = msg;
  t.append(span);
  if (action) {
    const b = h('button', '', action.label);
    b.onclick = () => {
      action.run();
      t.remove();
    };
    t.append(b);
  }
  box.append(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(
    () => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 300);
    },
    action ? 5000 : 2600,
  );
}

function setBtn(btn, label, pct) {
  $('.lbl', btn).textContent = label;
  $('.fill', btn).style.setProperty('--p', (pct || 0) + '%');
}

/* New-item detection: highlight / notify when something new is sniffed */
let known = { tabId: null, v: new Set(), i: new Set() };
const freshIds = new Set();

function applyState(s) {
  state = s;
  derive();
  const same = known.tabId === s.tabId;
  const newV = s.videos.filter((x) => !known.v.has(x.id));
  const newI = s.images.filter((x) => !known.i.has(x.id) && imgMain.has(x.id));
  if (same) {
    for (const x of newV) freshIds.add(x.id);
    for (const x of newI) freshIds.add(x.id);
    if (newV.length && S.tab !== 'video') {
      $('.tab[data-tab="video"]').classList.add('fresh');
      toast(T('发现 {n} 个新视频', { n: newV.length }), { label: T('查看'), run: () => switchTab('video') });
    }
    if (newI.length && S.tab !== 'image') {
      $('.tab[data-tab="image"]').classList.add('fresh');
      toast(T('发现 {n} 张新图片', { n: newI.length }), { label: T('查看'), run: () => switchTab('image') });
    }
  }
  known = { tabId: s.tabId, v: new Set(s.videos.map((x) => x.id)), i: new Set(s.images.map((x) => x.id)) };
  render();
}

function switchTab(kind) {
  S.tab = kind;
  saveSettings();
  if (playing) playing.stop();
  $(`.tab[data-tab="${kind}"]`).classList.remove('fresh');
  render();
}

// ---- Rendering ----
let rafPending = false;
function render() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderNow();
  });
}

const ICON_VIDEO =
  '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z"/></svg>';
const ICON_IMAGE =
  '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/></svg>';

function renderAvatar() {
  const avatar = $('#avatar');
  const letter = (state.host || 'V').replace(/^www\./, '')[0] || 'V';
  const key = JSON.stringify([letter, faviconUrl]);
  if (avatar.dataset.iconKey === key) return;
  avatar.dataset.iconKey = key;
  avatar.classList.remove('has-favicon');
  avatar.textContent = letter;
  if (!faviconUrl || !/^(https?:|data:image\/)/i.test(faviconUrl)) return;
  const img = document.createElement('img');
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.onload = () => {
    if (avatar.dataset.iconKey !== key) return;
    avatar.replaceChildren(img);
    avatar.classList.add('has-favicon');
  };
  img.onerror = () => {
    // Keep the initial letter if the tab icon is unavailable or its URL has expired.
    img.onload = img.onerror = null;
  };
  img.src = faviconUrl;
}

function renderNow() {
  derive();
  const kind = S.tab;
  const mode = kind === 'video' ? S.vidMode : S.imgMode;

  $$('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === kind));
  $(`.tab[data-tab="${kind}"]`).classList.remove('fresh');
  $('#cntVideo').textContent = state.videos.length;
  $('#cntImage').textContent = state.images.length;
  const all = kind === 'video' ? state.videos : state.images;
  $('#cntAll').textContent = all.length;
  $('#cntMain').textContent = all.filter(isMain).length;
  $$('.chip').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));

  const notice = $('#notice');
  if (supported && kind === 'video' && state.loading) {
    notice.textContent = T('正在解析站点视频…');
    notice.classList.remove('hidden');
  } else if (supported && kind === 'video' && state.siteError) {
    notice.textContent = siteErrorText(state.siteError);
    notice.classList.remove('hidden');
  } else if (supported && state.noScan) {
    notice.textContent = T('还没收到页面数据。若刚安装或更新过扩展，请刷新此页面（YouTube 缓冲下载必须刷新）。');
    notice.classList.remove('hidden');
  } else notice.classList.add('hidden');

  $('#host').textContent = state.host || (supported ? 'VictorLoad' : T('无法嗅探此页'));
  renderAvatar();
  $('#sum').textContent = supported
    ? T('{v} 个视频 · {i} 张图片', { v: state.videos.length, i: state.images.length })
    : T('浏览器内置页面不支持');

  const items = supported ? visibleItems() : [];
  listEl.classList.toggle('grid', kind === 'image');

  const wanted = new Set(items.map((i) => kind + ':' + i.id));
  for (const [k, c] of cards) {
    if (!wanted.has(k)) {
      c.destroy();
      c.el.remove();
      cards.delete(k);
    }
  }
  items.forEach((it, idx) => {
    const k = kind + ':' + it.id;
    let c = cards.get(k);
    if (!c) {
      c = kind === 'video' ? makeVideoCard(it) : makeImageCard(it);
      cards.set(k, c);
    }
    c.update(it);
    const ref = listEl.children[idx];
    if (ref !== c.el) listEl.insertBefore(c.el, ref || null);
  });

  const empty = $('#empty');
  if (!items.length) {
    const isV = kind === 'video';
    let title;
    let sub;
    let act = '';
    if (!supported) {
      title = T('这个页面无法嗅探');
      sub = T('浏览器内置页、扩展商店等页面不允许扩展读取。');
    } else if (all.length) {
      title = T(isV ? '没有符合「主要视频」标准的内容' : '没有符合「主要图片」标准的内容');
      sub = T(isV ? '页面上还有 {n} 个视频被过滤掉了。' : '页面上还有 {n} 个图片被过滤掉了。', { n: all.length });
      act = `<button data-act="all">${T('查看全部')}</button>`;
    } else {
      title = T(isV ? '还没发现视频' : '还没发现图片');
      sub = T(isV ? '打开或播放视频后会自动出现，无需刷新。' : '页面加载图片后会自动出现。');
    }
    empty.innerHTML = `<div class="art">${kind === 'video' ? ICON_VIDEO : ICON_IMAGE}</div><b>${title}</b><span>${sub}</span>${act}`;
    empty.classList.remove('hidden');
    const btn = $('[data-act="all"]', empty);
    if (btn) {
      btn.onclick = () => {
        if (kind === 'video') S.vidMode = 'all';
        else S.imgMode = 'all';
        saveSettings();
        render();
      };
    }
  } else empty.classList.add('hidden');

  updateFooter(items);
}

function updateFooter(items = visibleItems()) {
  const n = items.filter(isSel).length;
  const selBtn = $('#dlSel');
  const allBtn = $('#dlAll');
  selBtn.classList.toggle('hidden', n === 0);
  selBtn.textContent = T('下载选中 ({n})', { n });
  allBtn.textContent = n ? T('全部 ({n})', { n: items.length }) : T('全部下载 ({n})', { n: items.length });
  allBtn.disabled = items.length === 0;
  allBtn.classList.toggle('primary', n === 0);
  allBtn.classList.toggle('ghost', n > 0);
  $('#selAll').checked = items.length > 0 && n === items.length;
  $('#selAll').indeterminate = n > 0 && n < items.length;
  $('#selAll').disabled = items.length === 0;
}

function refreshCards() {
  for (const c of cards.values()) c.update(c.item);
  updateFooter();
}

function dlLabel(id, idle) {
  const d = dl.get(id);
  if (!d) return idle;
  if (d.state === 'queued') return T('排队中…');
  if (d.reconnecting) return T('正在重新连接…');
  if (d.state === 'progress') return T('合并 {n}%', { n: d.pct ?? 0 });
  // The buffering progress lives in the quality dropdown; the button only offers to cancel
  if (d.state === 'buffering') return T('取消');
  if (d.state === 'start') return T('下载中…');
  if (d.state === 'done') return T('已下载');
  if (d.state === 'error') return T('重试');
  return idle;
}

// ---- Video card ----
function makeVideoCard(first) {
  const el = h('div', 'card vid');
  el.innerHTML = `
    <div class="preview">
      <span class="chipov tl tag"></span><span class="chipov tr dur"></span>
      <input class="cb" type="checkbox" title="${T('选择')}" />
      <i class="done" title="${T('已下载')}"></i>
    </div>
    <div class="vbody">
      <div class="title"></div>
      <div class="meta"></div>
      <div class="vrow"><select title="${T('分辨率')}"></select><button class="btn dl"><span class="fill"></span><span class="lbl">${T('下载')}</span></button></div>
    </div>`;
  if (freshIds.has(first.id)) {
    el.classList.add('fresh');
    freshIds.delete(first.id);
  }
  const prev = $('.preview', el);
  const cb = $('.cb', el);
  const select = $('select', el);
  const btn = $('.dl', el);

  const card = { el, item: first, hls: null, video: null, qualitySignature: '', thumb: null };

  const poster = h('img');
  poster.referrerPolicy = 'no-referrer';
  poster.alt = '';
  prev.prepend(poster);

  const playBtn = h('button', 'play', '<i></i>');
  playBtn.title = T('预览');
  playBtn.setAttribute('aria-label', T('预览'));
  prev.insertBefore(playBtn, $('.tag', prev));

  const prog = h('div', 'prog', '<i></i>');
  prog.style.display = 'none';
  prev.append(prog);

  function stop() {
    if (card.hls) {
      card.hls.destroy();
      card.hls = null;
    }
    if (card.video) {
      card.video.pause();
      card.video.removeAttribute('src');
      card.video.load();
      card.video.remove();
      card.video = null;
    }
    poster.style.display = '';
    prog.style.display = 'none';
    playBtn.style.display = '';
    if (playing === card) playing = null;
  }
  card.stop = stop;
  card.destroy = stop;

  playBtn.addEventListener('click', () => {
    const it = card.item;
    const q = it.qualities?.[qIndex(it)] || it.qualities?.[0];
    if (!q) return;
    if (playing && playing !== card) playing.stop();
    playing = card;
    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    card.video = v;
    poster.after(v);
    poster.style.display = 'none';
    playBtn.style.display = 'none';
    prog.style.display = '';
    v.addEventListener('timeupdate', () => {
      $('i', prog).style.width = (v.duration ? (v.currentTime / v.duration) * 100 : 0) + '%';
    });
    v.addEventListener('click', () => (v.paused ? v.play() : v.pause()));
    const fail = () => {
      $('.meta', el).textContent = T('预览加载失败（仍可尝试下载）');
      stop();
    };
    v.addEventListener('error', fail);
    if (q.type === 'hls' && window.Hls?.isSupported()) {
      const hls = new window.Hls({ enableWorker: false });
      card.hls = hls;
      hls.loadSource(q.url);
      hls.attachMedia(v);
      hls.on(window.Hls.Events.ERROR, (_e, d) => {
        if (d.fatal) fail();
      });
    } else v.src = q.url;
    v.play().catch(() => {});
  });
  prog.addEventListener('click', (e) => {
    const v = card.video;
    if (!v || !v.duration) return;
    const r = prog.getBoundingClientRect();
    v.currentTime = ((e.clientX - r.left) / r.width) * v.duration;
  });

  cb.addEventListener('change', () => {
    touched.add(card.item.id);
    sel.set(card.item.id, cb.checked);
    updateFooter();
  });
  select.addEventListener('change', () => {
    pickedQuality.set(card.item.id, +select.value);
    S.prefHeight = card.item.qualities[+select.value]?.height || S.prefHeight;
    saveSettings();
    refreshCards();
  });
  btn.addEventListener('click', async () => {
    // While buffering for an auto download, the button cancels
    if (dl.get(card.item.id)?.state === 'buffering') {
      if (card.cancelling) return;
      const id = card.item.id;
      card.cancelling = true;
      refreshCards();
      try {
        const result = await chrome.runtime.sendMessage({ type: 'capture-ctl', tabId, cmd: 'fill-stop' });
        if (!result?.ok) throw new Error(result?.error || 'No cancellation acknowledgement');
        dl.delete(id);
        toast(T('已取消缓冲'));
      } catch (e) {
        console.warn('[VictorLoad] could not cancel buffering', e);
        toast(T('取消失败，请刷新视频页面后重试。'));
      } finally {
        card.cancelling = false;
        refreshCards();
      }
      return;
    }
    download([{ it: card.item, q: qIndex(card.item) }]);
  });

  card.update = (it) => {
    card.item = it;
    $('.title', el).textContent = it.title || T('（无标题）');
    $('.title', el).title = it.title || '';
    const mh = maxHeight(it);
    const q = it.qualities?.[qIndex(it)];
    const meta = [];
    if (q?.type === 'capture' && q.height)
      meta.push(`${q.height}p${q.codec ? ' ' + q.codec : ''}`); // format goes next to the resolution
    else if (it.w && it.h) meta.push(`${it.w}×${it.h}`);
    else if (mh) meta.push(mh + 'p');
    const size = q?.size || it.size;
    if (size) meta.push(fmtBytes(size));
    const m = $('.meta', el);
    const message = videoNotice(it, q);
    if (message.text) {
      m.textContent = message.text;
      m.classList.toggle('err', message.error);
    } else if (!card.video) {
      // A capture that hit the buffer limit (or dropped segments) must say so: the saved file is incomplete
      m.classList.remove('err');
      const info =
        it.capture && !it.qualities?.length ? T('播放视频几秒后，这里会出现可下载的清晰度') : meta.join(' · ') || ' ';
      m.textContent = info;
    }
    m.title = m.textContent; // full warnings remain accessible when the uniform card clamps them to two lines
    // Where the holes are, as a tooltip on the quality dropdown
    select.title =
      q?.type === 'capture' && q.gaps?.length
        ? T('缺失位置：') + q.gaps.map(([a, b]) => `${fmtDur(a) || '0:00'}–${fmtDur(b)}`).join(T('、'))
        : T('分辨率');
    const durEl = $('.dur', el);
    durEl.textContent = it.duration ? fmtDur(it.duration) : '';
    durEl.style.display = it.duration ? '' : 'none';
    const tag = it.qualities?.[0]?.type === 'hls' ? 'HLS' : '';
    const tagEl = $('.tag', el);
    tagEl.textContent = tag;
    tagEl.style.display = tag ? '' : 'none';

    if (it.thumb) {
      if (card.thumb !== it.thumb) {
        poster.src = it.thumb;
        card.thumb = it.thumb;
      }
      poster.style.visibility = '';
    } else poster.style.visibility = 'hidden';
    playBtn.style.display = card.video ? 'none' : it.posterOnly || it.error || !it.qualities?.length ? 'none' : '';

    // Only rebuild the options when the list of qualities changes. Updating the text in place
    // keeps an open dropdown from closing on every progress update.
    const quals = it.qualities || [];
    const qualitySignature = quals
      .map((x) => (x.type === 'capture' ? `cap:${x.vgid}:${x.agid}` : x.label + x.type + (x.size || '')))
      .join('|');
    if (qualitySignature !== card.qualitySignature) {
      card.qualitySignature = qualitySignature;
      select.innerHTML = '';
      quals.forEach((_x, i) => {
        const o = document.createElement('option');
        o.value = i;
        select.append(o);
      });
      if (!quals.length) {
        const o = document.createElement('option');
        o.textContent = T('无可用清晰度');
        select.append(o);
      }
    }
    quals.forEach((x, i) => {
      const o = select.options[i];
      if (!o) return;
      if (x.type === 'capture') {
        // Captured streams: just resolution and progress (add the codec only when two share a height)
        const sameHeight = quals.filter((y) => y.type === 'capture' && y.height === x.height).length > 1;
        const base = x.height ? `${x.height}p${sameHeight && x.codec ? ' ' + x.codec : ''}` : T(x.label);
        o.textContent = `${base} · ${Math.round((x.cov || 0) * 100)}%`;
      } else o.textContent = T(x.label) + (x.size ? ` · ${fmtBytes(x.size)}` : '');
    });
    select.value = qIndex(it);
    // Progress of a captured stream is drawn as the dropdown's background fill
    const selectedQuality = it.qualities?.[qIndex(it)];
    const isCaptureQuality = selectedQuality?.type === 'capture';
    select.classList.toggle('capsel', isCaptureQuality);
    select.style.setProperty('--p', isCaptureQuality ? Math.round((selectedQuality.cov || 0) * 100) + '%' : '0%');
    select.disabled = (it.qualities?.length || 0) <= 1;
    cb.checked = isSel(it);
    el.classList.toggle('is-done', isDone(it));
    const d = dl.get(it.id);
    // A captured stream that isn't fully buffered gets "Auto download": fill the gaps, then save
    const needsAutoDownload =
      selectedQuality?.type === 'capture' && (selectedQuality.cov < 0.98 || selectedQuality.holes > 0);
    setBtn(
      btn,
      dlLabel(it.id, needsAutoDownload ? T('自动下载') : isDone(it) ? T('再次下载') : T('下载')),
      d?.state === 'progress' ? d.pct : 0,
    );
    btn.title = needsAutoDownload && d?.state !== 'buffering' ? T('缓冲完整后自动下载') : '';
    btn.disabled =
      card.cancelling ||
      !!it.error ||
      !!selectedQuality?.error ||
      !it.qualities?.length ||
      ['start', 'queued', 'progress'].includes(d?.state);
  };
  return card;
}

// ---- Image card ----
function makeImageCard(first) {
  const el = h('div', 'card img');
  el.innerHTML = `
    <div class="preview">
      <span class="chipov tl dim"></span><span class="chipov tr st"></span>
      <input class="cb" type="checkbox" title="${T('选择')}" />
      <i class="done" title="${T('已下载')}"></i>
    </div>`;
  if (freshIds.has(first.id)) {
    el.classList.add('fresh');
    freshIds.delete(first.id);
  }
  const prev = $('.preview', el);
  const cb = $('.cb', el);
  const img = h('img');
  img.referrerPolicy = 'no-referrer';
  img.loading = 'lazy';
  img.alt = '';
  prev.prepend(img);
  const card = { el, item: first, thumb: null, destroy() {} };

  // A preview the panel cannot load (for example the site only serves the image to its own pages)
  img.addEventListener('error', () => {
    const it = card.item;
    prev.dataset.msg = T('无法预览，仍可下载');
    prev.classList.add('failed');
    // If the page measured the image it is fine and only our preview fails: keep it in "Main".
    // Otherwise it is broken and stays under "All" only.
    if (it.w || dims[it.id] || broken.has(it.id)) return;
    broken.add(it.id);
    render();
  });
  img.addEventListener('load', () => {
    const it = card.item;
    if (!it.w && img.naturalWidth && !dims[it.id]) {
      dims[it.id] = { w: img.naturalWidth, h: img.naturalHeight };
      render();
    }
  });
  el.addEventListener('click', (e) => {
    if (e.target === cb) return;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change'));
  });
  el.addEventListener('dblclick', () => window.open(card.item.url, '_blank'));
  cb.addEventListener('change', () => {
    touched.add(card.item.id);
    sel.set(card.item.id, cb.checked);
    el.classList.toggle('picked', cb.checked);
    updateFooter();
  });

  card.update = (it) => {
    card.item = it;
    if (card.thumb !== it.thumb) {
      img.src = it.thumb;
      card.thumb = it.thumb;
      prev.classList.remove('failed');
    }
    const w = it.w || dims[it.id]?.w;
    const hh = it.h || dims[it.id]?.h;
    const dim = w && hh ? `${w}×${hh}` : it.upgraded ? T('原图') : '';
    const dimEl = $('.dim', el);
    dimEl.textContent = [dim, it.size ? fmtBytes(it.size) : ''].filter(Boolean).join(' · ');
    dimEl.style.display = dimEl.textContent ? '' : 'none';
    const d = dl.get(it.id);
    const stEl = $('.st', el);
    stEl.textContent =
      d?.state === 'error' ? T('失败') : d?.state === 'start' || d?.state === 'queued' ? T('下载中') : '';
    stEl.style.display = stEl.textContent ? '' : 'none';
    el.title = T('单击选择，双击打开原图') + '\n' + it.url;
    cb.checked = isSel(it);
    el.classList.toggle('picked', cb.checked);
    el.classList.toggle('is-done', isDone(it));
  };
  return card;
}

// ---- Downloads ----
async function download(entries) {
  if (!entries.length || tabId == null) return;
  if (entries.length > 50 && !confirm(T('将下载 {n} 个文件，继续吗？', { n: entries.length }))) return;
  // Incomplete captures are buffered first (the page does it); everything else is queued
  const isAuto = (e) => {
    const q = e.it.qualities?.[e.q];
    return q?.type === 'capture' && !e.force && (q.cov < 0.98 || q.holes > 0);
  };
  for (const e of entries) {
    const q = e.it.qualities?.[e.q];
    dl.set(e.it.id, isAuto(e) ? { state: 'buffering', pct: Math.round((q.cov || 0) * 100) } : { state: 'queued' });
  }
  refreshCards();
  toast(entries.some(isAuto) ? T('开始缓冲，完成后自动下载') : T('已加入下载队列：{n} 项', { n: entries.length }));
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'download',
      tabId,
      // Include sizes measured from the preview image so {resolution} works for lazily loaded images
      entries: entries.map((e) => ({
        item: { ...e.it, w: e.it.w || dims[e.it.id]?.w || 0, h: e.it.h || dims[e.it.id]?.h || 0 },
        q: e.q,
        force: !!e.force,
      })),
    });
    if (res && res.error) throw new Error(res.error);
  } catch (e) {
    // The background never got the request: free the buttons that now say "queued" and tell the user
    console.warn('[VictorLoad] download request failed', e);
    for (const x of entries) dl.set(x.it.id, { state: 'error', msg: String((e && e.message) || e) });
    refreshCards();
    toast(T('下载失败：') + String((e && e.message) || e));
  }
}

function learn(kind, selected, shown) {
  if (!S.autoRemember || !state.host) return;
  const r = (remembered[state.host] ||= { image: [], video: [] });
  const set = new Set(r[kind] || []);
  const rem0 = remSets()[kind];
  const selSigs = new Set(selected.filter((i) => i.siteMain == null && i.sig && i.sig !== 'net').map((i) => i.sig));
  for (const s of selSigs) set.add(s);
  for (const it of shown) {
    if (!isSel(it) && it.sig && rem0.has(it.sig) && !selSigs.has(it.sig)) set.delete(it.sig);
  }
  r[kind] = [...set];
  if (!r.image.length && !r.video.length) delete remembered[state.host];
  saveRemembered();
}

$('#dlSel').addEventListener('click', () => {
  const shown = visibleItems();
  const picked = shown.filter(isSel);
  learn(S.tab, picked, shown);
  download(picked.map((it) => ({ it, q: qIndex(it) })));
});
$('#dlAll').addEventListener('click', () => {
  download(visibleItems().map((it) => ({ it, q: qIndex(it) })));
});
$('#selAll').addEventListener('change', (e) => {
  for (const it of visibleItems()) {
    touched.add(it.id);
    sel.set(it.id, e.target.checked);
  }
  refreshCards();
});

// ---- Tabs and modes ----
$$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$$('.chip').forEach((b) =>
  b.addEventListener('click', () => {
    if (S.tab === 'video') S.vidMode = b.dataset.mode;
    else S.imgMode = b.dataset.mode;
    saveSettings();
    render();
  }),
);

// ---- History and settings views ----
function show(view) {
  for (const v of ['Main', 'History', 'Settings']) $('#view' + v).classList.toggle('hidden', v !== view);
  if (view === 'History') renderHistory();
  if (view === 'Settings') renderSettings();
}
$('#btnRefresh').addEventListener('click', async () => {
  const btn = $('#btnRefresh');
  if (tabId == null || !supported || btn.classList.contains('spin')) return;
  btn.classList.add('spin');
  const started = Date.now();
  try {
    const s = await chrome.runtime.sendMessage({ type: 'refresh', tabId });
    if (s && !s.error) applyState(s);
    else if (s && s.error) throw new Error(s.error);
  } catch (e) {
    console.warn('[VictorLoad] refresh failed', e);
    toast(T('刷新失败：') + String((e && e.message) || e));
  }
  // Keep the spinner up long enough to be noticed
  setTimeout(() => btn.classList.remove('spin'), Math.max(0, 700 - (Date.now() - started)));
});
$('#btnHistory').addEventListener('click', () => show('History'));
$('#btnSettings').addEventListener('click', () => show('Settings'));
$$('[data-back]').forEach((b) => b.addEventListener('click', () => show('Main')));

function renderHistory() {
  $('#optBadge').checked = !!S.showBadge;
  const q = $('#histSearch').value.trim().toLowerCase();
  const box = $('#histList');
  box.innerHTML = '';
  const rows = history
    .filter((r) => !q || `${r.title || ''} ${r.name || ''} ${r.host || ''} ${r.q || ''}`.toLowerCase().includes(q))
    .slice(0, 300);
  if (!rows.length) {
    box.append(
      h('div', 'muted', history.length ? T('没有匹配的记录') : T('还没有下载记录。下载过的图片和视频会出现在这里。')),
    );
    return;
  }
  for (const r of rows) {
    const row = h('div', 'h-item');
    const th = h('div', 'th');
    const thumb = historyThumb(r);
    if (thumb) th.style.backgroundImage = `url("${thumb.replace(/"/g, '%22')}")`;
    const main = h('div', 'h-main');
    const t = h('div', 't');
    t.textContent = r.name || r.title || r.url;
    t.title = r.name || r.title || '';
    const s = h('div', 's');
    s.textContent = [r.kind === 'video' ? T('视频') : T('图片'), r.q, r.host, new Date(r.time).toLocaleString()]
      .filter(Boolean)
      .join(' · ');
    main.append(t, s);
    const act = h('div', 'h-act');
    const open = h('button', '', T('打开页面'));
    open.onclick = () => r.pageUrl && chrome.tabs.create({ url: r.pageUrl });
    const del = h('button', 'del', T('删除'));
    del.onclick = async () => {
      const { history: cur = [] } = await chrome.storage.local.get('history');
      await chrome.storage.local.set({ history: cur.filter((x) => x.id !== r.id) });
    };
    act.append(open, del);
    row.append(th, main, act);
    box.append(row);
  }
}
$('#histSearch').addEventListener('input', renderHistory);
$('#histClear').addEventListener('click', async () => {
  if (history.length && confirm(T('清空全部下载记录？页面上的对勾标记也会消失。'))) {
    await storeLocal({ history: [] }, 'history');
    dismissHistoryNotice();
  }
});
function dismissHistoryNotice() {
  showHistoryNotice(null);
  chrome.storage.session
    .remove('historyNotice')
    .catch((e) => console.warn('[VictorLoad] could not clear the notice', e));
}
$('#histNoticeOk').addEventListener('click', dismissHistoryNotice);
$('#optBadge').addEventListener('change', (e) => {
  S.showBadge = e.target.checked;
  saveSettings();
});

function renderSettings() {
  $$('[data-s]').forEach((i) => {
    const k = i.dataset.s;
    if (i.type === 'checkbox') i.checked = !!S[k];
    else if (i.type === 'radio') i.checked = S[k] === i.value;
    else i.value = S[k];
  });
  for (const sync of dropdowns) sync();
  renderNamePreview();
  const box = $('#remList');
  box.innerHTML = '';
  let n = 0;
  for (const [host, r] of Object.entries(remembered)) {
    for (const kind of ['image', 'video']) {
      for (const sig of r[kind] || []) {
        n++;
        const row = h('div', 'r');
        const code = h('code');
        code.textContent = `${host} · ${kind === 'image' ? T('图片') : T('视频')} · ${sig}`;
        code.title = code.textContent;
        const del = h('button', '', T('删除'));
        del.onclick = () => {
          r[kind] = r[kind].filter((x) => x !== sig);
          if (!r.image.length && !r.video.length) delete remembered[host];
          saveRemembered();
          renderSettings();
          render();
        };
        row.append(code, del);
        box.append(row);
      }
    }
  }
  if (!n) box.append(h('div', 'muted', T('暂无。勾选图片或视频并点「下载选中」，下次会自动勾选这个网站的同类内容。')));
}
$$('[data-s]').forEach((i) =>
  i.addEventListener('change', () => {
    const k = i.dataset.s;
    if (i.type === 'radio') {
      if (!i.checked) return;
      S[k] = i.value;
    } else if (i.type === 'text' || i.tagName === 'SELECT') S[k] = i.value;
    else S[k] = i.type === 'checkbox' ? i.checked : Math.max(0, +i.value || 0);
    if (k === 'uiMode') {
      switchUiMode();
      return;
    }
    saveSettings();
    if (k === 'uiLang') applyLanguage();
    else render();
  }),
);

/** Apply a display mode change right away: save, let the background rewire the toolbar button, then open the other UI */
async function switchUiMode() {
  clearTimeout(saveTimer);
  await storeLocal({ settings: S }, 'settings');
  try {
    await chrome.runtime.sendMessage({ type: 'sync-ui-mode' });
    const { id: windowId } = await chrome.windows.getCurrent();
    if (S.uiMode === 'popup' && !IS_POPUP) {
      await chrome.action.openPopup({ windowId });
      window.close();
    } else if (S.uiMode !== 'popup' && IS_POPUP) {
      await chrome.sidePanel.open({ windowId });
      window.close();
    }
  } catch (e) {
    // Older browsers cannot open the other UI from script; the toolbar button already uses the new mode
    console.warn('[VictorLoad] could not open the new display mode', e);
    toast(T('已切换，点击工具栏图标即可使用。'));
  }
}
/* Language */

function applyLanguage() {
  setLang(S.uiLang);
  applyDom();
  for (const sync of dropdowns) sync();
  // Cards carry translated tooltips created at build time: rebuild them
  for (const c of cards.values()) {
    c.destroy();
    c.el.remove();
  }
  cards.clear();
  renderNamePreview();
  showHistoryNotice(historyNotice);
  if (!$('#viewHistory').classList.contains('hidden')) renderHistory();
  if (!$('#viewSettings').classList.contains('hidden')) renderSettings();
  render();
}

/* Drop-down list styled like the rest of the UI. The native <select> stays (hidden) as the source of truth. */
const dropdowns = [];
function enhanceSelect(native) {
  const wrap = h('div', 'dd');
  const btn = h('button', 'dd-btn');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-label', native.getAttribute('aria-label') || '');
  const label = h('span', 'dd-label');
  btn.append(label, h('span', 'dd-chev'));
  const list = h('div', 'dd-list hidden');
  list.setAttribute('role', 'listbox');
  native.before(wrap);
  wrap.append(btn, list, native);
  native.classList.add('dd-native');
  native.tabIndex = -1;
  let active = -1;

  const setActive = (i) => {
    const els = [...list.children];
    active = Math.max(0, Math.min(els.length - 1, i));
    els.forEach((e, n) => e.classList.toggle('active', n === active));
    els[active]?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => {
    list.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    sync();
    list.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    setActive([...native.options].findIndex((o) => o.value === native.value));
  };
  const choose = (value) => {
    close();
    btn.focus();
    if (native.value === value) return;
    native.value = value;
    native.dispatchEvent(new Event('change'));
    sync();
  };
  // Rebuild labels and options from the native select (applyDom translates its option texts in place)
  function sync() {
    label.textContent = native.selectedOptions[0]?.textContent.trim() || '';
    list.replaceChildren(
      ...[...native.options].map((o) => {
        const it = h('div', 'dd-item' + (o.value === native.value ? ' on' : ''));
        it.setAttribute('role', 'option');
        it.setAttribute('aria-selected', String(o.value === native.value));
        it.textContent = o.textContent.trim();
        it.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the button
        it.addEventListener('click', () => choose(o.value));
        return it;
      }),
    );
  }

  btn.addEventListener('click', () => (list.classList.contains('hidden') ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    const isOpen = !list.classList.contains('hidden');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) open();
      else setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (isOpen && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      choose(native.options[active]?.value ?? native.value);
    } else if (isOpen && (e.key === 'Escape' || e.key === 'Tab')) {
      if (e.key === 'Escape') e.preventDefault();
      close();
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (!wrap.contains(e.target)) close();
  });
  window.addEventListener('blur', close);
  dropdowns.push(sync);
  sync();
}
$$('select[data-dd]').forEach(enhanceSelect);

/* File name template: presets, placeholder chips and a live example */

const nameInput = $('#nameFormat');
const sample = () => ({ tab: T('你好世界'), name: 'clip_001', duration: '2m05s', resolution: '1080p' });

function renderNamePreview() {
  const stem = formatName(nameInput.value, sample()) || sample().tab;
  $('#namePreview').textContent = `${stem}.mp4`;
}

function setNameFormat(v) {
  nameInput.value = v;
  S.nameFormat = v;
  saveSettings();
  renderNamePreview();
}

nameInput.addEventListener('input', () => {
  S.nameFormat = nameInput.value;
  saveSettings();
  renderNamePreview();
});
$$('[data-preset]').forEach((b) => b.addEventListener('click', () => setNameFormat(b.dataset.preset)));
$$('[data-token]').forEach((b) =>
  b.addEventListener('click', () => {
    const t = b.dataset.token;
    const s = nameInput.selectionStart ?? nameInput.value.length;
    const e = nameInput.selectionEnd ?? s;
    setNameFormat(nameInput.value.slice(0, s) + t + nameInput.value.slice(e));
    nameInput.focus();
    nameInput.setSelectionRange(s + t.length, s + t.length);
  }),
);

$('#resetSettings').addEventListener('click', () => {
  for (const k of ['imgMinW', 'imgMinH', 'imgMinKB', 'vidMinW', 'vidMinH', 'vidMinDur', 'vidMinMB']) S[k] = DEFAULTS[k];
  saveSettings();
  renderSettings();
  render();
});

// ---- Active tab and messages ----
const isHttp = (u) => /^https?:/i.test(u || '');

async function setActive(tab) {
  if (!tab) return;
  supported = isHttp(tab.url);
  faviconUrl = supported ? tab.favIconUrl || '' : '';
  render();
  if (tab.id !== tabId) {
    if (playing) playing.stop();
    tabId = tab.id;
    state = { images: [], videos: [], host: hostOf(tab.url), pageUrl: tab.url, loading: false, siteError: '' };
    for (const c of cards.values()) {
      c.destroy();
      c.el.remove();
    }
    cards.clear();
    render();
  }
  if (supported) loadState();
  else render();
}

async function loadState() {
  const requestedTabId = tabId;
  try {
    const s = await chrome.runtime.sendMessage({ type: 'getState', tabId: requestedTabId });
    if (tabId !== requestedTabId) return;
    if (s && !s.error) applyState(s);
    else if (s && s.error) console.warn('[VictorLoad] could not read the page state', s.error);
  } catch (e) {
    // Usually the service worker is restarting; the next state push or tab event reloads the list
    console.warn('[VictorLoad] could not read the page state', e);
  }
}

async function pickActive() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  setActive(tab);
}

chrome.tabs.onActivated.addListener(pickActive);
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (id !== tabId) return;
  if (info.favIconUrl !== undefined || info.url || info.status === 'loading') {
    faviconUrl = isHttp(tab.url) ? (info.favIconUrl ?? tab.favIconUrl ?? '') : '';
    render();
  }
  if (info.status === 'loading' || info.url) {
    supported = isHttp(tab.url);
    state.host = hostOf(tab.url);
  }
  if (info.status === 'complete') loadState();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'state' && msg.tabId === tabId) {
    applyState(msg.state);
  } else if (msg.type === 'history-notice') {
    showHistoryNotice(msg.notice, true);
  } else if (msg.type === 'dl') {
    dl.set(msg.id, msg);
    if (msg.state === 'error') toast(T('下载失败：') + T(msg.msg || '未知错误'));
    if (msg.state === 'cancelled') dl.delete(msg.id);
    if (msg.state === 'stuck') {
      // Some parts could not be buffered even after retrying: let the user decide
      dl.delete(msg.id);
      const it = state.videos.find((v) => v.id === msg.id);
      const where = msg.gaps?.length
        ? '\n' + T('缺失位置：') + msg.gaps.map(([a, b]) => `${fmtDur(a) || '0:00'}–${fmtDur(b)}`).join(T('、'))
        : '';
      refreshCards();
      if (
        it &&
        confirm(
          `${T('有 {holes} 处没能缓冲上。', { holes: msg.holes })}${where}\n${T('保存的文件会缺少这些部分，之后的画面和声音可能不同步。')}\n${T('仍要下载吗？')}`,
        )
      ) {
        download([{ it, q: qIndex(it), force: true }]);
      }
    }
    // Once the browser has the download, give the button back after a second so it can be clicked again.
    // HLS merging and buffered saves keep their state until they finish or fail.
    if (msg.state === 'start' || msg.state === 'done') {
      setTimeout(() => {
        if (dl.get(msg.id) === msg) {
          dl.delete(msg.id);
          refreshCards();
        }
      }, 1000);
    }
    refreshCards();
  }
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.history) {
    setHistory(ch.history.newValue);
    if (!$('#viewHistory').classList.contains('hidden')) renderHistory();
    refreshCards();
  }
  if (ch.remembered) {
    remembered = ch.remembered.newValue || {};
    render();
  }
});

// ---- Startup ----
(async function init() {
  const st = await chrome.storage.local.get(['settings', 'remembered', 'history']);
  S = { ...DEFAULTS, ...(st.settings || {}) };
  remembered = st.remembered || {};
  setHistory(st.history);
  setLang(S.uiLang);
  applyDom();
  try {
    // A problem reported while the panel was closed
    const { historyNotice: pendingNotice } = await chrome.storage.session.get('historyNotice');
    if (pendingNotice) showHistoryNotice(pendingNotice, true);
  } catch (e) {
    console.warn('[VictorLoad] could not read the history notice', e);
  }
  await pickActive();
})();

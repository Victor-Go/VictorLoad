// Minimal i18n. The language defaults to "auto" (browser language, English fallback). Chinese UI text is the source key, English is looked up in EN.
// Static HTML is translated by walking the DOM (applyDom); dynamic text goes through T().

import { FR, FR_RE } from './i18n-fr.js';
import { ZH_TW, ZH_TW_RE } from './i18n-zh-tw.js';

export const EN = {
  '请先播放视频，几秒后会出现可下载的画质。': 'Play the video first. Quality options will appear after a few seconds.',
  '暂时无法访问视频，请确认已登录且视频可以正常播放。':
    'This video is temporarily unavailable. Check that you are signed in and can play it.',
  '暂时无法连接视频站点，请检查网络后重试。':
    'Cannot connect to the video site right now. Check your connection and try again.',
  '暂时无法读取视频信息，请稍后重试或刷新页面。':
    'Cannot read the video information right now. Try again shortly or refresh the page.',
  '取消失败，请刷新视频页面后重试。': 'Could not cancel buffering. Refresh the video page and try again.',
  '已取消缓冲': 'Buffering cancelled',
  '正在重新连接…': 'Reconnecting…',
  '下载任务失去连接，请重试。': 'Lost connection to the download. Try again.',
  '此视频使用独立音轨，暂不支持下载。': 'This video has a separate audio track. Downloading it is not supported yet.',
  // ---- static HTML ----
  '正在嗅探…': 'Scanning…',
  '重新嗅探当前页面': 'Scan this page again',
  '重新嗅探': 'Scan again',
  '下载记录': 'Download history',
  '过滤与设置': 'Filters & settings',
  '设置': 'Settings',
  '视频': 'Video',
  '图片': 'Images',
  '主要': 'Main',
  '全部': 'All',
  '全选': 'Select all',
  '返回': 'Back',
  '清空': 'Clear',
  '搜索标题、站点或清晰度': 'Search title, site or quality',
  '页面上显示绿色对勾': 'Mark downloaded items on the page',
  '已下载的图片和视频右下角会出现绿色小对勾':
    'Downloaded images and videos get a small green check in the bottom-right corner',
  '页面上显示蓝色下载箭头': 'Show a download arrow on the page',
  '没下载过的图片和视频右下角会出现蓝色向下箭头，点击即以最高画质下载':
    'Images and videos not downloaded yet get a blue arrow in the bottom-right corner; one click saves the best quality',
  '恢复默认': 'Reset',
  '语言 / Language': 'Language / 语言',
  '全部下载 (0)': 'Download all (0)', // initial text, replaced as soon as the list renders
  '下载选中 (0)': 'Download selected (0)',
  '自动': 'Auto',
  '简体中文': '简体中文', // language names stay in their own language
  '繁體中文': '繁體中文',
  '显示方式': 'Open as',
  '侧边栏': 'Side panel',
  '浮窗': 'Popup',
  '侧边栏会一直停靠并实时更新；浮窗点击图标弹出，点到别处会自动关闭。切换后立即生效。':
    'The side panel stays open as you browse. The popup opens below the toolbar icon and closes when you click elsewhere. Changes apply immediately.',
  '已切换，点击工具栏图标即可使用。': 'Display mode changed. Click the toolbar icon to use it.',
  '下面的标准决定「主要」列表里显示什么，其余内容仍可在「全部」中找到。':
    'Choose what appears under "Main". Other items are still available under "All".',
  '主要图片': 'Main images',
  '主要视频': 'Main videos',
  '最小宽度': 'Min width',
  '最小高度': 'Min height',
  '最小体积': 'Min size',
  '最短时长': 'Min duration',
  '秒': 's',
  '文件名格式': 'File name format',
  '视频标题': 'Video title',
  '标签页名': 'Tab title',
  '文件本身的名字': 'Original file name',
  '视频标题 + 分辨率': 'Video title + resolution',
  '排除（刷新页面后恢复）': 'Exclude (comes back when the page is reloaded)',
  '排除失败：': 'Could not exclude: ',
  '插入：': 'Insert:',
  '{title} 视频标题（预览卡片上显示的标题，没有则用标签页名） · {tab} 标签页名 · {name} 视频/图片本身的名字 · {duration} 时长（如 5m32s） · {resolution} 分辨率（视频如 1080p，图片如 1920x1080）。同名文件会自动加序号。':
    "{title} video title (as shown on the preview card, else the tab title) · {tab} tab title · {name} the media's own name · {duration} duration (e.g. 5m32s) · {resolution} resolution (e.g. 1080p for video, 1920x1080 for images). Files with the same name get a number added automatically.",
  '示例': 'Example',
  '下载': 'Download',
  '记住我选的内容': 'Remember my selections',
  '点「下载选中」后，下次会在这个网站的「主要」列表中显示并勾选同类内容':
    'After you click "Download selected", similar content on this site will appear under "Main" and be selected next time',
  '保存位置（浏览器下载文件夹之内）': 'Save location (inside the browser\'s Downloads folder)',
  '下载文件夹': 'Downloads folder',
  'VictorLoad/站点名': 'VictorLoad/site-name',
  '{site} 站点名 · {date} 日期（如 2026-11-08） · {year} 年 · {month} 月。用 / 分隔子文件夹；留空则直接保存到下载文件夹。':
    '{site} site name · {date} date (e.g. 2026-11-08) · {year} year · {month} month. Use / to separate subfolders; leave empty to save straight into the Downloads folder.',
  'YouTube 优先 H.264': 'Prefer H.264 on YouTube',
  '可把缓冲的音视频合并成单个 mp4，最高 1080p。修改后刷新 YouTube 页面生效':
    'Save buffered audio and video as one MP4, up to 1080p. Reload the YouTube page after changing this setting.',
  '默认分辨率不超过': 'Preferred maximum resolution',
  '已记住的内容类型': 'Remembered content patterns',

  // ---- side panel (dynamic) ----
  '发现 {n} 个新视频': 'New videos: {n}',
  '发现 {n} 张新图片': 'New images: {n}',
  '查看': 'View',
  '正在解析站点视频…': 'Loading video details…',
  '站点解析失败：': 'Could not load video details: ',
  '还没收到页面数据。若刚安装或更新过扩展，请刷新此页面（YouTube 缓冲下载必须刷新）。':
    'No page data yet. If you just installed or updated VictorLoad, reload this page. YouTube capture requires a page reload.',
  '无法嗅探此页': 'Cannot scan this page',
  '{v} 个视频 · {i} 张图片': 'Videos: {v} · Images: {i}',
  '浏览器内置页面不支持': 'Cannot scan browser pages',
  '这个页面无法嗅探': 'Cannot scan this page',
  '浏览器内置页、扩展商店等页面不允许扩展读取。':
    'The browser does not allow extensions to read pages such as browser settings or the extension store.',
  '没有符合「主要视频」标准的内容': 'No videos match the "Main" criteria',
  '没有符合「主要图片」标准的内容': 'No images match the "Main" criteria',
  '页面上还有 {n} 个视频被过滤掉了。': 'Videos hidden by your filters: {n}.',
  '页面上还有 {n} 个图片被过滤掉了。': 'Images hidden by your filters: {n}.',
  '查看全部': 'Show all',
  '还没发现视频': 'No videos found yet',
  '还没发现图片': 'No images found yet',
  '打开或播放视频后会自动出现，无需刷新。':
    'They appear automatically once a video is opened or played, no refresh needed.',
  '页面加载图片后会自动出现。': 'They appear automatically as the page loads images.',
  '下载选中 ({n})': 'Download selected ({n})',
  '全部 ({n})': 'All ({n})',
  '全部下载 ({n})': 'Download all ({n})',
  '排队中…': 'Queued…',
  '合并 {n}%': 'Merging {n}%',
  '取消': 'Cancel',
  '下载中…': 'Downloading…',
  '已下载': 'Downloaded',
  '重试': 'Retry',
  '你好世界': 'Hello World',
  '选择': 'Select',
  '分辨率': 'Resolution',
  '预览': 'Preview',
  '无法预览，仍可下载': 'No preview available, but you can still download it',
  '预览加载失败（仍可尝试下载）': 'Preview failed to load (you can still try downloading)',
  '（无标题）': '(untitled)',
  '播放视频几秒后，这里会出现可下载的清晰度':
    'Play the video for a few seconds and the available qualities will appear here',
  '缺失位置：': 'Missing: ',
  '、': ', ',
  '无可用清晰度': 'No quality options available',
  '自动下载': 'Auto download',
  '再次下载': 'Download again',
  '缓冲完整后自动下载': 'Buffers the missing parts, then downloads',
  '原图': 'Original',
  '失败': 'Failed',
  '下载中': 'Downloading',
  '单击选择，双击打开原图': 'Click to select, double-click to open the original',
  '将下载 {n} 个文件，继续吗？': 'About to download {n} files. Continue?',
  '开始缓冲，完成后自动下载': 'Buffering… The download will start when ready.',
  '已加入下载队列：{n} 项': 'Added to the download queue: {n}',
  '没有匹配的记录': 'No matching records',
  '还没有下载记录。下载过的图片和视频会出现在这里。': 'No downloads yet. Downloaded images and videos show up here.',
  '打开页面': 'Open page',
  '删除': 'Delete',
  '清空全部下载记录？页面上的对勾标记也会消失。':
    'Clear all download history? The green checks on pages will disappear too.',
  '暂无。勾选图片或视频并点「下载选中」，下次会自动勾选这个网站的同类内容。':
    'None yet. Select images or videos and click "Download selected" to remember similar content on this site.',
  '下载失败：': 'Download failed: ',
  '未知错误': 'Unknown error',
  '有 {holes} 处没能缓冲上。': 'Some parts could not be buffered (missing: {holes}).',
  '保存的文件会缺少这些部分，之后的画面和声音可能不同步。':
    'The saved file will be missing these parts, and picture and sound may drift out of sync afterwards.',
  '仍要下载吗？': 'Download anyway?',

  // ---- messages produced by the background / page scripts ----
  '页面脚本没有响应，请刷新页面后重试': 'The page script did not respond. Refresh the page and try again.',
  '没有可下载的地址': 'Nothing to download',
  '保存失败': 'Save failed',
  '下载中断': 'Download interrupted',
  '该 HLS 使用了不支持的加密方式': 'This stream uses an encryption method that is not supported',
  '未获取到可下载的清晰度（可能需要登录或为番剧/付费内容）':
    'No download options found. You may need to sign in, or downloads may be restricted for this video.',
  '接口未返回直链。请播放视频几秒，将自动改用「缓冲下载」':
    'No direct download is available. Play the video for a few seconds to download from its buffer.',
  '已有缓冲任务在进行': 'A buffering task is already running',
  '请先播放视频几秒，再点下载': 'Play the video for a few seconds first, then click download',
  '没有可用的样本数据': 'No captured video data is ready to save',
  '文件超过 4GB，无法生成标准 MP4': 'This file is over 4 GB and cannot be saved as an MP4 by VictorLoad',
  '没有已缓冲的数据，请先播放视频': 'Nothing buffered yet, play the video first',
  '空的主清单': 'No video streams found in this playlist',
  '没有分片': 'No video segments found',
  'HLS 直播/清单': 'HLS live / playlist',
  '杜比视界': 'Dolby Vision',
  '仅音频': 'Audio only',
  // ---- failures the user has to see ----
  '已达到缓冲上限（1.5 GB），之后的内容没有被记录，保存的文件会不完整。':
    'The 1.5 GB buffer limit was reached. Later data was not recorded, so the saved file will be incomplete.',
  '有 {n} 个分片无法解析，保存的文件可能缺少这些部分。':
    'Unreadable video segments: {n}. The saved file may be incomplete.',
  '记录分片时出错 {n} 次，保存的文件可能不完整。': 'Errors while recording: {n}. The saved file may be incomplete.',
  '存储空间不足，已删除最早的 {n} 条下载记录。':
    'Storage is full. Download history entries removed: {n} (oldest first).',
  '下载记录保存失败：{error}。页面上的绿色对勾可能不会更新。':
    'The download history could not be saved: {error}. Green checks on pages may not update.',
  '保存失败：': 'Could not save: ',
  '刷新失败：': 'Refresh failed: ',
  '知道了': 'Got it',
};

// Messages with a variable part
export const EN_RE = [
  [/^不支持的加密方式：(.*)$/, 'Unsupported encryption: $1'],
  [/^(\d+p) · 视频\+音频分开$/, '$1 · video + audio as separate files'],
];

// Language -> [translation table, pattern table]. Simplified Chinese ('zh') is the source text itself.
export const TABLES = { en: [EN, EN_RE], fr: [FR, FR_RE], 'zh-TW': [ZH_TW, ZH_TW_RE] };
const HTML_LANG = { zh: 'zh-CN', 'zh-TW': 'zh-TW', en: 'en', fr: 'fr' };

let lang = 'zh';

export function detectLang() {
  const ui = String(
    (globalThis.chrome && chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) ||
      navigator.language ||
      'en',
  ).toLowerCase();
  if (ui.startsWith('zh')) {
    // Traditional script: Taiwan, Hong Kong, Macau or an explicit Hant tag. Simplified: Mainland China, Singapore, Malaysia, Hans.
    if (/hans/.test(ui)) return 'zh';
    if (/hant|[-_](tw|hk|mo)/.test(ui)) return 'zh-TW';
    return 'zh';
  }
  if (ui.startsWith('fr')) return 'fr';
  return 'en'; // every other browser language falls back to English
}

/** pref: 'auto' | 'zh' | 'zh-TW' | 'en' | 'fr'; anything else behaves like 'auto' */
export function setLang(pref) {
  lang = HTML_LANG[pref] ? pref : detectLang();
  document.documentElement.lang = HTML_LANG[lang];
  return lang;
}
export const getLang = () => lang;

function lookup(zh) {
  const t = TABLES[lang];
  if (!t) return zh;
  if (t[0][zh] !== undefined) return t[0][zh];
  for (const [re, rep] of t[1]) if (re.test(zh)) return zh.replace(re, rep);
  return zh;
}

/** Translate a Chinese source string; {name} placeholders are filled from params */
export function T(zh, params) {
  let s = lookup(zh);
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
  return s;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const ATTRS = ['title', 'placeholder', 'aria-label'];

/** Translate static DOM text and attributes; remembers the Chinese source so the language can be switched back and forth */
export function applyDom(root = document.body) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    if (n.parentElement && /^(SCRIPT|STYLE)$/.test(n.parentElement.tagName)) continue;
    if (n.__zh === undefined) {
      const k = norm(n.nodeValue);
      if (!k || !/[一-龥]/.test(k)) continue;
      n.__zh = k;
      n.__ws = [n.nodeValue.match(/^\s*/)[0], n.nodeValue.match(/\s*$/)[0]];
    }
    n.nodeValue = n.__ws[0] + lookup(n.__zh) + n.__ws[1];
  }
  for (const el of root.querySelectorAll('*')) {
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      el.__zhAttr = el.__zhAttr || {};
      if (el.__zhAttr[a] === undefined) {
        const v = el.getAttribute(a);
        if (!/[一-龥]/.test(v)) continue;
        el.__zhAttr[a] = v;
      }
      el.setAttribute(a, lookup(el.__zhAttr[a]));
    }
  }
}

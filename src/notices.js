// User-facing notices, separated from DOM rendering for testing.
import { T, EN } from './i18n.js';

/** Convert site/network diagnostics into an actionable message without exposing response bodies. */
export function siteErrorText(error) {
  const detail = String(error || '');
  if (/HTTP\s*(401|403)\b|LOGIN_REQUIRED|sign.?in/i.test(detail)) {
    return T('暂时无法访问视频，请确认已登录且视频可以正常播放。');
  }
  if (/fetch|network|offline|timeout|timed out|abort|ERR_/i.test(detail)) {
    return T('暂时无法连接视频站点，请检查网络后重试。');
  }
  return T('暂时无法读取视频信息，请稍后重试或刷新页面。');
}

/** Expected YouTube capture warm-up is informational, rather than a parsing error. */
export function videoNotice(item, quality) {
  if (quality?.error) return { text: T(quality.error), error: true };
  if (item.capture) return { text: captureWarning(item.capture), error: true };
  if (!item.qualities?.length && item.waitingForCapture) {
    return { text: T('请先播放视频，几秒后会出现可下载的画质。'), error: false };
  }
  if (item.error) {
    const text = Object.hasOwn(EN, item.error) ? T(item.error) : siteErrorText(item.error);
    return { text, error: true };
  }
  return { text: '', error: false };
}

/**
 * Warning for a YouTube buffer capture, or '' when nothing is wrong.
 * `cap` is the `capture` object of a video item (see collectCapture in content.js):
 *   full           the recording stopped at the memory limit
 *   rejected       segments that could not be parsed and were left out
 *   captureErrors  segments that threw while being recorded
 */
export function captureWarning(cap) {
  if (!cap) return '';
  const out = [];
  if (cap.full) out.push(T('已达到缓冲上限（1.5 GB），之后的内容没有被记录，保存的文件会不完整。'));
  if (cap.rejected > 0) out.push(T('有 {n} 个分片无法解析，保存的文件可能缺少这些部分。', { n: cap.rejected }));
  if (cap.captureErrors > 0) out.push(T('记录分片时出错 {n} 次，保存的文件可能不完整。', { n: cap.captureErrors }));
  return out.join(' ');
}

/**
 * Text for the history problem the background reported (see setHistoryNotice in background.js):
 *   { kind: 'trimmed', dropped }  the storage quota was reached and the oldest records were deleted
 *   { kind: 'failed', error }     the history could not be written at all
 */
export function historyNoticeText(n) {
  if (!n) return '';
  if (n.kind === 'trimmed') return T('存储空间不足，已删除最早的 {n} 条下载记录。', { n: n.dropped });
  return T('下载记录保存失败：{error}。页面上的绿色对勾可能不会更新。', { error: n.error || T('未知错误') });
}

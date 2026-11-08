// Optional: make YouTube use only H.264 + AAC (MAIN world, document_start).
// This lets the captured mp4 video and audio be muxed into a single mp4 (cost: 1080p max).
(() => {
  if (window.__vlH264) return;
  window.__vlH264 = true;
  const rx = /vp0?9|vp8|av01|av1|webm/i;
  const orig = MediaSource.isTypeSupported.bind(MediaSource);
  MediaSource.isTypeSupported = function (t) {
    return rx.test(String(t)) ? false : orig(t);
  };
  const cpt = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (t) {
    return rx.test(String(t)) ? '' : cpt.call(this, t);
  };
})();

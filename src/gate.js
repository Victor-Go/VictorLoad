// "New tab" download mode (MAIN world, document_start, registered before h264.js and mse.js).
// Only the background tab VictorLoad opens for a download (its address has vl_dl=1) may run those two
// scripts. On every other YouTube page this marks them as already loaded, so they do nothing and the
// player you watch is never touched.
(() => {
  if (/[?&]vl_dl=1(&|$)/.test(location.search)) return;
  window.__vlH264 = true;
  window.__vlMse = true;
})();

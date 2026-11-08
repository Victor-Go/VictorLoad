// A fake `chrome` for driving the extension's scripts in Node.
//
// It is strict: a call that is neither given in `overrides` nor listed in `noop` throws, so a test fails
// when the code starts using an API the test did not expect (a typo, a missing permission, a new call).
// `addListener` registrations are recorded in `handlers` (keyed by event path, e.g. 'runtime.onMessage').
// Properties of unknown namespaces can be read, so feature checks like `chrome.sidePanel?.x` still work;
// pass `missing: ['sidePanel']` to make a namespace undefined.

/** Calls that background.js makes and that need no answer in the tests */
export const COMMON_NOOP = [
  'action.setBadgeText',
  'action.setBadgeBackgroundColor',
  'action.setPopup',
  'sidePanel.setPanelBehavior',
  'scripting.executeScript',
  'scripting.registerContentScripts',
  'scripting.unregisterContentScripts',
  'webNavigation.getAllFrames',
  'tabs.query',
  'offscreen.createDocument',
  'alarms.create',
  'alarms.clear',
];

export function createFakeChrome({ overrides = {}, noop = COMMON_NOOP, missing = [] } = {}) {
  const handlers = {};
  const unexpected = [];
  const noopSet = new Set(noop);
  const node = (path) =>
    new Proxy(function () {}, {
      get: (_t, p) => {
        if (p === 'then') return undefined; // so `await chrome.x` does not treat the proxy as a promise
        if (path === '' && missing.includes(p)) return undefined;
        return node(path ? path + '.' + String(p) : String(p));
      },
      apply: (_t, _this, args) => {
        if (overrides[path]) return overrides[path](...args);
        if (path.endsWith('.addListener')) return void (handlers[path.slice(0, -12)] ||= []).push(args[0]);
        if (noopSet.has(path)) return Promise.resolve();
        unexpected.push(path);
        throw new Error(`Unexpected chrome call in test: chrome.${path}(...)`);
      },
    });
  // `overrides` is returned so a test can swap an answer later (the proxy looks it up on every call)
  return { chrome: node(''), handlers, unexpected, overrides };
}

/** In-memory chrome.storage.local / .session, with an optional quota like the real one */
export function createStorage({ local = {}, session = {}, quotaBytes = Infinity } = {}) {
  const store = { local, session };
  const get = (area) => async (k) =>
    k == null
      ? { ...store[area] }
      : typeof k === 'string'
        ? { [k]: store[area][k] }
        : Array.isArray(k)
          ? Object.fromEntries(k.map((x) => [x, store[area][x]]))
          : { ...store[area] };
  const set = (area) => async (o) => {
    if (area === 'local') {
      const next = { ...store.local, ...o };
      if (Buffer.byteLength(JSON.stringify(next), 'utf8') > api.quotaBytes) {
        throw new Error('QUOTA_BYTES quota exceeded');
      }
    }
    Object.assign(store[area], o);
  };
  const api = {
    store,
    quotaBytes,
    overrides: {
      'storage.local.get': get('local'),
      'storage.local.set': set('local'),
      'storage.session.get': get('session'),
      'storage.session.set': set('session'),
      'storage.session.remove': async (k) => void delete store.session[k],
    },
  };
  return api;
}

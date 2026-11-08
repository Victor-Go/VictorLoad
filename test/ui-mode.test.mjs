// How the extension picks between the side panel and the popup when the toolbar icon is clicked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome } from './helpers/fake-chrome.mjs';

/** Loads a fresh copy of the service worker with a fake chrome API and reports what it configured */
async function load({ uiMode, hasSidePanel = true }) {
  const calls = { popup: [], panelOnClick: [] };
  const store = { settings: uiMode ? { uiMode } : {} };
  const overrides = {
    'storage.local.get': async (key) => ({ [key]: store[key] }),
    'storage.session.get': async () => ({}),
    'action.setPopup': async (o) => void calls.popup.push(o.popup),
    'sidePanel.setPanelBehavior': async (o) => void calls.panelOnClick.push(o.openPanelOnActionClick),
    'scripting.getRegisteredContentScripts': async () => [],
  };
  const fake = createFakeChrome({ overrides, missing: hasSidePanel ? [] : ['sidePanel'] });
  globalThis.chrome = fake.chrome;
  await import(`../src/background.js?run=${Math.random()}`); // a new URL gives a new module instance
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(fake.unexpected, []);
  return calls;
}

test('default: the icon opens the side panel', async () => {
  const c = await load({});
  assert.deepEqual(c.panelOnClick, [true]);
  assert.deepEqual(c.popup, ['']);
});

test('popup mode: the icon opens the popup instead', async () => {
  const c = await load({ uiMode: 'popup' });
  assert.deepEqual(c.panelOnClick, [false]);
  assert.deepEqual(c.popup, ['src/sidepanel.html?popup=1']);
});

test('a browser without the side panel API falls back to the popup', async () => {
  const c = await load({ uiMode: 'sidepanel', hasSidePanel: false });
  assert.deepEqual(c.panelOnClick, []);
  assert.deepEqual(c.popup, ['src/sidepanel.html?popup=1']);
});

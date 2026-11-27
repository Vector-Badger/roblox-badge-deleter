const assert = require('assert').strict;

// Simple Mocks for Browser Globals
let messageHandler = null;
let badgeUpdates = 0;
global.chrome = {
  runtime: {
    onMessage: {
      addListener: (fn) => { messageHandler = fn; }
    },
    sendMessage: () => {}
  },
  action: {
    setBadgeBackgroundColor: () => {},
    setBadgeText: () => { badgeUpdates++; }
  },
  i18n: {
    getMessage: () => ''
  }
};

const mockCacheStore = new Map();
if (typeof global.Response === 'undefined') {
  global.Response = class {
    constructor(body) { this._body = body; }
    async json() { return JSON.parse(this._body); }
  };
}
global.caches = {
  open: async () => ({
    put: async (key, res) => { mockCacheStore.set(key, res); },
    match: async (key) => mockCacheStore.get(key)
  })
};

let fetchMockData = {};
global.fetch = async (url, options) => {
  if (fetchMockData[url]) {
    const mockRes = fetchMockData[url](options);
    return mockRes;
  }
  return {
    ok: true,
    json: async () => ({}),
    headers: { get: () => null }
  };
};
global.setFetchMock = (url, handler) => {
  fetchMockData[url] = handler;
};
global.clearFetchMocks = () => {
  fetchMockData = {};
};

// Mock Document and elements for popup.js
const mockElements = {
  status: { textContent: '', style: {} },
  loadBtn: { disabled: false, addEventListener: () => {} },
  'step-load': { style: {} },
  'step-filter': { style: {} },
  phraseFilter: { value: '', addEventListener: () => {} },
  whitelistFilter: { value: '', addEventListener: () => {} },
  inventoryStats: { textContent: '' },
  matchCount: { textContent: '' },
  deleteBtn: { disabled: false, addEventListener: () => {} },
  badgeList: { innerHTML: '', appendChild: () => {} },
  'step-confirm': { style: {} },
  confirmCount: { textContent: '' },
  cancelDeleteBtn: { addEventListener: () => {} },
  confirmDeleteBtn: { addEventListener: () => {} },
  popOutLink: { style: {}, previousElementSibling: { style: {} } }
};

global.document = {
  getElementById: (id) => {
    return mockElements[id] || { style: {}, textContent: '', addEventListener: () => {} };
  },
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {} }),
  createDocumentFragment: () => ({ appendChild: () => {} })
};

// Now require background and popup
const bg = require('./background.js');
const popup = require('./popup.js');

console.log('Mocks and exports setup correctly');

// --- background.js Tests ---
async function testBackground() {
  console.log("Running background.js tests...");

  // Test getCsrfToken
  clearFetchMocks();
  setFetchMock('https://auth.roblox.com/v2/logout', (options) => {
    return {
      headers: {
        get: (header) => header === 'x-csrf-token' ? 'mock-csrf-token' : null
      }
    };
  });

  // Need to force reset of internal cached token if possible. Since it's module scoped, we'll just test what's there.
  // We can't reset it directly, but since we haven't fetched it yet, it should work.
  const token = await bg.getCsrfToken();
  assert.equal(token, 'mock-csrf-token', 'getCsrfToken should return token from header');

  // Test getUserId
  setFetchMock('https://users.roblox.com/v1/users/authenticated', (options) => {
    return {
      ok: true,
      json: async () => ({ id: 12345 })
    };
  });
  const userId = await bg.getUserId();
  assert.equal(userId, 12345, 'getUserId should return the ID');

  // Test fetchAllBadges
  let badgeCalls = 0;
  setFetchMock('https://badges.roblox.com/v1/users/12345/badges?limit=100&sortOrder=Desc', (options) => {
    badgeCalls++;
    if (badgeCalls === 1) {
      return { ok: true, json: async () => ({ data: [{ id: 1 }, { id: 2 }], nextPageCursor: 'cursor1' }) };
    }
    return { ok: false };
  });
  setFetchMock('https://badges.roblox.com/v1/users/12345/badges?limit=100&sortOrder=Desc&cursor=cursor1', (options) => {
    return { ok: true, json: async () => ({ data: [{ id: 3 }], nextPageCursor: null }) };
  });

  const badgesRes = await bg.fetchAllBadges();
  assert.equal(badgesRes.success, true);
  assert.equal(badgesRes.badges.length, 3);
  assert.equal(badgesRes.badges[2].id, 3);

  // Test deleteBadge
  setFetchMock('https://badges.roblox.com/v1/user/badges/1', (options) => {
    assert.equal(options.headers['x-csrf-token'], 'mock-csrf-token');
    return { ok: true };
  });
  const delRes = await bg.deleteBadge(1);
  assert.equal(delRes.success, true);

  // Test runMassDeletion
  setFetchMock('https://badges.roblox.com/v1/user/badges/2', () => ({ ok: true }));
  setFetchMock('https://badges.roblox.com/v1/user/badges/3', () => ({
    ok: false, status: 400, json: async () => ({ errors: [{ message: 'Bad request' }] })
  }));

  const massDelRes = await bg.runMassDeletion([1, 2, 3]);
  assert.equal(massDelRes.status, 'completed');
  assert.equal(massDelRes.deleted, 2);
  assert.equal(massDelRes.failed, 1);

  // Test fallback CSRF Extraction
  bg.resetState();
  clearFetchMocks();
  setFetchMock('https://auth.roblox.com/v2/logout', (options) => {
    return {
      headers: { get: () => null }
    };
  });
  setFetchMock('https://badges.roblox.com/v1/user/badges/0', (options) => {
    return {
      headers: { get: (header) => header === 'x-csrf-token' ? 'mock-fallback-token' : null }
    };
  });
  const fallbackToken = await bg.getCsrfToken();
  assert.equal(fallbackToken, 'mock-fallback-token', 'getCsrfToken should return fallback token');

  // Test 403 CSRF Token Refresh Retry
  bg.resetState();
  let retryBadgeCalls = 0;
  setFetchMock('https://badges.roblox.com/v1/user/badges/403', () => {
    retryBadgeCalls++;
    if (retryBadgeCalls === 1) {
      return {
        status: 403,
        headers: { get: (h) => h === 'x-csrf-token' ? 'refreshed-token' : null }
      };
    }
    return { ok: true };
  });
  const retryDelRes = await bg.deleteBadge(403);
  assert.equal(retryDelRes.success, true);
  assert.equal(retryBadgeCalls, 2);

  // Test 429 Rate-Limit Retry and Deletion State Tracking
  bg.resetState();
  const origSetTimeout = global.setTimeout;
  const origDateNow = global.Date.now;

  // Override to mock time progressing without delay (ignore fetchWithTimeout's 15s abort timer)
  global.setTimeout = (cb, ms) => (ms > 5000 ? 0 : cb());
  let mockTime = 1000;
  global.Date.now = () => { mockTime += 1000; return mockTime; };

  let limitBadgeCalls = 0;
  setFetchMock('https://badges.roblox.com/v1/user/badges/429', () => {
    limitBadgeCalls++;
    if (limitBadgeCalls === 1) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true };
  });

  const massDelPromise = bg.runMassDeletion([429]);

  // Check synchronous state setup
  const initialDelState = bg.getDeletionState();
  assert.equal(initialDelState.isRunning, true);
  assert.equal(initialDelState.total, 1);

  const massDelRetryRes = await massDelPromise;

  assert.equal(massDelRetryRes.status, 'completed');
  assert.equal(massDelRetryRes.deleted, 1);
  assert.equal(limitBadgeCalls, 2);

  const finalDelState = bg.getDeletionState();
  assert.equal(finalDelState.isRunning, false);
  assert.equal(finalDelState.deleted, 1);

  // Test Automatic Second-Chance Retry Sweep for transiently failed badges
  bg.resetState();
  let transientCalls = 0;
  setFetchMock('https://badges.roblox.com/v1/user/badges/777', () => {
    transientCalls++;
    if (transientCalls === 1) return { ok: false, status: 400, json: async () => ({ errors: [{ message: 'Transient glitch' }] }) };
    return { ok: true };
  });
  const sweepRes = await bg.runMassDeletion([777]);
  assert.equal(sweepRes.status, 'completed');
  assert.equal(sweepRes.deleted, 1, 'Transiently failed badge should be recovered by automatic retry sweep');
  assert.equal(sweepRes.failed, 0);
  assert.equal(transientCalls, 2);
  assert.equal(badgeUpdates > 0, true, 'Toolbar action badge should receive progress updates');

  // Test CacheStorage State Persistence & Orphaned Running Normalization on MV3 SW Restart
  await bg.persistDeletionState({ isRunning: true, total: 98, deleted: 90, failed: 0, lastError: null });
  bg.resetState();
  const recovered = await new Promise(resolve => {
    const isAsync = messageHandler({ action: 'get_deletion_status' }, {}, resolve);
    assert.equal(isAsync, true);
  });
  assert.equal(recovered.total, 98);
  assert.equal(recovered.deleted, 90);
  assert.equal(recovered.isRunning, false, 'Interrupted SW state should normalize isRunning to false');

  // Test Sustained 429 + WAF 403 Recovery Across Worker + Wave Cooldowns
  bg.resetState();
  let heavy429Calls = 0;
  setFetchMock('https://badges.roblox.com/v1/user/badges/4290', () => {
    heavy429Calls++;
    if (heavy429Calls <= 4) {
      return {
        ok: false,
        status: 429,
        headers: { get: (h) => h === 'retry-after' ? '5' : null },
        json: async () => ({})
      };
    }
    if (heavy429Calls <= 12) {
      return {
        ok: false,
        status: 403,
        headers: { get: (h) => h === 'x-ratelimit-reset' ? '12' : null },
        json: async () => ({ errors: [{ message: 'WAF Challenge' }] })
      };
    }
    return { ok: true };
  });
  const heavyRes = await bg.runMassDeletion([4290]);
  assert.equal(heavyRes.status, 'completed');
  assert.equal(heavyRes.deleted, 1, 'Heavy 429 + WAF 403 badge should be rescued inside wave cooldown loop');
  assert.equal(heavyRes.failed, 0);
  assert.equal(heavy429Calls, 13);

  // Test Serial Cooldown Prevents Request Stampeding On Queued Badges
  bg.resetState();
  const waveCounts = { 901: 0, 902: 0, 903: 0 };
  setFetchMock('https://badges.roblox.com/v1/user/badges/901', () => {
    waveCounts[901]++;
    return waveCounts[901] <= 3 ? { ok: false, status: 429, json: async () => ({}) } : { ok: true };
  });
  setFetchMock('https://badges.roblox.com/v1/user/badges/902', () => {
    waveCounts[902]++;
    // After 901 waits out Roblox cooldown, 902 should delete in a single clean request
    return {
      ok: true,
      headers: { get: (h) => h === 'x-ratelimit-remaining' ? '0' : (h === 'x-ratelimit-reset' ? '2' : null) }
    };
  });
  setFetchMock('https://badges.roblox.com/v1/user/badges/903', () => {
    waveCounts[903]++;
    return waveCounts[903] <= 1 ? { ok: false, status: 429, json: async () => ({}) } : { ok: true };
  });
  const waveDrainRes = await bg.runMassDeletion([901, 902, 903]);
  assert.equal(waveDrainRes.deleted, 3, 'All badges across serial adaptive cooldowns must delete cleanly');
  assert.equal(waveDrainRes.failed, 0);
  assert.equal(waveCounts[901], 4);
  assert.equal(waveCounts[902], 1, '902 must delete in 1 call once 901 clears cooldown');
  assert.equal(waveCounts[903], 2);

  // Test Non-429 Retry Exhaustion Preserves Real HTTP Error Message
  bg.resetState();
  setFetchMock('https://badges.roblox.com/v1/user/badges/5000', () => ({
    ok: false,
    status: 500,
    json: async () => ({ errors: [{ message: 'Internal Server Error' }] })
  }));
  const serverErrRes = await bg.runMassDeletion([5000]);
  assert.equal(serverErrRes.failed, 1);
  assert.equal(serverErrRes.lastError.includes('Internal Server Error'), true, '500 failure must preserve server error rather than reporting Rate Limited');

  // Test GA4 Key Event Telemetry, Anonymous Identity, Sanitization, and Firefox Block
  bg.resetState();
  clearFetchMocks();
  const gaPayloads = [];
  const gaUrl = 'https://www.google-analytics.com/mp/collect?measurement_id=G-JKKP6G713X&api_secret=9W7muFwuReyr9HcMo-GI8A';
  setFetchMock(gaUrl, (options) => {
    gaPayloads.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({}), headers: { get: () => null } };
  });

  const origGetManifest = global.chrome.runtime.getManifest;
  const origGetURL = global.chrome.runtime.getURL;
  const origGetUILanguage = global.chrome.i18n.getUILanguage;
  global.chrome.runtime.getManifest = () => ({ version: '1.45.0' });
  global.chrome.runtime.getURL = () => 'chrome-extension://abcdefghijklmnop/';
  global.chrome.i18n.getUILanguage = () => 'en-US';
  const flushTelemetry = () => new Promise(r => origSetTimeout(r, 5));

  // Verify reserved GA4 event names are dropped
  await bg.trackAnalyticsEvent('error', { bad: 1 });
  assert.equal(gaPayloads.length, 0, 'Reserved GA4 event name "error" must never be dispatched');

  // Verify anonymous client_id, session_id, PII stripping, and 95-char truncation
  await bg.trackAnalyticsEvent('deletion_partial_fail', {
    deleted_count: 5,
    failed_count: 1,
    error_detail: 'Failed at https://badges.roblox.com/v1/users/987654321/badges ' + 'x'.repeat(120)
  });
  assert.equal(gaPayloads.length, 1);
  const firstEvent = gaPayloads[0];
  assert.notEqual(firstEvent.client_id, 'extension_user_background', 'client_id must be unique per install');
  assert.match(String(firstEvent.events[0].params.session_id), /^\d+$/, 'session_id must be positive digits');
  assert.equal(firstEvent.events[0].params.engagement_time_msec >= 100, true);
  assert.equal(firstEvent.events[0].params.ext_version, '1.45.0');
  assert.equal(firstEvent.events[0].params.error_detail.includes('987654321'), false, 'Numeric Roblox userId must be scrubbed');
  assert.equal(firstEvent.events[0].params.error_detail.includes('/users/[id]'), true);
  assert.equal(firstEvent.events[0].params.error_detail.length <= 95, true, 'GA4 params must stay below 100-char ceiling');

  // Verify persistent client_id survives SW memory resets via CacheStorage
  bg.resetState();
  await bg.trackAnalyticsEvent('deletion_started', { total_items: 1 });
  assert.equal(gaPayloads.length, 2);
  assert.equal(gaPayloads[1].client_id, firstEvent.client_id);

  // Verify deletion_full_clear and deletion_total_fail outcome split
  setFetchMock('https://auth.roblox.com/v2/logout', () => ({
    headers: { get: (h) => h === 'x-csrf-token' ? 'mock-csrf-token' : null }
  }));
  setFetchMock('https://badges.roblox.com/v1/user/badges/601', () => ({ ok: true }));
  await bg.runMassDeletion([601]);
  await flushTelemetry();
  assert.equal(gaPayloads.some(p => p.events[0].name === 'deletion_full_clear' && p.events[0].params.deleted_count === 1), true);

  setFetchMock('https://badges.roblox.com/v1/user/badges/602', () => ({
    ok: false,
    status: 401,
    json: async () => ({ errors: [{ message: 'Authorization has been denied' }] })
  }));
  await bg.runMassDeletion([602]);
  await flushTelemetry();
  const totalFailEvt = gaPayloads.find(p => p.events[0].name === 'deletion_total_fail');
  assert.equal(Boolean(totalFailEvt), true, 'Zero-success deletion must emit deletion_total_fail');
  assert.equal(totalFailEvt.events[0].params.error_reason, 'not_logged_in');
  assert.equal(totalFailEvt.events[0].params.error_status, 401);

  // Verify inventory_load_failed telemetry on auth failure
  setFetchMock('https://users.roblox.com/v1/users/authenticated', () => ({ ok: false, status: 401 }));
  const invFail = await bg.fetchAllBadges();
  await flushTelemetry();
  assert.equal(invFail.success, false);
  const invFailEvt = gaPayloads.find(p => p.events[0].name === 'inventory_load_failed');
  assert.equal(Boolean(invFailEvt), true);
  assert.equal(invFailEvt.events[0].params.error_reason, 'not_logged_in');
  assert.equal(invFailEvt.events[0].params.error_status, 401);

  // Verify badge_worker_interrupted telemetry on orphaned SW recovery
  await bg.persistDeletionState({ isRunning: true, total: 50, deleted: 12, failed: 0, lastError: null });
  bg.resetState();
  await new Promise(resolve => messageHandler({ action: 'get_deletion_status' }, {}, resolve));
  await flushTelemetry();
  const interruptedEvt = gaPayloads.find(p => p.events[0].name === 'badge_worker_interrupted');
  assert.equal(Boolean(interruptedEvt), true);
  assert.equal(interruptedEvt.events[0].params.deleted_count, 12);
  assert.equal(interruptedEvt.events[0].params.total_items, 50);

  // Verify Firefox telemetry suppression (zero external pings under moz-extension://)
  const countBeforeFirefox = gaPayloads.length;
  global.chrome.runtime.getURL = () => 'moz-extension://firefox-uuid-test/';
  assert.equal(bg.isTelemetryAllowed(), false);
  await bg.trackAnalyticsEvent('deletion_full_clear', { deleted_count: 99 });
  assert.equal(gaPayloads.length, countBeforeFirefox, 'Firefox build must send zero telemetry requests');

  // Restore globals and runtime helpers
  global.chrome.runtime.getManifest = origGetManifest;
  global.chrome.runtime.getURL = origGetURL;
  global.chrome.i18n.getUILanguage = origGetUILanguage;
  global.setTimeout = origSetTimeout;
  global.Date.now = origDateNow;

  console.log("background.js tests passed!");
}

// --- popup.js Tests ---
function testPopup() {
  console.log("Running popup.js tests...");

  // Test matchesQuery
  const mockBadge1 = { name: "Cool Badge", description: "This is a cool badge", awarder: { name: "Cool Creator" } };
  const mockBadge2 = { name: "Boring Item", description: "Very mundane", awarder: null };

  assert.equal(popup.matchesQuery(mockBadge1, "cool"), true, "matchesQuery should match name/desc");
  assert.equal(popup.matchesQuery(mockBadge1, "creator"), true, "matchesQuery should match awarder");
  assert.equal(popup.matchesQuery(mockBadge2, "cool"), false, "matchesQuery shouldn't match wrong string");

  // Test applyFilters
  popup.setAllBadges([mockBadge1, mockBadge2]);

  // Empty filters
  popup.setPhraseFilter("");
  popup.setWhitelistFilter("");
  popup.applyFilters();
  assert.equal(popup.getMatchedBadges().length, 2);
  assert.equal(popup.getSelectedCount(), 2);

  // Phrase filter
  popup.setPhraseFilter("cool");
  popup.setWhitelistFilter("");
  popup.applyFilters();
  assert.equal(popup.getMatchedBadges().length, 1);
  assert.equal(popup.getMatchedBadges()[0].badge.name, "Cool Badge");
  assert.equal(popup.getSelectedCount(), 1);

  // Whitelist filter
  popup.setPhraseFilter("");
  popup.setWhitelistFilter("boring");
  popup.applyFilters();
  assert.equal(popup.getMatchedBadges().length, 2);
  // Boring item should be filtered out from selected
  assert.equal(popup.getSelectedCount(), 1);
  const matched = popup.getMatchedBadges();
  assert.equal(matched[1].badge.name, "Boring Item");
  assert.equal(matched[1].selected, false);

  console.log("popup.js tests passed!");
}

async function runAllTests() {
  await testBackground();
  testPopup();
}

runAllTests().catch(e => {
  console.error("Test failed:", e);
  process.exit(1);
});

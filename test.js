const assert = require('assert').strict;

// Simple Mocks for Browser Globals
global.chrome = {
  runtime: {
    onMessage: {
      addListener: () => {}
    },
    sendMessage: () => {}
  }
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

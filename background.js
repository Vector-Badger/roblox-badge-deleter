let cachedCsrfToken = null;
let csrfPromise = null;
let deletionState = {
  isRunning: false,
  total: 0,
  deleted: 0,
  failed: 0,
  lastError: null,
  statusMessage: null
};

function setToolbarBadge(text, color = '#F68888') {
  try {
    if (typeof chrome !== 'undefined' && chrome.action && chrome.action.setBadgeText) {
      chrome.action.setBadgeBackgroundColor({ color });
      chrome.action.setBadgeText({ text: String(text) });
    }
  } catch (e) {}
}

async function waitWithBadgeUpdate(ms, badgeColor = '#00B06F') {
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(remaining, 5000);
    await new Promise(r => setTimeout(r, step));
    remaining -= step;
    if (deletionState && deletionState.isRunning) {
      setToolbarBadge(deletionState.deleted > 0 ? String(deletionState.deleted) : '0', badgeColor);
    }
  }
}

async function persistDeletionState(state) {
  try {
    if (typeof caches !== 'undefined' && caches.open) {
      const cache = await caches.open('badge-deleter-state-v1');
      await cache.put('https://local.state/deletion', new Response(JSON.stringify(state)));
    }
  } catch (e) {}
}

async function loadPersistedDeletionState() {
  try {
    if (typeof caches !== 'undefined' && caches.open) {
      const cache = await caches.open('badge-deleter-state-v1');
      const res = await cache.match('https://local.state/deletion');
      if (res) return await res.json();
    }
  } catch (e) {}
  return null;
}

async function getCsrfToken() {
  if (cachedCsrfToken) return cachedCsrfToken;
  if (csrfPromise) return csrfPromise;

  csrfPromise = (async () => {
    try {
      const response = await fetch('https://auth.roblox.com/v2/logout', {
        method: 'POST',
        credentials: 'include'
      });
      const csrfToken = response && response.headers ? response.headers.get('x-csrf-token') : null;
      if (csrfToken) {
        cachedCsrfToken = csrfToken;
        return csrfToken;
      }

      // Fallback: probe badges.roblox.com directly for x-csrf-token
      const fallbackRes = await fetch('https://badges.roblox.com/v1/user/badges/0', {
        method: 'DELETE',
        credentials: 'include'
      });
      const fallbackToken = fallbackRes && fallbackRes.headers ? fallbackRes.headers.get('x-csrf-token') : null;
      if (fallbackToken) {
        cachedCsrfToken = fallbackToken;
        return fallbackToken;
      }
    } catch (err) {
      console.error("Network error during CSRF token fetch: ", err);
    } finally {
      csrfPromise = null;
    }
    throw new Error("Could not extract CSRF token. Make sure you are logged in to Roblox.");
  })();

  return csrfPromise;
}

function getRetryDelayMs(headers) {
  if (!headers || typeof headers.get !== 'function') return 0;
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const asSeconds = Number(retryAfter);
    if (Number.isFinite(asSeconds) && asSeconds > 0) {
      return Math.min(asSeconds * 1000, 120000);
    }
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) {
      const delta = asDate - Date.now();
      if (delta > 0) return Math.min(delta, 120000);
    }
  }
  const resetHeader = headers.get('x-ratelimit-reset');
  if (resetHeader) {
    const resetVal = Number(resetHeader);
    if (Number.isFinite(resetVal) && resetVal > 0) {
      const deltaMs = resetVal > 1e9 ? (resetVal * 1000 - Date.now()) : (resetVal * 1000);
      if (deltaMs > 0) return Math.min(deltaMs, 120000);
    }
  }
  return 0;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  if (typeof AbortController === 'undefined') {
    return fetch(url, options);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function deleteBadge(badgeId) {
  let csrfToken = cachedCsrfToken;
  if (!csrfToken) {
    try {
      csrfToken = await getCsrfToken();
    } catch (e) {
      csrfToken = '';
    }
  }
  
  const safeBadgeId = encodeURIComponent(badgeId);
  const requestInit = () => ({
    method: 'DELETE',
    credentials: 'include',
    headers: {
      'x-csrf-token': csrfToken
    }
  });
  let response = await fetchWithTimeout(`https://badges.roblox.com/v1/user/badges/${safeBadgeId}`, requestInit());

  if (response.status === 403 && response.headers && response.headers.get('x-csrf-token')) {
    csrfToken = response.headers.get('x-csrf-token');
    cachedCsrfToken = csrfToken; 
    
    response = await fetchWithTimeout(`https://badges.roblox.com/v1/user/badges/${safeBadgeId}`, requestInit());
  }

  if (response.ok) {
    let preemptiveWaitMs = 0;
    if (response.headers && typeof response.headers.get === 'function') {
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (remaining !== null && Number(remaining) <= 0) {
        preemptiveWaitMs = getRetryDelayMs(response.headers);
      }
    }
    return { success: true, preemptiveWaitMs };
  } else {
    let errorMsg = `HTTP Error ${response.status}`;
    const retryAfterMs = getRetryDelayMs(response.headers);
    try {
      const data = await response.json();
      if (data.errors && data.errors.length > 0) {
        errorMsg = data.errors[0].message;
      }
    } catch (e) {
      console.warn("Could not parse error JSON:", e);
    }
    return { success: false, error: errorMsg, status: response.status, retryAfterMs };
  }
}

async function getUserId() {
  const response = await fetch('https://users.roblox.com/v1/users/authenticated', {
    credentials: 'include'
  });
  if (!response.ok) throw new Error("Not logged in to Roblox.");
  const data = await response.json();
  return data.id;
}

async function fetchAllBadges() {
  try {
    const userId = await getUserId();
    let allBadges = [];
    let cursor = "";
    
    do {
      let url = `https://badges.roblox.com/v1/users/${encodeURIComponent(userId)}/badges?limit=100&sortOrder=Desc`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
      
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP Error ${response.status} fetching badges`);
      
      const data = await response.json();
      if (data.data) {
        allBadges.push(...data.data);
      }
      cursor = data.nextPageCursor;
    } while (cursor);
    
    return { success: true, badges: allBadges };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'delete_badge') {
    deleteBadge(message.badgeId)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; 
  } else if (message.action === 'fetch_all_badges') {
    deletionState = { isRunning: false, total: 0, deleted: 0, failed: 0, lastError: null, statusMessage: null };
    setToolbarBadge('');
    persistDeletionState(deletionState);
    fetchAllBadges()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  } else if (message.action === 'start_mass_deletion') {
    runMassDeletion(message.badgesToDelete)
      .then(result => {
        try { sendResponse(result); } catch (e) {}
      })
      .catch(error => {
        try { sendResponse({ status: 'error', error: error.message }); } catch (e) {}
      });
    return true;
  } else if (message.action === 'get_deletion_status') {
    if (deletionState.isRunning || deletionState.total > 0 || typeof caches === 'undefined') {
      sendResponse(deletionState);
      return false;
    }
    loadPersistedDeletionState().then(saved => {
      if (saved && saved.total > 0) {
        if (saved.isRunning) {
          saved.isRunning = false;
          saved.lastError = saved.lastError || 'Background worker was interrupted before finishing.';
          persistDeletionState(saved);
        }
        deletionState = saved;
      }
      sendResponse(deletionState);
    });
    return true;
  } else if (message.action === 'track_analytics') {
    trackAnalyticsEvent(message.eventName, message.params);
    sendResponse({ success: true });
    return false;
  }
});

async function runMassDeletion(badgesToProcess) {
  if (!Array.isArray(badgesToProcess) || badgesToProcess.length === 0) {
    return { status: 'completed', deleted: 0, failed: 0 };
  }

  deletionState = {
    isRunning: true,
    total: badgesToProcess.length,
    deleted: 0,
    failed: 0,
    lastError: null,
    statusMessage: null
  };
  persistDeletionState(deletionState);
  setToolbarBadge('0', '#00B06F');

  try {
    // Pre-warm CSRF token before spawning workers
    try {
      await getCsrfToken();
    } catch (e) {
      console.warn("Initial CSRF token fetch warning:", e);
    }

    const START_STAGGER_MS = 250;
    const THROTTLED_FLOOR_MS = 1050;
    const CRUISING_START_MS = 1150;
    const MAX_STAGGER_MS = 3500;
    // Roblox web endpoints use a ~60s rolling bucket and escalate up to 5-15m when hammered mid-429.
    // Wait full cooldown intervals so tokens refill cleanly instead of repeatedly resetting the timer.
    const COOLDOWNS_MS = [60000, 60000, 90000, 120000, 120000, 150000, 180000, 180000, 180000, 180000, 180000, 180000];
    let successCount = 0;
    let failCount = 0;
    let pacingDelayMs = START_STAGGER_MS;
    let throttledOnce = false;
    let cleanStreak = 0;
    const glitchRetryQueue = [];

    function isRetryableStatus(status) {
      return status === 429 || status === 408 || status === 403 || status >= 500 || status === 0;
    }

    function formatAttemptError(status, message) {
      if (status === 429) return 'Max retries exceeded (Rate Limited)';
      return `Max retries exceeded (${message || `HTTP Error ${status}`})`;
    }

    function recordDeleted() {
      successCount++;
      deletionState.deleted = successCount;
      setToolbarBadge(String(successCount), '#00B06F');
      persistDeletionState(deletionState);
    }

    function recordFailed(badgeId, errorMsg) {
      console.warn(`Failed deleting badge ${badgeId} after cooldown recovery:`, errorMsg);
      deletionState.lastError = errorMsg;
      failCount++;
      deletionState.failed = failCount;
      persistDeletionState(deletionState);
    }

    async function tryDeleteSingle(badgeId) {
      try {
        const res = await deleteBadge(badgeId);
        if (res.success) return { success: true, preemptiveWaitMs: res.preemptiveWaitMs || 0 };
        return {
          success: false,
          retryable: isRetryableStatus(res.status),
          status: res.status,
          error: res.error || `HTTP Error ${res.status}`,
          retryAfterMs: res.retryAfterMs || 0
        };
      } catch (e) {
        return {
          success: false,
          retryable: true,
          status: 0,
          error: e.message || 'Network error',
          retryAfterMs: 0
        };
      }
    }

    async function processBadgeAdaptively(badgeId, allowGlitchDefer) {
      let stalledRetries = 0;
      let didQuickCsrfRetry = false;

      while (true) {
        const res = await tryDeleteSingle(badgeId);
        if (res.success) {
          recordDeleted();
          cleanStreak++;
          if (throttledOnce && cleanStreak >= 40) {
            pacingDelayMs = Math.max(THROTTLED_FLOOR_MS, pacingDelayMs - 50);
            cleanStreak = 0;
          }
          if (res.preemptiveWaitMs > 0) {
            deletionState.statusMessage = `Cooldown: waiting ${Math.max(1, Math.round(res.preemptiveWaitMs / 1000))}s before next quota window...`;
            persistDeletionState(deletionState);
            await waitWithBadgeUpdate(res.preemptiveWaitMs, '#F68802');
            deletionState.statusMessage = null;
            persistDeletionState(deletionState);
          }
          return true;
        }

        if (!res.retryable) {
          if (allowGlitchDefer) {
            glitchRetryQueue.push({ badgeId, lastError: res.error });
          } else {
            recordFailed(badgeId, res.error);
          }
          return false;
        }

        cleanStreak = 0;
        if (res.status === 403 || res.status === 0) {
          cachedCsrfToken = null;
        }

        // Only do one rapid retry for genuine CSRF expiry; everything else rests for full recovery
        if (res.status === 403 && !didQuickCsrfRetry && stalledRetries === 0) {
          didQuickCsrfRetry = true;
          await new Promise(r => setTimeout(r, 600));
          continue;
        }

        if (stalledRetries >= COOLDOWNS_MS.length) {
          recordFailed(badgeId, formatAttemptError(res.status, res.error));
          return false;
        }

        throttledOnce = true;
        pacingDelayMs = Math.min(Math.max(CRUISING_START_MS, Math.round(pacingDelayMs * 1.35)), MAX_STAGGER_MS);
        const waitMs = Math.max(res.retryAfterMs || 0, COOLDOWNS_MS[stalledRetries]);
        stalledRetries++;

        deletionState.statusMessage = `Rate limited by Roblox — resting ${Math.max(1, Math.round(waitMs / 1000))}s so quota resets cleanly...`;
        persistDeletionState(deletionState);
        await waitWithBadgeUpdate(waitMs, '#F68802');
        deletionState.statusMessage = null;
        persistDeletionState(deletionState);
      }
    }

    // Sequential pacing eliminates concurrent 429 collisions against Roblox's single-session bucket
    for (let i = 0; i < badgesToProcess.length; i++) {
      await processBadgeAdaptively(badgesToProcess[i], true);
      if (i < badgesToProcess.length - 1) {
        await new Promise(r => setTimeout(r, pacingDelayMs));
      }
    }

    // Single verification pass for any transient non-429 client glitches (e.g., 400)
    for (let j = 0; j < glitchRetryQueue.length; j++) {
      const item = glitchRetryQueue[j];
      const recovered = await processBadgeAdaptively(item.badgeId, false);
      if (!recovered && j < glitchRetryQueue.length - 1) {
        await new Promise(r => setTimeout(r, 150));
      }
    }

    deletionState.statusMessage = null;
    deletionState.isRunning = false;
    await persistDeletionState(deletionState);
    if (successCount > 0) {
      setToolbarBadge('✓', '#00B06F');
      setTimeout(() => { if (!deletionState.isRunning) setToolbarBadge(''); }, 4000);
    } else {
      setToolbarBadge('!', '#F68888');
    }

    if (successCount > 0 || failCount > 0) {
      trackAnalyticsEvent('mass_deletion_complete', { count: successCount, failed: failCount });
    }
    return { status: 'completed', deleted: successCount, failed: failCount, lastError: deletionState.lastError };
  } finally {
    deletionState.isRunning = false;
  }
}

function getDeletionState() {
  return deletionState;
}

function resetState() {
  cachedCsrfToken = null;
  csrfPromise = null;
  deletionState = {
    isRunning: false,
    total: 0,
    deleted: 0,
    failed: 0,
    lastError: null,
    statusMessage: null
  };
}

function trackAnalyticsEvent(eventName, params) {
  // Measurement Protocol for GA4
  // TODO: Replace with your actual Measurement ID and API Secret
  const measurement_id = 'G-JKKP6G713X'; 
  const api_secret = '9W7muFwuReyr9HcMo-GI8A'; 
  
  // If not configured, just return silently
  if (measurement_id === 'G-XXXXXXXXXX') return;

  fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${measurement_id}&api_secret=${api_secret}`, {
    method: "POST",
    body: JSON.stringify({
      client_id: 'extension_user_background', 
      events: [{
        name: eventName,
        params: params
      }]
    })
  }).catch(e => console.error("GA Error", e));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getCsrfToken,
    deleteBadge,
    getUserId,
    fetchAllBadges,
    runMassDeletion,
    trackAnalyticsEvent,
    getDeletionState,
    resetState,
    persistDeletionState,
    loadPersistedDeletionState
  };
}

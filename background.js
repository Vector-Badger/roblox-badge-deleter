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
  const response = await fetchWithTimeout('https://users.roblox.com/v1/users/authenticated', {
    credentials: 'include'
  });
  if (!response.ok) {
    const err = new Error(
      response.status === 401
        ? 'Not logged in to Roblox.'
        : `HTTP Error ${response.status} verifying Roblox session.`
    );
    err.status = response.status;
    throw err;
  }
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
      
      const response = await fetchWithTimeout(url, { credentials: 'include' });
      if (!response.ok) {
        const err = new Error(`HTTP Error ${response.status} fetching badges`);
        err.status = response.status;
        throw err;
      }
      
      const data = await response.json();
      if (data.data) {
        allBadges.push(...data.data);
      }
      cursor = data.nextPageCursor;
    } while (cursor);
    
    trackAnalyticsEvent('inventory_loaded', { badge_count: allBadges.length });
    return { success: true, badges: allBadges };
  } catch (error) {
    const errMsg = (error && error.message) ? error.message : 'Unknown inventory error';
    const errStatus = (error && error.status) || 0;
    trackAnalyticsEvent('inventory_load_failed', {
      error_reason: classifyErrorReason(errMsg, errStatus),
      error_status: errStatus,
      error_detail: sanitizeErrorDetail(errMsg)
    });
    return { success: false, error: errMsg };
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
          trackAnalyticsEvent('badge_worker_interrupted', {
            deleted_count: saved.deleted || 0,
            failed_count: saved.failed || 0,
            total_items: saved.total || 0
          });
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
    let lastFailureStatus = 0;
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

    function recordFailed(badgeId, errorMsg, status = 0) {
      console.warn(`Failed deleting badge ${badgeId} after cooldown recovery:`, errorMsg);
      deletionState.lastError = errorMsg;
      lastFailureStatus = status || 0;
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
            recordFailed(badgeId, res.error, res.status);
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
          recordFailed(badgeId, formatAttemptError(res.status, res.error), res.status);
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

    if (successCount > 0 && failCount === 0) {
      trackAnalyticsEvent('deletion_full_clear', {
        deleted_count: successCount,
        total_items: badgesToProcess.length,
        throttled_once: throttledOnce ? 1 : 0
      });
    } else if (failCount > 0) {
      const outcomeEvent = successCount > 0 ? 'deletion_partial_fail' : 'deletion_total_fail';
      trackAnalyticsEvent(outcomeEvent, {
        deleted_count: successCount,
        failed_count: failCount,
        total_items: badgesToProcess.length,
        error_reason: classifyErrorReason(deletionState.lastError, lastFailureStatus),
        error_status: lastFailureStatus,
        error_detail: sanitizeErrorDetail(deletionState.lastError)
      });
    }
    return { status: 'completed', deleted: successCount, failed: failCount, lastError: deletionState.lastError };
  } catch (fatalErr) {
    const errMsg = (fatalErr && fatalErr.message) ? fatalErr.message : 'Unexpected deletion failure';
    const errStatus = (fatalErr && fatalErr.status) || 0;
    deletionState.statusMessage = null;
    deletionState.lastError = errMsg;
    deletionState.isRunning = false;
    setToolbarBadge('!', '#F68888');
    await persistDeletionState(deletionState);
    trackAnalyticsEvent('deletion_crashed', {
      deleted_count: deletionState.deleted || 0,
      failed_count: deletionState.failed || 0,
      total_items: badgesToProcess.length,
      error_reason: classifyErrorReason(errMsg, errStatus),
      error_status: errStatus,
      error_detail: sanitizeErrorDetail(errMsg)
    });
    throw fatalErr;
  } finally {
    deletionState.isRunning = false;
  }
}

let analyticsIdentity = null;

function getDeletionState() {
  return deletionState;
}

function resetState() {
  cachedCsrfToken = null;
  csrfPromise = null;
  analyticsIdentity = null;
  deletionState = {
    isRunning: false,
    total: 0,
    deleted: 0,
    failed: 0,
    lastError: null,
    statusMessage: null
  };
}

const GA_MEASUREMENT_ID = 'G-JKKP6G713X';
const GA_API_SECRET = '9W7muFwuReyr9HcMo-GI8A';
const ANALYTICS_CACHE_KEY = 'https://local.state/analytics';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const RESERVED_GA_EVENTS = new Set([
  'error', 'first_visit', 'first_open', 'session_start', 'user_engagement', 'app_remove', 'app_update'
]);

/** Returns false on Firefox so AMO data_collection_permissions=['none'] stays strictly honored. */
function isTelemetryAllowed() {
  try {
    if (typeof browser !== 'undefined' && browser.runtime && typeof browser.runtime.getBrowserInfo === 'function') {
      return false;
    }
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
      const origin = chrome.runtime.getURL('');
      if (origin && origin.startsWith('moz-extension://')) return false;
    }
    if (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.includes('Firefox/')) {
      return false;
    }
  } catch (e) {}
  return Boolean(GA_MEASUREMENT_ID && GA_MEASUREMENT_ID !== 'G-XXXXXXXXXX' && GA_API_SECRET);
}

function generateAnonymousId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

async function getAnalyticsIdentity() {
  const now = Date.now();
  if (!analyticsIdentity && typeof caches !== 'undefined' && caches.open) {
    try {
      const cache = await caches.open('badge-deleter-state-v1');
      const res = await cache.match(ANALYTICS_CACHE_KEY);
      if (res) {
        const saved = await res.json();
        if (saved && saved.clientId) analyticsIdentity = saved;
      }
    } catch (e) {}
  }

  if (!analyticsIdentity) {
    analyticsIdentity = {
      clientId: generateAnonymousId(),
      sessionId: String(Math.floor(now / 1000)),
      lastEventAt: now
    };
  } else {
    if (!analyticsIdentity.sessionId || (now - (analyticsIdentity.lastEventAt || 0)) > SESSION_TIMEOUT_MS) {
      analyticsIdentity.sessionId = String(Math.floor(now / 1000));
    }
    analyticsIdentity.lastEventAt = now;
  }

  if (typeof caches !== 'undefined' && caches.open) {
    try {
      const cache = await caches.open('badge-deleter-state-v1');
      await cache.put(ANALYTICS_CACHE_KEY, new Response(JSON.stringify(analyticsIdentity)));
    } catch (e) {}
  }
  return analyticsIdentity;
}

function getExtensionVersion() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
      const manifest = chrome.runtime.getManifest();
      if (manifest && manifest.version) return String(manifest.version);
    }
  } catch (e) {}
  return 'unknown';
}

function getUiLocale() {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getUILanguage === 'function') {
      return chrome.i18n.getUILanguage() || '';
    }
  } catch (e) {}
  return '';
}

/** Maps verbose runtime/API errors into bounded categorical buckets for analytics grouping. */
function classifyErrorReason(errorMessage, status = 0) {
  const msg = String(errorMessage || '').toLowerCase();
  if (status === 401 || msg.includes('not logged in')) return 'not_logged_in';
  if (msg.includes('csrf')) return 'csrf_extract_failed';
  if (status === 429 || msg.includes('rate limit')) return 'rate_limited';
  if (status === 403 || msg.includes('waf') || msg.includes('forbidden')) return 'forbidden_waf';
  if (status === 408 || msg.includes('abort') || msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (status >= 500 || msg.includes('internal server')) return 'server_error';
  if (msg.includes('failed to fetch') || msg.includes('network')) return 'network_error';
  if (msg.includes('receiving end') || msg.includes('site access') || msg.includes('interrupted')) return 'extension_runtime_error';
  if (status >= 400) return `http_${status}`;
  return 'unknown_error';
}

/** Strips numeric IDs and extension hashes, enforcing GA4's 100-char parameter limit. */
function sanitizeErrorDetail(rawText) {
  if (!rawText) return '';
  return String(rawText)
    .replace(/\/users\/\d+/g, '/users/[id]')
    .replace(/\/badges\/\d+/g, '/badges/[id]')
    .replace(/(?:chrome|moz)-extension:\/\/[^/\s]+/g, 'ext://[self]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 95);
}

function sanitizeAnalyticsParams(params) {
  const clean = {};
  if (!params || typeof params !== 'object') return clean;
  let count = 0;
  for (const [key, val] of Object.entries(params)) {
    if (count >= 25) break;
    if (!key || key.length > 40) continue;
    if (/^(_|ga_|google_|gtag_|firebase_)/.test(key)) continue;
    if (val === null || val === undefined || val === '') continue;
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) continue;
      clean[key] = val;
    } else if (typeof val === 'boolean') {
      clean[key] = val ? 1 : 0;
    } else {
      const normalized = key === 'error_detail' ? sanitizeErrorDetail(val) : String(val);
      clean[key] = normalized.slice(0, 95);
    }
    count++;
  }
  return clean;
}

async function trackAnalyticsEvent(eventName, params = {}) {
  try {
    if (!eventName || typeof eventName !== 'string' || eventName.length > 40) return;
    if (RESERVED_GA_EVENTS.has(eventName) || /^(_|ga_|google_|gtag_|firebase_)/.test(eventName)) return;
    if (!isTelemetryAllowed()) return;

    const identity = await getAnalyticsIdentity();
    const locale = getUiLocale();
    const mergedParams = sanitizeAnalyticsParams({
      ...params,
      session_id: identity.sessionId,
      engagement_time_msec: (params && Number.isFinite(params.engagement_time_msec) && params.engagement_time_msec > 0)
        ? Math.round(params.engagement_time_msec)
        : 100,
      ext_version: getExtensionVersion(),
      ...(locale ? { ui_locale: locale } : {})
    });

    await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`, {
      method: 'POST',
      body: JSON.stringify({
        client_id: identity.clientId,
        events: [{
          name: eventName,
          params: mergedParams
        }]
      })
    });
  } catch (e) {
    // Telemetry errors must remain non-fatal to background operations.
  }
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
    loadPersistedDeletionState,
    isTelemetryAllowed,
    classifyErrorReason,
    sanitizeErrorDetail,
    getAnalyticsIdentity
  };
}

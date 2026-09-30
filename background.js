let cachedCsrfToken = null;
let csrfPromise = null;

async function getCsrfToken() {
  if (cachedCsrfToken) return cachedCsrfToken;
  if (csrfPromise) return csrfPromise;

  csrfPromise = (async () => {
    try {
      const response = await fetch('https://auth.roblox.com/v2/logout', {
        method: 'POST',
        headers: { 'Content-Length': '0' }
      });
      const csrfToken = response.headers.get('x-csrf-token');
      if (csrfToken) {
        cachedCsrfToken = csrfToken;
        return csrfToken;
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

async function deleteBadge(badgeId) {
  let csrfToken = cachedCsrfToken;
  if (!csrfToken) {
    csrfToken = await getCsrfToken();
  }
  
  let response = await fetch(`https://badges.roblox.com/v1/user/badges/${badgeId}`, {
    method: 'DELETE',
    headers: {
      'x-csrf-token': csrfToken
    }
  });

  if (response.status === 403 && response.headers.has('x-csrf-token')) {
    csrfToken = response.headers.get('x-csrf-token');
    cachedCsrfToken = csrfToken; 
    
    response = await fetch(`https://badges.roblox.com/v1/user/badges/${badgeId}`, {
      method: 'DELETE',
      headers: {
        'x-csrf-token': csrfToken
      }
    });
  }

  if (response.ok) {
    return { success: true };
  } else {
    let errorMsg = `HTTP Error ${response.status}`;
    try {
      const data = await response.json();
      if (data.errors && data.errors.length > 0) {
        errorMsg = data.errors[0].message;
      }
    } catch (e) {}
    return { success: false, error: errorMsg, status: response.status };
  }
}

async function getUserId() {
  const response = await fetch('https://users.roblox.com/v1/users/authenticated');
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
      let url = `https://badges.roblox.com/v1/users/${userId}/badges?limit=100&sortOrder=Desc`;
      if (cursor) url += `&cursor=${cursor}`;
      
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP Error ${response.status} fetching badges`);
      
      const data = await response.json();
      if (data.data) {
        allBadges = allBadges.concat(data.data);
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
    fetchAllBadges()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  } else if (message.action === 'start_mass_deletion') {
    sendResponse({ status: 'started' });
    runMassDeletion(message.badgesToDelete);
    return true;
  }
});

async function runMassDeletion(badgesToProcess) {
  const CONCURRENCY = 5;
  let currentIndex = 0;
  let successCount = 0;
  let failCount = 0;
  let rateLimitPauseUntil = 0;

  async function worker() {
    while (currentIndex < badgesToProcess.length) {
      const badgeId = badgesToProcess[currentIndex++];
      
      let retries = 0;
      let deleted = false;
      while (retries < 3 && !deleted) {
        const now = Date.now();
        if (now < rateLimitPauseUntil) {
          await new Promise(r => setTimeout(r, rateLimitPauseUntil - now));
        }

        try {
          const res = await deleteBadge(badgeId);
          if (res.success) {
            successCount++;
            deleted = true;
          } else if (res.status === 429) {
            rateLimitPauseUntil = Math.max(rateLimitPauseUntil, Date.now() + 3000);
            await new Promise(r => setTimeout(r, 3000));
            retries++;
          } else {
            failCount++;
            break;
          }
        } catch (e) {
          failCount++;
          break;
        }
      }
      if (!deleted && retries >= 3) failCount++;
      await new Promise(r => setTimeout(r, 100)); // slight stagger
    }
  }

  const workerCount = Math.min(CONCURRENCY, badgesToProcess.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Send Google Analytics event!
  if (successCount > 0) {
    trackAnalyticsEvent('mass_deletion_success', { count: successCount, failed: failCount });
  }
}

function trackAnalyticsEvent(eventName, params) {
  // Measurement Protocol for GA4
  // TODO: Replace with your actual Measurement ID and API Secret
  const measurement_id = 'G-XXXXXXXXXX'; 
  const api_secret = 'YOUR_API_SECRET'; 
  
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

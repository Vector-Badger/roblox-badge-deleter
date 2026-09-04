let cachedCsrfToken = null;

async function getCsrfToken() {
  try {
    const response = await fetch('https://auth.roblox.com/v2/logout', {
      method: 'POST',
      headers: {
        'Content-Length': '0'
      }
    });

    const csrfToken = response.headers.get('x-csrf-token');
    if (csrfToken) {
      cachedCsrfToken = csrfToken;
      return csrfToken;
    }
  } catch (err) {
    console.error("Network error during CSRF token fetch: ", err);
  }
  
  throw new Error("Could not extract CSRF token. Make sure you are logged in to Roblox.");
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
  }
});

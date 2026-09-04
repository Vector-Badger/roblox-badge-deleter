let allBadges = [];
let matchedBadges = []; // stores objects like { badge, selected: true }

const statusEl = document.getElementById('status');
const loadBtn = document.getElementById('loadBtn');
const stepLoad = document.getElementById('step-load');
const stepFilter = document.getElementById('step-filter');
const phraseFilter = document.getElementById('phraseFilter');
const whitelistFilter = document.getElementById('whitelistFilter');
const inventoryStats = document.getElementById('inventoryStats');
const matchCount = document.getElementById('matchCount');
const deleteBtn = document.getElementById('deleteBtn');
const badgeListContainer = document.getElementById('badgeList');

function setStatus(text, color = '#BDBEBE') {
  statusEl.textContent = text;
  statusEl.style.color = color;
}

function updateSelectionCount() {
  const selectedCount = matchedBadges.filter(b => b.selected).length;
  matchCount.textContent = `${selectedCount} selected`;
  deleteBtn.disabled = selectedCount === 0;
}

function renderBadgeList() {
  badgeListContainer.innerHTML = '';
  const displayLimit = 500;
  const toRender = matchedBadges.slice(0, displayLimit);
  
  toRender.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = 'badge-item';
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `badge-${index}`;
    checkbox.checked = item.selected;
    
    checkbox.addEventListener('change', (e) => {
      item.selected = e.target.checked;
      updateSelectionCount();
    });

    const label = document.createElement('label');
    label.htmlFor = `badge-${index}`;
    label.textContent = item.badge.name || `Badge ${item.badge.id}`;
    label.title = item.badge.name; // full name on hover

    div.appendChild(checkbox);
    div.appendChild(label);
    badgeListContainer.appendChild(div);
  });

  if (matchedBadges.length > displayLimit) {
    const overflow = document.createElement('div');
    overflow.style.color = '#BDBEBE';
    overflow.style.fontSize = '11px';
    overflow.style.textAlign = 'center';
    overflow.style.padding = '8px';
    overflow.textContent = `...and ${matchedBadges.length - displayLimit} more (Filtered out of view)`;
    badgeListContainer.appendChild(overflow);
  }

  updateSelectionCount();
}

loadBtn.addEventListener('click', () => {
  setStatus('Loading inventory... this may take a moment.');
  loadBtn.disabled = true;

  chrome.runtime.sendMessage({ action: 'fetch_all_badges' }, (response) => {
    loadBtn.disabled = false;
    
    if (chrome.runtime.lastError) {
      setStatus('Error: ' + chrome.runtime.lastError.message, '#F68888');
      return;
    }

    if (response && response.success) {
      allBadges = response.badges;
      setStatus(`Successfully loaded ${allBadges.length} badges.`, '#00B06F');
      
      stepLoad.style.display = 'none';
      stepFilter.style.display = 'flex';
      inventoryStats.textContent = `Badges loaded: ${allBadges.length}`;
      applyFilters(); // Immediately show all badges if phrase is empty
    } else {
      setStatus('Error: ' + (response ? response.error : 'Unknown error'), '#F68888');
    }
  });
});

function applyFilters() {
  const phrase = phraseFilter.value.trim().toLowerCase();
  const whitelist = whitelistFilter.value.trim().toLowerCase();
  
  const filtered = allBadges.filter(badge => {
    if (!phrase) return true;
    
    const bName = badge.name ? badge.name.toLowerCase() : '';
    const bDesc = badge.description ? badge.description.toLowerCase() : '';
    const bAwarder = (badge.awarder && badge.awarder.name) ? badge.awarder.name.toLowerCase() : '';
    
    return bName.includes(phrase) || bDesc.includes(phrase) || bAwarder.includes(phrase);
  });

  matchedBadges = filtered.map(b => {
    let isWhitelisted = false;
    if (whitelist) {
      const bName = b.name ? b.name.toLowerCase() : '';
      const bDesc = b.description ? b.description.toLowerCase() : '';
      const bAwarder = (b.awarder && b.awarder.name) ? b.awarder.name.toLowerCase() : '';
      
      if (bName.includes(whitelist) || bDesc.includes(whitelist) || bAwarder.includes(whitelist)) {
        isWhitelisted = true;
      }
    }
    return { badge: b, selected: !isWhitelisted };
  });

  renderBadgeList();
}

phraseFilter.addEventListener('input', applyFilters);
whitelistFilter.addEventListener('input', applyFilters);

const stepConfirm = document.getElementById('step-confirm');
const confirmCount = document.getElementById('confirmCount');
const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

const popOutLink = document.getElementById('popOutLink');
if (popOutLink) {
  // If we are already in a full tab, hide the pop out link
  if (window.innerWidth > 400) {
    popOutLink.style.display = 'none';
    popOutLink.previousElementSibling.style.display = 'none'; // hide the dot before it
  } else {
    popOutLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
    });
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let badgesToDeleteCache = [];

deleteBtn.addEventListener('click', () => {
  const toDelete = matchedBadges.filter(b => b.selected);
  if (toDelete.length === 0) return;

  badgesToDeleteCache = toDelete;
  confirmCount.textContent = toDelete.length;
  
  stepFilter.style.display = 'none';
  stepConfirm.style.display = 'flex';
});

cancelDeleteBtn.addEventListener('click', () => {
  badgesToDeleteCache = [];
  stepConfirm.style.display = 'none';
  stepFilter.style.display = 'flex';
  setStatus('');
});

confirmDeleteBtn.addEventListener('click', async () => {
  const toDelete = badgesToDeleteCache;
  if (toDelete.length === 0) return;

  cancelDeleteBtn.disabled = true;
  confirmDeleteBtn.disabled = true;
  
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < toDelete.length; i++) {
    const badge = toDelete[i].badge;
    setStatus(`Deleting (${i + 1}/${toDelete.length}): ${badge.name}...`, '#BDBEBE');
    
    let retries = 0;
    let deleted = false;
    
    while (retries < 3 && !deleted) {
      try {
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'delete_badge', badgeId: badge.id }, (res) => {
            resolve(res);
          });
        });

        if (response && response.success) {
          successCount++;
          deleted = true;
        } else {
          if (response && response.status === 429) {
            setStatus(`Rate limited. Waiting to retry ${badge.name}...`, '#F68888');
            await sleep(3000); // wait 3s on rate limit
            retries++;
          } else {
            failCount++;
            console.error(`Failed to delete badge ${badge.id}:`, response?.error);
            break; // don't retry on normal errors
          }
        }
      } catch (e) {
        failCount++;
        break;
      }
    }
    
    if (retries >= 3 && !deleted) failCount++;
    await sleep(400); // baseline delay increased slightly to avoid 429s in the first place
  }

  setStatus(`Deletion complete. ${successCount} deleted, ${failCount} failed. (Refresh page to see changes!)`, '#00B06F');
  
  if (window.innerWidth > 400) {
    // If running in background tab, auto-close it when done!
    await sleep(3000);
    window.close();
    return;
  }
  
  // Reset UI
  allBadges = [];
  matchedBadges = [];
  badgeListContainer.innerHTML = '';
  phraseFilter.value = '';
  whitelistFilter.value = '';
  updateSelectionCount();
  
  stepConfirm.style.display = 'none';
  stepLoad.style.display = 'flex';
  loadBtn.disabled = false;
  phraseFilter.disabled = false;
  whitelistFilter.disabled = false;
  cancelDeleteBtn.disabled = false;
  confirmDeleteBtn.disabled = false;
});

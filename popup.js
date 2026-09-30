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
  popOutLink.style.display = 'none'; // Completely hidden in v1.42
  popOutLink.previousElementSibling.style.display = 'none'; // hide the dot
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

confirmDeleteBtn.addEventListener('click', () => {
  const toDelete = badgesToDeleteCache;
  if (toDelete.length === 0) return;

  cancelDeleteBtn.disabled = true;
  confirmDeleteBtn.disabled = true;
  
  const badgeIds = toDelete.map(item => item.badge.id);

  chrome.runtime.sendMessage({ action: 'start_mass_deletion', badgesToDelete: badgeIds });

  setStatus(`Deletion started! You can safely close this popup—the process will finish automatically in the background.`, '#00B06F');
  
  // Clean up UI so they know it's handled
  badgeListContainer.innerHTML = '';
  stepConfirm.style.display = 'none';
});

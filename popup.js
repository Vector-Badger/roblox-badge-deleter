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
const stepDeleting = document.getElementById('step-deleting');
const deletionProgressBar = document.getElementById('deletionProgressBar');
const deletionCountText = document.getElementById('deletionCountText');
const deletionFailedText = document.getElementById('deletionFailedText');
const feedbackLink = document.getElementById('feedbackLink');
function localizeUI() {
  if (typeof chrome === 'undefined' || !chrome.i18n || !chrome.i18n.getMessage) return;
  try {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
      if (msg) el.textContent = msg;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n-placeholder'));
      if (msg) el.placeholder = msg;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n-title'));
      if (msg) el.title = msg;
    });
  } catch (e) {}
}

localizeUI();

let selectedCount = 0;

let reportedPopupCrash = false;

function reportPopupAnalytics(eventName, params = {}) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
      chrome.runtime.sendMessage({ action: 'track_analytics', eventName, params }, () => {
        // Read lastError to avoid unchecked runtime.lastError warnings when popup unloads.
        void (chrome.runtime && chrome.runtime.lastError);
      });
    }
  } catch (e) {}
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('error', (event) => {
    if (reportedPopupCrash) return;
    reportedPopupCrash = true;
    const msg = (event && event.message) ? event.message : 'Popup script error';
    reportPopupAnalytics('popup_js_error', {
      error_reason: 'popup_js_error',
      error_detail: msg
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (reportedPopupCrash) return;
    reportedPopupCrash = true;
    const reason = event && event.reason;
    const msg = (reason && reason.message) ? reason.message : String(reason || 'Unhandled popup rejection');
    reportPopupAnalytics('popup_js_error', {
      error_reason: 'popup_unhandled_rejection',
      error_detail: msg
    });
  });
}

function setStatus(text, color = '#BDBEBE') {
  statusEl.textContent = text;
  statusEl.style.color = color;
}

function updateSelectionCount() {
  matchCount.textContent = `${selectedCount} selected`;
  deleteBtn.disabled = selectedCount === 0;
}

function renderBadgeList() {
  badgeListContainer.innerHTML = '';
  const displayLimit = 500;
  const toRender = matchedBadges.slice(0, displayLimit);
  const fragment = document.createDocumentFragment();
  
  toRender.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = 'badge-item';
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `badge-${index}`;
    checkbox.checked = item.selected;
    
    checkbox.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      if (item.selected !== isChecked) {
        item.selected = isChecked;
        selectedCount += isChecked ? 1 : -1;
        updateSelectionCount();
      }
    });

    const label = document.createElement('label');
    label.htmlFor = `badge-${index}`;
    label.textContent = item.badge.name || `Badge ${item.badge.id}`;
    label.title = item.badge.name || ''; // full name on hover

    div.appendChild(checkbox);
    div.appendChild(label);
    fragment.appendChild(div);
  });

  if (matchedBadges.length > displayLimit) {
    const overflow = document.createElement('div');
    overflow.style.color = '#BDBEBE';
    overflow.style.fontSize = '11px';
    overflow.style.textAlign = 'center';
    overflow.style.padding = '8px';
    overflow.textContent = `...and ${matchedBadges.length - displayLimit} more (Filtered out of view)`;
    fragment.appendChild(overflow);
  }

  badgeListContainer.appendChild(fragment);
  updateSelectionCount();
}

loadBtn.addEventListener('click', () => {
  setStatus('Loading inventory... this may take a moment.');
  loadBtn.disabled = true;

  chrome.runtime.sendMessage({ action: 'fetch_all_badges' }, (response) => {
    loadBtn.disabled = false;
    
    if (chrome.runtime.lastError) {
      reportPopupAnalytics('popup_runtime_error', {
        error_reason: 'extension_runtime_error',
        error_detail: chrome.runtime.lastError.message,
        phase: 'fetch_all_badges'
      });
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

function matchesQuery(badge, query) {
  if (!query) return false;
  if (badge._searchText === undefined) {
    const bName = badge.name ? badge.name.toLowerCase() : '';
    const bDesc = badge.description ? badge.description.toLowerCase() : '';
    const bAwarder = (badge.awarder && badge.awarder.name) ? badge.awarder.name.toLowerCase() : '';
    badge._searchText = `${bName}\0${bDesc}\0${bAwarder}`;
  }
  return badge._searchText.includes(query);
}

function applyFilters() {
  const phrase = phraseFilter.value.trim().toLowerCase();
  const whitelist = whitelistFilter.value.trim().toLowerCase();
  
  selectedCount = 0;
  matchedBadges = [];

  for (let i = 0; i < allBadges.length; i++) {
    const badge = allBadges[i];
    if (phrase && !matchesQuery(badge, phrase)) continue;
    
    const isWhitelisted = whitelist ? matchesQuery(badge, whitelist) : false;
    const selected = !isWhitelisted;
    if (selected) selectedCount++;
    matchedBadges.push({ badge, selected });
  }

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

if (feedbackLink) {
  feedbackLink.addEventListener('click', (e) => {
    e.preventDefault();
    const feedbackUrl = 'https://github.com/Vector-Badger/roblox-badge-deleter/issues';
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: feedbackUrl });
    } else {
      window.open(feedbackUrl, '_blank');
    }
  });
}

let badgesToDeleteCache = [];

deleteBtn.addEventListener('click', () => {
  const toDelete = matchedBadges.filter(b => b.selected);
  if (toDelete.length === 0) return;

  badgesToDeleteCache = toDelete;
  confirmCount.textContent = toDelete.length;
  cancelDeleteBtn.disabled = false;
  confirmDeleteBtn.disabled = false;
  
  stepFilter.style.display = 'none';
  stepConfirm.style.display = 'flex';
});

cancelDeleteBtn.addEventListener('click', () => {
  reportPopupAnalytics('deletion_cancelled', { items_cancelled: badgesToDeleteCache.length });
  badgesToDeleteCache = [];
  stepConfirm.style.display = 'none';
  stepFilter.style.display = 'flex';
  setStatus('');
});

function renderCompletionStatus(deleted, failed, lastError, zeroDeleteFallback) {
  if (stepDeleting) stepDeleting.style.display = 'none';
  if (stepLoad) stepLoad.style.display = 'flex';
  if (deleted === 0 && failed > 0) {
    setStatus(`Deletion failed (${failed} failed). Error: ${lastError || zeroDeleteFallback}`, '#F68802');
    return;
  }
  const finishedHeader = (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage('finishedDeletingBadges')) || '✓ FINISHED DELETING BADGES ✓';
  const errorDetail = (failed > 0 && lastError) ? `\n(${lastError})` : '';
  setStatus(`${finishedHeader}\n${deleted} deleted, ${failed} failed. (Refresh Roblox page to see changes!)${errorDetail}`, '#00B06F');
}

function pollDeletionStatus() {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
  chrome.runtime.sendMessage({ action: 'get_deletion_status' }, (st) => {
    if (chrome.runtime.lastError || !st) return;
    if (st.isRunning || st.active) {
      if (stepLoad) stepLoad.style.display = 'none';
      if (stepFilter) stepFilter.style.display = 'none';
      if (stepConfirm) stepConfirm.style.display = 'none';
      if (stepDeleting) stepDeleting.style.display = 'flex';

      const total = st.total || 1;
      const progressPct = Math.min(100, Math.round(((st.deleted + st.failed) / total) * 100));
      if (deletionProgressBar) deletionProgressBar.style.width = `${progressPct}%`;
      if (deletionCountText) deletionCountText.textContent = `${st.deleted} / ${total} deleted (${progressPct}%)`;
      if (deletionFailedText) {
        if (st.failed > 0) {
          deletionFailedText.style.display = 'inline';
          deletionFailedText.textContent = `${st.failed} failed`;
        } else {
          deletionFailedText.style.display = 'none';
        }
      }
      setStatus(st.statusMessage || `Deleting in background... Safe to close popup!`, st.statusMessage ? '#F68802' : '#00B06F');
      setTimeout(pollDeletionStatus, 400);
    } else if (st.total > 0) {
      renderCompletionStatus(st.deleted, st.failed, st.lastError, 'Check site access permissions in chrome://extensions');
    }
  });
}

// Check if a background deletion is already running when popup opens
pollDeletionStatus();

confirmDeleteBtn.addEventListener('click', () => {
  const toDelete = badgesToDeleteCache;
  if (toDelete.length === 0) return;

  cancelDeleteBtn.disabled = true;
  confirmDeleteBtn.disabled = true;
  
  const badgeIds = toDelete.map(item => item.badge.id);

  reportPopupAnalytics('deletion_started', { total_items: badgeIds.length });
  chrome.runtime.sendMessage({ action: 'start_mass_deletion', badgesToDelete: badgeIds }, (res) => {
    if (chrome.runtime.lastError) {
      reportPopupAnalytics('popup_runtime_error', {
        error_reason: 'extension_runtime_error',
        error_detail: chrome.runtime.lastError.message,
        phase: 'start_mass_deletion'
      });
      return;
    }
    if (res && res.status === 'completed') {
      renderCompletionStatus(res.deleted, res.failed, res.lastError, 'Ensure site access is ON for *.roblox.com');
    }
  });

  badgeListContainer.innerHTML = '';
  stepConfirm.style.display = 'none';
  if (stepDeleting) stepDeleting.style.display = 'flex';
  if (deletionProgressBar) deletionProgressBar.style.width = '0%';
  if (deletionCountText) deletionCountText.textContent = `0 / ${badgeIds.length} deleted (0%)`;
  if (deletionFailedText) deletionFailedText.style.display = 'none';
  setStatus(`Deletion started! Safe to close this popup or leave it open to watch.`, '#00B06F');
  setTimeout(pollDeletionStatus, 400);
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    matchesQuery,
    applyFilters,
    getAllBadges: () => allBadges,
    setAllBadges: (b) => { allBadges = b; },
    getMatchedBadges: () => matchedBadges,
    getSelectedCount: () => selectedCount,
    setPhraseFilter: (v) => { phraseFilter.value = v; },
    setWhitelistFilter: (v) => { whitelistFilter.value = v; },
    renderBadgeList
  };
}

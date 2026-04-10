// MIT License

// Copyright (c) 2024 Kaan

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);
const DEFAULT_VOLUME = 100;
const MAX_VOLUME = 500;
const VISIBLE_SITES_LIMIT = 12;
const WHEEL_VOLUME_STEP = 5;
const STICKY_MARK_STEP = 100;
const STICKY_SNAP_TOLERANCE = 4;
const VOLUME_COMMIT_DEBOUNCE_MS = 140;
const TAB_OVERRIDES_KEY = 'tabVolumeOverrides';

document.addEventListener('DOMContentLoaded', async () => {
  const addSiteBtn = document.getElementById('addSiteBtn');
  const siteListEl = document.getElementById('siteList');

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentTabId = activeTab?.id;
  const currentOrigin = getOrigin(activeTab?.url);
  const tabSupported = Boolean(currentOrigin && Number.isInteger(currentTabId));

  let isExpanded = false;
  let isConfirmingDelete = false;
  let showInactivePresets = false;
  let addPulseTimeoutId = null;

  const applyVolumeToTab = async (tabId, volume) => {
    if (!Number.isInteger(tabId)) {
      return;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (nextVolume, maxVolume) => {
          const requestedVolume = Number(nextVolume);
          const safeVolume = Number.isFinite(requestedVolume)
            ? Math.max(0, Math.min(maxVolume, requestedVolume))
            : 100;
          const gainValue = safeVolume / 100;
          const AudioContextCtor = window.AudioContext || window.webkitAudioContext;

          const applyFallbackVolume = (media) => {
            media.volume = Math.max(0, Math.min(1, safeVolume / 100));
          };

          const ensureGainNode = (media) => {
            if (!AudioContextCtor) {
              return null;
            }

            try {
              if (!window.__svsAudioContext) {
                window.__svsAudioContext = new AudioContextCtor();
              }

              if (!window.__svsGainNodeMap) {
                window.__svsGainNodeMap = new WeakMap();
              }

              const ctx = window.__svsAudioContext;
              let nodePack = window.__svsGainNodeMap.get(media);

              if (!nodePack) {
                const sourceNode = ctx.createMediaElementSource(media);
                const gainNode = ctx.createGain();
                sourceNode.connect(gainNode);
                gainNode.connect(ctx.destination);
                nodePack = { gainNode };
                window.__svsGainNodeMap.set(media, nodePack);
              }

              nodePack.gainNode.gain.value = gainValue;
              media.volume = 1;

              if (ctx.state === 'suspended') {
                ctx.resume().catch(() => {});
              }

              return nodePack;
            } catch {
              return null;
            }
          };

          document.querySelectorAll('video, audio').forEach((media) => {
            const nodePack = ensureGainNode(media);
            if (!nodePack) {
              applyFallbackVolume(media);
            }
          });
        },
        args: [volume, MAX_VOLUME]
      });
    } catch {
      // Ignore tabs where script injection is not allowed.
    }
  };

  const applyVolumeToOriginTabs = async (origin, volume) => {
    if (!origin) {
      return;
    }

    const allTabs = await chrome.tabs.query({});
    const matchingTabs = allTabs.filter((tab) => getOrigin(tab.url) === origin);

    for (const tab of matchingTabs) {
      await applyVolumeToTab(tab.id, volume);
    }
  };

  const getSiteList = async () => {
    const data = await chrome.storage.sync.get(['siteList']);
    return data?.siteList || {};
  };

  const setSiteVolume = async (origin, volume) => {
    const clampedVolume = clampVolume(volume);
    const siteList = await getSiteList();
    siteList[origin] = clampedVolume;
    await chrome.storage.sync.set({ siteList });
  };

  const removeSiteRule = async (origin) => {
    const siteList = await getSiteList();
    delete siteList[origin];
    await chrome.storage.sync.set({ siteList });
  };

  const getTabOverrides = async () => {
    try {
      const data = await chrome.storage.session.get([TAB_OVERRIDES_KEY]);
      return data?.[TAB_OVERRIDES_KEY] || {};
    } catch {
      return {};
    }
  };

  const setTabOverrides = async (overrides) => {
    try {
      await chrome.storage.session.set({ [TAB_OVERRIDES_KEY]: overrides });
    } catch {
      // Ignore on browsers without session storage support.
    }
  };

  const setTabOverride = async (tabId, volume) => {
    if (!Number.isInteger(tabId)) {
      return;
    }

    const overrides = await getTabOverrides();
    overrides[String(tabId)] = clampVolume(volume);
    await setTabOverrides(overrides);
  };

  const clearTabOverride = async (tabId) => {
    if (!Number.isInteger(tabId)) {
      return;
    }

    const overrides = await getTabOverrides();
    delete overrides[String(tabId)];
    await setTabOverrides(overrides);
  };

  const clearOverridesForOrigin = async (origin) => {
    if (!origin) {
      return;
    }

    const tabs = await chrome.tabs.query({});
    const overrides = await getTabOverrides();

    tabs.forEach((tab) => {
      if (getOrigin(tab.url) === origin && Number.isInteger(tab.id)) {
        delete overrides[String(tab.id)];
      }
    });

    await setTabOverrides(overrides);
  };

  const pruneOverridesForClosedTabs = async (tabs) => {
    const overrides = await getTabOverrides();
    const openIds = new Set(tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => String(tab.id)));

    let changed = false;
    for (const tabId of Object.keys(overrides)) {
      if (!openIds.has(tabId)) {
        delete overrides[tabId];
        changed = true;
      }
    }

    if (changed) {
      await setTabOverrides(overrides);
    }

    return overrides;
  };

  const buildListRows = async () => {
    const siteList = await getSiteList();
    const savedOrigins = Object.keys(siteList);
    const savedSet = new Set(savedOrigins);

    const allTabs = await chrome.tabs.query({});
    const supportedTabs = allTabs.filter((tab) => getOrigin(tab.url));
    const overrides = await pruneOverridesForClosedTabs(supportedTabs);

    const rows = [];
    const usedTabIds = new Set();
    const openOrigins = new Set();

    const pushTabRow = (tab, isCurrentPriority = false) => {
      if (!Number.isInteger(tab.id) || usedTabIds.has(tab.id)) {
        return;
      }

      const origin = getOrigin(tab.url);
      if (!origin) {
        return;
      }

      usedTabIds.add(tab.id);
      openOrigins.add(origin);

      const savedVolume = savedSet.has(origin) ? clampVolume(siteList[origin]) : DEFAULT_VOLUME;
      const overrideVolume = Object.prototype.hasOwnProperty.call(overrides, String(tab.id))
        ? clampVolume(overrides[String(tab.id)])
        : null;

      rows.push({
        key: `tab:${tab.id}`,
        rowType: 'tab',
        tabId: tab.id,
        windowId: tab.windowId,
        origin,
        faviconUrl: resolveFaviconUrl(origin, tab.favIconUrl),
        title: tab.title || '',
        isAudible: Boolean(tab.audible),
        isCurrent: isCurrentPriority || tab.id === currentTabId,
        isSaved: savedSet.has(origin),
        volume: overrideVolume ?? savedVolume,
        hasOverride: overrideVolume !== null
      });
    };

    const currentTab = supportedTabs.find((tab) => tab.id === currentTabId);
    if (currentTab) {
      pushTabRow(currentTab, true);
    }

    supportedTabs
      .filter((tab) => tab.id !== currentTabId && tab.audible)
      .forEach((tab) => pushTabRow(tab));

    supportedTabs
      .filter((tab) => tab.id !== currentTabId && !tab.audible && savedSet.has(getOrigin(tab.url)))
      .forEach((tab) => pushTabRow(tab));

    savedOrigins.forEach((origin) => {
      if (!openOrigins.has(origin)) {
      rows.push({
        key: `origin:${origin}`,
        rowType: 'origin',
        tabId: null,
        windowId: null,
        origin,
        faviconUrl: resolveFaviconUrl(origin, null),
        title: '',
        isAudible: false,
        isCurrent: origin === currentOrigin,
        isSaved: true,
          volume: clampVolume(siteList[origin]),
          hasOverride: false
        });
      }
    });

    return rows;
  };

  const isInactivePresetRow = (row) => row.rowType === 'origin';

  const setRowVisualState = (rowEl, volume, isSaved) => {
    const clampedVolume = clampVolume(volume);
    const isAudibleRow = rowEl.classList.contains('site-item-audible');
    const isInactivePreset = rowEl.classList.contains('site-item-inactive-preset');
    const fillColor = isAudibleRow
      ? 'var(--slider-playing)'
      : (isInactivePreset ? 'var(--slider-unsaved)' : (isSaved ? 'var(--slider-fill)' : 'var(--slider-unsaved)'));

    const baseVolume = Math.min(clampedVolume, DEFAULT_VOLUME);
    const baseFillPercent = (baseVolume / MAX_VOLUME) * 100;
    const totalFillPercent = (clampedVolume / MAX_VOLUME) * 100;
    rowEl.style.setProperty('--fill-percent', `${baseFillPercent}%`);
    rowEl.style.setProperty('--boost-start-percent', `${baseFillPercent}%`);
    rowEl.style.setProperty('--boost-end-percent', `${totalFillPercent}%`);
    rowEl.style.setProperty('--fill-color', fillColor);
    rowEl.classList.toggle('site-item-boosted', clampedVolume > DEFAULT_VOLUME);
    rowEl.classList.toggle('site-item-unsaved', !isSaved);
    rowEl.classList.toggle('site-item-saved', isSaved);
  };

  const highlightRowByKey = (rowKey) => {
    if (!rowKey) {
      return;
    }

    const row = siteListEl.querySelector(`li[data-row-key="${cssEscape(rowKey)}"]`);
    if (!row) {
      return;
    }

    row.classList.remove('site-item-highlight');
    void row.offsetWidth;
    row.classList.add('site-item-highlight');

    if (addPulseTimeoutId) {
      clearTimeout(addPulseTimeoutId);
    }

    addPulseTimeoutId = setTimeout(() => {
      row.classList.remove('site-item-highlight');
      addPulseTimeoutId = null;
    }, 700);
  };

  const renderRow = async (row) => {
    const li = document.createElement('li');
    li.className = 'site-item site-item-slider';
    li.classList.toggle('site-item-audible', row.isAudible);
    li.classList.toggle('site-item-inactive-preset', row.rowType === 'origin');
    li.dataset.origin = row.origin;
    li.dataset.saved = row.isSaved ? '1' : '0';
    li.dataset.rowKey = row.key;
    if (Number.isInteger(row.tabId)) {
      li.dataset.tabId = String(row.tabId);
    }

    setRowVisualState(li, row.volume, row.isSaved);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'site-slider-input';
    slider.min = '0';
    slider.max = String(MAX_VOLUME);
    slider.step = '1';
    slider.value = String(row.volume);
    slider.setAttribute('aria-label', `Volume for ${safeHostname(row.origin)}`);

    const content = document.createElement('div');
    content.className = 'site-item-content';

    if (row.isAudible) {
      const liveDot = document.createElement('span');
      liveDot.className = 'audio-live-dot';
      liveDot.setAttribute('aria-label', 'Playing audio');
      content.appendChild(liveDot);
    }

    const gotoButton = document.createElement('button');
    gotoButton.type = 'button';
    gotoButton.className = 'btn btn-outline btn-small icon-btn-square goto-btn goto-btn-favicon';
    gotoButton.style.backgroundImage = `url("${row.faviconUrl}")`;
    if (row.rowType === 'tab') {
      gotoButton.setAttribute('aria-label', `Switch to open tab for ${safeHostname(row.origin)}`);
      gotoButton.setAttribute('title', 'Go to open tab');
    } else {
      gotoButton.classList.add('goto-btn-globe');
      gotoButton.setAttribute('aria-label', `Open ${safeHostname(row.origin)} in a new tab`);
      gotoButton.setAttribute('title', 'Open site in new tab');
    }

    const label = document.createElement('span');
    label.className = 'site-text';
    label.textContent = formatRowLabel(row.origin, row.title, row.rowType === 'tab');

    const volumeInput = document.createElement('input');
    volumeInput.type = 'number';
    volumeInput.min = '0';
    volumeInput.max = String(MAX_VOLUME);
    volumeInput.step = '1';
    volumeInput.value = String(row.volume);
    volumeInput.className = 'site-volume-input';
    volumeInput.setAttribute('aria-label', `Volume percent for ${safeHostname(row.origin)}`);

    const removeButton = document.createElement('button');
    removeButton.className = 'btn btn-danger btn-small icon-btn-square btn-append';
    removeButton.type = 'button';
    removeButton.setAttribute('aria-label', `Remove saved rule for ${safeHostname(row.origin)}`);
    removeButton.innerHTML = '<i class="fa-solid fa-trash fa-fw" aria-hidden="true"></i>';
    removeButton.disabled = !row.isSaved;

    let pendingCommitTimerId = null;
    let pendingVolume = row.volume;

    const runCommittedVolume = async (nextVolume) => {
      if (row.rowType === 'tab' && Number.isInteger(row.tabId)) {
        await setTabOverride(row.tabId, nextVolume);
        await applyVolumeToTab(row.tabId, nextVolume);
      } else {
        await setSiteVolume(row.origin, nextVolume);
        await applyVolumeToOriginTabs(row.origin, nextVolume);
      }

      await updateAddButtonState();
    };

    const scheduleCommitVolume = async (rawVolume, options = {}) => {
      if (rawVolume === '') {
        return;
      }

      const { immediate = false, source = 'generic' } = options;
      const currentVolume = clampVolume(slider.value);
      const nextVolume = getStickyVolume(rawVolume, currentVolume, source);
      pendingVolume = nextVolume;

      // Keep interaction silky while dragging; commit storage/script updates debounced.
      slider.value = String(nextVolume);
      volumeInput.value = String(nextVolume);
      setRowVisualState(li, nextVolume, row.isSaved);

      if (pendingCommitTimerId) {
        clearTimeout(pendingCommitTimerId);
        pendingCommitTimerId = null;
      }

      if (immediate) {
        await runCommittedVolume(pendingVolume);
        return;
      }

      pendingCommitTimerId = setTimeout(() => {
        pendingCommitTimerId = null;
        runCommittedVolume(pendingVolume);
      }, VOLUME_COMMIT_DEBOUNCE_MS);
    };

    gotoButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      try {
        if (row.rowType === 'tab' && Number.isInteger(row.tabId) && Number.isInteger(row.windowId)) {
          await chrome.tabs.update(row.tabId, { active: true });
          await chrome.windows.update(row.windowId, { focused: true });
          window.close();
          return;
        }

        const tabs = await chrome.tabs.query({});
        const matchingTabs = tabs.filter((tab) => (
          Number.isInteger(tab.id) &&
          Number.isInteger(tab.windowId) &&
          getOrigin(tab.url) === row.origin
        ));

        const targetTab = matchingTabs.find((tab) => tab.audible)
          || matchingTabs.find((tab) => tab.active)
          || matchingTabs[0]
          || null;

        if (targetTab) {
          await chrome.tabs.update(targetTab.id, { active: true });
          await chrome.windows.update(targetTab.windowId, { focused: true });
          window.close();
          return;
        }

        await chrome.tabs.create({ url: row.origin, active: true });
      } catch {
        await chrome.tabs.create({ url: row.origin, active: true });
      }
    });

    slider.addEventListener('input', async () => {
      await scheduleCommitVolume(slider.value, { source: 'slider' });
    });

    li.addEventListener('wheel', async (event) => {
      event.preventDefault();
      if (event.deltaY === 0) {
        return;
      }

      const direction = event.deltaY < 0 ? 1 : -1;
      const deltaMultiplier = Math.max(1, Math.min(6, Math.round(Math.abs(event.deltaY) / 40)));
      const step = WHEEL_VOLUME_STEP * deltaMultiplier;
      const currentVolume = clampVolume(Number(slider.value));
      const firstAlignedTarget = getFirstWheelAlignedVolume(currentVolume, direction);
      const nextVolume = currentVolume % WHEEL_VOLUME_STEP === 0
        ? clampVolume(currentVolume + (direction * step))
        : clampVolume(firstAlignedTarget);
      await scheduleCommitVolume(nextVolume, { source: 'wheel' });
    }, { passive: false });

    volumeInput.addEventListener('input', async () => {
      if (volumeInput.value === '') {
        return;
      }
      await scheduleCommitVolume(volumeInput.value, { source: 'input' });
    });

    volumeInput.addEventListener('blur', async () => {
      if (volumeInput.value === '') {
        volumeInput.value = slider.value;
      }
      await scheduleCommitVolume(volumeInput.value, { immediate: true, source: 'input' });
    });

    volumeInput.addEventListener('focus', () => {
      volumeInput.select();
    });

    volumeInput.addEventListener('click', () => {
      volumeInput.select();
    });

    volumeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        volumeInput.blur();
      }
    });

    removeButton.addEventListener('click', async () => {
      if (removeButton.disabled) {
        return;
      }

      if (pendingCommitTimerId) {
        clearTimeout(pendingCommitTimerId);
        pendingCommitTimerId = null;
      }

      await removeSiteRule(row.origin);
      await clearOverridesForOrigin(row.origin);
      await applyVolumeToOriginTabs(row.origin, DEFAULT_VOLUME);
      await displaySites();
    });

    const controls = document.createElement('div');
    controls.className = 'site-controls';

    const volumeInputWrap = document.createElement('div');
    volumeInputWrap.className = 'site-volume-wrap';
    const volumeSuffix = document.createElement('span');
    volumeSuffix.className = 'site-volume-suffix';
    volumeSuffix.textContent = '%';

    volumeInputWrap.appendChild(volumeInput);
    volumeInputWrap.appendChild(volumeSuffix);

    controls.appendChild(volumeInputWrap);
    controls.appendChild(removeButton);

    content.appendChild(gotoButton);
    content.appendChild(label);
    content.appendChild(controls);

    li.appendChild(slider);
    li.appendChild(content);

    return li;
  };

  const updateAddButtonState = async () => {
    const canUse = tabSupported && Boolean(currentOrigin);
    if (!canUse) {
      addSiteBtn.disabled = true;
      addSiteBtn.classList.add('btn-disabled-danger');
      addSiteBtn.classList.remove('btn-muted');
      return;
    }

    const siteList = await getSiteList();
    const alreadySaved = Object.prototype.hasOwnProperty.call(siteList, currentOrigin);

    addSiteBtn.disabled = false;
    addSiteBtn.classList.remove('btn-disabled-danger');
    addSiteBtn.classList.toggle('btn-muted', alreadySaved);
  };

  const displaySites = async () => {
    siteListEl.innerHTML = '';

    const rows = await buildListRows();
    const activeRows = rows.filter((row) => !isInactivePresetRow(row));
    const inactivePresetRows = rows.filter((row) => isInactivePresetRow(row));
    const displayRows = showInactivePresets ? [...activeRows, ...inactivePresetRows] : activeRows;
    const rowsToShow = isExpanded ? displayRows : displayRows.slice(0, VISIBLE_SITES_LIMIT);

    for (const row of rowsToShow) {
      const rowEl = await renderRow(row);
      siteListEl.appendChild(rowEl);
    }

    if (isExpanded && displayRows.length > 0) {
      if (!isConfirmingDelete) {
        const deleteAllButton = document.createElement('button');
        deleteAllButton.className = 'btn btn-danger btn-block';
        deleteAllButton.type = 'button';
        deleteAllButton.textContent = 'Remove All Sites';
        deleteAllButton.addEventListener('click', () => {
          isConfirmingDelete = true;
          displaySites();
        });
        siteListEl.appendChild(deleteAllButton);
      } else {
        const confirmRow = document.createElement('div');
        confirmRow.className = 'confirm-row';

        const yesButton = document.createElement('button');
        yesButton.className = 'btn btn-danger btn-block';
        yesButton.type = 'button';
        yesButton.textContent = 'Yes, Remove All';
        yesButton.addEventListener('click', async () => {
          await chrome.storage.sync.set({ siteList: {} });
          await setTabOverrides({});
          isConfirmingDelete = false;
          isExpanded = false;
          await displaySites();
        });

        const noButton = document.createElement('button');
        noButton.className = 'btn btn-secondary btn-block';
        noButton.type = 'button';
        noButton.textContent = 'No, Cancel';
        noButton.addEventListener('click', () => {
          isConfirmingDelete = false;
          displaySites();
        });

        confirmRow.appendChild(yesButton);
        confirmRow.appendChild(noButton);
        siteListEl.appendChild(confirmRow);
      }
    }

    if (displayRows.length > VISIBLE_SITES_LIMIT) {
      const toggleButton = document.createElement('button');
      toggleButton.className = 'btn btn-outline btn-block';
      toggleButton.type = 'button';
      toggleButton.textContent = isExpanded ? 'Hide' : 'Show More';
      toggleButton.addEventListener('click', () => {
        isExpanded = !isExpanded;
        isConfirmingDelete = false;
        displaySites();
      });

      siteListEl.appendChild(toggleButton);
    }

    if (inactivePresetRows.length > 0) {
      const inactiveToggleButton = document.createElement('button');
      inactiveToggleButton.className = 'btn btn-outline btn-block';
      inactiveToggleButton.type = 'button';
      inactiveToggleButton.textContent = showInactivePresets
        ? 'Hide Inactive Presets'
        : `Show Inactive Presets (${inactivePresetRows.length})`;
      inactiveToggleButton.addEventListener('click', () => {
        showInactivePresets = !showInactivePresets;
        isExpanded = false;
        isConfirmingDelete = false;
        displaySites();
      });
      siteListEl.appendChild(inactiveToggleButton);
    }

    await updateAddButtonState();
  };

  const addCurrentSiteRule = async () => {
    if (!tabSupported || !currentOrigin) {
      return;
    }

    const activeRowInput = siteListEl.querySelector(`li[data-tab-id="${currentTabId}"] .site-volume-input`)
      || siteListEl.querySelector(`li[data-origin="${cssEscape(currentOrigin)}"] .site-volume-input`);

    const volume = activeRowInput ? clampVolume(activeRowInput.value) : DEFAULT_VOLUME;

    await setSiteVolume(currentOrigin, volume);
    await applyVolumeToOriginTabs(currentOrigin, volume);
    await displaySites();
  };

  const pulseCurrentRow = () => {
    const keyByTab = Number.isInteger(currentTabId) ? `tab:${currentTabId}` : null;
    if (keyByTab) {
      highlightRowByKey(keyByTab);
      return;
    }

    if (currentOrigin) {
      highlightRowByKey(`origin:${currentOrigin}`);
    }
  };

  addSiteBtn.addEventListener('click', async () => {
    if (!tabSupported || !currentOrigin) {
      return;
    }

    const siteList = await getSiteList();
    if (Object.prototype.hasOwnProperty.call(siteList, currentOrigin)) {
      pulseCurrentRow();
      return;
    }

    await addCurrentSiteRule();
  });

  const onTabUpdated = () => {
    displaySites();
  };

  const onTabRemoved = async (tabId) => {
    await clearTabOverride(tabId);
    displaySites();
  };

  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.tabs.onRemoved.addListener(onTabRemoved);

  window.addEventListener('unload', () => {
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.onRemoved.removeListener(onTabRemoved);
  });

  await displaySites();
});

function getOrigin(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function clampVolume(rawVolume) {
  const num = Number(rawVolume);
  if (Number.isNaN(num)) {
    return DEFAULT_VOLUME;
  }
  return Math.max(0, Math.min(MAX_VOLUME, Math.round(num)));
}

function getFirstWheelAlignedVolume(currentVolume, direction) {
  if (currentVolume % WHEEL_VOLUME_STEP === 0) {
    return currentVolume;
  }

  if (direction > 0) {
    return Math.ceil(currentVolume / WHEEL_VOLUME_STEP) * WHEEL_VOLUME_STEP;
  }

  return Math.floor(currentVolume / WHEEL_VOLUME_STEP) * WHEEL_VOLUME_STEP;
}

function getStickyVolume(rawVolume, previousVolume, source) {
  const candidate = clampVolume(rawVolume);

  // Keep manual typing predictable; sticky mode is for wheel/slider interaction.
  if (source === 'input') {
    return candidate;
  }

  const nearestMark = Math.round(candidate / STICKY_MARK_STEP) * STICKY_MARK_STEP;
  const boundedMark = clampVolume(nearestMark);

  const isNearMark = Math.abs(candidate - boundedMark) <= STICKY_SNAP_TOLERANCE;
  if (isNearMark) {
    return boundedMark;
  }

  if (source === 'wheel') {
    const low = Math.min(previousVolume, candidate);
    const high = Math.max(previousVolume, candidate);
    for (let mark = STICKY_MARK_STEP; mark <= MAX_VOLUME; mark += STICKY_MARK_STEP) {
      if (low < mark && high > mark) {
        return mark;
      }
    }
  }

  return candidate;
}

function safeHostname(site) {
  try {
    return new URL(site).hostname.replace(/^www\./, '');
  } catch {
    return site;
  }
}

function formatRowLabel(origin, title, showTitle) {
  const domain = safeHostname(origin);
  if (showTitle && title && title.trim()) {
    return `${domain} - ${title.trim()}`;
  }
  return domain;
}

function resolveFaviconUrl(origin, tabFavIconUrl) {
  if (tabFavIconUrl && typeof tabFavIconUrl === 'string') {
    return tabFavIconUrl;
  }

  // High-res fallback favicon for domains without an open tab favicon URL.
  return `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(origin)}`;
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return String(value).replace(/"/g, '\\"');
}

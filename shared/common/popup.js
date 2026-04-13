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
const NORMAL_VOLUME_MAX = 100;
const VISIBLE_SITES_LIMIT = 12;
const LOW_RANGE_STEP = 5;
const HIGH_RANGE_STEP = 25;
const SLIDER_UI_MAX = 160;
const SLIDER_UI_SPLIT = 80;
const VOLUME_COMMIT_DEBOUNCE_MS = 140;
const ORIGIN_OVERRIDES_KEY = 'originVolumeOverrides';
const ORIGIN_AUDIO_METHODS_KEY = 'originAudioMethods';
const AUDIO_METHOD_STANDARD = 'standard';
const AUDIO_METHOD_NEGATIVE_GAIN = 'negative_gain';

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
  let rowMethodMenuEl = null;

  const closeRowMethodMenu = () => {
    if (rowMethodMenuEl) {
      rowMethodMenuEl.remove();
      rowMethodMenuEl = null;
    }
  };

  const openRowMethodMenu = (event, row, slider, li) => {
    event.preventDefault();
    event.stopPropagation();
    closeRowMethodMenu();

    const menu = document.createElement('div');
    menu.className = 'row-method-menu';
    menu.setAttribute('role', 'menu');

    const addOption = (label, value) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'row-method-menu-item';
      if (row.audioMethod === value) {
        btn.classList.add('is-active');
      }
      btn.textContent = label;
      btn.addEventListener('click', async () => {
        await setOriginAudioMethod(row.origin, value);
        row.audioMethod = value;
        li.dataset.audioMethod = value;
        await applyVolumeToOriginTabs(row.origin, sliderPositionToVolume(slider.value));
        closeRowMethodMenu();
      });
      menu.appendChild(btn);
    };

    addOption('Original (Default)', AUDIO_METHOD_STANDARD);
    addOption('Negative Gain Fallback', AUDIO_METHOD_NEGATIVE_GAIN);

    document.body.appendChild(menu);
    rowMethodMenuEl = menu;

    const menuRect = menu.getBoundingClientRect();
    const maxLeft = Math.max(4, window.innerWidth - menuRect.width - 4);
    const maxTop = Math.max(4, window.innerHeight - menuRect.height - 4);
    const left = Math.max(4, Math.min(event.clientX, maxLeft));
    const top = Math.max(4, Math.min(event.clientY, maxTop));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };

  const normalizeAudioMethod = (method) => (
    method === AUDIO_METHOD_NEGATIVE_GAIN ? AUDIO_METHOD_NEGATIVE_GAIN : AUDIO_METHOD_STANDARD
  );

  const getOriginAudioMethods = async () => {
    const data = await chrome.storage.sync.get([ORIGIN_AUDIO_METHODS_KEY]);
    return data?.[ORIGIN_AUDIO_METHODS_KEY] || {};
  };

  const getOriginAudioMethod = async (origin) => {
    if (!origin) {
      return AUDIO_METHOD_STANDARD;
    }
    const methods = await getOriginAudioMethods();
    return normalizeAudioMethod(methods[origin]);
  };

  const setOriginAudioMethod = async (origin, method) => {
    if (!origin) {
      return;
    }

    const methods = await getOriginAudioMethods();
    const normalized = normalizeAudioMethod(method);

    if (normalized === AUDIO_METHOD_STANDARD) {
      delete methods[origin];
    } else {
      methods[origin] = normalized;
    }

    await chrome.storage.sync.set({ [ORIGIN_AUDIO_METHODS_KEY]: methods });
  };

  const applyVolumeToTab = async (tabId, volume, audioMethod = AUDIO_METHOD_STANDARD) => {
    if (!Number.isInteger(tabId)) {
      return;
    }

    try {
      await chrome.runtime.sendMessage({
        command: 'svsRefreshTabAudio',
        tabId
      });
    } catch (error) {
      console.warn('[SVS][popup] Script injection failed', {
        tabId,
        error: String(error?.message || error),
        name: error?.name || null
      });
    }
  };

  const applyVolumeToOriginTabs = async (origin, volume) => {
    if (!origin) {
      return;
    }

    const audioMethod = await getOriginAudioMethod(origin);
    const allTabs = await chrome.tabs.query({});
    const matchingTabs = allTabs.filter((tab) => getOrigin(tab.url) === origin);

    for (const tab of matchingTabs) {
      await applyVolumeToTab(tab.id, volume, audioMethod);
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

  const getOriginOverrides = async () => {
    try {
      const data = await chrome.storage.local.get([ORIGIN_OVERRIDES_KEY]);
      return data?.[ORIGIN_OVERRIDES_KEY] || {};
    } catch {
      return {};
    }
  };

  const setOriginOverrides = async (overrides) => {
    try {
      await chrome.storage.local.set({ [ORIGIN_OVERRIDES_KEY]: overrides });
    } catch {
      // Ignore storage write failures.
    }
  };

  const setOriginOverride = async (origin, volume) => {
    if (!origin) {
      return;
    }

    const overrides = await getOriginOverrides();
    overrides[origin] = clampVolume(volume);
    await setOriginOverrides(overrides);
  };

  const clearOriginOverride = async (origin) => {
    if (!origin) {
      return;
    }

    const overrides = await getOriginOverrides();
    delete overrides[origin];
    await setOriginOverrides(overrides);
  };

  const clearOverridesForOrigin = async (origin) => {
    if (!origin) {
      return;
    }

    await clearOriginOverride(origin);
  };

  const pruneOverridesForClosedTabs = async () => {
    return getOriginOverrides();
  };

  const buildListRows = async () => {
    const siteList = await getSiteList();
    const audioMethods = await getOriginAudioMethods();
    const savedOrigins = Object.keys(siteList);
    const savedSet = new Set(savedOrigins);

    const allTabs = await chrome.tabs.query({});
    const supportedTabs = allTabs.filter((tab) => getOrigin(tab.url));
    const overrides = await pruneOverridesForClosedTabs();

    const rows = [];
    const usedTabIds = new Set();
    const tabsByOrigin = new Map();

    const pushTabRow = (tab) => {
      if (!Number.isInteger(tab.id) || usedTabIds.has(tab.id)) {
        return;
      }

      const origin = getOrigin(tab.url);
      if (!origin) {
        return;
      }

      usedTabIds.add(tab.id);

      const savedVolume = savedSet.has(origin) ? clampVolume(siteList[origin]) : DEFAULT_VOLUME;
      const overrideVolume = Object.prototype.hasOwnProperty.call(overrides, origin)
        ? clampVolume(overrides[origin])
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
        isCurrent: tab.id === currentTabId,
        isSaved: savedSet.has(origin),
        volume: overrideVolume ?? savedVolume,
        hasOverride: overrideVolume !== null,
        audioMethod: normalizeAudioMethod(audioMethods[origin])
      });
    };

    supportedTabs.forEach((tab) => {
      const origin = getOrigin(tab.url);
      if (!origin) {
        return;
      }

      if (!tabsByOrigin.has(origin)) {
        tabsByOrigin.set(origin, []);
      }
      tabsByOrigin.get(origin).push(tab);
    });

    const processOrigin = (origin, tabs) => {
      if (!tabs || tabs.length === 0) {
        return;
      }

      const audibleTabs = tabs.filter((tab) => Boolean(tab.audible));
      if (audibleTabs.length > 0) {
        const sortedAudibleTabs = [...audibleTabs].sort((a, b) => {
          if (a.id === currentTabId) {
            return -1;
          }
          if (b.id === currentTabId) {
            return 1;
          }
          return 0;
        });

        sortedAudibleTabs.forEach((tab) => pushTabRow(tab));
        return;
      }

      if (origin !== currentOrigin && !savedSet.has(origin)) {
        return;
      }

      const representativeTab = tabs.find((tab) => tab.id === currentTabId)
        || tabs.find((tab) => tab.active)
        || tabs[0];

      if (representativeTab) {
        pushTabRow(representativeTab);
      }
    };

    if (currentOrigin && tabsByOrigin.has(currentOrigin)) {
      processOrigin(currentOrigin, tabsByOrigin.get(currentOrigin));
    }

    tabsByOrigin.forEach((tabs, origin) => {
      if (origin === currentOrigin) {
        return;
      }

      if (tabs.some((tab) => Boolean(tab.audible))) {
        processOrigin(origin, tabs);
      }
    });

    tabsByOrigin.forEach((tabs, origin) => {
      if (origin === currentOrigin) {
        return;
      }

      if (!tabs.some((tab) => Boolean(tab.audible)) && savedSet.has(origin)) {
        processOrigin(origin, tabs);
      }
    });

    const openOrigins = new Set(tabsByOrigin.keys());

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
          hasOverride: false,
          audioMethod: normalizeAudioMethod(audioMethods[origin])
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

    const baseVolume = Math.min(clampedVolume, NORMAL_VOLUME_MAX);
    const baseFillPercent = (volumeToSliderPosition(baseVolume) / SLIDER_UI_MAX) * 100;
    const totalFillPercent = (volumeToSliderPosition(clampedVolume) / SLIDER_UI_MAX) * 100;
    rowEl.style.setProperty('--fill-percent', `${baseFillPercent}%`);
    rowEl.style.setProperty('--boost-start-percent', `${baseFillPercent}%`);
    rowEl.style.setProperty('--boost-end-percent', `${totalFillPercent}%`);
    rowEl.style.setProperty('--fill-color', fillColor);
    rowEl.classList.toggle('site-item-boosted', clampedVolume > NORMAL_VOLUME_MAX);
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
    li.dataset.audioMethod = row.audioMethod || AUDIO_METHOD_STANDARD;
    if (Number.isInteger(row.tabId)) {
      li.dataset.tabId = String(row.tabId);
    }

    const initialVolume = snapVolumeToStep(row.volume);
    setRowVisualState(li, initialVolume, row.isSaved);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'site-slider-input';
    slider.min = '0';
    slider.max = String(SLIDER_UI_MAX);
    slider.step = '1';
    slider.value = String(volumeToSliderPosition(initialVolume));
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
    volumeInput.value = String(initialVolume);
    volumeInput.className = 'site-volume-input';
    volumeInput.setAttribute('aria-label', `Volume percent for ${safeHostname(row.origin)}`);

    const removeButton = document.createElement('button');
    removeButton.className = 'btn btn-danger btn-small icon-btn-square btn-append';
    removeButton.type = 'button';
    removeButton.setAttribute('aria-label', `Remove saved rule for ${safeHostname(row.origin)}`);
    removeButton.innerHTML = '<i class="fa-solid fa-trash fa-fw" aria-hidden="true"></i>';
    removeButton.disabled = !row.isSaved;

    let pendingCommitTimerId = null;
    let pendingVolume = initialVolume;

    const runCommittedVolume = async (nextVolume) => {
      if (row.rowType === 'tab' && Number.isInteger(row.tabId)) {
        await setOriginOverride(row.origin, nextVolume);
        await applyVolumeToOriginTabs(row.origin, nextVolume);
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
      const candidateVolume = source === 'slider'
        ? sliderPositionToVolume(rawVolume)
        : clampVolume(rawVolume);
      const nextVolume = source === 'wheel'
        ? clampVolume(candidateVolume)
        : snapVolumeToStep(candidateVolume);
      pendingVolume = nextVolume;

      // Keep interaction silky while dragging; commit storage/script updates debounced.
      slider.value = String(volumeToSliderPosition(nextVolume));
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
      const currentVolume = clampVolume(Number(volumeInput.value));
      const nextVolume = getWheelSteppedVolume(currentVolume, direction);
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
        volumeInput.value = String(pendingVolume);
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

    li.addEventListener('contextmenu', (event) => {
      openRowMethodMenu(event, row, slider, li);
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
          await chrome.storage.sync.set({ [ORIGIN_AUDIO_METHODS_KEY]: {} });
          await setOriginOverrides({});
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
    closeRowMethodMenu();
    displaySites();
  };

  const onTabRemoved = async () => {
    closeRowMethodMenu();
    displaySites();
  };

  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.tabs.onRemoved.addListener(onTabRemoved);

  window.addEventListener('unload', () => {
    closeRowMethodMenu();
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.onRemoved.removeListener(onTabRemoved);
  });

  document.addEventListener('click', () => {
    closeRowMethodMenu();
  });

  document.addEventListener('contextmenu', (event) => {
    if (event.defaultPrevented) {
      return;
    }

    if (!rowMethodMenuEl) {
      return;
    }

    if (event.target instanceof Element && rowMethodMenuEl.contains(event.target)) {
      return;
    }

    closeRowMethodMenu();
  });

  window.addEventListener('blur', () => {
    closeRowMethodMenu();
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

function snapVolumeToStep(rawVolume) {
  const volume = clampVolume(rawVolume);
  if (volume <= NORMAL_VOLUME_MAX) {
    return clampVolume(Math.round(volume / LOW_RANGE_STEP) * LOW_RANGE_STEP);
  }

  return clampVolume(
    NORMAL_VOLUME_MAX + (Math.round((volume - NORMAL_VOLUME_MAX) / HIGH_RANGE_STEP) * HIGH_RANGE_STEP)
  );
}

function volumeToSliderPosition(rawVolume) {
  const volume = clampVolume(rawVolume);
  if (volume <= NORMAL_VOLUME_MAX) {
    return Math.round((volume / NORMAL_VOLUME_MAX) * SLIDER_UI_SPLIT);
  }

  return Math.round(
    SLIDER_UI_SPLIT + (((volume - NORMAL_VOLUME_MAX) / (MAX_VOLUME - NORMAL_VOLUME_MAX)) * SLIDER_UI_SPLIT)
  );
}

function sliderPositionToVolume(rawPosition) {
  const position = Math.max(0, Math.min(SLIDER_UI_MAX, Math.round(Number(rawPosition))));
  if (position <= SLIDER_UI_SPLIT) {
    return snapVolumeToStep((position / SLIDER_UI_SPLIT) * NORMAL_VOLUME_MAX);
  }

  return snapVolumeToStep(
    NORMAL_VOLUME_MAX + (((position - SLIDER_UI_SPLIT) / SLIDER_UI_SPLIT) * (MAX_VOLUME - NORMAL_VOLUME_MAX))
  );
}

function alignVolumeToStepForDirection(currentVolume, direction) {
  if (currentVolume <= NORMAL_VOLUME_MAX) {
    if (currentVolume % LOW_RANGE_STEP === 0) {
      return currentVolume;
    }

    return direction > 0
      ? Math.ceil(currentVolume / LOW_RANGE_STEP) * LOW_RANGE_STEP
      : Math.floor(currentVolume / LOW_RANGE_STEP) * LOW_RANGE_STEP;
  }

  const offset = currentVolume - NORMAL_VOLUME_MAX;
  if (offset % HIGH_RANGE_STEP === 0) {
    return currentVolume;
  }

  return direction > 0
    ? NORMAL_VOLUME_MAX + (Math.ceil(offset / HIGH_RANGE_STEP) * HIGH_RANGE_STEP)
    : NORMAL_VOLUME_MAX + (Math.floor(offset / HIGH_RANGE_STEP) * HIGH_RANGE_STEP);
}

function getWheelSteppedVolume(rawCurrentVolume, direction) {
  let volume = clampVolume(rawCurrentVolume);
  volume = alignVolumeToStepForDirection(volume, direction);

  const step = direction > 0
    ? (volume >= NORMAL_VOLUME_MAX ? HIGH_RANGE_STEP : LOW_RANGE_STEP)
    : (volume > NORMAL_VOLUME_MAX ? HIGH_RANGE_STEP : LOW_RANGE_STEP);
  volume = clampVolume(volume + (direction * step));

  return snapVolumeToStep(volume);
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

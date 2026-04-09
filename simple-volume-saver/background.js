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
const TAB_OVERRIDES_KEY = 'tabVolumeOverrides';

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.audible !== undefined) {
    handleTabAudio(tabId, tab);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const data = await chrome.storage.session.get([TAB_OVERRIDES_KEY]);
    const overrides = data?.[TAB_OVERRIDES_KEY] || {};
    if (Object.prototype.hasOwnProperty.call(overrides, String(tabId))) {
      delete overrides[String(tabId)];
      await chrome.storage.session.set({ [TAB_OVERRIDES_KEY]: overrides });
    }
  } catch {
    // Ignore session storage issues.
  }
});

async function handleTabAudio(tabId, tab) {
  const origin = getOrigin(tab?.url);
  if (!origin) {
    return;
  }

  let syncData;
  let sessionData;
  try {
    [syncData, sessionData] = await Promise.all([
      chrome.storage.sync.get(['siteList']),
      chrome.storage.session.get([TAB_OVERRIDES_KEY])
    ]);
  } catch {
    return;
  }

  const siteList = syncData?.siteList || {};
  const overrides = sessionData?.[TAB_OVERRIDES_KEY] || {};
  const tabOverride = overrides[String(tabId)];
  const hasSiteRule = Object.prototype.hasOwnProperty.call(siteList, origin);
  const hasTabOverride = tabOverride !== undefined;

  if (!hasTabOverride && !hasSiteRule) {
    return;
  }

  const volume = clampVolume(hasTabOverride ? tabOverride : siteList[origin]);

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (nextVolume) => {
        const normalizedVolume = Math.max(0, Math.min(100, Number(nextVolume))) / 100;

        window.__svsVolume = normalizedVolume;

        const setMediaVolume = (mediaElements) => {
          mediaElements.forEach((media) => {
            media.volume = window.__svsVolume;
          });
        };

        const applyToAllMedia = () => {
          setMediaVolume(document.querySelectorAll('video, audio'));
        };

        applyToAllMedia();

        if (window.__svsInitialized) {
          return;
        }

        window.__svsInitialized = true;

        const observer = new MutationObserver(() => {
          applyToAllMedia();
        });

        if (document.body) {
          observer.observe(document.body, {
            childList: true,
            subtree: true
          });
        }

        window.__svsObserver = observer;

        document.addEventListener('play', (event) => {
          const media = event.target;
          if (media && (media.tagName === 'VIDEO' || media.tagName === 'AUDIO')) {
            media.volume = window.__svsVolume;
          }
        }, true);

        window.addEventListener('beforeunload', () => {
          if (window.__svsObserver) {
            window.__svsObserver.disconnect();
            window.__svsObserver = null;
          }
          window.__svsInitialized = false;
        });
      },
      args: [volume]
    });
  } catch {
    // Ignore tabs where script injection is not allowed.
  }
}

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
    return 100;
  }
  return Math.max(0, Math.min(100, Math.round(num)));
}

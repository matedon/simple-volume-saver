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
const ORIGIN_OVERRIDES_KEY = 'originVolumeOverrides';
const ORIGIN_AUDIO_METHODS_KEY = 'originAudioMethods';
const AUDIO_METHOD_STANDARD = 'standard';
const AUDIO_METHOD_NEGATIVE_GAIN = 'negative_gain';
const MAX_VOLUME = 500;

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.audible !== undefined) {
    handleTabAudio(tabId, tab);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.command !== 'svsRefreshTabAudio') {
    return;
  }

  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId)) {
    sendResponse?.({ ok: false });
    return;
  }

  chrome.tabs.get(tabId).then((tab) => {
    handleTabAudio(tabId, tab).finally(() => {
      sendResponse?.({ ok: true });
    });
  }).catch(() => {
    sendResponse?.({ ok: false });
  });

  return true;
});

async function handleTabAudio(tabId, tab) {
  const origin = getOrigin(tab?.url);
  if (!origin) {
    return;
  }

  let syncData;
  let localData;
  try {
    [syncData, localData] = await Promise.all([
      chrome.storage.sync.get(['siteList', ORIGIN_AUDIO_METHODS_KEY]),
      chrome.storage.local.get([ORIGIN_OVERRIDES_KEY])
    ]);
  } catch {
    return;
  }

  const siteList = syncData?.siteList || {};
  const audioMethods = syncData?.[ORIGIN_AUDIO_METHODS_KEY] || {};
  const overrides = localData?.[ORIGIN_OVERRIDES_KEY] || {};
  const originOverride = overrides[origin];
  const audioMethod = audioMethods[origin] === AUDIO_METHOD_NEGATIVE_GAIN
    ? AUDIO_METHOD_NEGATIVE_GAIN
    : AUDIO_METHOD_STANDARD;
  const hasSiteRule = Object.prototype.hasOwnProperty.call(siteList, origin);
  const hasOriginOverride = originOverride !== undefined;

  if (!hasOriginOverride && !hasSiteRule) {
    return;
  }

  const volume = clampVolume(hasOriginOverride ? originOverride : siteList[origin]);

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (nextVolume, maxVolume, method) => {
        const LOG_PREFIX = '[SVS][bg]';
        const debug = (...args) => console.log(LOG_PREFIX, ...args);
        const warn = (...args) => console.warn(LOG_PREFIX, ...args);

        const requestedVolume = Number(nextVolume);
        const safeVolume = Number.isFinite(requestedVolume)
          ? Math.max(0, Math.min(maxVolume, requestedVolume))
          : 100;
        const normalizedMethod = method === 'negative_gain' ? 'negative_gain' : 'standard';
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        window.__svsRequestedVolume = safeVolume;
        window.__svsRequestedMethod = normalizedMethod;
        if (!window.__svsFallbackOnlyMedia) {
          window.__svsFallbackOnlyMedia = new WeakSet();
        }
        if (!window.__svsFallbackWarnedMedia) {
          window.__svsFallbackWarnedMedia = new WeakSet();
        }

        const getCurrentSettings = () => {
          const rawVolume = Number(window.__svsRequestedVolume);
          const currentSafeVolume = Number.isFinite(rawVolume)
            ? Math.max(0, Math.min(maxVolume, rawVolume))
            : safeVolume;
          const currentMethod = window.__svsRequestedMethod === 'negative_gain'
            ? 'negative_gain'
            : 'standard';
          const currentNormalizedLinearVolume = currentSafeVolume / 100;
          const currentGainValue = currentMethod === 'negative_gain' && currentSafeVolume < 100
            ? -currentNormalizedLinearVolume
            : currentNormalizedLinearVolume;

          return {
            safeVolume: currentSafeVolume,
            normalizedMethod: currentMethod,
            normalizedLinearVolume: currentNormalizedLinearVolume,
            gainValue: currentGainValue
          };
        };

        const applyMuteState = (media, settings) => {
          if (settings.normalizedLinearVolume <= 0.01) {
            media.muted = true;
            return;
          }

          if (media.muted && !media.defaultMuted) {
            media.muted = false;
          }
        };

        const applyFallbackVolume = (media) => {
          const settings = getCurrentSettings();
          applyMuteState(media, settings);
          media.volume = Math.max(0, Math.min(1, settings.normalizedLinearVolume));
        };

        const ensureGainNode = (media) => {
          if (window.__svsFallbackOnlyMedia.has(media)) {
            return null;
          }

          if (!AudioContextCtor) {
            if (!window.__svsFallbackWarnedMedia.has(media)) {
              warn('AudioContext unsupported; using fallback', {
                tag: media?.tagName,
                src: media?.currentSrc || media?.src || null
              });
              window.__svsFallbackWarnedMedia.add(media);
            }
            window.__svsFallbackOnlyMedia.add(media);
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
              debug('Created GainNode', {
                tag: media?.tagName,
                src: media?.currentSrc || media?.src || null
              });
            }

            const now = nodePack.gainNode.context.currentTime;
            try {
              nodePack.gainNode.gain.cancelScheduledValues(now);
            } catch {}
            const settings = getCurrentSettings();
            nodePack.gainNode.gain.setTargetAtTime(settings.gainValue, now, 0.05);

            applyMuteState(media, settings);
            media.volume = 1;

            if (ctx.state === 'suspended') {
              ctx.resume().catch(() => {});
            }

            return nodePack;
          } catch (error) {
            if (!window.__svsFallbackWarnedMedia.has(media)) {
              warn('GainNode hook failed; using fallback', {
                error: String(error?.message || error),
                name: error?.name || null,
                tag: media?.tagName,
                src: media?.currentSrc || media?.src || null
              });
              window.__svsFallbackWarnedMedia.add(media);
            }

            if (error?.name === 'InvalidStateError') {
              window.__svsFallbackOnlyMedia.add(media);
            }
            return null;
          }
        };

        const collectMediaFromRoot = (root, elements) => {
          if (!root || typeof root.querySelectorAll !== 'function') {
            return;
          }

          root.querySelectorAll('video, audio').forEach((media) => elements.push(media));

          root.querySelectorAll('*').forEach((el) => {
            if (el && el.shadowRoot) {
              collectMediaFromRoot(el.shadowRoot, elements);
            }
          });
        };

        const getAllMediaElements = () => {
          const elements = [];
          collectMediaFromRoot(document, elements);
          return elements;
        };

        const applyToMedia = (media) => {
          const nodePack = ensureGainNode(media);
          if (!nodePack) {
            applyFallbackVolume(media);
            debug('Applied fallback volume', {
              normalizedLinearVolume: getCurrentSettings().normalizedLinearVolume,
              mediaVolume: media?.volume,
              muted: media?.muted,
              tag: media?.tagName,
              src: media?.currentSrc || media?.src || null
            });
            return;
          }
          const settings = getCurrentSettings();
          debug('Applied GainNode volume', {
            gainValue: settings.gainValue,
            normalizedMethod: settings.normalizedMethod,
            muted: media?.muted,
            tag: media?.tagName,
            src: media?.currentSrc || media?.src || null
          });
        };

        const applyToAllMedia = () => {
          const allMedia = getAllMediaElements();
          const settings = getCurrentSettings();
          debug('Applying to media elements', {
            found: allMedia.length,
            requestedVolume: settings.safeVolume,
            safeVolume: settings.safeVolume,
            gainValue: settings.gainValue,
            normalizedMethod: settings.normalizedMethod,
            path: window.location.href
          });
          allMedia.forEach((media) => applyToMedia(media));
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
          const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
          const firstInPath = path.length > 0 ? path[0] : null;
          const media = firstInPath || event.target;
          if (media && (media.tagName === 'VIDEO' || media.tagName === 'AUDIO')) {
            applyToMedia(media);
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
      args: [volume, MAX_VOLUME, audioMethod]
    });
  } catch (error) {
    console.warn('[SVS][bg] Script injection failed', {
      tabId,
      origin,
      error: String(error?.message || error),
      name: error?.name || null
    });
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
  return Math.max(0, Math.min(MAX_VOLUME, Math.round(num)));
}

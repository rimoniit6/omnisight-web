/**
 * WorkLensAI Website Tracker — background service worker (MV3).
 *
 * Tracks the ACTIVE tab of the FOCUSED window and reports domain-only events
 * to the WorkLensAI desktop agent via Chrome Native Messaging.
 *
 * Privacy contract (enforced here, in the agent, and on the server):
 *   - Only bare lowercase DOMAINS are ever sent: `github.com`, never
 *     `https://github.com/user/repo?token=abc`.
 *   - No full URLs, paths, queries, fragments or credentials leave this file.
 *   - Incognito tabs are NEVER reported (spanning mode + explicit guard).
 *   - Internal pages (chrome://, edge://, about:, extension pages, file:…)
 *     are never reported.
 *
 * Event model: an event is emitted whenever the ACTIVE tab's domain changes —
 * tab activation, tab URL navigation (incl. SPA history-state changes), window
 * focus changes, and browser close. The desktop agent aggregates contiguous
 * same-domain events into visit slices (one activity row per visit).
 */
import { normalizeWebsiteDomain, sanitizeWebsiteTitle } from './shared/domain.js';

// ── Native messaging channel ────────────────────────────────────────────────
const HOST_NAME = 'com.worklensai.website';
const RECONNECT_DELAY_MS = 2_000;
const MAX_PENDING = 100; // bounded offline buffer — never unbounded

let port = null;
let disconnected = false;
let reconnectTimer = null;
let pending = [];

/**
 * Native messaging host bridge with reconnect + bounded offline buffering.
 * Events are only buffered when the agent host is momentarily unavailable;
 * the buffer is bounded so a dead host cannot grow memory forever.
 */
function ensurePort() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    scheduleReconnect();
    return;
  }
  port.onDisconnect.addListener(() => {
    port = null;
    // The host exited (agent not running / crashed / browser closed it).
    scheduleReconnect();
  });
  port.onMessage.addListener(() => {
    /* host replies are informational; nothing to act on */
  });
  // Deliver anything buffered while we were down.
  while (pending.length > 0) {
    const ev = pending.shift();
    sendEvent(ev);
  }
}

function scheduleReconnect() {
  if (reconnectTimer !== null || disconnected) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensurePort();
  }, RECONNECT_DELAY_MS);
}

/** Send one domain-only website event. Buffers (bounded) when the host is down. */
function sendEvent(event) {
  if (!port) {
    if (pending.length < MAX_PENDING) pending.push(event);
    ensurePort();
    return;
  }
  try {
    port.postMessage(event);
  } catch {
    if (pending.length < MAX_PENDING) pending.push(event);
  }
}

/** Flush current visit + disconnect (used at browser shutdown). */
function shutdownPort() {
  disconnected = true;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    if (port) port.disconnect();
  } catch {
    /* already closed */
  }
  port = null;
}

// ── Active-tab state ─────────────────────────────────────────────────────────
// windowId → active tabId for every window; focusedWindowId = the window the
// user is actually looking at.
const activeTabs = new Map();
let focusedWindowId = chrome.windows.WINDOW_ID_NONE;

/**
 * Emit a website event for a tab. Only the active tab of the focused window
 * is reported; everything else is treated as inactive (isActive: false lets
 * the agent CLOSE the previous visit slice instead of accumulating time the
 * employee is not looking at).
 */
function reportTab(tab) {
  if (!tab || typeof tab.id !== 'number') return;
  const isActive = tab.windowId === focusedWindowId && activeTabs.get(tab.windowId) === tab.id;
  const event = {
    type: 'website',
    domain: null,
    title: isActive ? sanitizeWebsiteTitle(tab.title) : null,
    tabId: tab.id,
    windowId: tab.windowId,
    isActive,
    timestamp: Date.now(),
  };

  // Privacy: incognito tabs are never reported, regardless of active status.
  if (tab.incognito) return;

  if (typeof tab.url === 'string') {
    event.domain = normalizeWebsiteDomain(tab.url);
  }
  // Internal / unparseable URLs → domain null → report as INACTIVE so the
  // agent closes any open visit (e.g. user switched to chrome://settings).
  if (event.domain === null) {
    if (isActive) {
      event.isActive = false;
      event.title = null;
    } else {
      return; // nothing meaningful to report for an inactive internal page
    }
  }

  sendEvent(event);
}

/** Query + report the current active tab of a window. */
function reportActiveTab(windowId) {
  const tabId = activeTabs.get(windowId);
  if (typeof tabId !== 'number') return;
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    reportTab(tab);
  });
}

/** Called when the focused window changes (incl. WINDOW_ID_NONE on minimize). */
function onFocusChanged(windowId) {
  const prev = focusedWindowId;
  focusedWindowId = windowId;

  // Focus moved AWAY from the previously active window (or browser minimized)
  // → close its visit by reporting its active tab as inactive.
  if (prev !== chrome.windows.WINDOW_ID_NONE && windowId !== prev) {
    const prevTabId = activeTabs.get(prev);
    if (typeof prevTabId === 'number') {
      chrome.tabs.get(prevTabId, (tab) => {
        if (!chrome.runtime.lastError && tab) {
          // reportTab derives isActive from the CURRENT focusedWindowId, so we
          // need an explicit inactive close event for the previous window.
          const event = {
            type: 'website',
            domain: null,
            title: null,
            tabId: prevTabId,
            windowId: prev,
            isActive: false,
            timestamp: Date.now(),
          };
          const domain = typeof tab.url === 'string' ? normalizeWebsiteDomain(tab.url) : null;
          if (domain && !tab.incognito) {
            event.domain = domain;
            sendEvent(event);
          }
        }
      });
    }
  }
  // Focused window now active → report its active tab.
  if (windowId !== chrome.windows.WINDOW_ID_NONE) reportActiveTab(windowId);
}

// ── Event wiring ─────────────────────────────────────────────────────────────

// Active tab changed (tab switch within a window).
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  activeTabs.set(windowId, tabId);
  reportActiveTab(windowId);
});

// Tab URL / title changed (includes SPA pushState when changeInfo.url fires).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (typeof changeInfo.url === 'string' || typeof changeInfo.title === 'string') {
    // Only report the CURRENT active tab of its window (avoid emitting for
    // background tabs that navigated).
    if (activeTabs.get(tab.windowId) === tabId) reportTab(tab);
  }
});

// SPA navigation: history-state updates often do NOT fire tabs.onUpdated.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return; // top frame only
  if (activeTabs.get(details.windowId) !== details.tabId) return;
  chrome.tabs.get(details.tabId, (tab) => {
    if (!chrome.runtime.lastError && tab) reportTab(tab);
  });
});

// Explicit navigation commits (belt-and-braces with onUpdated).
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (activeTabs.get(details.windowId) !== details.tabId) return;
  const domain = normalizeWebsiteDomain(details.url);
  if (domain === null) return; // internal page — handled by tab-level events
  chrome.tabs.get(details.tabId, (tab) => {
    if (!chrome.runtime.lastError && tab && !tab.incognito) {
      sendEvent({
        type: 'website',
        domain,
        title: sanitizeWebsiteTitle(tab.title),
        tabId: tab.id,
        windowId: tab.windowId,
        isActive: tab.windowId === focusedWindowId && activeTabs.get(tab.windowId) === tab.id,
        timestamp: Date.now(),
      });
    }
  });
});

// Window focus changes (focus another window, minimize → WINDOW_ID_NONE).
chrome.windows.onFocusChanged.addListener(onFocusChanged);

// Window closed → drop its active tab mapping.
chrome.windows.onRemoved.addListener((windowId) => {
  activeTabs.delete(windowId);
});

// Tab removed → close the visit (report inactive) if it was the active tab.
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  const winId = removeInfo.windowId;
  if (activeTabs.get(winId) === tabId) {
    activeTabs.delete(winId);
    const event = {
      type: 'website',
      domain: null,
      title: null,
      tabId,
      windowId: winId,
      isActive: false,
      timestamp: Date.now(),
    };
    // Report a domain-less close is meaningless to the agent; the collector
    // flushes on ANY isActive:false event, so send the current domain if we
    // can, otherwise just an inactive marker.
    if (removeInfo.isWindowClosing) {
      sendEvent({ ...event, type: 'website' });
    }
  }
});

// ── Startup ──────────────────────────────────────────────────────────────────
// Hydrate the active-tab map + focused window, then connect to the host.
async function init() {
  const windows = await chrome.windows.getAll({ populate: false });
  for (const w of windows) {
    const tabs = await chrome.tabs.query({ windowId: w.id, active: true });
    if (tabs[0]) activeTabs.set(w.id, tabs[0].id);
  }
  focusedWindowId = (await chrome.windows.getLastFocused()).id ?? chrome.windows.WINDOW_ID_NONE;
  if (focusedWindowId !== chrome.windows.WINDOW_ID_NONE) reportActiveTab(focusedWindowId);
  ensurePort();
}

// MV3 service workers are ephemeral: on (re)start we re-hydrate state and
// re-establish the native messaging channel. onInstalled/onStartup give us a
// fresh window into the browser lifecycle.
chrome.runtime.onInstalled.addListener(() => { void init(); });
chrome.runtime.onStartup.addListener(() => { void init(); });
// onSuspend → flush a close event so visits don't linger.
chrome.runtime.onSuspend.addListener(() => {
  shutdownPort();
});
void init();

/* MediaSniffer service worker.
   Listens only while a tab is in a one-shot scan window or continuous mode.
   No site-specific logic. */
importScripts("common.js");

const SCAN_WINDOW_MS = 15000;
const MAX_BODY = 200000;

const tabs = new Map();
const scanTimers = new Map();
const popupPorts = new Set();
const enriching = new Set();
const enrichTimers = new Map();
const enrichGen = new Map();

let hydratePromise = null;
let listenersOn = false;
let listenerKey = "";
let listenerError = "";
let persistTimer = 0;
let notifyTimer = 0;
let creatingOffscreen = null;
let history = [];
const dirtyTabs = new Set();
const captures = new Map();

function blankState() {
  return {
    continuous: false,
    scanned: false,
    scanUntil: 0,
    pageTitle: "",
    pageUrl: "",
    sawBlob: false,
    lastError: "",
    streams: []
  };
}

function ensureTab(tabId) {
  let state = tabs.get(tabId);
  if (!state) {
    state = blankState();
    tabs.set(tabId, state);
  }
  return state;
}

function whenReady() {
  if (!hydratePromise) hydratePromise = hydrate();
  return hydratePromise;
}

async function hydrate() {
  const stored = await chrome.storage.session.get("tabs");
  const saved = stored.tabs || {};
  let openIds = null;
  try {
    const open = await chrome.tabs.query({});
    openIds = new Set(open.map((tab) => tab.id));
  } catch {
    openIds = null;
  }
  for (const [id, value] of Object.entries(saved)) {
    const tabId = Number(id);
    if (openIds && !openIds.has(tabId)) continue;
    if (!value || typeof value !== "object") continue;
    tabs.set(tabId, {
      continuous: !!value.continuous,
      scanned: !!value.scanned,
      scanUntil: Number(value.scanUntil) || 0,
      pageTitle: value.pageTitle || "",
      pageUrl: value.pageUrl || "",
      sawBlob: !!value.sawBlob,
      lastError: "",
      streams: Array.isArray(value.streams) ? value.streams : []
    });
  }
  const now = Date.now();
  for (const [tabId, state] of tabs) {
    if (!state.continuous && state.scanUntil > now) armScanTimer(tabId, state.scanUntil);
    else if (!state.continuous) state.scanUntil = 0;
  }
  syncWebRequestListeners();
  try {
    const local = await chrome.storage.local.get("history");
    history = MS.loadHistory(local.history);
  } catch {
    history = [];
  }
}

whenReady();

function serializeTabs() {
  const obj = {};
  for (const [id, state] of tabs) obj[id] = state;
  return obj;
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    chrome.storage.session.set({ tabs: serializeTabs() }).catch(() => {});
  }, 200);
}

function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = 0;
  }
  return chrome.storage.session.set({ tabs: serializeTabs() }).catch(() => {});
}

function isCapturing(tabId) {
  const state = tabs.get(tabId);
  if (!state) return false;
  if (state.continuous) return true;
  return state.scanUntil > Date.now();
}

/* Attach webRequest only for tabs the user is scanning or watching.
   A single watched tab is filtered in the listener itself. Several watched
   tabs share one listener and the callback drops everyone else. */
function syncWebRequestListeners() {
  const plan = MS.webRequestPlan(tabs.entries(), Date.now());
  if (!plan.attach) {
    detachWebRequest();
    return;
  }
  if (listenersOn && listenerKey === plan.key) return;
  detachWebRequest();
  try {
    chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, plan.filter);
    chrome.webRequest.onCompleted.addListener(onCompleted, plan.filter, ["responseHeaders"]);
    listenersOn = true;
    listenerKey = plan.key;
    listenerError = "";
  } catch (error) {
    try { chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest); } catch { /* not attached */ }
    try { chrome.webRequest.onCompleted.removeListener(onCompleted); } catch { /* not attached */ }
    listenersOn = false;
    listenerKey = "";
    listenerError = (error && error.message) || "Couldn’t watch network requests.";
  }
}

function detachWebRequest() {
  if (!listenersOn) return;
  chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
  chrome.webRequest.onCompleted.removeListener(onCompleted);
  listenersOn = false;
  listenerKey = "";
}

function onBeforeRequest(details) {
  if (!details || details.tabId < 0 || !isCapturing(details.tabId)) {
    if (details && details.tabId >= 0) syncWebRequestListeners();
    return;
  }
  const classified = MS.classifyUrl(details.url);
  if (!classified && details.type !== "media") return;
  remember(details.tabId, {
    url: details.url,
    resourceType: details.type === "media" ? "media" : null,
    source: "network"
  });
  touch(details.tabId);
}

function onCompleted(details) {
  if (!details || details.tabId < 0 || !isCapturing(details.tabId)) {
    if (details && details.tabId >= 0) syncWebRequestListeners();
    return;
  }
  if (details.statusCode >= 400 || details.statusCode === 204) return;
  const mime = MS.headerValue(details.responseHeaders, "content-type");
  if (MS.blockedMime(mime)) {
    const state = tabs.get(details.tabId);
    const before = state ? state.streams.length : 0;
    removeStream(details.tabId, details.url);
    if (state && state.streams.length !== before) touch(details.tabId);
    return;
  }
  const classified = MS.classifyUrl(details.url);
  const mimeType = MS.typeFromMime(mime);
  if (!classified && details.type !== "media" && !mimeType) return;
  const size = MS.sizeFromHeaders(details.responseHeaders, details.statusCode);
  remember(details.tabId, {
    url: details.url,
    mime,
    size: size.size,
    sizeFromHeader: size.sizeFromHeader,
    resourceType: details.type === "media" ? "media" : null,
    source: "network"
  });
  touch(details.tabId);
}

function captureStoreKey(tabId, captureKey) {
  return `${tabId}\n${captureKey}`;
}

function clearCaptures(tabId) {
  const prefix = `${tabId}\n`;
  for (const key of [...captures.keys()]) {
    if (key.startsWith(prefix)) captures.delete(key);
  }
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

function rememberCaptured(tabId, requestUrl, track) {
  if (!track || !track.captureKey || !track.bytes) return;
  const href = MS.capturedMediaUrl(requestUrl, track.captureKey);
  if (!href) return;
  const state = ensureTab(tabId);
  const result = MS.upsertStream(state.streams, {
    url: href,
    mime: track.mime,
    size: track.bytes.byteLength,
    sizeFromHeader: true,
    duration: track.duration,
    resolution: track.resolution,
    source: "kept",
    captureKey: track.captureKey,
    label: track.label
  }, MS.MAX_STREAMS);
  if (!result.stream) return;
  const storeKey = captureStoreKey(tabId, track.captureKey);
  const prev = captures.get(storeKey);
  if (!prev || track.bytes.byteLength >= prev.byteLength) captures.set(storeKey, track.bytes);
}

function adoptKept(tabId, item) {
  const bytes = asBytes(item && item.bytes);
  if (!bytes) return false;
  const tracks = MS.parseUmp(bytes);
  if (!tracks) return false;
  for (const track of tracks) rememberCaptured(tabId, item.url, track);
  return true;
}

async function refillCaptures(tabId) {
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: "pull-kept" });
  } catch {
    return;
  }
  const items = response && Array.isArray(response.items) ? response.items : [];
  for (const item of items) adoptKept(tabId, item);
}

function removeStream(tabId, url) {
  const state = tabs.get(tabId);
  if (!state) return;
  const href = MS.absoluteHttpUrl(url);
  if (!href) return;
  const next = state.streams.filter((stream) => stream.url !== href);
  if (next.length !== state.streams.length) state.streams = next;
}

function remember(tabId, partial, body) {
  if (!isCapturing(tabId)) return;
  const state = ensureTab(tabId);
  if (partial && partial.source === "mse" && !partial.url) {
    state.sawBlob = true;
    return;
  }
  if (partial && partial.source === "mse" && partial.url) {
    const href = MS.absoluteHttpUrl(partial.url);
    const stream = href && state.streams.find((item) => item.url === href);
    if (stream && !stream.mime && partial.mime) {
      stream.mime = String(partial.mime).split(";")[0].trim().toLowerCase() || stream.mime;
    }
    return;
  }
  const result = MS.upsertStream(state.streams, partial, MS.MAX_STREAMS);
  if (!result.stream) return;
  const playlist = result.stream.type === "HLS" || result.stream.type === "DASH";
  if (!playlist) return;
  if (body && looksLikePlaylist(body)) {
    const parsed = parseBody(result.stream.type, body, result.stream.url);
    const index = state.streams.findIndex((stream) => stream.url === result.stream.url);
    if (index !== -1) state.streams[index] = MS.applyPlaylist(state.streams[index], parsed);
    return;
  }
  const current = state.streams.find((stream) => stream.url === result.stream.url);
  if (current && !current.parsed && !current.enrichFailed) queueEnrich(tabId, current.url);
}

function looksLikePlaylist(body) {
  const text = String(body || "");
  return text.includes("#EXTM3U") || text.includes("<MPD") || text.includes("<mpd");
}

function parseBody(type, body, url) {
  const text = String(body || "");
  if (text.includes("#EXTM3U") && !text.includes("<MPD")) return MS.parseHls(text, url);
  if (text.includes("<MPD") || text.includes("<mpd")) return MS.parseDash(text, url);
  return type === "DASH" ? MS.parseDash(text, url) : MS.parseHls(text, url);
}

function bumpEnrich(tabId) {
  enrichGen.set(tabId, (enrichGen.get(tabId) || 0) + 1);
  const prefix = `${tabId}\n`;
  for (const key of [...enrichTimers.keys()]) {
    if (!key.startsWith(prefix)) continue;
    clearTimeout(enrichTimers.get(key));
    enrichTimers.delete(key);
  }
  for (const key of [...enriching.keys()]) {
    if (key.startsWith(prefix)) enriching.delete(key);
  }
}

function queueEnrich(tabId, url) {
  const key = `${tabId}\n${url}`;
  if (enriching.has(key) || enrichTimers.has(key)) return;
  const gen = enrichGen.get(tabId) || 0;
  const timer = setTimeout(() => {
    enrichTimers.delete(key);
    if ((enrichGen.get(tabId) || 0) !== gen) return;
    const state = tabs.get(tabId);
    const stream = state && state.streams.find((item) => item.url === url);
    if (!stream || stream.parsed || stream.enrichFailed || !isCapturing(tabId)) return;
    enriching.add(key);
    enrichManifest(tabId, url, gen).finally(() => enriching.delete(key));
  }, 450);
  enrichTimers.set(key, timer);
}

async function enrichManifest(tabId, url, gen) {
  try {
    const response = await fetch(url, { credentials: "include", referrerPolicy: "no-referrer" });
    if ((enrichGen.get(tabId) || 0) !== gen) return;
    if (!response.ok) throw new Error(String(response.status));
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 2000000) throw new Error("large");
    const mime = response.headers.get("content-type") || "";
    if (MS.blockedMime(mime)) throw new Error("not-media");
    const text = (await response.text()).slice(0, MAX_BODY);
    if (!looksLikePlaylist(text)) throw new Error("not-playlist");
    const parsed = parseBody(text.includes("<MPD") ? "DASH" : "HLS", text, url);
    const state = tabs.get(tabId);
    const index = state ? state.streams.findIndex((stream) => stream.url === url) : -1;
    if (!state || index === -1 || state.streams[index].parsed) return;
    if ((enrichGen.get(tabId) || 0) !== gen) return;
    state.streams[index] = MS.applyPlaylist(state.streams[index], parsed);
    touch(tabId);
  } catch {
    if ((enrichGen.get(tabId) || 0) !== gen) return;
    const state = tabs.get(tabId);
    const stream = state && state.streams.find((item) => item.url === url);
    if (stream && !stream.parsed) stream.enrichFailed = true;
  }
}

function applyFrames(tabId, frames) {
  const state = ensureTab(tabId);
  for (const frame of frames || []) {
    const data = frame && frame.result;
    if (!data) continue;
    if (data.top) {
      if (data.pageTitle) state.pageTitle = String(data.pageTitle).slice(0, 180);
      if (data.pageUrl && MS.isCapturableUrl(data.pageUrl)) state.pageUrl = data.pageUrl;
    }
    if (data.sawBlob) state.sawBlob = true;
    const items = Array.isArray(data.streams) ? data.streams.slice(0, 100) : [];
    for (const item of items) remember(tabId, item, "");
  }
}

async function injectFiles(tabId, world, files) {
  const attempts = [
    { tabId, allFrames: true },
    { tabId }
  ];
  let lastError = null;
  for (const target of attempts) {
    try {
      await chrome.scripting.executeScript({ target, world, files });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("inject failed");
}

async function injectAll(tabId) {
  await injectFiles(tabId, undefined, ["common.js", "content.js"]);
  try {
    await injectFiles(tabId, "MAIN", ["injected.js"]);
  } catch {
    /* Network and DOM detection still work without the page-world hook. */
  }
}

async function collectFromTab(tabId, continuous, until) {
  const func = (isContinuous, hookUntil) => {
    let result = null;
    try {
      if (typeof globalThis.__mediaSnifferActivate === "function") {
        result = globalThis.__mediaSnifferActivate(isContinuous, hookUntil);
      }
    } catch (error) {
      result = { streams: [], sawBlob: false, error: String(error && error.message || error) };
    }
    try {
      const api = globalThis.MS;
      const extra = api && typeof api.mediaUrlsInDocument === "function" ? api.mediaUrlsInDocument() : [];
      if (extra.length) {
        if (!result) result = { streams: [], sawBlob: false, top: window === window.top };
        const streams = Array.isArray(result.streams) ? result.streams : [];
        const head = extra.map((url) => ({ url, source: "dom" }));
        result.streams = head.concat(streams).slice(0, 100);
      }
    } catch {
      /* Keep the streams the page hook already returned. */
    }
    return result;
  };
  try {
    return await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func,
      args: [!!continuous, until || 0]
    });
  } catch {
    return chrome.scripting.executeScript({
      target: { tabId },
      func,
      args: [!!continuous, until || 0]
    });
  }
}

function scanErrorMessage(error) {
  const text = (error && error.message) || String(error || "");
  if (/cannot be scripted|cannot access|chrome:\/\//i.test(text)) {
    return "This browser page can’t be scanned.";
  }
  if (/file url/i.test(text)) {
    return "Allow access to file URLs for this extension, then try again.";
  }
  return "Couldn’t scan this tab. Reload the page and try again.";
}

function resetPlaylists(state) {
  for (const stream of state.streams) {
    if (stream.type !== "HLS" && stream.type !== "DASH") continue;
    stream.parsed = false;
    stream.enrichFailed = false;
  }
}

async function startScan(tabId) {
  const tab = await getTab(tabId);
  if (!tab || !MS.isCapturableUrl(tab.url || "")) {
    return viewState(tabId, tab, "This browser page can’t be scanned.");
  }
  const state = ensureTab(tabId);
  state.scanned = true;
  state.lastError = "";
  state.sawBlob = false;
  state.pageUrl = tab.url || state.pageUrl;
  if (tab.title) state.pageTitle = tab.title;
  if (state.continuous) {
    clearScanTimer(tabId);
    state.scanUntil = 0;
  } else {
    state.scanUntil = Date.now() + SCAN_WINDOW_MS;
  }
  bumpEnrich(tabId);
  resetPlaylists(state);
  syncWebRequestListeners();
  if (!state.continuous) armScanTimer(tabId, state.scanUntil);
  try {
    await injectAll(tabId);
    const frames = await collectFromTab(tabId, state.continuous, state.scanUntil);
    applyFrames(tabId, frames);
    const ran = (frames || []).some((frame) => frame && frame.result);
    if (!ran) state.lastError = "Couldn’t scan this tab. Reload the page and try again.";
  } catch (error) {
    state.lastError = scanErrorMessage(error);
  }
  await persistNow();
  notifyNow(tabId);
  return viewState(tabId, tab);
}

async function setContinuous(tabId, enabled) {
  const tab = await getTab(tabId);
  if (!tab || !MS.isCapturableUrl(tab.url || "")) {
    return viewState(tabId, tab, "This browser page can’t be scanned.");
  }
  const state = ensureTab(tabId);
  state.pageUrl = tab.url || state.pageUrl;
  if (tab.title) state.pageTitle = tab.title;
  state.continuous = !!enabled;
  state.lastError = "";
  if (enabled) {
    state.scanned = true;
    clearScanTimer(tabId);
    state.scanUntil = 0;
    syncWebRequestListeners();
    try {
      await injectAll(tabId);
      const frames = await collectFromTab(tabId, true, 0);
      applyFrames(tabId, frames);
    } catch (error) {
      state.lastError = scanErrorMessage(error);
    }
  } else {
    clearScanTimer(tabId);
    state.scanUntil = 0;
    syncWebRequestListeners();
    chrome.tabs.sendMessage(tabId, { type: "deactivate" }).catch(() => {});
  }
  await persistNow();
  notifyNow(tabId);
  return viewState(tabId, tab);
}

function clearScanTimer(tabId) {
  const timer = scanTimers.get(tabId);
  if (timer) clearTimeout(timer);
  scanTimers.delete(tabId);
}

function armScanTimer(tabId, until) {
  clearScanTimer(tabId);
  const delay = Math.max(0, until - Date.now());
  const timer = setTimeout(() => {
    scanTimers.delete(tabId);
    const state = tabs.get(tabId);
    if (!state || state.continuous) {
      syncWebRequestListeners();
      return;
    }
    if (state.scanUntil > Date.now()) {
      armScanTimer(tabId, state.scanUntil);
      return;
    }
    syncWebRequestListeners();
    chrome.tabs.sendMessage(tabId, { type: "deactivate" }).catch(() => {});
    notifyNow(tabId);
  }, delay);
  scanTimers.set(tabId, timer);
}

function findKnown(state, url) {
  if (!state) return null;
  const href = MS.absoluteHttpUrl(url);
  if (!href) return null;
  for (const stream of state.streams) {
    if (stream.url === href) return stream;
    for (const variant of stream.variants || []) {
      if (variant.url === href) return { url: variant.url, type: variant.type || stream.type || "Media" };
    }
  }
  return null;
}

function revokeBlob(url) {
  if (typeof url !== "string" || !url.startsWith("blob:")) return;
  chrome.runtime.sendMessage({ target: "offscreen", type: "revoke-blob", url }).catch(() => {});
}

function watchBlob(downloadId, url) {
  const done = (delta) => {
    if (!delta || delta.id !== downloadId || !delta.state) return;
    const state = delta.state.current;
    if (state !== "complete" && state !== "interrupted") return;
    chrome.downloads.onChanged.removeListener(done);
    revokeBlob(url);
  };
  chrome.downloads.onChanged.addListener(done);
}

async function saveBlob(url, filename) {
  if (typeof url !== "string" || !url.startsWith("blob:")) throw new Error("Download failed.");
  const base = MS.sanitizeFilename(typeof filename === "string" ? filename : "");
  const named = /\.(mp4|m4a|webm|mkv|mov|mp3|aac)$/i.test(base) ? base : "";
  const options = {
    url,
    filename: `MediaSniffer/${named || MS.sanitizeFilename(`video_${Date.now()}.mp4`)}`,
    conflictAction: "uniquify",
    saveAs: false
  };
  let downloadId;
  try {
    downloadId = await chrome.downloads.download(options);
  } catch {
    options.filename = `MediaSniffer/${MS.sanitizeFilename(`video_${Date.now()}.mp4`)}`;
    downloadId = await chrome.downloads.download(options);
  }
  watchBlob(downloadId, url);
}

async function saveJoinedFiles(result) {
  const files = Array.isArray(result.files) ? result.files : [];
  if (!files.length) return { ok: false, error: "Couldn’t join the fragments." };
  const started = new Set();
  try {
    for (const file of files) {
      await saveBlob(file && file.url, file && file.filename);
      if (file && file.url) started.add(file.url);
    }
  } catch (error) {
    for (const file of files) {
      if (file && file.url && !started.has(file.url)) revokeBlob(file.url);
    }
    return { ok: false, error: (error && error.message) || "Download failed." };
  }
  return { ok: true, count: result.count || files.length, warning: result.warning || "" };
}

function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Join media fragments into one playable file and start the download."
      });
    } catch (error) {
      if (!(await chrome.offscreen.hasDocument())) throw error;
    }
  })().finally(() => {
    creatingOffscreen = null;
  });
  return creatingOffscreen;
}

function persistHistory() {
  chrome.storage.local.set({ history }).catch(() => {});
}

function recordHistory(entry) {
  history = MS.rememberHistory(history, entry);
  persistHistory();
}

async function runOffscreen(message) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await ensureOffscreen();
      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "assemble-run",
        ...message
      });
      if (result && result.ok) return await saveJoinedFiles(result);
      if (result) return result;
      lastError = new Error("Couldn’t join the fragments.");
    } catch (error) {
      lastError = error;
      creatingOffscreen = null;
    }
  }
  return { ok: false, error: (lastError && lastError.message) || "Couldn’t join the fragments." };
}

async function downloadStored(url, filename) {
  const href = MS.absoluteHttpUrl(url);
  if (!href) return { ok: false, error: "That download is no longer in the history." };
  const base = MS.sanitizeFilename(typeof filename === "string" ? filename : "");
  const saveName = base || MS.suggestFilename({ url: href, type: "Media" }, "");
  const options = {
    url: href,
    filename: `MediaSniffer/${saveName}`,
    conflictAction: "uniquify",
    saveAs: false
  };
  try {
    const downloadId = await chrome.downloads.download(options);
    return { ok: true, downloadId };
  } catch (error) {
    return { ok: false, error: (error && error.message) || "Download failed." };
  }
}

function relayAssembleProgress(msg) {
  if (!msg || typeof msg.tabId !== "number") return;
  for (const port of popupPorts) {
    if (port.tabId !== msg.tabId) continue;
    try {
      port.postMessage({
        type: "assemble-progress",
        tabId: msg.tabId,
        text: msg.text || "",
        done: msg.done,
        total: msg.total
      });
    } catch {
      /* Popup closed. */
    }
  }
}

async function assembleUrls(tabId, urls, filename) {
  await whenReady();
  if (typeof tabId !== "number") return { ok: false, error: "Scan this tab first." };
  const state = tabs.get(tabId);
  if (!state) return { ok: false, error: "Scan this tab first." };
  const allowed = new Set();
  for (const stream of state.streams || []) {
    if (stream && stream.url) allowed.add(stream.url);
  }
  const requested = [];
  const seen = new Set();
  for (const url of Array.isArray(urls) ? urls : []) {
    const href = MS.absoluteHttpUrl(url);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    if (!allowed.has(href)) {
      return { ok: false, error: "Those fragments are no longer in the list. Scan again and retry." };
    }
    requested.push(href);
  }
  if (!requested.length) {
    return { ok: false, error: "Those fragments are no longer in the list. Scan again and retry." };
  }
  if (requested.length > 400) return { ok: false, error: "Too many fragments to join at once." };
  const safeName = MS.sanitizeFilename(typeof filename === "string" ? filename : "");
  const output = safeName && /\.mp4$/i.test(safeName) ? safeName : MS.assembledFilename(state.pageTitle, 0, 1);
  if (!MS.fragmentsHaveInit(requested)) {
    const embedded = await embeddedMediaUrls(tabId);
    for (const url of embedded) MS.upsertStream(state.streams, { url, source: "dom" }, MS.MAX_STREAMS);
    if (embedded.length) touch(tabId);
    const recovery = MS.recoveryForCluster(state.streams, requested);
    if (recovery && recovery.kind === "file") return downloadUrl(tabId, recovery.url, output);
    if (recovery && recovery.kind === "playlist") {
      return assemblePlaylist(tabId, recovery.url, recovery.audioUrl || "", output);
    }
  }
  const saved = await runOffscreen({ urls: requested, filename: output, tabId });
  if (saved && saved.ok) {
    recordHistory({
      mode: "fragments",
      urls: requested,
      filename: output,
      pageTitle: state.pageTitle || ""
    });
  }
  return saved;
}

async function assemblePlaylist(tabId, url, audioUrl, filename) {
  await whenReady();
  if (typeof tabId !== "number") return { ok: false, error: "Scan this tab first." };
  const state = tabs.get(tabId);
  if (!state) return { ok: false, error: "Scan this tab first." };
  const known = findKnown(state, url);
  if (!known || (known.type !== "HLS" && known.type !== "Audio")) {
    return { ok: false, error: "That playlist is no longer in the list. Scan again and retry." };
  }
  const linked = MS.matchingAudioPlaylist(state.streams, known.url);
  const audio = MS.absoluteHttpUrl(audioUrl) || linked || "";
  if (audio && !findKnown(state, audio)) {
    return { ok: false, error: "That playlist is no longer in the list. Scan again and retry." };
  }
  const safeName = MS.sanitizeFilename(typeof filename === "string" ? filename : "");
  const output = safeName && /\.mp4$/i.test(safeName) ? safeName : MS.assembledFilename(state.pageTitle, 0, 1);
  const saved = await runOffscreen({
    playlist: known.url,
    audioUrl: audio,
    filename: output,
    tabId
  });
  if (saved && saved.ok) {
    recordHistory({
      mode: "playlist",
      url: known.url,
      audioUrl: audio,
      filename: output,
      pageTitle: state.pageTitle || ""
    });
  }
  return saved;
}

async function embeddedMediaUrls(tabId) {
  try {
    await injectFiles(tabId, undefined, ["common.js"]);
  } catch {
    return [];
  }
  let frames = [];
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const api = globalThis.MS;
        return api && typeof api.mediaUrlsInDocument === "function" ? api.mediaUrlsInDocument() : [];
      }
    });
  } catch {
    try {
      frames = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const api = globalThis.MS;
          return api && typeof api.mediaUrlsInDocument === "function" ? api.mediaUrlsInDocument() : [];
        }
      });
    } catch {
      return [];
    }
  }
  const urls = [];
  const seen = new Set();
  for (const frame of frames || []) {
    const list = frame && frame.result;
    if (!Array.isArray(list)) continue;
    for (const url of list) {
      const href = MS.absoluteHttpUrl(url);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      urls.push(href);
    }
  }
  return urls;
}

async function downloadCapture(tabId, stream, filename) {
  const state = tabs.get(tabId);
  const storeKey = captureStoreKey(tabId, stream.captureKey);
  let bytes = captures.get(storeKey);
  if (!bytes) {
    await refillCaptures(tabId);
    bytes = captures.get(storeKey);
  }
  if (!bytes || !bytes.byteLength) {
    return { ok: false, error: "This capture expired. Play the video and scan again." };
  }
  const preferred = MS.sanitizeFilename(typeof filename === "string" ? filename : "");
  const named = preferred && /\.(mp4|m4a|webm|mkv|mov|mp3|aac)$/i.test(preferred) ? preferred : "";
  const saveName = named || MS.suggestFilename(stream, state && state.pageTitle);
  const saved = await runOffscreen({
    bytes,
    filename: saveName,
    mime: stream.mime || "application/octet-stream",
    tabId
  });
  if (saved && saved.ok) {
    recordHistory({
      mode: "capture",
      filename: saveName,
      pageTitle: (state && state.pageTitle) || ""
    });
  }
  return saved || { ok: false, error: "Download failed." };
}

async function downloadUrl(tabId, url, filename) {
  await whenReady();
  const state = tabs.get(tabId);
  const known = findKnown(state, url);
  if (!known) return { ok: false, error: "That stream is no longer in the list. Scan again and retry." };
  if (known.captureKey) return downloadCapture(tabId, known, filename);
  const preferred = MS.sanitizeFilename(typeof filename === "string" ? filename : "");
  const named = preferred && /\.(mp4|webm|mkv|mov|m4a|mp3)$/i.test(preferred) ? preferred : "";
  const saveName = named || MS.suggestFilename(
    { url: known.url, type: known.type || "Media" },
    state && state.pageTitle
  );
  const options = {
    url: known.url,
    filename: `MediaSniffer/${saveName}`,
    conflictAction: "uniquify",
    saveAs: false
  };
  try {
    const downloadId = await chrome.downloads.download(options);
    recordHistory({
      mode: "file",
      url: known.url,
      filename: saveName,
      pageTitle: (state && state.pageTitle) || ""
    });
    return { ok: true, downloadId };
  } catch {
    try {
      const ext = MS.TYPE_EXT[known.type] || "bin";
      const fallback = MS.sanitizeFilename(`media_${Date.now()}.${ext}`);
      options.filename = `MediaSniffer/${fallback}`;
      const downloadId = await chrome.downloads.download(options);
      recordHistory({
        mode: "file",
        url: known.url,
        filename: fallback,
        pageTitle: (state && state.pageTitle) || ""
      });
      return { ok: true, downloadId };
    } catch (error) {
      return { ok: false, error: (error && error.message) || "Download failed." };
    }
  }
}

async function redownload(id, tabId) {
  await whenReady();
  const item = history.find((row) => row.id === id);
  if (!item) return { ok: false, error: "That download is no longer in the history." };
  let saved;
  if (item.mode === "capture") {
    return { ok: false, error: "This file was captured from the player. Scan the tab again to save it." };
  }
  if (item.mode === "file") saved = await downloadStored(item.url, item.filename);
  else if (item.mode === "playlist") {
    saved = await runOffscreen({
      playlist: item.url,
      audioUrl: item.audioUrl || "",
      filename: item.filename,
      tabId
    });
  } else {
    saved = await runOffscreen({ urls: item.urls, filename: item.filename, tabId });
  }
  if (saved && saved.ok) recordHistory({ ...item, at: Date.now() });
  return saved || { ok: false, error: "Download failed." };
}

function viewState(tabId, tab, error) {
  const state = tabs.get(tabId) || blankState();
  const pageUrl = (tab && tab.url) || state.pageUrl || "";
  const unsupported = pageUrl ? !MS.isCapturableUrl(pageUrl) : false;
  return {
    tabId,
    unsupported,
    continuous: !!state.continuous && !unsupported,
    scanned: !!state.scanned,
    scanning: !state.continuous && state.scanUntil > Date.now(),
    pageTitle: state.pageTitle || (tab && tab.title) || "",
    pageUrl,
    sawBlob: !!state.sawBlob,
    error: error || state.lastError || (unsupported ? "This browser page can’t be scanned." : listenerError),
    streams: MS.sorted(state.streams || [])
  };
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function updateBadge(tabId, state) {
  if (!state) {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    return;
  }
  const count = MS.presentMedia(state.streams).count;
  chrome.action.setBadgeText({ tabId, text: count ? String(Math.min(count, 999)) : "" }).catch(() => {});
  if (!count) return;
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" }).catch(() => {});
  if (chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" }).catch(() => {});
  }
}

function notifyNow(tabId) {
  const state = tabs.get(tabId);
  updateBadge(tabId, state);
  const view = viewState(tabId, null);
  for (const port of popupPorts) {
    if (port.tabId !== tabId) continue;
    try {
      port.postMessage({ type: "state", state: view });
    } catch {
      /* Popup closed. */
    }
  }
}

function touch(tabId, immediate) {
  if (immediate) {
    dirtyTabs.delete(tabId);
    notifyNow(tabId);
    persistNow();
    return;
  }
  dirtyTabs.add(tabId);
  if (!notifyTimer) {
    notifyTimer = setTimeout(() => {
      notifyTimer = 0;
      const ids = [...dirtyTabs];
      dirtyTabs.clear();
      for (const id of ids) notifyNow(id);
    }, 120);
  }
  persistSoon();
}

function sameDocument(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = "";
    right.hash = "";
    return left.href === right.href;
  } catch {
    return a === b;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  popupPorts.add(port);
  port.onDisconnect.addListener(() => popupPorts.delete(port));
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "bind" || typeof msg.tabId !== "number") return;
    port.tabId = msg.tabId;
    whenReady().then(async () => {
      const tab = await getTab(msg.tabId);
      try {
        port.postMessage({ type: "state", state: viewState(msg.tabId, tab) });
      } catch {
        /* Popup closed. */
      }
    });
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: (error && error.message) || "Request failed." });
  });
  return true;
});

async function handleMessage(msg, sender) {
  await whenReady();
  if (!msg || typeof msg !== "object") return { ok: false };
  if (msg.type === "ping") return { ok: true };
  if (msg.type === "media-batch") return onMediaBatch(msg, sender);
  if (msg.type === "get-state") return viewState(msg.tabId, await getTab(msg.tabId));
  if (msg.type === "scan") return startScan(msg.tabId);
  if (msg.type === "set-continuous") return setContinuous(msg.tabId, !!msg.enabled);
  if (msg.type === "download") return downloadUrl(msg.tabId, msg.url, msg.filename);
  if (msg.type === "get-history") {
    await whenReady();
    return { ok: true, items: history };
  }
  if (msg.type === "redownload") return redownload(msg.id, msg.tabId);
  if (msg.type === "assemble-progress") {
    if (!sender || !sender.tab) relayAssembleProgress(msg);
    return { ok: true };
  }
  if (msg.type === "assemble") {
    if (sender && sender.tab && sender.tab.id !== msg.tabId) {
      return { ok: false, error: "Scan this tab first." };
    }
    return assembleUrls(msg.tabId, msg.urls, msg.filename);
  }
  if (msg.type === "assemble-playlist") {
    if (sender && sender.tab && sender.tab.id !== msg.tabId) {
      return { ok: false, error: "Scan this tab first." };
    }
    return assemblePlaylist(msg.tabId, msg.url, msg.audioUrl, msg.filename);
  }
  return { ok: false };
}

function onMediaBatch(msg, sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId !== "number" || !isCapturing(tabId)) return { ok: false, ignored: true };
  const state = ensureTab(tabId);
  if (msg.sawBlob) state.sawBlob = true;
  if (msg.top) {
    if (msg.pageTitle) state.pageTitle = String(msg.pageTitle).slice(0, 180);
    if (msg.pageUrl && MS.isCapturableUrl(msg.pageUrl)) state.pageUrl = msg.pageUrl;
  }
  const items = Array.isArray(msg.streams) ? msg.streams.slice(0, 80) : [];
  for (const item of items) {
    if (item && item.bytes) {
      adoptKept(tabId, item);
      continue;
    }
    const body = typeof item.body === "string" ? item.body.slice(0, MAX_BODY) : "";
    remember(tabId, item, body);
  }
  touch(tabId);
  return { ok: true };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  whenReady().then(() => {
    tabs.delete(tabId);
    clearCaptures(tabId);
    clearScanTimer(tabId);
    for (const key of enrichTimers.keys()) {
      if (key.startsWith(`${tabId}\n`)) {
        clearTimeout(enrichTimers.get(key));
        enrichTimers.delete(key);
      }
    }
    syncWebRequestListeners();
    updateBadge(tabId, null);
    persistSoon();
  });
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  whenReady().then(async () => {
    const state = tabs.get(tabId);
    if (!state) return;
    if (info.url && state.pageUrl && !sameDocument(state.pageUrl, info.url)) {
      state.streams = [];
      clearCaptures(tabId);
      state.sawBlob = false;
      state.lastError = "";
      state.pageTitle = "";
      state.pageUrl = info.url;
      bumpEnrich(tabId);
      state.scanned = !!state.continuous;
      if (!state.continuous) {
        state.scanUntil = 0;
        clearScanTimer(tabId);
      }
      syncWebRequestListeners();
      updateBadge(tabId, state);
      touch(tabId, true);
    } else if (info.url && !state.pageUrl) {
      state.pageUrl = info.url;
    }
    if (info.status === "complete" && state.continuous && MS.isCapturableUrl(state.pageUrl)) {
      try {
        await injectAll(tabId);
        const frames = await collectFromTab(tabId, true, 0);
        applyFrames(tabId, frames);
        touch(tabId, true);
      } catch {
        /* The next manual scan can retry. */
      }
    }
  });
});

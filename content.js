/* DOM scanner. Idle until the service worker asks this tab to scan.
   Also forwards page-world hook reports while a scan or watch is active. */
(function () {
  "use strict";

  if (globalThis.__mediaSnifferCS) return;
  if (!globalThis.MS) return;
  globalThis.__mediaSnifferCS = true;

  const MS = globalThis.MS;
  let continuous = false;
  let acceptReports = false;
  let acceptUntil = 0;
  let acceptTimer = 0;
  let scanTimer = 0;
  let domEventsOn = false;
  let observedRoots = new WeakSet();
  const observers = [];
  let queue = [];
  let sawBlobQueued = false;
  let queueTimer = 0;

  function controlHook(active, until) {
    acceptReports = !!active;
    acceptUntil = until || 0;
    if (acceptTimer) {
      clearTimeout(acceptTimer);
      acceptTimer = 0;
    }
    if (active && acceptUntil && !continuous) {
      acceptTimer = setTimeout(() => {
        if (!continuous && Date.now() >= acceptUntil) acceptReports = false;
      }, Math.max(0, acceptUntil - Date.now()));
    }
    window.dispatchEvent(new CustomEvent("mediasniffer-control", {
      detail: { active: !!active, until: acceptUntil }
    }));
  }

  function forEachRoot(start, visit) {
    const stack = [start];
    const seen = new Set();
    while (stack.length) {
      const root = stack.pop();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      visit(root);
      let all = [];
      try {
        all = root.querySelectorAll("*");
      } catch {
        continue;
      }
      for (const el of all) {
        if (el.shadowRoot) stack.push(el.shadowRoot);
      }
    }
  }

  function readElement(el) {
    const items = [];
    let sawBlob = false;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
    const resolution = el.videoWidth > 0 && el.videoHeight > 0 ? `${el.videoWidth}x${el.videoHeight}` : null;
    const push = (url, mime) => {
      if (!url || typeof url !== "string") return;
      if (url.startsWith("blob:") || url.startsWith("data:")) {
        sawBlob = true;
        return;
      }
      items.push({
        url,
        mime: mime || null,
        duration,
        resolution,
        source: "dom"
      });
    };
    push(el.currentSrc, "");
    if (el.src && el.src !== el.currentSrc) push(el.src, "");
    let sources = [];
    try {
      sources = el.querySelectorAll("source");
    } catch {
      sources = [];
    }
    for (const source of sources) push(source.src, source.type || "");
    if (el.srcObject && items.length === 0) sawBlob = true;
    return { items, sawBlob };
  }

  function collect() {
    const streams = [];
    let sawBlob = false;
    if (document.documentElement || document.body) {
      forEachRoot(document, (root) => {
        if (continuous) watchRoot(root);
        let media = [];
        try {
          media = root.querySelectorAll("video, audio");
        } catch {
          return;
        }
        for (const el of media) {
          const info = readElement(el);
          if (info.sawBlob) sawBlob = true;
          for (const item of info.items) MS.upsertStream(streams, item, MS.MAX_STREAMS);
        }
      });
    }
    let entries = [];
    try {
      if (typeof performance !== "undefined" && typeof performance.setResourceTimingBufferSize === "function") {
        performance.setResourceTimingBufferSize(MS.RESOURCE_BUFFER);
      }
      entries = performance.getEntriesByType("resource");
    } catch {
      entries = [];
    }
    for (const item of MS.streamsFromResources(entries)) {
      MS.upsertStream(streams, item, MS.MAX_STREAMS);
    }
    try {
      for (const url of MS.mediaUrlsInDocument()) {
        MS.upsertStream(streams, { url, source: "dom" }, MS.MAX_STREAMS);
      }
    } catch {
      /* A document can refuse to expose its scripts. */
    }
    return {
      streams,
      sawBlob,
      top: window === window.top,
      pageTitle: window === window.top ? document.title : "",
      pageUrl: window === window.top ? location.href : ""
    };
  }

  function watchRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    try {
      const observer = new MutationObserver(() => scheduleScan());
      observer.observe(root, { childList: true, subtree: true });
      observers.push(observer);
    } catch {
      /* Some documents refuse observation. */
    }
  }

  function onMediaEvent(event) {
    const target = event.target;
    if (!target || (target.localName !== "video" && target.localName !== "audio")) return;
    scheduleScan();
  }

  function startContinuous() {
    continuous = true;
    acceptReports = true;
    acceptUntil = 0;
    if (!domEventsOn) {
      document.addEventListener("loadedmetadata", onMediaEvent, true);
      document.addEventListener("loadstart", onMediaEvent, true);
      document.addEventListener("play", onMediaEvent, true);
      domEventsOn = true;
    }
    if (document.documentElement) watchRoot(document);
  }

  function stopContinuous() {
    continuous = false;
    if (domEventsOn) {
      document.removeEventListener("loadedmetadata", onMediaEvent, true);
      document.removeEventListener("loadstart", onMediaEvent, true);
      document.removeEventListener("play", onMediaEvent, true);
      domEventsOn = false;
    }
    for (const observer of observers) observer.disconnect();
    observers.length = 0;
    observedRoots = new WeakSet();
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = 0;
    }
  }

  function scheduleScan() {
    if (!continuous || scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      if (!continuous) return;
      const result = collect();
      enqueue(result.streams, result.sawBlob);
    }, 400);
  }

  function payloadFor(streams, sawBlob) {
    return {
      type: "media-batch",
      streams: (streams || []).slice(0, 80).map((item) => {
        const out = {
          url: item.url,
          mime: item.mime || null,
          size: item.size || null,
          sizeFromHeader: !!item.sizeFromHeader,
          duration: item.duration || null,
          resolution: item.resolution || null,
          bitrate: item.bitrate || null,
          resourceType: item.resourceType || null,
          source: item.source || "dom"
        };
        if (typeof item.body === "string" && item.body) out.body = item.body.slice(0, 200000);
        if (item.bytes && item.bytes.byteLength) out.bytes = item.bytes;
        return out;
      }),
      sawBlob: !!sawBlob,
      top: window === window.top,
      pageTitle: window === window.top ? document.title : "",
      pageUrl: window === window.top ? location.href : ""
    };
  }

  function enqueue(streams, sawBlob) {
    if (sawBlob) sawBlobQueued = true;
    const light = [];
    for (const item of streams || []) {
      if (item && item.bytes && item.bytes.byteLength) {
        chrome.runtime.sendMessage(payloadFor([item], false)).catch(() => {});
      } else if (item) light.push(item);
    }
    if (light.length) queue.push(...light);
    if (!queue.length && !sawBlobQueued) return;
    if (queue.length >= 80) {
      flushQueue();
      return;
    }
    if (!queueTimer) queueTimer = setTimeout(flushQueue, 80);
  }

  function flushQueue() {
    queueTimer = 0;
    if (!queue.length && !sawBlobQueued) return;
    const batch = queue.splice(0, 80);
    const sawBlob = sawBlobQueued;
    sawBlobQueued = false;
    chrome.runtime.sendMessage(payloadFor(batch, sawBlob)).catch(() => {});
    if (queue.length || sawBlobQueued) queueTimer = setTimeout(flushQueue, 80);
  }

  window.addEventListener("mediasniffer-report", (event) => {
    if (!acceptReports) return;
    if (!continuous && acceptUntil && Date.now() > acceptUntil) return;
    const detail = event.detail;
    if (!detail || typeof detail !== "object") return;
    if (!detail.url) {
      if (detail.source === "mse") enqueue([], true);
      return;
    }
    enqueue([detail], false);
  });

  function activate(isContinuous, until) {
    if (isContinuous) startContinuous();
    else stopContinuous();
    controlHook(true, isContinuous ? 0 : until || 0);
    return collect();
  }

  globalThis.__mediaSnifferActivate = activate;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ping") {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "deactivate") {
      stopContinuous();
      controlHook(false, 0);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "scan") {
      const result = activate(!!msg.continuous, msg.until || 0);
      sendResponse({ ok: true, count: result.streams.length });
      return;
    }
    if (msg.type === "pull-kept") {
      if (window !== window.top) return;
      pullKept().then(
        (items) => sendResponse({ ok: true, items }),
        () => sendResponse({ ok: true, items: [] })
      );
      return true;
    }
  });

  function pullKept() {
    const kept = window.__mediaSnifferKept;
    if (kept && Array.isArray(kept.items)) {
      return Promise.resolve(kept.items.map((item) => ({ url: item.url, mime: item.mime, bytes: item.bytes })));
    }
    return new Promise((resolve) => {
      const requestId = `pull-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const finish = (items) => {
        window.removeEventListener("mediasniffer-kept", onReply);
        resolve(items || []);
      };
      const timer = setTimeout(() => finish([]), 1500);
      const onReply = (event) => {
        const detail = event && event.detail;
        if (!detail || detail.requestId !== requestId) return;
        clearTimeout(timer);
        finish(Array.isArray(detail.items) ? detail.items : []);
      };
      window.addEventListener("mediasniffer-kept", onReply);
      window.dispatchEvent(new CustomEvent("mediasniffer-pull", { detail: { requestId } }));
    });
  }
})();

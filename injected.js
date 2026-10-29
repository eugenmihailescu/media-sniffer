/* Page-world hook. Injected only for a scan or while continuous detection is on.
   Watches fetch, XHR, and MediaSource for generic media types. Removed again
   when the watch ends, unless the page wrapped the same functions later. */
(function () {
  "use strict";

  if (window.__mediaSnifferHook) {
    window.dispatchEvent(new CustomEvent("mediasniffer-ready"));
    return;
  }

  const state = {
    active: false,
    until: 0,
    timer: 0,
    installed: false
  };
  window.__mediaSnifferHook = state;

  const seen = new Map();
  let lastMediaUrl = "";
  let appendNoted = false;

  function absolute(url) {
    try {
      return new URL(String(url), location.href).href;
    } catch {
      return "";
    }
  }

  function classifyQuick(url) {
    const href = absolute(url);
    if (!href.startsWith("http://") && !href.startsWith("https://")) return null;
    let parsed;
    try {
      parsed = new URL(href);
    } catch {
      return null;
    }
    const ext = (parsed.pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/) || [])[1];
    const byExt = {
      mp4: "MP4",
      m4v: "MP4",
      webm: "WebM",
      mkv: "Video",
      mov: "Video",
      ogv: "Video",
      m3u8: "HLS",
      m3u: "HLS",
      mpd: "DASH",
      m4s: "Segment",
      cmfv: "Segment",
      cmfa: "Segment",
      mp3: "Audio",
      m4a: "Audio",
      aac: "Audio",
      ogg: "Audio",
      opus: "Audio",
      wav: "Audio",
      flac: "Audio",
      weba: "Audio"
    };
    if (ext && byExt[ext]) return byExt[ext];
    const query = parsed.search.toLowerCase();
    if (/\.m3u8(?:$|[&#])/.test(query)) return "HLS";
    if (/\.mpd(?:$|[&#])/.test(query)) return "DASH";
    if (/\.(mp4|webm|m4s|m4a|mp3)(?:$|[&#])/.test(query)) return "Media";
    return null;
  }

  function interestingMime(mime) {
    const value = String(mime || "").split(";")[0].trim().toLowerCase();
    if (!value) return false;
    if (value.includes("mpegurl") || value === "application/dash+xml") return true;
    if (value.startsWith("video/") || value.startsWith("audio/")) return true;
    if (value === "application/mp2t" || value === "video/iso.segment") return true;
    return false;
  }

  function isPlaylist(url, mime) {
    const kind = classifyQuick(url);
    if (kind === "HLS" || kind === "DASH") return true;
    const value = String(mime || "").toLowerCase();
    return value.includes("mpegurl") || value.includes("dash+xml");
  }

  function shouldReport(url, mime) {
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) return false;
    return !!(classifyQuick(url) || interestingMime(mime));
  }

  function reportBuffered() {
    let entries = [];
    try {
      if (typeof performance !== "undefined" && typeof performance.setResourceTimingBufferSize === "function") {
        performance.setResourceTimingBufferSize(5000);
      }
      entries = performance.getEntriesByType("resource") || [];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry || typeof entry.name !== "string") continue;
      const initiator = entry.initiatorType;
      if (!classifyQuick(entry.name) && initiator !== "video" && initiator !== "audio") continue;
      const size = Number(entry.encodedBodySize) || Number(entry.decodedBodySize) || 0;
      emit({
        url: absolute(entry.name),
        size: size || null,
        sizeFromHeader: false,
        source: "resource"
      });
    }
  }

  function emit(detail) {
    if (!state.active) return;
    if (state.until && Date.now() > state.until) {
      shutdown();
      return;
    }
    if (detail.url) lastMediaUrl = detail.url;
    const key = [
      detail.url || "",
      detail.mime || "",
      detail.size || "",
      detail.body ? detail.body.length : 0,
      detail.bytes && detail.bytes.byteLength || 0,
      detail.mseOnly ? "mse" : ""
    ].join("|");
    if (detail.url && seen.get(detail.url) === key) return;
    if (detail.url) {
      if (seen.size > 500) seen.clear();
      seen.set(detail.url, key);
    }
    try {
      window.dispatchEvent(new CustomEvent("mediasniffer-report", { detail }));
    } catch {
      /* Ignore a page that broke dispatch. */
    }
  }

  function header(response, name) {
    try {
      return response && response.headers && response.headers.get ? (response.headers.get(name) || "") : "";
    } catch {
      return "";
    }
  }

  async function inspectResponse(response, requested) {
    try {
      if (!state.active || !response) return;
      const mime = header(response, "content-type");
      const rawUrl = response.type === "opaque" ? requested : (response.url || requested);
      const url = absolute(rawUrl);
      if (!shouldReport(url, mime)) return;
      const length = Number(header(response, "content-length")) || null;
      let body = "";
      if (isPlaylist(url, mime) && response.type !== "opaque" && typeof response.clone === "function") {
        try {
          if (!length || length <= 200000) body = (await response.clone().text()).slice(0, 200000);
        } catch {
          body = "";
        }
      }
      emit({
        url,
        mime,
        size: length,
        sizeFromHeader: !!length,
        body,
        source: "hook"
      });
    } catch {
      /* Never break the page's fetch chain. */
    }
  }

  const restorers = [];

  function patch(owner, key, factory) {
    if (!owner || typeof owner[key] !== "function" || owner[key].__msWrapped) return;
    const original = owner[key];
    const next = factory(original);
    next.__msWrapped = true;
    owner[key] = next;
    restorers.push(() => {
      if (owner[key] === next) {
        owner[key] = original;
        return true;
      }
      return owner[key] === original;
    });
  }

  function install() {
    if (state.installed) return;
    state.installed = true;
    appendNoted = false;

    if (typeof window.fetch === "function" && !window.fetch.__msWrapped) {
      const original = window.fetch;
      const next = function () {
        const input = arguments[0];
        const requested = absolute(typeof input === "string" ? input : input && input.url);
        const result = original.apply(this, arguments);
        if (state.active && result && typeof result.then === "function") {
          result.then((response) => inspectResponse(response, requested), () => {});
        }
        return result;
      };
      next.__msWrapped = true;
      window.fetch = next;
      restorers.push(() => {
        if (window.fetch === next) {
          window.fetch = original;
          return true;
        }
        return window.fetch === original;
      });
    }

    if (typeof XMLHttpRequest === "function") {
      patch(XMLHttpRequest.prototype, "open", (original) => function (_method, url) {
        try { this.__msUrl = absolute(url); } catch { this.__msUrl = ""; }
        return original.apply(this, arguments);
      });
      patch(XMLHttpRequest.prototype, "send", (original) => function () {
        if (state.active) {
          this.addEventListener("load", function onLoad() {
            this.removeEventListener("load", onLoad);
            try {
              if (!state.active) return;
              let mime = "";
              let lengthHeader = "";
              try { mime = this.getResponseHeader("content-type") || ""; } catch { mime = ""; }
              try { lengthHeader = this.getResponseHeader("content-length") || ""; } catch { lengthHeader = ""; }
              const url = absolute(this.responseURL || this.__msUrl || "");
              if (!shouldReport(url, mime)) return;
              let body = "";
              if (isPlaylist(url, mime)) {
                const kind = this.responseType || "";
                if ((!kind || kind === "text") && typeof this.responseText === "string") {
                  body = this.responseText.slice(0, 200000);
                }
              }
              emit({
                url,
                mime,
                size: Number(lengthHeader) || null,
                sizeFromHeader: !!Number(lengthHeader),
                body,
                source: "hook"
              });
            } catch {
              /* Ignore CORS header locks. */
            }
          });
        }
        return original.apply(this, arguments);
      });
    }

    const patchAdd = (ctor) => {
      if (!ctor || !ctor.prototype) return;
      patch(ctor.prototype, "addSourceBuffer", (original) => function (mime) {
        try {
          if (state.active) {
            emit({
              url: lastMediaUrl || "",
              mime: mime || "",
              source: "mse",
              mseOnly: !lastMediaUrl
            });
          }
        } catch {
          /* Keep the player working. */
        }
        return original.apply(this, arguments);
      });
    };
    patchAdd(window.MediaSource);
    patchAdd(window.ManagedMediaSource);

    if (window.SourceBuffer && window.SourceBuffer.prototype) {
      patch(window.SourceBuffer.prototype, "appendBuffer", (original) => function (data) {
        try {
          if (state.active && !appendNoted) {
            appendNoted = true;
            emit({
              url: lastMediaUrl || "",
              mime: this.mimeType || "",
              source: "mse",
              mseOnly: !lastMediaUrl,
              size: data && (data.byteLength || data.length) || null
            });
          }
        } catch {
          /* Keep appending. */
        }
        return original.apply(this, arguments);
      });
    }
  }

  function emitKept(item) {
    if (!item || !item.bytes || !item.bytes.byteLength) return;
    emit({
      url: absolute(item.url) || item.url,
      mime: item.mime || "application/vnd.yt-ump",
      size: item.bytes.byteLength,
      sizeFromHeader: true,
      bytes: item.bytes,
      source: "kept"
    });
  }

  function watchKept() {
    const kept = window.__mediaSnifferKept;
    if (!kept || !Array.isArray(kept.items)) return;
    for (const item of kept.items) emitKept(item);
    kept.onAdd = (item) => {
      if (state.active) emitKept(item);
    };
  }

  function shutdown() {
    const kept = window.__mediaSnifferKept;
    if (kept) kept.onAdd = null;
    state.active = false;
    state.until = 0;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = 0;
    }
    let restoredAll = true;
    for (const restore of restorers) {
      try {
        if (!restore()) restoredAll = false;
      } catch {
        restoredAll = false;
      }
    }
    if (restoredAll) {
      restorers.length = 0;
      state.installed = false;
    }
  }

  window.addEventListener("mediasniffer-control", (event) => {
    const detail = (event && event.detail) || {};
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = 0;
    }
    if (!detail.active) {
      shutdown();
      return;
    }
    appendNoted = false;
    try {
      install();
    } catch {
      shutdown();
      return;
    }
    state.active = true;
    state.until = Number(detail.until) || 0;
    try {
      reportBuffered();
    } catch {
      /* A locked performance list should not cancel the watch. */
    }
    try {
      watchKept();
    } catch {
      /* A page without the early buffer still reports live requests. */
    }
    if (state.until) {
      state.timer = setTimeout(shutdown, Math.max(0, state.until - Date.now()));
    }
  });

  window.dispatchEvent(new CustomEvent("mediasniffer-ready"));
})();

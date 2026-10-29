/* MAIN world, document start. Raises the resource-timing buffer, and keeps the
   body of a multipart media response (application/vnd.yt-ump) so a later scan
   can still unpack it. Nothing is sent to the extension until that scan.
   5000 matches MS.RESOURCE_BUFFER. This file cannot load common.js into the page. */
(function () {
  "use strict";

  const CAP = 32 * 1024 * 1024;

  try {
    if (typeof performance !== "undefined" && typeof performance.setResourceTimingBufferSize === "function") {
      performance.setResourceTimingBufferSize(5000);
    }
  } catch {
    /* Some documents refuse the call. */
  }

  if (window.__mediaSnifferKept) return;

  function concat(chunks, total) {
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  const kept = {
    items: [],
    total: 0,
    onAdd: null,
    add(entry) {
      if (!entry || !entry.bytes || !entry.bytes.byteLength) return;
      let bytes = entry.bytes;
      if (bytes.byteLength > CAP) bytes = bytes.subarray(0, CAP);
      while (this.items.length && (this.items.length >= 8 || this.total + bytes.byteLength > CAP)) {
        const old = this.items.shift();
        this.total -= old.bytes.byteLength;
      }
      if (this.total + bytes.byteLength > CAP) return;
      const stored = { url: entry.url, mime: entry.mime, bytes };
      this.items.push(stored);
      this.total += bytes.byteLength;
      if (typeof this.onAdd === "function") {
        try { this.onAdd(stored); } catch { /* The watcher is optional. */ }
      }
    }
  };
  window.__mediaSnifferKept = kept;

  function absolute(url) {
    try {
      return new URL(String(url || ""), location.href).href;
    } catch {
      return "";
    }
  }

  function retain(response, requested) {
    try {
      if (!response || response.type === "opaque" || typeof response.clone !== "function") return;
      const mime = String((response.headers && response.headers.get && response.headers.get("content-type")) || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (mime !== "application/vnd.yt-ump") return;
      const url = absolute(response.url || requested);
      if (!url) return;
      const clone = response.clone();
      const reader = clone.body && typeof clone.body.getReader === "function" ? clone.body.getReader() : null;
      if (!reader) {
        clone.arrayBuffer().then((buffer) => {
          kept.add({ url, mime, bytes: new Uint8Array(buffer) });
        }).catch(() => {});
        return;
      }
      const chunks = [];
      let total = 0;
      const pull = () => {
        reader.read().then(({ done, value }) => {
          if (value && value.byteLength && total < CAP) {
            const room = CAP - total;
            const slice = value.byteLength > room ? value.subarray(0, room) : value;
            chunks.push(slice);
            total += slice.byteLength;
          }
          if (!done && total < CAP) {
            pull();
            return;
          }
          if (!done) reader.cancel().catch(() => {});
          if (total) kept.add({ url, mime, bytes: concat(chunks, total) });
        }).catch(() => {});
      };
      pull();
    } catch {
      /* Never break the page's fetch. */
    }
  }

  try {
    if (typeof window.fetch === "function" && !window.fetch.__msKept) {
      const original = window.fetch;
      const next = function () {
        let requested = "";
        try {
          const input = arguments[0];
          requested = typeof input === "string" ? input : (input && input.url) || "";
        } catch {
          requested = "";
        }
        const result = original.apply(this, arguments);
        if (result && typeof result.then === "function") {
          result.then((response) => retain(response, requested), () => {});
        }
        return result;
      };
      next.__msKept = true;
      window.fetch = next;
    }
  } catch {
    /* A locked window.fetch stays as the page left it. */
  }

  window.addEventListener("mediasniffer-pull", (event) => {
    const requestId = event && event.detail && event.detail.requestId;
    if (!requestId) return;
    try {
      window.dispatchEvent(new CustomEvent("mediasniffer-kept", {
        detail: {
          requestId,
          items: kept.items.map((item) => ({ url: item.url, mime: item.mime, bytes: item.bytes }))
        }
      }));
    } catch {
      /* The page can refuse the event. */
    }
  });
})();

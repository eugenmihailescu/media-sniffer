/* Popup for the active tab. Renders streams pushed by the service worker. */
(function () {
  "use strict";

  const scanBtn = document.getElementById("scan");
  const continuous = document.getElementById("continuous");
  const list = document.getElementById("list");
  const status = document.getElementById("status");
  const page = document.getElementById("page");
  const count = document.getElementById("count");
  const historyOpen = document.getElementById("history-open");
  const historyBack = document.getElementById("history-back");
  const historyView = document.getElementById("history-view");
  const historyList = document.getElementById("history-list");

  let tabId = null;
  let lastSignature = "";
  let rendered = null;
  let stickyUntil = 0;
  let pendingKey = "";
  let actionLock = "";
  let popupView = "main";
  let historyRequest = 0;
  let variantPanelSeq = 0;
  const openVariants = new Set();

  function showStatus(text, kind, busy) {
    if (!text) {
      status.hidden = true;
      status.replaceChildren();
      status.removeAttribute("data-kind");
      delete status.dataset.busy;
      return;
    }
    status.hidden = false;
    status.dataset.kind = kind || "error";
    if (busy) status.dataset.busy = "true";
    else delete status.dataset.busy;
    const label = document.createElement("span");
    label.className = "status-text";
    label.textContent = text;
    status.replaceChildren(label);
    if (!busy) return;
    const spin = document.createElement("span");
    spin.className = "spinner";
    spin.setAttribute("aria-hidden", "true");
    status.append(spin);
  }

  function buttonLockId(button) {
    if (button.dataset.history) return `history:${button.dataset.history}`;
    if (button.dataset.assemble) return button.dataset.key || "";
    if (button.dataset.playlist) return button.dataset.playlist;
    if (button.dataset.url) return button.dataset.url;
    return "";
  }

  function paintLock() {
    const locked = !!actionLock;
    const buttons = [
      ...list.querySelectorAll("button"),
      ...historyList.querySelectorAll("button")
    ];
    for (const button of buttons) {
      if (button.dataset.variants) continue;
      const id = buttonLockId(button);
      const active = locked && !!id && id === actionLock;
      button.disabled = locked;
      button.classList.toggle("is-busy", active);
      if (active) button.setAttribute("aria-busy", "true");
      else button.removeAttribute("aria-busy");
    }
    const scanBusy = actionLock === "scan";
    const unavailable = tabId == null || !!(rendered && rendered.unsupported);
    scanBtn.disabled = unavailable || locked;
    scanBtn.classList.toggle("is-busy", scanBusy);
    if (scanBusy) scanBtn.setAttribute("aria-busy", "true");
    else scanBtn.removeAttribute("aria-busy");
    continuous.disabled = unavailable || locked;
  }

  function beginAction(key) {
    if (actionLock) return false;
    actionLock = key;
    pendingKey = key === "scan" ? "" : key;
    paintLock();
    return true;
  }

  function endAction() {
    actionLock = "";
    pendingKey = "";
    paintLock();
  }

  function showStarted(button) {
    endAction();
    if (!button || !button.isConnected) return;
    const previous = button.textContent;
    button.disabled = true;
    button.textContent = "Started";
    setTimeout(() => {
      if (!button.isConnected || actionLock) return;
      button.textContent = previous;
      button.disabled = false;
    }, 1500);
  }

  function pageLabel(state) {
    if (state.pageTitle) return state.pageTitle;
    try {
      return new URL(state.pageUrl).host;
    } catch {
      return "This tab";
    }
  }

  function shortUrl(url) {
    const text = String(url || "");
    if (text.length <= 72) return text;
    return `${text.slice(0, 34)}…${text.slice(-28)}`;
  }

  function showView(view) {
    popupView = view === "history" ? "history" : "main";
    document.body.dataset.view = popupView;
    historyView.hidden = popupView !== "history";
  }

  function historyWhen(at) {
    const time = Number(at);
    if (!time) return "";
    try {
      return new Date(time).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
    } catch {
      return "";
    }
  }

  function historyDetail(item) {
    const count = Array.isArray(item.urls) ? item.urls.length : 0;
    if (item.mode === "fragments") return count === 1 ? "1 fragment" : `${count} fragments`;
    if (item.mode === "playlist") return `Playlist · ${shortUrl(item.url)}`;
    if (item.mode === "capture") return "Captured from the player";
    return shortUrl(item.url);
  }

  function historyEmpty(text) {
    historyList.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = text;
    historyList.append(empty);
    paintLock();
  }

  function renderHistory(items) {
    const rows = Array.isArray(items) ? items : [];
    historyList.replaceChildren();
    if (!rows.length) {
      historyEmpty("No downloads yet.");
      return;
    }
    for (const item of rows) {
      const article = document.createElement("article");
      article.className = "item";
      const row = document.createElement("div");
      row.className = "row";
      const main = document.createElement("div");
      main.className = "main";
      const name = document.createElement("p");
      name.className = "name";
      name.textContent = item.filename || "Download";
      if (item.pageTitle) name.title = item.pageTitle;
      const detail = document.createElement("p");
      detail.className = "url";
      detail.textContent = historyDetail(item);
      if (item.mode !== "fragments" && item.url) detail.title = item.url;
      else if (item.pageTitle) detail.title = item.pageTitle;
      main.append(name, detail);
      const when = historyWhen(item.at);
      if (when) {
        const meta = document.createElement("div");
        meta.className = "meta";
        const stamp = document.createElement("span");
        stamp.textContent = when;
        meta.append(stamp);
        main.append(meta);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "download";
      button.textContent = "Download";
      button.dataset.history = item.id;
      button.setAttribute("aria-label", `Download ${item.filename || "again"}`);
      row.append(main, button);
      article.append(row);
      historyList.append(article);
    }
    paintLock();
  }

  async function refreshHistoryLink() {
    const request = ++historyRequest;
    try {
      const result = await chrome.runtime.sendMessage({ type: "get-history" });
      if (request !== historyRequest) return;
      if (!result || result.ok === false) throw new Error((result && result.error) || "Couldn’t load download history.");
      const items = Array.isArray(result.items) ? result.items : [];
      historyOpen.hidden = items.length === 0;
      if (popupView !== "history") return;
      if (!items.length) {
        showView("main");
        return;
      }
      renderHistory(items);
    } catch (error) {
      if (request !== historyRequest) return;
      if (popupView === "history") historyEmpty(error.message || "Couldn’t load download history.");
      else historyOpen.hidden = false;
    }
  }

  function metaLine(stream) {
    const parts = [
      MS.formatSize(stream.size),
      MS.formatDuration(stream.duration),
      stream.resolution || "",
      MS.formatBitrate(stream.bitrate)
    ].filter(Boolean);
    return parts.join(" · ");
  }

  function variantLabel(variant) {
    const parts = [
      variant.label || "",
      variant.resolution || "",
      MS.formatBitrate(variant.bandwidth)
    ].filter(Boolean);
    const unique = [...new Set(parts)];
    if (!variant.url) unique.push("packaged as segments");
    return unique.join(" · ") || "Variant";
  }

  function variantKind(variant) {
    if (variant && (variant.type === "Audio" || MS.typeFromMime(variant.mime) === "Audio")) return "audio";
    return "video";
  }

  function svgNode(name, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }

  function makeVariantIcon(kind) {
    const audio = kind === "audio";
    const icon = document.createElement("span");
    icon.className = "variant-kind";
    icon.dataset.kind = kind;
    icon.title = audio ? "Audio" : "Video";
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", audio ? "Audio" : "Video");
    const svg = svgNode("svg", {
      viewBox: "0 0 16 16",
      width: "16",
      height: "16",
      "aria-hidden": "true",
      focusable: "false"
    });
    if (audio) {
      svg.append(
        svgNode("path", {
          d: "M2.15 6.15h2L7.6 3.65v8.7L4.15 9.85H2.15V6.15z",
          fill: "currentColor"
        }),
        svgNode("path", {
          d: "M9.75 6.2a2.6 2.6 0 0 1 0 3.6",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": "1.3",
          "stroke-linecap": "round"
        }),
        svgNode("path", {
          d: "M11.5 4.65a4.6 4.6 0 0 1 0 6.7",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": "1.3",
          "stroke-linecap": "round"
        })
      );
    } else {
      svg.append(
        svgNode("rect", {
          x: "1.35",
          y: "3.15",
          width: "13.3",
          height: "9.7",
          rx: "1.7",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": "1.3"
        }),
        svgNode("path", {
          d: "M6.7 6.1v3.8l3.45-1.9z",
          fill: "currentColor"
        })
      );
    }
    icon.append(svg);
    return icon;
  }

  function makeDownload(url, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = label === "Download" ? "download" : "variant-download";
    button.textContent = label;
    button.dataset.url = url;
    button.setAttribute("aria-label", `${label} ${url}`);
    return button;
  }

  function makePlaylistButton(url, audioUrl, filename) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "download";
    button.textContent = "Download MP4";
    button.dataset.playlist = url;
    if (audioUrl) button.dataset.audio = audioUrl;
    button.dataset.filename = filename;
    button.setAttribute("aria-label", `Download MP4 ${filename}`);
    return button;
  }

  function renderItem(stream) {
    const item = document.createElement("article");
    item.className = "item";

    const row = document.createElement("div");
    row.className = "row";

    const main = document.createElement("div");
    main.className = "main";

    const name = document.createElement("p");
    name.className = "name";
    const filename = MS.suggestFilename(stream, rendered && rendered.pageTitle);
    name.textContent = filename;
    name.title = stream.label || stream.url;

    const url = document.createElement("p");
    url.className = "url";
    url.textContent = stream.label || shortUrl(stream.url);
    url.title = stream.label || stream.url;

    const meta = document.createElement("div");
    meta.className = "meta";
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.dataset.type = stream.type || "Media";
    pill.textContent = stream.type || "Media";
    meta.append(pill);
    const details = metaLine(stream);
    if (details) {
      const span = document.createElement("span");
      span.textContent = details;
      meta.append(span);
    }

    main.append(name, url, meta);
    const playlistName = MS.assembledFilename(rendered && rendered.pageTitle, 0, 1);
    row.append(main, stream.type === "HLS"
      ? makePlaylistButton(stream.url, "", playlistName)
      : makeDownload(stream.url, "Download"));
    item.append(row);

    const variants = [...(stream.variants || [])].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (variants.length) {
      const open = openVariants.has(stream.url);
      const panelId = `variants-${++variantPanelSeq}`;
      const bar = document.createElement("div");
      bar.className = "variants-bar";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "text-link variants-toggle";
      toggle.dataset.variants = stream.url;
      toggle.textContent = open ? "Hide variants" : "Show variants";
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-controls", panelId);
      bar.append(toggle);
      const ul = document.createElement("ul");
      ul.className = "variants";
      ul.id = panelId;
      ul.hidden = !open;
      for (const variant of variants) {
        const li = document.createElement("li");
        li.className = "variant";
        const label = document.createElement("span");
        label.className = "variant-label";
        label.textContent = variantLabel(variant);
        if (variant.url) label.title = variant.url;
        li.append(makeVariantIcon(variantKind(variant)), label);
        if (variant.url && stream.type === "HLS") {
          li.append(makePlaylistButton(variant.url, variant.type === "Audio" ? "" : (variant.audioUrl || ""), playlistName));
        } else if (variant.url) li.append(makeDownload(variant.url, "Download"));
        ul.append(li);
      }
      item.append(bar, ul);
    }
    return item;
  }

  function toggleVariants(button) {
    const panel = button.closest(".item")?.querySelector(".variants");
    if (!panel) return;
    const open = panel.hidden;
    panel.hidden = !open;
    button.textContent = open ? "Hide variants" : "Show variants";
    button.setAttribute("aria-expanded", open ? "true" : "false");
    const key = button.dataset.variants;
    if (!key) return;
    if (open) openVariants.add(key);
    else openVariants.delete(key);
  }

  function renderCluster(cluster, index, total) {
    const item = document.createElement("article");
    item.className = "item";
    const filename = MS.assembledFilename(rendered && rendered.pageTitle, index, total);
    const key = cluster.urls.join("\n");

    const row = document.createElement("div");
    row.className = "row";
    const main = document.createElement("div");
    main.className = "main";

    const name = document.createElement("p");
    name.className = "name";
    name.textContent = filename;
    name.title = filename;

    const hint = document.createElement("p");
    hint.className = "url";
    const recovery = cluster.hasInit ? null : MS.recoveryForCluster(rendered && rendered.streams, cluster.urls);
    const size = MS.formatSize(cluster.size);
    const pieces = cluster.count === 1 ? "1 fragment" : `${cluster.count} fragments`;
    const detail = [pieces];
    if (recovery && recovery.kind === "file") detail.push("complete file from this page");
    else if (recovery && recovery.kind === "playlist") detail.push("playlist from this page");
    else detail.push(cluster.hasInit ? "joined into one MP4" : "initialization segment not captured");
    if (cluster.resolution) detail.push(cluster.resolution);
    if (cluster.paired && (!recovery || recovery.kind === "playlist")) detail.push("with audio");
    if (size && !recovery) detail.push(size);
    hint.textContent = detail.join(" · ");

    const meta = document.createElement("div");
    meta.className = "meta";
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.dataset.type = "MP4";
    pill.textContent = "MP4";
    meta.append(pill);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "download";
    button.textContent = "Download MP4";
    button.dataset.filename = filename;
    button.dataset.key = key;
    if (recovery && recovery.kind === "file") button.dataset.url = recovery.url;
    else if (recovery && recovery.kind === "playlist") {
      button.dataset.playlist = recovery.url;
      if (recovery.audioUrl) button.dataset.audio = recovery.audioUrl;
    } else button.dataset.assemble = String(index);
    button.setAttribute("aria-label", `Download MP4 ${filename}`);

    main.append(name, hint, meta);
    row.append(main, button);
    item.append(row);
    return item;
  }

  function emptyMessage(state) {
    if (!state.scanned && !state.scanning) return "No media detected yet — click Scan this tab.";
    if (state.sawBlob) {
      return "A player on this page is using an in-memory buffer. Start playback and scan again, or turn on continuous detection.";
    }
    return "No media detected on this pass. Start playback and scan again, or turn on continuous detection.";
  }

  function render(state) {
    if (!state || !Array.isArray(state.streams)) return;
    page.textContent = pageLabel(state);
    page.title = state.pageUrl || page.textContent;
    continuous.checked = !!state.continuous;
    continuous.disabled = !!state.unsupported || !!actionLock;
    if (actionLock !== "scan") {
      scanBtn.textContent = state.scanned || state.scanning ? "Rescan" : "Scan this tab";
    }
    const holdLocalError = !state.error && Date.now() < stickyUntil;
    if (!holdLocalError) {
      if (state.error) showStatus(state.error, "error");
      else if (state.scanning) showStatus("Scanning this tab…", "info", true);
      else if (state.continuous) showStatus("Watching this tab for new media.", "notice");
      else showStatus("");
    }

    const signature = JSON.stringify({
      c: state.continuous,
      s: state.scanned,
      g: state.scanning,
      b: state.sawBlob,
      e: state.error,
      u: state.unsupported,
      t: state.pageTitle,
      p: state.pageUrl,
      streams: state.streams.map((stream) => [
        stream.url,
        stream.type,
        stream.size,
        stream.duration,
        stream.resolution,
        stream.bitrate,
        stream.label || "",
        stream.captureKey || "",
        (stream.variants || []).map((variant) => [
          variant.url,
          variant.resolution,
          variant.bandwidth,
          variant.label,
          variant.type,
          variant.mime
        ])
      ])
    });
    if (signature === lastSignature) {
      paintLock();
      return;
    }
    lastSignature = signature;
    rendered = state;

    const view = MS.presentMedia(state.streams);
    const total = view.count;
    count.hidden = total === 0;
    count.textContent = total === 1 ? "1 stream" : `${total} streams`;

    const scroll = list.scrollTop;
    const segmentsOpen = document.getElementById("segments")?.open;
    list.replaceChildren();

    if (!state.streams.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = emptyMessage(state);
      list.append(empty);
      paintLock();
      return;
    }

    const playlists = view.primary.filter((stream) => stream.type === "HLS");
    const files = view.primary.filter((stream) => stream.type !== "HLS");
    for (const stream of playlists) list.append(renderItem(stream));
    view.clusters.forEach((cluster, index) => list.append(renderCluster(cluster, index, view.clusters.length)));
    for (const stream of files) list.append(renderItem(stream));
    if (view.fragments.length) {
      const details = document.createElement("details");
      details.className = "segments";
      details.id = "segments";
      details.open = !!segmentsOpen || (view.clusters.length === 0 && view.primary.length === 0);
      const summary = document.createElement("summary");
      summary.textContent = view.clusters.length
        ? "Individual fragments (not playable alone)"
        : (view.fragments.length === 1 ? "1 segment" : `${view.fragments.length} segments`);
      const inner = document.createElement("div");
      inner.className = "inner";
      for (const stream of view.fragments) inner.append(renderItem(stream));
      details.append(summary, inner);
      list.append(details);
    }
    list.scrollTop = scroll;
    paintLock();
  }

  async function startAssemble(button) {
    if (tabId == null || !rendered || actionLock) return;
    const clusters = MS.presentMedia(rendered.streams).clusters;
    const cluster = clusters[Number(button.dataset.assemble)];
    if (!cluster) return;
    const key = cluster.urls.join("\n");
    if (!beginAction(key)) return;
    stickyUntil = Date.now() + 120000;
    showStatus("Preparing the download…", "info", true);
    try {
      const result = await chrome.runtime.sendMessage({
        type: "assemble",
        tabId,
        urls: cluster.urls,
        filename: button.dataset.filename
      });
      if (!result || result.ok === false) throw new Error((result && result.error) || "Couldn’t join the fragments.");
      stickyUntil = Date.now() + 8000;
      showStatus(result.warning || "Download started.", "info");
      showStarted(button);
      refreshHistoryLink();
    } catch (error) {
      endAction();
      stickyUntil = Date.now() + 8000;
      showStatus(error.message || "Couldn’t join the fragments.");
    }
  }

  async function startPlaylist(button) {
    if (tabId == null || !rendered || actionLock) return;
    if (!beginAction(button.dataset.playlist)) return;
    stickyUntil = Date.now() + 120000;
    showStatus("Reading playlist…", "info", true);
    try {
      const result = await chrome.runtime.sendMessage({
        type: "assemble-playlist",
        tabId,
        url: button.dataset.playlist,
        audioUrl: button.dataset.audio || "",
        filename: button.dataset.filename
      });
      if (!result || result.ok === false) throw new Error((result && result.error) || "Couldn’t join the fragments.");
      stickyUntil = Date.now() + 8000;
      showStatus(result.warning || "Download started.", "info");
      showStarted(button);
      refreshHistoryLink();
    } catch (error) {
      endAction();
      stickyUntil = Date.now() + 8000;
      showStatus(error.message || "Couldn’t join the fragments.");
    }
  }

  list.addEventListener("click", async (event) => {
    const variantsToggle = event.target.closest("button[data-variants]");
    if (variantsToggle) {
      toggleVariants(variantsToggle);
      return;
    }
    const playlist = event.target.closest("button[data-playlist]");
    if (playlist) {
      await startPlaylist(playlist);
      return;
    }
    const assemble = event.target.closest("button[data-assemble]");
    if (assemble) {
      await startAssemble(assemble);
      return;
    }
    const button = event.target.closest("button[data-url]");
    if (!button || tabId == null || actionLock) return;
    const url = button.dataset.url;
    if (!beginAction(url)) return;
    stickyUntil = Date.now() + 120000;
    showStatus("Saving…", "info", true);
    try {
      const result = await chrome.runtime.sendMessage({
        type: "download",
        tabId,
        url,
        filename: button.dataset.filename || ""
      });
      if (!result || result.ok === false) throw new Error((result && result.error) || "Download failed.");
      stickyUntil = Date.now() + 4000;
      showStatus("Download started.", "info");
      showStarted(button);
      refreshHistoryLink();
    } catch (error) {
      endAction();
      stickyUntil = Date.now() + 5000;
      showStatus(error.message || "Download failed.");
    }
  });

  scanBtn.addEventListener("click", async () => {
    if (tabId == null || actionLock) return;
    stickyUntil = 0;
    scanBtn.textContent = "Scanning…";
    if (!beginAction("scan")) return;
    showStatus("Scanning this tab…", "info", true);
    try {
      const state = await chrome.runtime.sendMessage({ type: "scan", tabId });
      endAction();
      if (state && state.ok === false) throw new Error(state.error || "Scan failed.");
      render(state);
    } catch (error) {
      endAction();
      scanBtn.textContent = "Rescan";
      showStatus(error.message || "Scan failed.");
    }
  });

  historyList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-history]");
    if (!button || actionLock) return;
    const id = button.dataset.history;
    if (!id || !beginAction(`history:${id}`)) return;
    stickyUntil = Date.now() + 120000;
    showStatus("Preparing the download…", "info", true);
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "redownload", id, tabId });
      if (!result || result.ok === false) throw new Error((result && result.error) || "Download failed.");
    } catch (error) {
      endAction();
      stickyUntil = Date.now() + 8000;
      showStatus(error.message || "Download failed.");
      return;
    }
    stickyUntil = Date.now() + 8000;
    showStatus(result.warning || "Download started.", "info");
    try {
      await refreshHistoryLink();
    } catch {
      /* The download started. The list refreshes the next time history opens. */
    }
    endAction();
  });

  historyOpen.addEventListener("click", () => {
    if (historyOpen.hidden) return;
    showView("history");
    historyBack.focus();
    refreshHistoryLink();
  });

  historyBack.addEventListener("click", () => {
    showView("main");
    if (!historyOpen.hidden) historyOpen.focus();
  });

  continuous.addEventListener("change", async () => {
    if (tabId == null) return;
    const enabled = continuous.checked;
    continuous.disabled = true;
    try {
      const state = await chrome.runtime.sendMessage({ type: "set-continuous", tabId, enabled });
      if (state && state.ok === false) throw new Error(state.error || "Couldn’t update this tab.");
      render(state);
    } catch (error) {
      continuous.checked = !enabled;
      showStatus(error.message || "Couldn’t update continuous detection.");
    } finally {
      continuous.disabled = tabId == null || !!rendered?.unsupported || !!actionLock;
    }
  });

  async function init() {
    refreshHistoryLink();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== "number") {
      showStatus("No active tab.");
      scanBtn.disabled = true;
      continuous.disabled = true;
      return;
    }
    tabId = tab.id;
    const port = chrome.runtime.connect({ name: "popup" });
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === "assemble-progress" && msg.tabId === tabId && pendingKey) {
        stickyUntil = Date.now() + 120000;
        showStatus(msg.text || "Joining fragments…", "info", true);
        return;
      }
      if (msg.type === "state") render(msg.state);
    });
    port.postMessage({ type: "bind", tabId });
  }

  init().catch((error) => {
    showStatus(error.message || "Couldn’t open MediaSniffer.");
  });
})();

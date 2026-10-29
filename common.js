/* Shared media classification, playlist parsing, and filenames.
   Loaded by the service worker, content scripts, and popup.
   No site-specific paths, names, or selectors. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EXT = {
    mp4: "MP4",
    m4v: "MP4",
    webm: "WebM",
    mkv: "Video",
    mov: "Video",
    ogv: "Video",
    avi: "Video",
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

  const TYPE_EXT = {
    MP4: "mp4",
    WebM: "webm",
    Video: "mp4",
    Audio: "mp3",
    HLS: "m3u8",
    DASH: "mpd",
    Segment: "m4s",
    Media: "bin"
  };

  const TYPE_RANK = {
    MP4: 0,
    WebM: 1,
    Video: 2,
    Audio: 3,
    HLS: 4,
    DASH: 5,
    Media: 6,
    Segment: 7
  };

  const REQUEST_TYPES = ["main_frame", "sub_frame", "media", "xmlhttprequest", "object", "other"];

  const GENERIC_BASENAMES = new Set([
    "index", "master", "playlist", "manifest", "init", "segment", "seg",
    "chunk", "video", "audio", "stream", "media", "file", "play", "hls", "dash",
    "videoplayback"
  ]);

  const MAX_URL = 8000;
  const MAX_VARIANTS = 24;
  const MAX_STREAMS = 120;
  const MAX_HISTORY = 40;
  // Chrome keeps 250 resource-timing entries unless this is raised at document start.
  const RESOURCE_BUFFER = 5000;

  function finitePositive(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }

  function cleanMime(mime) {
    if (!mime || typeof mime !== "string") return "";
    return mime.split(";")[0].trim().toLowerCase();
  }

  function typeFromMime(mime) {
    const m = cleanMime(mime);
    if (!m) return null;
    if (
      m === "application/vnd.apple.mpegurl" ||
      m === "application/x-mpegurl" ||
      m === "audio/mpegurl" ||
      m === "audio/x-mpegurl"
    ) return "HLS";
    if (m === "application/dash+xml") return "DASH";
    if (m === "video/mp4" || m === "video/x-m4v" || m === "video/quicktime") return "MP4";
    if (m === "video/webm") return "WebM";
    if (m === "video/mp2t" || m === "video/iso.segment" || m === "application/mp2t") return "Segment";
    if (m.startsWith("audio/")) return "Audio";
    if (m === "video/ogg" || m === "video/x-matroska" || m === "video/avi") return "Video";
    if (m.startsWith("video/")) return "Media";
    return null;
  }

  function blockedMime(mime) {
    const m = cleanMime(mime);
    if (!m) return false;
    if (typeFromMime(m)) return false;
    return (
      m === "text/html" ||
      m === "application/xhtml+xml" ||
      m === "text/css" ||
      m === "text/javascript" ||
      m === "application/javascript" ||
      m === "application/json" ||
      m === "image/png" ||
      m === "image/jpeg" ||
      m === "image/gif" ||
      m === "image/webp" ||
      m === "image/svg+xml" ||
      m.startsWith("font/") ||
      m === "application/font-woff"
    );
  }

  function classifyUrl(raw) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    const pathMatch = url.pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    if (pathMatch && EXT[pathMatch[1]]) {
      return { type: EXT[pathMatch[1]], ext: pathMatch[1] };
    }

    const query = url.search.toLowerCase();
    const embedded = query.match(/\.(mp4|webm|m4v|m3u8|mpd|m4s|m4a|mp3)(?:$|[&#])/);
    if (embedded && EXT[embedded[1]]) {
      return { type: EXT[embedded[1]], ext: embedded[1] };
    }
    const param = query.match(
      /(?:^|[?&])(?:format|type|mime|ext|container)=(?:video\/|audio\/)?(mp4|webm|m3u8|mpd|m4a|mp3|webm)(?:$|&)/
    );
    if (param && EXT[param[1]]) {
      return { type: EXT[param[1]], ext: param[1] };
    }
    return null;
  }

  function pickType(fromMime, fromUrl, resourceType) {
    if (fromMime === "HLS" || fromMime === "DASH") return fromMime;
    if (fromUrl === "HLS" || fromUrl === "DASH") return fromUrl;
    if (fromUrl === "Segment") return "Segment";
    if (fromMime === "Audio") return "Audio";
    if (fromMime === "MP4" || fromMime === "WebM" || fromMime === "Video") return fromMime;
    if (fromUrl === "MP4" || fromUrl === "WebM" || fromUrl === "Video" || fromUrl === "Audio") return fromUrl;
    if (fromMime === "Segment" || fromUrl === "Segment") return "Segment";
    if (fromMime && fromMime !== "Media") return fromMime;
    if (fromUrl) return fromUrl;
    if (fromMime) return fromMime;
    if (resourceType === "media") return "Media";
    return null;
  }

  // Lower rank is more specific. An equal or better new type replaces the old one.
  function preferType(prev, next) {
    if (!prev) return next || null;
    if (!next || next === prev) return prev;
    if (prev === "Segment" && (next === "MP4" || next === "WebM" || next === "Video" || next === "Media")) return prev;
    const rank = { HLS: 1, DASH: 1, Audio: 2, MP4: 3, WebM: 3, Video: 4, Segment: 5, Media: 6 };
    return (rank[next] ?? 9) <= (rank[prev] ?? 9) ? next : prev;
  }

  function metaFromUrl(raw) {
    const out = { resolution: null, bitrate: null, duration: null };
    const text = String(raw || "");
    const res = text.match(/(?:^|[^0-9])(\d{3,5})x(\d{3,5})(?:[^0-9]|$)/);
    if (res) {
      const w = Number(res[1]);
      const h = Number(res[2]);
      if (w >= 160 && h >= 120 && w <= 7680 && h <= 4320) out.resolution = `${w}x${h}`;
    }
    const br = text.match(/(?:bitrate|bit_rate|bandwidth)[=:_-](\d{4,10})/i);
    if (br) out.bitrate = Number(br[1]);
    const dur = text.match(/(?:duration|dur)[=:_-](\d+(?:\.\d+)?)/i);
    if (dur) {
      const n = Number(dur[1]);
      if (n > 0 && n < 86400 * 2) out.duration = n;
    }
    return out;
  }

  function validResolution(value) {
    if (typeof value !== "string") return null;
    const m = value.match(/^(\d{2,5})x(\d{2,5})$/);
    if (!m) return null;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w < 16 || h < 16 || w > 7680 || h > 4320) return null;
    return `${w}x${h}`;
  }

  function headerValue(headers, name) {
    if (!headers) return "";
    const want = name.toLowerCase();
    if (Array.isArray(headers)) {
      for (const h of headers) {
        if (h && typeof h.name === "string" && h.name.toLowerCase() === want) return h.value || "";
      }
      return "";
    }
    if (typeof headers.get === "function") return headers.get(name) || "";
    return headers[want] || headers[name] || "";
  }

  function sizeFromHeaders(headers, statusCode) {
    const range = headerValue(headers, "content-range");
    const total = range && range.match(/\/(\d+)\s*$/);
    if (total) {
      const n = Number(total[1]);
      if (n > 0) return { size: n, sizeFromHeader: true };
    }
    if (statusCode === 206) return { size: null, sizeFromHeader: false };
    const len = finitePositive(headerValue(headers, "content-length"));
    if (len) return { size: len, sizeFromHeader: true };
    return { size: null, sizeFromHeader: false };
  }

  function absoluteHttpUrl(raw) {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_URL) return null;
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  }

  function normalizeCandidate(input) {
    if (!input || typeof input !== "object") return null;
    const href = absoluteHttpUrl(input.url);
    if (!href) return null;
    const mime = cleanMime(input.mime);
    if (blockedMime(mime)) return null;

    const fromUrl = classifyUrl(href);
    const fromMime = typeFromMime(mime);
    const type = pickType(fromMime, fromUrl ? fromUrl.type : null, input.resourceType || null);
    if (!type) return null;
    if (mime === "application/xml" || mime === "text/xml") {
      if (type !== "DASH" && type !== "HLS") return null;
    }

    const meta = metaFromUrl(href);
    const size = finitePositive(input.size);
    return {
      url: href,
      type,
      mime: mime || null,
      size,
      sizeFromHeader: !!(size && input.sizeFromHeader),
      duration: finitePositive(input.duration) || meta.duration,
      resolution: validResolution(input.resolution) || meta.resolution,
      bitrate: finitePositive(input.bitrate) || meta.bitrate,
      variants: [],
      parsed: false,
      source: typeof input.source === "string" ? input.source.slice(0, 24) : "network",
      captureKey: cleanCaptureKey(input.captureKey),
      label: typeof input.label === "string" ? input.label.slice(0, 80) : ""
    };
  }

  function cleanCaptureKey(value) {
    return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  }

  // A captured track shares the request URL with its pair. The extra parameter
  // keeps the rows distinct. The bytes were already downloaded by the page.
  function capturedMediaUrl(raw, captureKey) {
    const href = absoluteHttpUrl(raw);
    const key = cleanCaptureKey(captureKey);
    if (!href || !key) return null;
    const url = new URL(href);
    url.searchParams.set("msTrack", key);
    return url.href;
  }

  function mergeSize(prev, next) {
    if (next.sizeFromHeader && next.size) return { size: next.size, sizeFromHeader: true };
    if (prev.sizeFromHeader && prev.size) return { size: prev.size, sizeFromHeader: true };
    const size = Math.max(prev.size || 0, next.size || 0) || null;
    return { size, sizeFromHeader: false };
  }

  function mergeStream(prev, next) {
    const size = mergeSize(prev, next);
    return {
      url: prev.url,
      type: preferType(prev.type, next.type) || prev.type,
      mime: prev.mime || next.mime || null,
      size: size.size,
      sizeFromHeader: size.sizeFromHeader,
      duration: prev.duration || next.duration || null,
      resolution: prev.resolution || next.resolution || null,
      bitrate: prev.bitrate || next.bitrate || null,
      variants: next.variants && next.variants.length ? next.variants : prev.variants || [],
      parsed: !!(prev.parsed || next.parsed),
      enrichFailed: next.enrichFailed === false ? false : !!(prev.enrichFailed || next.enrichFailed),
      source: prev.source || next.source,
      captureKey: next.captureKey || prev.captureKey || "",
      label: next.label || prev.label || ""
    };
  }

  function trimStreams(streams, max) {
    const limit = max || MAX_STREAMS;
    if (streams.length <= limit) return streams;
    const primary = [];
    const segments = [];
    for (const stream of streams) {
      if (stream.type === "Segment") segments.push(stream);
      else primary.push(stream);
    }
    if (primary.length >= limit) return primary.slice(primary.length - limit);
    return primary.concat(segments.slice(-(limit - primary.length)));
  }

  function upsertStream(streams, candidate, max) {
    const norm = normalizeCandidate(candidate);
    if (!norm) return { accepted: false, added: false, stream: null };
    const idx = streams.findIndex((stream) => stream.url === norm.url);
    if (idx === -1) {
      streams.push(norm);
      const trimmed = trimStreams(streams, max || MAX_STREAMS);
      if (trimmed !== streams) {
        streams.length = 0;
        streams.push(...trimmed);
      }
      const stored = streams.find((stream) => stream.url === norm.url) || null;
      return { accepted: !!stored, added: !!stored, stream: stored };
    }
    streams[idx] = mergeStream(streams[idx], norm);
    return { accepted: true, added: false, stream: streams[idx] };
  }

  function resourceEntrySize(entry) {
    return finitePositive(entry && entry.encodedBodySize) || finitePositive(entry && entry.decodedBodySize);
  }

  // Resource-timing names stay visible across origins. Sizes are zero without Timing-Allow-Origin.
  function streamsFromResources(entries) {
    const out = [];
    if (!entries || typeof entries[Symbol.iterator] !== "function") return out;
    for (const entry of entries) {
      if (!entry || typeof entry.name !== "string") continue;
      const classified = classifyUrl(entry.name);
      const initiator = entry.initiatorType;
      if (!classified && initiator !== "video" && initiator !== "audio") continue;
      out.push({
        url: entry.name,
        size: resourceEntrySize(entry),
        sizeFromHeader: false,
        resourceType: initiator === "video" || initiator === "audio" ? "media" : null,
        source: "resource"
      });
    }
    return out;
  }

  function mediaUrlsInText(text, limit) {
    const cap = limit || 80;
    const raw = String(text || "")
      .replace(/\\u002f/gi, "/")
      .replace(/\\\//g, "/")
      .replace(/\\u0026/gi, "&")
      .replace(/&amp;/gi, "&");
    const out = [];
    const seen = new Set();
    const re = /https?:\/\/[^\s"'<>]+/gi;
    let match;
    while ((match = re.exec(raw))) {
      const token = match[0].replace(/[),.;\]]+$/g, "").replace(/\\+$/g, "");
      const href = absoluteHttpUrl(token);
      if (!href || seen.has(href) || !classifyUrl(href)) continue;
      seen.add(href);
      out.push(href);
      if (out.length >= cap) break;
    }
    return out;
  }

  function mediaUrlsInDocument(doc, limit) {
    const cap = limit || 80;
    const rootDoc = doc || (typeof document !== "undefined" ? document : null);
    if (!rootDoc || typeof rootDoc.querySelectorAll !== "function") return [];
    const urls = [];
    const seen = new Set();
    const stack = [rootDoc];
    const visited = new Set();
    while (stack.length && urls.length < cap) {
      const root = stack.pop();
      if (!root || visited.has(root)) continue;
      visited.add(root);
      let scripts = [];
      try {
        scripts = root.querySelectorAll("script");
      } catch {
        scripts = [];
      }
      for (const script of scripts) {
        const text = script && script.textContent;
        if (!text) continue;
        const slice = text.length > 1500000 ? text.slice(0, 1500000) : text;
        for (const url of mediaUrlsInText(slice, cap - urls.length)) {
          if (seen.has(url)) continue;
          seen.add(url);
          urls.push(url);
          if (urls.length >= cap) break;
        }
        if (urls.length >= cap) break;
      }
      let all = [];
      try {
        all = root.querySelectorAll("*");
      } catch {
        all = [];
      }
      for (const el of all) {
        if (el && el.shadowRoot) stack.push(el.shadowRoot);
      }
    }
    if (urls.length < cap && rootDoc.documentElement && typeof rootDoc.documentElement.innerHTML === "string") {
      const html = rootDoc.documentElement.innerHTML;
      const slice = html.length > 2000000 ? html.slice(0, 2000000) : html;
      for (const url of mediaUrlsInText(slice, cap - urls.length)) {
        if (seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
        if (urls.length >= cap) break;
      }
    }
    return urls;
  }

  function resolveUrl(ref, base) {
    try {
      return new URL(ref, base).href;
    } catch {
      return null;
    }
  }

  function cleanVariants(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const url = item.url ? absoluteHttpUrl(item.url) : null;
      const resolution = validResolution(item.resolution);
      const bandwidth = finitePositive(item.bandwidth);
      if (!url && !resolution && !bandwidth) continue;
      const key = `${url || ""}|${resolution || ""}|${bandwidth || ""}|${item.label || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        url,
        resolution,
        bandwidth,
        mime: item.mime ? cleanMime(item.mime) || null : null,
        label: item.label ? String(item.label).slice(0, 80) : null,
        type: item.type || null,
        audioUrl: item.audioUrl ? absoluteHttpUrl(item.audioUrl) : null
      });
      if (out.length >= MAX_VARIANTS) break;
    }
    return out;
  }

  function parseHls(text, manifestUrl) {
    const lines = String(text || "").split(/\r?\n/);
    const variants = [];
    const audioGroups = new Map();
    const segments = [];
    let map = null;
    let duration = 0;
    let hasInf = false;
    let hasMaster = false;
    let expectSegment = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        hasMaster = true;
        expectSegment = false;
        const bandwidth = finitePositive((line.match(/\bBANDWIDTH=(\d+)/) || [])[1]);
        const resolution = validResolution((line.match(/\bRESOLUTION=(\d+x\d+)/) || [])[1] || "");
        const audioGroup = (line.match(/\bAUDIO="([^"]*)"/) || [])[1] || "";
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        const target = (lines[j] || "").trim();
        if (target && !target.startsWith("#")) {
          variants.push({
            url: resolveUrl(target, manifestUrl),
            bandwidth,
            resolution,
            mime: null,
            label: resolution || (bandwidth ? `${Math.round(bandwidth / 1000)} kbps` : "Variant"),
            type: "HLS",
            audioGroup
          });
        }
      } else if (line.startsWith("#EXT-X-MEDIA:") && /\bTYPE=AUDIO\b/.test(line)) {
        expectSegment = false;
        const uri = (line.match(/\bURI="([^"]+)"/) || [])[1];
        if (!uri) continue;
        const name = (line.match(/\bNAME="([^"]*)"/) || [])[1] || "Audio";
        const group = (line.match(/\bGROUP-ID="([^"]*)"/) || [])[1] || "";
        const url = resolveUrl(uri, manifestUrl);
        if (!audioGroups.has(group)) audioGroups.set(group, []);
        audioGroups.get(group).push({ url, def: /\bDEFAULT=YES\b/.test(line) });
        variants.push({
          url,
          bandwidth: null,
          resolution: null,
          mime: null,
          label: name,
          type: "Audio",
          audioGroup: group
        });
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const uri = (line.match(/\bURI="([^"]+)"/) || [])[1];
        if (uri) map = resolveUrl(uri, manifestUrl);
      } else if (line.startsWith("#EXTINF:")) {
        hasInf = true;
        expectSegment = true;
        const value = parseFloat(line.slice("#EXTINF:".length));
        if (Number.isFinite(value) && value > 0) duration += value;
      } else if (line.startsWith("#")) {
        /* A tag between EXTINF and the URI still belongs to that segment. */
      } else if (expectSegment) {
        const url = resolveUrl(line, manifestUrl);
        if (url) segments.push(url);
        expectSegment = false;
      }
    }
    for (const variant of variants) {
      if (!variant.audioGroup || variant.type === "Audio") {
        variant.audioUrl = null;
        continue;
      }
      const group = audioGroups.get(variant.audioGroup) || [];
      const chosen = group.find((entry) => entry.def) || group[0];
      variant.audioUrl = chosen ? chosen.url : null;
    }
    return {
      duration: !hasMaster && hasInf && duration > 0 ? duration : null,
      variants: cleanVariants(variants),
      map: map || null,
      segments
    };
  }

  function chooseHlsRendition(parsed) {
    const variants = (parsed && parsed.variants) || [];
    const videos = variants.filter((item) => item && item.url && item.type !== "Audio");
    const ranked = videos.filter((item) => item.resolution);
    const pool = (ranked.length ? ranked : videos).slice();
    if (!pool.length) return null;
    const area = (item) => {
      const match = /^(\d+)x(\d+)$/.exec(item.resolution || "");
      return match ? Number(match[1]) * Number(match[2]) : 0;
    };
    pool.sort((a, b) => area(b) - area(a) || (b.bandwidth || 0) - (a.bandwidth || 0));
    return { videoUrl: pool[0].url, audioUrl: pool[0].audioUrl || "" };
  }

  function xmlAttr(source, name) {
    const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(source);
    if (!match) return null;
    return match[1] != null ? match[1] : match[2];
  }

  function parseIsoDuration(value) {
    if (!value) return null;
    const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value.trim());
    if (!match) return null;
    const days = Number(match[1] || 0);
    const hours = Number(match[2] || 0);
    const minutes = Number(match[3] || 0);
    const seconds = Number(match[4] || 0);
    const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
    return total > 0 ? total : null;
  }

  function parseDash(xml, manifestUrl) {
    const text = String(xml || "");
    const duration = parseIsoDuration((text.match(/\bmediaPresentationDuration\s*=\s*"([^"]+)"/i) || [])[1]);
    const topBase = (text.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i) || [])[1];
    const base = topBase ? resolveUrl(topBase.trim(), manifestUrl) || manifestUrl : manifestUrl;
    const parents = [];
    const setRe = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    let setMatch;
    while ((setMatch = setRe.exec(text))) {
      const setAttrs = setMatch[1] || "";
      parents.push({
        start: setMatch.index,
        end: setRe.lastIndex,
        mime: xmlAttr(setAttrs, "mimeType"),
        contentType: (xmlAttr(setAttrs, "contentType") || "").toLowerCase()
      });
    }
    const variants = [];
    const re = /<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/gi;
    let match;
    while ((match = re.exec(text))) {
      const attrs = match[1] || "";
      const body = match[2] || "";
      const parent = parents.find((span) => match.index >= span.start && match.index < span.end);
      const bandwidth = finitePositive(xmlAttr(attrs, "bandwidth"));
      const width = xmlAttr(attrs, "width");
      const height = xmlAttr(attrs, "height");
      const resolution = width && height ? validResolution(`${width}x${height}`) : null;
      const mime = xmlAttr(attrs, "mimeType") || (parent && parent.mime) || null;
      const cleaned = mime ? cleanMime(mime) : "";
      const contentType = parent ? parent.contentType : "";
      const localBase = (body.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i) || [])[1];
      const url = localBase ? resolveUrl(localBase.trim(), base) : null;
      const audio = cleaned.startsWith("audio/") || (!cleaned && contentType === "audio");
      variants.push({
        url,
        bandwidth,
        resolution,
        mime: cleaned || null,
        label: resolution || (audio ? "Audio" : bandwidth ? `${Math.round(bandwidth / 1000)} kbps` : "Variant"),
        type: audio ? "Audio" : "DASH"
      });
      if (variants.length >= MAX_VARIANTS) break;
    }
    return { duration, variants: cleanVariants(variants) };
  }

  function applyPlaylist(stream, parsed) {
    const variants = cleanVariants(parsed && parsed.variants);
    const next = {
      ...stream,
      parsed: true,
      enrichFailed: false,
      variants
    };
    if (parsed && parsed.duration && !next.duration) next.duration = parsed.duration;
    const ranked = [...variants].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    const best = ranked.find((item) => item.resolution) || ranked[0];
    if (best) {
      if (!next.resolution && best.resolution) next.resolution = best.resolution;
      if (!next.bitrate && best.bandwidth) next.bitrate = best.bandwidth;
    }
    return next;
  }

  function slugTitle(title) {
    const slug = String(title || "")
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    return slug;
  }

  function stamp(date) {
    const d = date || new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function sanitizeFilename(name) {
    let text = String(name || "media")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\.+/g, ".")
      .replace(/^\.+/, "")
      .trim();
    if (!text) text = "media.bin";
    const dot = text.lastIndexOf(".");
    let base = dot > 0 ? text.slice(0, dot) : text;
    const ext = dot > 0 ? text.slice(dot).toLowerCase() : "";
    if (base.length > 80) base = base.slice(0, 80).replace(/_+$/g, "");
    text = `${base || "media"}${ext}`;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(text)) text = `_${text}`;
    return text;
  }

  function extensionFor(stream) {
    const classified = stream && stream.url ? classifyUrl(stream.url) : null;
    if (classified && classified.ext) return classified.ext;
    const mime = cleanMime(stream && stream.mime);
    if (mime === "video/mp4") return "mp4";
    if (mime === "audio/mp4") return "m4a";
    if (mime === "video/webm" || mime === "audio/webm") return "webm";
    if (mime === "audio/mpeg") return "mp3";
    if (mime === "audio/aac" || mime === "audio/aacp") return "aac";
    return TYPE_EXT[(stream && stream.type) || ""] || "bin";
  }

  function suggestFilename(stream, pageTitle, date) {
    const ext = extensionFor(stream);
    if (stream && stream.label) {
      const audio = cleanMime(stream.mime).startsWith("audio/") || stream.type === "Audio";
      const title = slugTitle(pageTitle) || "media";
      return sanitizeFilename(`${title}_${audio ? "audio" : "video"}.${ext}`);
    }
    let base = "";
    try {
      const path = decodeURIComponent(new URL(stream.url).pathname);
      base = path.split("/").filter(Boolean).pop() || "";
    } catch {
      base = "";
    }
    base = base.replace(/\.[a-z0-9]{2,5}$/i, "");
    const generic = !base || base.length < 2 || GENERIC_BASENAMES.has(base.toLowerCase()) || /^[0-9a-f-]{16,}$/i.test(base);
    if (generic) {
      const title = slugTitle(pageTitle) || "media";
      base = base && !/^[0-9a-f-]{16,}$/i.test(base) ? `${title}_${base}` : `${title}_${stamp(date)}`;
    }
    return sanitizeFilename(`${base}.${ext}`);
  }

  function formatSize(bytes) {
    const n = finitePositive(bytes);
    if (!n) return "";
    const units = ["B", "KB", "MB", "GB"];
    let value = n;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    const digits = value >= 10 || Math.abs(value - Math.round(value)) < 0.05 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[i]}`;
  }

  function formatDuration(seconds) {
    const n = finitePositive(seconds);
    if (!n) return "";
    const total = Math.round(n);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const p = (v) => String(v).padStart(2, "0");
    if (h) return `${h}:${p(m)}:${p(s)}`;
    return `${m}:${p(s)}`;
  }

  function formatBitrate(bps) {
    const n = finitePositive(bps);
    if (!n) return "";
    if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)} Mbps`;
    if (n >= 1000) return `${Math.round(n / 1000)} kbps`;
    return `${Math.round(n)} bps`;
  }

  function sorted(streams) {
    return [...(streams || [])].sort((a, b) => {
      const rank = (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9);
      if (rank) return rank;
      return (b.size || 0) - (a.size || 0);
    });
  }

  function webRequestPlan(states, now) {
    const ids = [];
    for (const [id, state] of states) {
      if (!state) continue;
      if (state.continuous || (state.scanUntil && state.scanUntil > now)) ids.push(Number(id));
    }
    ids.sort((a, b) => a - b);
    if (!ids.length) return { attach: false, filter: null, key: "" };
    const filter = { urls: ["<all_urls>"], types: REQUEST_TYPES.slice() };
    if (ids.length === 1) filter.tabId = ids[0];
    return { attach: true, filter, key: JSON.stringify(filter) };
  }

  function isCapturableUrl(url) {
    return /^https?:/i.test(url || "") || /^file:/i.test(url || "");
  }

  function fileParts(url) {
    const parsed = new URL(url);
    const chunks = parsed.pathname.split("/").filter(Boolean);
    const file = chunks.pop() || "";
    const dot = file.lastIndexOf(".");
    const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
    const stem = dot > 0 ? file.slice(0, dot) : file;
    return {
      dir: `${parsed.origin}/${chunks.join("/")}`,
      stem,
      ext
    };
  }

  function isSegmentExt(ext) {
    return ext === "m4s" || ext === "cmfv" || ext === "cmfa";
  }

  function isInitStem(stem) {
    return /(^|[^a-z0-9])(init|header|hdr)([^a-z0-9]|$)/i.test(stem || "");
  }

  function sequenceNumber(url) {
    try {
      const parsed = new URL(url);
      const file = parsed.pathname.split("/").filter(Boolean).pop() || "";
      const stem = file.replace(/\.[a-z0-9]{2,5}$/i, "");
      const nums = stem.match(/\d+/g);
      if (nums && nums.length) return Number(nums[nums.length - 1]);
      for (const key of ["sq", "sn", "n", "seg", "segment", "frag", "fragment", "chunk", "num", "number"]) {
        const value = parsed.searchParams.get(key);
        if (value && /^\d+$/.test(value)) return Number(value);
      }
    } catch {
      /* Ignore unparseable URLs. */
    }
    return null;
  }

  function tokenizeStem(stem) {
    const tokens = [];
    const re = /(\d+)|(\D+)/g;
    let match;
    while ((match = re.exec(stem || ""))) {
      tokens.push(match[1] != null ? { n: true, v: Number(match[1]) } : { n: false, v: match[2] });
    }
    return tokens;
  }

  function clusterParts(parts) {
    const opaque = [];
    const structured = [];
    for (const item of parts) {
      if (isOpaqueId(item.stem)) opaque.push(item);
      else structured.push(item);
    }
    const buckets = [];
    if (opaque.length) buckets.push(opaque);
    const patterns = new Map();
    for (const item of structured) {
      const tokens = tokenizeStem(item.stem);
      const pattern = tokens.map((token) => (token.n ? "#" : token.v)).join("");
      if (!patterns.has(pattern)) patterns.set(pattern, []);
      patterns.get(pattern).push({ item, tokens });
    }
    for (const group of patterns.values()) {
      const width = group.reduce((max, entry) => Math.max(max, entry.tokens.filter((token) => token.n).length), 0);
      const columns = Array.from({ length: width }, () => new Set());
      for (const entry of group) {
        entry.tokens.filter((token) => token.n).forEach((token, index) => columns[index].add(token.v));
      }
      let counter = Math.max(0, width - 1);
      let best = -1;
      columns.forEach((values, index) => {
        if (values.size >= best) {
          best = values.size;
          counter = index;
        }
      });
      const subs = new Map();
      for (const entry of group) {
        const nums = entry.tokens.filter((token) => token.n);
        const fixed = nums.filter((_, index) => index !== counter).map((token) => token.v);
        const key = fixed.join(",");
        entry.item.seq = nums[counter] ? nums[counter].v : null;
        if (!subs.has(key)) subs.set(key, []);
        subs.get(key).push(entry.item);
      }
      for (const items of subs.values()) buckets.push(items);
    }
    return buckets;
  }

  function makeCluster(list) {
    const orderKey = (item) => {
      const fromPath = pathOrder(item.url);
      if (fromPath != null) return fromPath;
      if (Number.isFinite(item.seq)) return item.seq;
      return sequenceNumber(item.url) ?? 0;
    };
    const sorted = [...list].sort((a, b) => orderKey(a) - orderKey(b) || a.url.localeCompare(b.url));
    const urls = [];
    const seen = new Set();
    let size = 0;
    let fragments = 0;
    let hasInit = false;
    let ranged = false;
    for (const item of sorted) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      urls.push(item.url);
      size += item.size || 0;
      if (item.range) ranged = true;
      const rangedInit = item.range && item.range.start === 0;
      if (rangedInit || (!item.range && isInitFile(item))) hasInit = true;
      if (!item.init) fragments += 1;
    }
    return { urls, count: fragments || urls.length, size, hasInit, ranged };
  }

  function byteRangeOf(url) {
    try {
      for (const value of new URL(url).searchParams.values()) {
        const match = /^(\d+)-(\d+)$/.exec(value);
        if (!match) continue;
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (end >= start) return { start, end };
      }
    } catch {
      /* Ignore unparseable URLs. */
    }
    return null;
  }

  const INIT_BYTE_LIMIT = 2 * 1024 * 1024;

  function isOpaqueId(stem) {
    const base = String(stem || "");
    if (base.length < 8 || /[-_. ]\d{1,6}$/.test(base) || !/^[A-Za-z0-9_-]+$/.test(base)) return false;
    const hasDigit = /\d/.test(base);
    const hasLower = /[a-z]/.test(base);
    const hasUpper = /[A-Z]/.test(base);
    return (hasLower && hasUpper) || (hasDigit && (hasLower || hasUpper));
  }

  function isFragmentCandidate(stream, info) {
    if (isSegmentExt(info.ext)) return true;
    if (info.ext === "mp4" || info.ext === "m4v" || info.ext === "m4a") {
      if (isInitStem(info.stem) || isOpaqueId(info.stem)) return true;
    }
    return stream.type === "Segment" && (info.ext === "mp4" || info.ext === "m4v" || info.ext === "m4a" || info.ext === "");
  }

  // A pair of numeric folders is a time range. 0/0 is the initialization folder.
  function segmentDirectory(dir) {
    let parsed;
    try {
      parsed = new URL(dir);
    } catch {
      return dir;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    const out = [];
    for (let i = 0; i < parts.length; i += 1) {
      const next = parts[i + 1];
      if (next && /^\d+$/.test(parts[i]) && /^\d+$/.test(next)) {
        const left = Number(parts[i]);
        const right = Number(next);
        if ((left === 0 && right === 0) || (right > left && Number.isSafeInteger(right))) {
          out.push("#");
          i += 1;
          continue;
        }
      }
      out.push(parts[i]);
    }
    return `${parsed.origin}/${out.join("/")}`;
  }

  function pathOrder(url) {
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!/^\d+$/.test(parts[i]) || !/^\d+$/.test(parts[i + 1])) continue;
        const left = Number(parts[i]);
        const right = Number(parts[i + 1]);
        if ((left === 0 && right === 0) || right > left) return left;
      }
    } catch {
      /* Ignore unparseable URLs. */
    }
    return null;
  }

  function isInitFile(item) {
    if (item.init) return true;
    if (item.ext !== "mp4" && item.ext !== "m4v" && item.ext !== "m4a") return false;
    if (!isOpaqueId(item.stem)) return false;
    return !item.size || item.size <= INIT_BYTE_LIMIT;
  }

  function clusterFragments(streams) {
    const selected = [];
    for (const stream of streams || []) {
      if (!stream || !stream.url) continue;
      let info;
      try {
        info = fileParts(stream.url);
      } catch {
        continue;
      }
      if (!isFragmentCandidate(stream, info)) continue;
      selected.push({
        url: stream.url,
        size: stream.size || 0,
        dir: segmentDirectory(info.dir),
        ext: info.ext,
        stem: info.stem,
        init: isInitStem(info.stem),
        range: byteRangeOf(stream.url)
      });
    }
    const rangedGroups = new Map();
    const rest = [];
    for (const item of selected) {
      if (!item.range || !isOpaqueId(item.stem)) {
        rest.push(item);
        continue;
      }
      let origin = "";
      try {
        origin = new URL(item.url).origin;
      } catch {
        origin = "";
      }
      const key = `${origin}/${item.stem}.${item.ext}`;
      if (!rangedGroups.has(key)) rangedGroups.set(key, []);
      rangedGroups.get(key).push(item);
    }
    const clusters = [];
    for (const items of rangedGroups.values()) {
      const leaders = [];
      const parts = [];
      for (const item of items) {
        item.seq = item.range.start;
        item.init = item.range.start === 0;
        if (item.init) leaders.push(item);
        else parts.push(item);
      }
      if (!parts.length) continue;
      clusters.push(makeCluster(leaders.concat(parts)));
    }
    const byDir = new Map();
    for (const item of rest) {
      if (!byDir.has(item.dir)) byDir.set(item.dir, []);
      byDir.get(item.dir).push(item);
    }
    for (const items of byDir.values()) {
      const leaders = items.filter((item) => isInitFile(item));
      const parts = items.filter((item) => !isInitFile(item));
      if (!parts.length) continue;
      for (const bucket of clusterParts(parts)) clusters.push(makeCluster(bucket.concat(leaders)));
    }
    return clusters.filter((cluster) => cluster.urls.length && (cluster.hasInit || cluster.urls.length > 1 || !cluster.ranged));
  }

  function nestedPlaylistUrls(streams) {
    const nested = new Set();
    for (const stream of streams || []) {
      for (const variant of stream.variants || []) {
        if (variant && variant.url && variant.url !== stream.url) nested.add(variant.url);
      }
    }
    return nested;
  }

  function matchingAudioPlaylist(streams, videoUrl) {
    const want = absoluteHttpUrl(videoUrl) || "";
    if (!want) return "";
    for (const stream of streams || []) {
      for (const variant of (stream && stream.variants) || []) {
        if (variant && variant.url === want && variant.audioUrl) return variant.audioUrl;
      }
    }
    const key = assetKey(want);
    if (!key || !metaFromUrl(want).resolution) return "";
    const candidates = [];
    for (const stream of streams || []) {
      if (!stream || stream.url === want || stream.type !== "HLS") continue;
      if (assetKey(stream.url) !== key || metaFromUrl(stream.url).resolution) continue;
      candidates.push(stream);
    }
    return candidates.length === 1 ? candidates[0].url : "";
  }

  function clusterResolution(cluster) {
    for (const url of cluster.urls || []) {
      const resolution = metaFromUrl(url).resolution;
      if (resolution) return resolution;
    }
    return "";
  }

  function assetKey(url) {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      let index = -1;
      for (let i = 0; i < parts.length; i += 1) {
        if (/^\d{8,}$/.test(parts[i])) index = i;
      }
      if (index < 0) return "";
      return `${parsed.origin}/${parts.slice(0, index + 1).join("/")}`;
    } catch {
      return "";
    }
  }

  function combineRenditions(clusters) {
    const groups = new Map();
    const alone = [];
    for (const cluster of clusters) {
      const key = assetKey(cluster.urls[0] || "");
      const decorated = { ...cluster, resolution: clusterResolution(cluster), paired: false };
      if (!key) {
        alone.push(decorated);
        continue;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(decorated);
    }
    const combined = [];
    for (const group of groups.values()) {
      const videos = group.filter((cluster) => cluster.resolution);
      const audios = group.filter((cluster) => !cluster.resolution);
      if (!videos.length || !audios.length) {
        combined.push(...group);
        continue;
      }
      videos.sort((a, b) => (b.size || 0) - (a.size || 0));
      audios.sort((a, b) => (b.size || 0) - (a.size || 0));
      const video = videos[0];
      const audio = audios[0];
      const urls = [];
      const seen = new Set();
      for (const url of video.urls.concat(audio.urls)) {
        if (seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
      }
      combined.push({
        urls,
        count: (video.count || 0) + (audio.count || 0),
        size: (video.size || 0) + (audio.size || 0),
        resolution: video.resolution,
        paired: true,
        hasInit: !!(video.hasInit && audio.hasInit)
      });
      combined.push(...videos.slice(1), ...audios.slice(1));
    }
    return combined.concat(alone).sort((a, b) => (b.size || 0) - (a.size || 0) || String(a.urls[0]).localeCompare(String(b.urls[0])));
  }

  function pixelArea(resolution) {
    const value = validResolution(resolution);
    if (!value) return 0;
    const parts = value.split("x");
    return Number(parts[0]) * Number(parts[1]);
  }

  function isWholeFile(url) {
    return pathOrder(url) == null && !byteRangeOf(url);
  }

  function fragmentsHaveInit(urls) {
    const streams = (urls || []).map((url) => ({ url, size: null }));
    const clusters = clusterFragments(streams);
    return clusters.length > 0 && clusters.every((cluster) => cluster.hasInit);
  }

  // A captured fragment list can omit the initialization segment. The page may
  // already name a complete file, or a playlist, for the same asset.
  function recoveryForCluster(streams, urls) {
    const keys = new Set();
    for (const url of urls || []) {
      const key = assetKey(url);
      if (key) keys.add(key);
    }
    if (keys.size !== 1) return null;
    const key = [...keys][0];
    let wanted = "";
    for (const url of urls || []) {
      const resolution = metaFromUrl(url).resolution;
      if (resolution) {
        wanted = resolution;
        break;
      }
    }
    const files = [];
    const playlists = [];
    for (const stream of streams || []) {
      if (!stream || !stream.url || assetKey(stream.url) !== key) continue;
      if ((urls || []).includes(stream.url)) continue;
      if (stream.type === "HLS") {
        playlists.push(stream);
        continue;
      }
      if ((stream.type === "MP4" || stream.type === "WebM" || stream.type === "Video") && isWholeFile(stream.url)) {
        files.push(stream);
      }
    }
    if (files.length) {
      files.sort((a, b) => {
        const ar = a.resolution || metaFromUrl(a.url).resolution || "";
        const br = b.resolution || metaFromUrl(b.url).resolution || "";
        const am = wanted && ar === wanted ? 1 : 0;
        const bm = wanted && br === wanted ? 1 : 0;
        if (am !== bm) return bm - am;
        const area = pixelArea(br) - pixelArea(ar);
        if (area) return area;
        return (b.size || 0) - (a.size || 0);
      });
      return { kind: "file", url: files[0].url };
    }
    if (!playlists.length) return null;
    playlists.sort((a, b) => (b.variants || []).length - (a.variants || []).length || a.url.length - b.url.length);
    const chosen = playlists[0];
    return {
      kind: "playlist",
      url: chosen.url,
      audioUrl: matchingAudioPlaylist(streams, chosen.url) || ""
    };
  }

  function presentMedia(streams) {
    const list = Array.isArray(streams) ? streams : [];
    const clusters = combineRenditions(clusterFragments(list).map((cluster) => ({
      ...cluster,
      resolution: clusterResolution(cluster)
    })));
    const consumed = new Set();
    for (const cluster of clusters) {
      for (const url of cluster.urls) consumed.add(url);
    }
    const nested = nestedPlaylistUrls(list);
    const primary = list.filter((stream) => (
      stream && stream.type !== "Segment" && !consumed.has(stream.url) && !nested.has(stream.url)
    ));
    const fragments = list.filter((stream) => stream && (stream.type === "Segment" || consumed.has(stream.url)));
    const playable = primary.length + clusters.length;
    return { clusters, primary, fragments, count: playable || list.length };
  }

  function assembledFilename(pageTitle, index, total, date) {
    const title = slugTitle(pageTitle) || "video";
    const suffix = total > 1 ? `_${index + 1}` : "";
    return sanitizeFilename(`${title}${suffix}_${stamp(date)}.mp4`);
  }

  const MEDIA_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf", "edts"]);

  function fourcc(bytes, offset) {
    if (offset + 4 > bytes.length) return "";
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  }

  function walkBoxes(bytes, start, end, visit) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const type = fourcc(bytes, offset + 4);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) return;
        const large = view.getBigUint64(offset + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return;
        size = Number(large);
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) return;
      visit({ type, offset, size, header, view });
      if (MEDIA_CONTAINERS.has(type)) walkBoxes(bytes, offset + header, offset + size, visit);
      offset += size;
    }
  }

  function inspectFragment(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    const boxes = new Set();
    const trackIds = new Set();
    const handlers = new Set();
    let decodeTime = null;
    if (bytes.length >= 8) {
      walkBoxes(bytes, 0, bytes.length, (box) => {
        boxes.add(box.type);
        if (box.type === "tkhd") {
          const version = bytes[box.offset + box.header];
          const idOffset = box.offset + box.header + 4 + (version === 1 ? 16 : 8);
          if (idOffset + 4 <= box.offset + box.size) trackIds.add(box.view.getUint32(idOffset));
        } else if (box.type === "tfhd") {
          const idOffset = box.offset + box.header + 4;
          if (idOffset + 4 <= box.offset + box.size) trackIds.add(box.view.getUint32(idOffset));
        } else if (box.type === "tfdt") {
          const version = bytes[box.offset + box.header];
          const timeOffset = box.offset + box.header + 4;
          let time = null;
          if (version === 1 && timeOffset + 8 <= box.offset + box.size) time = Number(box.view.getBigUint64(timeOffset));
          else if (timeOffset + 4 <= box.offset + box.size) time = box.view.getUint32(timeOffset);
          if (time != null && (decodeTime == null || time < decodeTime)) decodeTime = time;
        } else if (box.type === "hdlr") {
          const typeOffset = box.offset + box.header + 8;
          if (typeOffset + 4 <= box.offset + box.size) {
            const handler = fourcc(bytes, typeOffset);
            if (handler === "vide" || handler === "soun") handlers.add(handler);
          }
        }
      });
    }
    const hasMoov = boxes.has("moov");
    const hasMoof = boxes.has("moof");
    const hasMdat = boxes.has("mdat");
    let kind = "unknown";
    if (hasMoov && hasMoof) kind = "hybrid";
    else if (hasMoov && hasMdat) kind = "progressive";
    else if (hasMoov) kind = "init";
    else if (hasMoof || hasMdat) kind = "media";
    return {
      kind,
      trackIds: [...trackIds],
      handlers: [...handlers],
      decodeTime
    };
  }

  function urlAffinity(a, b) {
    const left = String(a || "");
    const right = String(b || "");
    let index = 0;
    while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
    let score = index;
    try {
      const leftParts = new URL(left).pathname.split("/").filter(Boolean);
      const rightParts = new URL(right).pathname.split("/").filter(Boolean);
      let tail = 0;
      while (
        tail < leftParts.length
        && tail < rightParts.length
        && leftParts[leftParts.length - 1 - tail] === rightParts[rightParts.length - 1 - tail]
      ) tail += 1;
      // A shared filename outranks a shared directory prefix. Byte-range slices of one
      // file differ near the start of the path and keep the same name at the end.
      score += tail * 10000;
    } catch {
      /* The shared prefix still applies. */
    }
    return score;
  }

  function trackKey(item) {
    if (!item || !item.trackIds || !item.trackIds.length) return "";
    return item.trackIds.slice().sort((a, b) => a - b).join(",");
  }

  function trackLabel(item) {
    const handlers = (item && item.handlers) || [];
    if (handlers.includes("soun") && !handlers.includes("vide")) return "audio";
    return "video";
  }

  function chooseInit(item, inits) {
    if (!inits.length) return null;
    const ids = item.trackIds || [];
    let candidates = inits;
    if (ids.length) {
      const exact = inits.filter((init) => {
        const theirs = init.trackIds || [];
        return theirs.length === ids.length && ids.every((id) => theirs.includes(id));
      });
      const overlap = inits.filter((init) => {
        const theirs = init.trackIds || [];
        return !theirs.length || ids.some((id) => theirs.includes(id));
      });
      if (exact.length) candidates = exact;
      else if (overlap.length) candidates = overlap;
      else return null;
    }
    if (candidates.length === 1) return candidates[0];
    const sample = item.url || "";
    return candidates
      .slice()
      .sort((a, b) => urlAffinity(b.url, sample) - urlAffinity(a.url, sample) || a.index - b.index)[0];
  }

  function orderFragments(items) {
    const byTime = new Map();
    const untimed = [];
    for (const item of items) {
      if (item.decodeTime == null) {
        untimed.push(item);
        continue;
      }
      const previous = byTime.get(item.decodeTime);
      if (!previous || (item.size || 0) > (previous.size || 0)) byTime.set(item.decodeTime, item);
    }
    const ordered = [...byTime.values()].sort((a, b) => a.decodeTime - b.decodeTime || a.index - b.index);
    untimed.sort((a, b) => (sequenceNumber(a.url) ?? 0) - (sequenceNumber(b.url) ?? 0) || String(a.url).localeCompare(String(b.url)));
    return ordered.concat(untimed);
  }

  function planAssembly(items) {
    const list = items || [];
    const progressive = list.filter((item) => item.kind === "progressive");
    const inits = list.filter((item) => item.kind === "init");
    const media = list.filter((item) => item.kind === "media" || item.kind === "hybrid");
    if (!media.length && progressive.length) {
      return { files: progressive.map((item) => ({ parts: [item.index], label: trackLabel(item) })), warning: "" };
    }
    if (!media.length && inits.length) {
      return {
        files: [],
        error: "Only an initialization segment was found. Play the video so the rest of the fragments can be captured, then try again."
      };
    }
    if (!media.length) {
      return { files: [], error: "These fragments could not be read as media." };
    }

    const hybridByTrack = new Map();
    for (const item of media) {
      if (item.kind !== "hybrid") continue;
      const key = trackKey(item) || `hybrid:${item.index}`;
      if (!hybridByTrack.has(key)) hybridByTrack.set(key, []);
      hybridByTrack.get(key).push(item);
    }

    const groups = new Map();
    let missingInit = false;
    for (const item of media) {
      if (item.kind === "hybrid") continue;
      const key = trackKey(item);
      if (key && hybridByTrack.has(key)) {
        const groupKey = `hybrid:${key}`;
        if (!groups.has(groupKey)) groups.set(groupKey, { init: null, hybrids: hybridByTrack.get(key), items: [] });
        groups.get(groupKey).items.push(item);
        continue;
      }
      const init = chooseInit(item, inits);
      if (!init) {
        missingInit = true;
        continue;
      }
      const groupKey = `init:${init.index}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { init, hybrids: [], items: [] });
      groups.get(groupKey).items.push(item);
    }
    for (const [key, hybrids] of hybridByTrack) {
      const groupKey = key.startsWith("hybrid:") ? key : `hybrid:${key}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { init: null, hybrids, items: [] });
    }

    if (missingInit || !groups.size) {
      return {
        files: [],
        error: "These are media fragments, not a complete video. The initialization segment was not captured. Play the video from the start and scan again, or turn on continuous detection before playback."
      };
    }

    const files = [];
    for (const group of groups.values()) {
      const hybrids = (group.hybrids || []).slice().sort((a, b) => (a.decodeTime ?? 0) - (b.decodeTime ?? 0) || a.index - b.index);
      const sequence = hybrids.concat(orderFragments(group.items));
      if (!sequence.length) continue;
      const parts = [];
      if (group.init) parts.push(group.init.index);
      for (const item of sequence) parts.push(item.index);
      files.push({ parts, label: trackLabel(group.init || hybrids[0] || sequence[0]) });
    }
    files.sort((a, b) => Number(a.label === "audio") - Number(b.label === "audio"));
    if (!files.length) {
      return { files: [], error: "These fragments could not be joined." };
    }
    const labels = new Set(files.map((file) => file.label));
    const warning = files.length > 1 && labels.has("audio") && labels.has("video")
      ? "Audio and video arrived as separate tracks, so they were saved as two files."
      : "";
    return { files, warning };
  }

  function listBoxes(bytes, start, end) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const list = [];
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const type = fourcc(bytes, offset + 4);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        const large = view.getBigUint64(offset + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
        size = Number(large);
        header = 16;
      } else if (size === 0) size = end - offset;
      if (size < header || offset + size > end) break;
      list.push({ type, offset, size, header });
      offset += size;
    }
    return list;
  }

  function sliceBox(bytes, offset, size) {
    const out = new Uint8Array(size);
    out.set(bytes.subarray(offset, offset + size));
    return out;
  }

  function concatParts(parts) {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function wrapBox(type, children) {
    const body = concatParts(children);
    const out = new Uint8Array(8 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, out.length);
    out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
    out.set(body, 8);
    return out;
  }

  function boxTrackId(bytes, box) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (box.type === "tkhd") {
      const version = bytes[box.offset + box.header];
      const idOffset = box.offset + box.header + 4 + (version === 1 ? 16 : 8);
      if (idOffset + 4 <= box.offset + box.size) return view.getUint32(idOffset);
    }
    if (box.type === "tfhd" || box.type === "trex") {
      const idOffset = box.offset + box.header + 4;
      if (idOffset + 4 <= box.offset + box.size) return view.getUint32(idOffset);
    }
    return null;
  }

  function writeTrackId(bytes, box, id) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (box.type === "tkhd") {
      const version = bytes[box.offset + box.header];
      const idOffset = box.offset + box.header + 4 + (version === 1 ? 16 : 8);
      if (idOffset + 4 <= box.offset + box.size) view.setUint32(idOffset, id);
    } else if (box.type === "tfhd" || box.type === "trex") {
      const idOffset = box.offset + box.header + 4;
      if (idOffset + 4 <= box.offset + box.size) view.setUint32(idOffset, id);
    }
  }

  function retargetFragment(input, fromId, toId) {
    const bytes = input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(input || 0);
    if (fromId === toId) return bytes;
    walkBoxes(bytes, 0, bytes.length, (box) => {
      if (box.type !== "tkhd" && box.type !== "tfhd" && box.type !== "trex") return;
      if (boxTrackId(bytes, box) === fromId) writeTrackId(bytes, box, toId);
    });
    return bytes;
  }

  function handlerOf(bytes) {
    let handler = "";
    walkBoxes(bytes, 0, bytes.length, (box) => {
      if (box.type !== "hdlr") return;
      const typeOffset = box.offset + box.header + 8;
      if (typeOffset + 4 <= box.offset + box.size) handler = fourcc(bytes, typeOffset);
    });
    return handler;
  }

  function mergeFragmentInits(videoInit, audioInit) {
    const video = videoInit instanceof Uint8Array ? videoInit : new Uint8Array(videoInit || 0);
    let audio = audioInit instanceof Uint8Array ? audioInit : new Uint8Array(audioInit || 0);
    const videoTracks = [];
    walkBoxes(video, 0, video.length, (box) => {
      if (box.type === "tkhd") {
        const id = boxTrackId(video, box);
        if (id != null) videoTracks.push(id);
      }
    });
    let audioFrom = null;
    walkBoxes(audio, 0, audio.length, (box) => {
      if (box.type === "tkhd" && audioFrom == null) audioFrom = boxTrackId(audio, box);
    });
    if (audioFrom == null) return null;
    if (handlerOf(audio) === "vide" || handlerOf(video) === "soun") return null;
    let audioTo = audioFrom;
    if (videoTracks.includes(audioFrom)) {
      audioTo = videoTracks.reduce((max, id) => Math.max(max, id), 0) + 1;
      audio = retargetFragment(audio, audioFrom, audioTo);
    }
    const audioMoov = listBoxes(audio, 0, audio.length).find((box) => box.type === "moov");
    if (!audioMoov) return null;
    const audioKids = listBoxes(audio, audioMoov.offset + audioMoov.header, audioMoov.offset + audioMoov.size);
    const audioTrak = audioKids.find((box) => box.type === "trak");
    const audioMvex = audioKids.find((box) => box.type === "mvex");
    if (!audioTrak) return null;
    let audioTrex = null;
    if (audioMvex) {
      const trex = listBoxes(audio, audioMvex.offset + audioMvex.header, audioMvex.offset + audioMvex.size)
        .find((box) => box.type === "trex");
      if (trex) audioTrex = sliceBox(audio, trex.offset, trex.size);
    }
    const videoMoov = listBoxes(video, 0, video.length).find((box) => box.type === "moov");
    if (!videoMoov) return null;
    const moovKids = listBoxes(video, videoMoov.offset + videoMoov.header, videoMoov.offset + videoMoov.size);
    const before = [];
    const after = [];
    let mvexBytes = null;
    let seenMvex = false;
    for (const kid of moovKids) {
      const slice = sliceBox(video, kid.offset, kid.size);
      if (kid.type === "mvex") {
        mvexBytes = slice;
        seenMvex = true;
      } else if (!seenMvex) before.push(slice);
      else after.push(slice);
    }
    const moovChildren = before.concat([sliceBox(audio, audioTrak.offset, audioTrak.size)]);
    if (mvexBytes) {
      const children = listBoxes(mvexBytes, 8, mvexBytes.length).map((kid) => sliceBox(mvexBytes, kid.offset, kid.size));
      if (audioTrex) children.push(audioTrex);
      moovChildren.push(wrapBox("mvex", children));
    }
    moovChildren.push(...after);
    const moov = wrapBox("moov", moovChildren);
    const top = listBoxes(video, 0, video.length).map((kid) => (
      kid.type === "moov" ? moov : sliceBox(video, kid.offset, kid.size)
    ));
    return { bytes: concatParts(top), audioFrom, audioTo };
  }

  function readUmpVarint(bytes, offset) {
    if (offset >= bytes.length) return null;
    const first = bytes[offset];
    const width = first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5;
    if (offset + width > bytes.length) return null;
    let value = 0;
    if (width === 1) value = first;
    else if (width === 2) value = (first & 0x3f) | (bytes[offset + 1] << 6);
    else if (width === 3) value = (first & 0x1f) | (bytes[offset + 1] << 5) | (bytes[offset + 2] << 13);
    else if (width === 4) {
      value = (first & 0x0f)
        | (bytes[offset + 1] << 4)
        | (bytes[offset + 2] << 12)
        | (bytes[offset + 3] << 20);
    } else {
      value = bytes[offset + 1]
        | (bytes[offset + 2] << 8)
        | (bytes[offset + 3] << 16)
        | (bytes[offset + 4] << 24);
      value >>>= 0;
    }
    return { value, offset: offset + width };
  }

  function readPbVarint(bytes, offset) {
    let value = 0;
    let shift = 0;
    while (offset < bytes.length && shift <= 63) {
      const byte = bytes[offset++];
      value += (byte & 0x7f) * (2 ** shift);
      if ((byte & 0x80) === 0) return { value, offset };
      shift += 7;
    }
    return null;
  }

  function readPbFields(bytes) {
    const fields = [];
    let offset = 0;
    while (offset < bytes.length) {
      const key = readPbVarint(bytes, offset);
      if (!key) break;
      const field = Math.floor(key.value / 8);
      const wire = key.value % 8;
      if (!field || field > 200) break;
      offset = key.offset;
      if (wire === 0) {
        const val = readPbVarint(bytes, offset);
        if (!val) break;
        fields.push({ field, value: val.value });
        offset = val.offset;
      } else if (wire === 2) {
        const len = readPbVarint(bytes, offset);
        if (!len || len.value < 0 || len.offset + len.value > bytes.length) break;
        fields.push({ field, bytes: bytes.subarray(len.offset, len.offset + len.value) });
        offset = len.offset + len.value;
      } else if (wire === 5) {
        if (offset + 4 > bytes.length) break;
        offset += 4;
      } else if (wire === 1) {
        if (offset + 8 > bytes.length) break;
        offset += 8;
      } else break;
    }
    return fields;
  }

  function pbText(field) {
    if (!field || !field.bytes || !field.bytes.length) return "";
    for (const byte of field.bytes) {
      if (byte < 32 || byte > 126) return "";
    }
    return new TextDecoder().decode(field.bytes);
  }

  function pbHex(field) {
    if (!field || !field.bytes) return "";
    let hex = "";
    for (const byte of field.bytes) hex += byte.toString(16).padStart(2, "0");
    return hex;
  }

  function fieldVar(fields, number) {
    const found = fields.find((item) => item.field === number && item.value != null);
    return found ? found.value : null;
  }

  function fieldBytes(fields, number) {
    const found = fields.find((item) => item.field === number && item.bytes);
    return found ? found : null;
  }

  function mediaMagic(bytes) {
    if (!bytes || bytes.length < 8) return false;
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return true;
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
    return false;
  }

  function boxResolution(bytes) {
    let found = null;
    if (!bytes || bytes.length < 16 || bytes[4] !== 0x66) return null;
    walkBoxes(bytes, 0, bytes.length, (box) => {
      if (found || box.type !== "tkhd") return;
      const version = bytes[box.offset + box.header];
      const widthAt = box.offset + box.header + (version === 1 ? 88 : 76);
      if (widthAt + 8 > box.offset + box.size) return;
      const width = box.view.getUint32(widthAt) >> 16;
      const height = box.view.getUint32(widthAt + 4) >> 16;
      const resolution = validResolution(`${width}x${height}`);
      if (resolution) found = resolution;
    });
    return found;
  }

  // application/vnd.yt-ump is a multipart envelope. Part 20 describes a segment,
  // part 21 carries the bytes, and part 42 names the codec. The same request
  // holds every track, so each track is returned on its own.
  function parseUmp(input) {
    const bytes = input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : null;
    if (!bytes || bytes.length < 8 || bytes.length > 64 * 1024 * 1024) return null;
    const formats = new Map();
    const headers = new Map();
    const pieces = [];
    let sawMedia = false;
    let offset = 0;
    while (offset + 2 <= bytes.length) {
      const typeInfo = readUmpVarint(bytes, offset);
      if (!typeInfo) break;
      const sizeInfo = readUmpVarint(bytes, typeInfo.offset);
      if (!sizeInfo) break;
      const type = typeInfo.value;
      const size = sizeInfo.value;
      if (type > 80 || size < 0 || sizeInfo.offset + size > bytes.length) break;
      const payload = bytes.subarray(sizeInfo.offset, sizeInfo.offset + size);
      offset = sizeInfo.offset + size;
      if (type === 42) {
        const fields = readPbFields(payload);
        const id = pbHex(fieldBytes(fields, 2));
        const mime = cleanMime(pbText(fieldBytes(fields, 5)));
        const durationMs = fieldVar(fields, 3);
        if (id && mime) formats.set(id, { mime, durationMs });
      } else if (type === 20) {
        const fields = readPbFields(payload);
        const headerId = fieldVar(fields, 1);
        if (headerId == null) continue;
        headers.set(headerId, {
          headerId,
          videoId: pbText(fieldBytes(fields, 2)) || "media",
          itag: fieldVar(fields, 3) || 0,
          lmt: fieldVar(fields, 4) || 0,
          start: fieldVar(fields, 6) || 0,
          sequence: fieldVar(fields, 9) || 0,
          formatId: pbHex(fieldBytes(fields, 13))
        });
      } else if (type === 21 && payload.length) {
        const idInfo = readUmpVarint(payload, 0);
        if (!idInfo) continue;
        const header = headers.get(idInfo.value);
        const chunk = payload.subarray(idInfo.offset);
        if (!header || !chunk.length || chunk[0] === 0x1f && chunk[1] === 0x8b) continue;
        sawMedia = true;
        pieces.push({ ...header, bytes: chunk });
      }
    }
    if (!sawMedia || !pieces.length) return null;
    const groups = new Map();
    for (const piece of pieces) {
      const key = `${piece.videoId}:${piece.itag}:${piece.lmt}:${piece.formatId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(piece);
    }
    const tracks = [];
    for (const group of groups.values()) {
      group.sort((a, b) => a.start - b.start || a.sequence - b.sequence || a.headerId - b.headerId);
      const joined = concatParts(group.map((piece) => piece.bytes));
      if (!mediaMagic(joined)) continue;
      const sample = group[0];
      const format = formats.get(sample.formatId) || null;
      const mime = (format && format.mime) || (joined[0] === 0x1a ? "audio/webm" : "video/mp4");
      const type = typeFromMime(mime) || (mime.startsWith("audio/") ? "Audio" : "MP4");
      const durationMs = format && format.durationMs;
      const duration = durationMs > 0 ? durationMs / 1000 : null;
      const audio = mime.startsWith("audio/") || type === "Audio";
      const captureKey = cleanCaptureKey(`ump-${sample.videoId}-${sample.itag}-${sample.lmt}`);
      if (!captureKey) continue;
      tracks.push({
        captureKey,
        mime,
        type,
        bytes: joined,
        size: joined.byteLength,
        duration: duration && duration < 86400 * 2 ? duration : null,
        resolution: audio ? null : boxResolution(joined),
        label: audio ? "Audio from this page" : "Video from this page"
      });
    }
    return tracks.length ? tracks : null;
  }

  function historyIdentity(entry) {
    if (!entry) return "";
    if (entry.mode === "file") return `file:${entry.url}`;
    if (entry.mode === "playlist") return `playlist:${entry.url}|${entry.audioUrl || ""}`;
    if (entry.mode === "fragments") return `fragments:${(entry.urls || []).join("\n")}`;
    if (entry.mode === "capture") return `capture:${entry.filename}|${entry.pageTitle || ""}`;
    return "";
  }

  function normalizeHistoryEntry(input, now) {
    if (!input || typeof input !== "object") return null;
    const rawName = typeof input.filename === "string" ? input.filename : "";
    if (!rawName.trim()) return null;
    const filename = sanitizeFilename(rawName);
    if (!filename) return null;
    const at = Number(input.at) > 0 ? Number(input.at) : (now || Date.now());
    const pageTitle = typeof input.pageTitle === "string" ? input.pageTitle.slice(0, 180) : "";
    const id = typeof input.id === "string" && /^[\w-]{4,80}$/.test(input.id)
      ? input.id
      : `${at}-${Math.random().toString(36).slice(2, 10)}`;
    if (input.mode === "file" || input.mode === "playlist") {
      const url = absoluteHttpUrl(input.url);
      if (!url) return null;
      return {
        id,
        at,
        mode: input.mode,
        filename,
        url,
        audioUrl: input.mode === "playlist" ? (absoluteHttpUrl(input.audioUrl) || "") : "",
        urls: [],
        pageTitle
      };
    }
    if (input.mode === "capture") {
      return { id, at, mode: "capture", filename, url: "", audioUrl: "", urls: [], pageTitle };
    }
    if (input.mode !== "fragments") return null;
    const urls = [];
    const seen = new Set();
    for (const raw of Array.isArray(input.urls) ? input.urls : []) {
      const href = absoluteHttpUrl(raw);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      urls.push(href);
      if (urls.length >= 400) break;
    }
    if (!urls.length) return null;
    return { id, at, mode: "fragments", filename, url: "", audioUrl: "", urls, pageTitle };
  }

  function loadHistory(list) {
    const out = [];
    const indexByKey = new Map();
    for (const row of Array.isArray(list) ? list : []) {
      const item = normalizeHistoryEntry(row);
      if (!item) continue;
      const key = historyIdentity(item);
      if (!key) continue;
      const previous = indexByKey.get(key);
      if (previous == null) {
        indexByKey.set(key, out.length);
        out.push(item);
        continue;
      }
      if (item.at >= out[previous].at) out[previous] = item;
    }
    out.sort((a, b) => b.at - a.at || a.filename.localeCompare(b.filename));
    return out.slice(0, MAX_HISTORY);
  }

  function rememberHistory(list, entry, now) {
    const current = loadHistory(list);
    const item = normalizeHistoryEntry(entry, now);
    if (!item) return current;
    const key = historyIdentity(item);
    return [item].concat(current.filter((row) => historyIdentity(row) !== key)).slice(0, MAX_HISTORY);
  }

  return {
    EXT,
    TYPE_EXT,
    REQUEST_TYPES,
    MAX_STREAMS,
    MAX_HISTORY,
    loadHistory,
    rememberHistory,
    RESOURCE_BUFFER,
    classifyUrl,
    streamsFromResources,
    mediaUrlsInText,
    mediaUrlsInDocument,
    fragmentsHaveInit,
    recoveryForCluster,
    typeFromMime,
    blockedMime,
    metaFromUrl,
    headerValue,
    sizeFromHeaders,
    normalizeCandidate,
    mergeStream,
    upsertStream,
    trimStreams,
    parseHls,
    parseDash,
    applyPlaylist,
    suggestFilename,
    sanitizeFilename,
    formatSize,
    formatDuration,
    formatBitrate,
    sorted,
    webRequestPlan,
    isCapturableUrl,
    finitePositive,
    absoluteHttpUrl,
    capturedMediaUrl,
    parseUmp,
    clusterFragments,
    presentMedia,
    chooseHlsRendition,
    matchingAudioPlaylist,
    assembledFilename,
    inspectFragment,
    planAssembly,
    mergeFragmentInits,
    retargetFragment,
    sequenceNumber
  };
});

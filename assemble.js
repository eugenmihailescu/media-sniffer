/* Joins fragmented MP4 pieces into a playable file.
   Runs in an offscreen document because a service worker cannot create blob URLs.
   The offscreen document may use only chrome.runtime, so the service worker
   starts the download from the blob URL this page creates. */
(function () {
  "use strict";

  const MAX_BYTES = 800 * 1024 * 1024;

  function outputName(base, label, multiple) {
    const safe = MS.sanitizeFilename(/\.mp4$/i.test(base) ? base : `${base}.mp4`);
    if (!multiple) return safe;
    if (label === "audio") return safe.replace(/\.mp4$/i, "_audio.mp4");
    return safe.replace(/\.mp4$/i, "_video.mp4");
  }

  function report(tabId, text, done, total) {
    chrome.runtime.sendMessage({ type: "assemble-progress", tabId, text, done, total }).catch(() => {});
  }

  async function fetchPart(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(url, {
        credentials: "include",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error("A fragment could not be fetched. It may have expired. Play the video and scan again.");
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("A fragment took too long to download. Play the video and scan again.");
      }
      if (error && typeof error.message === "string" && error.message.startsWith("A fragment")) throw error;
      throw new Error("A fragment could not be fetched. It may have expired. Play the video and scan again.");
    } finally {
      clearTimeout(timer);
    }
  }

  const heldBlobs = new Map();

  function holdBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const timer = setTimeout(() => releaseBlob(url), 10 * 60 * 1000);
    heldBlobs.set(url, timer);
    return { url, filename };
  }

  function releaseBlob(url) {
    if (!heldBlobs.has(url)) return;
    clearTimeout(heldBlobs.get(url));
    heldBlobs.delete(url);
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* The URL was already revoked. */
    }
  }

  async function fetchText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(url, {
        credentials: "include",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error("A playlist could not be fetched. It may have expired. Play the video and scan again.");
      }
      return await response.text();
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("A playlist took too long to download. Play the video and scan again.");
      }
      if (error && typeof error.message === "string" && error.message.startsWith("A playlist")) throw error;
      throw new Error("A playlist could not be fetched. It may have expired. Play the video and scan again.");
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolvePlaylist(url, audioUrl, depth) {
    if (depth > 3) throw new Error("This playlist can't be saved as one MP4.");
    const parsed = MS.parseHls(await fetchText(url), url);
    if (parsed.segments && parsed.segments.length) {
      if (!parsed.map || !/^https?:/i.test(parsed.map)) {
        throw new Error("This playlist is not a fragmented MP4, so it can't be saved as one file.");
      }
      const urls = [parsed.map].concat(parsed.segments).filter((item) => /^https?:/i.test(item || ""));
      if (audioUrl && depth === 0) return urls.concat(await resolvePlaylist(audioUrl, "", depth + 1));
      return urls;
    }
    const choice = MS.chooseHlsRendition(parsed);
    if (!choice || !choice.videoUrl) throw new Error("This playlist can't be saved as one MP4.");
    const video = await resolvePlaylist(choice.videoUrl, "", depth + 1);
    if (!choice.audioUrl) return video;
    return video.concat(await resolvePlaylist(choice.audioUrl, "", depth + 1));
  }

  async function run(message) {
    if (message.bytes) {
      const raw = message.bytes instanceof Uint8Array ? message.bytes : new Uint8Array(message.bytes);
      if (!raw.byteLength) throw new Error("This capture expired. Play the video and scan again.");
      if (raw.byteLength > MAX_BYTES) throw new Error("This capture is too large to save in the browser.");
      const copy = new Uint8Array(raw.byteLength);
      copy.set(raw);
      const name = MS.sanitizeFilename(message.filename || "media.bin");
      const blob = new Blob([copy], { type: message.mime || "application/octet-stream" });
      return { ok: true, count: 1, warning: "", files: [holdBlob(blob, name)] };
    }
    if (message.playlist) report(message.tabId, "Reading playlist…", 0, 0);
    let urls = Array.isArray(message.urls) ? message.urls : [];
    if (message.playlist) urls = await resolvePlaylist(message.playlist, message.audioUrl || "", 0);
    if (urls.length > 3000) throw new Error("Too many fragments to join at once.");
    const bytes = [];
    let total = 0;
    for (let index = 0; index < urls.length; index += 1) {
      report(message.tabId, `Fetching fragment ${index + 1} of ${urls.length}…`, index, urls.length);
      const part = await fetchPart(urls[index]);
      total += part.length;
      if (total > MAX_BYTES) throw new Error("These fragments are too large to join in the browser.");
      bytes.push(part);
    }
    report(message.tabId, "Joining fragments into an MP4…", urls.length, urls.length);
    const inspections = bytes.map((part, index) => Object.assign({
      index,
      url: urls[index],
      size: part.length
    }, MS.inspectFragment(part)));
    const plan = MS.planAssembly(inspections);
    if (!plan || plan.error || !plan.files || !plan.files.length) {
      throw new Error((plan && plan.error) || "These fragments could not be joined.");
    }
    const videoFile = plan.files.find((file) => file.label === "video");
    const audioFile = plan.files.find((file) => file.label === "audio");
    if (videoFile && audioFile && plan.files.length === 2) {
      const vInit = videoFile.parts.find((index) => inspections[index].kind === "init");
      const aInit = audioFile.parts.find((index) => inspections[index].kind === "init");
      const merged = vInit != null && aInit != null ? MS.mergeFragmentInits(bytes[vInit], bytes[aInit]) : null;
      if (merged) {
        const media = [];
        for (const index of videoFile.parts) {
          if (inspections[index].kind !== "init") media.push(bytes[index]);
        }
        for (const index of audioFile.parts) {
          if (inspections[index].kind === "init") continue;
          media.push(MS.retargetFragment(bytes[index], merged.audioFrom, merged.audioTo));
        }
        const blob = new Blob([merged.bytes].concat(media), { type: "video/mp4" });
        return {
          ok: true,
          count: 1,
          warning: "",
          files: [holdBlob(blob, outputName(message.filename, "", false))]
        };
      }
    }
    const multiple = plan.files.length > 1;
    const files = [];
    for (const file of plan.files) {
      const blob = new Blob(file.parts.map((index) => bytes[index]), { type: "video/mp4" });
      files.push(holdBlob(blob, outputName(message.filename, file.label, multiple)));
    }
    return { ok: true, count: files.length, warning: plan.warning || "", files };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== "offscreen") return;
    if (message.type === "revoke-blob") {
      releaseBlob(message.url);
      sendResponse({ ok: true });
      return;
    }
    if (message.type !== "assemble-run") return;
    if (sender && sender.tab) return;
    run(message).then(sendResponse, (error) => {
      sendResponse({ ok: false, error: (error && error.message) || "Couldn’t join the fragments." });
    });
    return true;
  });
})();

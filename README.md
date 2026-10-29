# MediaSniffer

Manifest V3 Chrome extension that finds video and audio on the current tab and downloads it. Detection uses only generic browser signals: network requests, media elements, resource timing, and common media types. It does not contain site-specific code.

The default is quiet. Nothing is collected until you scan a tab, or until you turn on continuous detection for that tab.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Choose this folder (`media-sniffer`).

Pin MediaSniffer if you want it in the toolbar. Open a page, click the icon, then **Scan this tab**.

Reload a tab once after installing or updating. That enlarges the page’s resource list before playback, so a later scan can still see an initialization segment or playlist that already finished. The scan itself injects its scripts into the open page.

## How to use

- **Scan this tab** runs one detection pass and keeps listening for about 15 seconds so a player that starts loading can still be caught. The button then becomes **Rescan**.
- **Continuous detection for this tab** stays off until you turn it on. It watches only that tab, including later navigations in the same tab. Closing the tab drops the preference and the collected list.
- Each row shows a filename guess, the kind of stream (MP4, WebM, HLS, DASH, audio, or another video type), and size, duration, resolution, or bitrate when those are known.
- **Download** saves the file with `chrome.downloads` into a `MediaSniffer` folder in your downloads directory.
- **Download history** appears at the bottom right after a save. **Download** on a row repeats that save from the stored file address, playlist, or fragment set. **Back** returns to the media list. History is kept after the tab closes. A signed address can still expire.
- Progressive files are listed first. HLS and DASH manifests are listed too. When a manifest can be read, **Show variants** under that row opens the first level of renditions. **Hide variants** closes it again.
- Fragmented MP4 is offered as **Download MP4**. An HLS playlist is fetched and saved as one MP4: the highest-resolution video rendition, plus the audio rendition that playlist names. Pieces already captured on the tab are joined the same way, including when each piece lives in its own numbered time-range folder or is a byte range of one file, and when the initialization file is a small `.mp4` with a generated name. Matching audio is muxed into that file. The raw fragments stay under “Individual fragments (not playable alone)”.

## How detection works

Three generic mechanisms, all inactive until a scan or a continuous watch:

1. **Network** (`background.js`). `webRequest.onBeforeRequest` and `onCompleted` are registered only while at least one tab is scanning or in continuous mode. One watched tab is filtered in the listener. Requests are kept when their type is `media`, the URL has a common media extension or format parameter, or the response `Content-Type` is a video, audio, HLS, or DASH type.
2. **DOM** (`content.js`). On a scan, every frame walks the document, including open shadow roots, for `video` and `audio`. It reads `currentSrc`, `src`, and `source` children, plus duration and dimensions when the element already knows them. It reads `performance` resource entries for media elements and recognizable media URLs, and media addresses written into the page’s scripts. A separate MAIN-world script (`buffer.js`) runs at the start of each document. It raises the resource list’s size, and it keeps the body of a response whose content type is `application/vnd.yt-ump` (up to 32 MB). It does not send anything until a scan.
3. **Page hook** (`injected.js`). A small MAIN-world script is injected for the scan window, or for as long as continuous mode is on. It observes `fetch`, XHR, `MediaSource.addSourceBuffer`, and `SourceBuffer.appendBuffer`, and it reports media URLs already sitting in the page’s resource list. Playlist responses already downloaded by the page are parsed without a second request. A kept `application/vnd.yt-ump` body is split into the audio and video tracks inside it. The wrappers are removed when the watch ends.

Results are deduplicated by URL and stored per tab in `chrome.storage.session`. The service worker drops that state when the tab closes. Recent downloads are stored separately in `chrome.storage.local` and stay after the tab closes.

## Known limitations

- **DRM / Encrypted Media Extensions.** The browser decrypts inside a CDM. MediaSniffer cannot turn that into a playable download.
- **Pure Media Source buffers.** If a player never requests a URL (samples are generated or decrypted only in memory), there is no file to save. A `blob:` URL on a media element is not a file. Scan again after playback starts, or enable continuous detection so the underlying request can be recorded.
- **Multipart player responses (`application/vnd.yt-ump`).** Some players download audio and video together in one response that is not itself a playable file. The media element then only has a `blob:` address. MediaSniffer keeps that response in the page and, on a scan, lists each track inside it. Reload the tab after installing or updating, then let playback start, so the response is kept. Each track is saved in the container the player received. A video-only MP4 and a separate audio file (often WebM) stay separate. Download history cannot fetch a captured file again after you leave the page. Scan the tab and save it once more.
- **Closed shadow roots** that already exist cannot be inspected. Open shadow roots can.
- **Temporary signed URLs** expire, and some accept only one request. Download soon after a scan. Download history repeats the stored address, so an expired link fails the same way. Reading HLS/DASH variants may fetch the manifest once if the page-world hook did not already see its body.
- **Fragmented MP4 needs its initialization segment.** A lone `.m4s` file is a fragment (`moof` + `mdat`) and will not play by itself. Download MP4 puts the init segment (`ftyp` + `moov`) first and the media fragments in decode order. If those fragments have no init segment, but the page already names a complete file or a playlist for the same item, Download saves that instead. Otherwise nothing is saved and the popup explains how to scan again. Reload the tab after installing or updating, then play and scan, so that earlier request is still in the page’s resource list. Joining fetches each fragment once more, without sending the extension address as the referer, so a URL that has already expired or accepts only one request can still fail.
- **Separate audio and video tracks** are muxed when each track has its own initialization segment and the track ids can be told apart. If that merge fails, they are saved as two MP4 files.
- **MPEG-TS playlists are not remuxed.** An HLS playlist without a fragmented-MP4 initialization segment cannot be saved as one file. DASH manifests are listed, and a direct file URL inside one can be saved, but a DASH playlist is not turned into one file.
- **Requests that already finished.** Recognizable media URLs stay visible to a later scan while they remain in the page’s resource-timing list. Reload the tab after installing or updating so that list is enlarged before playback. A request the browser has already dropped, or one made only inside a worker that started before the scan, is visible only when continuous detection was on at the time.
- **Browser pages** (`chrome://` and similar) cannot be scanned. Local `file://` pages need “Allow access to file URLs” on the extension.
- The optional `fetch` / XHR hook that reports ordinary media URLs is installed only after you scan or enable continuous mode. If the page replaces those functions again, the hook leaves them in place and stops reporting when the watch ends. The document-start script keeps `application/vnd.yt-ump` bodies before that, and still does not send them until a scan.
- The service worker can miss a short gap of network events if Chrome restarts it. Saved results are restored, and listeners are reattached for tabs that are still in continuous mode.

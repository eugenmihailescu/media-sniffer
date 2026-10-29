const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const MS = require("../common.js");

const root = path.join(__dirname, "..");

test("manifest is a quiet MV3 extension", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.version, "1.1.0");
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "downloads", "offscreen", "scripting", "storage", "webRequest"]);
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.equal(manifest.content_scripts.length, 2);
  const idle = manifest.content_scripts.find((script) => script.js.includes("content.js"));
  const early = manifest.content_scripts.find((script) => script.js.includes("buffer.js"));
  assert.deepEqual(idle.matches, ["<all_urls>"]);
  assert.equal(idle.run_at, "document_idle");
  assert.equal(idle.all_frames, true);
  assert.deepEqual(idle.js, ["common.js", "content.js"]);
  assert.deepEqual(early.matches, ["<all_urls>"]);
  assert.equal(early.run_at, "document_start");
  assert.equal(early.world, "MAIN");
  assert.equal(early.all_frames, true);
  assert.deepEqual(early.js, ["buffer.js"]);
  const buffer = fs.readFileSync(path.join(root, "buffer.js"), "utf8");
  assert.match(buffer, /setResourceTimingBufferSize\(5000\)/);
  assert.doesNotMatch(buffer, /fetch\(|sendMessage|webRequest|XMLHttpRequest|chrome\./);
  assert.match(buffer, /application\/vnd\.yt-ump/);
  assert.match(buffer, /__mediaSnifferKept/);
  assert.doesNotMatch(buffer, /youtube|googlevideo|videoplayback/i);
  assert.match(fs.readFileSync(path.join(root, "injected.js"), "utf8"), /setResourceTimingBufferSize\(5000\)/);
  const assemble = fs.readFileSync(path.join(root, "assemble.js"), "utf8");
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  assert.doesNotMatch(assemble, /chrome\.downloads/);
  assert.match(assemble, /URL\.createObjectURL/);
  assert.match(background, /chrome\.downloads\.download/);
  assert.match(background, /revoke-blob/);
  assert.equal(MS.RESOURCE_BUFFER, 5000);
  for (const file of ["background.js", "content.js", "injected.js", "buffer.js", "popup.html", "popup.js", "popup.css", "common.js", "assemble.js", "offscreen.html"]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, file);
  }
});

test("classifies ordinary media URLs and ignores pages", () => {
  assert.equal(MS.classifyUrl("https://cdn.example/a/movie.mp4?token=1").type, "MP4");
  assert.equal(MS.classifyUrl("https://cdn.example/a/clip.webm").type, "WebM");
  assert.equal(MS.classifyUrl("https://cdn.example/hls/master.m3u8?x=1").type, "HLS");
  assert.equal(MS.classifyUrl("https://cdn.example/dash/index.mpd").type, "DASH");
  assert.equal(MS.classifyUrl("https://cdn.example/seg/init.m4s").type, "Segment");
  assert.equal(MS.classifyUrl("https://cdn.example/get?format=mp4&id=1").type, "MP4");
  assert.equal(MS.classifyUrl("https://cdn.example/file?name=episode.m3u8").type, "HLS");
  assert.equal(MS.classifyUrl("https://example.com/article"), null);
  assert.equal(MS.classifyUrl("blob:https://example.com/11111111-1111-1111-1111-111111111111"), null);
  assert.equal(MS.classifyUrl("https://cdn.example/app.js"), null);
});

test("keeps an initialization file found in resource timing", () => {
  const entries = [
    { name: "https://cdn.example/media/12345678/avc/0/0/720x1280/Ab12cd34Ef56.mp4", encodedBodySize: 0 },
    { name: "https://cdn.example/media/12345678/avc/12000/15000/720x1280/Zz98yx76Wv54.m4s", encodedBodySize: 0 },
    { name: "https://cdn.example/media/12345678/playlist.m3u8", encodedBodySize: 400 },
    { name: "https://cdn.example/photo.jpg", initiatorType: "img", encodedBodySize: 10 },
    { name: "https://cdn.example/media/clip", initiatorType: "video", decodedBodySize: 1000 },
    { name: "blob:https://cdn.example/1111" },
    null
  ];
  const rows = MS.streamsFromResources(entries);
  assert.deepEqual(rows.map((row) => row.url), [
    "https://cdn.example/media/12345678/avc/0/0/720x1280/Ab12cd34Ef56.mp4",
    "https://cdn.example/media/12345678/avc/12000/15000/720x1280/Zz98yx76Wv54.m4s",
    "https://cdn.example/media/12345678/playlist.m3u8",
    "https://cdn.example/media/clip"
  ]);
  assert.equal(rows[0].size, null);
  assert.equal(rows[2].size, 400);
  assert.equal(rows[3].resourceType, "media");
  const streams = [];
  for (const item of rows) MS.upsertStream(streams, item);
  const view = MS.presentMedia(streams);
  assert.equal(view.clusters.length, 1);
  assert.equal(view.clusters[0].hasInit, true);
  assert.equal(view.clusters[0].urls[0].includes("/0/0/"), true);
  assert.equal(view.primary.some((stream) => stream.type === "HLS"), true);
});

test("reads media MIME types and rejects documents", () => {
  assert.equal(MS.typeFromMime("application/vnd.apple.mpegurl"), "HLS");
  assert.equal(MS.typeFromMime("application/dash+xml; charset=utf-8"), "DASH");
  assert.equal(MS.typeFromMime("video/mp4"), "MP4");
  assert.equal(MS.typeFromMime("audio/mp4"), "Audio");
  assert.equal(MS.typeFromMime("video/mp2t"), "Segment");
  assert.equal(MS.normalizeCandidate({ url: "https://cdn.example/noext", resourceType: "media" }).type, "Media");
  assert.equal(MS.normalizeCandidate({ url: "https://cdn.example/a.mp4", mime: "text/html" }), null);
  assert.equal(MS.normalizeCandidate({ url: "https://cdn.example/seg/a.m4s", mime: "video/mp4" }).type, "Segment");
  assert.equal(MS.normalizeCandidate({ url: "https://cdn.example/app.js", mime: "application/javascript" }), null);
});

test("dedupes streams and keeps an exact content size", () => {
  const streams = [];
  MS.upsertStream(streams, { url: "https://cdn.example/movie.mp4", size: 1000, source: "dom" });
  MS.upsertStream(streams, {
    url: "https://cdn.example/movie.mp4",
    mime: "audio/mp4",
    size: 5000000,
    sizeFromHeader: true,
    source: "network"
  });
  MS.upsertStream(streams, { url: "https://cdn.example/movie.mp4#t=10", size: 20, source: "dom" });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].type, "Audio");
  assert.equal(streams[0].size, 5000000);
  assert.equal(streams[0].sizeFromHeader, true);
  MS.upsertStream(streams, { url: "https://cdn.example/movie.mp4", size: 10 });
  assert.equal(streams[0].size, 5000000);
});

test("parses an HLS master and a media playlist", () => {
  const master = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720",
    "low/playlist.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080",
    "hi/playlist.m3u8",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",URI="audio.m3u8"'
  ].join("\n");
  const parsed = MS.parseHls(master, "https://cdn.example/hls/master.m3u8");
  assert.equal(parsed.variants.length, 3);
  assert.equal(parsed.variants[1].url, "https://cdn.example/hls/hi/playlist.m3u8");
  assert.equal(parsed.variants[1].resolution, "1920x1080");
  assert.equal(parsed.variants[1].bandwidth, 2560000);
  assert.equal(parsed.variants[2].url, "https://cdn.example/hls/audio.m3u8");
  const linked = [
    "#EXTM3U",
    '#EXT-X-MEDIA:NAME="English",TYPE=AUDIO,GROUP-ID="hi",DEFAULT=YES,URI="a-hi.m3u8"',
    '#EXT-X-MEDIA:NAME="Commentary",TYPE=AUDIO,GROUP-ID="hi",DEFAULT=NO,URI="a-note.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=320x180,AUDIO="lo"',
    "lo.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720,AUDIO="hi"',
    "hi.m3u8",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="lo",URI="a-lo.m3u8"'
  ].join("\n");
  const choice = MS.chooseHlsRendition(MS.parseHls(linked, "https://cdn.example/hls/master.m3u8"));
  assert.equal(choice.videoUrl, "https://cdn.example/hls/hi.m3u8");
  assert.equal(choice.audioUrl, "https://cdn.example/hls/a-hi.m3u8");
  const media = [
    "#EXTM3U",
    '#EXT-X-MAP:URI="init.mp4"',
    "#EXTINF:4.0,",
    "seg1.m4s",
    "#EXTINF:6.0,",
    "seg2.m4s"
  ].join("\n");
  const duration = MS.parseHls(media, "https://cdn.example/hls/hi/playlist.m3u8");
  assert.equal(duration.variants.length, 0);
  assert.equal(duration.duration, 10);
  assert.equal(duration.map, "https://cdn.example/hls/hi/init.mp4");
  assert.deepEqual(duration.segments, [
    "https://cdn.example/hls/hi/seg1.m4s",
    "https://cdn.example/hls/hi/seg2.m4s"
  ]);
  assert.equal(MS.parseHls("#EXTM3U\n#EXTINF:1,\nseg.ts\n", "https://cdn.example/a.m3u8").map, null);
});

test("parses the first level of a DASH manifest", () => {
  const xml = `<?xml version="1.0"?>
    <MPD mediaPresentationDuration="PT1H2M3S">
      <Period>
        <AdaptationSet>
          <Representation id="v1" bandwidth="800000" width="640" height="360">
            <BaseURL>low.mp4</BaseURL>
          </Representation>
          <Representation id="v2" bandwidth="2400000" width="1280" height="720" />
        </AdaptationSet>
      </Period>
    </MPD>`;
  const parsed = MS.parseDash(xml, "https://cdn.example/dash/index.mpd");
  assert.equal(parsed.duration, 3723);
  assert.equal(parsed.variants.length, 2);
  assert.equal(parsed.variants[0].url, "https://cdn.example/dash/low.mp4");
  assert.equal(parsed.variants[0].resolution, "640x360");
  assert.equal(parsed.variants[1].resolution, "1280x720");
  assert.equal(parsed.variants[1].url, null);
  const stream = MS.applyPlaylist({
    url: "https://cdn.example/dash/index.mpd",
    type: "DASH",
    variants: [],
    parsed: false
  }, parsed);
  assert.equal(stream.parsed, true);
  assert.equal(stream.resolution, "1280x720");
  assert.equal(stream.bitrate, 2400000);

  const split = `<?xml version="1.0"?>
    <MPD>
      <Period>
        <AdaptationSet mimeType="video/mp4" contentType="video">
          <Representation id="v" bandwidth="2400000" width="1280" height="720">
            <BaseURL>video.mp4</BaseURL>
          </Representation>
        </AdaptationSet>
        <AdaptationSet mimeType="audio/mp4" contentType="audio">
          <Representation id="a" bandwidth="128000">
            <BaseURL>audio.mp4</BaseURL>
          </Representation>
        </AdaptationSet>
        <AdaptationSet contentType="audio">
          <Representation id="a2" bandwidth="64000">
            <BaseURL>low-audio.mp4</BaseURL>
          </Representation>
        </AdaptationSet>
      </Period>
    </MPD>`;
  const kinds = MS.parseDash(split, "https://cdn.example/dash/index.mpd");
  assert.equal(kinds.variants[0].type, "DASH");
  assert.equal(kinds.variants[0].mime, "video/mp4");
  assert.equal(kinds.variants[1].type, "Audio");
  assert.equal(kinds.variants[1].mime, "audio/mp4");
  assert.equal(kinds.variants[1].url, "https://cdn.example/dash/audio.mp4");
  assert.equal(kinds.variants[2].type, "Audio");
  assert.equal(kinds.variants[2].mime, null);
});

test("builds a safe filename from the URL or the page title", () => {
  assert.equal(
    MS.suggestFilename({ url: "https://cdn.example/videos/lecture.mp4?sig=abc", type: "MP4" }, "Ignored"),
    "lecture.mp4"
  );
  const fallback = MS.suggestFilename(
    { url: "https://cdn.example/?format=mp4", type: "MP4" },
    "My Talk",
    new Date(2026, 3, 5, 9, 8, 7)
  );
  assert.match(fallback, /^My_Talk_20260405-090807\.mp4$/);
  assert.equal(MS.sanitizeFilename("a/b:c?.mp4"), "a_b_c_.mp4");
  const generic = MS.suggestFilename(
    { url: "https://cdn.example/hls/master.m3u8", type: "HLS" },
    "Evening Show"
  );
  assert.equal(generic, "Evening_Show_master.m3u8");
});

test("reads generic size and quality hints", () => {
  const meta = MS.metaFromUrl("https://cdn.example/v/1280x720/file.mp4?bitrate=2500000&duration=90");
  assert.equal(meta.resolution, "1280x720");
  assert.equal(meta.bitrate, 2500000);
  assert.equal(meta.duration, 90);
  assert.equal(MS.formatSize(1536), "1.5 KB");
  assert.equal(MS.formatSize(1048576), "1 MB");
  assert.equal(MS.formatDuration(65), "1:05");
  assert.equal(MS.formatDuration(3723), "1:02:03");
  assert.equal(MS.formatBitrate(2500000), "2.5 Mbps");
});

test("plans webRequest listeners from per-tab choices", () => {
  const now = 1_000_000;
  assert.deepEqual(MS.webRequestPlan([], now), { attach: false, filter: null, key: "" });
  const one = MS.webRequestPlan([[7, { continuous: true, scanUntil: 0 }]], now);
  assert.equal(one.attach, true);
  assert.equal(one.filter.tabId, 7);
  assert.ok(one.filter.types.includes("media"));
  const scan = MS.webRequestPlan([[3, { continuous: false, scanUntil: now + 1000 }]], now);
  assert.equal(scan.filter.tabId, 3);
  const expired = MS.webRequestPlan([[3, { continuous: false, scanUntil: now - 1 }]], now);
  assert.equal(expired.attach, false);
  const many = MS.webRequestPlan([
    [4, { continuous: true }],
    [9, { continuous: false, scanUntil: now + 50 }]
  ], now);
  assert.equal(many.filter.tabId, undefined);
  assert.deepEqual(JSON.parse(many.key).types, MS.REQUEST_TYPES);
});

test("prefers progressive files when trimming a long list", () => {
  const streams = [];
  for (let i = 0; i < 5; i++) {
    MS.upsertStream(streams, { url: `https://cdn.example/f${i}.mp4` }, 8);
  }
  for (let i = 0; i < 10; i++) {
    MS.upsertStream(streams, { url: `https://cdn.example/s${i}.m4s` }, 8);
  }
  assert.equal(streams.length, 8);
  assert.equal(streams.filter((stream) => stream.type === "MP4").length, 5);
  assert.equal(streams.filter((stream) => stream.type === "Segment").length, 3);
});

test("groups fragmented mp4 pieces from the same stream", () => {
  const numbered = [];
  for (let i = 1; i <= 10; i += 1) {
    numbered.push({ url: `https://cdn.example/v/${i}.m4s`, type: "Segment", size: 100 });
  }
  const one = MS.clusterFragments(numbered);
  assert.equal(one.length, 1);
  assert.equal(one[0].count, 10);
  assert.equal(one[0].urls[0], "https://cdn.example/v/1.m4s");
  assert.equal(one[0].urls[9], "https://cdn.example/v/10.m4s");
  assert.equal(MS.presentMedia(numbered).count, 1);

  const withInit = [
    { url: "https://cdn.example/v/movie.mp4", type: "MP4", size: 500 },
    { url: "https://cdn.example/v/init.mp4", type: "MP4", size: 100 },
    { url: "https://cdn.example/v/1.m4s", type: "Segment", size: 10 },
    { url: "https://cdn.example/v/2.m4s", type: "Segment", size: 20 }
  ];
  const view = MS.presentMedia(withInit);
  assert.deepEqual(view.clusters[0].urls, [
    "https://cdn.example/v/init.mp4",
    "https://cdn.example/v/1.m4s",
    "https://cdn.example/v/2.m4s"
  ]);
  assert.equal(view.clusters[0].count, 2);
  assert.equal(view.clusters[0].size, 130);
  assert.deepEqual(view.primary.map((stream) => stream.url), ["https://cdn.example/v/movie.mp4"]);
  assert.equal(view.count, 2);

  const split = MS.clusterFragments([
    { url: "https://cdn.example/v/chunk-1-1.m4s", type: "Segment" },
    { url: "https://cdn.example/v/chunk-1-2.m4s", type: "Segment" },
    { url: "https://cdn.example/v/chunk-2-1.m4s", type: "Segment" }
  ]);
  assert.equal(split.length, 2);
  assert.deepEqual(split[0].urls, [
    "https://cdn.example/v/chunk-1-1.m4s",
    "https://cdn.example/v/chunk-1-2.m4s"
  ]);
  assert.deepEqual(split[1].urls, ["https://cdn.example/v/chunk-2-1.m4s"]);

  const counterFirst = MS.clusterFragments([
    { url: "https://cdn.example/v/10-seg-9.m4s", type: "Segment" },
    { url: "https://cdn.example/v/2-seg-9.m4s", type: "Segment" }
  ]);
  assert.deepEqual(counterFirst[0].urls, [
    "https://cdn.example/v/2-seg-9.m4s",
    "https://cdn.example/v/10-seg-9.m4s"
  ]);

  const dirs = MS.clusterFragments([
    { url: "https://cdn.example/a/1.m4s", type: "Segment" },
    { url: "https://cdn.example/b/1.m4s", type: "Segment" }
  ]);
  assert.equal(dirs.length, 2);

  const queried = MS.clusterFragments([
    { url: "https://cdn.example/v/seg.m4s?sq=10", type: "Segment" },
    { url: "https://cdn.example/v/seg.m4s?sq=2", type: "Segment" }
  ]);
  assert.deepEqual(queried[0].urls, [
    "https://cdn.example/v/seg.m4s?sq=2",
    "https://cdn.example/v/seg.m4s?sq=10"
  ]);

  const transport = [{ url: "https://cdn.example/v/1.ts", type: "Segment", size: 5 }];
  assert.equal(MS.clusterFragments(transport).length, 0);
  assert.equal(MS.presentMedia(transport).count, 1);

  const named = MS.presentMedia([
    { url: "https://cdn.example/v/initialization.mp4", type: "MP4", size: 50 },
    { url: "https://cdn.example/v/1.m4s", type: "Segment", size: 10 }
  ]);
  assert.deepEqual(named.clusters[0].urls, ["https://cdn.example/v/1.m4s"]);
  assert.equal(named.primary[0].url, "https://cdn.example/v/initialization.mp4");

  const ranged = MS.clusterFragments([
    { url: "https://cdn.example/media/b/AbCdEf12file.mp4?range=200-500", type: "MP4", size: 300 },
    { url: "https://cdn.example/media/a/AbCdEf12file.mp4?range=0-100", type: "MP4", size: 101 },
    { url: "https://cdn.example/media/c/AbCdEf12file.mp4?range=500-900", type: "MP4", size: 400 }
  ]);
  assert.deepEqual(ranged[0].urls, [
    "https://cdn.example/media/a/AbCdEf12file.mp4?range=0-100",
    "https://cdn.example/media/b/AbCdEf12file.mp4?range=200-500",
    "https://cdn.example/media/c/AbCdEf12file.mp4?range=500-900"
  ]);
  assert.equal(MS.clusterFragments([
    { url: "https://cdn.example/media/b/AbCdEf12file.mp4?range=200-500", type: "MP4", size: 10 }
  ]).length, 0);

  const listed = [
    {
      url: "https://cdn.example/master.m3u8",
      type: "HLS",
      variants: [
        {
          url: "https://cdn.example/hi.m3u8",
          type: "HLS",
          resolution: "1280x720",
          audioUrl: "https://cdn.example/audio.m3u8"
        },
        { url: "https://cdn.example/audio.m3u8", type: "Audio", label: "Audio" }
      ]
    },
    { url: "https://cdn.example/hi.m3u8", type: "HLS" },
    { url: "https://cdn.example/audio.m3u8", type: "HLS" }
  ];
  const folded = MS.presentMedia(listed);
  assert.equal(folded.primary.length, 1);
  assert.equal(folded.primary[0].url, "https://cdn.example/master.m3u8");
  assert.equal(MS.matchingAudioPlaylist(listed, "https://cdn.example/hi.m3u8"), "https://cdn.example/audio.m3u8");

  const when = new Date(2026, 3, 5, 9, 8, 7);
  assert.equal(MS.assembledFilename("My Talk", 0, 1, when), "My_Talk_20260405-090807.mp4");
  assert.equal(MS.assembledFilename("My Talk", 1, 2, when), "My_Talk_2_20260405-090807.mp4");

  const root = "https://cdn.example/media/123456789012/avc";
  const timed = [
    { url: `${root}/0/0/720x1280/r0M725FNykL7CxKZ.mp4`, type: "MP4", size: 903 },
    { url: `${root}/3000/6000/720x1280/Zz9LateSEGMent01.m4s`, type: "Segment", size: 1000 },
    { url: `${root}/0/3000/720x1280/Aa8EarlySEGment1.m4s`, type: "Segment", size: 2000 },
    { url: `${root}/0/0/320x568/qW8smallINITfile1.mp4`, type: "MP4", size: 800 },
    { url: `${root}/0/3000/320x568/mN4smallSEGMENT1.m4s`, type: "Segment", size: 400 },
    { url: `${root.replace("/avc", "/mp4a")}/0/0/128000/bQ8audioINITfile1.mp4`, type: "MP4", size: 700 },
    { url: `${root.replace("/avc", "/mp4a")}/0/3000/128000/xY7audioSEGment01.m4s`, type: "Segment", size: 500 },
    { url: `${root.replace("/avc", "/mp4a")}/0/0/32000/cD6lowaudioINIT01.mp4`, type: "MP4", size: 400 },
    { url: `${root.replace("/avc", "/mp4a")}/0/3000/32000/eF5lowaudioSEG001.m4s`, type: "Segment", size: 200 }
  ];
  const timedClusters = MS.clusterFragments(timed);
  const hd = timedClusters.find((cluster) => cluster.urls.some((url) => url.includes("720x1280")));
  assert.deepEqual(hd.urls, [
    `${root}/0/0/720x1280/r0M725FNykL7CxKZ.mp4`,
    `${root}/0/3000/720x1280/Aa8EarlySEGment1.m4s`,
    `${root}/3000/6000/720x1280/Zz9LateSEGMent01.m4s`
  ]);
  assert.equal(timedClusters.filter((cluster) => cluster.urls.some((url) => url.includes("320x568"))).length, 1);
  assert.equal(timedClusters.filter((cluster) => cluster.urls.some((url) => url.includes("/128000/"))).length, 1);
  assert.equal(timedClusters.filter((cluster) => cluster.urls.some((url) => url.includes("/32000/"))).length, 1);
  const paired = MS.presentMedia(timed);
  assert.equal(paired.clusters[0].paired, true);
  assert.equal(paired.clusters[0].hasInit, true);
  assert.equal(paired.clusters[0].resolution, "720x1280");
  assert.equal(paired.clusters[0].urls.some((url) => url.includes("720x1280")), true);
  assert.equal(paired.clusters[0].urls.some((url) => url.includes("/128000/")), true);
  assert.equal(paired.clusters[0].urls.some((url) => url.includes("/32000/")), false);
  assert.equal(paired.primary.some((stream) => stream.url.includes("r0M725FNykL7CxKZ")), false);
});

test("uses a complete file named by the page when fragments have no init", () => {
  const doc = {
    querySelectorAll(selector) {
      if (selector === "script") {
        return [{
          textContent: "{\"url\":\"https:\\/\\/cdn.example\\/media\\/123456789012\\/vid\\/720x1280\\/CompleteFile01.mp4?tag=1\"} https://cdn.example/photo.jpg"
        }];
      }
      return [];
    }
  };
  assert.deepEqual(MS.mediaUrlsInDocument(doc), [
    "https://cdn.example/media/123456789012/vid/720x1280/CompleteFile01.mp4?tag=1"
  ]);

  const root = "https://cdn.example/media/123456789012";
  const fragments = [
    `${root}/vid/12000/15000/720x1280/Aa11bb22cc33.m4s`,
    `${root}/aud/12000/15000/128000/Dd44ee55ff66.m4s`
  ];
  const file = `${root}/vid/720x1280/CompleteFile01.mp4`;
  const bigger = `${root}/vid/2160x3840/BiggerFile0001.mp4`;
  const init = `${root}/vid/0/0/720x1280/InitFile000001.mp4`;
  const playlist = `${root}/pl/master.m3u8`;
  const streams = [
    ...fragments.map((url) => ({ url, type: "Segment" })),
    { url: file, type: "MP4" },
    { url: bigger, type: "MP4" },
    { url: init, type: "MP4", size: 900 },
    { url: playlist, type: "HLS" },
    { url: "https://cdn.example/other/123456789099/vid/720x1280/OtherFile0001.mp4", type: "MP4" }
  ];
  assert.equal(MS.fragmentsHaveInit(fragments), false);
  assert.equal(MS.recoveryForCluster(streams, fragments).kind, "file");
  assert.equal(MS.recoveryForCluster(streams, fragments).url, file);
  const playlistOnly = streams.filter((stream) => stream.url !== file && stream.url !== bigger);
  assert.equal(MS.recoveryForCluster(playlistOnly, fragments).url, playlist);
  assert.equal(MS.recoveryForCluster(streams.filter((stream) => stream.type === "Segment"), fragments), null);
});

function box(type, payload = new Uint8Array(0)) {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  return out;
}

function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function tkhd(trackId) {
  const payload = new Uint8Array(20);
  new DataView(payload.buffer).setUint32(12, trackId);
  return box("tkhd", payload);
}

function hdlr(kind) {
  const payload = new Uint8Array(12);
  payload[8] = kind.charCodeAt(0);
  payload[9] = kind.charCodeAt(1);
  payload[10] = kind.charCodeAt(2);
  payload[11] = kind.charCodeAt(3);
  return box("hdlr", payload);
}

function tfhd(trackId) {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setUint32(4, trackId);
  return box("tfhd", payload);
}

function tfdt(time) {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setUint32(4, time);
  return box("tfdt", payload);
}

function initBytes(trackId, handler) {
  const trak = box("trak", concatBytes([tkhd(trackId), box("mdia", hdlr(handler))]));
  return concatBytes([box("ftyp", new Uint8Array(8)), box("moov", trak)]);
}

function mediaBytes(trackId, time) {
  return concatBytes([
    box("styp", new Uint8Array(8)),
    box("moof", box("traf", concatBytes([tfhd(trackId), tfdt(time)]))),
    box("mdat", new Uint8Array(4))
  ]);
}

function inspected(bytes, fields) {
  return Object.assign({ size: bytes.length }, fields, MS.inspectFragment(bytes));
}

test("joins init and media fragments into decode order", () => {
  const init = MS.inspectFragment(initBytes(7, "soun"));
  assert.equal(init.kind, "init");
  assert.deepEqual(init.trackIds, [7]);
  assert.deepEqual(init.handlers, ["soun"]);
  assert.equal(MS.inspectFragment(mediaBytes(7, 100)).decodeTime, 100);
  assert.equal(MS.inspectFragment(new Uint8Array([0, 0, 0, 4, 97, 98, 99, 100])).kind, "unknown");

  const videoInit = inspected(initBytes(1, "vide"), { index: 0, url: "https://cdn.example/v/init.mp4", size: 40 });
  const later = inspected(mediaBytes(1, 200), { index: 1, url: "https://cdn.example/v/2.m4s", size: 10 });
  const earlier = inspected(mediaBytes(1, 100), { index: 2, url: "https://cdn.example/v/1.m4s", size: 10 });
  const ordered = MS.planAssembly([videoInit, later, earlier]);
  assert.deepEqual(ordered.files, [{ parts: [0, 2, 1], label: "video" }]);
  assert.equal(ordered.warning, "");

  const small = inspected(mediaBytes(1, 100), { index: 1, url: "https://cdn.example/v/a.m4s", size: 5 });
  const big = inspected(mediaBytes(1, 100), { index: 2, url: "https://cdn.example/v/b.m4s", size: 50 });
  assert.deepEqual(MS.planAssembly([videoInit, small, big]).files[0].parts, [0, 2]);

  const missing = MS.planAssembly([earlier]);
  assert.equal(missing.files.length, 0);
  assert.match(missing.error, /initialization segment was not captured/);

  const onlyInit = MS.planAssembly([videoInit]);
  assert.equal(onlyInit.files.length, 0);
  assert.match(onlyInit.error, /Only an initialization segment/);

  const audioInit = inspected(initBytes(2, "soun"), { index: 1, url: "https://cdn.example/a/init.mp4", size: 20 });
  const videoMedia = inspected(mediaBytes(1, 0), { index: 2, url: "https://cdn.example/v/1.m4s", size: 10 });
  const audioMedia = inspected(mediaBytes(2, 0), { index: 3, url: "https://cdn.example/a/1.m4s", size: 10 });
  const split = MS.planAssembly([videoInit, audioInit, videoMedia, audioMedia]);
  assert.deepEqual(split.files.find((file) => file.label === "video").parts, [0, 2]);
  assert.deepEqual(split.files.find((file) => file.label === "audio").parts, [1, 3]);
  assert.match(split.warning, /two files/);

  const sameIdVideo = inspected(initBytes(1, "vide"), { index: 0, url: "https://cdn.example/video/init.mp4", size: 20 });
  const sameIdAudio = inspected(initBytes(1, "soun"), { index: 1, url: "https://cdn.example/audio/init.mp4", size: 20 });
  const sameVideo = inspected(mediaBytes(1, 0), { index: 2, url: "https://cdn.example/video/1.m4s", size: 10 });
  const sameAudio = inspected(mediaBytes(1, 5), { index: 3, url: "https://cdn.example/audio/1.m4s", size: 10 });
  const affinity = MS.planAssembly([sameIdVideo, sameIdAudio, sameVideo, sameAudio]);
  assert.deepEqual(affinity.files.find((file) => file.label === "video").parts, [0, 2]);
  assert.deepEqual(affinity.files.find((file) => file.label === "audio").parts, [1, 3]);

  const rangeVideoInit = inspected(initBytes(1, "vide"), {
    index: 0,
    url: "https://cdn.example/range/aaa/file/VideoFile123.mp4?range=0-10",
    size: 20
  });
  const rangeAudioInit = inspected(initBytes(1, "soun"), {
    index: 1,
    url: "https://cdn.example/range/bbb/file/AudioFile123.mp4?range=0-10",
    size: 20
  });
  const rangeVideo = inspected(mediaBytes(1, 0), {
    index: 2,
    url: "https://cdn.example/range/ccc/file/VideoFile123.mp4?range=20-40",
    size: 10
  });
  const rangeAudio = inspected(mediaBytes(1, 0), {
    index: 3,
    url: "https://cdn.example/range/ddd/file/AudioFile123.mp4?range=20-40",
    size: 30
  });
  const ranges = MS.planAssembly([rangeVideoInit, rangeAudioInit, rangeVideo, rangeAudio]);
  assert.deepEqual(ranges.files.find((file) => file.label === "video").parts, [0, 2]);
  assert.deepEqual(ranges.files.find((file) => file.label === "audio").parts, [1, 3]);

  const progressiveBytes = concatBytes([
    box("ftyp", new Uint8Array(4)),
    box("moov", box("trak", tkhd(1))),
    box("mdat", new Uint8Array(4))
  ]);
  const progressive = inspected(progressiveBytes, { index: 3, url: "https://cdn.example/movie.mp4", size: progressiveBytes.length });
  assert.equal(progressive.kind, "progressive");
  assert.deepEqual(MS.planAssembly([progressive]).files, [{ parts: [3], label: "video" }]);

  const hybridBytes = concatBytes([
    box("moov", box("trak", concatBytes([tkhd(1), box("mdia", hdlr("vide"))]))),
    box("moof", box("traf", concatBytes([tfhd(1), tfdt(0)])))
  ]);
  const hybrid = inspected(hybridBytes, { index: 4, url: "https://cdn.example/h.mp4", size: hybridBytes.length });
  assert.equal(hybrid.kind, "hybrid");
  assert.deepEqual(MS.planAssembly([hybrid]).files[0].parts, [4]);

  const unread = MS.planAssembly([inspected(new Uint8Array(16), { index: 0, url: "https://cdn.example/v/1.m4s", size: 16 })]);
  assert.equal(unread.files.length, 0);
  assert.match(unread.error, /could not be read/);

  function trex(trackId) {
    const payload = new Uint8Array(24);
    new DataView(payload.buffer).setUint32(4, trackId);
    return box("trex", payload);
  }
  function initWithTrex(trackId, handler) {
    const trak = box("trak", concatBytes([tkhd(trackId), box("mdia", hdlr(handler))]));
    const mvex = box("mvex", trex(trackId));
    return concatBytes([box("ftyp", new Uint8Array(8)), box("moov", concatBytes([trak, mvex]))]);
  }
  const merged = MS.mergeFragmentInits(initWithTrex(1, "vide"), initWithTrex(1, "soun"));
  const mergedInfo = MS.inspectFragment(merged.bytes);
  assert.deepEqual(mergedInfo.trackIds.slice().sort((a, b) => a - b), [1, 2]);
  assert.equal(mergedInfo.handlers.includes("vide"), true);
  assert.equal(mergedInfo.handlers.includes("soun"), true);
  assert.equal(merged.audioFrom, 1);
  assert.equal(merged.audioTo, 2);
  const retargeted = MS.inspectFragment(MS.retargetFragment(mediaBytes(1, 0), 1, 2));
  assert.deepEqual(retargeted.trackIds, [2]);
  const distinct = MS.mergeFragmentInits(initWithTrex(1, "vide"), initWithTrex(2, "soun"));
  assert.equal(distinct.audioFrom, 2);
  assert.equal(distinct.audioTo, 2);
  assert.equal(MS.inspectFragment(distinct.bytes).handlers.includes("soun"), true);
});

test("keeps a short download history that can be repeated", () => {
  const now = 1700000000000;
  assert.equal(MS.MAX_HISTORY, 40);
  const file = {
    mode: "file",
    url: "https://cdn.example/a/movie.mp4?token=1#frag",
    filename: "Movie.mp4",
    pageTitle: "Sample page",
    at: now,
    id: "file-1"
  };
  const first = MS.rememberHistory([], file, now);
  assert.equal(first.length, 1);
  assert.equal(first[0].mode, "file");
  assert.equal(first[0].url, "https://cdn.example/a/movie.mp4?token=1");
  assert.equal(first[0].filename, "Movie.mp4");
  assert.equal(first[0].pageTitle, "Sample page");
  assert.equal(first[0].id, "file-1");
  assert.deepEqual(first[0].urls, []);

  assert.equal(MS.rememberHistory([], {
    mode: "file",
    url: "blob:https://cdn.example/uuid",
    filename: "Clip.mp4"
  }, now).length, 0);
  assert.equal(MS.rememberHistory([], { mode: "file", url: "https://cdn.example/a.mp4" }, now).length, 0);
  assert.equal(MS.rememberHistory([], {
    mode: "fragments",
    urls: ["blob:https://cdn.example/1"],
    filename: "Joined.mp4"
  }, now).length, 0);

  const again = MS.rememberHistory(first, { ...file, at: now + 5000 }, now + 5000);
  assert.equal(again.length, 1);
  assert.equal(again[0].id, "file-1");
  assert.equal(again[0].at, now + 5000);

  const second = MS.rememberHistory(again, {
    mode: "file",
    url: "https://cdn.example/b.webm",
    filename: "Other.webm",
    at: now + 1000,
    id: "file-2"
  }, now + 1000);
  assert.deepEqual(second.map((row) => row.id), ["file-2", "file-1"]);

  const playlist = MS.rememberHistory(second, {
    mode: "playlist",
    url: "https://cdn.example/master.m3u8",
    audioUrl: "not a url",
    filename: "Show.mp4",
    id: "play-1",
    at: now + 2000
  }, now + 2000);
  assert.equal(playlist[0].mode, "playlist");
  assert.equal(playlist[0].audioUrl, "");
  const withAudio = MS.rememberHistory(playlist, {
    mode: "playlist",
    url: "https://cdn.example/master.m3u8",
    audioUrl: "https://cdn.example/audio.m3u8",
    filename: "Show.mp4",
    id: "play-2",
    at: now + 3000
  }, now + 3000);
  assert.equal(withAudio.filter((row) => row.mode === "playlist").length, 2);

  const urls = Array.from({ length: 410 }, (_, index) => `https://cdn.example/seg/${index}.m4s`);
  urls.push(urls[0]);
  const fragments = MS.rememberHistory([], {
    mode: "fragments",
    urls,
    filename: "Joined.mp4",
    id: "frag-1",
    at: now
  }, now);
  assert.equal(fragments[0].urls.length, 400);
  assert.equal(fragments[0].urls[0], "https://cdn.example/seg/0.m4s");
  assert.equal(fragments[0].urls[399], "https://cdn.example/seg/399.m4s");
  assert.equal(fragments[0].url, "");

  let list = [];
  for (let index = 0; index < 45; index += 1) {
    list = MS.rememberHistory(list, {
      mode: "file",
      url: `https://cdn.example/f/${index}.mp4`,
      filename: `Clip ${index}.mp4`,
      id: `clip-${index}`,
      at: now + index
    }, now + index);
  }
  assert.equal(list.length, 40);
  assert.equal(list[0].id, "clip-44");
  assert.equal(list.some((row) => row.id === "clip-0"), false);
  assert.equal(list.some((row) => row.id === "clip-5"), true);

  const loaded = MS.loadHistory([
    { mode: "nope", filename: "Bad.mp4", url: "https://cdn.example/bad.mp4", at: now },
    { mode: "file", filename: "Old.mp4", url: "https://cdn.example/old.mp4", at: now, id: "old-1" },
    { mode: "file", filename: "New.mp4", url: "https://cdn.example/new.mp4", at: now + 10, id: "new-1" },
    { mode: "file", filename: "Old.mp4", url: "https://cdn.example/old.mp4", at: now + 1, id: "old-2" },
    null,
    {
      mode: "playlist",
      filename: "Show.mp4",
      url: "https://cdn.example/master.m3u8",
      audioUrl: "https://cdn.example/audio.m3u8",
      at: now + 5,
      id: "play-9"
    }
  ]);
  assert.deepEqual(loaded.map((row) => row.filename), ["New.mp4", "Show.mp4", "Old.mp4"]);
  assert.equal(loaded[2].id, "old-2");
  assert.equal(loaded[2].at, now + 1);
  assert.equal(loaded[1].audioUrl, "https://cdn.example/audio.m3u8");

  const popup = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  const popupJs = fs.readFileSync(path.join(root, "popup.js"), "utf8");
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  assert.match(popup, /id="history-open"[^>]*\bhidden\b/);
  assert.match(popup, />Download history</);
  assert.match(popupJs, /historyOpen\.hidden = items\.length === 0/);
  assert.match(popupJs, /Show variants/);
  assert.match(popupJs, /Hide variants/);
  assert.match(popupJs, /button\.dataset\.variants/);
  assert.match(popupJs, /makeVariantIcon\(variantKind\(variant\)\)/);
  assert.match(popupJs, /aria-label", audio \? "Audio" : "Video"/);
  const popupCss = fs.readFileSync(path.join(root, "popup.css"), "utf8");
  assert.match(popupCss, /\.variants-bar/);
  assert.match(popupCss, /\.variant-kind\[data-kind="audio"\]/);
  assert.match(popup, /id="history-back"/);
  assert.match(popup, /id="history-view"/);
  assert.match(popup, /id="history-list"/);
  assert.match(popupJs, /get-history/);
  assert.match(popupJs, /redownload/);
  assert.match(popupJs, /history:\$\{/);
  assert.match(background, /chrome\.storage\.local/);
  assert.match(background, /type === "get-history"/);
  assert.match(background, /type === "redownload"/);
  assert.match(background, /mode: "fragments"/);
  assert.match(background, /mode: "playlist"/);
  assert.match(background, /mode: "file"/);
  assert.match(background, /mode: "capture"/);
  assert.match(background, /parseUmp/);
  assert.match(background, /pull-kept/);
});

test("unpacks a multipart media envelope into video and audio", () => {
  function u32(value) {
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  }
  function concat(...parts) {
    const list = parts.map((part) => (part instanceof Uint8Array ? part : Uint8Array.from(part)));
    const out = new Uint8Array(list.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of list) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
  function umpVarint(value) {
    if (value < 128) return Uint8Array.of(value);
    return Uint8Array.of(0x80 | (value & 0x3f), value >> 6);
  }
  function pbVarint(value) {
    const out = [];
    let rest = value;
    while (rest > 127) {
      out.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    out.push(rest);
    return out;
  }
  function pbNum(field, value) {
    return [...pbVarint(field * 8), ...pbVarint(value)];
  }
  function pbRaw(field, bytes) {
    const raw = [...bytes];
    return [...pbVarint(field * 8 + 2), ...pbVarint(raw.length), ...raw];
  }
  function pbStr(field, text) {
    return pbRaw(field, Buffer.from(text));
  }
  function umpPart(type, payload) {
    const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
    return concat(umpVarint(type), umpVarint(body.length), body);
  }

  const videoFormat = Uint8Array.of(8, 140, 3);
  const audioFormat = Uint8Array.of(8, 251);
  const tkhd = new Uint8Array(84);
  tkhd.set(u32(360 << 16), 76);
  tkhd.set(u32(640 << 16), 80);
  const ftyp = concat(u32(20), Buffer.from("ftyp"), Buffer.from("isom"), u32(0), Buffer.from("isom"));
  const tkhdBox = concat(u32(92), Buffer.from("tkhd"), tkhd);
  const init = concat(ftyp, u32(8 + tkhdBox.length), Buffer.from("moov"), tkhdBox);
  const fragment = Buffer.from("moof-rest");
  const audio = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4);
  const header = (id, itag, start, format) => umpPart(20, [
    ...pbNum(1, id),
    ...pbStr(2, "abc123def45"),
    ...pbNum(3, itag),
    ...pbNum(4, 99),
    ...pbNum(6, start),
    ...pbNum(8, start === 0 ? 1 : 0),
    ...pbRaw(13, format)
  ]);
  const media = (id, bytes) => umpPart(21, concat(umpVarint(id), bytes));
  const envelope = concat(
    umpPart(42, [...pbStr(1, "abc123def45"), ...pbRaw(2, videoFormat), ...pbNum(3, 16320), ...pbStr(5, "video/mp4")]),
    umpPart(42, [...pbStr(1, "abc123def45"), ...pbRaw(2, audioFormat), ...pbNum(3, 16000), ...pbStr(5, "audio/webm")]),
    header(0, 18, 0, videoFormat),
    media(0, init),
    header(1, 18, init.length, videoFormat),
    media(1, fragment),
    header(2, 251, 0, audioFormat),
    media(2, audio),
    umpPart(22, umpVarint(0))
  );

  assert.equal(MS.parseUmp(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)), null);
  assert.equal(MS.parseUmp(Buffer.from("<html>nope</html>")), null);
  const tracks = MS.parseUmp(envelope);
  assert.equal(tracks.length, 2);
  const video = tracks.find((track) => track.type === "MP4");
  const sound = tracks.find((track) => track.type === "Audio");
  assert.equal(video.mime, "video/mp4");
  assert.equal(video.resolution, "360x640");
  assert.equal(video.duration, 16.32);
  assert.equal(video.label, "Video from this page");
  assert.equal(Buffer.from(video.bytes.subarray(4, 8)).toString(), "ftyp");
  assert.equal(Buffer.from(video.bytes.subarray(init.length, init.length + 4)).toString(), "moof");
  assert.equal(sound.mime, "audio/webm");
  assert.equal(sound.duration, 16);
  assert.equal(sound.resolution, null);
  assert.equal(sound.bytes[0], 0x1a);
  assert.notEqual(video.captureKey, sound.captureKey);

  const page = "https://cdn.example/videoplayback?id=1";
  const streams = [];
  for (const track of tracks) {
    MS.upsertStream(streams, {
      url: MS.capturedMediaUrl(page, track.captureKey),
      mime: track.mime,
      size: track.bytes.byteLength,
      sizeFromHeader: true,
      duration: track.duration,
      resolution: track.resolution,
      captureKey: track.captureKey,
      label: track.label,
      source: "kept"
    });
  }
  assert.equal(streams.length, 2);
  assert.equal(MS.suggestFilename(video, "All new ATV"), "All_new_ATV_video.mp4");
  assert.equal(MS.suggestFilename(sound, "All new ATV"), "All_new_ATV_audio.webm");
  const saved = MS.rememberHistory([], {
    mode: "capture",
    filename: "All_new_ATV_video.mp4",
    pageTitle: "All new ATV",
    id: "cap-1",
    at: 1700000000000
  }, 1700000000000);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mode, "capture");
  assert.equal(saved[0].url, "");
});

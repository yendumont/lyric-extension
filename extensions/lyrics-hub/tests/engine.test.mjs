import { test, assert, load, toLrc } from "./t.mjs";

const TRACK = ["Bad Romance", "Lady Gaga", "", 294];
const ALL = ["spicy","lrcred","amll","binilyrics","musixmatch","unison","lrclib","lrcmux","netease","qqmusic","kugou","kuwo","deezer"];
const cfg = (extra = {}, off = ALL) => { const s = { useSpotifyApp: false, ...extra }; for (const p of ALL) s["use_" + p] = !off.includes(p) ? true : (extra["use_" + p] ?? false); return s; };
const LINE_LRC = "[00:01.00]Hello world\n[00:03.00]Second line";
const WORD_LRC = "[00:01.00]<00:01.00>Hello <00:01.50>world<00:02.00>\n[00:03.00]<00:03.00>Second <00:03.50>line<00:04.00>";
const lrclib = (lrc) => ["lrclib.net/api/get", { syncedLyrics: lrc, duration: 294 }];
const netease = (yrcOrNull, lrc) => [
  ["search/get", { result: { songs: [{ id: 7, name: "Bad Romance", artists: [{ name: "Lady Gaga" }], duration: 294000 }] } }],
  ["song/lyric/v1", { yrc: yrcOrNull ? { lyric: yrcOrNull } : undefined, lrc: { lyric: lrc } }],
];
const YRC = "[1000,2000](1000,500,0)Hello (1500,500,0)world\n[3000,1000](3000,500,0)Second (3500,500,0)line";

test("prefer best sync: a later word-synced source beats an earlier line-synced one", () => {
  const routes = [lrclib(LINE_LRC), ...netease(YRC, "[00:01.00]x")];
  const { ext, calls } = load(cfg({ preferBestSync: true, use_lrclib: true, use_netease: true }), routes);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "NetEase");
  assert.ok(calls.some((c) => c.url.includes("lrclib")), "lrclib was asked first");
});

test("prefer best sync off: the first source that has anything wins", () => {
  const routes = [lrclib(LINE_LRC), ...netease(YRC, "[00:01.00]x")];
  const { ext, calls } = load(cfg({ preferBestSync: false, use_lrclib: true, use_netease: true }), routes);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "LRCLIB");
  assert.ok(!calls.some((c) => c.url.includes("music.163.com")), "netease never asked");
});

test("word-synced result stops the search at once", () => {
  const { ext, calls } = load(cfg({ use_lrclib: true, use_netease: true, use_deezer: true }), [lrclib(WORD_LRC), ...netease(YRC, "x")]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "LRCLIB");
  assert.equal(calls.length, 1);
});

test("a source that can give at most line sync is skipped once a line-synced result is held", () => {
  const { ext, calls } = load(cfg({ use_lrclib: true, use_deezer: true }), [lrclib(LINE_LRC)]);
  ext.fetchLyrics(...TRACK);
  assert.ok(!calls.some((c) => c.url.includes("deezer")));
});

test("order setting by id and by name; unknown names ignored; the rest follow in default order", () => {
  const routes = [lrclib(WORD_LRC), ...netease(YRC, "x")];
  let h = load(cfg({ providerOrder: "NetEase, nonsense, lrclib", use_lrclib: true, use_netease: true }), routes);
  assert.equal(h.ext.fetchLyrics(...TRACK).provider, "NetEase");
  h = load(cfg({ providerOrder: "", use_lrclib: true, use_netease: true }), routes);
  assert.equal(h.ext.fetchLyrics(...TRACK).provider, "LRCLIB");
});

test("a failing source does not stop the next one", () => {
  const { ext } = load(cfg({ use_lrcmux: true, use_lrclib: true }), [["api.lrcmux.dev", { statusCode: 500 }], lrclib(LINE_LRC)]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "LRCLIB");
  const trace = ext.lastLookup().message;
  assert.ok(/LRCMux failed/.test(trace), trace);
});

test("everything off or nothing found gives null", () => {
  assert.equal(load(cfg({}), []).ext.fetchLyrics(...TRACK), null);
  assert.equal(load(cfg({ use_lrclib: true }), []).ext.fetchLyrics(...TRACK), null);
});

test("word timing switch off: line lyrics, voices kept, background folded into text", () => {
  const lrc = "[00:01.00]v2:<00:01.00>Hello <00:01.50>world<00:02.00>\n[bg:<00:01.50>ooh<00:01.90>]\n[00:03.00]v1:<00:03.00>Bye<00:04.00>";
  const { ext } = load(cfg({ use_lrclib: true, wordTiming: false }), [lrclib(lrc)]);
  const r = ext.fetchLyrics(...TRACK);
  assert.deepEqual(Array.from(r.lines, (l) => l.words), ["v2:Hello world (ooh)", "v1:Bye"]);
});

test("background vocals switch off drops [bg:] rows", () => {
  const lrc = "[00:01.00]<00:01.00>Hello<00:02.00>\n[bg:<00:01.50>ooh<00:01.90>]";
  const on_ = load(cfg({ use_lrclib: true }), [lrclib(lrc)]).ext.fetchLyrics(...TRACK);
  assert.ok(on_.lines[0].words.includes("[bg:"));
  // bg rows are kept by parseLRC only while the switch is on
  const off = load(cfg({ use_lrclib: true, backgroundVocals: false }), [lrclib(lrc)]).ext.fetchLyrics(...TRACK);
  assert.ok(!off.lines[0].words.includes("[bg:"));
});

test("timing offset shifts line and word times", () => {
  const { ext } = load(cfg({ use_lrclib: true, timingOffsetMs: "-300" }), [lrclib(WORD_LRC)]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.lines[0].startTimeMs, 700);
  assert.ok(r.lines[0].words.startsWith("<00:00.700>Hello"));
  assert.equal(r.lines[0].endTimeMs, 2700);
});

test("plainLyrics has no tags, voices or extra rows", () => {
  const lrc = "[00:01.00]v1:<00:01.00>Hello<00:02.00>\n[bg:<00:01.50>ooh<00:01.90>]";
  const r = load(cfg({ use_lrclib: true }), [lrclib(lrc)]).ext.fetchLyrics(...TRACK);
  assert.equal(r.plainLyrics, "Hello (ooh)");
});

test("time budget stops the search", () => {
  let now = 1_000_000;
  const clock = class extends Date { static now() { return now; } };
  const routes = [
    ["lrclib.net", () => { now += 30_000; return { statusCode: 404 }; }],
    ...netease(YRC, "x"),
  ];
  const { ext } = load(cfg({ use_lrclib: true, use_netease: true, timeBudgetSec: "20" }), routes, { now: clock });
  assert.equal(ext.fetchLyrics(...TRACK), null);
  assert.ok(/time budget/.test(ext.lastLookup().message));
});

// ---- Translation ----------------------------------------------------------------------------------
const gemini = (reply) => ["generativelanguage.googleapis.com", (u, body) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply(JSON.parse(body))) }] } }] })];
const decodeRows = (words) => words.split("\n").slice(1).filter((r) => r.startsWith("[x-")).map((r) => { const m = /^\[(x-[a-z-]+):(\d+):([^\]]*)\]$/.exec(r); return { kind: m[1], ms: +m[2], text: Buffer.from(m[3], "base64").toString("utf8") }; });

test("translation, line mode: [x-translation] row per line keyed by start ms", () => {
  const lrc = "[00:01.00]Hola mundo\n[00:03.00]ooh\n[00:05.00]Adiós amigo";
  const g = gemini((b) => { assert.ok(b.contents[0].parts[0].text.includes("1. Hola mundo")); return ["Hello world", "", "Goodbye friend"]; });
  const { ext, calls } = load(cfg({ use_lrclib: true, translationMode: "line", geminiApiKey: "KEY", translateTo: "English" }), [lrclib(lrc), g]);
  const r = ext.fetchLyrics(...TRACK);
  assert.ok(r.provider.endsWith("+ Gemini translation"));
  assert.deepEqual(decodeRows(r.lines[0].words), [{ kind: "x-translation", ms: 1000, text: "Hello world" }]);
  assert.deepEqual(decodeRows(r.lines[1].words), []);
  assert.deepEqual(decodeRows(r.lines[2].words), [{ kind: "x-translation", ms: 5000, text: "Goodbye friend" }]);
  assert.equal(calls.find((c) => c.url.includes("generativelanguage")).headers["x-goog-api-key"], "KEY");
  assert.equal(r.plainLyrics, "Hola mundo\nooh\nAdiós amigo");
});

test("translation is cached: a second song fetch does not call Gemini again", () => {
  const lrc = "[00:01.00]Hola mundo";
  const g = gemini(() => ["Hello world"]);
  const { ext, calls } = load(cfg({ use_lrclib: true, translationMode: "line", geminiApiKey: "KEY" }), [lrclib(lrc), g]);
  ext.fetchLyrics(...TRACK);
  ext.fetchLyrics(...TRACK);
  assert.equal(calls.filter((c) => c.url.includes("generativelanguage")).length, 1);
});

test("translation, word mode: word-timed chunks in the app's pronunciation slot", () => {
  const lrc = "[00:01.00]<00:01.00>Hola <00:01.50>mundo<00:02.00>";
  const g = gemini((b) => { assert.ok(b.contents[0].parts[0].text.includes("1:Hola 2:mundo")); return [[{ t: "Hello ", w: 1 }, { t: "world", w: 2 }]]; });
  const { ext } = load(cfg({ use_lrclib: true, translationMode: "word", geminiApiKey: "KEY" }), [lrclib(lrc), g]);
  const r = ext.fetchLyrics(...TRACK);
  const rows = decodeRows(r.lines[0].words);
  assert.deepEqual(rows.map((x) => x.kind), ["x-romaji", "x-romaji-words"]);
  assert.equal(rows[0].text, "Hello world");
  const items = JSON.parse(rows[1].text);
  assert.deepEqual(items, [{ text: "Hello ", startTimeMs: 1000, endTimeMs: 1500 }, { text: "world", startTimeMs: 1500, endTimeMs: 2000 }]);
  assert.equal(items.map((i) => i.text).join(""), rows[0].text, "joined chunks equal the text, as the app requires");
});

test("translation: a Gemini failure never loses the lyrics", () => {
  const { ext } = load(cfg({ use_lrclib: true, translationMode: "line", geminiApiKey: "KEY" }), [lrclib(LINE_LRC), ["generativelanguage", { statusCode: 400, body: JSON.stringify({ error: { message: "API key not valid" } }) }]]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.lines.length, 2);
  assert.ok(!r.provider.includes("Gemini"));
  assert.ok(/API key was not accepted/.test(ext.lastLookup().message));
});

test("translation off by default and without a key", () => {
  const g = ["generativelanguage", () => { throw new Error("should not be called"); }];
  load(cfg({ use_lrclib: true }), [lrclib(LINE_LRC), g]).ext.fetchLyrics(...TRACK);
  load(cfg({ use_lrclib: true, translationMode: "line" }), [lrclib(LINE_LRC), g]).ext.fetchLyrics(...TRACK);
});

test("output survives Mornye's file format: every row is a [ts]line or a recognised extra row", () => {
  const lrc = "[00:01.00]v2:<00:01.00>Hola <00:01.50>mundo<00:02.00>\n[bg:<00:01.50>ooh<00:01.90>]\n[00:03.00]v1:<00:03.00>Adiós<00:04.00>";
  const g = gemini(() => ["Hello world", "Goodbye"]);
  const r = load(cfg({ use_lrclib: true, translationMode: "line", geminiApiKey: "K" }), [lrclib(lrc), g]).ext.fetchLyrics(...TRACK);
  const file = toLrc(r);
  for (const row of file.split("\n")) {
    assert.ok(/^\[\d\d:\d\d\.\d\d\]/.test(row) || /^\[bg:.*\]$/.test(row) || /^\[x-(romaji-words|romaji|translation):\d+:[A-Za-z0-9+\/=]*\]$/.test(row), "unexpected row: " + row);
  }
});

test("testConnection reports sources and Gemini state", () => {
  const { ext } = load(cfg({ use_lrclib: true, translationMode: "line", geminiApiKey: "K" }), [gemini(() => ["ok"])]);
  const r = ext.testConnection();
  assert.ok(r.success);
  assert.ok(/Sources on: LRCLIB/.test(r.message) && /Gemini OK/.test(r.message), r.message);
});

test("custom order: names, aliases and separators all apply, and unlisted sources follow", () => {
  const routes = [lrclib(LINE_LRC), ...netease(null, LINE_LRC)];
  const { ext, calls } = load(cfg({ preferBestSync: false, providerOrder: "NetEase > lrclib", use_lrclib: true, use_netease: true }), routes);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "NetEase");
  assert.ok(!calls.some((c) => c.url.includes("lrclib")), "lrclib never asked, netease was first");
  const b = load(cfg({ preferBestSync: false, providerOrder: "ncm\nlrc", use_lrclib: true, use_netease: true }), routes);
  assert.equal(b.ext.fetchLyrics(...TRACK).provider, "NetEase");
});

test("best sync off: plain text from an earlier source does not stop a later synced one", () => {
  const routes = [["lrclib.net/api/get", { plainLyrics: "Hello world\nSecond line", duration: 294 }], ...netease(null, LINE_LRC)];
  const { ext } = load(cfg({ preferBestSync: false, use_lrclib: true, use_netease: true }), routes);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "NetEase");
  assert.equal(r.syncType, "LINE_SYNCED");
});

test("NetEase is asked with its web-player headers, and falls back to the second search", () => {
  const routes = [["api/search/get", { code: -460 }], ["cloudsearch/get/web", { result: { songs: [{ id: 7, name: "Bad Romance", ar: [{ name: "Lady Gaga" }], dt: 294000 }] } }],
    ["song/lyric/v1", { lrc: { lyric: LINE_LRC } }]];
  const { ext, calls } = load(cfg({ use_netease: true }), routes);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "NetEase");
  const c = calls.find((x) => x.url.includes("api/search/get"));
  assert.ok(c && JSON.stringify(c).includes("music.163.com"), "Referer sent");
});

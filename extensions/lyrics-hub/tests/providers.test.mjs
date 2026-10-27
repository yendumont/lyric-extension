import { test, assert, load, toLrc, zlib } from "./t.mjs";

const TRACK = ["Bad Romance", "Lady Gaga", "", 294];
const only = (id, extra = {}) => {
  const s = { preferBestSync: true, useSpotifyApp: false, ...extra };
  for (const p of ["spicy","lrcred","amll","binilyrics","musixmatch","unison","lrclib","lrcmux","netease","qqmusic","kugou","kuwo","deezer"]) s["use_" + p] = p === id;
  return s;
};
const wordsOf = (r) => Array.from(r.lines, (l) => l.words);

const TTML = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word"><body><div>
<p begin="0:01.000" end="0:03.000" ttm:agent="v1"><span begin="0:01.000" end="0:01.500">Hel</span><span begin="0:01.500" end="0:02.000">lo </span><span begin="0:02.000" end="0:03.000">world</span><span ttm:role="x-bg" begin="0:02.000" end="0:02.500"><span begin="0:02.000" end="0:02.500">(ooh)</span></span></p>
<p begin="0:04.000" end="0:05.000" ttm:agent="v2"><span begin="0:04.000" end="0:05.000">Bye</span></p>
</div></body></tt>`;

test("LRCLIB: synced result, word tags kept", () => {
  const { ext, calls } = load(only("lrclib"), [["lrclib.net/api/get", { syncedLyrics: "[00:01.00]<00:01.00>Hi <00:01.50>you<00:02.00>\n[00:03.00]Line two", plainLyrics: "Hi you\nLine two", duration: 294 }]]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "LRCLIB");
  assert.equal(r.lines.length, 2);
  assert.ok(r.lines[0].words.includes("<00:01.00>Hi"));
  assert.equal(r.lines[0].endTimeMs, 3000);
  assert.ok(calls[0].url.includes("track_name=Bad%20Romance"));
  assert.equal(r.plainLyrics, "Hi you\nLine two");
});

test("LRCLIB: /get failing falls back to /search and picks synced + nearest length", () => {
  const { ext } = load(only("lrclib"), [
    ["lrclib.net/api/get", { statusCode: 503 }],
    ["lrclib.net/api/search", [{ duration: 300, plainLyrics: "x" }, { duration: 295, syncedLyrics: "[00:02.00]found" }, { duration: 294, plainLyrics: "plain only" }]],
  ]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.lines[0].words, "found");
});

test("LRCLIB: plain only gives UNSYNCED; allowPlainFallback=false drops it", () => {
  const routes = [["lrclib.net/api/get", { plainLyrics: "one\ntwo", duration: 294 }]];
  const r = load(only("lrclib"), routes).ext.fetchLyrics(...TRACK);
  assert.equal(r.syncType, "UNSYNCED");
  assert.equal(r.plainLyrics, "one\ntwo");
  assert.equal(load(only("lrclib", { allowPlainFallback: false }), routes).ext.fetchLyrics(...TRACK), null);
});

test("Unison TTML: duet voices, background row, credit with submitter", () => {
  const { ext } = load(only("unison"), [["unison.boidu.dev/lyrics", { success: true, data: { format: "ttml", lyrics: TTML, submitter: { displayName: "Sam" } } }]]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "Unison (submitted by Sam)");
  assert.ok(r.lines[0].words.startsWith("v1:<00:01.000>Hel"));
  assert.ok(r.lines[0].words.includes("\n[bg:<00:02.000>ooh"));
  assert.ok(r.lines[1].words.startsWith("v2:"));
});

test("lrc.red: word sync policy hand / all / off", () => {
  const routes = (byModel) => [
    ["lrc.red/search.json", { hits: [{ isrc: "USUM71000001", title: "Bad Romance", artist: "Lady Gaga", duration: 294 }] }],
    [".song.json", { byModel }],
    [".ttml", TTML.replace("itunes:timing", "lrc:timing")],
  ];
  // hand-timed song, mode hand -> word tags kept
  let r = load(only("lrcred"), routes(false)).ext.fetchLyrics(...TRACK);
  assert.ok(/<00:01/.test(r.lines[0].words), "hand-timed keeps words");
  // model-timed song, mode hand -> reduced to lines
  r = load(only("lrcred"), routes(true)).ext.fetchLyrics(...TRACK);
  assert.ok(!/<\d\d:/.test(r.lines[0].words), "model-timed reduced");
  assert.ok(r.lines[0].words.startsWith("v1:Hello world"), r.lines[0].words);
  // mode all keeps even model-timed
  r = load(only("lrcred", { lrcRedWordSync: "all" }), routes(true)).ext.fetchLyrics(...TRACK);
  assert.ok(/<00:01/.test(r.lines[0].words));
  // mode off reduces even hand-timed
  r = load(only("lrcred", { lrcRedWordSync: "off" }), routes(false)).ext.fetchLyrics(...TRACK);
  assert.ok(!/<\d\d:/.test(r.lines[0].words));
});

test("lrc.red: falls back to .lrc when there is no TTML; rejects a wrong-length hit", () => {
  const ok = load(only("lrcred"), [
    ["lrc.red/search.json", { hits: [{ isrc: "A", title: "Bad Romance", artist: "Lady Gaga", duration: 294 }] }],
    ["A.lrc", "[00:01.00]hello\n[00:03.00]there"],
  ]).ext.fetchLyrics(...TRACK);
  assert.equal(ok.lines.length, 2);
  const bad = load(only("lrcred"), [["lrc.red/search.json", { hits: [{ isrc: "A", title: "Bad Romance", artist: "Lady Gaga", duration: 250 }] }]]).ext.fetchLyrics(...TRACK);
  assert.equal(bad, null);
});

test("BiniLyrics: relays lrc.red through the same word-sync rule", () => {
  const { ext } = load(only("binilyrics", { lrcRedWordSync: "all" }), [
    ["lyrics-api.binimum.org", { results: [{ track_name: "Bad Romance", artist_name: "Lady Gaga", duration: 294, isrc: "X1", timing_type: "word", lyricsUrl: "https://lrc.red/s/X1.ttml" }] }],
    ["lrc.red/s/X1.ttml", TTML],
  ]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "BiniLyrics");
  assert.ok(/<00:01/.test(r.lines[0].words));
});

test("NetEase: YRC word timing preferred over LRC", () => {
  const { ext } = load(only("netease"), [
    ["search/get", { result: { songs: [{ id: 7, name: "Bad Romance", artists: [{ name: "Lady Gaga" }], duration: 294000 }] } }],
    ["song/lyric/v1", { yrc: { lyric: "[1000,2000](1000,500,0)Hel(1500,500,0)lo (2000,800,0)world" }, lrc: { lyric: "[00:01.00]Hello world" } }],
  ]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "NetEase");
  assert.ok(/<00:01.000>Hel/.test(r.lines[0].words));
});

test("NetEase: falls back to LRC, drops credit rows, JSON-lines lyric", () => {
  const routes = (lyric) => [
    ["search/get", { result: { songs: [{ id: 7, name: "Bad Romance", artists: [{ name: "Lady Gaga" }], duration: 294000 }] } }],
    ["song/lyric/v1", { lrc: { lyric } }],
  ];
  let r = load(only("netease"), routes("[00:00.00]作词 : A\n[00:05.00]real line")).ext.fetchLyrics(...TRACK);
  assert.deepEqual(wordsOf(r), ["real line"]);
  r = load(only("netease"), routes('{"t":1000,"c":[{"tx":"json "},{"tx":"line"}]}')).ext.fetchLyrics(...TRACK);
  assert.deepEqual(wordsOf(r), ["json line"]);
});

test("KuGou: KRC word timing, header line dropped", () => {
  const KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
  const krc = "[0,1000]<0,900,0>Bad Romance - Lady Gaga\n[1000,2000]<0,500,0>Hel<500,500,0>lo <1000,800,0>world\n";
  const z = zlib.deflateSync(Buffer.from(krc));
  const b64 = Buffer.concat([Buffer.from("krc1"), Buffer.from(z.map((b, i) => b ^ KEY[i % KEY.length]))]).toString("base64");
  const { ext, calls } = load(only("kugou"), [
    ["lyrics.kugou.com/search", { candidates: [{ id: "1", accesskey: "k", singer: "Lady Gaga", song: "Bad Romance", duration: 294000 }] }],
    ["fmt=krc", { content: b64 }],
  ]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "KuGou");
  assert.equal(r.lines.length, 1);
  assert.ok(r.lines[0].words.startsWith("<00:01.000>Hel"));
  assert.ok(calls.some((c) => c.url.includes("fmt=krc")));
});

test("KuGou: LRC fallback decodes base64 text", () => {
  const lrc = "[00:01.00]hello kugou\n[00:03.00]second";
  const { ext } = load(only("kugou"), [
    ["lyrics.kugou.com/search", { candidates: [{ id: "1", accesskey: "k", singer: "Lady Gaga", song: "Bad Romance", duration: 294000 }] }],
    ["fmt=krc", { content: "" }],
    ["fmt=lrc", { content: Buffer.from(lrc).toString("base64") }],
  ]);
  const r = ext.fetchLyrics(...TRACK);
  assert.deepEqual(wordsOf(r), ["hello kugou", "second"]);
});

test("Kuwo: first line shown, translation twin at the same time ignored, speaker tag skipped", () => {
  const { ext } = load(only("kuwo"), [
    ["searchMusicBykeyWord", { data: { list: [{ musicrid: "MUSIC_55", name: "Bad Romance", artist: "Lady Gaga", duration: 294 }] } }],
    ["getlyric", { data: { lrclist: [
      { time: "0.5", lineLyric: "Bad Romance - Lady Gaga" },
      { time: "2.0", lineLyric: "Lady Gaga：" },
      { time: "3.0", lineLyric: "I want your love" }, { time: "3.0", lineLyric: "我要你的爱" },
      { time: "6.0", lineLyric: "Second" } ] } }],
  ]);
  const r = ext.fetchLyrics(...TRACK);
  assert.deepEqual(wordsOf(r), ["I want your love", "Second"]);
});

test("QQ Music: base64 lyric with entities and a heading line", () => {
  const raw = "[00:00.00]Bad Romance - Lady Gaga\n[00:02.00]don&apos;t stop\n[00:05.00]go";
  const { ext } = load(only("qqmusic"), [
    [/DoSearchForQQMusicDesktop/, (u) => decodeURIComponent(u).includes("DoSearch") ? { req: { data: { body: { song: { list: [{ mid: "m1", title: "Bad Romance", singer: [{ name: "Lady Gaga" }], interval: 294 }] } } } } } : undefined],
    [/GetPlayLyricInfo/, { req: { data: { lyric: Buffer.from(raw).toString("base64") } } }],
  ]);
  const r = ext.fetchLyrics(...TRACK);
  assert.deepEqual(wordsOf(r), ["don't stop", "go"]);
});

test("Deezer: token, synchronized lines, line sync only", () => {
  const { ext, calls } = load(only("deezer"), [
    ["auth.deezer.com", { jwt: "JWT" }],
    ["api.deezer.com/search", { data: [{ id: 9, title: "Bad Romance", artist: { name: "Lady Gaga" }, duration: 294 }] }],
    ["pipe.deezer.com", { data: { track: { lyrics: { text: "a\nb", synchronizedLines: [{ line: "a", milliseconds: 1000 }, { line: "b", milliseconds: 3000 }] } } } }],
  ]);
  const r = ext.fetchLyrics(...TRACK);
  assert.deepEqual(wordsOf(r), ["a", "b"]);
  assert.ok(calls.some((c) => c.method === "POST" && c.url.includes("access_token=JWT")));
});

test("Musixmatch: needs a real token; richsync word timing", () => {
  const richsync = { richsync_body: JSON.stringify([{ ts: 1, te: 3, l: [{ c: "Hel", o: 0 }, { c: "lo", o: 0.5 }] }]) };
  const calls_ = {
    "matcher.track.get": { message: { header: { status_code: 200 } } },
    "track.richsync.get": { message: { body: { richsync } } },
  };
  const body = { message: { body: { macro_calls: calls_ } } };
  const routes = [["macro.subtitles.get", body]];
  assert.equal(load(only("musixmatch"), routes).ext.fetchLyrics(...TRACK), null);
  assert.equal(load(only("musixmatch", { musixmatchToken: "0".repeat(40) }), routes).ext.fetchLyrics(...TRACK), null);
  const r = load(only("musixmatch", { musixmatchToken: "abcdef0123456789abcdef0123456789" }), routes).ext.fetchLyrics(...TRACK);
  assert.ok(/<00:01.000>Hel/.test(r.lines[0].words));
});

test("LRCMux: word level and duration mismatch", () => {
  const body = (dur) => ({ track: { duration: dur }, meta: { level: "word", source: { id: "x", name: "Src" } }, lines: [{ text: "Hello world", start: 1000, end: 3000, words: [{ text: "Hello ", start: 1000, end: 1500 }, { text: "world", start: 1500, end: 3000 }] }] });
  let r = load(only("lrcmux"), [["api.lrcmux.dev/get", body(294)]]).ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "LRCMux (Src)");
  assert.ok(/<00:01.000>Hello/.test(r.lines[0].words));
  r = load(only("lrcmux"), [["api.lrcmux.dev/get", body(330)]]).ext.fetchLyrics(...TRACK);
  assert.equal(r, null);
});

test("Spicy Lyrics: finds the Spotify ID without keys, then word lines, duet voices, attribution", () => {
  const SID = "4u7EnebtmKWzUH433cf5Qv";
  const body = { Body: { Type: "Syllable", source: "spicy_lyrics", UploadAttribution: { Uploader: { username: "up" }, Maker: { username: "mk" } }, Content: [
    { Type: "Vocal", OppositeAligned: false, Lead: { StartTime: 1, EndTime: 3, Syllables: [{ Text: "Hel", IsPartOfWord: true, StartTime: 1, EndTime: 1.5 }, { Text: "lo", IsPartOfWord: false, StartTime: 1.5, EndTime: 3 }] }, Background: [{ StartTime: 2, EndTime: 2.5, Syllables: [{ Text: "ooh", IsPartOfWord: false, StartTime: 2, EndTime: 2.5 }] }] },
    { Type: "Vocal", OppositeAligned: true, Lead: { StartTime: 4, EndTime: 5, Syllables: [{ Text: "Bye", IsPartOfWord: false, StartTime: 4, EndTime: 5 }] } } ] } };
  const { ext } = load(only("spicy", { spicyKey: "sl_pk_x" }), [
    ["labs.api.listenbrainz.org", [{ spotify_track_ids: [SID] }]],
    ["api.spicylyrics.org/v1/lyrics/" + SID, body],
  ]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "Spicy Lyrics (uploaded by up, made by mk)");
  assert.ok(r.lines[0].words.startsWith("v1:<00:01.000>Hel"));
  assert.ok(r.lines[0].words.includes("\n[bg:<00:02.000>ooh"));
  assert.ok(r.lines[1].words.startsWith("v2:"));
});

test("Spicy Lyrics: skipped without a key; uses the desktop helper when on", () => {
  const SID = "4u7EnebtmKWzUH433cf5Qv";
  assert.equal(load(only("spicy"), []).ext.fetchLyrics(...TRACK), null);
  const { ext, calls } = load(only("spicy", { spicyKey: "k", useSpotifyApp: true }), [
    ["127.0.0.1:8089/search", { id: SID }],
    ["api.spicylyrics.org", { Body: { Type: "Line", Content: [{ Type: "Vocal", Text: "hi", StartTime: 1, EndTime: 2 }] } }],
  ]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.lines.length, 1);
  assert.ok(calls[0].url.startsWith("http://127.0.0.1:8089/search"));
});

test("AMLL TTML DB: by Spotify id, else NetEase id", () => {
  const SID = "4u7EnebtmKWzUH433cf5Qv";
  let r = load(only("amll"), [
    ["labs.api.listenbrainz.org", [{ spotify_track_ids: [SID] }]],
    ["spotify-lyrics/" + SID + ".ttml", TTML],
  ]).ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "AMLL TTML DB");
  r = load(only("amll"), [
    ["search/get", { result: { songs: [{ id: 77, name: "Bad Romance", artists: [{ name: "Lady Gaga" }], duration: 294000 }] } }],
    ["ncm-lyrics/77.ttml", TTML],
  ]).ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "AMLL TTML DB");
});

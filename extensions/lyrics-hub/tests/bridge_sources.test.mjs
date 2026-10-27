import { test, assert, load } from "./t.mjs";

const TRACK = ["Bad Romance", "Lady Gaga", "", 294];
const ALL = ["spicy","lrcred","amll","binilyrics","musixmatch","unison","lrclib","lrcmux","netease","qqmusic","kugou","kuwo","deezer","ytmusic","genius"];
const only = (ids, extra = {}) => { const s = { useSpotifyApp: false, ...extra }; for (const p of ALL) s["use_" + p] = ids.includes(p); return s; };
const H = "127.0.0.1:8089";
const gsong = (o) => ({ result: { id: 1, path: "/Gaga-bad-romance-lyrics", title: "Bad Romance", lyrics_state: "complete", primary_artist: { name: "Lady Gaga" }, stats: { pageviews: 5000 }, ...o } });
const search = (...songs) => ({ response: { sections: [{ type: "song", hits: songs }] } });
const gl = (text) => [H + "/genius/lyrics", { text }];

test("YouTube Music: ranks by title/artist/length, returns plain text with source", () => {
  const { ext, calls } = load(only(["ytmusic"]), [
    [H + "/ytm/search", { songs: [{ videoId: "AAAAAAAAAAA", title: "Bad Romance (Live)", artists: ["Lady Gaga"], durationMs: 294000 }, { videoId: "BBBBBBBBBBB", title: "Bad Romance", artists: ["Lady Gaga"], durationMs: 294500 }] }],
    [H + "/ytm/lyrics", (u) => u.includes("BBBBBBBBBBB") ? { text: "Rah rah\nah-ah-ah", source: "LyricFind" } : { text: null }],
  ]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "YouTube Music (LyricFind)");
  assert.equal(r.syncType, "UNSYNCED");
  assert.equal(r.plainLyrics, "Rah rah\nah-ah-ah");
  assert.ok(!calls.some((c) => c.url.includes("AAAAAAAAAAA")), "live version not used");
});

test("Genius strict: exact song and artist, lyrics by path and id", () => {
  const { ext, calls } = load(only(["genius"]), [
    [H + "/genius/search", search(gsong({})) ],
    gl("I want your love"),
  ]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "Genius");
  assert.equal(r.plainLyrics, "I want your love");
  assert.ok(calls.some((c) => c.url.includes("/genius/lyrics?path=%2FGaga-bad-romance-lyrics&id=1")));
});

test("Genius: results still being transcribed are ignored", () => {
  const { ext } = load(only(["genius"], { geniusLooseSearch: false }), [[H + "/genius/search", search(gsong({ lyrics_state: "unreleased" }))], gl("x")]);
  assert.equal(ext.fetchLyrics(...TRACK), null);
});

test("Genius loose search switch: a related artist is accepted only while loose search is on", () => {
  const routes = [[H + "/genius/search", search(gsong({ primary_artist: { name: "Lady Gogo" } }))], gl("loose lyrics")];
  assert.equal(load(only(["genius"], { geniusLooseSearch: false }), routes).ext.fetchLyrics(...TRACK), null);
  const on_ = load(only(["genius"], { geniusLooseSearch: true, geniusEagerMatch: false }), routes).ext.fetchLyrics(...TRACK);
  assert.equal(on_ && on_.plainLyrics, "loose lyrics");
});

test("Genius favourite artists: an uploader's song is found under the real artist's name", () => {
  // Spotify says the artist is "Yen"; Genius has the song by "jaydes". Searching by the title alone finds nothing useful.
  const route = (u) => {
    const q = decodeURIComponent(/q=([^&]+)/.exec(u)[1]);
    if (/jaydes/i.test(q)) return search(gsong({ id: 77, path: "/Jaydes-idiot-lyrics", title: "idiot", primary_artist: { name: "jaydes" } }));
    return search(gsong({ id: 5, path: "/Other-idiot-lyrics", title: "Idiot", primary_artist: { name: "Famous Band" }, stats: { pageviews: 9000000 } }), gsong({ id: 6, path: "/Third-idiot-lyrics", title: "Idiot", primary_artist: { name: "Another One" }, stats: { pageviews: 100 } }));
  };
  const routes = [[H + "/genius/search", route], [H + "/genius/lyrics", (u) => u.includes("Jaydes-idiot") ? { text: "real lyrics" } : { text: "WRONG SONG" }]];
  const without = load(only(["genius"], { geniusEagerMatch: false }), routes).ext.fetchLyrics("idiot", "Yen", "", 120);
  assert.equal(without, null, "two unrelated same-titled songs must not be guessed");
  const withFav = load(only(["genius"], { geniusEagerMatch: false, geniusFavoriteArtists: "jaydes, someone else" }), routes).ext.fetchLyrics("idiot", "Yen", "", 120);
  assert.equal(withFav.plainLyrics, "real lyrics");
});

test("Genius learns artists: after three songs the library is searched without a favourites list", () => {
  let current = null;
  const h = load(only(["genius"], { geniusEagerMatch: false }), [[H + "/genius/search", (u) => current(u)], [H + "/genius/lyrics", { text: "t" }]]);
  for (const n of ["songa", "songb", "songc"]) {
    // Spotify says "Jayz Dee", Genius says "jaydes": related but not the same name, so each match is noted.
    current = () => search(gsong({ id: 70, path: `/Jaydes-${n}-lyrics`, title: n, primary_artist: { name: "jaydes" } }));
    assert.ok(h.ext.fetchLyrics(n, "Jayz Dee", "", 100), "loose " + n);
  }
  const stored = JSON.parse(h.store.get("genius:artists"));
  assert.equal(stored.jaydes.songs.length, 3);
  // A fourth, obscure song: Genius' own search shows famous same-titled songs, but "<title> jaydes" finds it.
  current = (u) => {
    const q = decodeURIComponent(/q=([^&]+)/.exec(u)[1]);
    if (/jaydes/i.test(q)) return search(gsong({ id: 71, path: "/Jaydes-newsong-lyrics", title: "newsong", primary_artist: { name: "jaydes" } }));
    return search(gsong({ id: 5, path: "/Other-newsong-lyrics", title: "newsong", primary_artist: { name: "Famous One" } }), gsong({ id: 6, path: "/Third-newsong-lyrics", title: "newsong", primary_artist: { name: "Another One" } }));
  };
  const r = h.ext.fetchLyrics("newsong", "Yen", "", 100);
  assert.ok(r && r.provider === "Genius", "library artist found the song");
});

test("Genius eager: with nothing proven, the best-looking obscure result is used; off means none", () => {
  const route = [[H + "/genius/search", search(gsong({ id: 9, path: "/Someone-bad-romance-lyrics", title: "bad romance", primary_artist: { name: "unrelated person" }, stats: { pageviews: 300 } }))], gl("guessed")];
  const eager = load(only(["genius"], { geniusEagerMatch: true }), route).ext.fetchLyrics(...TRACK);
  assert.equal(eager && eager.plainLyrics, "guessed");
  const strictOnly = load(only(["genius"], { geniusEagerMatch: false }), route).ext.fetchLyrics(...TRACK);
  assert.equal(strictOnly, null);
});

test("helper not running: Genius/YouTube are skipped quickly and other sources still answer", () => {
  const { ext, calls } = load(only(["ytmusic", "genius", "lrclib"]), [["lrclib.net/api/get", { plainLyrics: "plain from lrclib", duration: 294 }], [H, { error: "connection refused" }]]);
  const r = ext.fetchLyrics(...TRACK);
  assert.equal(r.provider, "LRCLIB");
});

test("helper not running and nothing else: one failed call, genius skipped by the flag", () => {
  const { ext, calls } = load(only(["ytmusic", "genius"]), [[H, { error: "connection refused" }]]);
  assert.equal(ext.fetchLyrics(...TRACK), null);
  assert.equal(calls.filter((c) => c.url.includes(H)).length, 1);
  assert.ok(/skipped, the desktop helper is not reachable/.test(ext.lastLookup().message));
});

test("old helper without the new routes gives a clear message", () => {
  const { ext } = load(only(["genius"]), [[H + "/genius/search", { statusCode: 404, body: "{}" }]]);
  assert.equal(ext.fetchLyrics(...TRACK), null);
});

test("Genius and YouTube only run when nothing better was found (plain text is last)", () => {
  const { ext, calls } = load(only(["lrclib", "genius", "ytmusic"]), [["lrclib.net/api/get", { syncedLyrics: "[00:01.00]hi", duration: 294 }]]);
  ext.fetchLyrics(...TRACK);
  assert.ok(!calls.some((c) => c.url.includes(H)));
});

test("testConnection reports the helper's version and sources", () => {
  const { ext } = load(only(["genius"]), [[H + "/health", { ok: true, spotify: false, reason: "no page", version: "2.0", sources: ["genius", "ytm"] }]]);
  const r = ext.testConnection();
  assert.ok(/Genius\/YouTube Music available/.test(r.message), r.message);
});

test("helper on another machine: address forms, port setting, and the token goes in X-Bridge-Token", () => {
  const yt = (host) => [host + "/ytm/search", { songs: [{ videoId: "BBBBBBBBBBB", title: "Bad Romance", artists: ["Lady Gaga"], durationMs: 294000 }] }];
  const lyr = (host) => [host + "/ytm/lyrics", { text: "Rah rah", source: "LyricFind" }];
  for (const [bridgeHost, bridgePort, base] of [["laptop.tail1234.ts.net", "", "laptop.tail1234.ts.net:8089"], ["192.168.1.50:9000", "", "192.168.1.50:9000"],
    ["http://192.168.1.50", "9000", "192.168.1.50"], ["lap.local", "9100", "lap.local:9100"], ["192-168-1-171.sslip.io", "", "192-168-1-171.sslip.io:8089"], [" https://lyrics.example.org/ ", "", "lyrics.example.org"]]) {
    const { ext, calls } = load(only(["ytmusic"], { bridgeHost, bridgePort, bridgeToken: "secret-token-1234567" }), [yt(base), lyr(base)]);
    const r = ext.fetchLyrics(...TRACK);
    assert.equal(r && r.provider, "YouTube Music (LyricFind)", bridgeHost);
    assert.ok(calls.length >= 2 && calls.every((c) => JSON.stringify(c.headers).includes("secret-token-1234567")), "token sent on every call: " + bridgeHost);
    assert.ok(!calls.some((c) => c.url.includes("127.0.0.1")), "never the local address");
  }
});

test("helper token refused: a clear message, not 'no lyrics'", () => {
  const { ext } = load(only(["ytmusic"], { bridgeHost: "lap.local", bridgeToken: "wrong" }), [["lap.local:8089/ytm/search", () => ({ statusCode: 401, body: "{\"error\":\"missing or wrong token\"}" })]]);
  assert.equal(ext.fetchLyrics(...TRACK), null);
  assert.ok(/refused the token/.test(JSON.stringify(ext.lastLookup())), "trace says so");
});

test("helper unreachable: the test says where it tried and why, not 'HTTP undefined'", () => {
  const { ext } = load(only(["genius"], { bridgeHost: "lap.tail1.ts.net", bridgeToken: "x", spicyKey: "k", use_spicy: true }), [["lap.tail1.ts.net:8089", () => ({ error: "dns error: no such host" })]]);
  const msg = JSON.stringify(ext.testConnection());
  assert.ok(/not reachable at http:\/\/lap\.tail1\.ts\.net:8089 \(dns error/.test(msg), msg);
  assert.ok(!/undefined/.test(msg), msg);
});

// ---- The Spotify track ID, found once per song when a provider needs it -----------------------------
function spotifyIdOf(t) {
  if (t.spotifyId !== undefined) return t.spotifyId;
  t.spotifyId = null;
  try {
    var found = resolveSpotifyId(t.name, t.artist, t.durationSec);
    if (found.id) t.spotifyId = found.id;
    else record("spotify id: " + (found.error || "none"));
  } catch (e) {
    record("spotify id failed: " + String(e).slice(0, 120));
  }
  return t.spotifyId;
}

// ---- NetEase ---------------------------------------------------------------------------------------
var NETEASE = "https://music.163.com/api";

// NetEase turns away requests that don't look like its own web player ("Cheating"), so these go with every call.
var NETEASE_HEADERS = { "Accept": "application/json", "Referer": "https://music.163.com/", "Cookie": "os=pc; appver=2.9.7" };

function neteaseSongList(res) {
  var songs = res && res.result ? res.result.songs : null;
  if (!songs || !songs.length) return [];
  var cands = [];
  for (var i = 0; i < songs.length; i++) {
    var s = songs[i];
    var list = s.artists || s.ar || [];
    var artists = [];
    for (var a = 0; a < list.length; a++) artists.push(list[a].name || "");
    cands.push({ id: s.id, title: s.name || "", artists: artists, durationMs: s.duration || s.dt || 0 });
  }
  return cands;
}

function neteaseFindSongs(t) {
  var query = t.name + " " + t.artist;
  var cands = [];
  try { cands = neteaseSongList(getJson(NETEASE + "/search/get?" + qs({ s: query, type: 1, limit: 10, offset: 0 }), NETEASE_HEADERS)); } catch (e) {}
  var ranked = cands.length ? rankCandidates(t, cands) : [];
  if (!ranked.length) {
    // The other search the web player uses; it answers when the first one comes back empty.
    var more = neteaseSongList(getJson(NETEASE + "/cloudsearch/get/web?" + qs({ s: query, type: 1, limit: 10, offset: 0 }), NETEASE_HEADERS));
    ranked = more.length ? rankCandidates(t, more) : [];
  }
  return ranked.slice(0, 3);
}

// Lyrics stored as one JSON object per line: {"t":1000,"c":[{"tx":"words"}]}
function neteaseJsonLines(lyric) {
  var out = [];
  var rows = String(lyric).split(/\r?\n/);
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i].trim();
    if (row.charAt(0) !== "{") continue;
    try {
      var o = JSON.parse(row);
      if (typeof o.t !== "number" || !o.c) continue;
      var text = "";
      for (var k = 0; k < o.c.length; k++) text += o.c[k].tx || "";
      text = text.trim();
      if (isCreditLine(text)) continue;
      out.push({ startTimeMs: o.t, words: text, endTimeMs: 0 });
    } catch (e) {}
  }
  return out;
}

function fetchNetEase(t) {
  var songs = neteaseFindSongs(t);
  for (var i = 0; i < songs.length; i++) {
    var lyric = getJson(NETEASE + "/song/lyric/v1?" + qs({ id: songs[i].id, lv: 1, yv: 1 }), NETEASE_HEADERS);
    if (!lyric || lyric.nolyric) continue;
    if (lyric.yrc && lyric.yrc.lyric) {
      var yrc = linesResult(parseYrc(lyric.yrc.lyric), "NetEase");
      if (yrc) return yrc;
    }
    var lrc = lyric.lrc && lyric.lrc.lyric;
    if (lrc) {
      var res = linesResult(parseLRC(lrc), "NetEase") || linesResult(neteaseJsonLines(lrc), "NetEase") || lrcResult(lrc, "NetEase");
      if (res) return res;
    }
  }
  return null;
}

// ---- QQ Music ----------------------------------------------------------------------------------------
var QQ = "https://u.y.qq.com/cgi-bin/musicu.fcg";

function qqCall(req) {
  return getJson(QQ + "?" + qs({ format: "json", data: JSON.stringify(req) }));
}

function qqFindSongs(t) {
  var res = qqCall({
    comm: { ct: 19, cv: 1859, uin: 0 },
    req: { module: "music.search.SearchCgiService", method: "DoSearchForQQMusicDesktop", param: { query: t.name + " " + t.artist, num_per_page: 10, page_num: 1, search_type: 0 } }
  });
  var list = res && res.req && res.req.data && res.req.data.body && res.req.data.body.song ? res.req.data.body.song.list : null;
  if (!list || !list.length) return [];
  var cands = [];
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (!s.mid) continue;
    var artists = [];
    for (var a = 0; a < (s.singer || []).length; a++) artists.push(s.singer[a].name || "");
    cands.push({ mid: s.mid, title: s.title || s.name || "", artists: artists, durationMs: (s.interval || 0) * 1000 });
  }
  return rankCandidates(t, cands).slice(0, 3);
}

function qqLyric(mid) {
  var res = qqCall({
    comm: { ct: 24, cv: 0 },
    req: { module: "music.musichallSong.PlayLyricInfo", method: "GetPlayLyricInfo", param: { songMID: mid, trans: 0, roma: 0 } }
  });
  var enc = res && res.req && res.req.data ? res.req.data.lyric : null;
  if (typeof enc !== "string" || !enc) return null;
  return utf8string(b64bytes(enc)).replace(/&(?:apos|quot|amp|lt|gt|#39);/g, function (m) {
    return { "&apos;": "'", "&#39;": "'", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">" }[m] || m;
  });
}

function fetchQQ(t) {
  var songs = qqFindSongs(t);
  for (var i = 0; i < songs.length; i++) {
    var raw = qqLyric(songs[i].mid);
    if (!raw) continue;
    var rows = raw.split(/\r?\n/);
    var first = -1;
    for (var r = 0; r < rows.length; r++) if (/^\[\d/.test(rows[r])) { first = r; break; }
    // The first timed line is usually "Title - Artist": a heading, not a lyric.
    if (first >= 0 && /^\[0?0:0\d[^\]]*\].+ - .+/.test(rows[first])) rows.splice(first, 1);
    var res = lrcResult(rows.join("\n"), "QQ Music");
    if (res) return res;
  }
  return null;
}

// ---- KuGou ---------------------------------------------------------------------------------------------
var KUGOU = "https://lyrics.kugou.com";

function kugouRank(t, list) {
  var cands = [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var artists = String(c.singer || "").split(/[、,&\/]/);
    var clean = [];
    for (var a = 0; a < artists.length; a++) if (artists[a].trim()) clean.push(artists[a].trim());
    cands.push({ id: c.id, accesskey: c.accesskey, title: c.song || "", artists: clean, durationMs: c.duration || 0 });
  }
  return rankCandidates(t, cands).slice(0, 3);
}

function kugouFind(t) {
  var title = cleanTitle(t.name);
  var keywords = [t.artist + " - " + title, t.artist + " - " + title.toLowerCase(), title, title.toLowerCase()];
  var seen = {};
  var found = [];
  for (var k = 0; k < keywords.length; k++) {
    if (seen["k" + keywords[k]]) continue;
    seen["k" + keywords[k]] = true;
    var res = getJson(KUGOU + "/search?" + qs({ ver: 1, man: "yes", client: "pc", keyword: keywords[k], duration: t.durationMs || 0 }));
    var cs = res && res.candidates ? res.candidates : [];
    for (var i = 0; i < cs.length; i++) {
      if (cs[i] && cs[i].id && cs[i].accesskey && !seen["i" + cs[i].id]) { seen["i" + cs[i].id] = true; found.push(cs[i]); }
    }
    var ranked = kugouRank(t, found);
    if (ranked.length) return ranked;
  }
  return [];
}

function kugouDownload(id, accesskey, fmt) {
  var res = getJson(KUGOU + "/download?" + qs({ ver: 1, client: "pc", id: id, accesskey: accesskey, fmt: fmt, charset: "utf8" }));
  return res && typeof res.content === "string" && res.content ? res.content : null;
}

// KuGou starts most lyrics with a "Title - Artist" line at 0:00; it is not a lyric.
function dropKugouHeader(lines, t) {
  var flat = function (s) { return nfkc(s).toLowerCase().replace(NON_WORD, ""); };
  if (lines.length && lines[0].startTimeMs < 1000) {
    var f = flat(plainFromWords(lines[0].words));
    if (f && f.indexOf(flat(cleanTitle(t.name))) !== -1 && f.indexOf(flat(t.artist)) !== -1) return lines.slice(1);
  }
  return lines;
}

function fetchKugou(t) {
  var songs = kugouFind(t);
  for (var i = 0; i < songs.length; i++) {
    try {
      var krc = kugouDownload(songs[i].id, songs[i].accesskey, "krc");
      var text = krc ? decodeKrc(krc) : null;
      var lines = text ? dropKugouHeader(parseKrc(text), t) : [];
      var res = linesResult(lines, "KuGou");
      if (res) return res;
    } catch (e) {
      record("kugou krc failed: " + String(e).slice(0, 80));
    }
    var lrc = kugouDownload(songs[i].id, songs[i].accesskey, "lrc");
    if (!lrc) continue;
    var lrcLines = dropKugouHeader(parseLRC(utf8string(b64bytes(lrc))), t);
    var res2 = linesResult(lrcLines, "KuGou");
    if (res2) return res2;
  }
  return null;
}

// ---- Kuwo (line sync only) -----------------------------------------------------------------------------
var KUWO = "https://www.kuwo.cn/openapi/v1/www";

function fetchKuwo(t) {
  var title = cleanTitle(t.name) || t.name;
  var res = getJson(KUWO + "/search/searchMusicBykeyWord?" + qs({ key: title + " " + t.artist, pn: 1, rn: 20 }));
  var list = res && res.data ? res.data.list : null;
  if (!list || !list.length) return null;
  var cands = [];
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (!s.musicrid) continue;
    var names = String(s.artist || "").split("&");
    var artists = [];
    for (var a = 0; a < names.length; a++) if (names[a].trim()) artists.push(names[a].trim());
    cands.push({ id: String(s.musicrid).replace(/^MUSIC_/, ""), title: s.name || "", artists: artists, durationMs: (s.duration || 0) * 1000 });
  }
  var ranked = rankCandidates(t, cands).slice(0, 3);
  for (var r = 0; r < ranked.length; r++) {
    try {
      var l = getJson(KUWO + "/lyric/getlyric?" + qs({ musicId: ranked[r].id }));
      var rows = l && l.data ? l.data.lrclist : null;
      if (!rows || !rows.length) continue;
      var seen = {};
      var lines = [];
      for (var k = 0; k < rows.length; k++) {
        var time = parseFloat(rows[k].time);
        var text = String(rows[k].lineLyric || "").trim();
        if (!isFinite(time) || !text || isCreditLine(text) || /TME享有|版权所有|著作权/.test(text) || /^[^:：]{1,40}[:：]$/.test(text)) continue;
        // Where a line and its translation share a time, the first is the original.
        if (seen[time]) continue;
        seen[time] = true;
        lines.push({ startTimeMs: Math.round(time * 1000), words: text, endTimeMs: 0 });
      }
      // The first line, at 0:00, is "Title - Artist".
      var flat = function (s) { return nfkc(s).toLowerCase().replace(NON_WORD, ""); };
      if (lines.length && lines[0].startTimeMs < 1000) {
        var f = flat(lines[0].words);
        if (f.indexOf(flat(cleanTitle(t.name))) !== -1 && f.indexOf(flat(t.artist)) !== -1) lines.shift();
      }
      var res2 = linesResult(lines, "Kuwo");
      if (res2) return res2;
    } catch (e) {
      record("kuwo lyric failed: " + String(e).slice(0, 80));
    }
  }
  return null;
}

// ---- Deezer (line sync at best) ------------------------------------------------------------------------
function deezerToken() {
  var cached = storage.get("deezerToken");
  var exp = storage.get("deezerTokenExp");
  if (cached && exp && exp > Date.now()) return cached;
  var res = getJson("https://auth.deezer.com/login/anonymous?jo=p&rto=c");
  if (!res || typeof res.jwt !== "string") throw new Error("Deezer gave no token");
  storage.set("deezerToken", res.jwt);
  storage.set("deezerTokenExp", Date.now() + 4 * 60 * 1000);
  return res.jwt;
}

function fetchDeezer(t) {
  var list = null;
  var res = getJson("https://api.deezer.com/search?" + qs({ q: 'artist:"' + t.artist + '" track:"' + t.name + '"', limit: 10 }));
  list = res && res.data ? res.data : null;
  if (!list || !list.length) {
    var loose = getJson("https://api.deezer.com/search?" + qs({ q: t.artist + " " + t.name, limit: 10 }));
    list = loose && loose.data ? loose.data : null;
  }
  if (!list || !list.length) return null;
  var cands = [];
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    cands.push({ id: d.id, title: (d.title || "") + (d.title_version ? " " + d.title_version : ""), artists: [d.artist && d.artist.name ? d.artist.name : ""], durationMs: (d.duration || 0) * 1000 });
  }
  var ranked = rankCandidates(t, cands).slice(0, 3);
  var query = "query GetLyrics($trackId: String!) { track(trackId: $trackId) { lyrics { text synchronizedLines { line milliseconds duration } } } }";
  for (var r = 0; r < ranked.length; r++) {
    try {
      var url = "https://pipe.deezer.com/api?access_token=" + encodeURIComponent(deezerToken());
      var resp = http.post(url, JSON.stringify({ query: query, variables: { trackId: String(ranked[r].id) } }), { "Content-Type": "application/json" });
      if (!resp.ok) throw new Error("Deezer answered " + resp.statusCode);
      var data = JSON.parse(resp.body);
      var lyr = data && data.data && data.data.track ? data.data.track.lyrics : null;
      if (!lyr) continue;
      var lines = [];
      var sl = lyr.synchronizedLines || [];
      for (var k = 0; k < sl.length; k++) {
        if (typeof sl[k].milliseconds !== "number") continue;
        lines.push({ startTimeMs: sl[k].milliseconds, words: String(sl[k].line || "").trim(), endTimeMs: 0 });
      }
      var synced = linesResult(lines, "Deezer");
      if (synced) return synced;
      var plain = plainResult(lyr.text, "Deezer");
      if (plain) return plain;
    } catch (e) {
      try { storage.remove("deezerToken"); } catch (e2) {}
      record("deezer failed: " + String(e).slice(0, 80));
    }
  }
  return null;
}

// ---- Musixmatch (needs your own user token) ------------------------------------------------------------
function fetchMusixmatch(t) {
  var token = str("musixmatchToken");
  if (token.length <= 20 || !/[^0]/.test(token)) return null;
  var dur = t.durationSec > 0 ? Math.round(t.durationSec) : "";
  var q = {
    format: "json", namespace: "lyrics_richsynched", subtitle_format: "mxm", app_id: "web-desktop-app-v1.0",
    usertoken: token, optional_calls: "track.richsync", q_track: t.name, q_artist: t.artist, q_album: t.album || "",
    q_duration: dur, f_subtitle_length: dur
  };
  var id = t.spotifyId !== undefined ? t.spotifyId : null;
  if (id) q.track_spotify_id = id;
  var res = getJson("https://apic-desktop.musixmatch.com/ws/1.1/macro.subtitles.get?" + qs(q), { "Cookie": "x-mxm-token-guid=" });
  var calls = res && res.message && res.message.body ? res.message.body.macro_calls : null;
  if (!calls) return null;
  var matcher = calls["matcher.track.get"];
  if (!matcher || !matcher.message || !matcher.message.header || matcher.message.header.status_code !== 200) return null;

  var parseJ = function (v) { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } };
  var rich = calls["track.richsync.get"];
  var richBody = rich && rich.message && rich.message.body && rich.message.body.richsync ? rich.message.body.richsync.richsync_body : null;
  var parsedRich = parseJ(richBody);
  var wordRes = parsedRich ? linesResult(parseRichsync(parsedRich), "Musixmatch") : null;
  if (wordRes) return wordRes;

  var subs = calls["track.subtitles.get"];
  var list = subs && subs.message && subs.message.body && subs.message.body.subtitle_list ? subs.message.body.subtitle_list : null;
  var subBody = list && list[0] && list[0].subtitle ? parseJ(list[0].subtitle.subtitle_body) : null;
  if (subBody) {
    var lines = [];
    for (var i = 0; i < subBody.length; i++) {
      if (!subBody[i].time || typeof subBody[i].time.total !== "number") continue;
      lines.push({ startTimeMs: Math.round(subBody[i].time.total * 1000), words: String(subBody[i].text || "").trim(), endTimeMs: 0 });
    }
    var lineRes = linesResult(lines, "Musixmatch");
    if (lineRes) return lineRes;
  }
  var lyr = calls["track.lyrics.get"];
  var plain = lyr && lyr.message && lyr.message.body && lyr.message.body.lyrics ? lyr.message.body.lyrics.lyrics_body : null;
  return typeof plain === "string" ? plainResult(plain.replace(/\n?\*{3,}[\s\S]*$/, ""), "Musixmatch") : null;
}

// ---- LRCMux --------------------------------------------------------------------------------------------
function muxRequest(t, extra) {
  var q = { artist: t.artist, title: t.name, level: "word", format: "json" };
  if (t.album) q.album = t.album;
  if (t.durationSec > 0) q.duration = Math.round(t.durationSec);
  for (var k in (extra || {})) q[k] = extra[k];
  var r = get("https://api.lrcmux.dev/get?" + qs(q));
  if (r.statusCode === 404) return null;
  if (r.statusCode === 429) throw new Error("LRCMux is rate limiting");
  if (!r.ok) throw new Error("LRCMux answered " + r.statusCode);
  return JSON.parse(r.body);
}

function muxCensored(body) {
  var re = /\p{L}\*+|\*+\p{L}/u;
  var lines = body.lines || [];
  for (var i = 0; i < lines.length; i++) {
    if (re.test(lines[i].text)) return true;
    var w = lines[i].words || [];
    for (var j = 0; j < w.length; j++) if (re.test(w[j].text)) return true;
  }
  return false;
}

function fetchLrcMux(t) {
  var body = muxRequest(t);
  if (!body) return null;
  // KuGou censors profanity; another source's uncensored text beats asterisks.
  if (body.meta && body.meta.source && body.meta.source.id === "kugou" && muxCensored(body)) {
    try {
      var alt = muxRequest(t, { sources: "!kugou" });
      if (alt && !muxCensored(alt)) body = alt;
    } catch (e) { record("lrcmux uncensored lookup failed"); }
  }
  var theirs = body.track && body.track.duration;
  if (theirs && t.durationSec > 0 && Math.abs(theirs - t.durationSec) > 8) return null;
  var lines = body.lines || [];
  if ((body.meta && body.meta.instrumental) || !lines.length) return null;
  var level = body.meta && body.meta.level;
  var credit = "LRCMux" + (body.meta && body.meta.source && body.meta.source.name ? " (" + body.meta.source.name + ")" : "");
  if (level === "word") return linesResult(muxWordLines(lines), credit) || linesResult(muxLineLines(lines), credit);
  if (level === "line") return linesResult(muxLineLines(lines), credit);
  if (level === "none") {
    var rows = [];
    for (var i = 0; i < lines.length; i++) if (!isCreditLine(lines[i].text)) rows.push(muxTidy(lines[i].text));
    return plainResult(rows.join("\n"), credit);
  }
  return null;
}

// ---- AMLL TTML DB (word-timed lyrics filed by Spotify or NetEase id) --------------------------------
function amllGet(folder, id) {
  return getText("https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main/" + folder + "/" + encodeURIComponent(id) + ".ttml");
}

function fetchAmll(t) {
  var id = spotifyIdOf(t);
  if (id) {
    var text = amllGet("spotify-lyrics", id);
    var res = text ? linesResult(parseTTML(text), "AMLL TTML DB") : null;
    if (res) return res;
  }
  var songs = neteaseFindSongs(t).slice(0, 2);
  for (var i = 0; i < songs.length; i++) {
    var ttml = amllGet("ncm-lyrics", String(songs[i].id));
    var r2 = ttml ? linesResult(parseTTML(ttml), "AMLL TTML DB") : null;
    if (r2) return r2;
  }
  return null;
}

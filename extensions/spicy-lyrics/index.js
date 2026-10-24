// Spicy Lyrics provider for SpotiFLAC Mobile.
// SpotiFLAC passes (title, artist, album, duration) but Spicy Lyrics is keyed by
// Spotify track ID, so the ID is resolved with a Spotify client-credentials search.
// Attribution is mandatory per https://developers.spicylyrics.org/docs/attribution
// and is carried in the `provider` string the app shows.
var settings = {};

function initialize(config) {
  settings = config || {};
  return true;
}

function cleanup() {}

var trace = [];

function record(msg) { trace.push(String(msg)); }

function saveTrace() {
  try { storage.set("lastTrace", new Date().toISOString() + " | " + trace.join(" | ")); } catch (e) {}
}

function lastLookup() {
  var t = storage.get("lastTrace");
  return { success: true, message: t || "No lookup has run yet. Download or re-fetch lyrics for a track, then tap this again." };
}

function resetToken() {
  try { storage.remove("spotifyToken"); storage.remove("spotifyTokenExp"); } catch (e) {}
  return { success: true, message: "Token cache cleared" };
}

function testConnection() {
  var steps = [];
  if (!settings.spicyKey) return { success: false, error: "Spicy Lyrics API key is empty" };
  try {
    var title = "Bad Romance";
    var who = "Lady Gaga";
    var secs = 294;
    if (settings.testTrack && settings.testTrack.indexOf(" - ") !== -1) {
      title = settings.testTrack.split(" - ")[0].trim();
      who = settings.testTrack.split(" - ").slice(1).join(" - ").trim();
      secs = 0;
    }
    trace = [];
    var found = resolveSpotifyId(title, who, secs);
    if (!found.id) return { success: false, error: "Could not find a Spotify ID: " + found.error };
    steps.push("Track ID lookup OK (" + found.id + ")");
    var resp = http.get("https://api.spicylyrics.org/v1/lyrics/" + found.id, { "Authorization": "Bearer " + settings.spicyKey });
    if (!resp.ok) {
      var code = "";
      try { code = JSON.parse(resp.body).Body.error; } catch (e) {}
      return { success: false, error: steps.join("; ") + "; Spicy Lyrics HTTP " + resp.statusCode + (code ? " " + code : "") };
    }
    steps.push("Spicy Lyrics OK");
    return { success: true, message: steps.join("; ") };
  } catch (err) {
    return { success: false, error: steps.join("; ") + "; exception: " + String(err) };
  }
}

function formEncode(obj) {
  return Object.keys(obj)
    .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]); })
    .join("&");
}

function getSpotifyToken() {
  var now = Date.now();
  var cached = storage.get("spotifyToken");
  var exp = storage.get("spotifyTokenExp");
  if (cached && exp && exp - 60000 > now) return cached;

  if (!settings.spotifyClientId || !settings.spotifyClientSecret) return null;
  var basic = btoa(settings.spotifyClientId + ":" + settings.spotifyClientSecret);
  var resp = http.post(
    "https://accounts.spotify.com/api/token",
    formEncode({ grant_type: "client_credentials" }),
    { "Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + basic }
  );
  if (!resp.ok) {
    log.warn("Spotify token request failed: HTTP " + resp.statusCode);
    return null;
  }
  var data = JSON.parse(resp.body);
  storage.set("spotifyToken", data.access_token);
  storage.set("spotifyTokenExp", now + (data.expires_in || 3600) * 1000);
  return data.access_token;
}

function normalize(s) {
  var t = String(s || "").toLowerCase();
  t = t.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  var dash = t.indexOf(" - ");
  if (dash !== -1) t = t.slice(0, dash);
  var out = "";
  for (var i = 0; i < t.length; i++) {
    var c = t.charAt(i);
    var code = t.charCodeAt(i);
    if (c === "'" || c === "\u2019" || c === "\u2018") continue; // don't == don\u2019t
    if (code === 0x2013 || code === 0x2014 || code === 0x2010 || code === 0x2011) out += " ";
    else if ((code >= 48 && code <= 57) || (code >= 97 && code <= 122) || code > 127) out += c;
    else out += " ";
  }
  return out.split(" ").filter(function (w) { return w.length > 0; }).join(" ");
}

function searchSpotify(token, q) {
  var url = "https://api.spotify.com/v1/search?type=track&limit=10&q=" + encodeURIComponent(q);
  var resp = http.get(url, { "Authorization": "Bearer " + token });
  if (resp.statusCode === 401) {
    resetToken();
    return { error: "Spotify rejected the token (401)" };
  }
  if (!resp.ok) {
    var detail = "";
    try { detail = (JSON.parse(resp.body).error || {}).message || ""; } catch (e) {}
    log.error("Spotify search failed: HTTP " + resp.statusCode + " " + detail);
    return { error: "Spotify search failed: HTTP " + resp.statusCode + (detail ? " (" + detail + ")" : "") };
  }
  return { items: (JSON.parse(resp.body).tracks || {}).items || [] };
}

function pickMatch(items, track, artist, durationSec) {
  var wantTitle = normalize(track);
  var wantArtist = normalize(artist);
  var best = null;
  var bestScore = -1;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var score = 0;
    var name = normalize(it.name);
    if (name === wantTitle) score += 3;
    else if (wantTitle && name && (name.indexOf(wantTitle) !== -1 || wantTitle.indexOf(name) !== -1)) score += 1;
    else continue;
    var artistHit = false;
    for (var a = 0; a < it.artists.length; a++) {
      var n = normalize(it.artists[a].name);
      if (n && (wantArtist.indexOf(n) !== -1 || n.indexOf(wantArtist) !== -1)) artistHit = true;
    }
    if (!artistHit) continue;
    score += 2;
    if (durationSec > 0) {
      var diff = Math.abs(it.duration_ms / 1000 - durationSec);
      if (diff <= 2) score += 3;
      else if (diff <= 5) score += 1;
      else if (diff > 15) continue; // a different recording; never swap silently
    }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return best;
}

// ---- Key-free resolution: iTunes / Deezer search -> Odesli (song.link) -> Spotify ID ----
function spotifyIdFromLinks(sourceUrl) {
  // UniTune (the same free service SpotiFLAC uses) first; song.link now wants a key, so it is only a fallback.
  var hosts = [
    { name: "UniTune", url: "https://api.unitune.art/v1-alpha.1/links?url=" },
    { name: "song.link", url: "https://api.song.link/v1-alpha.1/links?url=" }
  ];
  var errors = [];
  for (var i = 0; i < hosts.length; i++) {
    var resp;
    try {
      resp = http.get(hosts[i].url + encodeURIComponent(sourceUrl), { "Accept": "application/json" });
    } catch (e) {
      errors.push(hosts[i].name + " failed: " + String(e));
      continue;
    }
    if (resp.statusCode === 429) { errors.push(hosts[i].name + " rate limit"); continue; }
    if (!resp.ok) { errors.push(hosts[i].name + " HTTP " + resp.statusCode); continue; }
    var data;
    try { data = JSON.parse(resp.body); } catch (e2) { errors.push(hosts[i].name + " sent invalid JSON"); continue; }
    var sp = data.linksByPlatform && data.linksByPlatform.spotify;
    if (sp) {
      var m = /track\/([A-Za-z0-9]{22})/.exec(sp.url || "") || /([A-Za-z0-9]{22})$/.exec(sp.entityUniqueId || "");
      if (m) return { id: m[1] };
    }
    errors.push(hosts[i].name + " has no Spotify link");
  }
  return { error: errors.join(", ") };
}

function durationOk(candidateSec, wantSec) {
  if (!(wantSec > 0) || !(candidateSec > 0)) return true;
  return Math.abs(candidateSec - wantSec) <= 15;
}

function artistMatches(candidateArtist, wanted) {
  var c = normalize(candidateArtist);
  var w = normalize(wanted);
  return !!c && !!w && (w.indexOf(c) !== -1 || c.indexOf(w) !== -1);
}

function titleMatches(candidateTitle, wanted) {
  var c = normalize(candidateTitle);
  var w = normalize(wanted);
  return !!c && !!w && (c === w || c.indexOf(w) !== -1 || w.indexOf(c) !== -1);
}

function resolveViaItunes(track, artist, durationSec) {
  var firstArtist = artist.split(/[,&;]/)[0].trim();
  var resp = http.get("https://itunes.apple.com/search?media=music&entity=song&limit=15&term=" +
    encodeURIComponent(track + " " + firstArtist), {});
  if (!resp.ok) return { error: "iTunes HTTP " + resp.statusCode };
  var results = JSON.parse(resp.body).results || [];
  var matched = 0;
  var linkError = "";
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!titleMatches(r.trackName, track) || !artistMatches(r.artistName, artist)) continue;
    if (!durationOk((r.trackTimeMillis || 0) / 1000, durationSec)) continue;
    if (!r.trackViewUrl) continue;
    matched++;
    var out;
    try { out = spotifyIdFromLinks(r.trackViewUrl); }
    catch (e) { out = { error: "song.link failed: " + String(e) }; }
    if (out.id || /rate limit/.test(out.error || "")) return out;
    linkError = out.error;
    if (matched >= 3) break; // do not spend the rate limit on more
  }
  if (matched) return { error: "iTunes matched " + matched + " but " + linkError };
  var first = results[0] ? ' first: "' + results[0].trackName + '" by "' + results[0].artistName + '" ' + Math.round((results[0].trackTimeMillis || 0) / 1000) + "s" : "";
  return { error: "No iTunes match (" + results.length + " results;" + first + ")" };
}

function resolveViaDeezer(track, artist, durationSec) {
  var firstArtist = artist.split(/[,&;]/)[0].trim();
  var resp = http.get("https://api.deezer.com/search?limit=15&q=" +
    encodeURIComponent('track:"' + track.replace(/"/g, "") + '" artist:"' + firstArtist.replace(/"/g, "") + '"'), {});
  if (!resp.ok) return { error: "Deezer HTTP " + resp.statusCode };
  var results = JSON.parse(resp.body).data || [];
  var matched = 0;
  var linkError = "";
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!titleMatches(r.title, track) || !artistMatches(r.artist && r.artist.name, artist)) continue;
    if (!durationOk(r.duration, durationSec)) continue;
    matched++;
    var out;
    try { out = spotifyIdFromLinks("https://www.deezer.com/track/" + r.id); }
    catch (e) { out = { error: "song.link failed: " + String(e) }; }
    if (out.id || /rate limit/.test(out.error || "")) return out;
    linkError = out.error;
    if (matched >= 3) break;
  }
  if (matched) return { error: "Deezer matched " + matched + " but " + linkError };
  var firstD = results[0] ? ' first: "' + results[0].title + '" by "' + (results[0].artist && results[0].artist.name) + '" ' + results[0].duration + "s" : "";
  return { error: "No Deezer match (" + results.length + " results;" + firstD + ")" };
}

function resolveSpotifyId(track, artist, durationSec) {
  var cacheKey = "id:" + normalize(track) + "|" + normalize(artist) + "|" + Math.round((durationSec || 0) / 5);
  var cached = storage.get(cacheKey);
  if (cached) { record("id cached " + cached); return { id: cached }; }

  var errors = [];
  var found = null;

  if (settings.spotifyClientId && settings.spotifyClientSecret) {
    found = findSpotifyId(track, artist, durationSec);
    if (found.error) errors.push(found.error);
  }
  if (!found || !found.id) {
    var steps = [resolveViaItunes, resolveViaDeezer];
    for (var i = 0; i < steps.length; i++) {
      try { found = steps[i](track, artist, durationSec); } catch (e) { found = { error: String(e) }; }
      if (found.id) break;
      errors.push(found.error);
      if (/rate limit/.test(found.error || "")) break;
    }
  }
  if (found && found.id) {
    record("id " + found.id);
    storage.set(cacheKey, found.id);
    return found;
  }
  record("id lookup failed: " + (errors.join("; ") || "No match"));
  return { error: errors.join("; ") || "No match" };
}

// Returns { id } or { error }.
function findSpotifyId(track, artist, durationSec) {
  var token = getSpotifyToken();
  if (!token) return { error: "Could not get a Spotify token (check Client ID / Secret)" };

  var firstArtist = artist.split(/[,&;]/)[0].trim();
  var queries = [
    'track:"' + track.replace(/"/g, "") + '" artist:"' + firstArtist.replace(/"/g, "") + '"',
    track + " " + firstArtist
  ];
  var lastError = null;
  for (var i = 0; i < queries.length; i++) {
    var res = searchSpotify(token, queries[i]);
    if (res.error) { lastError = res.error; if (/401/.test(res.error)) break; continue; }
    var hit = pickMatch(res.items, track, artist, durationSec);
    if (hit) return { id: hit.id };
  }
  return { error: lastError || "No matching Spotify track" };
}

function ms(sec) { return Math.round((sec || 0) * 1000); }

function joinSyllables(group) {
  var out = "";
  var syl = (group && group.Syllables) || [];
  for (var i = 0; i < syl.length; i++) {
    out += syl[i].Text;
    if (!syl[i].IsPartOfWord && i < syl.length - 1) out += " ";
  }
  return out.trim();
}

// ---- Word-sync helpers ------------------------------------------------------
// Mornye reads word timing from enhanced-LRC tags inside each line's text:
//   <mm:ss.xxx>word <mm:ss.xxx>word<mm:ss.xxx>   (start tag, text, end tag)
// Background vocals go on their own "[bg:...]" row after the lead line.
var TAG_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

function pad(n, w) {
  var s = String(n);
  while (s.length < w) s = "0" + s;
  return s;
}

function tag(msVal) {
  var t = Math.max(0, Math.round(msVal || 0));
  var sec = Math.floor(t / 1000);
  return "<" + pad(Math.floor(sec / 60), 2) + ":" + pad(sec % 60, 2) + "." + pad(t % 1000, 3) + ">";
}

function stripTags(s) { return String(s).replace(TAG_RE, ""); }

// segs: [{ start: ms, end: ms, text: "word " }]
function cleanSegs(segs) {
  var out = [];
  for (var i = 0; i < segs.length; i++) {
    if (stripTags(segs[i].text).replace(/\s+/g, "") === "") continue;
    out.push({ start: segs[i].start, end: segs[i].end, text: stripTags(segs[i].text) });
  }
  if (out.length) {
    out[0].text = out[0].text.replace(/^\s+/, "");
    out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, "");
  }
  return out;
}

function serializeSegs(segs) {
  var out = "";
  for (var i = 0; i < segs.length; i++) {
    out += tag(segs[i].start) + segs[i].text;
    if (segs[i].end > segs[i].start) out += tag(segs[i].end);
  }
  return out;
}

// Lead syllables + optional background groups -> one line string, or "".
function buildWordLine(lead, bgGroups) {
  lead = cleanSegs(lead);
  var bgs = [];
  for (var i = 0; i < bgGroups.length; i++) {
    var g = cleanSegs(bgGroups[i]);
    if (g.length) bgs.push(g);
  }
  if (!lead.length && bgs.length) lead = bgs.shift();
  if (!lead.length) return "";
  var words = serializeSegs(lead);
  // Background rows are shown unless the user turns them off.
  if (!settings || settings.backgroundVocals !== false) {
    for (var j = 0; j < bgs.length; j++) words += "\n[bg:" + serializeSegs(bgs[j]) + "]";
  }
  return words;
}

// Line text with every timing tag removed; background rows become "(...)".
function plainFromWords(words) {
  var rows = String(words).split("\n");
  var main = stripTags(rows[0]).replace(/^\s*v[1-9]\d*:\s*/i, "").replace(/\s+/g, " ").trim();
  for (var i = 1; i < rows.length; i++) {
    var r = /^\s*\[bg:([\s\S]*)\]\s*$/i.exec(rows[i]);
    if (!r) continue;
    var t = stripTags(r[1]).replace(/\s+/g, " ").trim();
    if (t) main += " (" + t + ")";
  }
  return main;
}

function plainOf(lines) {
  var arr = [];
  for (var i = 0; i < lines.length; i++) {
    var p = plainFromWords(lines[i].words);
    if (p) arr.push(p);
  }
  return arr.join("\n");
}

// Shifts every line and word time by the user's "Timing offset" (ms, negative = earlier).
function applyOffset(lines) {
  // "Word-by-word timing" off: send plain line-synced lyrics (useful for comparing against the app).
  if (settings && settings.wordSync === false) {
    for (var w = 0; w < lines.length; w++) lines[w].words = stripTags(lines[w].words);
    return lines;
  }
  var off = parseInt(settings && settings.timingOffsetMs, 10);
  if (!off || isNaN(off)) return lines;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    l.startTimeMs = Math.max(0, l.startTimeMs + off);
    if (l.endTimeMs > 0) l.endTimeMs = Math.max(0, l.endTimeMs + off);
    l.words = String(l.words).replace(/<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g, function (m, a, b, c) {
      var t = parseInt(a, 10) * 60000 + parseInt(b, 10) * 1000 + (c ? parseInt((c + "00").slice(0, 3), 10) : 0);
      return tag(t + off);
    });
  }
  return lines;
}
// ---------------------------------------------------------------------------

function syllableSegs(group) {
  var segs = [];
  var syl = (group && group.Syllables) || [];
  for (var i = 0; i < syl.length; i++) {
    var raw = String(syl[i].Text === undefined || syl[i].Text === null ? "" : syl[i].Text).replace(/[\r\n]+/g, " ");
    var wordEnd = !syl[i].IsPartOfWord && i < syl.length - 1;
    if (raw.replace(/\s+/g, "") === "") {
      if (segs.length) segs[segs.length - 1].text += " ";
      continue;
    }
    segs.push({
      start: ms(syl[i].StartTime),
      end: ms(syl[i].EndTime),
      text: raw + (wordEnd && !/\s$/.test(raw) ? " " : "")
    });
  }
  return segs;
}

function attribution(body) {
  var label = "Spicy Lyrics";
  var src = body.source;
  if (src === "spicy_lyrics") {
    var ua = body.UploadAttribution || {};
    var credits = [];
    if (ua.Uploader && ua.Uploader.username) credits.push("uploaded by " + ua.Uploader.username);
    if (ua.Maker && ua.Maker.username) credits.push("made by " + ua.Maker.username);
    if (credits.length) label += " (" + credits.join(", ") + ")";
  } else if (src === "apple_music") {
    label += " (Apple Music)";
  } else if (src === "spotify") {
    label += " (Spotify)";
  }
  return label;
}

function doFetchLyrics(trackName, artistName, albumName, durationSec) {
  if (!settings.spicyKey || !trackName || !artistName) return null;

  var id = null;
  try {
    var found = resolveSpotifyId(trackName, artistName, durationSec);
    if (found.error) log.warn("Spicy Lyrics: " + found.error);
    id = found.id;
  } catch (err) {
    log.error("Spotify lookup failed: " + String(err));
  }
  if (!id) return null;

  var resp = http.get("https://api.spicylyrics.org/v1/lyrics/" + id, {
    "Authorization": "Bearer " + settings.spicyKey
  });
  record("spicy HTTP " + resp.statusCode);
  if (!resp.ok) {
    if (resp.statusCode !== 404) log.error("Spicy Lyrics API returned HTTP " + resp.statusCode + " " + String(resp.body).slice(0, 200));
    if (resp.statusCode !== 404) record(String(resp.body).slice(0, 120));
    return null;
  }

  var body;
  try { body = JSON.parse(resp.body).Body; } catch (e) { record("bad JSON from spicy"); return null; }
  if (!body) { record("empty body"); return null; }
  record("Type=" + body.Type + " source=" + body.source + " rows=" + ((body.Content || body.Lines || []).length));

  var provider = attribution(body);
  var lines = [];
  var wordLines = 0;
  var i;

  if (body.Type === "Syllable" || body.Type === "Line") {
    var content = body.Content || [];
    // Duets: lines flagged OppositeAligned are the second singer -> "v2:" (right side in the app).
    var anyOpposite = false;
    for (var oi = 0; oi < content.length; oi++) if (content[oi] && content[oi].OppositeAligned) anyOpposite = true;
    var useVoices = anyOpposite && settings.voiceAlignment !== false;
    for (i = 0; i < content.length; i++) {
      var c = content[i];
      if (c.Type && c.Type !== "Vocal") continue;
      var text;
      var start;
      var end;
      if (body.Type === "Syllable") {
        // Word-level timing goes into the line text as <mm:ss.xxx> tags.
        var bgs = c.Background || [];
        try {
          var bgSegs = [];
          for (var b = 0; b < bgs.length; b++) bgSegs.push(syllableSegs(bgs[b]));
          text = buildWordLine(syllableSegs(c.Lead), bgSegs);
          if (text) wordLines++;
        } catch (werr) {
          // Never lose the lyrics over word timing: fall back to plain line text.
          record("word-sync failed: " + String(werr));
          text = joinSyllables(c.Lead);
        }
        start = c.Lead ? c.Lead.StartTime : 0;
        end = c.Lead ? c.Lead.EndTime : 0;
        if (!c.Lead && bgs.length && bgs[0]) {
          start = bgs[0].StartTime;
          end = bgs[0].EndTime;
        }
      } else {
        text = c.Text;
        start = c.StartTime;
        end = c.EndTime;
      }
      if (!text || !text.trim()) continue;
      var voice = useVoices ? (c.OppositeAligned ? "v2:" : "v1:") : "";
      lines.push({ startTimeMs: ms(start), words: voice + text.trim(), endTimeMs: ms(end) });
    }
    record("word-synced lines=" + wordLines + "/" + lines.length);
    // Timing diagnostics: overlapping lines / very long words can make the app's lyric view lag.
    var ovl = 0, maxOvl = 0, longest = 0, order = 0, gaps = 0;
    for (var d = 0; d < lines.length; d++) {
      if (d + 1 < lines.length) {
        var o = lines[d].endTimeMs - lines[d + 1].startTimeMs;
        if (o > 0) { ovl++; if (o > maxOvl) maxOvl = o; }
        if (lines[d + 1].startTimeMs < lines[d].startTimeMs) order++;
      }
      var wr = /<(\d+):(\d+)\.(\d+)>[^<]+<(\d+):(\d+)\.(\d+)>/g, wm;
      while ((wm = wr.exec(lines[d].words.split("\n")[0])) !== null) {
        var w = (parseInt(wm[4], 10) * 60000 + parseInt(wm[5], 10) * 1000 + parseInt(wm[6], 10)) - (parseInt(wm[1], 10) * 60000 + parseInt(wm[2], 10) * 1000 + parseInt(wm[3], 10));
        if (w > longest) longest = w;
      }
    }
    record("timing: overlapLines=" + ovl + " maxOverlapMs=" + maxOvl + " outOfOrder=" + order + " longestWordMs=" + longest);
    if (lines.length) record("first=" + JSON.stringify(lines[0]) + (lines[1] ? " second=" + JSON.stringify(lines[1]) : ""));
    if (lines.length) {
      applyOffset(lines);
      var plain = plainOf(lines);
      return {
        lines: lines,
        syncType: "LINE_SYNCED",
        instrumental: false,
        plainLyrics: plain,
        provider: provider
      };
    }
    return null;
  }

  if (body.Type === "Static" && settings.allowPlainFallback !== false) {
    var rows = [];
    var src = body.Lines || [];
    for (i = 0; i < src.length; i++) rows.push(src[i].Text);
    if (rows.length) {
      return {
        lines: [],
        syncType: "UNSYNCED",
        instrumental: false,
        plainLyrics: rows.join("\n"),
        provider: provider
      };
    }
  }
  return null;
}

function fetchLyrics(trackName, artistName, albumName, durationSec) {
  trace = [];
  record("ask: " + trackName + " / " + artistName + " / " + Math.round(durationSec || 0) + "s");
  var result = null;
  try {
    result = doFetchLyrics(trackName, artistName, albumName, durationSec);
  } catch (err) {
    record("exception: " + String(err));
  }
  record(result ? "returned " + result.syncType : "returned nothing");
  saveTrace();
  return result;
}

registerExtension({
  initialize: initialize,
  cleanup: cleanup,
  fetchLyrics: fetchLyrics,
  resetToken: resetToken,
  lastLookup: lastLookup,
  testConnection: testConnection
});

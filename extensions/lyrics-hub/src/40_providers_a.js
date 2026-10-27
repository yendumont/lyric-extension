// ---- Providers ------------------------------------------------------------------------------------
// Each provider takes t = { name, artist, album, durationMs, durationSec } and returns null (nothing)
// or { lines: [{ startTimeMs, words, endTimeMs }], plain: "text", credit: "who it came from" }.
// It may throw: the caller records the error and moves on to the next provider.

function linesResult(lines, credit) {
  if (!lines || !lines.length) return null;
  var any = false;
  for (var i = 0; i < lines.length; i++) if (hasLyricsText(lines[i].words)) { any = true; break; }
  return any ? { lines: lines, plain: "", credit: credit || "" } : null;
}

function plainResult(text, credit) {
  var t = String(text || "").replace(/\r/g, "").trim();
  return t && hasLyricsText(t) ? { lines: [], plain: t, credit: credit || "" } : null;
}

// LRC text (maybe with word tags) -> a result; plain text if it carries no timing.
function lrcResult(text, credit) {
  var lines = parseLRC(text);
  var timed = linesResult(lines, credit);
  if (timed) return timed;
  var rows = String(text).split(/\r?\n/);
  var keep = [];
  for (var i = 0; i < rows.length; i++) {
    if (/^\s*\[[a-z]+:[^\]]*\]\s*$/i.test(rows[i]) || /^\s*\{/.test(rows[i])) continue;
    if (isCreditLine(rows[i])) continue;
    keep.push(rows[i]);
  }
  return plainResult(keep.join("\n"), credit);
}

// ---- Spicy Lyrics (needs the Spotify track ID and your key) --------------------------------------
function spicyAttribution(body) {
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
    segs.push({ start: ms(syl[i].StartTime), end: ms(syl[i].EndTime), text: raw + (wordEnd && !/\s$/.test(raw) ? " " : "") });
  }
  return segs;
}

// Spicy/Viewer-shaped lyrics ({ Type: "Syllable" | "Line" | "Static", Content | Lines }) -> a result.
function spicyShapeResult(body, credit) {
  var lines = [];
  var i;
  if (body.Type === "Syllable" || body.Type === "Line") {
    var content = body.Content || [];
    var anyOpposite = false;
    for (var oi = 0; oi < content.length; oi++) if (content[oi] && content[oi].OppositeAligned) anyOpposite = true;
    var useVoices = anyOpposite && on("voiceAlignment", true);
    for (i = 0; i < content.length; i++) {
      var c = content[i];
      if (c.Type && c.Type !== "Vocal") continue;
      var text, start, end;
      if (body.Type === "Syllable") {
        var bgs = c.Background || [];
        try {
          var bgSegs = [];
          for (var b = 0; b < bgs.length; b++) bgSegs.push(syllableSegs(bgs[b]));
          text = buildWordLine(syllableSegs(c.Lead), bgSegs);
        } catch (werr) {
          record("word-sync failed: " + String(werr));
          text = "";
        }
        start = c.Lead ? c.Lead.StartTime : 0;
        end = c.Lead ? c.Lead.EndTime : 0;
        if (!c.Lead && bgs.length && bgs[0]) { start = bgs[0].StartTime; end = bgs[0].EndTime; }
      } else {
        text = c.Text;
        start = c.StartTime;
        end = c.EndTime;
      }
      if (!text || !String(text).trim()) continue;
      var voice = useVoices ? (c.OppositeAligned ? "v2:" : "v1:") : "";
      lines.push({ startTimeMs: ms(start), words: voice + String(text).trim(), endTimeMs: ms(end) });
    }
    return linesResult(lines, credit);
  }
  if (body.Type === "Static") {
    var rows = [];
    var src = body.Lines || [];
    for (i = 0; i < src.length; i++) rows.push(src[i].Text);
    return plainResult(rows.join("\n"), credit);
  }
  return null;
}

function fetchSpicy(t) {
  if (!str("spicyKey")) return null;
  var id = spotifyIdOf(t);
  if (!id) return null;
  var resp = get("https://api.spicylyrics.org/v1/lyrics/" + id, { "Authorization": "Bearer " + str("spicyKey") });
  record("spicy HTTP " + resp.statusCode);
  if (!resp.ok) {
    if (resp.statusCode !== 404) throw new Error("Spicy Lyrics answered " + resp.statusCode + " " + String(resp.body).slice(0, 120));
    return null;
  }
  var body;
  try { body = JSON.parse(resp.body).Body; } catch (e) { throw new Error("Spicy Lyrics sent invalid JSON"); }
  if (!body) return null;
  var res = spicyShapeResult(body, spicyAttribution(body));
  if (res && !res.lines.length && !on("allowPlainFallback", true)) return null;
  return res;
}

// ---- LRCLIB -------------------------------------------------------------------------------------
function fetchLrcLib(t) {
  var base = "https://lrclib.net/api";
  var hdr = { "Lrclib-Client": "MornyeLyricsHub", "Accept": "application/json" };
  var dur = Math.round(t.durationSec);
  var record_ = null;
  try {
    record_ = getJson(base + "/get?" + qs({ track_name: t.name, artist_name: t.artist, album_name: t.album, duration: dur || "" }), hdr);
  } catch (e) {
    record("lrclib /get failed, trying /search: " + String(e).slice(0, 80));
  }
  if (!record_) {
    var results = getJson(base + "/search?" + qs({ track_name: t.name, artist_name: t.artist }), hdr);
    if (!results || !results.length) return null;
    var usable = [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (!dur || typeof r.duration !== "number" || Math.abs(r.duration - dur) <= 5) usable.push(r);
    }
    usable.sort(function (a, b) {
      var s = (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0);
      if (s) return s;
      return Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur);
    });
    record_ = usable[0] || null;
  }
  if (!record_ || record_.instrumental) return null;
  if (record_.syncedLyrics) {
    var synced = linesResult(parseLRC(record_.syncedLyrics), "LRCLIB");
    if (synced) return synced;
  }
  return plainResult(record_.plainLyrics, "LRCLIB");
}

// ---- Unison (lyrics: ODbL, attribution required) -------------------------------------------------
function fetchUnison(t) {
  var q = "song=" + encodeURIComponent(t.name) + "&artist=" + encodeURIComponent(t.artist);
  if (t.album) q += "&album=" + encodeURIComponent(t.album);
  if (t.durationSec > 0) q += "&duration=" + Math.round(t.durationSec);
  var payload = getJson("https://unison.boidu.dev/lyrics?" + q);
  var data = payload && (payload.data || payload);
  if (!data || typeof data.lyrics !== "string" || !data.lyrics.trim() || data.hidden) return null;
  var credit = "Unison";
  if (data.submitter && data.submitter.displayName) credit += " (submitted by " + data.submitter.displayName + ")";
  var format = String(data.format || "").toLowerCase();
  var raw = data.lyrics;
  if (format === "ttml" || /^\s*<(\?xml|tt\b)/.test(raw)) format = "ttml";
  else if (format !== "plain" && /\[\d{1,3}:\d{2}/.test(raw)) format = "lrc";
  if (format === "ttml") return linesResult(parseTTML(raw), credit);
  if (format === "lrc") return lrcResult(raw, credit);
  return plainResult(raw, credit);
}

// ---- lrc.red and BiniLyrics ------------------------------------------------------------------------
var LRCRED = "https://lrc.red";

function lrcRedSearch(query) {
  var body = getJson(LRCRED + "/search.json?q=" + encodeURIComponent(query));
  return body && body.hits ? body.hits : [];
}

function lrcRedMatches(t) {
  var title = cleanTitle(t.name) || t.name;
  var queries = [title + " " + t.artist, title];
  for (var q = 0; q < queries.length; q++) {
    if (q > 0 && queries[q] === queries[0]) continue;
    var hits = lrcRedSearch(queries[q]);
    var cands = [];
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (!h.isrc) continue;
      var whole = String(h.artist || "").trim();
      var names = [whole];
      var split = whole.split(/,\s*|\s+&\s+/);
      for (var s = 0; s < split.length; s++) if (split[s] && names.indexOf(split[s]) === -1) names.push(split[s]);
      cands.push({ isrc: h.isrc, title: h.title || "", artists: names, durationMs: (h.duration || 0) * 1000 });
    }
    var ranked = rankCandidates(t, cands, { exactTitle: true, closeDurationMs: 500 });
    if (ranked.length) return ranked.slice(0, 3);
  }
  return [];
}

// "hand" keeps word timing only for songs a person timed; "all" keeps it always; "off" never.
function lrcRedWordMode() {
  var v = str("lrcRedWordSync", "hand");
  return v === "all" || v === "off" ? v : "hand";
}

function lrcRedModelTimed(isrc) {
  try {
    var song = getJson(LRCRED + "/s/" + encodeURIComponent(isrc) + ".song.json");
    return song ? song.byModel === true : null;
  } catch (e) {
    return null;
  }
}

function lrcRedLyrics(isrc, t, credit) {
  var ttml = getText(LRCRED + "/s/" + encodeURIComponent(isrc) + ".ttml");
  if (ttml) {
    var lines = parseTTML(ttml);
    if (lines.length) {
      var mode = lrcRedWordMode();
      if (hasWordTags(lines) && mode !== "all") {
        var keep = mode === "hand" && lrcRedModelTimed(isrc) === false;
        if (!keep) lines = toLineSynced(lines);
      }
      var res = linesResult(lines, credit);
      if (res) return res;
    }
  }
  var lrc = getText(LRCRED + "/s/" + encodeURIComponent(isrc) + ".lrc");
  return lrc ? lrcResult(lrc, credit) : null;
}

function fetchLrcRed(t) {
  var matches = lrcRedMatches(t);
  for (var i = 0; i < matches.length; i++) {
    var res = lrcRedLyrics(matches[i].isrc, t, "lrc.red");
    if (res) return res;
  }
  return null;
}

function fetchBini(t) {
  var q = { track: cleanTitle(t.name) || t.name, artist: t.artist };
  if (t.durationSec > 0) q.duration = Math.round(t.durationSec);
  if (t.album) q.album = t.album;
  var body = getJson("https://lyrics-api.binimum.org/?" + qs(q));
  var results = body && body.results ? body.results : [];
  var cands = [];
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!r.lyricsUrl || r.timing_type === "none") continue;
    cands.push({ r: r, title: r.track_name || "", artists: [r.artist_name || ""], durationMs: (r.duration || 0) * 1000 });
  }
  var ranked = rankCandidates(t, cands, { exactTitle: true, closeDurationMs: 500 }).slice(0, 3);
  for (var k = 0; k < ranked.length; k++) {
    var hit = ranked[k].r;
    try {
      var res;
      if (hostOf(hit.lyricsUrl) === "lrc.red" && hit.isrc) res = lrcRedLyrics(hit.isrc, t, "BiniLyrics");
      else {
        var text = getText(hit.lyricsUrl);
        res = text ? linesResult(parseTTML(text), "BiniLyrics") : null;
      }
      if (res) return res;
    } catch (e) {
      record("binilyrics candidate failed: " + String(e).slice(0, 80));
    }
  }
  return null;
}

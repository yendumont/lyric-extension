// Lyrics Hub for Mornye: one lyrics provider that asks many sources (the same ones the Lyric Viewer uses),
// keeps the best-synced answer, and can add a translation. Works on mobile and desktop; the parts that
// need the desktop app (the Spotify-app helper) are optional and skipped when it is not there.
// Attribution: Spicy Lyrics (mandatory, shown in the provider string), Unison (ODbL), LRCLIB, lrc.red, etc.

var settings = {};
var T0 = 0;
var trace = [];

function initialize(config) {
  settings = config || {};
  return true;
}

function cleanup() {}

function record(msg) { trace.push(String(msg)); }
function elapsed() { return Date.now() - T0; }

function saveTrace() {
  try { storage.set("lastTrace", new Date().toISOString() + "\n" + trace.join("\n")); } catch (e) {}
}

// Settings arrive as booleans, strings or nothing. "on" is true unless it was switched off.
function on(key, dflt) {
  var v = settings[key];
  if (v === undefined || v === null || v === "") return dflt;
  if (v === false || v === "false" || v === "0" || v === 0) return false;
  return true;
}
function str(key, dflt) {
  var v = settings[key];
  return v === undefined || v === null ? (dflt || "") : String(v).trim();
}
function num(key, dflt) {
  var n = parseInt(settings[key], 10);
  return isNaN(n) ? dflt : n;
}

// ---- Text helpers -----------------------------------------------------------------------------
function nfkc(s) {
  s = String(s === undefined || s === null ? "" : s);
  try { return s.normalize ? s.normalize("NFKC") : s; } catch (e) { return s; }
}

var NON_WORD = null;
var BRACKETS = null;
try {
  NON_WORD = new RegExp("[^\\p{L}\\p{N}]+", "gu");
  BRACKETS = new RegExp("[(\\[（【][^)\\]）】]*[)\\]）】]", "g");
} catch (e) {
  NON_WORD = /[^a-z0-9À-￿]+/gi;
  BRACKETS = /[(\[][^)\]]*[)\]]/g;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&amp;/g, "&");
}

// "1:02.345", "62.345", "00:01:02.345", "62.5s" -> milliseconds
function parseClock(value) {
  if (value === undefined || value === null) return 0;
  var s = String(value).trim().replace(/s$/, "");
  var parts = s.split(":");
  var secs = 0;
  for (var i = 0; i < parts.length; i++) secs = secs * 60 + parseFloat(parts[i].replace(",", "."));
  return isNaN(secs) ? 0 : Math.round(secs * 1000);
}

function ms(sec) { return Math.round((sec || 0) * 1000); }

// ---- Word-sync text (what Mornye reads) -------------------------------------------------------
//   [ts]v2:<mm:ss.xxx>word <mm:ss.xxx>word<mm:ss.xxx>      start tag, text, end tag
//   \n[bg:<...>backing words<...>]                         background vocal of that line
//   \n[x-translation:<startMs>:<base64>]                   a translation of that line
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

// Lead segments + optional background groups -> one line string, or "".
function buildWordLine(lead, bgGroups) {
  lead = cleanSegs(lead);
  var bgs = [];
  for (var i = 0; i < (bgGroups || []).length; i++) {
    var g = cleanSegs(bgGroups[i]);
    if (g.length) bgs.push(g);
  }
  if (!lead.length && bgs.length) lead = bgs.shift();
  if (!lead.length) return "";
  var words = serializeSegs(lead);
  if (on("backgroundVocals", true)) {
    for (var j = 0; j < bgs.length; j++) words += "\n[bg:" + serializeSegs(bgs[j]) + "]";
  }
  return words;
}

// Line text with every timing tag, voice label and extra row removed; background rows become "(...)".
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

function hasWordTags(lines) {
  for (var i = 0; i < lines.length; i++) if (/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/.test(String(lines[i].words).split("\n")[0])) return true;
  return false;
}

// How synced a result is: 3 word, 2 line, 1 plain text only.
function rankOf(res) {
  if (!res) return 0;
  if (!res.lines || !res.lines.length) return res.plain ? 1 : 0;
  return hasWordTags(res.lines) ? 3 : 2;
}

// Word timing removed, singers and (optionally) backing words kept as plain text.
function toLineSynced(lines) {
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var voice = /^\s*(?:<[^>]*>\s*)*(v[1-9]\d*):/i.exec(String(l.words).split("\n")[0]);
    var text = plainFromWords(l.words);
    if (!text) continue;
    out.push({ startTimeMs: l.startTimeMs, words: (voice ? voice[1].toLowerCase() + ":" : "") + text, endTimeMs: l.endTimeMs });
  }
  return out;
}

function fillEndTimes(lines, durationSec) {
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].endTimeMs && lines[i].endTimeMs > lines[i].startTimeMs) continue;
    var next = -1;
    for (var j = i + 1; j < lines.length; j++) if (lines[j].startTimeMs > lines[i].startTimeMs) { next = lines[j].startTimeMs; break; }
    if (next >= 0) lines[i].endTimeMs = next;
    else lines[i].endTimeMs = durationSec > 0 ? Math.max(Math.round(durationSec * 1000), lines[i].startTimeMs + 1000) : lines[i].startTimeMs + 5000;
  }
  return lines;
}

// Shifts every line and word time by the user's "Timing offset" (ms, negative = earlier).
function shiftLines(lines, off) {
  if (!off) return lines;
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

// ---- Network helpers --------------------------------------------------------------------------
// http.get never throws for HTTP errors; it returns { ok, statusCode, body }. A network error gives { error }.
var BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// One request. A plain program with no User-Agent is turned away by several of these sites, so send a browser-like
// one unless the caller chose its own. A network error or a 5xx/429 answer is tried once more before giving up.
function get(url, headers) {
  var h = {};
  var given = headers || {};
  var hasUa = false;
  for (var k in given) { h[k] = given[k]; if (k.toLowerCase() === "user-agent") hasUa = true; }
  if (!hasUa) h["User-Agent"] = BROWSER_UA;
  var r = null, lastErr = "";
  for (var attempt = 0; attempt < 2; attempt++) {
    try { r = http.get(url, h); } catch (e) { r = null; lastErr = hostOf(url) + " request failed: " + String(e).slice(0, 100); }
    if (r && r.error) { lastErr = hostOf(url) + ": " + String(r.error).slice(0, 100); r = null; }
    if (r && (r.statusCode >= 500 || r.statusCode === 429) && attempt === 0) continue;
    if (r) return r;
  }
  throw new Error(lastErr || hostOf(url) + " did not answer");
}

function hostOf(url) {
  var m = /^https?:\/\/([^\/?#:]+)/i.exec(url);
  return m ? m[1] : url;
}

// JSON from a URL: null for 404, an error for anything else that is not 2xx.
function getJson(url, headers) {
  var r = get(url, headers || { "Accept": "application/json" });
  if (r.statusCode === 404) return null;
  if (!r.ok) throw new Error(hostOf(url) + " answered " + r.statusCode);
  try { return JSON.parse(r.body); } catch (e) { throw new Error(hostOf(url) + " sent invalid JSON"); }
}

// Text from a URL: null for 404.
function getText(url, headers) {
  var r = get(url, headers || {});
  if (r.statusCode === 404) return null;
  if (!r.ok) throw new Error(hostOf(url) + " answered " + r.statusCode);
  return String(r.body);
}

function qs(params) {
  var out = [];
  for (var k in params) {
    if (params[k] === undefined || params[k] === null || params[k] === "") continue;
    out.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])));
  }
  return out.join("&");
}

// ---- Credit lines (written by / composed by ...) -----------------------------------------------
var CREDIT_RE = /^(作词|作曲|编曲|制作人?|监制|混音|母带|词|曲|lyrics?|composer|composed|arranger|arranged|producer|produced|written)(\s*by)?\s*[:：]/i;
function isCreditLine(text) { return CREDIT_RE.test(String(text).trim()); }

// Text with something to sing in it (not only music notes, dashes or dots).
function hasLyricsText(text) {
  return stripTags(text).replace(/[\s\u2000-\u206f.,!?\u2026\u266a\u266b*_\-\u2013\u2014()\[\]]+/g, "") !== "";
}
// ---- Matching search results to the playing track (from the Lyric Viewer's Match.ts) ------------
// Search-based providers return several versions of a song. Lyrics timed for another edit are worse
// than none, so a result has to agree on title, artist or duration, and on length within seconds.
var MAX_DURATION_DIFF_MS = 4000;
var CLOSE_DURATION_DIFF_MS = 1500;

function normalizeName(value) {
  var s = nfkc(value).toLowerCase().replace(BRACKETS, " ");
  s = s.split(/\s[-–—]\s/)[0];
  return s.replace(NON_WORD, "");
}

function namesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return (a.length >= 3 && b.indexOf(a) !== -1) || (b.length >= 3 && a.indexOf(b) !== -1);
}

var VERSION_TAG = /\b(?:remix(?:ed|es)?|live|instrumental|karaoke|acoustic|cover|demo)\b|\boff vocal\b|伴奏|纯音乐|现场/gi;

function versionTags(title) {
  var m = String(title).match(VERSION_TAG) || [];
  var out = [];
  for (var i = 0; i < m.length; i++) out.push(m[i].toLowerCase());
  return out;
}

// Versions whose lyrics are the same words: fine for unsynced text, where timing does not matter.
var SAME_LYRICS_TAG = { remix: 1, remixed: 1, remixes: 1, live: 1, acoustic: 1, demo: 1 };

function wrongVersion(candidateTitle, wanted, options) {
  var tags = versionTags(candidateTitle);
  for (var i = 0; i < tags.length; i++) {
    if (wanted.indexOf(tags[i]) !== -1) continue;
    if (options && options.relaxedVersions && SAME_LYRICS_TAG[tags[i]]) continue;
    return true;
  }
  return false;
}

// "feat." tails, hashtags and *decoration* uploaders add to titles.
function stripDecoration(value) {
  var stripped = String(value)
    .replace(/([*＊]).*?\1/g, " ")
    .replace(/#\S+/g, " ")
    .replace(/\s+(?:prod\.?|produced by|prod by)\s.*$/i, "")
    .replace(/\s+(?:feat|ft|featuring)\.?\s.*$/i, "");
  return stripped.trim() ? stripped : String(value).replace(/[#*＊]/g, "");
}

// Title without bracketed parts, a " - Remastered" tail, or decoration.
function cleanTitle(value) {
  var t = nfkc(value).replace(BRACKETS, " ").split(/\s[-–—]\s/)[0];
  return stripDecoration(t).replace(/\s+/g, " ").trim();
}

// Every name a title can be compared as ("Artist - Song" is "Song" too).
function titleForms(raw) {
  var unbracketed = nfkc(raw).replace(BRACKETS, " ");
  var parts = unbracketed.split(/\s[-–—]\s/);
  var forms = [];
  for (var i = 0; i < parts.length; i++) {
    var f = normalizeName(cleanTitle(parts[i]));
    if (f && forms.indexOf(f) === -1) forms.push(f);
  }
  return forms;
}

var VERSION_SUFFIX = /remaster|version|edit|mix|live|demo|acoustic|radio|single|album|explicit|mono|stereo|deluxe|bonus|\d{4}/i;

// The cleaned parts of the PLAYING track's title that can stand for it.
function searchTitles(raw) {
  var unbracketed = nfkc(raw).replace(BRACKETS, " ");
  var all = unbracketed.split(/\s[-–—]\s/);
  var parts = [cleanTitle(all[0])];
  for (var i = 1; i < all.length; i++) {
    var c = cleanTitle(all[i]);
    if (!VERSION_SUFFIX.test(c)) parts.push(c);
  }
  var unique = [];
  for (var j = 0; j < parts.length; j++) if (parts[j] && unique.indexOf(parts[j]) === -1) unique.push(parts[j]);
  return unique.length ? unique : [String(raw).trim()];
}

function ownForms(track) {
  var forms = [];
  var t = searchTitles(track.name);
  for (var i = 0; i < t.length; i++) {
    var f = normalizeName(t[i]);
    if (f && forms.indexOf(f) === -1) forms.push(f);
  }
  return forms.length ? forms : [normalizeName(track.name)];
}

// candidates: [{ title, artists: [..], durationMs, ...anything }] -> the ones that plausibly are `track`, best first.
// options: { exactTitle, closeDurationMs }
function rankCandidates(track, candidates, options) {
  options = options || {};
  var ours = ownForms(track);
  var artist = normalizeName(track.artist);
  var wanted = versionTags(track.name);
  var scored = [];

  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    var known = c.durationMs > 0 && track.durationMs > 0;
    var diff = known ? Math.abs(c.durationMs - track.durationMs) : 0;
    if (diff > MAX_DURATION_DIFF_MS) continue;
    if (wrongVersion(c.title, wanted, options)) continue;

    var forms = titleForms(c.title);
    var exact = false;
    var titleOk = false;
    for (var o = 0; o < ours.length; o++) {
      if (forms.indexOf(ours[o]) !== -1) exact = true;
      if (options.exactTitle) {
        if (forms.indexOf(ours[o]) !== -1) titleOk = true;
      } else {
        for (var f = 0; f < forms.length; f++) if (namesMatch(ours[o], forms[f])) titleOk = true;
      }
    }
    if (!titleOk) continue;

    var artistOk = false;
    for (var a = 0; a < (c.artists || []).length; a++) if (namesMatch(artist, normalizeName(c.artists[a]))) artistOk = true;
    // Artists are often spelled differently (script, aliases); accept a near-exact length instead.
    if (!artistOk && !(known && diff <= (options.closeDurationMs || CLOSE_DURATION_DIFF_MS))) continue;

    scored.push({ candidate: c, score: (artistOk ? 10 : 0) + (exact ? 5 : 0) - diff / 1000, order: i });
  }
  scored.sort(function (x, y) { return y.score - x.score || x.order - y.order; });
  var out = [];
  for (var k = 0; k < scored.length; k++) out.push(scored[k].candidate);
  return out;
}
// ---- Looser matching, for Genius (plain text has no timing, so a near title is good enough) ------------------
function bigrams(value) {
  var out = {};
  for (var i = 0; i < value.length - 1; i++) {
    var pair = value.slice(i, i + 2);
    out[pair] = (out[pair] || 0) + 1;
  }
  return out;
}

// Bigram overlap alone: 1 identical, near 0 unrelated.
function dice(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  var left = bigrams(a), right = bigrams(b), shared = 0;
  for (var pair in left) shared += Math.min(left[pair], right[pair] || 0);
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

// 0 to 1 closeness of two normalised names, containment counting as close.
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  var short = a.length <= b.length ? a : b;
  var long_ = a.length <= b.length ? b : a;
  var containment = short.length >= 3 && long_.indexOf(short) !== -1 ? 0.85 : 0;
  return Math.max(containment, dice(a, b));
}

// Title closeness that does not let a longer title stand in for a shorter one.
function titleSimilarity(ours, theirs, theirArtists) {
  if (!ours || !theirs) return 0;
  if (ours === theirs) return 1;
  if (theirs.indexOf(ours) !== -1) {
    var rest = theirs.replace(ours, "");
    if (rest.length >= 3) for (var i = 0; i < theirArtists.length; i++) if (theirArtists[i].length >= 3 && theirArtists[i].indexOf(rest) !== -1) return 0.95;
    // Genius pages are often named with the whole first lyric line.
    if (ours.length >= 8 && theirs.indexOf(ours) === 0) return 0.9;
  }
  return dice(ours, theirs);
}

function bestTitleMatch(ours, theirs, theirArtists) {
  var best = { score: 0, form: ours[0] || "" };
  for (var i = 0; i < ours.length; i++) {
    for (var j = 0; j < theirs.length; j++) {
      var s = titleSimilarity(ours[i], theirs[j], theirArtists);
      if (s > best.score) best = { score: s, form: ours[i] };
    }
  }
  return best;
}

function artistsOfTrack(t) { return t.artists && t.artists.length ? t.artists : [t.artist]; }

function artistSimilarity(t, candidateArtists) {
  var ours = artistsOfTrack(t).map(normalizeName).filter(Boolean);
  var score = 0;
  for (var i = 0; i < candidateArtists.length; i++) {
    var theirs = normalizeName(candidateArtists[i]);
    for (var j = 0; j < ours.length; j++) score = Math.max(score, similarity(ours[j], theirs));
  }
  return score;
}

function isDistinctive(title) {
  var cjk = /[぀-ヿ㐀-鿿가-힯]/.test(title);
  return Array.from(title).length >= (cjk ? 5 : 12);
}

var EXACT_TITLE = 0.95;
var TRUSTED_ARTIST_TITLE = 0.9;
var LOOSE_MIN_TITLE = 0.85, LOOSE_MIN_ARTIST = 0.4, LOOSE_MIN_SCORE = 0.7;

// Every candidate whose title is close to the playing track's, whatever its artist, closest first.
function titleCandidates(t, candidates, options, minScore) {
  options = options || {};
  var wanted = versionTags(t.name);
  var ours = ownForms(t);
  var scored = [];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (wrongVersion(c.title, wanted, options)) continue;
    var score = bestTitleMatch(ours, titleForms(c.title), c.artists.map(normalizeName)).score;
    if (score >= (minScore === undefined ? LOOSE_MIN_TITLE : minScore)) scored.push({ c: c, score: score, order: i });
  }
  scored.sort(function (a, b) { return b.score - a.score || a.order - b.order; });
  return scored.map(function (x) { return x.c; });
}

// Best guesses when the strict match found nothing, best first: title closeness, artist closeness and popularity.
function rankLoose(t, candidates, options) {
  options = options || {};
  var wanted = versionTags(t.name);
  var ours = ownForms(t);
  var scored = [];
  var unrelated = [];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (wrongVersion(c.title, wanted, options)) continue;
    var match = bestTitleMatch(ours, titleForms(c.title), c.artists.map(normalizeName));
    if (match.score < LOOSE_MIN_TITLE) continue;
    var artistScore = artistSimilarity(t, c.artists);
    var fame = Math.min(1, Math.log(1 + Math.max(0, c.popularity || 0)) / Math.LN10 / 6);
    var artistOk = artistScore >= LOOSE_MIN_ARTIST;
    // A long, unusual title that the result matches whole is hardly a coincidence.
    if (!artistOk && !isDistinctive(match.form)) continue;
    var score = 0.7 * match.score + 0.3 * artistScore + 0.05 * fame;
    if (artistOk) { if (score >= LOOSE_MIN_SCORE) scored.push({ c: c, score: score }); }
    else unrelated.push({ c: c, score: score });
  }
  if (unrelated.length === 1) scored.push(unrelated[0]);
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.map(function (x) { return x.c; });
}

// Whether two titles are written exactly alike (same case, same punctuation).
function writtenAlike(a, b) {
  var tidy = function (s) { return nfkc(s).replace(/[​-‏‪-‮⁠﻿]/g, "").replace(/\s+/g, " ").trim(); };
  var left = tidy(a);
  return left !== "" && left === tidy(b);
}

// The last resort: the best-looking candidate when nothing was proven. Obscure beats famous.
function rankEager(t, candidates, options) {
  options = options || {};
  var wanted = versionTags(t.name);
  var ours = ownForms(t);
  var written = [t.name].concat(searchTitles(t.name));
  var scored = [];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (wrongVersion(c.title, wanted, options)) continue;
    if ((c.popularity || 0) > 1000000) continue;
    var match = bestTitleMatch(ours, titleForms(c.title), c.artists.map(normalizeName));
    if (match.score < 0.78) continue;
    var artist = artistSimilarity(t, c.artists);
    var same = 0;
    for (var w = 0; w < written.length; w++) if (writtenAlike(written[w], c.title)) same = 1;
    var obscurity = 1 - Math.min(1, Math.log(1 + Math.max(0, c.popularity || 0)) / Math.LN10 / 6);
    var score = 0.45 * match.score + 0.15 * same + 0.2 * artist + 0.1 * obscurity;
    if (score >= 0.5) scored.push({ c: c, score: score });
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.map(function (x) { return x.c; });
}
// ---- LRC and TTML -> Mornye lines ----------------------------------------------------------------
function parseLRC(text) {
  var out = [];
  var rows = String(text).split(/\r?\n/);
  var lead = /^\s*((?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s*)+)/;
  var one = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];

    // "[bg:...]" row = background vocal of the previous line.
    if (/^\s*\[bg:/i.test(row)) {
      if (out.length && on("backgroundVocals", true)) out[out.length - 1].words += "\n" + row.trim().replace(/\[(\d{1,3}:\d{2}(?:[.:]\d{1,3})?)\]/g, "<$1>");
      continue;
    }

    var head = lead.exec(row);
    if (!head) continue;
    var stamps = [];
    var m;
    one.lastIndex = 0;
    while ((m = one.exec(head[1])) !== null) {
      var frac = m[3] ? parseFloat("0." + m[3]) : 0;
      stamps.push(Math.round((parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac) * 1000));
    }
    // Keep word-level tags (enhanced LRC); some files write them as [mm:ss.xx].
    var rest = row.slice(head[0].length).replace(/\[(\d{1,3}:\d{2}(?:[.:]\d{1,3})?)\]/g, "<$1>").trim();
    var words = stripTags(rest).trim() ? rest : "";
    if (words && isCreditLine(stripTags(words))) continue;
    for (var j = 0; j < stamps.length; j++) {
      out.push({ startTimeMs: stamps[j], words: words, endTimeMs: 0 });
    }
  }
  out.sort(function (a, b) { return a.startTimeMs - b.startTimeMs; });
  return out;
}

function addSpace(segs) {
  if (segs.length && !/\s$/.test(segs[segs.length - 1].text)) segs[segs.length - 1].text += " ";
}

// Word/syllable TTML -> one line per <p>, with inline word-timing tags.
// Lines whose TTML has no per-word timing stay plain line text.
function parseTTML(text) {
  var out = [];
  var pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  var m;
  // Duets: with two or more agents (singers), prefix lines with v1:/v2: so the app can alternate sides.
  var agents = [];
  var scan = /<p\b[^>]*ttm:agent="([^"]+)"/g;
  var sm;
  while ((sm = scan.exec(text)) !== null) if (agents.indexOf(sm[1]) === -1) agents.push(sm[1]);
  var useVoices = agents.length > 1 && on("voiceAlignment", true);
  while ((m = pRe.exec(text)) !== null) {
    var b = /\bbegin="([^"]+)"/.exec(m[1]);
    var e = /\bend="([^"]+)"/.exec(m[1]);
    if (!b) continue;

    var lead = [];
    var bgGroups = [];
    var bgCur = null;
    var stack = [];
    var untimed = "";
    var tokRe = /<span\b([^>]*?)(\/?)>|<\/span>|<br\s*\/?>|<[^>]+>|([^<]+)/g;
    var t;
    while ((t = tokRe.exec(m[2])) !== null) {
      var tok = t[0];
      if (/^<span\b/.test(tok)) {
        if (t[2] === "/") continue;
        var attrs = t[1];
        var sb = /\bbegin="([^"]+)"/.exec(attrs);
        var se = /\bend="([^"]+)"/.exec(attrs);
        var isBg = /ttm:role="x-bg"/.test(attrs);
        var entry = { begin: sb ? parseClock(sb[1]) : null, end: se ? parseClock(se[1]) : 0, startedBg: false };
        if (isBg && !bgCur) {
          bgCur = [];
          bgGroups.push(bgCur);
          entry.startedBg = true;
        }
        stack.push(entry);
      } else if (tok === "</span>") {
        var popped = stack.pop();
        if (popped && popped.startedBg) bgCur = null;
      } else if (/^<br/.test(tok)) {
        addSpace(bgCur || lead);
        untimed += " ";
      } else if (t[3] !== undefined) {
        var txt = decodeEntities(t[3]).replace(/\s+/g, " ");
        var target = bgCur || lead;
        if (txt.charAt(0) === " ") { addSpace(target); untimed += " "; txt = txt.slice(1); }
        if (!txt) continue;
        untimed += txt;
        var timed = null;
        for (var k = stack.length - 1; k >= 0; k--) {
          if (stack[k].begin !== null) { timed = stack[k]; break; }
        }
        if (timed) target.push({ start: timed.begin, end: timed.end, text: txt });
      }
    }

    // Drop the parentheses some files wrap around background vocals.
    for (var g = 0; g < bgGroups.length; g++) {
      if (bgGroups[g].length) {
        bgGroups[g][0].text = bgGroups[g][0].text.replace(/^\s*\(/, "");
        var lastSeg = bgGroups[g][bgGroups[g].length - 1];
        lastSeg.text = lastSeg.text.replace(/\)\s*$/, "");
      }
    }

    var words = buildWordLine(lead, bgGroups);
    if (!words) words = untimed.replace(/\s+/g, " ").trim();
    if (!words) continue;
    if (useVoices) {
      var ag = /ttm:agent="([^"]+)"/.exec(m[1]);
      var vm = ag && /^v([1-9]\d*)$/i.exec(ag[1]);
      var idx = ag ? agents.indexOf(ag[1]) : 0;
      words = (vm ? "v" + vm[1] : (idx % 2 === 0 ? "v1" : "v2")) + ":" + words;
    }
    out.push({ startTimeMs: parseClock(b[1]), words: words, endTimeMs: e ? parseClock(e[1]) : 0 });
  }
  out.sort(function (a, b) { return a.startTimeMs - b.startTimeMs; });
  return out;
}

// ---- Bytes: base64, UTF-8 and a small zlib reader (KuGou's KRC lyrics are zlib data) ------------
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64bytes(text) {
  var clean = String(text).replace(/[^A-Za-z0-9+\/]/g, "");
  var out = [];
  var buf = 0, bits = 0;
  for (var i = 0; i < clean.length; i++) {
    buf = (buf << 6) | B64.indexOf(clean.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
      buf &= (1 << bits) - 1;
    }
  }
  return out;
}

function bytesToB64(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64.charAt(a >> 2) + B64.charAt(((a & 3) << 4) | (b >> 4));
    out += i + 1 < bytes.length ? B64.charAt(((b & 15) << 2) | (c >> 6)) : "=";
    out += i + 2 < bytes.length ? B64.charAt(c & 63) : "=";
  }
  return out;
}

function utf8bytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function utf8string(bytes) {
  var out = "";
  var i = 0;
  while (i < bytes.length) {
    var b = bytes[i++];
    var cp;
    if (b < 0x80) cp = b;
    else if (b >= 0xc0 && b < 0xe0 && i < bytes.length) cp = ((b & 31) << 6) | (bytes[i++] & 63);
    else if (b >= 0xe0 && b < 0xf0 && i + 1 < bytes.length) { cp = ((b & 15) << 12) | ((bytes[i] & 63) << 6) | (bytes[i + 1] & 63); i += 2; }
    else if (b >= 0xf0 && i + 2 < bytes.length) { cp = ((b & 7) << 18) | ((bytes[i] & 63) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3; }
    else cp = 0xfffd;
    if (cp >= 0x10000) { cp -= 0x10000; out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); }
    else out += String.fromCharCode(cp);
  }
  return out.replace(/^﻿/, "");
}

// Inflate (RFC 1951) with the zlib wrapper skipped. Returns an array of bytes, or null on bad data.
function zlibInflate(bytes) {
  var pos = 2; // CMF + FLG
  var bitBuf = 0, bitCnt = 0;
  var out = [];

  function bit() {
    if (bitCnt === 0) {
      if (pos >= bytes.length) throw new Error("eof");
      bitBuf = bytes[pos++];
      bitCnt = 8;
    }
    var b = bitBuf & 1;
    bitBuf >>= 1;
    bitCnt--;
    return b;
  }
  function bits(n) {
    var v = 0;
    for (var i = 0; i < n; i++) v |= bit() << i;
    return v;
  }
  function build(lengths) {
    var count = [], offs = [], symbols = [];
    var i;
    for (i = 0; i <= 15; i++) count[i] = 0;
    for (i = 0; i < lengths.length; i++) count[lengths[i]]++;
    count[0] = 0;
    offs[1] = 0;
    for (i = 1; i < 15; i++) offs[i + 1] = offs[i] + count[i];
    for (i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
    return { count: count, symbols: symbols };
  }
  function decode(h) {
    var code = 0, first = 0, index = 0;
    for (var len = 1; len <= 15; len++) {
      code |= bit();
      var c = h.count[len];
      if (code - c < first) return h.symbols[index + (code - first)];
      index += c;
      first += c;
      first <<= 1;
      code <<= 1;
    }
    throw new Error("bad code");
  }

  var LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  var LEXT = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  var DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  var DEXT = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  var fixedL = null, fixedD = null;

  try {
    var last;
    do {
      last = bit();
      var type = bits(2);
      if (type === 0) {
        bitCnt = 0;
        var len = bytes[pos] | (bytes[pos + 1] << 8);
        pos += 4;
        for (var s = 0; s < len; s++) out.push(bytes[pos++]);
      } else if (type === 1 || type === 2) {
        var lit, dist;
        if (type === 1) {
          if (!fixedL) {
            var fl = [], k;
            for (k = 0; k < 144; k++) fl[k] = 8;
            for (; k < 256; k++) fl[k] = 9;
            for (; k < 280; k++) fl[k] = 7;
            for (; k < 288; k++) fl[k] = 8;
            var fd = [];
            for (k = 0; k < 30; k++) fd[k] = 5;
            fixedL = build(fl);
            fixedD = build(fd);
          }
          lit = fixedL;
          dist = fixedD;
        } else {
          var nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
          var order = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
          var lengths = [], x;
          for (x = 0; x < 19; x++) lengths[x] = 0;
          for (x = 0; x < ncode; x++) lengths[order[x]] = bits(3);
          var lencode = build(lengths);
          var all = [];
          while (all.length < nlen + ndist) {
            var sym = decode(lencode);
            if (sym < 16) all.push(sym);
            else {
              var prev = 0, rep;
              if (sym === 16) { prev = all[all.length - 1]; rep = 3 + bits(2); }
              else if (sym === 17) rep = 3 + bits(3);
              else rep = 11 + bits(7);
              while (rep--) all.push(prev);
            }
          }
          lit = build(all.slice(0, nlen));
          dist = build(all.slice(nlen));
        }
        for (;;) {
          var symbol = decode(lit);
          if (symbol < 256) out.push(symbol);
          else if (symbol === 256) break;
          else {
            symbol -= 257;
            var length = LBASE[symbol] + bits(LEXT[symbol]);
            var ds = decode(dist);
            var distance = DBASE[ds] + bits(DEXT[ds]);
            for (var n = 0; n < length; n++) out.push(out[out.length - distance]);
          }
        }
      } else {
        return null;
      }
    } while (!last);
  } catch (e) {
    return null;
  }
  return out;
}

// ---- NetEase word-timed lyrics (YRC) ---------------------------------------------------------
//   [lineStartMs,lineDurMs](wordStartMs,wordDurMs,0)word(wordStartMs,wordDurMs,0)word
function parseYrc(yrc) {
  var out = [];
  var rows = String(yrc).split(/\r?\n/);
  for (var r = 0; r < rows.length; r++) {
    var line = rows[r].trim();
    var head = /^\[(\d+),(\d+)\]/.exec(line);
    if (!head) continue;
    var body = line.slice(head[0].length);
    var re = /\((\d+),(\d+),-?\d+\)/g;
    var marks = [], m;
    while ((m = re.exec(body)) !== null) marks.push({ index: m.index, len: m[0].length, start: parseInt(m[1], 10), dur: parseInt(m[2], 10) });
    var segs = [];
    for (var i = 0; i < marks.length; i++) {
      var from = marks[i].index + marks[i].len;
      var to = i + 1 < marks.length ? marks[i + 1].index : body.length;
      var text = body.slice(from, to);
      if (text.replace(/\s+/g, "") === "") { if (segs.length) segs[segs.length - 1].text += " "; continue; }
      segs.push({ start: marks[i].start, end: marks[i].start + marks[i].dur, text: text });
    }
    if (!segs.length) continue;
    var joined = "";
    for (var j = 0; j < segs.length; j++) joined += segs[j].text;
    if (isCreditLine(joined)) continue;
    var words = buildWordLine(segs, []);
    if (!words) continue;
    out.push({ startTimeMs: segs[0].start, words: words, endTimeMs: segs[segs.length - 1].end });
  }
  return out;
}

// ---- KuGou word-timed lyrics (KRC), word times relative to the line ---------------------------
//   [lineStartMs,lineDurMs]<wordOffsetMs,wordDurMs,0>word<...>word
var KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];

function decodeKrc(base64) {
  var bytes = b64bytes(base64);
  if (bytes.length <= 4) return null;
  var body = [];
  for (var i = 4; i < bytes.length; i++) body.push(bytes[i] ^ KRC_KEY[(i - 4) % KRC_KEY.length]);
  var raw = zlibInflate(body);
  return raw ? utf8string(raw) : null;
}

function parseKrc(krc) {
  var out = [];
  var rows = String(krc).split(/\r?\n/);
  for (var r = 0; r < rows.length; r++) {
    var line = rows[r].trim();
    var head = /^\[(\d+),(\d+)\]/.exec(line);
    if (!head) continue;
    var lineStart = parseInt(head[1], 10);
    var body = line.slice(head[0].length);
    var re = /<(\d+),(\d+),-?\d+>/g;
    var marks = [], m;
    while ((m = re.exec(body)) !== null) marks.push({ index: m.index, len: m[0].length, start: lineStart + parseInt(m[1], 10), dur: parseInt(m[2], 10) });
    var segs = [];
    for (var i = 0; i < marks.length; i++) {
      var from = marks[i].index + marks[i].len;
      var to = i + 1 < marks.length ? marks[i + 1].index : body.length;
      var text = body.slice(from, to);
      if (text.replace(/\s+/g, "") === "") { if (segs.length) segs[segs.length - 1].text += " "; continue; }
      // A mark of punctuation with no time of its own belongs to the word before it.
      var prev = segs[segs.length - 1];
      if (prev && marks[i].dur === 0 && /^[^\w\sÀ-￿]+\s*$/.test(text) && !/\s$/.test(prev.text)) { prev.text += text; continue; }
      segs.push({ start: marks[i].start, end: marks[i].start + marks[i].dur, text: text });
    }
    if (!segs.length) continue;
    var joined = "";
    for (var j = 0; j < segs.length; j++) joined += segs[j].text;
    if (isCreditLine(joined)) continue;
    var words = buildWordLine(segs, []);
    if (!words) continue;
    out.push({ startTimeMs: segs[0].start, words: words, endTimeMs: segs[segs.length - 1].end });
  }
  return out;
}

// ---- Musixmatch richsync: lines { ts, te, l: [{ c, o }] } in seconds ----------------------------
function parseRichsync(body) {
  var out = [];
  for (var i = 0; i < body.length; i++) {
    var line = body[i];
    var pieces = line.l || [];
    var segs = [];
    for (var p = 0; p < pieces.length; p++) {
      var text = pieces[p].c === undefined || pieces[p].c === null ? "" : String(pieces[p].c);
      if (text.replace(/\s+/g, "") === "") { if (segs.length) segs[segs.length - 1].text += " "; continue; }
      segs.push({ start: ms(line.ts + (pieces[p].o || 0)), end: 0, text: text });
    }
    if (!segs.length) continue;
    for (var k = 0; k < segs.length; k++) segs[k].end = k + 1 < segs.length ? segs[k + 1].start : ms(line.te);
    var words = buildWordLine(segs, []);
    if (!words) continue;
    out.push({ startTimeMs: segs[0].start, words: words, endTimeMs: ms(line.te) });
  }
  return out;
}

// ---- LRCMux ---------------------------------------------------------------------------------
var MIN_WORD_MS = 80;

function muxTidy(text) {
  return String(text)
    .replace(/\s+([,.!?;:)\]}…])/g, "$1")
    .replace(/([(\[{¿¡])\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Word timings made safe to show: in order, none overlapping the next, none shorter than a flash.
function muxCleanTimings(words) {
  var sorted = [];
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (!w || String(w.text).trim() === "" || !isFinite(w.start) || !isFinite(w.end)) continue;
    sorted.push({ text: w.text, start: Math.max(0, w.start), end: w.end });
  }
  sorted.sort(function (a, b) { return a.start - b.start; });
  for (var j = 0; j < sorted.length; j++) {
    var next = sorted[j + 1];
    var end = Math.max(sorted[j].end, sorted[j].start);
    if (next && end > next.start) end = next.start;
    if (end - sorted[j].start < MIN_WORD_MS) end = next ? Math.max(end, Math.min(next.start, sorted[j].start + MIN_WORD_MS)) : sorted[j].start + MIN_WORD_MS;
    sorted[j].end = end;
  }
  return sorted;
}

// Brackets, quotes and commas sent as words of their own join the word they belong to.
function muxAttachPunctuation(words) {
  var OPENING = /^[(\[{“‘¿¡]+$/;
  var CLOSING = /^[)\]}”.,!?;:…]+$/;
  var STRAIGHT = /^"+$/;
  var out = [];
  var opener = null;
  var quotes = 0;
  for (var i = 0; i < words.length; i++) {
    var word = words[i];
    var bare = String(word.text).trim();
    var kind = null;
    if (OPENING.test(bare)) kind = "open";
    else if (CLOSING.test(bare)) kind = "close";
    else if (STRAIGHT.test(bare)) kind = (++quotes % 2 === 1) ? "open" : "close";
    if (kind === "open") {
      opener = { text: (opener ? opener.text : "") + bare, start: Math.min(opener ? opener.start : word.start, word.start) };
      continue;
    }
    var previous = out[out.length - 1];
    if (kind === "close" && previous) {
      previous.text = previous.text.replace(/\s+$/, "") + word.text;
      previous.end = Math.max(previous.end, word.end);
      continue;
    }
    if (opener) {
      out.push({ text: opener.text + String(word.text).replace(/^\s+/, ""), start: Math.min(opener.start, word.start), end: word.end });
      opener = null;
    } else {
      out.push({ text: word.text, start: word.start, end: word.end });
    }
  }
  if (opener) {
    var lastWord = out[out.length - 1];
    if (lastWord) lastWord.text = lastWord.text.replace(/\s+$/, "") + opener.text;
    else out.push({ text: opener.text, start: opener.start, end: opener.start + MIN_WORD_MS });
  }
  return out;
}

// LRCMux's { lines: [{ text, start, end, words: [{ text, start, end }] }] } (ms) at level "word".
function muxWordLines(lines) {
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!hasLyricsText(line.text) || isCreditLine(line.text)) continue;
    var words = muxAttachPunctuation(muxCleanTimings(line.words || []));
    var segs = [];
    if (words.length) {
      // Words normally carry their trailing space; a provider sending bare words would glue the line together.
      var carries = false;
      for (var c = 0; c < words.length; c++) if (/\s/.test(words[c].text)) carries = true;
      var bare = !carries && /\s/.test(String(line.text).trim());
      for (var w = 0; w < words.length; w++) {
        var text = muxTidy(words[w].text);
        if (!text) continue;
        var next = words[w + 1];
        var joinsNext = next && !bare && !/\s$/.test(words[w].text) && !/^\s/.test(next.text) && !/[,.!?;:…)\]}]$/.test(words[w].text.trim());
        segs.push({ start: words[w].start, end: words[w].end, text: text + (joinsNext || !next ? "" : " ") });
      }
    } else if (typeof line.start === "number" && typeof line.end === "number" && line.end > line.start) {
      segs.push({ start: line.start, end: line.end, text: muxTidy(line.text) });
    }
    if (!segs.length) continue;
    var wordsText = buildWordLine(segs, []);
    if (!wordsText) continue;
    out.push({ startTimeMs: segs[0].start, words: wordsText, endTimeMs: segs[segs.length - 1].end });
  }
  out.sort(function (a, b) { return a.startTimeMs - b.startTimeMs; });
  return out;
}

function muxLineLines(lines) {
  var timed = [];
  for (var i = 0; i < lines.length; i++) {
    if (hasLyricsText(lines[i].text) && !isCreditLine(lines[i].text) && typeof lines[i].start === "number") timed.push(lines[i]);
  }
  timed.sort(function (a, b) { return a.start - b.start; });
  var out = [];
  for (var j = 0; j < timed.length; j++) {
    var end = typeof timed[j].end === "number" && timed[j].end > timed[j].start ? timed[j].end : 0;
    var nextStart = j + 1 < timed.length ? timed[j + 1].start : 0;
    if (nextStart && end > nextStart) end = nextStart;
    out.push({ startTimeMs: Math.round(timed[j].start), words: muxTidy(timed[j].text), endTimeMs: Math.round(end) });
  }
  return out;
}
// ---- Finding the Spotify track ID (Spicy Lyrics, Musixmatch and the AMLL database are keyed by it) ---
function resetToken() {
  try { storage.remove("spotifyToken"); storage.remove("spotifyTokenExp"); } catch (e) {}
  return { success: true, message: "Token cache cleared" };
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

// ---- Spotify app lookup via the helper (lyrics-bridge.mjs) ----
// Where the helper is. Empty "Helper address" = this PC (127.0.0.1). Otherwise a name or IP, with or without :port or http(s)://,
// for a helper that runs on another machine that stays on (server mode, with a token).
function bridgeBase() {
  var port = parseInt(settings.bridgePort, 10);
  if (!port || port < 1 || port > 65535) port = 8089;
  var host = str("bridgeHost").replace(/\s+/g, "");
  if (!host) return "http://127.0.0.1:" + port;
  if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, "");
  host = host.replace(/\/+$/, "");
  return "http://" + host + (/:\d+$/.test(host) ? "" : ":" + port);
}

// Headers for every call to the helper: the token (server mode) goes in X-Bridge-Token.
function bridgeHeaders() {
  var h = { "Accept": "application/json" };
  var token = str("bridgeToken");
  if (token) h["X-Bridge-Token"] = token;
  return h;
}

function resolveViaBridge(track, artist, durationSec) {
  var url = bridgeBase() + "/search?track=" + encodeURIComponent(track) +
    "&artist=" + encodeURIComponent(artist) +
    (durationSec > 0 ? "&duration=" + Math.round(durationSec) : "");
  var resp;
  try {
    resp = http.get(url, bridgeHeaders());
  } catch (e) {
    return { error: "helper not reachable (" + String(e).slice(0, 120) + ")" };
  }
  if (resp.error || resp.statusCode === undefined) return { error: "helper not reachable at " + bridgeBase() + " (" + String(resp.error || "no answer").slice(0, 160) + ")" };
  if (resp.statusCode === 401) return { error: "the helper refused the token (check Helper token)" };
  if (resp.statusCode === 429) return { error: "Spotify is rate-limiting searches (the helper is waiting it out)" };
  if (resp.statusCode === 404) {
    var why = "";
    try { why = JSON.parse(resp.body).detail || ""; } catch (e0) {}
    return { error: "Spotify app found no match" + (why ? " (" + why.slice(0, 500) + ")" : "") };
  }
  if (!resp.ok) {
    var detail = "";
    try { detail = JSON.parse(resp.body).error || ""; } catch (e2) {}
    return { error: "helper HTTP " + resp.statusCode + (detail ? " " + String(detail).slice(0, 500) : "") };
  }
  var data;
  try { data = JSON.parse(resp.body); } catch (e3) { return { error: "helper sent invalid JSON" }; }
  if (data && /^[A-Za-z0-9]{22}$/.test(data.id || "")) return { id: data.id };
  return { error: "helper returned no track ID" };
}

function bridgeHealth() {
  try {
    var resp = http.get(bridgeBase() + "/health", bridgeHeaders());
    if (resp.error || resp.statusCode === undefined) return { ok: false, text: "helper not reachable at " + bridgeBase() + " (" + String(resp.error || "no answer").slice(0, 160) + ")" };
    if (resp.statusCode === 401) return { ok: false, text: "helper refused the token (check Helper token)" };
    if (!resp.ok) return { ok: false, text: "helper HTTP " + resp.statusCode };
    var d = JSON.parse(resp.body);
    var extra = d.sources && d.sources.length ? "; Genius/YouTube Music " + (d.sources.indexOf("genius") !== -1 ? "available" : "missing") : "; old helper, update to lyrics-bridge 2.0 for Genius/YouTube Music";
    return { ok: !!d.spotify, text: (d.spotify ? "helper OK, Spotify app connected" : "helper OK at " + bridgeBase() + ", Spotify app not connected there (only the Spotify lookup needs it)") + extra };
  } catch (e) {
    return { ok: false, text: "helper not reachable (" + String(e).slice(0, 120) + ")" };
  }
}

// ---- No-account lookup: ListenBrainz "Spotify id from metadata" (the lyric viewer uses it too) ----
function resolveViaListenBrainz(track, artist) {
  var firstArtist = artist.split(/[,&;]/)[0].trim();
  var titles = [track];
  var bare = track.replace(/\s*[(\[].*?[)\]]/g, "").trim();
  if (bare && bare !== track) titles.push(bare);
  var errors = [];
  for (var t = 0; t < titles.length; t++) {
    // We are not told the album, so try the title standing in for a single's album, then none.
    var albums = [titles[t], ""];
    for (var a = 0; a < albums.length; a++) {
      var url = "https://labs.api.listenbrainz.org/spotify-id-from-metadata/json?artist_name=" + encodeURIComponent(firstArtist) +
        "&release_name=" + encodeURIComponent(albums[a]) + "&track_name=" + encodeURIComponent(titles[t]);
      try {
        var resp = http.get(url, { "Accept": "application/json" });
        if (!resp.ok) { errors.push("HTTP " + resp.statusCode); continue; }
        var data = JSON.parse(resp.body);
        var ids = Array.isArray(data) && data[0] ? data[0].spotify_track_ids : null;
        if (Array.isArray(ids)) {
          for (var i = 0; i < ids.length; i++) if (/^[A-Za-z0-9]{22}$/.test(ids[i])) return { id: ids[i] };
        }
      } catch (err) { errors.push(String(err).slice(0, 80)); }
    }
  }
  return { error: "ListenBrainz had no match" + (errors.length ? " (" + errors[0] + ")" : "") };
}

function resolveSpotifyId(track, artist, durationSec) {
  var cacheKey = "id:" + normalize(track) + "|" + normalize(artist) + "|" + Math.round((durationSec || 0) / 5);
  var cached = storage.get(cacheKey);
  if (cached) { record("id cached " + cached); return { id: cached }; }

  var errors = [];
  var found = null;

  // 1) The running Spotify app, through the local helper (no keys, exact Spotify matching).
  if (on("useSpotifyApp", true)) {
    found = resolveViaBridge(track, artist, durationSec);
    if (found.id) {
      record("id from Spotify app " + found.id);
      storage.set(cacheKey, found.id);
      return found;
    }
    record("Spotify app lookup: " + found.error);
    errors.push(found.error);
    found = null;
  }

  if (settings.spotifyClientId && settings.spotifyClientSecret) {
    found = findSpotifyId(track, artist, durationSec);
    if (found.error) errors.push(found.error);
  }
  if (!found || !found.id) {
    var steps = [resolveViaListenBrainz, resolveViaItunes, resolveViaDeezer];
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
// ---- Genius and YouTube Music, through the helper (lyrics-bridge) -----------------------------------------------
// Both refuse the extension sandbox, so the helper program fetches them (see bridge/). It runs on this PC or, for phones,
// on a second computer (Helper address). If it can't be reached these two are skipped.

function bridgeGet(path, t) {
  if (t && t.bridgeDown) throw new Error("desktop helper not reachable (skipped)");
  var r;
  try {
    r = http.get(bridgeBase() + path, bridgeHeaders());
  } catch (e) {
    if (t) t.bridgeDown = true;
    throw new Error("desktop helper not reachable (" + String(e).slice(0, 80) + ")");
  }
  if (r && r.error) {
    if (t) t.bridgeDown = true;
    throw new Error("desktop helper not reachable (" + String(r.error).slice(0, 80) + ")");
  }
  if (r.statusCode === 401) throw new Error("the helper refused the token (check Helper token)");
  if (r.statusCode === 404) return null;
  if (r.statusCode === 400 && /not found/i.test(String(r.body))) throw new Error("the desktop helper is too old: update it to lyrics-bridge 2.0");
  if (!r.ok) {
    var why = "";
    try { why = JSON.parse(r.body).error || ""; } catch (e2) {}
    throw new Error("desktop helper answered " + r.statusCode + (why ? " (" + why + ")" : ""));
  }
  try { return JSON.parse(r.body); } catch (e3) { throw new Error("desktop helper sent invalid JSON"); }
}

function bridgeGetRetry(path, t) {
  try {
    return bridgeGet(path, t);
  } catch (e) {
    // Genius and YouTube answer with a passing 502/503 now and then.
    if (!/answered 50[234]/.test(String(e))) throw e;
    return bridgeGet(path, t);
  }
}

// ---- YouTube Music (plain text lyrics) ----------------------------------------------------------------------------
function fetchYouTubeMusic(t) {
  var found = bridgeGetRetry("/ytm/search?q=" + encodeURIComponent(t.artist + " " + t.name), t);
  var songs = found && found.songs ? found.songs : [];
  var cands = [];
  for (var i = 0; i < songs.length; i++) cands.push({ videoId: songs[i].videoId, title: songs[i].title, artists: songs[i].artists || [], durationMs: songs[i].durationMs || 0 });
  var ranked = rankCandidates(t, cands).slice(0, 2);
  for (var k = 0; k < ranked.length; k++) {
    try {
      var l = bridgeGetRetry("/ytm/lyrics?videoId=" + encodeURIComponent(ranked[k].videoId), t);
      var res = l && l.text ? plainResult(l.text, "YouTube Music" + (l.source ? " (" + l.source + ")" : "")) : null;
      if (res) return res;
    } catch (e) {
      record("ytmusic lyrics failed: " + String(e).slice(0, 80));
    }
  }
  return null;
}

// ---- Which Genius artists this listener's library hosts (kept between songs) ---------------------------------------
// Leaked and fan-uploaded songs sit on Spotify under an uploader's name while Genius lists the real artist. An artist
// seen behind uploader names in several songs is searched for, and trusted as the sole exact-title result.
var SEEN_KEY = "genius:artists";
var MAX_ARTISTS = 300, MAX_SONGS_PER_ARTIST = 50, MIN_LIBRARY_SONGS = 3, MAX_LIBRARY_QUERIES = 3;

function readSeen() {
  try {
    var raw = storage.get(SEEN_KEY);
    var parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) { return {}; }
}

function noteArtist(spotifyArtist, geniusArtist, path) {
  var key = normalizeName(geniusArtist);
  if (!key || similarity(normalizeName(spotifyArtist), key) >= 0.6) return;
  var seen = readSeen();
  var entry = seen[key] || (seen[key] = { name: geniusArtist, songs: [] });
  if (entry.songs.indexOf(path) !== -1) return;
  entry.songs = entry.songs.concat([path]).slice(-MAX_SONGS_PER_ARTIST);
  var keys = Object.keys(seen).sort(function (a, b) { return seen[b].songs.length - seen[a].songs.length; }).slice(0, MAX_ARTISTS);
  var keep = {};
  for (var i = 0; i < keys.length; i++) keep[keys[i]] = seen[keys[i]];
  try { storage.set(SEEN_KEY, JSON.stringify(keep)); } catch (e) {}
}

function libraryArtists(minSongs) {
  var seen = readSeen();
  var out = [];
  for (var key in seen) if (seen[key].songs.length >= minSongs) out.push({ name: seen[key].name, key: key, songs: seen[key].songs.length });
  out.sort(function (a, b) { return b.songs - a.songs; });
  return out;
}

// ---- Genius (plain text lyrics) ------------------------------------------------------------------------------------
var GENIUS_RELAXED = { relaxedVersions: true };
var GENIUS_MAX_CANDIDATES = 2;
var GENIUS_DEEP_RESULTS = 20;

function geniusFavorites() {
  var out = [];
  var parts = str("geniusFavoriteArtists").split(/[,;\n]+/);
  for (var i = 0; i < parts.length; i++) if (parts[i].trim()) out.push(parts[i].trim());
  return out;
}

// Song results for one search, without lyrics that are missing or still being transcribed.
function geniusSearchSongs(t, query, perPage) {
  var body = bridgeGetRetry("/genius/search?q=" + encodeURIComponent(query) + (perPage ? "&per_page=" + perPage : ""), t);
  var sections = body && body.response && body.response.sections ? body.response.sections : [];
  var section = null;
  for (var i = 0; i < sections.length; i++) if (sections[i].type === "song") { section = sections[i]; break; }
  section = section || sections[0];
  var hits = section && section.hits ? section.hits : [];
  var out = [];
  for (var h = 0; h < hits.length; h++) {
    var r = hits[h].result;
    if (!r || !r.path || r.lyrics_state !== "complete") continue;
    var artists = [];
    if (r.primary_artist && r.primary_artist.name) artists.push(r.primary_artist.name);
    for (var f = 0; f < (r.featured_artists || []).length; f++) if (r.featured_artists[f].name) artists.push(r.featured_artists[f].name);
    if (r.artist_names) artists.push(r.artist_names);
    out.push({ id: r.id, path: r.path, title: r.title || "", artists: artists, popularity: r.stats && r.stats.pageviews ? r.stats.pageviews : 0, durationMs: 0 });
  }
  return out;
}

function geniusPick(hit, how, trusted) {
  return { id: hit.id, path: hit.path, title: hit.title, artist: hit.artists[0] || "", how: how, trusted: !!trusted };
}

function geniusStrictQuery(t) { return (cleanTitle(t.name) || t.name) + " " + t.artist; }

function geniusStrictPicks(t) {
  var found = geniusSearchSongs(t, geniusStrictQuery(t));
  record("genius strict: " + found.length + " results");
  return rankCandidates(t, found, GENIUS_RELAXED).slice(0, GENIUS_MAX_CANDIDATES).map(function (h) { return geniusPick(h, "strict: title and artist match", true); });
}

function plainWords(value) { return String(value).replace(NON_WORD_KEEP_SPACE, " ").replace(/\s+/g, " ").trim(); }
var NON_WORD_KEEP_SPACE = null;
try { NON_WORD_KEEP_SPACE = new RegExp("[^\\p{L}\\p{N}\\s]", "gu"); } catch (e) { NON_WORD_KEEP_SPACE = /[^a-z0-9\sÀ-￿]/gi; }

// For a song with no proof of its real artist: the exact-title result by an artist the listener named, or one the
// library has resolved several times. Genius' search buries obscure songs under famous ones, so they are searched by name.
function geniusLibraryPick(t, pool, titles, favorites, addToPool, budget) {
  var named = favorites.map(function (n) { return { name: n, key: normalizeName(n), songs: Infinity }; });
  var all = named.concat(libraryArtists(MIN_LIBRARY_SONGS));
  var library = [];
  var seenKeys = {};
  for (var i = 0; i < all.length; i++) if (all[i].key && !seenKeys[all[i].key]) { seenKeys[all[i].key] = true; library.push(all[i]); }
  if (!library.length) return null;

  for (var a = 0; a < Math.min(library.length, MAX_LIBRARY_QUERIES); a++) {
    for (var k = 0; k < titles.length; k++) {
      if (elapsed() > budget) break;
      addToPool(geniusSearchSongs(t, titles[k] + " " + library[a].name));
    }
  }
  var keys = {};
  for (var l = 0; l < library.length; l++) keys[library[l].key] = library[l];
  var written = [t.name].concat(titles);
  var poolList = Object.keys(pool).map(function (p) { return pool[p]; });
  var exact = titleCandidates(t, poolList, GENIUS_RELAXED, TRUSTED_ARTIST_TITLE)
    .filter(function (hit) { return !!keys[normalizeName(hit.artists[0] || "")]; })
    .map(function (hit) {
      var alike = false;
      for (var w = 0; w < written.length; w++) if (writtenAlike(written[w], hit.title)) alike = true;
      return { hit: hit, alike: alike, songs: Math.min(keys[normalizeName(hit.artists[0] || "")].songs, 1000000) };
    });
  exact.sort(function (a2, b2) { return (b2.alike ? 1 : 0) - (a2.alike ? 1 : 0) || b2.songs - a2.songs; });
  if (!exact.length) return null;
  var best = exact[0];
  var info = keys[normalizeName(best.hit.artists[0] || "")];
  return geniusPick(best.hit, isFinite(info.songs) ? "loose: " + best.hit.artists[0] + ", whom your library has resolved " + info.songs + "x" : "loose: " + best.hit.artists[0] + ", a favourite artist you listed", false);
}

// Broader searches for when the exact song and artist found nothing.
function geniusLoosePicks(t, skip, favorites, eager, budget) {
  var titles = searchTitles(t.name).slice(0, 2);
  var title = titles[0];
  var artist = plainWords(t.artist);
  var strictQ = geniusStrictQuery(t);
  var raw = titles.concat([artist + " " + title, t.album ? title + " " + plainWords(t.album) : "", title + " " + artist]);
  var queries = [];
  for (var i = 0; i < raw.length; i++) {
    var q = raw[i].trim();
    if (q && queries.indexOf(q) === -1 && q !== strictQ) queries.push(q);
  }
  var pool = {};
  var addToPool = function (found) {
    for (var h = 0; h < found.length; h++) {
      // Genius' own Translations / Romanizations accounts re-post the same lyrics.
      if (/^genius\b/i.test(found[h].artists[0] || "")) continue;
      if (!skip[found[h].path]) pool[found[h].path] = found[h];
    }
  };
  var poolList = function () { return Object.keys(pool).map(function (p) { return pool[p]; }); };

  for (var qi = 0; qi < queries.length; qi++) {
    if (elapsed() > budget) break;
    // A bare title is what famous songs of the same name crowd out, so it asks for a deeper page of results.
    addToPool(geniusSearchSongs(t, queries[qi], titles.indexOf(queries[qi]) !== -1 ? GENIUS_DEEP_RESULTS : 0));
    if (rankLoose(t, poolList(), GENIUS_RELAXED).length >= GENIUS_MAX_CANDIDATES) break;
  }
  var picks = rankLoose(t, poolList(), GENIUS_RELAXED).map(function (h) { return geniusPick(h, "loose: closest title and artist", true); });
  if (!picks.length) {
    var lib = geniusLibraryPick(t, pool, titles, favorites, addToPool, budget);
    if (lib) picks.push(lib);
  }
  if (!picks.length && eager) {
    var best = rankEager(t, poolList(), GENIUS_RELAXED);
    if (best[0]) picks.push(geniusPick(best[0], "loose: best guess, nothing proved it", false));
  }
  return picks.slice(0, GENIUS_MAX_CANDIDATES);
}

function geniusLyricsAt(t, pick) {
  var r = bridgeGetRetry("/genius/lyrics?path=" + encodeURIComponent(pick.path) + (pick.id ? "&id=" + pick.id : ""), t);
  return r && r.text ? plainResult(r.text, "Genius") : null;
}

function fetchGenius(t, budget) {
  budget = budget || 1e9;
  var tried = {};
  var strict = geniusStrictPicks(t);
  for (var i = 0; i < strict.length; i++) {
    tried[strict[i].path] = true;
    var res = geniusLyricsAt(t, strict[i]);
    if (res) {
      if (strict[i].trusted) noteArtist(t.artist, strict[i].artist, strict[i].path);
      return res;
    }
  }
  if (!on("geniusLooseSearch", true)) return null;
  var picks = geniusLoosePicks(t, tried, geniusFavorites(), on("geniusEagerMatch", true), budget);
  for (var p = 0; p < picks.length; p++) {
    var r2 = geniusLyricsAt(t, picks[p]);
    if (r2) {
      record("genius " + picks[p].how);
      if (picks[p].trusted) noteArtist(t.artist, picks[p].artist, picks[p].path);
      return r2;
    }
  }
  return null;
}
// ---- Translation (Gemini, with your own key) ------------------------------------------------------------
// "line": one translated line under each lyric ([x-translation] rows, shown by the app as the translation).
// "word": the translation split into chunks tied to the sung words ([x-romaji] + [x-romaji-words] rows, shown by
//         the app in its word-by-word "pronunciation" slot, so it lights up as the line is sung).
var TR_CHUNK = 70;

function leadRow(words) { return String(words).split("\n")[0]; }

function leadText(line) {
  return stripTags(leadRow(line.words)).replace(/^\s*v[1-9]\d*:\s*/i, "").replace(/\s+/g, " ").trim();
}

// The sung words of a line with their start and end times: [{ text, start, end }].
function wordsOf(line) {
  var row = leadRow(line.words).replace(/^\s*v[1-9]\d*:\s*/i, "");
  var re = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
  var tags = [], m;
  while ((m = re.exec(row)) !== null) {
    tags.push({ at: m.index, end: m.index + m[0].length, time: parseInt(m[1], 10) * 60000 + parseInt(m[2], 10) * 1000 + (m[3] ? parseInt((m[3] + "00").slice(0, 3), 10) : 0) });
  }
  var segs = [];
  for (var i = 0; i < tags.length; i++) {
    var text = row.slice(tags[i].end, i + 1 < tags.length ? tags[i + 1].at : row.length);
    if (text.replace(/\s+/g, "") === "") {
      if (segs.length && text) segs[segs.length - 1].text += " ";
      if (segs.length) segs[segs.length - 1].end = tags[i].time;
      continue;
    }
    segs.push({ start: tags[i].time, end: i + 1 < tags.length ? tags[i + 1].time : line.endTimeMs, text: text });
  }
  var words = [];
  for (var s = 0; s < segs.length; s++) {
    var prev = words[words.length - 1];
    if (prev && !/\s$/.test(prev.text) && !/^\s/.test(segs[s].text)) {
      prev.text += segs[s].text;
      prev.end = segs[s].end;
    } else {
      words.push({ text: segs[s].text, start: segs[s].start, end: segs[s].end });
    }
  }
  for (var w = 0; w < words.length; w++) words[w].text = words[w].text.replace(/\s+/g, " ").trim();
  return words;
}

var GEMINI_SAFETY = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"];

function plainPrompt(lines, language) {
  var numbered = [];
  for (var i = 0; i < lines.length; i++) numbered.push((i + 1) + ". " + lines[i]);
  return [
    "You translate song lyrics into " + language + ".",
    "Translate each of the " + lines.length + " numbered lines. Keep the meaning, tone and slang; do not censor or soften anything; do not merge or split lines.",
    "If a line is already in " + language + " (even with slang, dialect or odd spelling), or is only sounds (ooh, yeah, la la), return an empty string \"\" for it. Never reword, correct or paraphrase a line that is already in " + language + ".",
    "Reply with a JSON array of exactly " + lines.length + " strings, in the same order, with no numbering.",
    "",
    numbered.join("\n")
  ].join("\n");
}

function syncedPrompt(lines, language) {
  var numbered = [];
  for (var i = 0; i < lines.length; i++) {
    var parts = [];
    for (var n = 0; n < lines[i].length; n++) parts.push((n + 1) + ":" + lines[i][n]);
    numbered.push((i + 1) + ". " + parts.join(" "));
  }
  return [
    "You translate song lyrics into " + language + ", lined up with the words as they are sung.",
    "Each of the " + lines.length + " numbered lines is given as its sung words, each tagged \"number:word\". Translate each line, keeping the meaning, tone and slang; do not censor or soften anything; do not merge or split lines.",
    "Give each line's translation as consecutive chunks in reading order (a word or short phrase each). For every chunk, \"w\" is the number of the sung word it matches best. Within a line \"w\" never decreases; if the word order differs, pick the nearest sung word that keeps it that way. The chunks joined exactly make the translated line, so keep the spaces inside the chunks (at the end of each chunk but the last).",
    "If a line is already in " + language + " (even with slang, dialect or odd spelling), or is only sounds (ooh, yeah, la la), return an empty array [] for it. Never reword, correct or paraphrase a line that is already in " + language + ".",
    "Reply with a JSON array of exactly " + lines.length + " arrays of {\"t\": chunk, \"w\": number}, in the same order.",
    "",
    numbered.join("\n")
  ].join("\n");
}

var PLAIN_SCHEMA = { type: "ARRAY", items: { type: "STRING" } };
var SYNCED_SCHEMA = { type: "ARRAY", items: { type: "ARRAY", items: { type: "OBJECT", properties: { t: { type: "STRING" }, w: { type: "INTEGER" } }, required: ["t", "w"] } } };

function askGemini(prompt, schema) {
  var key = str("geminiApiKey");
  var model = str("geminiModel", "gemini-3.5-flash-lite") || "gemini-3.5-flash-lite";
  var safety = [];
  for (var i = 0; i < GEMINI_SAFETY.length; i++) safety.push({ category: GEMINI_SAFETY[i], threshold: "BLOCK_NONE" });
  var body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, responseMimeType: "application/json", responseSchema: schema },
    safetySettings: safety
  };
  var resp = http.post("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
    JSON.stringify(body), { "Content-Type": "application/json", "x-goog-api-key": key });
  if (resp.error) throw new Error("Could not reach Gemini (" + String(resp.error).slice(0, 80) + ")");
  var data = null;
  try { data = JSON.parse(resp.body); } catch (e) {}
  if (!resp.ok) {
    var message = data && data.error && data.error.message ? data.error.message : "HTTP " + resp.statusCode;
    if (resp.statusCode === 400 && /api key/i.test(message)) throw new Error("The Gemini API key was not accepted");
    if (resp.statusCode === 404) throw new Error("Gemini has no model called \"" + model + "\"");
    if (resp.statusCode === 429) throw new Error("Gemini says you are over your limit");
    throw new Error("Gemini: " + String(message).slice(0, 140));
  }
  var cand = data && data.candidates ? data.candidates[0] : null;
  var text = "";
  if (cand && cand.content && cand.content.parts) for (var p = 0; p < cand.content.parts.length; p++) text += cand.content.parts[p].text || "";
  if (!text) throw new Error(data && data.promptFeedback && data.promptFeedback.blockReason ? "Gemini declined these lyrics (" + data.promptFeedback.blockReason + ")" : "Gemini sent no translation");
  try { return JSON.parse(text); } catch (e2) { throw new Error("Gemini's answer could not be read"); }
}

function hashOf(text) {
  var h = 5381;
  for (var i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Whether two lines say the same thing, give or take punctuation, case and a stray word or two.
function sameLine(a, b) {
  var flat = function (s) { return nfkc(s).toLowerCase().replace(NON_WORD, ""); };
  var x = flat(a), y = flat(b);
  if (x === y) return true;
  if (!x || !y || Math.abs(x.length - y.length) > Math.max(x.length, y.length) * 0.2) return false;
  var prev = [], j;
  for (j = 0; j <= y.length; j++) prev[j] = j;
  for (var i = 1; i <= x.length; i++) {
    var row = [i];
    for (j = 1; j <= y.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x.charAt(i - 1) === y.charAt(j - 1) ? 0 : 1));
    prev = row;
  }
  return prev[y.length] <= Math.max(x.length, y.length) * 0.15;
}

function cleanChunks(chunks, count) {
  var out = [];
  var last = 1;
  for (var i = 0; i < (chunks || []).length; i++) {
    var c = chunks[i];
    if (!c || typeof c.t !== "string" || c.t === "") continue;
    var w = Math.min(count, Math.max(last, Math.round(Number(c.w)) || last));
    out.push({ t: c.t, w: w });
    last = w;
  }
  return out;
}

// Translations for `items`: [string] (line mode) or [[word, ...]] (word mode), one result per item. Cached for a while.
function translateAll(items, language, synced) {
  var model = str("geminiModel", "gemini-3.5-flash-lite");
  var key = "tr1:" + hashOf(language + "|" + model + "|" + (synced ? "w" : "l") + "|" + JSON.stringify(items));
  try {
    var cached = storage.get(key);
    if (cached) {
      var parsed = JSON.parse(cached);
      if (parsed && parsed.length === items.length) return parsed;
    }
  } catch (e) {}
  var out = [];
  for (var i = 0; i < items.length; i += TR_CHUNK) {
    var part = items.slice(i, i + TR_CHUNK);
    var answer = askGemini(synced ? syncedPrompt(part, language) : plainPrompt(part, language), synced ? SYNCED_SCHEMA : PLAIN_SCHEMA);
    if (!answer || answer.length !== part.length) throw new Error("Gemini's answer did not match the lyrics line for line");
    for (var k = 0; k < answer.length; k++) {
      if (synced) {
        if (Object.prototype.toString.call(answer[k]) !== "[object Array]") throw new Error("Gemini's answer did not match the lyrics line for line");
        out.push(cleanChunks(answer[k], part[k].length));
      } else {
        if (typeof answer[k] !== "string") throw new Error("Gemini's answer did not match the lyrics line for line");
        out.push(answer[k]);
      }
    }
  }
  try { storage.set(key, JSON.stringify(out)); } catch (e2) {}
  return out;
}

function supplementRow(kind, startMs, text) {
  return "\n[" + kind + ":" + startMs + ":" + bytesToB64(utf8bytes(text)) + "]";
}

// Adds translation rows to the lines (in place). Returns how many lines got one.
function addTranslations(lines, mode) {
  var language = str("translateTo", "English") || "English";
  var seen = {};
  var idx = [];
  var texts = [];
  var sung = [];
  var i;
  for (i = 0; i < lines.length; i++) {
    var text = leadText(lines[i]);
    if (!text || !hasLyricsText(text) || seen[lines[i].startTimeMs]) continue;
    seen[lines[i].startTimeMs] = true;
    var w = mode === "word" ? wordsOf(lines[i]) : null;
    if (mode === "word") {
      if (!w.length) continue;
      sung.push(w.map(function (x) { return x.text; }));
    }
    idx.push(i);
    texts.push(text);
  }
  if (!idx.length) return 0;
  var result = translateAll(mode === "word" ? sung : texts, language, mode === "word");
  var added = 0;
  for (var n = 0; n < idx.length; n++) {
    var line = lines[idx[n]];
    if (mode === "word") {
      var chunks = result[n];
      if (!chunks || !chunks.length) continue;
      var joined = "";
      for (var c = 0; c < chunks.length; c++) joined += chunks[c].t;
      if (sameLine(joined, texts[n])) continue;
      var sw = wordsOf(line);
      var lineEnd = sw[sw.length - 1].end || line.endTimeMs;
      var startOf = function (ch) { return sw[Math.min(sw.length, Math.max(1, ch.w)) - 1].start; };
      var items = [];
      var k = 0;
      while (k < chunks.length) {
        var m = k;
        while (m + 1 < chunks.length && chunks[m + 1].w === chunks[k].w) m++;
        var from = startOf(chunks[k]);
        var to = m + 1 < chunks.length ? startOf(chunks[m + 1]) : lineEnd;
        var each = (to - from) / (m - k + 1);
        for (var q = k; q <= m; q++) {
          items.push({ text: chunks[q].t, startTimeMs: Math.round(from + each * (q - k)), endTimeMs: Math.round(from + each * (q - k + 1)) });
        }
        k = m + 1;
      }
      // The app wants the words in order and its text to equal the joined chunks, trimmed at both ends.
      items[0].text = items[0].text.replace(/^\s+/, "");
      items[items.length - 1].text = items[items.length - 1].text.replace(/\s+$/, "");
      var whole = "";
      for (var z = 0; z < items.length; z++) {
        if (items[z].endTimeMs < items[z].startTimeMs) items[z].endTimeMs = items[z].startTimeMs;
        if (z > 0 && items[z].startTimeMs < items[z - 1].startTimeMs) items[z].startTimeMs = items[z - 1].startTimeMs;
        whole += items[z].text;
      }
      line.words += supplementRow("x-romaji", line.startTimeMs, whole);
      line.words += supplementRow("x-romaji-words", line.startTimeMs, JSON.stringify(items));
      added++;
    } else {
      var tr = String(result[n] || "").trim();
      if (!tr || sameLine(tr, texts[n])) continue;
      line.words += supplementRow("x-translation", line.startTimeMs, tr);
      added++;
    }
  }
  return added;
}
// ---- Putting it together -------------------------------------------------------------------------------
// maxRank: the best sync a source can give (3 word, 2 line, 1 plain); one that cannot beat what is held is not asked.
var PROVIDERS = {
  spicy:      { label: "Spicy Lyrics", fn: fetchSpicy, max: 3 },
  lrcred:     { label: "lrc.red", fn: fetchLrcRed, max: 3 },
  amll:       { label: "AMLL TTML DB", fn: fetchAmll, max: 3 },
  binilyrics: { label: "BiniLyrics", fn: fetchBini, max: 3 },
  musixmatch: { label: "Musixmatch", fn: fetchMusixmatch, max: 3 },
  unison:     { label: "Unison", fn: fetchUnison, max: 3 },
  lrclib:     { label: "LRCLIB", fn: fetchLrcLib, max: 3 },
  lrcmux:     { label: "LRCMux", fn: fetchLrcMux, max: 3 },
  netease:    { label: "NetEase", fn: fetchNetEase, max: 3 },
  qqmusic:    { label: "QQ Music", fn: fetchQQ, max: 2 },
  kugou:      { label: "KuGou", fn: fetchKugou, max: 3 },
  kuwo:       { label: "Kuwo", fn: fetchKuwo, max: 2 },
  deezer:     { label: "Deezer", fn: fetchDeezer, max: 2 },
  ytmusic:    { label: "YouTube Music", fn: fetchYouTubeMusic, max: 1, needsHelper: true },
  genius:     { label: "Genius", fn: fetchGenius, max: 1, needsHelper: true }
};
var DEFAULT_ORDER = ["spicy", "lrcred", "amll", "binilyrics", "musixmatch", "unison", "lrclib", "lrcmux", "netease", "qqmusic", "kugou", "kuwo", "deezer", "ytmusic", "genius"];

// The order the user typed (ids or names, comma separated), then anything they left out in the default order.
var ORDER_ALIASES = { lrc: "lrclib", lrcred: "lrcred", lrcredapi: "lrcred", amllttmldb: "amll", ttml: "amll", bini: "binilyrics", mxm: "musixmatch",
  qq: "qqmusic", tencent: "qqmusic", wangyi: "netease", ncm: "netease", netease163: "netease", youtube: "ytmusic", yt: "ytmusic", ytm: "ytmusic",
  youtubemusic: "ytmusic", spicylyrics: "spicy" };

function orderId(token) {
  var w = String(token).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!w) return "";
  if (PROVIDERS[w]) return w;
  if (ORDER_ALIASES[w]) return ORDER_ALIASES[w];
  for (var id in PROVIDERS) if (w === PROVIDERS[id].label.toLowerCase().replace(/[^a-z0-9]/g, "")) return id;
  return "";
}

// The order the user typed (ids or names, separated by commas, semicolons, > | / or new lines; spaces work too when the names
// have none), then anything they left out in the default order.
function providerOrder() {
  var out = [];
  var tokens = str("providerOrder").split(/[,;>|\/\n]+/);
  for (var i = 0; i < tokens.length; i++) {
    var id = orderId(tokens[i]);
    if (id) { if (out.indexOf(id) === -1) out.push(id); continue; }
    var words = tokens[i].split(/\s+/);
    if (words.length > 1) {
      for (var w = 0; w < words.length; w++) {
        var one = orderId(words[w]);
        if (one && out.indexOf(one) === -1) out.push(one);
      }
    }
  }
  for (var d = 0; d < DEFAULT_ORDER.length; d++) if (out.indexOf(DEFAULT_ORDER[d]) === -1) out.push(DEFAULT_ORDER[d]);
  return out;
}

function providerOn(id) { return on("use_" + id, true); }

function doFetch(trackName, artistName, albumName, durationSec) {
  var t = { name: String(trackName), artist: String(artistName), album: albumName ? String(albumName) : "", durationSec: durationSec > 0 ? durationSec : 0, durationMs: durationSec > 0 ? Math.round(durationSec * 1000) : 0 };
  var preferBest = on("preferBestSync", true);
  var allowPlain = on("allowPlainFallback", true);
  var budget = Math.max(5, num("timeBudgetSec", 22)) * 1000;
  var order = providerOrder();
  record("order: " + order.filter(providerOn).join(" > "));
  var best = null, bestRank = 0, bestId = "";

  for (var i = 0; i < order.length; i++) {
    var id = order[i];
    var p = PROVIDERS[id];
    if (!providerOn(id)) continue;
    if (p.max <= bestRank) continue;
    if (p.needsHelper && t.bridgeDown) { record(p.label + ": skipped, the desktop helper is not reachable"); continue; }
    if (elapsed() > budget) { record("time budget used up, stopped before " + p.label); break; }
    var t0 = Date.now();
    var res = null;
    try {
      res = p.fn(t, budget);
    } catch (err) {
      record(p.label + " failed: " + String(err).slice(0, 140));
      continue;
    }
    var rank = rankOf(res);
    record(p.label + ": " + (res ? ["", "plain text", "line synced", "word synced"][rank] + (res.lines.length ? " (" + res.lines.length + " lines)" : "") : "nothing") + " in " + (Date.now() - t0) + " ms");
    if (!res || (rank === 1 && !allowPlain)) continue;
    if (rank > bestRank) {
      best = res; bestRank = rank; bestId = id;
      // Best sync on: keep looking until word timing turns up. Off: the first source in your order that has synced lyrics
      // wins (plain text is only kept in case nothing synced is found later).
      if (rank >= 3 || (!preferBest && rank >= 2)) break;
    }
  }
  if (!best) return null;

  var credit = best.credit || PROVIDERS[bestId].label;
  if (!best.lines.length) {
    return { lines: [], syncType: "UNSYNCED", instrumental: false, plainLyrics: best.plain, provider: credit };
  }

  var lines = best.lines;
  lines.sort(function (a, b) { return a.startTimeMs - b.startTimeMs; });
  fillEndTimes(lines, durationSec);
  if (!on("wordTiming", true)) lines = toLineSynced(lines);
  shiftLines(lines, num("timingOffsetMs", 0));

  var mode = str("translationMode", "off");
  if ((mode === "line" || mode === "word") && str("geminiApiKey") && elapsed() < budget + 3000) {
    try {
      var added = addTranslations(lines, mode);
      record("translation (" + mode + "): " + added + " lines");
      if (added) credit += " + Gemini translation";
    } catch (e) {
      record("translation failed: " + String(e).slice(0, 160));
    }
  }

  return { lines: lines, syncType: "LINE_SYNCED", instrumental: false, plainLyrics: plainOf(lines), provider: credit };
}

function fetchLyrics(trackName, artistName, albumName, durationSec) {
  T0 = Date.now();
  trace = [];
  record("ask: " + trackName + " / " + artistName + " / " + Math.round(durationSec || 0) + "s");
  var result = null;
  try {
    if (trackName && artistName) result = doFetch(trackName, artistName, albumName, durationSec);
  } catch (err) {
    record("exception: " + String(err));
  }
  record(result ? "returned " + result.syncType + " from " + result.provider : "returned nothing");
  saveTrace();
  return result;
}

function lastLookup() {
  var t = storage.get("lastTrace");
  return { success: true, message: t || "No lookup has run yet. Download or re-fetch lyrics for a track, then tap this again." };
}

function testConnection() {
  var steps = [];
  try {
    var enabled = [];
    for (var id in PROVIDERS) if (providerOn(id)) enabled.push(PROVIDERS[id].label);
    steps.push("Sources on: " + (enabled.join(", ") || "none"));
    if (str("spicyKey") && providerOn("spicy")) {
      if (on("useSpotifyApp", true)) steps.push("Helper: " + bridgeHealth().text);
      var found = resolveSpotifyId("Bad Romance", "Lady Gaga", 294);
      steps.push(found.id ? "Spotify track lookup OK" : "Spotify track lookup failed: " + found.error);
      if (found.id) {
        var r = http.get("https://api.spicylyrics.org/v1/lyrics/" + found.id, { "Authorization": "Bearer " + str("spicyKey") });
        steps.push(r.ok ? "Spicy Lyrics OK" : "Spicy Lyrics HTTP " + r.statusCode);
      }
    }
    if (providerOn("genius") || providerOn("ytmusic")) {
      var bh = bridgeHealth();
      steps.push("Helper (Genius / YouTube Music): " + bh.text);
    }
    if (str("geminiApiKey") && str("translationMode", "off") !== "off") {
      try { askGemini("Reply with a JSON array containing the single string \"ok\".", PLAIN_SCHEMA); steps.push("Gemini OK"); }
      catch (e) { steps.push("Gemini: " + String(e).replace(/^Error: /, "")); }
    }
    return { success: true, message: steps.join("; ") };
  } catch (err) {
    return { success: false, error: steps.join("; ") + "; exception: " + String(err) };
  }
}

registerExtension({
  initialize: initialize,
  cleanup: cleanup,
  fetchLyrics: fetchLyrics,
  resetToken: resetToken,
  lastLookup: lastLookup,
  testConnection: testConnection
});

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

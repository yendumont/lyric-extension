// Unison lyrics provider for SpotiFLAC Mobile (word-sync aware).
// API: https://github.com/better-lyrics/unison  (lyrics: ODbL, attribution required)
var PROVIDER = "Unison";
var settings = {};

function initialize(config) {
  settings = config || {};
  return true;
}

function cleanup() {}

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
  for (var i = 0; i < parts.length; i++) {
    secs = secs * 60 + parseFloat(parts[i].replace(",", "."));
  }
  return isNaN(secs) ? 0 : Math.round(secs * 1000);
}

function parseLRC(text) {
  var out = [];
  var rows = String(text).split(/\r?\n/);
  var lead = /^\s*((?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s*)+)/;
  var one = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];

    // "[bg:...]" row = background vocal of the previous line.
    if (/^\s*\[bg:/i.test(row)) {
      if (out.length && settings.backgroundVocals !== false) out[out.length - 1].words += "\n" + row.trim().replace(/\[(\d{1,3}:\d{2}(?:[.:]\d{1,3})?)\]/g, "<$1>");
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
  var useVoices = agents.length > 1 && settings.voiceAlignment !== false;
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

function fillEndTimes(lines, durationSec) {
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].endTimeMs && lines[i].endTimeMs > lines[i].startTimeMs) continue;
    if (i + 1 < lines.length) lines[i].endTimeMs = lines[i + 1].startTimeMs;
    else lines[i].endTimeMs = durationSec > 0 ? Math.round(durationSec * 1000) : lines[i].startTimeMs + 5000;
  }
  return lines;
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

function fetchLyrics(trackName, artistName, albumName, durationSec) {
  if (!trackName || !artistName) return null;

  var qs = "song=" + encodeURIComponent(trackName) + "&artist=" + encodeURIComponent(artistName);
  if (albumName) qs += "&album=" + encodeURIComponent(albumName);
  if (settings.durationTolerance !== false && durationSec > 0) {
    qs += "&duration=" + Math.round(durationSec);
  }

  var resp;
  try {
    resp = http.get("https://unison.boidu.dev/lyrics?" + qs, { "Accept": "application/json" });
  } catch (err) {
    log.warn("Unison request failed: " + String(err));
    return null;
  }
  if (!resp.ok) {
    if (resp.statusCode !== 404) log.warn("Unison returned HTTP " + resp.statusCode);
    return null;
  }

  var payload;
  try {
    payload = JSON.parse(resp.body);
  } catch (err) {
    return null;
  }
  var data = payload && (payload.data || payload);
  if (!data || typeof data.lyrics !== "string" || !data.lyrics.trim()) return null;

  var format = String(data.format || "").toLowerCase();
  var raw = data.lyrics;
  if (format === "ttml" || /^\s*<(\?xml|tt\b)/.test(raw)) format = "ttml";
  else if (format !== "plain" && /\[\d{1,3}:\d{2}/.test(raw)) format = "lrc";

  var lines = [];
  if (format === "ttml") lines = parseTTML(raw);
  else if (format === "lrc") lines = parseLRC(raw);

  if (lines.length) {
    fillEndTimes(lines, durationSec);
    applyOffset(lines);
    return {
      lines: lines,
      syncType: "LINE_SYNCED",
      instrumental: false,
      plainLyrics: plainOf(lines),
      provider: PROVIDER
    };
  }

  if (format === "plain") {
    return {
      lines: [],
      syncType: "UNSYNCED",
      instrumental: false,
      plainLyrics: raw.trim(),
      provider: PROVIDER
    };
  }
  return null;
}

registerExtension({
  initialize: initialize,
  cleanup: cleanup,
  fetchLyrics: fetchLyrics
});

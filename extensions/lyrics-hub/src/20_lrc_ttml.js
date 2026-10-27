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


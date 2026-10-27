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

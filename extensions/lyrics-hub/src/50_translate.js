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

function syncedPrompt(lines, language, retry) {
  var numbered = [];
  for (var i = 0; i < lines.length; i++) {
    var parts = [];
    for (var n = 0; n < lines[i].length; n++) {
      var sw_ = lines[i][n];
      // Each sung word with how long it is held; a long gap before it is marked, so pauses and held notes are visible.
      parts.push((sw_.gap >= 500 ? "[pause " + sw_.gap + "ms] " : "") + (n + 1) + ":" + sw_.w + "(" + sw_.ms + "ms)");
    }
    numbered.push((i + 1) + ". " + parts.join(" "));
  }
  return [
    "You translate song lyrics into " + language + ", lined up with the words as they are sung.",
    "Each of the " + lines.length + " numbered lines is given as its sung words, each tagged \"number:word(duration)\", with long pauses marked. Use the whole song as context so each line is translated the way it is meant, and use the durations to place phrases: a long word is held, a pause separates phrases. Translate each line, keeping the meaning, tone and slang; do not censor or soften anything; do not merge or split lines.",
    "Give each line's translation as consecutive chunks in reading order, as small as the language allows: about one chunk per sung word, a short phrase when several sung words become one. Never make one chunk cover a whole line unless the line is one or two words.",
    "For every chunk give \"from\" and \"to\": the numbers of the first and last sung word the chunk expresses (from <= to, inclusive). Chunks stay in order: a chunk's \"from\" is never lower than the previous chunk's \"from\", and its \"to\" is never lower than the previous \"to\". Neighbouring chunks may share a sung word only when that one word is translated by several chunks. If the word order differs between the languages, pick the ranges that keep the order. The chunks joined exactly make the translated line, so keep the spaces inside the chunks (at the end of each chunk but the last).",
    "If a line is already in " + language + " (even with slang, dialect or odd spelling), or is only sounds (ooh, yeah, la la), return an empty array [] for it. Never reword, correct or paraphrase a line that is already in " + language + ".",
    retry ? "A first attempt paired some lines badly (many chunks on one word, or sung words left out). Spread every line's chunks across all of its sung words, in order, so every sung word is covered by some chunk." : "",
    "Reply with a JSON array of exactly " + lines.length + " arrays of {\"t\": chunk, \"from\": number, \"to\": number}, in the same order.",
    "",
    numbered.join("\n")
  ].join("\n");
}

var PLAIN_SCHEMA = { type: "ARRAY", items: { type: "STRING" } };
var SYNCED_SCHEMA = { type: "ARRAY", items: { type: "ARRAY", items: { type: "OBJECT", properties: { t: { type: "STRING" }, from: { type: "INTEGER" }, to: { type: "INTEGER" } }, required: ["t", "from", "to"] } } };

function askGemini(prompt, schema) {
  var key = str("geminiApiKey");
  var model = str("geminiModel", "gemini-3.5-flash-lite") || "gemini-3.5-flash-lite";
  var safety = [];
  for (var i = 0; i < GEMINI_SAFETY.length; i++) safety.push({ category: GEMINI_SAFETY[i], threshold: "BLOCK_NONE" });
  var body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: schema === SYNCED_SCHEMA ? 0 : 0.3, responseMimeType: "application/json", responseSchema: schema },
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

// Gemini's chunks as { t, from, to } (sung word numbers, 1-based, inclusive), kept in order and inside the line.
// An answer that only has "w" (one word per chunk) still works.
function cleanChunks(chunks, count) {
  var out = [];
  var lastFrom = 1, lastTo = 1;
  for (var i = 0; i < (chunks || []).length; i++) {
    var c = chunks[i];
    if (!c || typeof c.t !== "string" || c.t === "") continue;
    var from = Math.round(Number(c.from !== undefined ? c.from : c.w)) || lastFrom;
    var to = Math.round(Number(c.to !== undefined ? c.to : from)) || from;
    from = Math.min(count, Math.max(lastFrom, from));
    to = Math.min(count, Math.max(lastTo, from, to));
    out.push({ t: c.t, from: from, to: to });
    lastFrom = from;
    lastTo = to;
  }
  return out;
}

// A pairing that cannot be trusted, spread by text instead: the chunks keep their order and each gets the sung words that sit at
// the same relative position (by letters) in the line. Always usable, but only approximate.
function spreadChunks(chunks, sw) {
  var total = 0, i;
  for (i = 0; i < sw.length; i++) total += Math.max(1, sw[i].text.replace(/\s+/g, "").length);
  var cum = [0];
  for (i = 0; i < sw.length; i++) cum[i + 1] = cum[i] + Math.max(1, sw[i].text.replace(/\s+/g, "").length);
  var len = 0, sum = 0;
  for (i = 0; i < chunks.length; i++) sum += Math.max(1, chunks[i].t.replace(/\s+/g, "").length);
  var out = [], at = 0;
  for (i = 0; i < chunks.length; i++) {
    var w1 = Math.max(1, chunks[i].t.replace(/\s+/g, "").length);
    var a = at / sum * total, b = (at + w1) / sum * total;
    at += w1;
    var from = 1, to = sw.length, k;
    for (k = 0; k < sw.length; k++) if (cum[k + 1] > a + 0.0001) { from = k + 1; break; }
    for (k = sw.length - 1; k >= 0; k--) if (cum[k] < b - 0.0001) { to = k + 1; break; }
    out.push({ t: chunks[i].t, from: from, to: Math.max(from, to) });
  }
  return out;
}

// Times for the chunks from the real timing of the sung words they cover: a chunk starts when its first sung word starts and
// ends when its last one ends. Where neighbouring chunks share sung words, that stretch is split between them by text length.
// `sw` is wordsOf(line). Returns [{ text, startTimeMs, endTimeMs }], or null when the pairing looks wrong (too many chunks
// on one word, or most sung words unaccounted for), so the caller can fall back to a plain translated line.
function chunkTimings(chunks, sw, lineEnd) {
  if (!chunks.length || !sw.length) return null;
  var n = chunks.length, i;
  var uses = {};
  for (i = 0; i < n; i++) {
    for (var u = chunks[i].from; u <= chunks[i].to; u++) uses[u] = (uses[u] || 0) + 1;
  }
  var covered = 0, w;
  for (w = 1; w <= sw.length; w++) {
    if (uses[w] > 4) return null;
    if (uses[w]) covered++;
  }
  if (sw.length >= 3 && covered < Math.ceil(sw.length * 0.5)) return null;
  var start = [], end = [];
  for (i = 0; i < n; i++) {
    var first = sw[chunks[i].from - 1], last = sw[chunks[i].to - 1];
    start[i] = first.start;
    end[i] = last.end > last.start ? last.end : (chunks[i].to < sw.length ? sw[chunks[i].to].start : lineEnd);
    if (end[i] < start[i]) end[i] = start[i];
  }
  // Group chunks whose stretches overlap and share the stretch out by text length.
  var g = 0;
  while (g < n) {
    var h = g, groupEnd = end[g];
    while (h + 1 < n && start[h + 1] < groupEnd) { h++; if (end[h] > groupEnd) groupEnd = end[h]; }
    if (h > g) {
      var from = start[g], weightSum = 0, k;
      for (k = g; k <= h; k++) weightSum += Math.max(1, chunks[k].t.replace(/\s+/g, "").length);
      var at = from;
      for (k = g; k <= h; k++) {
        start[k] = Math.round(at);
        at += (groupEnd - from) * Math.max(1, chunks[k].t.replace(/\s+/g, "").length) / weightSum;
        end[k] = k === h ? groupEnd : Math.round(at);
      }
    }
    g = h + 1;
  }
  var items = [];
  for (i = 0; i < n; i++) {
    if (i > 0 && start[i] < items[i - 1].startTimeMs) start[i] = items[i - 1].startTimeMs;
    if (end[i] < start[i]) end[i] = start[i];
    items.push({ text: chunks[i].t, startTimeMs: Math.round(start[i]), endTimeMs: Math.round(end[i]) });
  }
  items[0].text = items[0].text.replace(/^\s+/, "");
  items[n - 1].text = items[n - 1].text.replace(/\s+$/, "");
  return items;
}

// Translations for `items`: [string] (line mode) or [[word, ...]] (word mode), one result per item. Cached for a while.
function translateAll(items, language, synced, retry) {
  var model = str("geminiModel", "gemini-3.5-flash-lite");
  var key = "tr2:" + hashOf(language + "|" + model + "|" + (synced ? (retry ? "r" : "w") : "l") + "|" + JSON.stringify(items));
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
    var answer = askGemini(synced ? syncedPrompt(part, language, retry) : plainPrompt(part, language), synced ? SYNCED_SCHEMA : PLAIN_SCHEMA);
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
      sung.push(w.map(function (x, q) {
        return { w: x.text, ms: Math.max(0, Math.round((x.end || x.start) - x.start)), gap: q ? Math.max(0, Math.round(x.start - (w[q - 1].end || w[q - 1].start))) : 0 };
      }));
    }
    idx.push(i);
    texts.push(text);
  }
  if (!idx.length) return 0;
  var result = translateAll(mode === "word" ? sung : texts, language, mode === "word");
  var added = 0;
  if (mode === "word") {
    // Lines whose pairing looks wrong are asked about once more, with a hint; what still fails is spread by text below.
    var bad = [], badItems = [];
    for (var b0 = 0; b0 < idx.length; b0++) {
      var swb = wordsOf(lines[idx[b0]]);
      if (result[b0] && result[b0].length && swb.length && !chunkTimings(result[b0], swb, swb[swb.length - 1].end || lines[idx[b0]].endTimeMs)) {
        bad.push(b0);
        badItems.push(sung[b0]);
      }
    }
    if (bad.length && elapsed() < 20000) {
      try {
        var again = translateAll(badItems, language, true, true);
        for (var r0 = 0; r0 < bad.length; r0++) if (again[r0] && again[r0].length) result[bad[r0]] = again[r0];
        record("translation: " + bad.length + " badly paired lines asked again");
      } catch (e3) {
        record("translation retry failed: " + String(e3).slice(0, 120));
      }
    }
  }
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
      var items = chunkTimings(chunks, sw, lineEnd);
      // Still not trustworthy after the second try: lay the chunks over the sung words by text length (approximate, but in step).
      if (!items) items = chunkTimings(spreadChunks(chunks, sw), sw, lineEnd);
      if (!items) {
        line.words += supplementRow("x-translation", line.startTimeMs, joined.replace(/\s+/g, " ").trim());
        added++;
        continue;
      }
      var whole = "";
      for (var z = 0; z < items.length; z++) whole += items[z].text;
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

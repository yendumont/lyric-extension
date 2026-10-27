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

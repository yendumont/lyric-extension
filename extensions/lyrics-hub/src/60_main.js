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

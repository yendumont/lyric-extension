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

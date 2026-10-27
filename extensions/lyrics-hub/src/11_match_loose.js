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

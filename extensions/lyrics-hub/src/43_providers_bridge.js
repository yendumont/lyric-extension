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

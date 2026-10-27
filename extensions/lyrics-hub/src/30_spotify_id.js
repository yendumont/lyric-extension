// ---- Finding the Spotify track ID (Spicy Lyrics, Musixmatch and the AMLL database are keyed by it) ---
function resetToken() {
  try { storage.remove("spotifyToken"); storage.remove("spotifyTokenExp"); } catch (e) {}
  return { success: true, message: "Token cache cleared" };
}

function formEncode(obj) {
  return Object.keys(obj)
    .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]); })
    .join("&");
}

function getSpotifyToken() {
  var now = Date.now();
  var cached = storage.get("spotifyToken");
  var exp = storage.get("spotifyTokenExp");
  if (cached && exp && exp - 60000 > now) return cached;

  if (!settings.spotifyClientId || !settings.spotifyClientSecret) return null;
  var basic = btoa(settings.spotifyClientId + ":" + settings.spotifyClientSecret);
  var resp = http.post(
    "https://accounts.spotify.com/api/token",
    formEncode({ grant_type: "client_credentials" }),
    { "Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + basic }
  );
  if (!resp.ok) {
    log.warn("Spotify token request failed: HTTP " + resp.statusCode);
    return null;
  }
  var data = JSON.parse(resp.body);
  storage.set("spotifyToken", data.access_token);
  storage.set("spotifyTokenExp", now + (data.expires_in || 3600) * 1000);
  return data.access_token;
}

function normalize(s) {
  var t = String(s || "").toLowerCase();
  t = t.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  var dash = t.indexOf(" - ");
  if (dash !== -1) t = t.slice(0, dash);
  var out = "";
  for (var i = 0; i < t.length; i++) {
    var c = t.charAt(i);
    var code = t.charCodeAt(i);
    if (c === "'" || c === "\u2019" || c === "\u2018") continue; // don't == don\u2019t
    if (code === 0x2013 || code === 0x2014 || code === 0x2010 || code === 0x2011) out += " ";
    else if ((code >= 48 && code <= 57) || (code >= 97 && code <= 122) || code > 127) out += c;
    else out += " ";
  }
  return out.split(" ").filter(function (w) { return w.length > 0; }).join(" ");
}

function searchSpotify(token, q) {
  var url = "https://api.spotify.com/v1/search?type=track&limit=10&q=" + encodeURIComponent(q);
  var resp = http.get(url, { "Authorization": "Bearer " + token });
  if (resp.statusCode === 401) {
    resetToken();
    return { error: "Spotify rejected the token (401)" };
  }
  if (!resp.ok) {
    var detail = "";
    try { detail = (JSON.parse(resp.body).error || {}).message || ""; } catch (e) {}
    log.error("Spotify search failed: HTTP " + resp.statusCode + " " + detail);
    return { error: "Spotify search failed: HTTP " + resp.statusCode + (detail ? " (" + detail + ")" : "") };
  }
  return { items: (JSON.parse(resp.body).tracks || {}).items || [] };
}

function pickMatch(items, track, artist, durationSec) {
  var wantTitle = normalize(track);
  var wantArtist = normalize(artist);
  var best = null;
  var bestScore = -1;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var score = 0;
    var name = normalize(it.name);
    if (name === wantTitle) score += 3;
    else if (wantTitle && name && (name.indexOf(wantTitle) !== -1 || wantTitle.indexOf(name) !== -1)) score += 1;
    else continue;
    var artistHit = false;
    for (var a = 0; a < it.artists.length; a++) {
      var n = normalize(it.artists[a].name);
      if (n && (wantArtist.indexOf(n) !== -1 || n.indexOf(wantArtist) !== -1)) artistHit = true;
    }
    if (!artistHit) continue;
    score += 2;
    if (durationSec > 0) {
      var diff = Math.abs(it.duration_ms / 1000 - durationSec);
      if (diff <= 2) score += 3;
      else if (diff <= 5) score += 1;
      else if (diff > 15) continue; // a different recording; never swap silently
    }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return best;
}

// ---- Key-free resolution: iTunes / Deezer search -> Odesli (song.link) -> Spotify ID ----
function spotifyIdFromLinks(sourceUrl) {
  // UniTune (the same free service SpotiFLAC uses) first; song.link now wants a key, so it is only a fallback.
  var hosts = [
    { name: "UniTune", url: "https://api.unitune.art/v1-alpha.1/links?url=" },
    { name: "song.link", url: "https://api.song.link/v1-alpha.1/links?url=" }
  ];
  var errors = [];
  for (var i = 0; i < hosts.length; i++) {
    var resp;
    try {
      resp = http.get(hosts[i].url + encodeURIComponent(sourceUrl), { "Accept": "application/json" });
    } catch (e) {
      errors.push(hosts[i].name + " failed: " + String(e));
      continue;
    }
    if (resp.statusCode === 429) { errors.push(hosts[i].name + " rate limit"); continue; }
    if (!resp.ok) { errors.push(hosts[i].name + " HTTP " + resp.statusCode); continue; }
    var data;
    try { data = JSON.parse(resp.body); } catch (e2) { errors.push(hosts[i].name + " sent invalid JSON"); continue; }
    var sp = data.linksByPlatform && data.linksByPlatform.spotify;
    if (sp) {
      var m = /track\/([A-Za-z0-9]{22})/.exec(sp.url || "") || /([A-Za-z0-9]{22})$/.exec(sp.entityUniqueId || "");
      if (m) return { id: m[1] };
    }
    errors.push(hosts[i].name + " has no Spotify link");
  }
  return { error: errors.join(", ") };
}

function durationOk(candidateSec, wantSec) {
  if (!(wantSec > 0) || !(candidateSec > 0)) return true;
  return Math.abs(candidateSec - wantSec) <= 15;
}

function artistMatches(candidateArtist, wanted) {
  var c = normalize(candidateArtist);
  var w = normalize(wanted);
  return !!c && !!w && (w.indexOf(c) !== -1 || c.indexOf(w) !== -1);
}

function titleMatches(candidateTitle, wanted) {
  var c = normalize(candidateTitle);
  var w = normalize(wanted);
  return !!c && !!w && (c === w || c.indexOf(w) !== -1 || w.indexOf(c) !== -1);
}

function resolveViaItunes(track, artist, durationSec) {
  var firstArtist = artist.split(/[,&;]/)[0].trim();
  var resp = http.get("https://itunes.apple.com/search?media=music&entity=song&limit=15&term=" +
    encodeURIComponent(track + " " + firstArtist), {});
  if (!resp.ok) return { error: "iTunes HTTP " + resp.statusCode };
  var results = JSON.parse(resp.body).results || [];
  var matched = 0;
  var linkError = "";
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!titleMatches(r.trackName, track) || !artistMatches(r.artistName, artist)) continue;
    if (!durationOk((r.trackTimeMillis || 0) / 1000, durationSec)) continue;
    if (!r.trackViewUrl) continue;
    matched++;
    var out;
    try { out = spotifyIdFromLinks(r.trackViewUrl); }
    catch (e) { out = { error: "song.link failed: " + String(e) }; }
    if (out.id || /rate limit/.test(out.error || "")) return out;
    linkError = out.error;
    if (matched >= 3) break; // do not spend the rate limit on more
  }
  if (matched) return { error: "iTunes matched " + matched + " but " + linkError };
  var first = results[0] ? ' first: "' + results[0].trackName + '" by "' + results[0].artistName + '" ' + Math.round((results[0].trackTimeMillis || 0) / 1000) + "s" : "";
  return { error: "No iTunes match (" + results.length + " results;" + first + ")" };
}

function resolveViaDeezer(track, artist, durationSec) {
  var firstArtist = artist.split(/[,&;]/)[0].trim();
  var resp = http.get("https://api.deezer.com/search?limit=15&q=" +
    encodeURIComponent('track:"' + track.replace(/"/g, "") + '" artist:"' + firstArtist.replace(/"/g, "") + '"'), {});
  if (!resp.ok) return { error: "Deezer HTTP " + resp.statusCode };
  var results = JSON.parse(resp.body).data || [];
  var matched = 0;
  var linkError = "";
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!titleMatches(r.title, track) || !artistMatches(r.artist && r.artist.name, artist)) continue;
    if (!durationOk(r.duration, durationSec)) continue;
    matched++;
    var out;
    try { out = spotifyIdFromLinks("https://www.deezer.com/track/" + r.id); }
    catch (e) { out = { error: "song.link failed: " + String(e) }; }
    if (out.id || /rate limit/.test(out.error || "")) return out;
    linkError = out.error;
    if (matched >= 3) break;
  }
  if (matched) return { error: "Deezer matched " + matched + " but " + linkError };
  var firstD = results[0] ? ' first: "' + results[0].title + '" by "' + (results[0].artist && results[0].artist.name) + '" ' + results[0].duration + "s" : "";
  return { error: "No Deezer match (" + results.length + " results;" + firstD + ")" };
}

// ---- Spotify app lookup via the local helper (spotify-bridge.mjs) ----
// Where the helper is. Empty "Helper address" = this PC (127.0.0.1). Otherwise a name or IP, with or without :port or http(s)://,
// for a helper that runs on another machine that stays on (server mode, with a token).
function bridgeBase() {
  var port = parseInt(settings.bridgePort, 10);
  if (!port || port < 1 || port > 65535) port = 8089;
  var host = str("bridgeHost").replace(/\s+/g, "");
  if (!host) return "http://127.0.0.1:" + port;
  if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, "");
  host = host.replace(/\/+$/, "");
  return "http://" + host + (/:\d+$/.test(host) ? "" : ":" + port);
}

// Headers for every call to the helper: the token (server mode) goes in X-Bridge-Token.
function bridgeHeaders() {
  var h = { "Accept": "application/json" };
  var token = str("bridgeToken");
  if (token) h["X-Bridge-Token"] = token;
  return h;
}

function resolveViaBridge(track, artist, durationSec) {
  var url = bridgeBase() + "/search?track=" + encodeURIComponent(track) +
    "&artist=" + encodeURIComponent(artist) +
    (durationSec > 0 ? "&duration=" + Math.round(durationSec) : "");
  var resp;
  try {
    resp = http.get(url, bridgeHeaders());
  } catch (e) {
    return { error: "helper not reachable (" + String(e).slice(0, 120) + ")" };
  }
  if (resp.error || resp.statusCode === undefined) return { error: "helper not reachable at " + bridgeBase() + " (" + String(resp.error || "no answer").slice(0, 160) + ")" };
  if (resp.statusCode === 401) return { error: "the helper refused the token (check Helper token)" };
  if (resp.statusCode === 429) return { error: "Spotify is rate-limiting searches (the helper is waiting it out)" };
  if (resp.statusCode === 404) {
    var why = "";
    try { why = JSON.parse(resp.body).detail || ""; } catch (e0) {}
    return { error: "Spotify app found no match" + (why ? " (" + why.slice(0, 500) + ")" : "") };
  }
  if (!resp.ok) {
    var detail = "";
    try { detail = JSON.parse(resp.body).error || ""; } catch (e2) {}
    return { error: "helper HTTP " + resp.statusCode + (detail ? " " + String(detail).slice(0, 500) : "") };
  }
  var data;
  try { data = JSON.parse(resp.body); } catch (e3) { return { error: "helper sent invalid JSON" }; }
  if (data && /^[A-Za-z0-9]{22}$/.test(data.id || "")) return { id: data.id };
  return { error: "helper returned no track ID" };
}

function bridgeHealth() {
  try {
    var resp = http.get(bridgeBase() + "/health", bridgeHeaders());
    if (resp.error || resp.statusCode === undefined) return { ok: false, text: "helper not reachable at " + bridgeBase() + " (" + String(resp.error || "no answer").slice(0, 160) + ")" };
    if (resp.statusCode === 401) return { ok: false, text: "helper refused the token (check Helper token)" };
    if (!resp.ok) return { ok: false, text: "helper HTTP " + resp.statusCode };
    var d = JSON.parse(resp.body);
    var extra = d.sources && d.sources.length ? "; Genius/YouTube Music " + (d.sources.indexOf("genius") !== -1 ? "available" : "missing") : "; old helper, update to lyrics-bridge 2.0 for Genius/YouTube Music";
    return { ok: !!d.spotify, text: (d.spotify ? "helper OK, Spotify app connected" : "helper OK at " + bridgeBase() + ", Spotify app not connected there (only the Spotify lookup needs it)") + extra };
  } catch (e) {
    return { ok: false, text: "helper not reachable (" + String(e).slice(0, 120) + ")" };
  }
}

// ---- No-account lookup: ListenBrainz "Spotify id from metadata" (the lyric viewer uses it too) ----
function resolveViaListenBrainz(track, artist) {
  var firstArtist = artist.split(/[,&;]/)[0].trim();
  var titles = [track];
  var bare = track.replace(/\s*[(\[].*?[)\]]/g, "").trim();
  if (bare && bare !== track) titles.push(bare);
  var errors = [];
  for (var t = 0; t < titles.length; t++) {
    // We are not told the album, so try the title standing in for a single's album, then none.
    var albums = [titles[t], ""];
    for (var a = 0; a < albums.length; a++) {
      var url = "https://labs.api.listenbrainz.org/spotify-id-from-metadata/json?artist_name=" + encodeURIComponent(firstArtist) +
        "&release_name=" + encodeURIComponent(albums[a]) + "&track_name=" + encodeURIComponent(titles[t]);
      try {
        var resp = http.get(url, { "Accept": "application/json" });
        if (!resp.ok) { errors.push("HTTP " + resp.statusCode); continue; }
        var data = JSON.parse(resp.body);
        var ids = Array.isArray(data) && data[0] ? data[0].spotify_track_ids : null;
        if (Array.isArray(ids)) {
          for (var i = 0; i < ids.length; i++) if (/^[A-Za-z0-9]{22}$/.test(ids[i])) return { id: ids[i] };
        }
      } catch (err) { errors.push(String(err).slice(0, 80)); }
    }
  }
  return { error: "ListenBrainz had no match" + (errors.length ? " (" + errors[0] + ")" : "") };
}

function resolveSpotifyId(track, artist, durationSec) {
  var cacheKey = "id:" + normalize(track) + "|" + normalize(artist) + "|" + Math.round((durationSec || 0) / 5);
  var cached = storage.get(cacheKey);
  if (cached) { record("id cached " + cached); return { id: cached }; }

  var errors = [];
  var found = null;

  // 1) The running Spotify app, through the local helper (no keys, exact Spotify matching).
  if (on("useSpotifyApp", true)) {
    found = resolveViaBridge(track, artist, durationSec);
    if (found.id) {
      record("id from Spotify app " + found.id);
      storage.set(cacheKey, found.id);
      return found;
    }
    record("Spotify app lookup: " + found.error);
    errors.push(found.error);
    found = null;
  }

  if (settings.spotifyClientId && settings.spotifyClientSecret) {
    found = findSpotifyId(track, artist, durationSec);
    if (found.error) errors.push(found.error);
  }
  if (!found || !found.id) {
    var steps = [resolveViaListenBrainz, resolveViaItunes, resolveViaDeezer];
    for (var i = 0; i < steps.length; i++) {
      try { found = steps[i](track, artist, durationSec); } catch (e) { found = { error: String(e) }; }
      if (found.id) break;
      errors.push(found.error);
      if (/rate limit/.test(found.error || "")) break;
    }
  }
  if (found && found.id) {
    record("id " + found.id);
    storage.set(cacheKey, found.id);
    return found;
  }
  record("id lookup failed: " + (errors.join("; ") || "No match"));
  return { error: errors.join("; ") || "No match" };
}

// Returns { id } or { error }.
function findSpotifyId(track, artist, durationSec) {
  var token = getSpotifyToken();
  if (!token) return { error: "Could not get a Spotify token (check Client ID / Secret)" };

  var firstArtist = artist.split(/[,&;]/)[0].trim();
  var queries = [
    'track:"' + track.replace(/"/g, "") + '" artist:"' + firstArtist.replace(/"/g, "") + '"',
    track + " " + firstArtist
  ];
  var lastError = null;
  for (var i = 0; i < queries.length; i++) {
    var res = searchSpotify(token, queries[i]);
    if (res.error) { lastError = res.error; if (/401/.test(res.error)) break; continue; }
    var hit = pickMatch(res.items, track, artist, durationSec);
    if (hit) return { id: hit.id };
  }
  return { error: lastError || "No matching Spotify track" };
}

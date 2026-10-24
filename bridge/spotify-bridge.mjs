// Spotify bridge for the "Spicy Lyrics (Desktop)" Mornye extension. (v1.5)
//
// Mornye extensions can only make plain HTTP requests, but Spotify's debug port needs a WebSocket.
// This small helper sits in between: the extension asks it (http://127.0.0.1:8089) to search for a
// track, and it asks your running Spotify app (via the debug port Spicetify opens) to do the search
// with Spotify's own login. No keys, nothing is sent anywhere except to Spotify itself.
//
// Needs Node.js 22 or newer (it has WebSocket built in). No packages to install.
//   node spotify-bridge.mjs
//   node spotify-bridge.mjs --cdp 8088 --port 8089
//
// Safety: it only listens on 127.0.0.1, answers only GET /health and GET /search, and refuses any
// request that carries an Origin header (so web pages in your browser can't use it).

import http from "node:http";

const arg = (name, fallback) => {
  const i = process.argv.indexOf("--" + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", process.env.BRIDGE_PORT || 8089));
const CDP_PORTS = [arg("cdp", process.env.SPOTIFY_DEBUG_PORT || 8088), 9222]
  .map(Number)
  .filter((p, i, a) => p > 0 && a.indexOf(p) === i);

if (typeof WebSocket === "undefined") {
  console.error("This helper needs Node.js 22 or newer (found " + process.version + "). Get it from https://nodejs.org");
  process.exit(1);
}

// ---------- talking to Spotify through the debug port ----------
async function findPage() {
  const problems = [];
  for (const port of CDP_PORTS) {
    for (const host of ["127.0.0.1", "localhost"]) {
      try {
        const res = await fetch(`http://${host}:${port}/json`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) {
          problems.push(`${host}:${port} answered HTTP ${res.status}`);
          continue;
        }
        const targets = await res.json();
        const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
        const page = pages.find((t) => /xpui/i.test(t.url ?? "")) || pages.find((t) => /spotify/i.test(`${t.title} ${t.url}`));
        if (page) return page.webSocketDebuggerUrl.replace(/^ws:\/\/localhost/i, "ws://127.0.0.1");
        problems.push(`${host}:${port} is open but shows no Spotify page (pages: ${pages.map((t) => t.url).join(", ") || "none"})`);
      } catch (e) {
        const why = e?.name === "TimeoutError" ? "timed out" : e?.cause?.code || e?.cause?.message || e?.message || "failed";
        problems.push(`${host}:${port} ${why}`);
      }
    }
  }
  throw new Error(problems.join("; ") + ". Spotify must be started with --remote-debugging-port=8088 (see README).");
}

async function evaluate(expression, timeoutMs = 9000) {
  const url = await findPage();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => finish(new Error("Spotify did not answer in time")), timeoutMs);
    const finish = (err, value) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      err ? reject(err) : resolve(value);
    };
    ws.onerror = () => finish(new Error("could not open the Spotify debug connection"));
    ws.onopen = () =>
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id !== 1) return;
      if (msg.result?.exceptionDetails) {
        const text = msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text || "error in Spotify";
        return finish(new Error(String(text).split("\n")[0]));
      }
      finish(null, msg.result?.result?.value);
    };
  });
}

// ---------- matching (same rules as the extension) ----------
function normalize(s) {
  let t = String(s || "").toLowerCase();
  t = t.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  const dash = t.indexOf(" - ");
  if (dash !== -1) t = t.slice(0, dash);
  let out = "";
  for (const c of t) {
    const code = c.codePointAt(0);
    if (c === "'" || c === "’" || c === "‘") continue;
    if ([0x2013, 0x2014, 0x2010, 0x2011].includes(code)) out += " ";
    else if ((code >= 48 && code <= 57) || (code >= 97 && code <= 122) || code > 127) out += c;
    else out += " ";
  }
  return out.split(" ").filter(Boolean).join(" ");
}

function pickMatch(items, track, artist, durationSec) {
  const wantTitle = normalize(track);
  const wantArtist = normalize(artist);
  let best = null;
  let bestScore = -1;
  for (const it of items) {
    if (!it?.id || !it.artists) continue;
    let score = 0;
    const name = normalize(it.name);
    if (name === wantTitle) score += 3;
    else if (wantTitle && name && (name.includes(wantTitle) || wantTitle.includes(name))) score += 1;
    else continue;
    const artistHit = it.artists.some((a) => {
      const n = normalize(a.name);
      return n && (wantArtist.includes(n) || n.includes(wantArtist));
    });
    if (!artistHit) continue;
    score += 2;
    if (durationSec > 0 && it.duration_ms > 0) { // some Spotify answers carry no length: then it can't count either way
      const diff = Math.abs(it.duration_ms / 1000 - durationSec);
      if (diff <= 2) score += 3;
      else if (diff <= 5) score += 1;
      else if (diff > 15) continue; // a different recording
    }
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return best;
}

// Spotify's own search (the one behind the desktop search box). No Web API token, no rate limit.
async function gqlSearch(term) {
  const expression = `(async () => {
    const gql = Spicetify && Spicetify.GraphQL;
    const query = gql && gql.Definitions && gql.Definitions.searchModalResults;
    if (!gql || !gql.Request || !query) throw new Error("Spotify GraphQL search is not available (run: spicetify apply)");
    const response = await gql.Request(query, {
      searchTerm: ${JSON.stringify(term)}, offset: 0, limit: 10, numberOfTopResults: 10,
      includeAudiobooks: false, includeArtistHasConcertsField: false, includePreReleases: false,
      includeAuthors: false, includeEpisodeContentRatingsV2: false });
    const found = new Map();
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.__typename === "Track" && typeof node.uri === "string" && node.name) {
        found.set(node.uri, { uri: node.uri, name: node.name,
          artists: ((node.artists && node.artists.items) || []).map((a) => a && a.profile && a.profile.name).filter(Boolean),
          album: node.albumOfTrack && node.albumOfTrack.name });
      }
      Object.values(node).forEach(walk);
    };
    walk(response && response.data);
    return JSON.stringify({ errors: response && response.errors ? JSON.stringify(response.errors).slice(0, 200) : null, tracks: [...found.values()] });
  })()`;
  return JSON.parse(await evaluate(expression));
}

async function gqlDuration(uri) {
  const expression = `(async () => {
    const gql = Spicetify.GraphQL;
    const r = await gql.Request(gql.Definitions.getTrack, { uri: ${JSON.stringify(uri)} });
    return JSON.stringify(r && r.data && r.data.trackUnion && r.data.trackUnion.duration ? r.data.trackUnion.duration.totalMilliseconds : 0);
  })()`;
  return Number(JSON.parse(await evaluate(expression))) || 0;
}

function scoreCandidate(c, track, artist) {
  const wantTitle = normalize(track);
  const wantArtist = normalize(artist);
  const name = normalize(c.name);
  let score = 0;
  if (name === wantTitle) score += 3;
  else if (wantTitle && name && (name.includes(wantTitle) || wantTitle.includes(name))) score += 1;
  else return -1;
  const artistHit = (c.artists || []).some((a) => {
    const n = normalize(a);
    return n && (wantArtist.includes(n) || n.includes(wantArtist));
  });
  return artistHit ? score + 2 : -1;
}

async function searchViaGraphQL(track, artist, durationSec, seen) {
  const firstArtist = artist.split(/[,&;]/)[0].trim();
  const tried = new Set();
  for (const term of [`${firstArtist} ${track}`, track]) {
    if (tried.has(term.toLowerCase())) continue;
    tried.add(term.toLowerCase());
    const reply = await gqlSearch(term);
    const tracks = reply.tracks || [];
    seen.push(`graphql "${term}": ${tracks.length} track(s)` + (tracks.length ? " e.g. " + tracks.slice(0, 3).map((t) => `"${t.name}" by ${t.artists.join("/")}`).join(", ") : "") + (reply.errors ? ` errors: ${reply.errors}` : ""));
    const ranked = tracks
      .map((c) => ({ c, score: scoreCandidate(c, track, artist) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    let best = null;
    for (const { c, score } of ranked) {
      const id = c.uri.split(":")[2];
      if (!id) continue;
      if (!(durationSec > 0)) return { id, name: c.name, artists: c.artists };
      let diff = Infinity;
      try {
        diff = Math.abs((await gqlDuration(c.uri)) / 1000 - durationSec);
      } catch {}
      if (diff > 15) continue; // a different recording
      const total = score * 100 - diff; // exact title/artist first, then closest length
      if (!best || total > best.total) best = { total, id, name: c.name, artists: c.artists };
    }
    if (best) return { id: best.id, name: best.name, artists: best.artists };
  }
  return null;
}

// Last resort: Spotify's Web API through the app (can be rate limited, which is why it isn't first).
async function searchViaWebApi(track, artist, durationSec, seen) {
  const firstArtist = artist.split(/[,&;]/)[0].trim();
  const queries = [`track:"${track.replace(/"/g, "")}" artist:"${firstArtist.replace(/"/g, "")}"`, `${track} ${firstArtist}`];
  for (const q of queries) {
    const reply = await spotifyGet("https://api.spotify.com/v1/search?type=track&limit=10&q=" + encodeURIComponent(q));
    const items = reply.data?.tracks?.items ?? [];
    seen.push(`web api (${reply.via}): ${items.length} result(s)`);
    const match = pickMatch(items, track, artist, durationSec);
    if (match) return { id: match.id, name: match.name, artists: match.artists.map((a) => a.name) };
  }
  return null;
}

const cache = new Map(); // key -> { at, result }

// Runs inside the Spotify app. Tries several ways to search, stops at the first that yields a match:
//   1. Spotify's own internal search (Spicetify GraphQL), 2. the Web API with the app's token
//   (read the way Spicetify apps do), 3. Spicetify's CosmosAsync. Matching code is copied in so the
//   page does the choosing and only a tiny result comes back.
function pageExpression(track, artist, durationSec, firstArtist, skipWeb) {
  return `(async () => {
    ${normalize.toString()}
    ${pickMatch.toString()}
    const track = ${JSON.stringify(track)}, artist = ${JSON.stringify(artist)}, dur = ${Number(durationSec) || 0};
    const first = ${JSON.stringify(firstArtist)};
    const filtered = 'track:"' + track.replace(/"/g, "") + '" artist:"' + first.replace(/"/g, "") + '"';
    const plain = track + " " + first;
    const notes = [];
    const short = (v) => String(v && (v.message || v.body || v.status) || v).slice(0, 140);
    const describe = (items) => items.length + " result(s)" + (items.length ? " e.g. " + items.slice(0, 3).map((i) => '"' + i.name + '" by ' + (i.artists || []).map((a) => a.name).join("/")).join(", ") : "");

    const getToken = async () => {
      try { const t = Spicetify.Platform?.AuthorizationAPI?.getState?.()?.token?.accessToken; if (t) return t; } catch (e) {}
      try { const r = await Spicetify.CosmosAsync.get("sp://oauth/v2/token"); if (r?.accessToken) return r.accessToken; } catch (e) {}
      return Spicetify.Platform?.Session?.accessToken;
    };
    const webItems = (data) => data?.tracks?.items ?? [];
    const gqlItems = (r) => {
      const d = r?.data || r;
      const arr = [].concat(d?.searchV2?.topResultsV2?.itemsV2 || [], d?.searchV2?.tracksV2?.items || []);
      return arr.map((x) => x?.item?.data ?? x?.item ?? x)
        .filter((t) => t && typeof t.uri === "string" && /^spotify:track:/.test(t.uri))
        .map((t) => ({
          id: String(t.uri).split(":")[2], name: String(t.name ?? ""),
          artists: (t.artists?.items || []).map((a) => ({ name: String(a?.profile?.name ?? a?.name ?? "") })),
          duration_ms: Number(t.duration?.totalMilliseconds ?? 0) }));
    };
    const webGet = async (q) => {
      const token = await getToken();
      if (!token) throw new Error("no access token in Spotify");
      const r = await fetch("https://api.spotify.com/v1/search?type=track&limit=10&q=" + encodeURIComponent(q), { headers: {
        Accept: "application/json", Authorization: "Bearer " + token,
        "Spotify-App-Version": String(Spicetify.Platform?.version || ""), "App-Platform": String(Spicetify.Platform?.PlatformData?.app_platform || "") } });
      if (!r.ok) throw new Error("HTTP " + r.status + (r.status === 429 ? " (rate limited, retry after " + (r.headers.get("retry-after") || "?") + "s)" : ""));
      return webItems(await r.json());
    };
    const cosmosGet = async (q) => {
      const r = await Spicetify.CosmosAsync.get("https://api.spotify.com/v1/search?type=track&limit=10&q=" + encodeURIComponent(q));
      if (!r || !r.tracks) throw new Error("gave " + JSON.stringify(r).slice(0, 100));
      return webItems(r);
    };
    const gqlGet = async () => {
      const G = Spicetify.GraphQL;
      const defs = G?.Definitions || {};
      // searchModalResults is what Spotify's own search box uses (and what the lyric viewer uses).
      const tries = [
        ["searchModalResults", { searchTerm: plain, offset: 0, limit: 8, numberOfTopResults: 8, includeAudiobooks: false, includeArtistHasConcertsField: false, includePreReleases: false, includeAuthors: false }],
        ["searchTracks", { searchTerm: plain, offset: 0, limit: 10, numberOfTopResults: 5, includeAudiobooks: false, includePreReleases: false }],
        ["searchDesktop", { searchTerm: plain, offset: 0, limit: 10, numberOfTopResults: 5, includeAudiobooks: false, includePreReleases: false, includeArtistHasConcertsField: false, includeLocalConcertsField: false }],
      ].filter(([n]) => defs[n]);
      if (!G?.Request || !tries.length) throw new Error("GraphQL search not available (search-like definitions: " + (Object.keys(defs).filter((k) => /search/i.test(k)).join(",") || "none") + ")");
      let last;
      for (const [n, vars] of tries) {
        try {
          const items = gqlItems(await G.Request(defs[n], vars));
          if (items.length) return items;
          last = n + " returned no tracks";
        } catch (e) { last = n + ": " + short(e); }
      }
      throw new Error(last || "no result");
    };

    // Cheapest and most reliable first; each stops as soon as a query matches (fewer requests, fewer 429s).
    const strategies = [
      ["internal-search", [plain], gqlGet],
      ["web-api", [filtered, plain], webGet],
      ["cosmos", [filtered, plain], cosmosGet],
    ];

    for (const [name, queries, get] of strategies) {
      if (${skipWeb ? "true" : "false"} && name !== "internal-search") continue; // Spotify's rate limit is on: don't add to it
      try {
        const seen = [];
        for (const q of queries) {
          const items = await get(q);
          const m = pickMatch(items, track, artist, dur);
          if (m) return JSON.stringify({ via: name, match: { id: m.id, name: m.name, artists: m.artists.map((x) => x.name) }, notes });
          seen.push(describe(items));
        }
        notes.push(name + ": " + seen.join(" | ") + " - no match");
      } catch (e) {
        notes.push(name + " failed: " + short(e));
        if (/HTTP 429/.test(short(e))) break; // rate limited: don't pile more requests on
      }
    }
    return JSON.stringify({ via: null, match: null, notes });
  })()`;
}

let cooldownUntil = 0; // Spotify said "too many requests": stay quiet until then
let queue = Promise.resolve(); // one search at a time, a little apart
let lastRun = 0;

function limited(seconds) {
  const e = new Error(`Spotify is rate-limiting searches right now; try again in ${seconds}s`);
  e.status = 429;
  e.retryAfter = seconds;
  return e;
}

function search(track, artist, durationSec) {
  const key = `${normalize(track)}|${normalize(artist)}|${Math.round(durationSec / 5)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.result.none ? Promise.resolve(hit.result) : Promise.resolve(hit.result);

  const run = async () => {
    const skipWeb = cooldownUntil > Date.now(); // the internal search is not affected by the Web API's limit
    const gap = 800 - (Date.now() - lastRun);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    lastRun = Date.now();

    const firstArtist = artist.split(/[,&;]/)[0].trim();
    const out = JSON.parse(await evaluate(pageExpression(track, artist, durationSec, firstArtist, skipWeb), 20000));
    const text = out.notes.join(" || ");
    if (skipWeb && !out.match && out.notes.every((n) => / failed: /.test(n))) throw limited(Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000)));
    const limit = /HTTP 429 \(rate limited, retry after (\d+|\?)s\)/.exec(text) || (/"code":429/.test(text) ? [null, "?"] : null);
    if (limit && !out.match) {
      const secs = limit[1] === "?" ? 45 : Math.min(Number(limit[1]) + 3, 300);
      cooldownUntil = Date.now() + secs * 1000;
    }
    if (out.match) {
      cache.set(key, { at: Date.now(), ttl: 10 * 60 * 1000, result: out.match });
      console.log(`   (found with: ${out.via})`);
      return out.match;
    }
    if (out.notes.length && out.notes.every((n) => / failed: /.test(n))) {
      if (limit) throw limited(Math.ceil((cooldownUntil - Date.now()) / 1000));
      throw new Error("Spotify search failed: " + text);
    }
    const result = { none: true, detail: text };
    if (!limit) cache.set(key, { at: Date.now(), ttl: 2 * 60 * 1000, result });
    return result;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

// ---------- the local server ----------
const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const hostOk = [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(String(req.headers.host || "").toLowerCase());
  if (!hostOk || req.headers.origin) return send(res, 403, { error: "forbidden" });
  if (req.method !== "GET") return send(res, 405, { error: "GET only" });

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === "/health") {
      try {
        await findPage();
        return send(res, 200, { ok: true, spotify: true });
      } catch (e) {
        return send(res, 200, { ok: true, spotify: false, reason: e.message });
      }
    }
    if (url.pathname === "/search") {
      const track = (url.searchParams.get("track") || "").slice(0, 200);
      const artist = (url.searchParams.get("artist") || "").slice(0, 200);
      const duration = Number(url.searchParams.get("duration")) || 0;
      if (!track || !artist) return send(res, 400, { error: "track and artist are required" });
      const found = await search(track, artist, duration);
      if (found.none) {
        console.log(`${new Date().toLocaleTimeString()}  ${track} - ${artist}  ->  no match. Spotify returned: ${found.detail}`);
        return send(res, 404, { error: "no match", detail: found.detail });
      }
      console.log(`${new Date().toLocaleTimeString()}  ${track} - ${artist}  ->  ${found.id}`);
      return send(res, 200, found);
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    console.log(`${new Date().toLocaleTimeString()}  error: ${e.message}`);
    if (e.status === 429) {
      res.setHeader("Retry-After", String(e.retryAfter || 45));
      return send(res, 429, { error: e.message });
    }
    return send(res, 502, { error: e.message });
  }
});

server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Is the helper already running? (or use --port 8090)` : e.message);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", async () => {
  console.log(`Spotify bridge listening on http://127.0.0.1:${PORT}  (Spotify debug port: ${CDP_PORTS.join(" or ")})`);
  console.log("Leave this window open while downloading. Press Ctrl+C to stop.");
  try {
    await findPage();
    console.log("Spotify check: connected to the Spotify app. Ready.");
  } catch (e) {
    console.log("Spotify check: NOT connected -> " + e.message);
    console.log("(The helper keeps running and retries on every request.)");
  }
});

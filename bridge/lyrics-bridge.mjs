// Lyrics Hub bridge for the "Lyrics Hub" (and "Spicy Lyrics (Desktop)") Mornye extensions. (v2.0)
//
// Mornye extensions can only make plain, header-limited HTTP requests. This small helper, running on
// your PC at http://127.0.0.1:8089, does the things they can't:
//   * Spotify lookup: asks your running Spotify app (through the debug port Spicetify opens, which needs a
//     WebSocket) to search, so Spicy Lyrics gets the exact track ID. No keys.        GET /search
//   * Genius: searches Genius and returns a song's lyrics as plain text.             GET /genius/search, /genius/lyrics
//   * YouTube Music: searches songs and returns their lyrics.                         GET /ytm/search, /ytm/lyrics
// Genius and YouTube Music refuse requests from a phone-style sandbox (no cookies, no browser headers); this
// does what the Lyric Viewer's built-in worker does. Nothing is sent anywhere except to those sites.
//
// Needs Node.js 22 or newer (it has fetch and WebSocket built in). No packages to install.
//   node lyrics-bridge.mjs
//   node lyrics-bridge.mjs --cdp 8088 --port 8089
//
// Safety: it only listens on 127.0.0.1, answers only GET requests for the routes above, and refuses any
// request that carries an Origin header (so web pages in your browser can't use it).

import http from "node:http";
import { pathToFileURL } from "node:url";

const VERSION = "2.0";
const SOURCES = ["genius", "ytm"]; // what this helper can fetch besides the Spotify lookup
const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const arg = (name, fallback) => {
  const i = process.argv.indexOf("--" + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", process.env.BRIDGE_PORT || 8089));
const CDP_PORTS = [arg("cdp", process.env.SPOTIFY_DEBUG_PORT || 8088), 9222]
  .map(Number)
  .filter((p, i, a) => p > 0 && a.indexOf(p) === i);

if (IS_MAIN && typeof WebSocket === "undefined") {
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


// ---------- Genius and YouTube Music (what the Lyric Viewer's worker does) ----------
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const LYRICS_PATH = /^\/[\w\-.~%]{1,200}-lyrics$/;
const VIDEO_ID = /^[\w-]{11}$/;
const MAX_QUERY_LENGTH = 200;
const UPSTREAM_TIMEOUT_MS = 12000;

// Tests swap this for a fake.
export const upstream = { fetch: (...a) => globalThis.fetch(...a) };

const boundedInt = (value, min, max) => {
  if (value === null || !/^\d{1,3}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
};

const decodeEntities = (t) =>
  t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

// -- YouTube Music --
const YTM_API = "https://music.youtube.com/youtubei/v1";
const YTM_CONTEXT = { client: { clientName: "WEB_REMIX", clientVersion: "1.20250310.01.00", hl: "en", gl: "US" } };
const YTM_SONGS_ONLY = "EgWKAQIIAWoKEAMQBBAJEAoQBQ%3D%3D";

async function ytm(path, body) {
  const res = await upstream.fetch(`${YTM_API}/${path}?prettyPrint=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    body: JSON.stringify({ context: YTM_CONTEXT, ...body }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`youtube music responded ${res.status}`);
  return res.json();
}

const clockToMs = (clock) => {
  const parts = clock.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0) * 1000;
};

function collectSongs(node, out) {
  if (!node || typeof node !== "object") return;
  const item = node.musicResponsiveListItemRenderer;
  if (item) {
    const columns = (item.flexColumns ?? []).map((c) =>
      (c.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? []).map((r) => r.text).join("")
    );
    const videoId =
      item.playlistItemData?.videoId ??
      item.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
    // "Artist • Album • 3:24": artists first, the length last.
    const details = (columns[1] ?? "").split("•").map((x) => x.trim());
    if (videoId && columns[0] && details.length >= 2) {
      out.push({
        videoId,
        title: columns[0],
        artists: (details[0] ?? "").split(/\s*(?:&|,)\s*/).filter(Boolean),
        durationMs: clockToMs(details[details.length - 1]),
      });
    }
  }
  for (const value of Object.values(node)) collectSongs(value, out);
}

export async function ytmSearch(q) {
  const songs = [];
  collectSongs(await ytm("search", { query: q, params: YTM_SONGS_ONLY }), songs);
  return { songs: songs.slice(0, 10) };
}

export async function ytmLyrics(videoId) {
  const next = await ytm("next", { videoId });
  const tabs = next?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs ?? [];
  const tab = tabs.map((t) => t.tabRenderer).find((t) => /lyrics/i.test(t?.title ?? ""));
  const browseId = tab && !tab.unselectable ? tab.endpoint?.browseEndpoint?.browseId : undefined;
  if (!browseId) return { text: null };
  const page = await ytm("browse", { browseId });
  const shelf = page?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer;
  const text = (shelf?.description?.runs ?? []).map((r) => r.text).join("").trim();
  const footer = (shelf?.footer?.runs ?? []).map((r) => r.text).join("").replace(/^Source:\s*/i, "").trim();
  return { text: text || null, source: footer || null };
}

// -- Genius --
// Genius answers a first visit with a redirect to the same address that sets a cookie, so redirects are
// followed by hand, carrying the cookies along, and never leave genius.com.
async function geniusGet(target, wantsJson) {
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    Accept: wantsJson ? "application/json" : "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  };
  const cookies = new Map();
  let next = target;
  let res;
  for (let hop = 0; hop < 5; hop++) {
    const sent = { ...headers };
    if (cookies.size) sent.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    res = await upstream.fetch(next, { headers: sent, redirect: "manual", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const where = res.headers.get("Location");
    if (res.status < 300 || res.status >= 400 || !where) break;
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const resolved = new URL(where, next);
    if (resolved.hostname !== "genius.com" && !resolved.hostname.endsWith(".genius.com")) break;
    next = resolved.href;
  }
  if (!res.ok) throw new Error(`genius responded ${res.status}`);
  return res;
}

export async function geniusSearch(q, perPage, page) {
  const target =
    perPage || page
      ? `https://genius.com/api/search/song?per_page=${perPage ?? 5}&page=${page ?? 1}&q=${encodeURIComponent(q)}`
      : `https://genius.com/api/search/multi?per_page=5&q=${encodeURIComponent(q)}`;
  return (await geniusGet(target, true)).json();
}

// Removes every element whose opening tag matches `isTarget`, with everything inside it (balanced on <div>/<span>/<a>).
function removeElements(html, isTarget) {
  let out = "";
  let i = 0;
  const open = /<([a-z][a-z0-9]*)\b[^>]*>/gi;
  while (i < html.length) {
    open.lastIndex = i;
    const m = open.exec(html);
    if (!m) { out += html.slice(i); break; }
    if (!isTarget(m[0])) { out += html.slice(i, m.index + m[0].length); i = m.index + m[0].length; continue; }
    out += html.slice(i, m.index);
    const name = m[1].toLowerCase();
    let depth = 1;
    let j = m.index + m[0].length;
    const tag = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
    tag.lastIndex = j;
    let t;
    while ((t = tag.exec(html)) !== null) {
      depth += t[1] ? -1 : t[0].endsWith("/>") ? 0 : 1;
      j = tag.lastIndex;
      if (depth === 0) break;
    }
    i = j;
  }
  return out;
}

// The text of every data-lyrics-container in a Genius page (or the wrapped embed), without page furniture.
export function extractGeniusText(html) {
  const containers = [];
  const re = /<div\b[^>]*data-lyrics-container="true"[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let depth = 1;
    const tag = /<(\/?)div\b[^>]*>/gi;
    tag.lastIndex = re.lastIndex;
    let t;
    let end = html.length;
    while ((t = tag.exec(html)) !== null) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) { end = t.index; break; }
    }
    containers.push(html.slice(re.lastIndex, end));
    re.lastIndex = end;
  }
  if (!containers.length) return null;

  const parts = containers.map((c) => {
    let inner = removeElements(c, (tag) => /data-exclude-from-selection="true"|class="[^"]*(?:LyricsHeader|InreadContainer)/.test(tag));
    inner = inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
    return decodeEntities(inner);
  });
  const lines = parts
    .join("\n")
    .split(/\r?\n/)
    .map((l) => l.trim())
    // "[Verse 1: Name]" labels, and the promo text Genius drops between lines.
    .filter((l) => l && !/^\[[^\]]*\]$/.test(l) && !/^(you might also like|\d*embed)$/i.test(l));
  return lines.length ? lines.join("\n") : null;
}

export async function geniusLyrics(path, id) {
  // With the song id, the embed script is read first: Genius still serves it where the page itself is refused.
  if (id) {
    try {
      const res = await geniusGet(`https://genius.com/songs/${id}/embed.js`, false);
      const script = await res.text();
      const literal = /JSON\.parse\('((?:[^'\\]|\\.)*)'\)/s.exec(script)?.[1];
      if (literal) {
        const json = literal.replace(/\\(.)/gs, (_, c) => (c === "n" ? "\n" : c === "u" ? "\\u" : c));
        const html = JSON.parse(json);
        const body = /<div class="rg_embed_body">([\s\S]*?)<\/div>\s*(?:<div class="rg_embed_footer"|$)/.exec(html)?.[1] ?? html;
        const text = extractGeniusText(`<div data-lyrics-container="true">${body}</div>`);
        if (text) return { text };
      }
    } catch {
      // Fall through to the page itself.
    }
  }
  const page = await (await geniusGet(`https://genius.com${path}`, false)).text();
  return { text: extractGeniusText(page) };
}

// Answers one /genius/* or /ytm/* request. Returns { status, body } or null when the path is not one of these.
export async function sourceRoute(url) {
  const q = (url.searchParams.get("q") ?? "").trim();
  try {
    switch (url.pathname) {
      case "/ytm/search":
        if (!q || q.length > MAX_QUERY_LENGTH) return { status: 400, body: { error: "bad query" } };
        return { status: 200, body: await ytmSearch(q) };
      case "/ytm/lyrics": {
        const videoId = url.searchParams.get("videoId") ?? "";
        if (!VIDEO_ID.test(videoId)) return { status: 400, body: { error: "bad video id" } };
        return { status: 200, body: await ytmLyrics(videoId) };
      }
      case "/genius/search":
        if (!q || q.length > MAX_QUERY_LENGTH) return { status: 400, body: { error: "bad query" } };
        return {
          status: 200,
          body: await geniusSearch(q, boundedInt(url.searchParams.get("per_page"), 1, 20), boundedInt(url.searchParams.get("page"), 1, 5)),
        };
      case "/genius/lyrics": {
        const path = url.searchParams.get("path") ?? "";
        if (!LYRICS_PATH.test(path)) return { status: 400, body: { error: "bad path" } };
        const idParam = url.searchParams.get("id") ?? "";
        const id = /^\d{1,12}$/.test(idParam) ? idParam : "";
        const out = await geniusLyrics(path, id);
        return out.text ? { status: 200, body: out } : { status: 404, body: { error: "no lyrics on that page" } };
      }
      default:
        return null;
    }
  } catch (e) {
    return { status: 502, body: { error: String(e.message || e).slice(0, 200) } };
  }
}

// ---------- the local server ----------
const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

export const server = http.createServer(async (req, res) => {
  const hostOk = [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(String(req.headers.host || "").toLowerCase());
  if (!hostOk || req.headers.origin) return send(res, 403, { error: "forbidden" });
  if (req.method !== "GET") return send(res, 405, { error: "GET only" });

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === "/health") {
      try {
        await findPage();
        return send(res, 200, { ok: true, spotify: true, version: VERSION, sources: SOURCES });
      } catch (e) {
        return send(res, 200, { ok: true, spotify: false, reason: e.message, version: VERSION, sources: SOURCES });
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
    const routed = await sourceRoute(url);
    if (routed) {
      console.log(`${new Date().toLocaleTimeString()}  ${url.pathname}${url.searchParams.get("q") ? " " + url.searchParams.get("q") : ""}  ->  ${routed.status}`);
      return send(res, routed.status, routed.body);
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

if (IS_MAIN) server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Is the helper already running? (or use --port 8090)` : e.message);
  process.exit(1);
});
if (IS_MAIN) server.listen(PORT, "127.0.0.1", async () => {
  console.log(`Lyrics Hub bridge listening on http://127.0.0.1:${PORT}  (Spotify debug port: ${CDP_PORTS.join(" or ")})`);
  console.log("Leave this window open while downloading. Press Ctrl+C to stop.");
  try {
    await findPage();
    console.log("Spotify check: connected to the Spotify app. Ready.");
  } catch (e) {
    console.log("Spotify check: NOT connected -> " + e.message);
    console.log("(The helper keeps running and retries on every request.)");
  }
});

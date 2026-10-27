import assert from "node:assert/strict";
import http from "node:http";
process.env.BRIDGE_PORT = "18089";
const bridge = await import("../lyrics-bridge.mjs");
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("ok   " + name); } catch (e) { failed++; console.log("FAIL " + name + "\n     " + String(e.stack).split("\n").slice(0, 4).join("\n     ")); } };
const mkres = (status, body, headers = {}, cookies = []) => {
  const h = new Headers(headers);
  const r = { ok: status >= 200 && status < 300, status, headers: Object.assign(h, { getSetCookie: () => cookies }), json: async () => (typeof body === "string" ? JSON.parse(body) : body), text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  return r;
};

const PAGE = `<html><body><div class="Header__x">nav</div>
<div data-lyrics-container="true" class="Lyrics__Container-sc-1"><div class="LyricsHeader__Container-x"><div>6 Contributors</div></div><div data-exclude-from-selection="true"><div>Translations</div></div>[Verse 1: Gaga]<br/>I want your love<br/>And I &amp; you &#39;ll<a href="/x"><span>run</span></a><br/>You might also like<br/>[Chorus]<br/>Oh-oh</div>
<div data-lyrics-container="true">Second part<br>line two</div><div>after</div></body></html>`;

await test("extractGeniusText: labels, header, promo and entities are removed; containers joined", () => {
  assert.equal(bridge.extractGeniusText(PAGE), "I want your love\nAnd I & you 'llrun\nOh-oh\nSecond part\nline two");
});
await test("extractGeniusText: no container gives null", () => assert.equal(bridge.extractGeniusText("<html>nothing</html>"), null));

const YTM_SEARCH = { contents: { x: [{ musicResponsiveListItemRenderer: {
  playlistItemData: { videoId: "abcdefghijk" },
  flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Bad Romance" }] } } }, { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Lady Gaga • The Fame Monster • 4:54" }] } } }] } }] } };

await test("ytm search: songs with artists and duration", async () => {
  bridge.upstream.fetch = async (url) => mkres(200, YTM_SEARCH);
  const out = await bridge.ytmSearch("bad romance");
  assert.deepEqual(out.songs, [{ videoId: "abcdefghijk", title: "Bad Romance", artists: ["Lady Gaga"], durationMs: 294000 }]);
});

await test("ytm lyrics: next -> browse", async () => {
  const calls = [];
  bridge.upstream.fetch = async (url, init) => {
    calls.push(url);
    if (url.includes("/next")) return mkres(200, { contents: { singleColumnMusicWatchNextResultsRenderer: { tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs: [{ tabRenderer: { title: "Up next" } }, { tabRenderer: { title: "Lyrics", endpoint: { browseEndpoint: { browseId: "MPLY1" } } } }] } } } } });
    return mkres(200, { contents: { sectionListRenderer: { contents: [{ musicDescriptionShelfRenderer: { description: { runs: [{ text: "line one\nline two" }] }, footer: { runs: [{ text: "Source: LyricFind" }] } } }] } } });
  };
  assert.deepEqual(await bridge.ytmLyrics("abcdefghijk"), { text: "line one\nline two", source: "LyricFind" });
  assert.equal(calls.length, 2);
});

await test("ytm lyrics: no lyrics tab gives null text", async () => {
  bridge.upstream.fetch = async () => mkres(200, { contents: { singleColumnMusicWatchNextResultsRenderer: { tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs: [{ tabRenderer: { title: "Up next" } }] } } } } });
  assert.deepEqual(await bridge.ytmLyrics("abcdefghijk"), { text: null });
});

await test("genius: redirect with cookie is followed by hand, never leaves genius.com", async () => {
  const seen = [];
  bridge.upstream.fetch = async (url, init) => {
    seen.push({ url, cookie: init.headers.Cookie });
    if (!init.headers.Cookie) return mkres(302, "", { Location: "/Gaga-bad-romance-lyrics" }, ["_genius_ab=1; Path=/"]);
    return mkres(200, PAGE);
  };
  const out = await bridge.geniusLyrics("/Gaga-bad-romance-lyrics", "");
  assert.ok(out.text.startsWith("I want your love"));
  assert.equal(seen[1].cookie, "_genius_ab=1");
  bridge.upstream.fetch = async () => mkres(302, "", { Location: "https://evil.example/x" });
  await assert.rejects(() => bridge.geniusLyrics("/Gaga-bad-romance-lyrics", ""), /responded 302/);
});

await test("genius lyrics: embed script used first when the id is given", async () => {
  const body = "<div class=\"rg_embed_body\">Embed line one<br>Embed line two</div><div class=\"rg_embed_footer\">x</div>";
  const script = "document.write(JSON.parse('" + JSON.stringify(body).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'))";
  const urls = [];
  bridge.upstream.fetch = async (url) => { urls.push(url); return mkres(200, script); };
  const out = await bridge.geniusLyrics("/Gaga-bad-romance-lyrics", "123");
  assert.equal(out.text, "Embed line one\nEmbed line two");
  assert.deepEqual(urls, ["https://genius.com/songs/123/embed.js"]);
});

await test("genius search: multi by default, song search with per_page / page", async () => {
  const urls = [];
  bridge.upstream.fetch = async (url) => { urls.push(url); return mkres(200, { response: { sections: [] } }); };
  await bridge.geniusSearch("bad romance");
  await bridge.geniusSearch("bad romance", 20, 1);
  assert.ok(urls[0].includes("/api/search/multi?per_page=5&q=bad%20romance"));
  assert.ok(urls[1].includes("/api/search/song?per_page=20&page=1&q=bad%20romance"));
});

// The real HTTP server
const get = (path, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: 18089, path, headers: { Host: "127.0.0.1:18089", ...headers } }, (res) => {
    let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode, body: data }));
  });
  req.on("error", reject); req.end();
});
await new Promise((r) => bridge.server.listen(18089, "127.0.0.1", r));

await test("server: routes answer, bad input is 400, unknown is 404, Origin refused", async () => {
  bridge.upstream.fetch = async () => mkres(200, YTM_SEARCH);
  let r = await get("/ytm/search?q=bad%20romance");
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).songs[0].videoId, "abcdefghijk");
  assert.equal((await get("/ytm/search")).status, 400);
  assert.equal((await get("/ytm/lyrics?videoId=bad")).status, 400);
  assert.equal((await get("/genius/lyrics?path=/etc/passwd")).status, 400);
  assert.equal((await get("/nope")).status, 404);
  assert.equal((await get("/ytm/search?q=x", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await get("/ytm/search?q=x", { Host: "evil.example" })).status, 403);
});

await test("server: upstream failure is a 502, missing lyrics a 404, health lists sources", async () => {
  bridge.upstream.fetch = async () => mkres(503, "");
  assert.equal((await get("/ytm/search?q=x")).status, 502);
  bridge.upstream.fetch = async () => mkres(200, "<html>no lyrics</html>");
  assert.equal((await get("/genius/lyrics?path=/A-b-lyrics")).status, 404);
  const h = JSON.parse((await get("/health")).body);
  assert.equal(h.version, "2.2");
  assert.deepEqual(h.sources, ["genius", "ytm"]);
});

bridge.server.close();

// ---- server mode ----
{
  const { spawn } = await import("node:child_process");
  const run = (args, env = {}) => new Promise((resolve) => {
    const p = spawn("node", ["lyrics-bridge.mjs", ...args], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, ...env } });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    resolve({ p, out: () => out });
  });
  const req = (port, headers = {}, path = "/health") => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => resolve({ status: r.statusCode, body: b })); }).on("error", reject);
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await test("server mode refuses to start without a good token", async () => {
    const { p, out } = await run(["--host", "0.0.0.0", "--port", "18091"]);
    await wait(600);
    assert.ok(/needs a token/.test(out()), out());
    p.kill();
  });
  await test("server mode: token required, any Host accepted, Origin refused, repeated misses are throttled", async () => {
    const TOKEN = "t".repeat(20);
    const { p } = await run(["--host", "127.0.0.1", "--port", "18092", "--token", TOKEN]);
    await wait(700);
    assert.equal((await req(18092)).status, 401);
    assert.equal((await req(18092, { "x-bridge-token": "wrong" })).status, 401);
    const ok = await req(18092, { "x-bridge-token": TOKEN, host: "192.168.1.50:18092" });
    assert.equal(ok.status, 200);
    assert.ok(JSON.parse(ok.body).sources.includes("genius"));
    assert.equal((await req(18092, { "x-bridge-token": TOKEN, origin: "http://evil.example" })).status, 403);
    for (let i = 0; i < 10; i++) await req(18092, { "x-bridge-token": "bad" + i });
    assert.equal((await req(18092, { "x-bridge-token": TOKEN })).status, 429);
    p.kill();
  });
  await test("default mode is unchanged: localhost only, no token", async () => {
    const { p } = await run(["--port", "18093"]);
    await wait(700);
    assert.equal((await req(18093, { host: "127.0.0.1:18093" })).status, 200);
    assert.equal((await req(18093, { host: "evil.example:18093" })).status, 403);
    p.kill();
  });
  await test("--init writes a private .env once, keeps it on a second run, and the server then starts from it", async () => {
    const { mkdtempSync, copyFileSync, readFileSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(tmpdir() + "/bridge-init-");
    copyFileSync(new URL("../lyrics-bridge.mjs", import.meta.url), dir + "/lyrics-bridge.mjs");
    const a = spawnSync(process.execPath, [dir + "/lyrics-bridge.mjs", "--init"], { encoding: "utf8" });
    assert.ok(/Created \.env/.test(a.stdout), a.stdout + a.stderr);
    const env1 = readFileSync(dir + "/.env", "utf8");
    assert.ok(/BRIDGE_HOST=0\.0\.0\.0/.test(env1) && /BRIDGE_TOKEN=[A-Za-z0-9_-]{30,}/.test(env1), env1);
    const token = /BRIDGE_TOKEN=(\S+)/.exec(env1)[1];
    assert.ok(a.stdout.includes(token), "token printed for Mornye");
    const b = spawnSync(process.execPath, [dir + "/lyrics-bridge.mjs", "--init"], { encoding: "utf8" });
    assert.ok(/existing \.env/.test(b.stdout));
    assert.equal(readFileSync(dir + "/.env", "utf8"), env1, "token kept");
  });
  await test("--make-token prints a long random token", async () => {
    const { out } = await run(["--make-token"]);
    await wait(500);
    assert.ok(/^[A-Za-z0-9_-]{30,}\s*$/.test(out()), out());
  });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

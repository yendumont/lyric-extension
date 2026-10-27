import { test, assert, load, zlib } from "./t.mjs";

const h = load({});
const run = (code) => h.run(code);
const inCtx = (name, value) => { h.ctx[name] = value; };

test("zlibInflate matches node zlib (dynamic, fixed, stored, long)", () => {
  const samples = [
    Buffer.from("hello hello hello hello world"),
    Buffer.from("[0,3000]<0,500,0>Hel<500,500,0>lo \n".repeat(300)),
    Buffer.alloc(0),
    Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 251)),
    Buffer.from("日本語の歌詞です。".repeat(50)),
  ];
  for (const [i, s] of samples.entries()) {
    for (const opts of [{}, { level: 0 }, { strategy: zlib.constants.Z_FIXED }]) {
      const z = zlib.deflateSync(s, opts);
      inCtx("__z", Array.from(z));
      const out = run("zlibInflate(__z)");
      assert.ok(out, `sample ${i} ${JSON.stringify(opts)} returned null`);
      assert.deepEqual(Buffer.from(out), s, `sample ${i} ${JSON.stringify(opts)}`);
    }
  }
});

test("zlibInflate gives null on garbage", () => {
  inCtx("__z", [120, 156, 255, 255, 255, 255]);
  assert.equal(run("zlibInflate(__z)"), null);
});

test("base64 / utf-8 helpers round-trip", () => {
  const s = "Héllo 日本語 🎵 ok";
  inCtx("__s", s);
  assert.equal(run("bytesToB64(utf8bytes(__s))"), Buffer.from(s).toString("base64"));
  assert.equal(run("utf8string(b64bytes(bytesToB64(utf8bytes(__s))))"), s);
});

test("KRC: decodeKrc undoes xor+zlib and parseKrc builds word tags", () => {
  const KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
  const krc = "[language:e30=]\n[1000,2000]<0,500,0>Hel<500,500,0>lo <1000,800,0>world\n[4000,1000]<0,400,0>Bye\n";
  const body = zlib.deflateSync(Buffer.from(krc));
  const xored = Buffer.from(body.map((b, i) => b ^ KEY[i % KEY.length]));
  const b64 = Buffer.concat([Buffer.from("krc1"), xored]).toString("base64");
  inCtx("__b", b64);
  assert.equal(run("decodeKrc(__b)"), krc);
  inCtx("__t", krc);
  const lines = JSON.parse(run("JSON.stringify(parseKrc(__t))"));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].startTimeMs, 1000);
  assert.equal(lines[0].words, "<00:01.000>Hel<00:01.500><00:01.500>lo <00:02.000><00:02.000>world<00:02.800>");
  assert.equal(lines[1].startTimeMs, 4000);
});

test("YRC: word marks become word tags, credit lines are dropped", () => {
  const yrc = '{"t":0,"c":[{"tx":"作词: x"}]}\n[1000,2000](1000,500,0)Hel(1500,500,0)lo (2000,800,0)world\n[5000,500](5000,400,0)Bye\n[6000,500](6000,400,0)Lyrics by: someone';
  inCtx("__t", yrc);
  const lines = JSON.parse(run("JSON.stringify(parseYrc(__t))"));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].words, "<00:01.000>Hel<00:01.500><00:01.500>lo <00:02.000><00:02.000>world<00:02.800>");
});

test("Musixmatch richsync: offsets are seconds from the line", () => {
  const rich = [{ ts: 1.0, te: 3.0, l: [{ c: "Hel", o: 0 }, { c: "lo ", o: 0.5 }, { c: "world", o: 1.0 }] }];
  inCtx("__r", JSON.stringify(rich));
  const lines = JSON.parse(run("JSON.stringify(parseRichsync(JSON.parse(__r)))"));
  assert.equal(lines[0].startTimeMs, 1000);
  assert.equal(lines[0].endTimeMs, 3000);
  assert.equal(lines[0].words, "<00:01.000>Hel<00:01.500><00:01.500>lo <00:02.000><00:02.000>world<00:03.000>");
});

test("LRCMux words: punctuation joins its word; overlaps fixed", () => {
  const mux = [{ text: "Hello , world !", start: 1000, end: 3000, words: [
    { text: "Hello ", start: 1000, end: 1400 }, { text: ",", start: 1400, end: 1450 },
    { text: "world ", start: 1500, end: 2900 }, { text: "!", start: 2900, end: 3000 } ] }];
  inCtx("__m", JSON.stringify(mux));
  const lines = JSON.parse(run("JSON.stringify(muxWordLines(JSON.parse(__m)))"));
  assert.equal(lines.length, 1);
  inCtx("__w", lines[0].words);
  assert.equal(run("plainFromWords(__w)"), "Hello, world!");
});

test("parseLRC keeps enhanced word tags, bg rows and credit filtering", () => {
  const lrc = "[ti:x]\n[00:01.00]v1:<00:01.00>Hi <00:01.50>you<00:02.00>\n[bg:<00:01.50>ooh<00:01.90>]\n[00:03.00]Lyrics by: someone\n[00:04.00]plain line";
  inCtx("__l", lrc);
  const lines = JSON.parse(run("JSON.stringify(parseLRC(__l))"));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].words.startsWith("v1:<00:01.00>Hi"));
  assert.ok(lines[0].words.includes("\n[bg:"));
  assert.equal(lines[1].words, "plain line");
});

test("rankCandidates: wrong version, duration and artist rules", () => {
  inCtx("__t", { name: "Bad Romance", artist: "Lady Gaga", durationMs: 294000 });
  inCtx("__c", [
    { title: "Bad Romance (Live)", artists: ["Lady Gaga"], durationMs: 294000, id: "live" },
    { title: "Bad Romance - Remastered", artists: ["Lady Gaga"], durationMs: 294500, id: "ok" },
    { title: "Bad Romance", artists: ["Someone Else"], durationMs: 300500, id: "far" },
    { title: "Bad Romance", artists: ["Other"], durationMs: 294400, id: "close-length" },
  ]);
  const ids = JSON.parse(run("JSON.stringify(rankCandidates(__t, __c).map(function(c){return c.id}))"));
  assert.deepEqual(ids, ["ok", "close-length"]);
  const strict = JSON.parse(run("JSON.stringify(rankCandidates(__t, __c, {exactTitle:true, closeDurationMs:300}).map(function(c){return c.id}))"));
  assert.deepEqual(strict, ["ok"]);
});

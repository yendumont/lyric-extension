import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = (process.env.HUB_STRICT ? "\"use strict\";\n" : "") + fs.readFileSync(path.join(here, "../index.js"), "utf8");

// A fake of the app's extension sandbox: sync http with a route table, in-memory storage.
export function load(settings = {}, routes = [], opts = {}) {
  const calls = [];
  const store = new Map();
  let ext = null;
  const answer = (method, url, body, headers) => {
    calls.push({ method, url, body, headers });
    for (const [match, reply] of routes) {
      const hit = typeof match === "string" ? url.includes(match) : match.test(url);
      if (!hit) continue;
      if (method === "POST" && reply && reply.post === false) continue;
      const r = typeof reply === "function" ? reply(url, body, headers) : reply;
      if (r === undefined) continue;
      if (r && r.error) return { error: r.error };
      if (r && r.statusCode !== undefined) return { ok: r.statusCode >= 200 && r.statusCode < 300, statusCode: r.statusCode, body: r.body ?? "" };
      return { ok: true, statusCode: 200, body: typeof r === "string" ? r : JSON.stringify(r) };
    }
    return { ok: false, statusCode: 404, body: "" };
  };
  const sandbox = {
    http: {
      get: (url, headers) => answer("GET", url, "", headers),
      post: (url, body, headers) => answer("POST", url, body, headers),
    },
    storage: {
      get: (k) => (store.has(k) ? store.get(k) : undefined),
      set: (k, v) => { store.set(k, v); return true; },
      remove: (k) => store.delete(k),
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    registerExtension: (e) => { ext = e; },
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    console,
    Date,
  };
  if (opts.now) sandbox.Date = opts.now;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "index.js" });
  ext.initialize(settings);
  return { ext, calls, store, ctx: sandbox, run: (code) => vm.runInContext(code, sandbox) };
}

// What Mornye's Rust side writes for a returned result (the [ts]words part of with_metadata).
export function toLrc(result) {
  return (result.lines || []).map((l) => {
    const t = l.startTimeMs;
    const mm = String(Math.floor(t / 60000)).padStart(2, "0");
    const ss = String(Math.floor((t % 60000) / 1000)).padStart(2, "0");
    const cs = String(Math.floor((t % 1000) / 10)).padStart(2, "0");
    return `[${mm}:${ss}.${cs}]${l.words}`;
  }).join("\n");
}

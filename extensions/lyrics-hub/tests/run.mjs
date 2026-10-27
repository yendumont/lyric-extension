import { tests } from "./t.mjs";
const mods = process.argv.slice(2);
for (const m of mods) await import(`./${m}`);
let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (e) { failed++; console.log("FAIL " + name + "\n     " + (e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n     ") : e)); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

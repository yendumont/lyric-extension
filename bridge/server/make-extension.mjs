// Makes a copy of the Lyrics Hub extension that is allowed to talk to your own helper address.
// Mornye only lets an extension reach hosts listed in its manifest; the normal build lists *.ts.net (Tailscale),
// *.local and *.trycloudflare.com. If your helper is at an IP address (192.168.1.50) or your own domain, run:
//
//   node make-extension.mjs 192.168.1.50 lyrics.example.org
//
// It reads ../../extensions/lyrics-hub (or --from <folder with manifest.json and index.js>) and writes
// lyrics-hub_<version>_private.mornye-ext next to where you ran it (or --out <file>). Install that in Mornye
// instead of the normal one; it keeps the same name, so it replaces it. Needs Node.js 22 or newer.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf("--" + name); return i === -1 ? null : args.splice(i, 2)[1]; };
const from = path.resolve(opt("from") || fileURLToPath(new URL("../../extensions/lyrics-hub", import.meta.url)));
let out = opt("out");
const hosts = args.map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "")).filter(Boolean);

if (!hosts.length) { console.error("Usage: node make-extension.mjs <ip-or-domain> [more...] [--from folder] [--out file]"); process.exit(1); }
for (const h of hosts) if (!/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h)) { console.error(`"${h}" is not a host name or IP address.`); process.exit(1); }
let manifest, index;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(from, "manifest.json"), "utf8"));
  index = fs.readFileSync(path.join(from, "index.js"));
} catch (e) { console.error(`Could not read manifest.json and index.js in ${from}\n(use --from <folder>): ${e.message}`); process.exit(1); }

const network = manifest.permissions.network;
for (const h of hosts) if (!network.includes(h)) network.push(h);
out = path.resolve(out || `lyrics-hub_${manifest.version}_private.mornye-ext`);

// A zip with the two files stored uncompressed.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8);
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(n.length, 28); head.writeUInt32LE(offset, 42);
    central.push(head, n);
    parts.push(local, n, data);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
fs.writeFileSync(out, zip([["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))], ["index.js", index]]));
console.log(`Wrote ${out}\nAllowed helper hosts added: ${hosts.join(", ")}\nInstall it in Mornye in place of the normal Lyrics Hub, then set Helper address and Helper token.`);

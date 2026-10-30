// Rewrites registry.json, the list Mornye reads to install and update Lyrics Hub from its Repo tab.
// Run it after every new package is built (see README, "Releasing"):
//
//   node make-registry.js
//
// It takes the version from extensions/lyrics-hub/manifest.json, finds dist/lyrics-hub_<version>.mornye-ext,
// works out the file's sha256 (Mornye refuses a download that doesn't match it) and points download_url at that file on the main branch.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const REPO = "yendumont/lyric-extension";
const BRANCH = "main";

const manifest = JSON.parse(fs.readFileSync(path.join(root, "extensions/lyrics-hub/manifest.json"), "utf8"));
const file = `${manifest.name}_${manifest.version}.mornye-ext`;
const pkg = path.join(root, "dist", file);
if (!fs.existsSync(pkg)) {
  console.error(`dist/${file} not found. Build the package first (README, "Building").`);
  process.exit(1);
}
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(pkg)).digest("hex");

const registry = {
  version: 1,
  updated_at: new Date().toISOString().slice(0, 10),
  extensions: [
    {
      id: manifest.name,
      name: manifest.name,
      display_name: manifest.displayName,
      version: manifest.version,
      description: "All-in-one lyrics: 15 sources, word-by-word sync, background vocals, duets, translation. Genius, YouTube Music and the Spotify lookup through the optional helper.",
      download_url: `https://raw.githubusercontent.com/${REPO}/${BRANCH}/dist/${file}`,
      category: "lyrics",
      tags: ["lyrics", "word-synced", "translation", "spicy lyrics", "genius"],
      updated_at: new Date().toISOString().slice(0, 10),
      sha256,
    },
  ],
};
fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify(registry, null, 2) + "\n");
console.log(`registry.json: ${manifest.displayName} ${manifest.version}\n  ${registry.extensions[0].download_url}\n  sha256 ${sha256}`);

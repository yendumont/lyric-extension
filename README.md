# Mornye lyrics extensions

Word-synced lyrics extensions for [Mornye](https://github.com/mornyeapp/Mornye) (mobile) and
[Mornye Desktop](https://github.com/mornyeapp/Mornye-Desktop).

| Extension | For | What it does |
|---|---|---|
| `extensions/lyrics-hub` | Mornye (mobile and desktop) | **All-in-one**: 15 lyric sources (Genius and YouTube Music via the helper), best-sync choice, translation. Replaces the three below. |
| `extensions/spicy-lyrics` | Mornye (mobile and desktop) | Spicy Lyrics with word-by-word timing |
| `extensions/spicy-lyrics-desktop` | Mornye Desktop | Same, plus finding songs through your running Spotify app |
| `extensions/unison-lyrics` | Mornye (mobile and desktop) | Unison community lyrics, with word timing when available |
| `bridge/` | Mornye Desktop | One helper for Spotify lookup, Genius and YouTube Music (`lyrics-bridge.mjs`) |

Ready-to-install files are in [`dist/`](dist/) (`*.spotiflac-ext`).

## What was added

- **Word-by-word sync.** Word timing is written as `<mm:ss.xxx>` tags inside each line, which is what Mornye reads.
- **Background vocals** as a small line under the main lyric (can be turned off).
- **Duets.** The second singer's lines are tagged `v2:` so Mornye shows them on the right (can be turned off).
- **Timing offset** setting (in ms, negative = earlier) and a **Word-by-word timing** switch for comparing.
- **Diagnostics.** "Show last lookup" in the Spicy Lyrics settings shows what happened on the last lookup.

## Lyrics Hub (the all-in-one extension)

`extensions/lyrics-hub` asks the lyric sources the [Lyric Viewer](https://github.com/yendumont/lyric-viewer) uses, from one
extension, on mobile and desktop: Spicy Lyrics, lrc.red, AMLL TTML DB, BiniLyrics, Musixmatch, Unison, LRCLIB, LRCMux, NetEase,
QQ Music, KuGou, Kuwo and Deezer, plus Genius and YouTube Music through the helper (`bridge/`), on your PC or on a second computer that stays on for phones. Install `dist/lyrics-hub_1.3.0.spotiflac-ext`, then in **Settings > Lyrics > Lyrics providers**
switch it on, put it first and switch the other providers off.

Settings (grouped by the label prefix): **[General]** prefer best sync, source order, accept unsynced, word timing, background
vocals, duet sides, timing offset, search time limit; **[Sources]** an on/off switch per source and the lrc.red / BiniLyrics
word-sync mode (`hand`, `all`, `off`); **[Keys]** Spicy Lyrics, Musixmatch, optional Spotify; **[Translation]** off / line / word,
language, Gemini key and model; **[Helper]** YouTube Music, Genius (favourite artists, loose search, best-guess match), the Spotify-app lookup, and where the helper runs (address and token; skipped by themselves when it can't be reached); **[Tools]** test
connection and last lookup.

Translation: with a Gemini key (yours) each lyric line is translated. *line* adds a translation line under each lyric
(`[x-translation]`, shown by Mornye as the translation). *word* splits the translation into chunks tied to the sung words and
sends them as `[x-romaji]` + `[x-romaji-words]`, so Mornye shows them in its word-by-word "pronunciation" slot (use the lyrics
language button). Mornye has no separate word-synced translation slot.

Genius and YouTube Music only answer a normal program, not an extension sandbox, so they go through the helper and only work while it is running (on your PC, or on another computer for phones, see below). Genius is tried last (plain text only). Not included: Genius' cover-based matching and alias learning,
Genius line meanings, and animated album covers (an extension can only return lyrics, not artwork).

To rebuild: `cd extensions/lyrics-hub && ./build.sh` joins `src/*.js` into `index.js`; tests are in `tests/`
(`cd tests && node run.mjs formats.test.mjs providers.test.mjs engine.test.mjs`).

## Install

1. Download the `.spotiflac-ext` file you want from `dist/`.
2. In Mornye, install it from the Extensions page.
3. For Spicy Lyrics, paste your free key from <https://developers.spicylyrics.org> into the extension's settings.
4. In **Settings > Lyrics > Lyrics providers**, switch the extension on and move it to the top.

## Desktop helper (Spotify lookup, Genius, YouTube Music)

Mornye extensions can only make plain web requests, but Spotify's debug port needs a WebSocket. So the desktop extension
asks `bridge/lyrics-bridge.mjs`, a tiny helper running on your PC, which asks your running Spotify app to search.
No Spotify keys needed. If the helper isn't running, the extension falls back to a ListenBrainz / iTunes / Deezer lookup.

Setup, once:

1. Install **Node.js 22 or newer** (the LTS from <https://nodejs.org>). Don't tick the "native modules" box.
2. Start Spotify with the debug port open. With Spicetify, put this in `%APPDATA%\spicetify\config-xpui.ini` under `[Setting]`,
   then run `spicetify apply` and restart Spotify:
   `spotify_launch_flags = --remote-debugging-port=8088`
3. In Mornye Desktop: **Settings > Download > Allow Local Network Access**.
4. Install the `lyrics-hub` (or `spicy-lyrics-desktop`) extension. Genius and YouTube Music need only steps 1, 3 and the helper.

Every time: open Spotify, double-click `bridge/start-lyrics-bridge.cmd`, leave the window open while downloading.
More detail is in [`bridge/README.txt`](bridge/README.txt).

**Safety.** The helper listens only on `127.0.0.1`, answers only `GET` requests to `/health`, `/search`, `/genius/*` and `/ytm/*`, and refuses any request with an
`Origin` header, so websites can't use it. Server mode instead requires the token on every request and blocks an address after ten wrong ones. While Spotify's debug port is on, any program on your PC can use that port.

### Phones: a private helper on a second computer

Android and iPhone can't run the helper, so run it on another laptop that stays on, in server mode. Every request needs your
secret token (`X-Bridge-Token`); without it the helper answers 401. On Windows, double-click `bridge/server/setup-server.cmd`: it
makes the token, starts the helper at every logon, opens the firewall and prints the address and token to enter in Lyrics Hub
(**[Helper] Helper address** and **Helper token**). Reach it from the phones with [Tailscale](https://tailscale.com) (works at
home and away; the normal build already allows `*.ts.net`), or on the same Wi-Fi by its `.local` name. If Tailscale is inconvenient (another VPN, say), an IP can be written as
`192-168-1-50.sslip.io` (a free public DNS service that turns it back into 192.168.1.50; the normal build allows `*.sslip.io`). **Warning:**
that trusts sslip.io not to point the name elsewhere, and the token travels unencrypted, so Tailscale is safer. For a bare IP address or your
own domain, `node bridge/server/make-extension.mjs <address>` writes a Lyrics Hub build that allows it. Full steps (including
Linux, sleep settings and Cloudflare Tunnel) are in [`bridge/server/SERVER.txt`](bridge/server/SERVER.txt). Never port-forward it to
the internet.

## Building the packages

A package is a zip with `manifest.json` and `index.js` at its root, renamed to `.spotiflac-ext`:

```sh
cd extensions/spicy-lyrics-desktop
zip -X ../../dist/spicy-lyrics-desktop_1.0.4.spotiflac-ext manifest.json index.js
```

## Credits and terms

- Based on my prior **Spicy Lyrics** and **Unison** extensions for SpotiFLAC Mobile.
- **Spicy Lyrics** lyrics come from [developers.spicylyrics.org](https://developers.spicylyrics.org) with your own key, and its
  [attribution rules](https://developers.spicylyrics.org/docs/attribution) apply. The provider name shown in Mornye carries the credit.
- **Unison** lyrics come from <https://unison.boidu.dev> ([Better Lyrics](https://github.com/better-lyrics/unison), ODbL, attribution required).
- The idea of reading Spotify through its debug port, and the search call used, come from
  [yendumont/lyric-viewer](https://github.com/yendumont/lyric-viewer) (AGPL-3.0).
- Not affiliated with Mornye, Spotify, Spicy Lyrics or Unison etc.

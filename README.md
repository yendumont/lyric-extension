# Mornye lyrics extensions

Word-synced lyrics extensions for [Mornye](https://github.com/mornyeapp/Mornye) (mobile) and
[Mornye Desktop](https://github.com/mornyeapp/Mornye-Desktop), made from the Spicy Lyrics and Unison
extensions for SpotiFLAC-style apps.

| Extension | For | What it does |
|---|---|---|
| `extensions/spicy-lyrics` | Mornye (mobile and desktop) | Spicy Lyrics with word-by-word timing |
| `extensions/spicy-lyrics-desktop` | Mornye Desktop | Same, plus finding songs through your running Spotify app |
| `extensions/unison-lyrics` | Mornye (mobile and desktop) | Unison community lyrics, with word timing when available |
| `bridge/` | Mornye Desktop | Small helper that lets the desktop extension talk to Spotify |

Ready-to-install files are in [`dist/`](dist/) (`*.spotiflac-ext`).

## What was added

- **Word-by-word sync.** Word timing is written as `<mm:ss.xxx>` tags inside each line, which is what Mornye reads.
- **Background vocals** as a small line under the main lyric (can be turned off).
- **Duets.** The second singer's lines are tagged `v2:` so Mornye shows them on the right (can be turned off).
- **Timing offset** setting (in ms, negative = earlier) and a **Word-by-word timing** switch for comparing.
- **Diagnostics.** "Show last lookup" in the Spicy Lyrics settings shows what happened on the last lookup.

## Install

1. Download the `.spotiflac-ext` file you want from `dist/` (or [Releases](../../releases)).
2. In Mornye, install it from the Extensions page.
3. For Spicy Lyrics, paste your free key from <https://developers.spicylyrics.org> into the extension's settings.
4. In **Settings > Lyrics > Lyrics providers**, switch the extension on and move it to the top.

## Desktop: finding songs through the Spotify app

Mornye extensions can only make plain web requests, but Spotify's debug port needs a WebSocket. So the desktop extension
asks `bridge/spotify-bridge.mjs`, a tiny helper running on your PC, which asks your running Spotify app to search.
No Spotify keys needed. If the helper isn't running, the extension falls back to a ListenBrainz / iTunes / Deezer lookup.

Setup, once:

1. Install **Node.js 22 or newer** (the LTS from <https://nodejs.org>). Don't tick the "native modules" box.
2. Start Spotify with the debug port open. With Spicetify, put this in `%APPDATA%\spicetify\config-xpui.ini` under `[Setting]`,
   then run `spicetify apply` and restart Spotify:
   `spotify_launch_flags = --remote-debugging-port=8088`
3. In Mornye Desktop: **Settings > Download > Allow Local Network Access**.
4. Install the `spicy-lyrics-desktop` extension.

Every time: open Spotify, double-click `bridge/start-spotify-bridge.cmd`, leave the window open while downloading.
More detail is in [`bridge/README.txt`](bridge/README.txt).

**Safety.** The helper listens only on `127.0.0.1`, answers only `GET /health` and `GET /search`, and refuses any request with an
`Origin` header, so websites can't use it. While Spotify's debug port is on, any program on your PC can use that port.

## Building the packages

A package is a zip with `manifest.json` and `index.js` at its root, renamed to `.spotiflac-ext`:

```sh
cd extensions/spicy-lyrics-desktop
zip -X ../../dist/spicy-lyrics-desktop_1.0.4.spotiflac-ext manifest.json index.js
```

## Credits and terms

- Based on community **Spicy Lyrics** and **Unison** extensions for SpotiFLAC Mobile. The original author and licence are
  not known to the maintainer of this repository; if you wrote them, please open an issue so credit can be added.
- **Spicy Lyrics** lyrics come from [developers.spicylyrics.org](https://developers.spicylyrics.org) with your own key, and its
  [attribution rules](https://developers.spicylyrics.org/docs/attribution) apply. The provider name shown in Mornye carries the credit.
- **Unison** lyrics come from <https://unison.boidu.dev> ([Better Lyrics](https://github.com/better-lyrics/unison), ODbL, attribution required).
- The idea of reading Spotify through its debug port, and the search call used, come from
  [yendumont/lyric-viewer](https://github.com/yendumont/lyric-viewer) (AGPL-3.0). The helper here is separately written.
- Not affiliated with Mornye, Spotify, Spicy Lyrics or Unison.

## Licence

No licence has been chosen yet. Until one is added, all rights are reserved by default. Choose one before sharing widely, and check the
original extensions' terms for the parts they cover.

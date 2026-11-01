# Changelog

## Repo
- Added `registry.json` and `make-registry.js`: add this repo in Mornye's **Repo** tab to install and update Lyrics Hub.

## lyrics-hub 1.4.1
- Word-timed translation: Gemini now sees each sung word's length and the pauses between words, and is told to use the whole song as context.
- Alignment runs at temperature 0, so the same song pairs the same way each time.
- Lines whose pairing looks wrong are asked again once with a hint. If they still look wrong, the chunks are laid over the sung words by text length (approximate but in step) instead of dropping to a plain line.

## lyrics-hub 1.4.0
- Word-timed translation is now much closer to the sung timing: Gemini says which sung words each translated chunk covers (a range, not one word), and the chunk takes the real start of the first and the real end of the last of them. It no longer holds through pauses or long notes.
- When several chunks share one sung word, that word's time is split between them by text length instead of equally.
- Smaller chunks are asked for (about one per sung word).
- If a line's pairing looks wrong (most sung words unaccounted for, or too many chunks squeezed onto one word), that line shows a plain translated line instead of wrong timing.
- Cached translations from before are not reused (they have the old pairing); the first play of a song asks Gemini again.

## lyrics-hub 1.3.1
- Packages are now named `.mornye-ext`.
- Removed the separate Spicy Lyrics, Spicy Lyrics (Desktop) and Unison extensions and the old `spotify-bridge`: Lyrics Hub and `lyrics-bridge` replace them.
- README rewritten: which setup you need, what every file is, `start-lyrics-bridge.cmd` (this PC only) versus `server/run-server.cmd` (other devices), and a file guide in `bridge/README.txt`.

## lyrics-hub 1.3.0 / Helper 2.2
- Lyrics Hub allows `*.sslip.io`, so any IP can be used as `192-168-1-50.sslip.io` when Tailscale is inconvenient (with a warning in the setting, README and SERVER.txt).
- Helper startup and `--init` messages say which addresses the extension accepts.

## lyrics-hub 1.2.1
- Test connection says where it looked for the helper and why it failed, instead of "helper HTTP undefined".

## lyrics-hub 1.2.0 / Helper 2.1
- Private server mode for phones: run the helper on another computer that stays on (`--host 0.0.0.0` with a token, `--init` makes the `.env`), with Windows start-at-logon scripts, a systemd unit and `make-extension.mjs` for custom addresses.
- Lyrics Hub: new [Helper] settings Helper address and Helper token (the other helper settings moved from [Desktop only] to [Helper]); Tailscale, `.local` and trycloudflare hosts allowed.

## lyrics-hub 1.1.1
- NetEase (and every other source) now sends a browser-like User-Agent, NetEase its web-player headers and a second search endpoint; failed requests are retried once.
- Source order: names, aliases and `>` / new-line separators work. With best sync off, plain text from an early source no longer stops a later synced one.
- The last lookup (Tools) shows the order that was used.

## lyrics-hub 1.1.0 / Helper 2.0
- Helper is now `lyrics-bridge`: Spotify lookup plus Genius and YouTube Music routes (GET only, localhost only).
- Hub gains YouTube Music and Genius sources with favourite artists, loose search and best-guess options ([Desktop only]).

## lyrics-hub 1.0.0
- New all-in-one extension: 13 sources from the Lyric Viewer, prefer-best-sync, source order and switches, lrc.red/BiniLyrics word-sync mode, Gemini translation (line or word by word), optional desktop Spotify-app lookup.

## Desktop extension 1.0.4 / Helper 1.5
- Helper searches Spotify the way Spotify's own search box does (works when the Web API is rate-limited).
- Missing song lengths in Spotify's answer no longer reject a match.
- Added ListenBrainz as a no-account fallback.

## Desktop extension 1.0.0 – 1.0.3 / Helper 1.0 – 1.4
- First desktop version with the Spotify helper; clearer errors, request queueing and rate-limit cooldown.

## Spicy Lyrics 1.3.7 / Unison 1.1.5
- Word-by-word timing, background vocals, duet sides, timing offset, word-timing switch, diagnostics.

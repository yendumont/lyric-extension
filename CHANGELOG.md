# Changelog

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

Lyrics Hub bridge (the helper), version 2.2
============================================

What it is
  A small program that does what the Lyrics Hub extension can't do from inside Mornye:
    * Genius: searches Genius and returns a song's lyrics (plain text).
    * YouTube Music: searches songs and returns their lyrics (plain text).
    * Spotify song lookup: asks your running Spotify app for a song's exact ID, which Spicy Lyrics,
      Musixmatch and AMLL need. Optional: without it the extension uses a no-account lookup instead.
  Needs Node.js 22 or newer (https://nodejs.org). Nothing else to install. If it isn't running, Lyrics Hub just
  skips these sources and uses the rest.

Which file do I use?
  Only on this PC (the simple way)     ->  start-lyrics-bridge.cmd
  For phones / other computers         ->  server\setup-server.cmd once, then it starts by itself (server\SERVER.txt)

Every file in this folder
  lyrics-bridge.mjs             The helper itself. Everything else here just starts or sets it up.
  start-lyrics-bridge.cmd       Starts the helper for THIS PC only. Double-click it each time (see below).
  README.txt                    This file.
  tests\bridge.test.mjs         Tests for developers. You don't need it.
  .env                          Made by setup-server.cmd (not in the repo): your private settings and secret token.
  server\                       Only for running the helper for OTHER devices (server mode):
    SERVER.txt                    The full guide: Tailscale, firewall, sleep settings, updating.
    setup-server.cmd              One-time setup: makes the token, starts it at every logon, opens the firewall.
    run-server.cmd                Starts server mode right now and restarts it if it crashes. For when you closed it.
    remove-server.cmd             Undoes setup-server.cmd (stops starting at logon, closes the firewall port).
    make-extension.mjs            Makes a Lyrics Hub build that allows a bare IP address or your own domain.
    lyrics-bridge.service         The same thing as setup-server.cmd for Linux (systemd).

start-lyrics-bridge.cmd or run-server.cmd?
                              start-lyrics-bridge.cmd          server\run-server.cmd
  Who can use it              only this PC (127.0.0.1)         other devices too (phones, other PCs)
  Token (password)            none                             required on every request (from .env)
  If it crashes               stays stopped                    restarts itself after 10 seconds
  Starts at login             no, you start it                 yes, once setup-server.cmd has run
  Lyrics Hub "Helper address" leave empty                      the address of that computer, plus the token

Use it only on this PC (setup, once)
  1. Install Node.js 22 or newer. Check with:  node --version
  2. Only for the Spotify song lookup: start Spotify with the debug port open. With Spicetify, put this in
       %APPDATA%\spicetify\config-xpui.ini   under [Setting]:
       spotify_launch_flags = --remote-debugging-port=8088
     then run  spicetify apply  and restart Spotify. (To check, open http://127.0.0.1:8088/json in a browser while
     Spotify is open: it should show text.) The helper tries port 8088, then 9222. For another port:
     start-lyrics-bridge.cmd --cdp 9333
  3. In Mornye Desktop: Settings > Download > turn on "Allow Local Network Access" (Mornye blocks 127.0.0.1 otherwise).
  4. Install "Lyrics Hub" in Mornye. Leave "Helper address" empty.
  Genius and YouTube Music only need steps 1, 3 and 4.

Every time
  Double-click start-lyrics-bridge.cmd and leave its window open while you download. (For the Spotify lookup,
  open Spotify first.) In Lyrics Hub, [Tools] "Test connection" says whether the helper is reachable and whether it
  can see Spotify.

If Spotify says "too many requests"
  The helper waits out the limit (usually under a minute) and answers "try again in Ns" meanwhile; the extension
  then uses its backup lookup for that song. Downloading many songs at once triggers this more.

Safety
  * start-lyrics-bridge.cmd listens only on 127.0.0.1. Server mode listens for other devices but needs your secret
    token on every request (wrong tries are blocked for a minute after ten).
  * It answers only GET /health, /search, /genius/* and /ytm/*, and refuses any request that has an Origin header,
    so websites in your browser can't use it.
  * While Spotify's debug port is on, any program on that computer can use that port. Turn the flag off if you
    don't want that.

Changing the port
  start-lyrics-bridge.cmd --port 8090, and set the same number in Lyrics Hub's "Helper port" setting.

Credit: the idea of reading Spotify through its debug port comes from yendumont/lyric-viewer.

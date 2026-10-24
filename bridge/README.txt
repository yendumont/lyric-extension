Spotify bridge for "Spicy Lyrics (Desktop)"
===========================================

What it does
  Mornye extensions can't open the Spotify debug port themselves (it needs a WebSocket), so this
  tiny helper does it for them. When Mornye asks Spicy Lyrics for a song, the extension asks the
  helper, the helper asks your running Spotify app to search (using Spotify's own login), and the
  exact Spotify track ID goes back to the extension. No keys needed, nothing leaves your PC except
  the normal Spotify and Spicy Lyrics requests.

  If the helper isn't running, the extension quietly falls back to its normal key-free lookup,
  so nothing breaks.

Setup (one time)
  1. Node.js 22 or newer must be installed (https://nodejs.org). Check with:  node --version
  2. Spotify must be started with the debug port open. With Spicetify, put this in
       %APPDATA%\spicetify\config-xpui.ini   under [Setting]:
       spotify_launch_flags = --remote-debugging-port=8088
     then run  spicetify apply  and restart Spotify. (You can check it worked by opening
     http://127.0.0.1:8088/json in a browser while Spotify is open: it should show text.)
     The helper tries port 8088 first, then 9222. For another port:  start-spotify-bridge.cmd --cdp 9333
  3. In Mornye Desktop: Settings > Download > turn on "Allow Local Network Access".
     (Mornye blocks 127.0.0.1 otherwise.)
  4. Install the extension "Spicy Lyrics (Desktop)" in Mornye, paste your Spicy Lyrics key, and leave
     "Use my running Spotify app to find songs" on.

Every time
  Open Spotify, then double-click  start-spotify-bridge.cmd  and leave its window open while you
  download. In the extension's settings, "Test connection" tells you if the helper can see Spotify.

If Spotify says "too many requests"
  The helper waits out the limit (usually under a minute) and answers "try again in Ns" meanwhile; the
  extension then uses its backup lookup for that song. Downloading many songs at once triggers this
  more, so smaller batches work better.

Safety
  * Listens only on 127.0.0.1 (not reachable from other devices).
  * Answers only GET /health and GET /search, and refuses any request that has an Origin header,
    so websites in your browser can't use it.
  * Remember: while Spotify's debug port is on, any program on your PC can use that port.
    Turn the flag off if you don't want that.

Changing the helper's port: start-spotify-bridge.cmd --port 8090, and set the same number in the
extension's "Helper port" setting.

Credit: the idea of reading Spotify through its debug port comes from yendumont/lyric-viewer.

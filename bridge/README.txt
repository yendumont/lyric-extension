Lyrics Hub bridge (v2.0) for the "Lyrics Hub" and "Spicy Lyrics (Desktop)" extensions
===================================================================================

What it does
  One small helper for everything the Mornye extensions can't do themselves:
    * Spotify lookup (Spicy Lyrics, Musixmatch, AMLL need the exact Spotify track ID) - see below.
    * Genius: searches Genius and returns a song's lyrics as plain text (used by the Lyrics Hub's Genius
      source, with its favourite-artists / loose-search / best-guess options).
    * YouTube Music: searches songs and returns their lyrics (the Lyrics Hub's YouTube Music source).
  Genius and YouTube Music only answer a normal browser-like program, not an extension sandbox, so this helper
  asks them for the extension (the same job the Lyric Viewer's built-in worker does). Nothing is sent anywhere
  except to those sites. Genius and YouTube Music work without Spotify running; only the Spotify lookup needs it.

Spotify lookup
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
     The helper tries port 8088 first, then 9222. For another port:  start-lyrics-bridge.cmd --cdp 9333
  3. In Mornye Desktop: Settings > Download > turn on "Allow Local Network Access".
     (Mornye blocks 127.0.0.1 otherwise.)
  4. Install the extension "Lyrics Hub" (or "Spicy Lyrics (Desktop)") in Mornye, paste your Spicy Lyrics key, and leave
     "Find songs through the Spotify app" on. For Genius and YouTube Music you only need steps 1 and 3.

Every time
  Open Spotify, then double-click  start-lyrics-bridge.cmd  and leave its window open while you
  download. In the extension's settings, "Test connection" tells you if the helper can see Spotify.

If Spotify says "too many requests"
  The helper waits out the limit (usually under a minute) and answers "try again in Ns" meanwhile; the
  extension then uses its backup lookup for that song. Downloading many songs at once triggers this
  more, so smaller batches work better.

Phones and tablets
  They can't run this helper. To use Genius and YouTube Music on Android or iPhone, run the helper on a second
  computer that stays on, in server mode, with a token: see server\SERVER.txt.

Safety
  * By default it listens only on 127.0.0.1 (not reachable from other devices). Server mode (server\SERVER.txt)
    listens for other devices but needs your secret token on every request.
  * Answers only GET /health, /search, /genius/* and /ytm/*, and refuses any request that has an Origin header,
    so websites in your browser can't use it.
  * Remember: while Spotify's debug port is on, any program on your PC can use that port.
    Turn the flag off if you don't want that.

Changing the helper's port: start-lyrics-bridge.cmd --port 8090, and set the same number in the
extension's "Helper port" setting.

Credit: the idea of reading Spotify through its debug port comes from yendumont/lyric-viewer.

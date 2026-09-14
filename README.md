# Telegram Archive Viewer

Offline reader for Telegram Desktop chat exports. Nothing touches the network;
the server binds to loopback only.

**Your exports are never modified.** The backup folder is mounted read-only.
Every file this program writes lives under `TelegramViewer/data/` — the index,
`config.json`, and any pictures you upload.

## Two ways to run it

| | The website | The downloadable app |
|---|---|---|
| Install | Nothing: open the page | Unzip and run the installer |
| Where it runs | Entirely in your browser | A small server on this computer, loopback only |
| Your folder | Chosen in the browser | Set in Settings |
| Your settings | `telegram-archive-config.json`, in your folder | `data/config.json` |
| Needs | Chrome, Edge, Firefox, Safari or Brave | Python 3 |

Both read the same exports and build the same index. The website's indexer
(`app/indexer/`) is a JavaScript port of `tools/tgindex/`, and
`tools/tests/test_web_parity.py` fails if the two ever write different indexes.
Neither opens a media file while indexing a cloud or network folder, so
pointing either at an on-demand NAS folder does not download it.

The website's safety rules are enforced in code and tested:
`tools/tests/test_web_safety.py` fails if anything but `app/web/folder.js` can
write, if anything can delete or move a file, or if an address to another
website appears anywhere in the page's code.

Build and preview the website:

```bash
python3 tools/build_site.py
python3 -m http.server --directory site 8850      # then open http://localhost:8850
```

Publishing it is explained step by step in `GITHUB-GUIDE.md`.

## Layout

```
Backups/                          ← your archive, read-only
  Jordan/
    ChatExport_2024-03-01/        result.json  photos/  video_files/ ...
    ChatExport_2026-07-26/        result.json  stickers/ ...
  Robin/
    ChatExport_2026-07-26/        result.json  messages.html  ...

TelegramViewer/                   ← the program, self-contained
  index.html                      app shell
  app/
    css/theme.css                 all design tokens — the only colour source
    css/{shell,sidebar,chat,message,media,search,settings}.css
    main.js                       bootstrap
    api.js                        index access + media URLs
    state.js                      persisted settings
    theme.js                      light/dark/system, wallpapers
    format.js                     Telegram-style dates and labels
    sidebar.js                    chat list + drag resizer
    chat.js                       header + message column
    message.js                    bubbles, media, replies, reactions
    scroller.js                   the windowed history engine
    search.js                     inverted-index queries
    profile.js                    the info panel and its library tabs
    settings.js                   settings screen
    settings-schema.js            every setting, declared once
    theme-import.js               .attheme / .tdesktop-theme readers
    keyboard.js                   shortcuts + help sheet
    lightbox.js  contextmenu.js  icons.js
    media/{album,tgs,waveform,visibility}.js
  serve.py                        read-only two-root server
  tools/tgindex/                  the indexer
  tools/tests/                    hermetic tests
  data/
    config.json                   backup root + your identity
    index/                        generated; safe to delete and rebuild
```

## First run

Opening the viewer with no `setup_complete` in `data/config.json` starts a
four-step wizard: welcome → pick the backup folder → confirm who you are →
done. The folder step has a built-in browser that marks which folders already
contain exports, and indexes the one you choose before moving on — so the
identity step can offer the **actual participant list** instead of asking you to
go hunting for a `from_id`. The account owner is ranked first because they are
the one person present in every conversation.

It runs exactly once. `setup_complete` lives on disk, not in localStorage, so it
survives clearing browser data. To see it again: Settings → Archive → *Run
first-time setup again*, or Settings → Advanced → *Reset everything*.

### Pointing at a different backup folder

Settings → Archive → *Backup folder*, then *Rebuild the index*. Both write
straight to `data/config.json`. From the command line:

```bash
python3 -m tools.tgindex --root "/path/to/your/backups"
```

Relative paths resolve against the program folder. `serve.py` reads the same
setting to decide what to mount at `/media/`.

## What saves, and where

| | Stored in | Survives |
|---|---|---|
| Backup folder, your name/ID, setup state | `data/config.json` | clearing browser data |
| Uploaded pictures | `data/avatars/<slug>.jpg` | clearing browser data |
| Theme, sizes, toggles, chat background | browser localStorage | per browser |

Everything saves the moment you change it — there is no save button anywhere.

### The write surface

The server is read-only for your archive and has a deliberately narrow write
path for the program's own state:

```
GET  /api/config     current config
GET  /api/browse     list sub-folders (directories only)
POST /api/config     merge known keys into data/config.json
POST /api/avatar     store data/avatars/<slug>.<ext>
POST /api/reindex    run the indexer, return its report
```

`/media/` answers reads and nothing else. Every write above touches `data/`.

## Profile pictures

Telegram's exports rarely include one, so you set them yourself: click the
avatar at the top of a chat's profile panel. Images are centre-cropped square
and re-encoded before saving. Your own photo is in Settings → Archive.

Avatars resolve in order: a picture you set, then whatever the export happened
to include (`profile_pictures/`), then coloured initials.

A conversation folder that *is itself* an export (a `result.json` sitting
directly in it) also works — that's what you get unzipping a single export.

## Starting and stopping

**Start it:** double-click a launcher in the `TelegramViewer` folder. It
indexes anything new, starts the local server, and opens your browser.

| Platform | Double-click | Notes |
|---|---|---|
| macOS | **Telegram Archive.app** | Real app — Dock icon, Spotlight. See the caveat below. |
| macOS | `Start Viewer.command` | Always works; opens a Terminal window alongside. |
| Windows | **Telegram Archive.vbs** | No console window. Right-click → *Send to → Desktop* for a shortcut. |
| Windows | `start-viewer.bat` | Shows the indexer output in a console. |
| Linux | **Telegram Archive.desktop** | Mark executable, or copy to `~/.local/share/applications/`. |
| Linux | `start-viewer.sh` | From a terminal. |

### macOS: where the folders live matters

macOS protects **Documents, Desktop and Downloads**. An app that isn't signed
by a paid Apple developer account is denied access to them *silently* — no
prompt, it simply reads nothing. This affects **two** folders independently:

| | If it sits in a protected folder |
|---|---|
| The program folder | The app won't start at all |
| Your **Backups** folder | The app starts but finds no chats |

Double-click **`Install to Applications.command`** to put the program in
`~/Applications` (it keeps any existing index and settings, and ad-hoc signs
the bundle so granted permissions stick). Then keep your exports somewhere
unprotected too — a folder in your Home directory is the simplest choice.

If you would rather leave everything where it is, either grant the app access
under *System Settings › Privacy & Security › Files and Folders*, or just use
`Start Viewer.command`, which is unaffected because Terminal already has
access.

Both failures are detected and explained in place rather than showing an empty
archive.

**Stop it:** click the power button at the bottom of the sidebar and confirm.
Closing the browser tab is *not* enough — the server keeps running behind it,
which is exactly what the button is there to prevent. `Ctrl+C` in the terminal
window works too.

From a terminal:

```bash
python3 -m tools.tgindex && python3 serve.py
```

Re-run the indexer after adding an export — or use Settings → Archive →
*Rebuild the index*, which does the same thing from inside the app. It is
incremental: media hashes are cached by `(path, size, mtime)`, so a rebuild
only reads what changed.

```bash
python3 -m tools.tgindex --root /path/to/Backups   # override the configured root
python3 -m tools.tgindex --no-hash                 # skip hashing (disables dedupe)
python3 -m tools.tests.test_index               # tests
```

## Privacy and dependencies

Audited, not asserted — the checks below are reproducible from the program
folder:

- **Your exports are only read, and that is enforced rather than intended.**
  The `/media/` mount is served by `translate_path` alone; there is no
  `do_PUT`, `do_DELETE` or `do_PATCH`, and none of the seven `/api/` routes
  touch `media_root`. Every write in the program lands in the index directory
  or `data/`, so the guarantee reduces to one property: the index can never
  sit inside the backup folder. `_overlaps()` refuses to run if it would —
  after resolving symlinks, and regardless of whether the path arrived from
  the API, a hand-edited `config.json` or `--out`. `tools/tests/test_readonly.py`
  asserts this end to end, comparing bytes, timestamps and permissions across
  a full index run.
- **The macOS folder chooser asks for no permissions.** `choose folder` is a
  plain scripting addition. An earlier version wrapped it in `tell application
  "System Events"` to raise the panel, which made macOS prompt for Automation
  access — a permission covering UI scripting and synthetic keystrokes, far
  more than a folder picker should ever hold. It is gone.
- **No third-party code.** Every Python import is from the standard library.
  No `pip install`, no `npm install`, no lockfile, no vendored bundles.
- **No CDN or remote assets.** `index.html` loads only files under `app/`.
  Icons are inline SVG; the app icon is generated, not downloaded.
- **No outbound requests.** Every `fetch()` in the app resolves to a relative
  path (`data/…`, `media/…`, `api/…`). There is no analytics, telemetry,
  update check, or crash reporting anywhere in the codebase.
- **The socket binds to `127.0.0.1`.** Nothing on your network can reach it.
- **Write endpoints reject cross-origin requests.** `/api/shutdown` and
  `/api/reindex` carry no request body, which makes them CORS "simple
  requests" — a browser will send those cross-site with no preflight to stop
  them, so any page open in another tab could have stopped the server or
  kicked off a re-index. A present-and-foreign `Origin` is now refused with
  403. A missing `Origin` (curl, a script) is still allowed, since a browser
  cannot omit it cross-site.
- **Build tooling is not shipped.** `make_dist.py` and `make_guide.py` stay in
  the development tree; the latter imports reportlab, which would otherwise be
  the one third-party name inside a distributed file.
- **`.tgs` stickers and `.tdesktop-theme` files are decompressed by the
  browser's own `DecompressionStream`** — the reason no compression library
  had to be vendored.
- **The program contains no personal information.** Names, IDs and paths live
  only in `data/`, which is generated and excluded when you share the folder.

```bash
grep -rE "https?://" app index.html serve.py tools   # only w3.org SVG xmlns
grep -rhE "^\s*(import|from) " --include='*.py' .   # stdlib only
```

Two deliberate exceptions, both user-initiated: links inside your messages open
in a new tab when you click them, and `Open full size` opens local media. Both
act on your archive's own content.

## Building a copy to give away

```bash
python3 tools/make_dist.py      # -> dist/TelegramArchive-<version>.zip
```

Roughly 0.4 MB. It contains the program and nothing else: no index, no config,
no uploaded pictures, no caches. Those live in `data/`, which the recipient's
own first run creates.

The build **refuses to run** if any shipping file mentions the person building
it. The names it looks for are read from the machine — the account name, the
home folder, the full name on the user record — so the check protects whoever
builds it without a real name ever appearing in the source.

### What the recipient does

Unzip anywhere, then double-click:

| Platform | Installer |
|---|---|
| macOS | `Install (macOS).command` |
| Windows | `Install (Windows).bat` |
| Linux | `Install (Linux).sh` |

Each one checks prerequisites before touching anything, installs per-user (no
administrator rights, nothing outside the home folder), creates a menu entry or
Start Menu shortcut where the platform has one, and offers to launch.

Afterwards it deletes the unzipped folder, so nothing is left lying around.
That is guarded by the folder's *name*: only a directory called
`TelegramArchive-<version>` — which is what the zip always unpacks to — is
removed. Running the installer from a development checkout copies out of it and
leaves it alone, because deleting one of those would be unforgivable. Use
`--keep-source` to skip the tidy-up entirely.

Everything goes in **one folder in the home directory** — the same place on
every platform (`~/Telegram Archive`). That sidesteps the macOS restriction on
Documents, Desktop and Downloads, needs no admin rights anywhere, and means one
sentence of instructions instead of three:

```
~/Telegram Archive/
    Backups/                 the user's exports, created by the installer
    Telegram Archive.app     macOS launcher
    data/                    index and settings
```

Reinstalling over an existing copy **keeps both `data/` and `Backups/`**. The
archive lives inside the install folder, so a blind `rmtree` on upgrade would
destroy the very thing the program exists to read.

### Uninstalling

`Uninstall (macOS).command` / `(Windows).bat` / `(Linux).sh`, or
`python3 tools/uninstall.py`. It stops a running copy, removes the program, the
index and any menu entries — and **never touches `Backups/`**, which is left in
place with its files byte-for-byte unchanged. That is not only the uninstaller
being careful: the program has no write path to that folder at all.

An install where no exports were ever added is removed completely, placeholder
note and all. `--delete-backups` exists but demands the word `DELETE` typed in
full.

### Prerequisites

Python 3.9 or newer, and nothing else. Already present on macOS and Linux; on
Windows it is a one-click install from python.org (tick *Add python.exe to
PATH*). Each installer detects a missing or too-old Python and prints the exact
fix rather than failing obscurely. To check without installing:

```bash
python3 tools/preflight.py
```

These are **not compiled binaries.** Producing true standalone executables
would mean bundling an interpreter with something like PyInstaller — a
third-party build dependency, a much larger download, and a per-platform build
machine. Requiring Python instead keeps the program dependency-free,
inspectable, and identical on all three platforms.

## Import JSON, not HTML

Use Telegram's **machine-readable JSON** export. Measured against these files,
the HTML export loses `from_id`, media `width`/`height`, duration, mime type,
file size, precise timestamps, and who reacted — and it splits across
`messages.html`, `messages2.html`, … while JSON never splits.

`width`/`height` matter most: they exist only in JSON, and without them the
viewer cannot draw a correctly-shaped placeholder for media that isn't on disk.

### Keep old HTML exports anyway

Telegram names every sticker after its own filename attribute — literally
`sticker.webp` for most packs — so each send collides on write and gets a
` (N)` suffix. **That numbering is assigned in export order, per run.** The same
sticker is `sticker (5).webp` in one export and `sticker (12).webp` in the next,
and a JSON export dropped into a folder that already holds media re-downloads
rather than reuses.

So an already-downloaded HTML export is a correct message-id → file map, and the
indexer reads it as one. Put a fresh JSON export in a *clean sibling folder* and
keep the old HTML folder next to it: JSON supplies the structure, the old folder
supplies the bytes. Nothing is re-downloaded and hand-pruned media survives.

## The floating-card layout

The chrome is a set of rounded cards sitting on the wallpaper, not full-bleed
bars welded to the window edge — matching the desktop app. `--inset` in
`theme.css` is the gap that lets the background show through between and around
them, and it is the single value to change if you want a tighter or airier look.

The chat header is deliberately **two** cards: identity on the left, actions on
the right, with wallpaper visible between them. `#chat-head` itself has
`pointer-events: none` so only the cards are clickable and the gap is not.

## Sizing media

Media elements get **explicit pixel dimensions** computed by `fitMedia()` in
`app/message.js`, derived from the export's own `width`/`height`.

Do not size media with CSS `max-width` plus `max-height` alone. Those clamp each
axis independently, so a 512×512 sticker in a 180×340 box renders 180×340 —
every sticker ends up the same shape, stretched. Computing the fit also reserves
exact space before the bytes arrive, which the phase 3 scroller depends on to
avoid jumping.

The lightbox sizes with `width: auto; height: auto` and both maxima, which is
safe there precisely because nothing constrains the other axis.

## How the scroller works

`app/scroller.js` keeps the column as one permanent `<section>` per chunk.
Sections near the viewport hold real bubbles; the rest hold only their own
height. Measured heights feed back into the estimate for unrendered chunks, so
the scrollbar converges on the truth as you explore.

Two invariants make this cheap, and both come from earlier phases:

- **Media carries explicit pixel dimensions**, so a chunk's height is final the
  moment it renders — images loading later never resize it.
- **Replies carry a denormalised preview**, so a chunk renders entirely on its
  own with no fetch for a neighbour.

Because the sections are permanent, there is always a stable element to measure
against. Every materialise/dematerialise captures the viewport's offset from the
chunk containing it and restores it afterwards, which is what keeps the view
still while content above changes height.

**Long jumps are instant, not smooth.** Assigning `scrollTop` cancels a smooth
scroll, and holding the anchor assigns `scrollTop` on every chunk that
materialises en route — so an animated jump across thousands of messages dies
partway and its destination gets released for being outside the band. Smooth
scrolling is used only when the target is already rendered and within two
screens.

Measured on a synthetic 120,000-message chat (240 chunks, 11 M px of scroll):
500–1,000 messages live, ~2,500 DOM nodes, median 8.3 ms/frame and p95 9.4 ms
while scrolling continuously, zero pixel drift when re-anchoring.

## Media notes

**Spoilers.** `media_spoiler: true` renders a heavy blur under a canvas of
drifting pale specks, matching the app's cover. Clicking reveals it with a
circle grown from the exact point of contact out to the furthest corner, while
the particles blow outward from the same origin. The reveal click is consumed,
so it does not also open the lightbox — the next click does. Media that is
genuinely missing keeps its placeholder instead of being covered, because
hiding an absent file behind a spoiler tells you nothing.

**Recovering media an export denied.** A partial or interrupted export writes
`"(File not included. Change data exporting settings to download.)"` even when
the file is sitting in `photos/`. It still records `photo_file_size`, `width`
and `height`, and those three together are a strong fingerprint. The indexer
builds a `(size, width, height)` index of every media file in the conversation
and reunites them — unambiguous matches first, then any remaining ties in
order, which lines up because messages are date-sorted and Telegram numbers
files in the order it writes them. The run report counts what it recovered.

Dimensions are read from file headers with no third-party library, and
dispatched on **magic bytes rather than the extension** — Telegram writes
sticker thumbnails as WebP while naming them `<sticker>.webp_thumb.jpg`, so
trusting the extension silently fails on a whole class of real files.

**Albums.** The export has no album field — a six-photo album is six separate
messages. What identifies them is a shared sender and an *exact* shared send
time, which is how `app/media/album.js` regroups them into one tiled bubble.

**Autoplay is gated.** GIFs, `.webm` stickers and video notes only decode while
on screen, through one shared `IntersectionObserver` in `app/media/visibility.js`.
They start with `preload="none"`, so scrolling past a thousand of them costs
nothing, and each rewinds when it leaves so re-entry restarts the loop.

**Voice waveforms are computed, not exported.** Telegram discards the waveform,
so `app/media/waveform.js` decodes the `.ogg` with WebAudio on first play,
reduces it to 48 peaks and caches them. If a browser can't decode Opus-in-Ogg
the bars render flat and the audio still plays.

**`.tgs` needs no library to *read*.** A `.tgs` is gzipped Lottie JSON, and
`DecompressionStream('gzip')` is built into the browser — fetch, inflate and
parse of a 512×512/60fps sticker measures ~6 ms with nothing vendored and
nothing downloaded.

*Playing* it is the open piece. Even a simple wave-hand sticker uses nested
precompositions (40 sub-layers), layer parenting, bezier keyframes, trim paths
and gradient strokes; a faithful player is a large project. So `app/media/tgs.js`
is built around a pluggable renderer:

```js
import { registerRenderer } from './media/tgs.js';
registerRenderer(({ container, animationData, loop }) => /* → {play, pause, destroy} */);
```

With no renderer registered, stickers show the still frame Telegram already
exported next to the `.tgs` — the same frame the app shows before an animation
loads, so the fallback reads as intentional. Dropping in `lottie-web` (one
vendored file) would light them up; the program stays offline either way.

## Test fixtures

Real exports rarely contain one of everything:

```bash
python3 tools/make_fixtures.py     # builds Backups/_MediaTest
python3 -m tools.tgindex
python3 tools/make_fixtures.py --remove
```

Generates a chat with a four-up album, a two-up album, a GIF, a video, a voice
note with a real amplitude envelope, a `.webm` sticker, a `.tgs` sticker, a
document and a deliberately-missing file. Needs `ffmpeg`; borrows photos and the
`.tgs` from whatever real exports are already present.

## Search

Whole words, case-folded, multi-word is AND — the same model Telegram search
uses. Two entry points: the sidebar box searches every message in every chat;
the magnifier in the chat header scopes to the open chat and steps through
matches with `↑`/`↓`, Enter, or `⌘F`.

Three things keep it cheap on a large archive:

- **Shards.** Postings live in files keyed by a token's first two characters, so
  a query fetches kilobytes, never the whole index.
- **Dates in the postings.** Each posting is `[chat index, message id, day]`, so
  results sort newest-first without opening a single chunk.
- **Paged hydration.** Message text is fetched only for the 30 results being
  displayed; scrolling loads the next page. A query matching thousands of
  messages still touches a handful of chunks.

Message *filenames* are indexed alongside text, so `notes.txt` finds the
document — useful in an archive, and the reason searching `sticker` returns
sticker sends.

## Group chats

Telegram exports groups as `private_group`/`public_group` with a `from_id` per
message, which is everything needed to tell people apart:

- **Every participant gets a colour**, used for their name, their reply quotes
  and their avatar fallback. Colours are assigned **per chat**, not by hashing
  the id alone — in a four-person group two people landing on the same colour
  is likely, and that defeats the point. The hash is a preference; a taken
  colour rolls to the next free one, busiest speaker first. Override it from a
  member's card.
- **A picture sits beside the last message of each run**, keyed by participant
  id — so one upload follows that person into every chat they appear in.
  Incoming rows always reserve the gutter, so bubbles share one left edge
  whether or not that row is the one showing the face.
- **Reactions carry the faces of who reacted.** The export's `recent` list has
  the ids; an emoji alone says nothing in a group of four.
- **A Members tab** leads the profile panel. Clicking someone's *picture* or
  the chevron opens their card — their colour, their id, and, when the archive
  has a one-to-one chat with them, that chat's own media library. Clicking
  their *name* jumps to that chat, or slides up a note saying there isn't one.

Service messages are spelled out (`Demm invited Alex`, `changed the group
photo`) rather than shown as raw action names.

## Profile panel

Opens from the chat header. Above the tabs it reports what the *backup* holds —
message count, date range, participants with per-person counts, and how many
export folders it was assembled from.

The seven tabs (Media, Files, Links, Music, Voice, GIFs, Stickers) come straight
from `media.json`. Stickers and GIFs are de-duplicated by content hash, which
matters because the same sticker is re-downloaded into every export under a new
` (N)` name — one chat's 120 sticker sends collapse to 80 distinct stickers.
Entries render in batches of 60 as you scroll, and clicking one jumps the
history to that message.

## Settings

Everything lives in `app/settings-schema.js` — one entry per setting. The panel
renders from that list, the search box filters that list, and defaults come from
that list, so adding a setting means editing exactly one file. A `cssVar` field
makes a setting apply itself; `reload: true` marks the ones that need the open
chat re-rendered.

Search matches labels, help text, group names **and** a `keywords` field, so
"night" finds *Colour theme* and "reindex" finds *Rebuild the index*.

Two details worth knowing if you extend it:

- **Opacity is composed, not baked in.** Base colours are opaque and bubbles use
  `color-mix(… var(--bubble-alpha) …)`. That way an imported theme supplies one
  solid colour and the opacity slider still works on top of it.
- **Reduce-motion is written inline.** The animation-speed setting also writes
  `--dur` inline, and an inline value always beats a stylesheet rule — so a
  `:root[data-reduce-motion]` rule would silently lose.

## Importing Telegram themes

Settings → Advanced → *Import a Telegram theme*. Three formats, no vendored code:

| Format | Source | How it's read |
|---|---|---|
| `.tdesktop-palette` | Desktop | `key: #rrggbb;` text, with `key: otherKey;` aliases resolved |
| `.tdesktop-theme` | Desktop | ZIP — central directory walked by hand, entries inflated with `DecompressionStream('deflate-raw')` |
| `.attheme` | Android | `key=value` text; values may be `#AARRGGBB` **or** signed 32-bit ARGB ints |

Note the byte orders differ: Desktop writes `RRGGBBAA`, Android writes
`AARRGGBB`. Both are handled.

The mapping is **deliberately lossy**. Telegram palettes carry hundreds of keys
and this UI has a few dozen, so `app/theme-import.js` maps the ~20 that carry a
theme's character and lets everything else fall back to the built-in palette.
The import reports how many keys matched (e.g. "matched 15 of 19"), and light
vs dark is inferred from the background's luminance. Sample themes in
`themes/` for testing.

## Keyboard

Press `?` for the list in-app. Bindings are declared once in `app/keyboard.js`
and the help sheet is generated from that same list.

| Keys | Action |
|---|---|
| `⌘K` | Search all messages |
| `⌘F` | Search this chat |
| `⌘,` | Settings |
| `↑` `↓` | Previous / next chat |
| `Home` `End` | Start / latest of a chat |
| `I` | Toggle the profile panel |
| `Esc` | Close the topmost open thing |
| `?` | Shortcut list |

## Measured on a 120,000-message archive

A synthetic chat spanning ~1.75 years (48 MB of export JSON, 240 chunks):

| | |
|---|---|
| Index build | 3.0 s |
| Index size | 48.9 MB (22 MB of it search) |
| Messages live in the DOM | 500 of 120,000 |
| DOM nodes | ~2,500 |
| Scroll height | 11 M px |
| Frame time, continuous scroll | median 8.3 ms, p95 9.6 ms |
| Frames over 32 ms | 6 of 360 |
| Search, 48,980 hits | 42 ms |
| Hydrating a 30-result page | 12 ms |

Regenerate the fixture from `tools/make_fixtures.py`, or the scale chat from the
snippet in the phase-7 notes.

## Index schema

Everything the viewer renders comes from here; it never reads a raw export.
Paths in `src`/`thumb` are relative to the backup root and are served under
`/media/`.

### `manifest.json`

```jsonc
{
  "schema": 1,
  "generated": 1785000000,
  "self_id": "user9000000001",   // auto-detected: the peer present in every chat
  "chats": [{
    "slug": "robin",             // url-safe id; the chats/<slug>/ folder name
    "name": "Robin",
    "type": "personal_chat",
    "messages": 1200,
    "first_date": 1700000000,    // unix seconds
    "last_date":  1710000000,
    "backed_up_at": 1710003600,  // newest export run; drives "Backed Up to ..."
    "avatar": "Robin/.../profile_pictures/photo.jpg",
    "chunks": 3,
    "peers": [{ "id": "user9000000001", "name": "Alex", "messages": 640 }],
    "media_counts":   { "sticker": 120, "photo": 30, "video": 2, "gif": 4 },
    "library_counts": { "media": 32, "stickers": 80, "gifs": 4, "links": 2 }
  }]
}
```

`media_counts` counts *messages*; `library_counts` counts what the profile
panel shows, after byte-identical stickers and GIFs are collapsed.

### `chats/<slug>/chunk-NNNN.json`

An array of messages, date-ascending, 500 per file.

```jsonc
{
  "id": 1001,
  "date": 1700000060,
  "from": "user9000000001",
  "from_name": "Alex",
  "edited": 1700000100,          // optional
  "reply_to": 1000,            // optional
  "text": [{ "type": "plain", "text": "hi" }],   // typed entities, always a list
  "reactions": [{ "emoji": "❤", "count": 1, "from": ["user9000000002"] }],
  "media": {
    "kind": "sticker",           // photo video gif sticker voice music round file unknown
    "src":  "Robin/ChatExport_2026-07-26/stickers/sticker.webp",
    "thumb":"Robin/ChatExport_2026-07-26/stickers/sticker.webp_thumb.jpg",
    "w": 502, "h": 512,
    "duration": 17,              // seconds, time-based media
    "name": "sticker.webp", "size": 40336, "mime": "image/webp",
    "emoji": "👋",
    "hash": "2a9b0b9e…"          // content digest; collapses library duplicates
  }
}
```

Service messages carry `"service": "<action>"` instead of a normal body.

**Missing media.** When no file can be found, `src`/`thumb` are absent and
`"missing": true` is set — but `w`/`h` survive, so the placeholder gets the real
aspect ratio. `"excluded": true` additionally means Telegram wrote
`"(File not included…)"`, i.e. the export settings skipped it rather than the
file being lost. Worth wording differently in the UI.

### `chats/<slug>/meta.json`

```jsonc
{
  "chunks": [{ "n": 0, "count": 500,
               "first_id": 1000, "last_id": 1499,
               "first_date": 1700000000, "last_date": 1705000000 }],
  "peers":   [...],
  "exports": [{ "rel": "Robin/ChatExport_2026-07-26", "exported_at": 1710003600,
                "has_json": true, "html_pages": 0 }]
}
```

Binary-search `chunks` to resolve both jump-to-date and jump-to-message.

### `chats/<slug>/media.json`

The profile panel's library tabs: `media`, `files`, `links`, `music`, `voice`,
`gifs`, `stickers`. Each entry carries `id` and `date` so clicking one can jump
to the message. `stickers` and `gifs` are de-duplicated by content hash.

### `search/`

Inverted index, whole words, case-folded — the same model Telegram search uses.
`shards.json` lists the shards; each shard is `{token: [chat_index, msg_id, …]}`
where `chat_index` indexes `manifest.chats`. Shard names are the hex-encoded
first two characters of the token, so a query fetches kilobytes rather than the
whole index. Narrow further with a substring check once messages are loaded.

## How media is resolved

For each message, in order — first hit wins:

1. the path in `result.json`, inside the export the message came from;
2. that same path in another export of the same conversation (a run with
   different download settings may hold the file);
3. the message-id → path map recovered from an HTML export.

The run report breaks down which route each file took, plus anything the
normalizer didn't recognise (`unhandled fields`, `unknown media`, service
actions) — so an unfamiliar export surfaces loudly instead of silently dropping
data.

## Phase status

- [x] **1 — Indexer, schema, server.** Merge/dedupe, media resolution, missing
      detection, chunking, library catalogs, search index, read-only server.
- [x] **2 — Shell.** Token-driven theming (light/dark/system, CSS wallpapers),
      chat list with backup dates, drag-resizable sidebar, bubbles, replies,
      reactions, inline media, spring motion.
- [x] **3 — Message engine.** Chunked windowed scroller with anchor-stable
      materialisation, day separators, floating date badge, cross-chunk
      jump-to-message, jump-to-date, jump-to-latest.
- [x] **4 — Media.** Albums, visibility-gated GIF autoplay, `.webm` stickers,
      `.tgs` inflate + static fallback, decoded voice waveforms, lightbox.
      *Animated `.tgs` playback needs a Lottie renderer — see below.*
- [x] **5 — Search and profile.** Global message search in the sidebar,
      scoped search in the chat header with match stepping, and a profile panel
      with seven de-duplicated library tabs on infinite scroll.
- [x] **6 — Theming and settings.** 33 searchable settings across five groups,
      Telegram theme import in all three formats, right-click menus.
- [x] **7 — Navigation and polish.** Keyboard shortcuts with a `?` help sheet,
      right-click menus, uploadable chat backgrounds, performance verified on a
      120,000-message archive.

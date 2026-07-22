# Huddle — spontaneous-call overlay

Desktop overlay for a closed group of friends: press the global shortcut, flip
yourself "up for a call in the next hour," see who else is. Spec:
[../specs/desktop-call-overlay.md](../specs/desktop-call-overlay.md).

Electron shell (spec's sanctioned fallback — no Rust toolchain on this machine);
all product logic is in `renderer/` behind the `window.huddle` bridge, so a
later Tauri port only replaces `main.js`/`preload.js`.

## Run (dev)

The backend must run with CORS enabled — the overlay is a `file://` page, so
set `CORS_ORIGINS=*` plus the Huddle vars on the server:

```powershell
# in the repo root — server
$env:HUDDLE_INVITE_CODES='some-secret-code'; $env:HUDDLE_CALL_LINK='https://your-call-room'; $env:CORS_ORIGINS='*'
npm run dev

# in huddle/ — the overlay
npm install
npm start                      # or: $env:HUDDLE_DEBUG='1'; npm start  (window opens immediately)
```

First launch shows onboarding: server URL (`https://ai.nicohillbrand.com` or
`http://localhost:8080` for dev), a **friend code**, and your name. The code
of the friend inviting you both creates your account and makes you two
friends; the very first member uses a bootstrap code from the server's
`HUDDLE_INVITE_CODES`. Entering **your own** code with your name pairs an
additional device onto your identity.

Friendship is pairwise and mutual: your roster shows only the people you've
added (and who thereby added you) — not everyone on the server. Friends of
your friends see nothing of you.

## Use

| Action | How |
|---|---|
| Show / hide | `Ctrl/Cmd+Shift+Space` (rebindable in settings), tray click, `Esc`/`✕` close to tray (Huddle keeps running), `–` minimizes to the taskbar. Quit via the tray menu. The overlay stays on screen until you explicitly hide it, and the window auto-sizes to your friends list. |
| The `+` menu | `+` in the header opens a small chooser: **I'm up for a call now** (go available) or **Propose something for later** (a coordination opportunity). Both composers step `back` to this chooser. |
| Go available | From the `+` chooser → "up for a call now": 30/60/90 min or custom (15–180), tick call types — each with **two optional times**: how long the offer stands ("offer", counts down) and the expected call length ("~call") — plus an optional note. Chips read "AI evals (~5min call)" — the offer countdown lives in the row above and only appears on a chip when that call type expires earlier than the signal. |
| Call type presets | click "Me (inactive)" (or settings → Call type presets…): add/remove and set per-preset visibility (everyone / **groups** / specific friends — mixable). Group visibility is a **live reference**: whoever is in the group when someone looks sees the call type, so editing "close" later changes visibility everywhere it's used. Defaults: get unstuck on a task, help me escape a local minimum, meditation, coworking, body doubling |
| Ping a friend | 👋 on their row — toast + notification on their overlay (throttled; tells you if they're offline) |
| Call a friend | `call` on an available friend's row sends a request; **they must accept** — then the room opens for both, with a **Copy link** button on the toast (e.g. to reshare over Messenger). The room is your own link if you set one (settings → My call link, e.g. a Google Meet), otherwise a fresh room from the server's `HUDDLE_CALL_LINK` template (`{room}` replaced per call; default Jitsi). Requests expire after 2 min and are single-use. |
| Propose an opportunity | From the `+` chooser → "Propose something for later" — write what you're proposing ("climbing Saturday morning?"), pick who sees it (**everyone**, a saved **group** in one tap, or tick **specific friends**), then choose **when**: **Sometime** (open-ended — how long the post stands: 4h/1d/3d/1w or custom up to two weeks, default 1d) or **At a set time** (pick a day, a start time, and an optional end — the post then reads as that window, e.g. "📅 Sat, Jul 25, 18:00–21:00", and stays up until the time passes, schedulable up to ~2 months out). It appears under **opportunities** on recipients' overlays with a notification; offline recipients get it on Telegram if linked. Recipients 👋 the poster to show interest; only you can take your post down (×), and it expires on its own. Max 5 open posts. Telegram `/post` still posts open-ended opportunities: `/post climbing Saturday?` to all friends, `/post to close: sauna?` to a group, `/post 90 to Ada, Bob: …` to named friends, and `/status` lists open posts (scheduled ones show their time). |
| Friend groups | settings → **Friend groups**: name a set of friends ("close", "climbing crew"), tick who's in it, then use it anywhere an audience is picked — post to it in one tap from the 📣 composer (a group chip pre-ticks its members; hand-editing the ticks turns the selection ad-hoc again), or set a call type's visibility to it. Groups live server-side, so Telegram shares them: `/groups` lists, `/groups set close Ada, Bob` creates/replaces, `/groups rm close` deletes. Groups are private to you — recipients never learn a group exists or who else is in it. Max 20 groups. |
| Quick-set from tray | right-click tray → "Available for 60 min" |
| Add / remove friends | settings → **My friend code** (click to copy, rotatable — rotation doesn't affect existing friends) to be added; paste a friend's code under **Friends** to add them. Removing a friend (×) is mutual — you disappear from each other's rosters. |
| Telegram (optional) | settings → **Telegram notifications** → Link: pings, call requests (with an inline **Accept** button) and friend-available updates reach you on Telegram whenever your overlay isn't running. Message the bot a bare `/up` for an inline picker of your call type presets, or `/up 60 coworking` for the quick path (free text never changes your availability — it chats with the representative). Presets sync two-way: overlay edits reach the bot, `/presets add`/`/presets rm` in the bot reach a live overlay instantly (and closed overlays on next launch). `/new` resets the representative-chat context (it also auto-trims when it grows too big). Requires the server to set `TELEGRAM_BOT_TOKEN`. |
| Telegram-only friends | no install needed at all: they message the bot `/join <your-friend-code> <their name>` and live entirely in Telegram — notifications, `/up` (with the preset picker), `/presets` to edit their call types, `/post` and `/groups`, `/status`, `/code`, `/addfriend`. |
| Settings (⚙ in header) | friend code + friends list, Telegram link, call type presets, shortcut recorder, **my call link** (your Meet/Zoom/... room, sent with your call requests), quiet pings (no sound), friend-available notifications, start at login, sign out |

True Google Meet room creation would require Google OAuth per user (Calendar
API) — the `{room}` template keeps that swappable later without app changes.

Activity and opportunity visibility is enforced **server-side** — the stream
and roster are filtered per viewer, so a client never even receives activities
or posts not shared with it, and only the poster ever sees a post's audience
list.

Signals auto-expire; nothing persists server-side except who's paired
(`data/presence-members.json`, gitignored — it holds device tokens).
Local state (token, server, name, activities, settings) lives in
`%APPDATA%/huddle/huddle-store.json`.

## Packaging (Windows installer)

`npm run dist` builds a per-user NSIS installer at `../release/Huddle-Setup-<version>.exe`
(electron-builder) — a single double-click installer. Autostart (launch-at-login) only takes effect in the packaged
app — a dev `npm start` run can't register a working login item, so it's guarded
on `app.isPackaged`. Fresh installs enable autostart by default until the user
makes an explicit choice; toggle it any time under settings → **start at login**.

Note: the build is unsigned, so SmartScreen shows a "unknown publisher" warning
on first run (More info → Run anyway). If electron-builder's `winCodeSign` unpack
fails with "Cannot create symbolic link", enable Windows Developer Mode or run the
build once from an elevated terminal — the macOS symlinks it trips on aren't used
for a Windows build.

## Not yet (Phase 2+)

macOS/Linux installers, code signing, extend-nudge, multiple groups. See spec §10.

### Coordination-opportunity ideas (future)

Building on scheduled/open-ended proposals — noted here so they aren't lost:

- **Multi-party opportunities**: a post that needs an "activation count" — it
  only fires (or nudges everyone) once N friends have shown interest ("3 people
  and we do it"), rather than being a pure one-way broadcast. The 👋 interest
  primitive already exists to build on.
- **Calendar availability**: let people mark free windows in the future and
  match proposals against them, instead of one-off scheduled posts. Would also
  benefit from a per-user timezone (see below).
- **Start-time reminders**: ping recipients (overlay + Telegram) when a
  scheduled opportunity is about to start, not just when it's posted.
- **Scheduling from Telegram**: `/post` is open-ended only; a natural-language
  or explicit time syntax for scheduled posts over Telegram is a follow-up.
- **Per-user timezones**: scheduled times are formatted in the viewer's local
  zone in the overlay, but Telegram notifications fall back to the server's
  zone (Telegram gives us no per-user zone). Store a member timezone to fix.

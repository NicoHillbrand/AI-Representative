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
| Go available | `+` in the header opens the composer: 30/60/90 min or custom (15–180), tick call types — each with **two optional times**: how long the offer stands ("offer", counts down) and the expected call length ("~call") — plus an optional note. Chips read "55min AI evals (~5min call)". |
| Call type presets | click "Me (inactive)" (or settings → Call type presets…): add/remove and set per-preset visibility (everyone / specific friends). Defaults: get unstuck on a task, meditation, coworking, body doubling |
| Ping a friend | 👋 on their row — toast + notification on their overlay (throttled; tells you if they're offline) |
| Call a friend | `call` on an available friend's row sends a request; **they must accept** — then the room opens for both, with a **Copy link** button on the toast (e.g. to reshare over Messenger). The room is your own link if you set one (settings → My call link, e.g. a Google Meet), otherwise a fresh room from the server's `HUDDLE_CALL_LINK` template (`{room}` replaced per call; default Jitsi). Requests expire after 2 min and are single-use. |
| Quick-set from tray | right-click tray → "Available for 60 min" |
| Add / remove friends | settings → **My friend code** (click to copy, rotatable — rotation doesn't affect existing friends) to be added; paste a friend's code under **Friends** to add them. Removing a friend (×) is mutual — you disappear from each other's rosters. |
| Telegram (optional) | settings → **Telegram notifications** → Link: pings, call requests (with an inline **Accept** button) and friend-available updates reach you on Telegram whenever your overlay isn't running. Message the bot `/up 60 coworking` — or plain words like "up for a call about X in the next hour" — to go available from your phone. Requires the server to set `TELEGRAM_BOT_TOKEN`. |
| Telegram-only friends | no install needed at all: they message the bot `/join <your-friend-code> <their name>` and live entirely in Telegram — notifications, `/up`, `/status`, `/code`, `/addfriend`. |
| Settings (⚙ in header) | friend code + friends list, Telegram link, call type presets, shortcut recorder, **my call link** (your Meet/Zoom/... room, sent with your call requests), quiet pings (no sound), friend-available notifications, start at login, sign out |

True Google Meet room creation would require Google OAuth per user (Calendar
API) — the `{room}` template keeps that swappable later without app changes.

Activity visibility is enforced **server-side** — the stream and roster are
filtered per viewer, so a client never even receives activities not shared
with it.

Signals auto-expire; nothing persists server-side except who's paired
(`data/presence-members.json`, gitignored — it holds device tokens).
Local state (token, server, name, activities, settings) lives in
`%APPDATA%/huddle/huddle-store.json`.

## Not yet (Phase 2+)

Packaging/installers (currently `npm start` only — autostart also only takes
effect once packaged), extend-nudge, multiple groups. See spec §10.

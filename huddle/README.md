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
`http://localhost:8080` for dev), invite code, your name. Pairing again with the
same name on another machine attaches it to the same identity.

## Use

| Action | How |
|---|---|
| Show / hide | `Ctrl/Cmd+Shift+Space` (rebindable in settings), tray click, `Esc` hides |
| Go available | `+` in the header opens the composer: 30/60/90 min or custom (15–180), tick call types — each with its own optional duration (chips read "30min coworking" and count down) — plus an optional note |
| Call type presets | click "Me (inactive)" (or settings → Call type presets…): add/remove and set per-preset visibility (everyone / specific friends). Defaults: get unstuck on a task, meditation, coworking, body doubling |
| Ping a friend | 👋 on their row — toast + notification on their overlay (throttled; tells you if they're offline) |
| Call a friend | `call` on an available friend's row sends a request; **they must accept** — then a fresh room (`HUDDLE_CALL_LINK` template, `{room}` replaced per call; default Jitsi) opens for both. Requests expire after 2 min and are single-use. |
| Quick-set from tray | right-click tray → "Available for 60 min" |
| Settings (⚙ in header) | call type presets, shortcut recorder, quiet pings (no sound), friend-available notifications, start at login, sign out |

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

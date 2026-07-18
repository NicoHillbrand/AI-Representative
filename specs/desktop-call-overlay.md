# Spec: Desktop "Spontaneous Call" Overlay (codename **Huddle**)

> Status: **Phase 1 built** (2026-07-17) · Author: Nico · Date: 2026-07-17
>
> Build notes — deviations/decisions vs. this draft:
> - **Electron, not Tauri** (the sanctioned fallback in §6.1): no Rust/MSVC
>   toolchain on the dev machine. The `platform`-adapter split was kept —
>   product logic lives in `huddle/renderer/` behind `window.huddle`.
> - §12 resolved: reusable static invite codes via `HUDDLE_INVITE_CODES` env;
>   single implicit group; one static call link via `HUDDLE_CALL_LINK`; roster
>   shows availability only (no online/connected state → **no heartbeat
>   endpoint**; SSE close events prune connections).
> - Paired members (identity + tokens) persist to `data/presence-members.json`
>   so a server restart doesn't force re-pairing; signals stay in-memory.
> - Code: backend `src/presence/store.ts` + routes in `src/server.ts`;
>   app in `huddle/` (see `huddle/README.md`).
>
> Same-day additions beyond this draft (2026-07-17):
> - **Activities**: a per-user bullet list (defaults: get unstuck on a task,
>   meditation, coworking, body doubling; user-extendable) attached to a
>   signal, each with per-friend visibility ("everyone" or chosen members).
>   Visibility is enforced server-side: roster + SSE updates are filtered per
>   viewer, so unshared activities never reach other clients.
> - **Pings**: `POST /api/presence/ping` routes a `ping-from` SSE event only to
>   the target's devices (3s per-pair throttle); shows as toast + notification.
> - **Settings view** (replaces footer; sign-out lives here): shortcut
>   recorder for the global show/hide keybind, quiet-pings toggle,
>   friend-available notification toggle, start-at-login toggle.
> - **Custom duration** input (15–180 min) next to the 30/60/90 presets.
> - Layout: own card separated from a labeled friends list; per-friend
>   `call` + `👋` actions on rows instead of footer buttons.
> - **Per-activity durations**: each ticked call type carries its own
>   minutes (default = the signal window); server stores per-activity
>   expiries, individually lapsed types drop out of rosters early, and chips
>   render as live countdowns ("30min coworking").
> - **Call handshake** (replaces the static call link): `call` sends a
>   request (`/api/presence/call-request`, 2-min TTL, single-use) → callee
>   accepts (`/api/presence/call-accept`) → server mints a fresh room from
>   the `HUDDLE_CALL_LINK` template (`{room}` slug; default Jitsi — real
>   Google Meet would need per-user OAuth) and pushes `call-start` with the
>   URL to both sides.
> - Views: main = status + friends only; `+` = composer (select types +
>   duration + note + go); clicking "Me (inactive)" or settings = call-type
>   manager (add/remove/visibility).
>
> A lightweight desktop overlay that lets a small group of friends signal
> "I'm up for a spontaneous call in the next hour" and instantly see who else is.
> Hidden by default, summoned with a global keyboard shortcut.

---

## 1. Goal

Lower the activation energy for a spontaneous voice/video call among a tight
group of friends. Today, hopping on a call requires someone to guess who's free
and send a message. This tool turns that into an ambient, low-pressure signal:
flip yourself "available for the next hour," and everyone who's also available
sees it and can start a call — no scheduling, no "you free?" ping-pong.

The overlay is **always running but invisible**. You summon it with a shortcut,
glance at who's around, optionally flip your own status, and dismiss it. It
should feel as cheap to open as Spotlight / a launcher.

## 2. Non-goals

- **Not** a full chat or messaging app. It signals availability; the actual call
  happens in whatever tool the group already uses (Discord, FaceTime, Meet…).
- **Not** a calendar or scheduler. It only ever means "in the next ~hour."
- **Not** a public/social product. Closed group, invite-only, no discovery.
- **Not** a persistent presence tracker ("online/offline"). It is an *intent*
  signal that the user explicitly sets and that auto-expires.

## 3. Users & trust model

- A single closed group of friends (initially just Nico + a handful of people).
- Everyone is trusted; there is no moderation, no blocking, no roles.
- Identity is per-device. A person installs the app, redeems an **invite code**,
  and gets a long-lived **device token** + a chosen display name.
- One person may run it on multiple devices; each device is its own token but
  shares the display name (server may dedupe presence by name — see §7.4).

Auth stays deliberately minimal — this reuses the pattern already in the
existing service (`bearer(req)` in `src/server.ts`, tokens in
`src/negotiation/store.ts`). No passwords, no OAuth.

## 4. Core concepts

| Concept | Meaning |
|---|---|
| **Availability signal** | A user-set intent: "I'm up for a spontaneous call." |
| **Window** | How long the signal lasts. Default 60 min; presets 30/60/90. |
| **Expiry** | A signal auto-clears at `setAt + window`. No manual "I'm done" needed, though clearing early is allowed. |
| **Presence roster** | The live list of group members and, for each, whether they're currently available and how much of their window remains. |
| **Note (optional)** | A short free-text hint attached to a signal, e.g. "gaming, hop in" or "walk, audio only". Max ~80 chars. |

Key rule: **availability is always self-declared and always temporary.** The
system never infers it from activity, and it always decays on its own.

## 5. UX / interaction design

### 5.1 Overlay window
- Small, frameless, always-on-top panel (~360×420 px), centered or last position.
- Hidden by default. Does **not** appear in the taskbar/dock; lives in the tray/
  menu bar only.
- Summon/dismiss with a **global shortcut** (default `Ctrl/Cmd + Shift + Space`,
  rebindable). Pressing it again, `Esc`, or clicking away hides it.
- Opening focuses the window so keyboard shortcuts work immediately.

### 5.2 Panel contents (top → bottom)
1. **Your status control** — a prominent toggle:
   - OFF: "Set me available" + window preset picker (30 / 60 / 90 min).
   - ON: "Available for 47 min" with a countdown, an optional note field, and a
     "Clear" button. Toggling window presets while ON re-bases the timer.
2. **Roster** — one row per other member:
   - Available members first, sorted by most-recently-set.
   - Each row: display name · availability dot · remaining time · optional note.
   - A row for an available friend has a subtle **"Start call"** action that
     opens the group's agreed call link (configurable URL, see §6.5) — the app
     does not host calls itself.
3. **Footer** — settings gear (shortcut, call link, display name, autostart),
   connection status dot (connected / reconnecting), version.

### 5.3 States to design for
- Not yet paired (needs invite code) → onboarding screen.
- Connected, nobody available → "Nobody's around right now. Be the first."
- Offline / server unreachable → banner + cached last-known roster (stale-marked).
- Your signal about to expire (< 5 min) → gentle "extend?" affordance.

### 5.4 Notifications (OS-level, optional per user)
- When a friend flips to available **while you are also currently available**,
  fire a native notification ("Anna is up for a call — 60 min"). Rationale:
  only nudge people who have themselves opted in right now, avoiding spam.
- Optionally also: notify when a friend becomes available and you are NOT
  available (toggle, default OFF).
- Never notify for expiries or for your own actions.

## 6. Architecture

```
┌────────────────────────┐         HTTPS (REST + SSE)          ┌───────────────────────────┐
│   Desktop overlay app   │  ── POST /api/presence/... ──▶       │  nicohillbrand.com service │
│   (Tauri, cross-OS)     │  ◀── SSE /api/presence/stream ──     │  (existing Node/Express)   │
│                         │                                     │  + new presence module     │
│  • global shortcut      │                                     │  • in-memory roster w/ TTL │
│  • tray icon            │                                     │  • invite/token auth       │
│  • web UI (HTML/JS)     │                                     │                            │
└────────────────────────┘                                     └───────────────────────────┘
```

### 6.1 Desktop framework — **Tauri v2** (recommended)
Chosen for the "easiest to have across multiple operating systems" priority:
- One codebase → Windows, macOS, Linux.
- Web-tech UI (HTML/CSS/JS) — reuses the frontend skills already used in
  `public/` (`index.html`, `chat.js`, `styles.css`), so the UI can look/feel
  consistent with the existing site.
- First-class **global shortcut**, **system tray**, **autostart**, and
  **native notification** plugins.
- Tiny footprint (~5–10 MB installer, low RAM) — right for an always-on tool.

**Fallback: Electron.** If the Rust toolchain / signing setup for Tauri proves
painful, Electron gives the same cross-platform reach with pure Node (which Nico
already knows) at the cost of size (~150 MB) and RAM. The app's own code is
structured so the choice is isolated to the shell layer (§8).

> The web-UI/native split means ~90% of the app (the UI + API client) is
> framework-agnostic. Keep all native calls (shortcut, tray, notifications,
> autostart) behind a thin `platform` adapter so Tauri↔Electron is a small swap.

### 6.2 Backend — extend the existing service
Add a `src/presence/` module to the current Express app, mirroring the shape of
`src/negotiation/`:
- `src/presence/store.ts` — in-memory roster keyed by member, TTL-based expiry
  (same idea as `negotiation/store.ts`'s 6h session TTL, but here TTL == signal
  window). Ships a background sweep to drop expired signals.
- `src/presence/routes.ts` (or inline in `server.ts`) — REST + SSE endpoints.
- Reuses existing `bearer()` auth helper and the `wrap()` error wrapper.

### 6.3 Why SSE, not WebSockets
The service already streams via **SSE** for chat (`respondStream`) and the deploy
notes already configure nginx for it (`proxy_buffering off`). Presence is a
low-frequency, server→client-push problem, so:
- **Client→server** state changes go over plain `POST` (set / clear / heartbeat).
- **Server→client** roster updates stream over a single **SSE** connection.

This avoids adding a WebSocket dependency and reuses infra that's already proven
in this codebase. (If bidirectional needs grow later, revisit WebSockets.)

### 6.4 Realtime flow
1. On launch, app opens `GET /api/presence/stream` (SSE, `Authorization: Bearer <token>`).
2. Server immediately sends a `roster` event (full snapshot), then incremental
   `update` events whenever anyone's signal changes or expires.
3. When the user flips their status, app `POST`s the change; server updates the
   roster and fans out an `update` to all connected streams.
4. App sends a lightweight `POST /api/presence/heartbeat` every ~30 s so the
   server can mark a device connected and prune dead SSE connections.

### 6.5 Call link (out of scope to host)
The "Start call" action just opens a URL. Store a single group-wide call link
(e.g. a persistent Discord/Meet/Jitsi room) in server config or per-group
settings; the app opens it in the default browser / app. No call hosting here.

## 7. Backend API (proposed)

All under the existing service. JSON. Auth via `Authorization: Bearer <deviceToken>`
except the pairing endpoint.

### 7.1 Pairing
```
POST /api/presence/pair
  body: { inviteCode: string, displayName: string }
  → 201 { deviceToken: string, memberId: string, displayName: string }
```
Invite codes are pre-generated (config list or an admin endpoint Nico calls).
A code may be single-use or reusable within the small group — TBD (§12).

### 7.2 Set / update availability
```
POST /api/presence/signal
  body: { windowMinutes: 30|60|90, note?: string }   // note ≤ 80 chars
  → 200 { availableUntil: ISO8601, note?: string }
```

### 7.3 Clear availability
```
DELETE /api/presence/signal   → 204
```

### 7.4 Roster snapshot (also pushed via SSE)
```
GET /api/presence/roster
  → 200 {
      members: [
        { memberId, displayName,
          available: boolean,
          availableUntil?: ISO8601,
          note?: string,
          connected: boolean }        // has a live device streaming
      ]
    }
```
If one person runs multiple devices, presence is deduped by `memberId`
(a member is "available" if any of their devices set it).

### 7.5 Stream
```
GET /api/presence/stream            (SSE)
  events:
    event: roster   data: <full snapshot as in 7.4>     // on connect
    event: update   data: { member: <single member obj> }  // on any change
    event: ping     data: {}                             // keep-alive ~20s
```

### 7.6 Heartbeat
```
POST /api/presence/heartbeat  → 204   // ~every 30s; marks device connected
```

### 7.7 Data model (in-memory, no DB for MVP)
```ts
type Member = {
  id: string;              // stable per person
  displayName: string;
  devices: Map<string, {  // keyed by deviceToken hash
    lastHeartbeat: number;
    stream?: SSEConnection;
  }>;
  signal?: {
    setAt: number;
    expiresAt: number;     // setAt + windowMinutes*60_000
    note?: string;
  };
};
```
Matches the codebase's current "in-memory, swap for Redis/SQLite later" stance
(see `src/negotiation/store.ts`). A member is *available* iff `signal` exists and
`now < signal.expiresAt`. A sweep runs every ~15 s to expire signals and emit
updates.

## 8. Desktop app design

### 8.1 Layout (Tauri)
```
src-tauri/            # Rust shell: window config, tray, shortcut, notif, autostart
  tauri.conf.json     # frameless, always-on-top, skipTaskbar, transparent
src/                  # web UI (framework-agnostic)
  ui/                 # panel, roster, status control, onboarding, settings
  api/                # REST client + SSE client (reconnect w/ backoff)
  platform/           # thin adapter over native: shortcut, tray, notify, store
  state/              # local state: token, displayName, settings, cached roster
```

### 8.2 Native behaviors
- **Global shortcut**: register on startup; rebindable in settings; persist choice.
- **Tray/menu-bar icon**: left-click toggles overlay; right-click menu = Set
  available (quick 60 min) / Clear / Settings / Quit. Icon reflects own status
  (e.g. filled dot when available).
- **Autostart**: opt-in "launch at login" toggle (Tauri autostart plugin).
- **Window**: frameless, always-on-top, `skipTaskbar`, hidden on blur/`Esc`.
- **Notifications**: native, per §5.4, guarded by a user setting.
- **Single instance**: enforce one running instance; second launch just shows.

### 8.3 Local persistence
Store `deviceToken`, `displayName`, `memberId`, shortcut binding, call link, and
notification/autostart prefs in the OS-appropriate app-data dir (Tauri store
plugin). Token is the only sensitive item — store it in the OS keychain if the
plugin supports it, else the app-data file with tightened perms.

### 8.4 Resilience
- SSE client auto-reconnects with exponential backoff; on reconnect, re-fetch the
  full roster snapshot.
- Show cached last-known roster (stale-marked) while disconnected.
- Clock skew: server is source of truth for `expiresAt`; UI counts down from the
  server timestamp, not local set time.

## 9. Privacy & data

- Only data stored: display name + current transient signal + connection status.
  No message content, no location, no history beyond the live window.
- Signals are visible only to the closed group (auth-gated).
- No analytics/telemetry to third parties.
- Signals auto-delete on expiry; nothing is persisted server-side across restarts
  in the MVP (in-memory only) — a server restart clears all presence, which is
  acceptable given the transient nature.

## 10. MVP scope & phases

**Phase 1 — MVP (the useful core):**
- Backend presence module (pair, signal, clear, roster, SSE stream, heartbeat).
- Tauri app: onboarding (invite code), overlay panel, global shortcut, tray,
  own status toggle with 60-min default, live roster, SSE with reconnect.
- Single group, hard-coded invite codes in config.

**Phase 2 — polish:**
- Notifications (§5.4), window presets (30/90), notes, "Start call" link,
  autostart, settings screen, own-status tray icon, multi-device dedupe.

**Phase 3 — nice-to-have:**
- Multiple groups; admin endpoint to mint invite codes; "extend window" nudge;
  optional persistence (SQLite) so a server restart keeps live signals;
  recurring "quiet hours" so notifications respect DND.

## 11. Rough acceptance criteria (Phase 1)

- [ ] A new user can pair with an invite code and pick a display name.
- [ ] Pressing the global shortcut shows/hides the overlay from anywhere; it
      never appears in the taskbar/dock.
- [ ] Setting myself available broadcasts to all connected members within ~1 s.
- [ ] My signal auto-clears at the window end without any action, and the roster
      reflects it for everyone within a few seconds.
- [ ] Killing/restarting the app reconnects and shows the correct live roster.
- [ ] Two members available simultaneously each see the other in the roster.

## 12. Open questions

1. **Invite codes**: single-use vs reusable? Who mints them (config file vs an
   admin endpoint)? Leaning: a small static list in config for MVP.
2. **Group scoping**: single implicit group for MVP, or model groups from day one?
   Leaning: single group now, `groupId` field reserved for later.
3. **Call link**: one group-wide static room, or per-signal ("call me here")?
   Leaning: one static group link for MVP.
4. **macOS specifics**: menu-bar-only apps need `LSUIElement`; confirm Tauri
   config + notarization/signing effort is acceptable (main Tauri-vs-Electron risk).
5. **Rate limiting / abuse**: trivial for a trusted group, but add a basic per-token
   cap on the existing `wrap()` path anyway?
6. **Presence privacy nuance**: should "connected but not available" be visible at
   all, or only show members who are actively available? Leaning: show name +
   available-or-not, hide raw connected state to avoid an "are you online" vibe.

---

### Appendix A — Relationship to the existing AI Representative service

This overlay is a **separate product** that happens to *reuse the same backend
deployment* (nicohillbrand.com Node/Express VPS) for convenience:
- Reuses: Express app, `bearer()` auth helper, `wrap()` error handling, the
  in-memory-store-with-TTL pattern, SSE streaming + nginx config.
- Adds: an isolated `src/presence/` module and a set of `/api/presence/*` routes.
- Shares nothing with the negotiation/chat logic or the Gemini LLM — no model
  calls are involved in presence at all (zero LLM cost).

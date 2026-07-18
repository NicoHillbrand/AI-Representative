# Spec: Call Coordination + Overlay (extends AI_Representative)

Status: draft v0, for a coding agent to build.
Scope owner: Nico. This spec assumes it is built **inside the existing AI_Representative service**, not as a new repo.

## Why this lives here

AI_Representative is already the always-on VPS service (Node/TS, Express, systemd + nginx on nicohillbrand.com) with a public API, a public chat UI, and an agent-to-agent negotiation gate that keeps private interests un-leakable. This feature reuses all of that: the deploy, the public API surface, the provider-swappable LLM layer (`src/llm.ts`), and especially the public/private separation pattern in `src/negotiation/`. Do not fork a new service.

## What we're adding

Two modules:

1. **Call coordination** — Nico expresses an intent ("I want a short purposeful call in the next ~hour"); the agent finds candidate friends, invites them, collects a response, and notifies Nico. Call types: `coworking`, `topic-discussion`, `meditation` (extensible).
2. **Overlay client** — a thin desktop client of this API. Same codebase serves two roles by credential/scope:
   - **Nico's overlay** (private, full control): hotkey-summoned; fire a call intent; receive notifications + spoken TTS.
   - **Distributable overlay** (public, scoped): a friend installs it to talk to Nico's representative and to let *their* agent negotiate with Nico's via the existing a2a negotiation protocol. This is the desktop front-end for `src/negotiation/`.

## Build order (important)

1. Coordination API + datastore (server-side).
2. Nico's own overlay (input: fire intent; output: notifications + TTS via the existing laptop TTS pipeline). Nico uses this daily, so it's the priority client.
3. **Only then**, and only if there's real pull, the distributable/public overlay. Desktop install friction is high; the website chat stays the zero-install primary public surface. Do not build an installer before the core loop works end to end.

## MVP = one vertical slice

The friend-call coordination happy path, end to end:

1. Nico fires an intent (from his overlay, or later a Flic button): `{ callType, windowStart, windowEnd, topic?, friendId? }`.
2. Agent builds a shortlist of candidate friends (from the friends store) or uses the named friend.
3. Agent sends each candidate a lightweight invite containing a **capability link** (unguessable token). Delivery channel for MVP: see Open Questions (default email).
4. Friend opens the link, sees the proposed call (type + window), and accepts / declines / proposes-another-time on a minimal web page.
5. On accept, agent notifies Nico via his overlay + TTS with the confirmed friend, time, and type. Optional: create a calendar event / meeting link.

MVP includes: the API, the friends store, the invite page, one Nico input surface, one Nico output surface (overlay + TTS).
MVP excludes: distributable overlay, Flic button integration (can be added trivially later since it just POSTs the same intent), video, MCP wrapper, multi-friend simultaneous scheduling.

## Data model (MVP)

- **Friend**: `id, name, contactChannel (email|other), timezone, availabilityHints, callTypesInterested[], notes, lastCoordinatedAt`
- **CallRequest**: `id, createdAt, windowStart, windowEnd, callType, topic?, status (open|dispatched|confirmed|expired|cancelled), candidateFriendIds[], invitedFriendIds[], acceptedFriendId?, meetingLink?`
- **Invite**: `id, callRequestId, friendId, token (unguessable), status (sent|opened|accepted|declined|proposed-alt), proposedTime?`
- **NicoNotification**: `id, createdAt, kind, message, delivered { overlay, tts }`

Persistence: SQLite (low volume). Mirror the existing pattern — the negotiation store is in-memory today (`src/negotiation/store.ts`); coordination needs durability across restarts, so use SQLite from the start for these entities.

## API endpoints (added to the existing Express app)

Nico-authed (Bearer, a shared secret in `.env`; the Flic button will later carry this token in a header or the URL path):
- `POST /api/coordination/intent` — create a CallRequest. Body: `{ callType, windowStart, windowEnd, topic?, friendId? }`.
- `GET  /api/coordination/friends` — list friends (via context adapter, see below).
- `POST /api/coordination/call-requests/:id/dispatch` — pick candidates + send invites (may run automatically on intent create).
- `GET  /api/coordination/notifications/stream` — SSE stream the overlay subscribes to (reuse the existing SSE setup from `/api/chat`; nginx is already SSE-friendly).

Public via capability token (no account needed; possessing the link = permission for that one invite):
- `GET  /invite/:token` — invite page data.
- `POST /invite/:token/respond` — `{ response: accept|decline|propose, proposedTime? }`.

Reuse existing: `/api/chat`, `/api/negotiate/*`, `/openapi.json`, `/healthz`. Add the new paths to `openapi.ts`.

## Auth & security

- **Nico endpoints**: Bearer shared secret from `.env`. Never log the token; keep it out of query strings.
- **Friend invites**: capability-URL model — unguessable token in the link is the only credential. No friend accounts for MVP.
- **Public overlay / representative**: scoped to the public surface only. Reuse the negotiation gate's core guarantee — the LLM that talks to outsiders must never receive private data (friends list, notes, hidden interests). Private coordination data lives behind the Nico-authed endpoints only.
- Rate-limit `/api/*` (already listed as a hardening idea in the README).

## Context adapter (link to NicoAgent, kept narrow)

The friends list / preferences may originate from Nico's private context (currently NicoAgent markdown). Access it through a **single adapter module** (`src/coordination/context-adapter.ts`) exposing `getFriends()` / `getFriendContext(id)`. For MVP back it with a local JSON/SQLite seed. Never read NicoAgent files directly elsewhere; the adapter is the only crossing point, so the source can later change (local → synced → API) by editing one file.

## Notifications to Nico (output)

NOT into any chat. Nico's laptop runs a small listener that subscribes to `/api/coordination/notifications/stream` and, per message: (a) shows it in the overlay, (b) speaks it via the existing TTS pipeline (edge-tts `en-US-AvaNeural` -> mp3 -> `speak.ps1`, played in background). Keep spoken text to 1-2 short sentences.

## Overlay client (thin, config-driven)

- A small desktop app (Electron/Tauri, or a hotkey-summoned local webview). It is a **pure client of this API** — no business logic. Role is set by config + token:
  - Nico config: full controls (fire intent, see notifications, admin). Points at Nico-authed endpoints.
  - Public config: chat with the representative + a2a negotiation only. Points at public endpoints.
- Because it's one codebase, the distributable version is the Nico overlay with private controls hidden and credentials swapped. Build it that way from the start (feature-flag the private controls) so the public build falls out for free later.

## Non-goals (design so they slot in later)

Flic button wiring (later; just POSTs `/api/coordination/intent`), video streams, a local always-on box, distributable-overlay installer, friend accounts, group scheduling. Hub-and-spoke + the context adapter are what keep these cheap to add.

## Open questions for Nico

1. Invite delivery channel for MVP: email (simplest), or a specific messenger?
2. Auto-pick candidate friends, or always present Nico a shortlist to approve before inviting?
3. Google Calendar event creation in MVP or later? (Calendar access is available.)
4. Overlay tech preference (Electron vs Tauri vs lightweight webview)?

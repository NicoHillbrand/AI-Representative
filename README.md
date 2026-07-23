# AI Representative + Huddle

Two things in one small server, live at [ai.nicohillbrand.com](https://ai.nicohillbrand.com):

1. **Public chat UI** — talk to an AI grounded in Nico's life-strategy document.
2. **Public API** — `POST /api/chat`, plus the negotiation endpoints.
3. **API docs** — human docs at `/docs.html`, machine spec at `/openapi.json`.
4. **Agent-to-agent negotiation** — another agent connects and, through a
   **gated mutual-interest protocol**, discovers collaborations without either
   side leaking its private position unilaterally.
5. **Huddle** — a desktop overlay ([`huddle/`](huddle/README.md)) for friends to
   signal "up for a spontaneous call in the next hour", see who else is, and
   hop into a call by mutual consent.

Built with Node/TypeScript and Express; LLM calls go through the Google Gen AI
SDK (`gemini-3.5-flash` by default, classifier on `gemini-3.1-flash-lite`).
The whole LLM layer lives in `src/llm.ts`, so swapping providers is a one-file
change. Huddle uses no LLM at all.

Fork it to run your own representative: swap `content/public-doc.md` (what it
knows) and `content/interests.ts` (what it wants), set your key, deploy.

## The negotiation gate (the interesting part)

Two planes, so hidden interests can't leak:

- **Matching plane** (`src/negotiation/matcher.ts`, `content/interests.ts`) — holds
  the full interest set, including **hidden** ones. It classifies what the
  counterpart asserts and computes matches **deterministically**. This is the only
  place the hidden registry is read.
- **Conversational plane** (`src/negotiation/negotiate.ts`) — the LLM that actually
  replies to the counterpart. It is given **only** the public doc + the matches that
  have already been confirmed for the session. It never receives the hidden registry,
  so no prompt-injection or fishing can extract an unmatched hidden interest — the
  model doesn't have it to leak.

A hidden interest is confirmed **only** when the counterpart's agent independently
asserts the same interest. The only things that leave a session are turn replies,
confirmed matches, and a bounded end-of-session summary.

`content/interests.ts` is **gitignored** — its hidden entries are private by
definition, so the real registry never enters the repo. On a fresh clone the
dev/start/typecheck scripts create it automatically from
`content/interests.example.ts`; edit the created copy. When deploying, copy
your real `interests.ts` to the server by hand (it won't arrive via git).

### Private context (`content/private.ts`, also gitignored)

Context for the **chat** representative that stays out of git, bootstrapped
from `content/private.example.ts` the same way:

- `PRIVATE_CONTEXT` — inline text spliced into the system prompt (personal
  details, standing instructions, secrets with reveal conditions).
- `PRIVATE_SOURCES` — pointers to files elsewhere on the machine (other
  repos' READMEs, project notes). Each file is re-read whenever it changes on
  disk, so the representative stays current without a restart. Missing files
  are skipped with a warning.

Unlike hidden interests (never in the chat model's context, structurally
unleakable), private context **is** in the chat model's context and is guarded
only by instructions — a determined jailbreak can extract it. Use it only where
instruction-level secrecy is enough. Deploying: copy `private.ts` up by hand,
and make sure any `PRIVATE_SOURCES` paths exist on the server.

## Huddle (the overlay)

An Electron tray overlay in [`huddle/`](huddle/README.md); the presence backend
(`src/presence/`) runs inside this same server. Design highlights:

- **Pairwise friend graph** — every member has a personal, rotatable friend
  code. Joining the server with a friend's code creates your account *and*
  makes you two friends; your roster shows only your own friends. Everything
  (roster, live updates, pings, call requests) is filtered by friendship
  **server-side** — friends-of-friends never receive your data.
- **Calls by mutual consent** — request → accept → a room opens for both, with
  a copyable link. Your own room link (e.g. Google Meet) rides along with your
  requests; otherwise the server mints one from `HUDDLE_CALL_LINK`.
- **Nothing sensitive persists server-side** except who's paired and the friend
  graph (`data/presence-members.json`, gitignored). Availability signals are
  in-memory and expire on their own.
- **Telegram bridge (optional)** — set `TELEGRAM_BOT_TOKEN` and one bot serves
  both worlds: anyone can chat with the representative on Telegram or run the
  mutual-interest protocol with `/negotiate` (confirmed matches + summary,
  same two-plane engine as the API), and Huddle members who link it (overlay
  settings) get notifications there when their overlay is closed — including
  accepting call requests — and can go available with `/up` (bare for a
  preset picker, or `/up 60 coworking`).

To run it: `cd huddle && npm install && npm start`, then enter the server URL
and the friend code of whoever invited you. Full details in
[huddle/README.md](huddle/README.md).

**Desktop installer (Windows):** `cd huddle && npm run dist` builds a per-user
installer at `release/Huddle-Setup-<version>.exe` (electron-builder) — a single
double-click installer that adds Start-menu/desktop shortcuts and starts with
Windows by default. The `release/` folder is gitignored (it's a build artifact);
share the `.exe` directly with friends. See
[huddle/README.md](huddle/README.md#packaging-windows-installer) for
signing/SmartScreen notes.

## Forwarding feed (`src/forwarding/`)

A private inbox of things worth Nico's attention, fed from two directions and
read only by him.

- **From chats** — the representative now *offers to forward* messages instead
  of just handing out an email. After each turn a **loose, intuition-based
  classifier** (on the cheap classifier model) judges whether the visitor was
  trying to reach Nico and whether it's worth passing on — a real coordination
  opportunity or a sincere person reaching out, versus spam or an idle question
  already answered. Worthy items land in the feed; either way the classifier's
  verdict is shown back to the visitor (a chip in the web UI, a follow-up line
  on Telegram). The chat path sees only the **public** interest list, so the
  reason it shows a visitor can't leak anything private.
- **From external APIs** — a scheduler (`FORWARD_POLL_HOURS`, default 12 =
  twice a day) walks each enabled source, dedupes against what it's already
  filed, and runs new items past the same classifier. Sources are pluggable
  (`src/forwarding/sources/`); **Hacker News** ships as a working example. Turn
  them on with `FORWARD_SOURCES=hackernews` — empty means the scheduler stays
  idle.

**Reading it** is gated by a single `OWNER_TOKEN` (blank = the whole retrieval
side is disabled):

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/forwards` | The feed as JSON (`?limit`, `?since`, `?unread=1`, `?category`). Bearer `OWNER_TOKEN`. |
| POST | `/api/forwards` | Push an item in directly (`{ title, summary?, detail?, contact?, url?, category?, externalId? }`) — for Nico's own agent to forward things to himself. Bearer `OWNER_TOKEN`. |
| POST | `/api/forwards/read` | Mark items read (`{ ids?: string[] }`; omit for all). Bearer `OWNER_TOKEN`. |

Point an agent (e.g. Slay the List) at `GET /api/forwards` with the token and
ask it to summarize, or open **`/forwards.html`** for a simple authed viewer.
These routes are deliberately kept out of the public OpenAPI spec, like the
Huddle presence API. The feed persists to `data/forwards.json` (gitignored).

**Connecting your own agent** — [`mcp/`](mcp/README.md) is a self-contained MCP
server (its own package, so it never bloats the deployed server) exposing these
as agent tools: `list_forwards`, `forward_to_self`, `mark_forwards_read`, and
`who_is_up` (which reads the Huddle roster with a device token). Either set it up
by hand ([mcp/README.md](mcp/README.md)) or just **point your own agent at the
repo and tell it to follow [mcp/AGENT_SETUP.md](mcp/AGENT_SETUP.md)** — that file
is written as executable steps an agent can run to wire itself up.

## Run your own (local)

```bash
npm install
cp .env.example .env      # add your GEMINI_API_KEY (free from https://aistudio.google.com/apikey)
npm run dev               # http://localhost:8080
```

- `npm run dev` — hot-reloading dev server (tsx).
- `npm start` — run the server (tsx, no build step needed).
- `npm run typecheck` — type-check without emitting.

Models are set in `.env` (`MODEL`, `CLASSIFIER_MODEL`). `src/llm.ts` picks the
right "thinking" knob per model generation (Gemini 3.x `thinkingLevel`, 2.x
`thinkingBudget`), keeping replies cheap and untruncated on flash-class models.

For the overlay against a local server you also need `CORS_ORIGINS=*` (the
overlay is a `file://` page) and a `HUDDLE_INVITE_CODES` bootstrap code.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/chat` | Chat with the representative (`stream: true` for SSE). |
| GET  | `/api/interests` | List the **public** interests. |
| POST | `/api/negotiate/sessions` | Open a negotiation session → `{ sessionId, token }`. |
| POST | `/api/negotiate/sessions/:id/messages` | Send a message (Bearer token). |
| GET  | `/api/negotiate/sessions/:id/summary` | Bounded summary + confirmed matches (Bearer token). |
| GET  | `/openapi.json` | OpenAPI 3.1 spec. |
| GET  | `/healthz` | Health check. |

Negotiation sessions are in-memory and expire after 6 hours (a restart clears
them); swap `src/negotiation/store.ts` for Redis/SQLite if you need more.
The `/api/presence/*` routes are Huddle's private API (device-token auth) —
see `src/server.ts`; they're deliberately not in the public docs.

## Deploying (the pattern running in production)

Caddy in front (automatic HTTPS, SSE just works), the app under systemd as a
dedicated user, secrets in `/etc` with mode 600:

```bash
sudo git clone https://github.com/NicoHillbrand/AI-Representative.git /opt/ai-representative
sudo useradd --system --home /opt/ai-representative --shell /usr/sbin/nologin airep
# copy your REAL content/interests.ts + content/private.ts up by hand (gitignored)
cd /opt/ai-representative && sudo -u airep npm install && sudo chown -R airep:airep .

sudo mkdir -p /etc/ai-representative
sudo tee /etc/ai-representative/ai-representative.env >/dev/null <<'EOF'
GEMINI_API_KEY=your-key
PORT=8091
PUBLIC_BASE_URL=https://your.domain
CORS_ORIGINS=*
HUDDLE_INVITE_CODES=one-time-bootstrap-code
EOF
sudo chmod 600 /etc/ai-representative/ai-representative.env
```

Systemd unit (`/etc/systemd/system/ai-representative.service`):

```ini
[Unit]
Description=AI Representative
After=network.target

[Service]
Type=simple
User=airep
WorkingDirectory=/opt/ai-representative
EnvironmentFile=/etc/ai-representative/ai-representative.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Caddyfile block:

```caddy
your.domain {
  encode gzip zstd
  reverse_proxy 127.0.0.1:8091
}
```

```bash
sudo systemctl enable --now ai-representative
sudo systemctl reload caddy
```

Then pair your own overlay with the bootstrap code, **blank
`HUDDLE_INVITE_CODES` and restart** — from then on the only way in is a
member's personal friend code.

Updating later: `sudo -u airep git pull && sudo systemctl restart ai-representative`
(your `interests.ts` and `data/` are untouched by pulls).

## Notes & next steps

- **Streaming** works end-to-end for `/api/chat`; negotiation turns are
  request/response (a turn is a classification step + a reply).
- **Cost/latency**: the classifier uses Gemini structured output
  (`responseSchema`) on a cheap model. Tune `MODEL` / `CLASSIFIER_MODEL` in
  the env to trade cost against quality.
- **Hardening ideas**: rate-limit `/api/*`, add a global API key for the
  negotiation endpoints if you don't want them fully open, move sessions to a
  real store.
- **Huddle desktop app**: packaged with electron-builder (`cd huddle && npm run
  dist`) so friends don't need Node; autostart is on by default in the installed
  app. Next: code signing (unsigned builds trip SmartScreen), macOS/Linux targets.

# AI Representative — nicohillbrand.com

An AI representative of Nico Hillbrand with four surfaces:

1. **Public chat UI** — talk to an AI grounded in Nico's life-strategy document.
2. **Public API** — `POST /api/chat`, plus the negotiation endpoints.
3. **API docs** — human docs at `/docs.html`, machine spec at `/openapi.json`.
4. **Agent-to-agent negotiation** — another agent connects to Nico's agent and,
   through a **gated mutual-interest protocol**, discovers collaborations without
   either side leaking its private position unilaterally.

Built with Node/TypeScript, Express, and the Google Gen AI SDK (`gemini-2.5-flash`
by default). The whole LLM layer lives in `src/llm.ts`, so swapping providers is a
one-file change.

## The negotiation gate (the interesting part)

Two planes, so hidden interests can't leak:

- **Matching plane** (`src/negotiation/matcher.ts`, `content/interests.ts`) — holds
  Nico's full interest set, including **hidden** ones. It classifies what the
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

Edit `content/interests.ts` to change what Nico is (publicly / privately) interested in,
and `content/public-doc.md` to change what the representative knows.

`content/interests.ts` is **gitignored** — its hidden entries are private by
definition, so the real registry never enters the repo. On a fresh clone the
dev/start/typecheck scripts create it automatically from
`content/interests.example.ts`; edit the created copy. When deploying, copy
your real `interests.ts` to the server by hand (it won't arrive via git).

## Local setup

```bash
npm install
cp .env.example .env      # add your GEMINI_API_KEY (free from https://aistudio.google.com/apikey)
npm run dev               # http://localhost:8080
```

- `npm run dev` — hot-reloading dev server (tsx).
- `npm start` — run the server (tsx, no build step needed).
- `npm run typecheck` — type-check without emitting.

Auth: the Gemini client reads `GEMINI_API_KEY` from `.env`. On `gemini-2.5-flash`
(and `-flash-lite`) `src/llm.ts` disables model "thinking" so short replies don't
get truncated on the free tier; on `gemini-2.5-pro` thinking stays on.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/chat` | Chat with the representative (`stream: true` for SSE). |
| GET  | `/api/interests` | List Nico's **public** interests. |
| POST | `/api/negotiate/sessions` | Open a negotiation session → `{ sessionId, token }`. |
| POST | `/api/negotiate/sessions/:id/messages` | Send a message (Bearer token). |
| GET  | `/api/negotiate/sessions/:id/summary` | Bounded summary + confirmed matches (Bearer token). |
| GET  | `/openapi.json` | OpenAPI 3.1 spec. |
| GET  | `/healthz` | Health check. |

Sessions are in-memory and expire after 6 hours (a server restart clears them).
For production persistence, swap `src/negotiation/store.ts` for Redis/SQLite.

## Deploying to the VPS (nicohillbrand.com)

1. **Install Node 20+** and clone the repo onto the VPS.
2. **Configure** `.env` with your `GEMINI_API_KEY`, `PORT=8080`, and
   `PUBLIC_BASE_URL=https://nicohillbrand.com`.
3. **Run it under systemd** so it restarts on boot/crash:

   ```ini
   # /etc/systemd/system/ai-representative.service
   [Unit]
   Description=AI Representative
   After=network.target

   [Service]
   WorkingDirectory=/opt/ai-representative
   ExecStart=/usr/bin/npm start
   Restart=always
   Environment=NODE_ENV=production
   EnvironmentFile=/opt/ai-representative/.env
   User=www-data

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl enable --now ai-representative
   ```

4. **Reverse-proxy with nginx** (TLS via certbot). Note the SSE-friendly settings:

   ```nginx
   server {
     server_name nicohillbrand.com;
     location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $remote_addr;
       # Streaming (SSE) needs buffering off:
       proxy_buffering off;
       proxy_cache off;
       proxy_read_timeout 300s;
     }
   }
   ```

   ```bash
   sudo certbot --nginx -d nicohillbrand.com
   ```

That's it — the chat UI, negotiation sandbox, and docs are all served from the
same process.

## Notes & next steps

- **Streaming** works end-to-end for `/api/chat`; the negotiation turns are
  request/response (a turn involves a classification step + a reply).
- **Cost/latency**: everything runs on `gemini-2.5-flash` by default (free-tier
  friendly). The classifier uses Gemini structured output (`responseSchema`).
  Tune the model in `.env` (`gemini-2.5-flash-lite` is cheapest, `gemini-2.5-pro`
  is strongest).
- **Hardening ideas**: rate-limit `/api/*`, add a global API key for the negotiation
  endpoints if you don't want them fully open, and move sessions to a real store.

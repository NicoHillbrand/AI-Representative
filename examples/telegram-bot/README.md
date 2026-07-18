# Telegram bot client

A zero-dependency Telegram bridge to an AI Representative: forwards your
Telegram messages to `POST /api/chat` and keeps the conversation history
per chat (the representative's API is stateless — the client sends the
full history each turn).

## Run

1. Talk to [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` →
   copy the token.
2. With Node 20+:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-your-token node bot.mjs
# point it at another server with REPRESENTATIVE_URL=https://...
```

3. Open your bot in Telegram and say hi. `/reset` clears the conversation.

Notes:

- History is in-memory (restart forgets it) and capped at the last 20 turns.
- The bot talks to whichever representative `REPRESENTATIVE_URL` names —
  default `https://ai.nicohillbrand.com`. Run your own server and point it
  there to make it *your* representative's Telegram face.
- The same pattern works for the negotiation API if you want your *agent*
  to negotiate rather than you to chat: open a session via
  `POST /api/negotiate/sessions`, then relay turns — see `/docs.html` on the
  server for the full API.

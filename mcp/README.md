# AI Representative — MCP server

A small [Model Context Protocol](https://modelcontextprotocol.io) server that
gives *your own* agent (Claude Code, Claude Desktop, the Agent SDK, anything
that speaks MCP) tools to reach the private, owner-only side of your running
representative:

| Tool | What it does | Needs |
|---|---|---|
| `list_forwards` | Read messages forwarded to you (website chats, the scheduled poller, agent pushes). Newest first; filter by unread/category. | `OWNER_TOKEN` |
| `forward_to_self` | Push an item into your feed — a note, a reminder, something worth your attention. | `OWNER_TOKEN` |
| `mark_forwards_read` | Mark items read (specific ids, or all). | `OWNER_TOKEN` |
| `who_is_up` | See which Huddle friends are up for a spontaneous call right now, and what for. | `PRESENCE_DEVICE_TOKEN` |

It talks to the server **over HTTP**, so it runs anywhere — your laptop, wherever
your agent lives — and just needs the base URL and your tokens as env vars. It
never holds the feed itself; the server is the source of truth.

> **Letting an agent set this up for you:** point your agent at this repo and
> tell it to follow [`AGENT_SETUP.md`](AGENT_SETUP.md) — it's the same steps
> below, written as instructions an agent can execute (install, ask you for the
> tokens, write the config into its own project). The rest of this file is the
> manual version.

## 1. Install

```bash
cd mcp
npm install         # Node 18+ (uses global fetch)
```

You can also copy this whole `mcp/` folder somewhere else — it's self-contained.

## 2. Get your tokens

- **`OWNER_TOKEN`** — the same value set as `OWNER_TOKEN` in the server's env
  file (the one that gates `/api/forwards`). This is a secret; treat it like a
  password.
- **`PRESENCE_DEVICE_TOKEN`** *(only for `who_is_up`)* — a Huddle device token
  tied to your identity. Mint one without touching the overlay by pairing with
  your **own** friend code and your **own** display name (this attaches a new
  device token to your existing account rather than creating a new person):

  ```bash
  curl -s -X POST https://ai.nicohillbrand.com/api/presence/pair \
    -H "Content-Type: application/json" \
    -d '{"code":"<your-friend-code>","displayName":"<Your exact Huddle name>"}'
  # -> { "deviceToken": "...", ... }
  ```

  Your friend code is in the overlay under **settings → My friend code**. Save
  the returned `deviceToken`; it persists across restarts. Skip this if you
  don't need `who_is_up`.

## 3. Wire it into your agent

### Claude Code (project-scoped `.mcp.json`)

Drop this in your agent project's `.mcp.json` (use an **absolute** path to
`server.mjs`):

```json
{
  "mcpServers": {
    "ai-representative": {
      "command": "node",
      "args": ["/absolute/path/to/AI-Representative/mcp/server.mjs"],
      "env": {
        "REPRESENTATIVE_BASE_URL": "https://ai.nicohillbrand.com",
        "OWNER_TOKEN": "your-owner-token",
        "PRESENCE_DEVICE_TOKEN": "your-device-token"
      }
    }
  }
}
```

Or add it from the CLI:

```bash
claude mcp add ai-representative \
  -e REPRESENTATIVE_BASE_URL=https://ai.nicohillbrand.com \
  -e OWNER_TOKEN=your-owner-token \
  -e PRESENCE_DEVICE_TOKEN=your-device-token \
  -- node /absolute/path/to/AI-Representative/mcp/server.mjs
```

### Claude Desktop

Add the same block to `claude_desktop_config.json` (Settings → Developer → Edit
Config), then restart the app.

## 4. Use it

Ask your agent things like:

- *"Summarize what's been forwarded to me — anything I should act on?"* → it
  calls `list_forwards`, and can `mark_forwards_read` once you've seen them.
- *"Forward this to my feed: follow up with Jane about the Berlin talk."* →
  `forward_to_self`.
- *"Is anyone up for a call right now?"* → `who_is_up`.

## Notes

- **Secrets:** the env block holds real tokens — keep `.mcp.json` /
  `claude_desktop_config.json` out of any shared repo, or inject the values
  from your own secret store.
- **`REPRESENTATIVE_BASE_URL`** defaults to `https://ai.nicohillbrand.com`. Point
  it at your own deployment (or `http://localhost:8080` in dev) if you forked
  this.
- If a token is missing, the tools that need it return a clear error instead of
  failing silently — the others keep working.

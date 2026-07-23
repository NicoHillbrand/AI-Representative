# AI Representative — MCP server

A small [Model Context Protocol](https://modelcontextprotocol.io) server that
gives *your own* agent (Claude Code, Claude Desktop, the Agent SDK, anything
that speaks MCP) tools to reach the private, owner-only side of your running
representative:

**Read-only by default.** With just the read token it can read; the two write
tools only appear if you also provide a write token. So a compromised agent can
be used to *read*, not to *change* — deliberately (make changes via Telegram or
the overlay).

| Tool | What it does | Needs |
|---|---|---|
| `list_forwards` | Read messages forwarded to you (website chats, the scheduled poller, agent pushes). Newest first; filter by unread/category. | `OWNER_READ_TOKEN` |
| `who_is_up` | See which Huddle friends are up for a spontaneous call right now, and what for (via the server's read-only owner roster — no device token). | `OWNER_READ_TOKEN` |
| `forward_to_self` | Push an item into your feed — a note, a reminder, something worth your attention. | `OWNER_WRITE_TOKEN` |
| `mark_forwards_read` | Mark items read (specific ids, or all). | `OWNER_WRITE_TOKEN` |

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

## 2. Get your token(s)

- **`OWNER_READ_TOKEN`** *(required)* — the read-only owner token set in the
  server's env. Enables `list_forwards` and `who_is_up`. A secret; treat it like
  a password, but note it can't change anything.
- **`OWNER_WRITE_TOKEN`** *(optional)* — the full owner token. Only set this if
  you want the agent to be able to `forward_to_self` / `mark_forwards_read`.
  Leaving it out keeps the agent read-only (recommended — make changes via
  Telegram or the overlay instead).

For `who_is_up` to return anything, the **server** must have `OWNER_MEMBER_ID`
set to your Huddle member id (that's a server-side setting, not something this
client needs). No device token is involved — the client never gets authority to
act as you on Huddle.

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
        "OWNER_READ_TOKEN": "your-read-token"
      }
    }
  }
}
```

(Add `"OWNER_WRITE_TOKEN": "..."` to that `env` block only if you want the write
tools.)

Or add it from the CLI:

```bash
claude mcp add ai-representative \
  -e REPRESENTATIVE_BASE_URL=https://ai.nicohillbrand.com \
  -e OWNER_READ_TOKEN=your-read-token \
  -- node /absolute/path/to/AI-Representative/mcp/server.mjs
```

### Claude Desktop

Add the same block to `claude_desktop_config.json` (Settings → Developer → Edit
Config), then restart the app.

## 4. Use it

Ask your agent things like:

- *"Summarize what's been forwarded to me — anything I should act on?"* → it
  calls `list_forwards`.
- *"Is anyone up for a call right now?"* → `who_is_up`.
- *(only with a write token)* *"Forward this to my feed: follow up with Jane
  about the Berlin talk."* → `forward_to_self`; `mark_forwards_read` after you've
  reviewed.

## Notes

- **Secrets:** the env block holds real tokens — keep `.mcp.json` /
  `claude_desktop_config.json` out of any shared repo, or inject the values
  from your own secret store.
- **`REPRESENTATIVE_BASE_URL`** defaults to `https://ai.nicohillbrand.com`. Point
  it at your own deployment (or `http://localhost:8080` in dev) if you forked
  this.
- If a token is missing, the tools that need it return a clear error instead of
  failing silently — the others keep working.

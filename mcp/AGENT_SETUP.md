# Agent setup guide — AI Representative MCP server

**You are an AI agent being asked to connect yourself to Nico Hillbrand's AI
Representative via its MCP server.** Follow these steps. This gives you tools to
read/write his forwarding feed and see who's up for a Huddle call. The MCP
server lives in this repo (the `mcp/` folder) and talks to the deployed
representative over HTTP; you run it locally and configure it with env vars.

Work through the steps in order. Where a step needs a secret you can't obtain
yourself, **ask the user** — don't guess or fabricate tokens.

---

## Step 1 — Install the MCP server's dependencies

From the repo root:

```bash
cd mcp
npm install        # requires Node 18+ (global fetch); safe to re-run
```

If `node_modules/@modelcontextprotocol/sdk` already exists, it's installed —
you can skip this.

## Step 2 — Resolve the absolute path to the server

You'll need it for the config. From inside `mcp/`:

```bash
node -e "console.log(require('path').resolve('server.mjs'))"
```

Record the output as `SERVER_PATH`. (On Windows, either backslashes or forward
slashes work in the JSON; forward slashes avoid escaping.)

## Step 3 — Collect the tokens (ask the user)

The server exposes two capabilities behind two different secrets:

- **`OWNER_TOKEN`** — required for the forwarding-feed tools (`list_forwards`,
  `forward_to_self`, `mark_forwards_read`). This is the `OWNER_TOKEN` set in the
  representative's server env. **You cannot derive it — ask the user for it.**
- **`PRESENCE_DEVICE_TOKEN`** — required only for `who_is_up` (the Huddle
  roster). Optional. If the user wants it, obtain it in Step 3b; otherwise leave
  it unset and the other three tools still work.

Also confirm the base URL. Default: `https://ai.nicohillbrand.com`. Ask the user
only if they might be running a different deployment (e.g. a fork or
`http://localhost:8080` in dev).

### Step 3b — (optional) Mint a Huddle device token

`who_is_up` needs a device token tied to the user's own Huddle identity. Mint
one by pairing with **their own friend code and their own display name** (this
attaches a new token to their existing account — it does not create a new
member). Ask the user for their friend code (overlay → settings → *My friend
code*) and exact display name, then:

```bash
curl -s -X POST https://ai.nicohillbrand.com/api/presence/pair \
  -H "Content-Type: application/json" \
  -d '{"code":"<friend-code>","displayName":"<exact display name>"}'
```

Use the `deviceToken` from the JSON response as `PRESENCE_DEVICE_TOKEN`.

## Step 4 — Write the MCP config into YOUR project

Add the server to the MCP config of the project **you** (the agent) run in.

- **Claude Code / Agent SDK:** a `.mcp.json` at your project root.
- **Claude Desktop:** `claude_desktop_config.json` (Settings → Developer → Edit
  Config).

Merge this into the existing `mcpServers` object (create the file if absent —
**do not overwrite** other servers already configured):

```json
{
  "mcpServers": {
    "ai-representative": {
      "command": "node",
      "args": ["<SERVER_PATH from Step 2>"],
      "env": {
        "REPRESENTATIVE_BASE_URL": "https://ai.nicohillbrand.com",
        "OWNER_TOKEN": "<OWNER_TOKEN from Step 3>",
        "PRESENCE_DEVICE_TOKEN": "<device token from Step 3b, or omit this line>"
      }
    }
  }
}
```

**Security:** these are real secrets. Make sure this config file is gitignored
or otherwise kept out of any shared/committed repo. If the user has a secret
manager, prefer injecting the values from there.

## Step 5 — Reload and verify

Reload MCP servers (restart the agent, or the client's "reconnect MCP" action).
Then confirm the connection with a read call — ask to list the feed, or call
`list_forwards` directly. A successful response (even an empty feed) means it's
wired up. If it errors, re-check `OWNER_TOKEN` and that the server has the
`POST /api/forwards` endpoint deployed.

---

## Tool reference

| Tool | Purpose | Needs |
|---|---|---|
| `list_forwards` | Read messages forwarded to Nico (newest first; `unread_only`, `category`, `limit` filters). | `OWNER_TOKEN` |
| `forward_to_self` | Push an item into the feed (`title`, plus optional `summary`/`url`/`detail`/`category`/`external_id`). | `OWNER_TOKEN` |
| `mark_forwards_read` | Mark items read (`ids`, or all if omitted). | `OWNER_TOKEN` |
| `who_is_up` | List Huddle friends currently available for a call. | `PRESENCE_DEVICE_TOKEN` |

For a human-oriented version of this, see [README.md](README.md).

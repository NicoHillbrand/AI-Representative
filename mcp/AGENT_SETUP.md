# Agent setup guide — AI Representative MCP server

**You are an AI agent being asked to connect yourself to Nico Hillbrand's AI
Representative via its MCP server.** Follow these steps. This gives you tools to
read his forwarding feed and see who's up for a Huddle call — and, only if the
user opts in with a write token, to push items into the feed. The MCP server
lives in this repo (the `mcp/` folder) and talks to the deployed representative
over HTTP; you run it locally and configure it with env vars.

It is **read-only by default**: with only the read token you can read but not
change anything, which is the intended posture. Do not ask for a write token
unless the user explicitly wants you to be able to forward things.

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

## Step 3 — Collect the token(s) (ask the user)

- **`OWNER_READ_TOKEN`** *(required)* — the read-only owner token from the
  representative's server env. Enables `list_forwards` and `who_is_up`. **You
  cannot derive it — ask the user for it.**
- **`OWNER_WRITE_TOKEN`** *(optional — do NOT request by default)* — the full
  owner token. Only collect this if the user explicitly says they want you to be
  able to forward items / mark things read. Otherwise leave it unset so you stay
  read-only.

Also confirm the base URL. Default: `https://ai.nicohillbrand.com`. Ask the user
only if they might be running a different deployment (e.g. a fork or
`http://localhost:8080` in dev).

Note: `who_is_up` also requires the **server** to have `OWNER_MEMBER_ID` set —
that's the user's server-side config, not something you set here. If `who_is_up`
comes back saying the roster isn't enabled, tell the user to set
`OWNER_MEMBER_ID` in the server env (their Huddle member id, found in
`data/presence-members.json`).

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
        "OWNER_READ_TOKEN": "<OWNER_READ_TOKEN from Step 3>"
      }
    }
  }
}
```

Only if the user opted into writes (Step 3), also add
`"OWNER_WRITE_TOKEN": "<their write token>"` to that `env` block — that's what
makes the `forward_to_self` / `mark_forwards_read` tools appear.

**Security:** these are real secrets. Make sure this config file is gitignored
or otherwise kept out of any shared/committed repo. If the user has a secret
manager, prefer injecting the values from there.

## Step 5 — Reload and verify

Reload MCP servers (restart the agent, or the client's "reconnect MCP" action).
Then confirm the connection with a read call — ask to list the feed, or call
`list_forwards` directly. A successful response (even an empty feed) means it's
wired up. If it errors, re-check `OWNER_READ_TOKEN` and that the server has the
owner API deployed.

---

## Tool reference

| Tool | Purpose | Needs |
|---|---|---|
| `list_forwards` | Read messages forwarded to Nico (newest first; `unread_only`, `category`, `limit` filters). | `OWNER_READ_TOKEN` |
| `who_is_up` | List Huddle friends currently available for a call. | `OWNER_READ_TOKEN` (+ server `OWNER_MEMBER_ID`) |
| `forward_to_self` | Push an item into the feed (`title`, plus optional `summary`/`url`/`detail`/`category`/`external_id`). Appears only with a write token. | `OWNER_WRITE_TOKEN` |
| `mark_forwards_read` | Mark items read (`ids`, or all if omitted). Appears only with a write token. | `OWNER_WRITE_TOKEN` |

For a human-oriented version of this, see [README.md](README.md).

#!/usr/bin/env node
// MCP server for the AI Representative's private owner API.
//
// Read-only by default: give it the READ token and it can list the forwarding
// feed and see who's up for a Huddle call — but it cannot change anything. If
// (and only if) you also give it a WRITE token, the write tools appear. This
// keeps a compromised agent limited to *reading*; changes go through Telegram
// or the overlay instead.
//
// It talks to a running server over HTTP, so run it anywhere and point it at
// your deployment with env vars:
//
//   REPRESENTATIVE_BASE_URL   base URL of the server (default https://ai.nicohillbrand.com)
//   OWNER_READ_TOKEN          read-only token: list feed + read owner roster   (required)
//   OWNER_WRITE_TOKEN         full token: also enables forward/mark-read tools (optional)
//
// See ./README.md and ./AGENT_SETUP.md for how to wire this into an agent and
// how to obtain the tokens.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.REPRESENTATIVE_BASE_URL ?? "https://ai.nicohillbrand.com").replace(/\/$/, "");
// A plain OWNER_TOKEN is accepted as a read credential for convenience, but the
// write tools require an explicit OWNER_WRITE_TOKEN — so dropping a full token
// in here still won't hand an agent write access unless you opt in.
const READ_TOKEN = process.env.OWNER_READ_TOKEN ?? process.env.OWNER_TOKEN ?? "";
const WRITE_TOKEN = process.env.OWNER_WRITE_TOKEN ?? "";

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (s) => ({ content: [{ type: "text", text: s }], isError: true });

/** Call the server's JSON API with a bearer token. Returns {ok, status, body}. */
async function api(path, token, init = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = { error: "bad_response", message: `Non-JSON response (HTTP ${res.status}).` };
  }
  return { ok: res.ok, status: res.status, body };
}

const server = new McpServer({ name: "ai-representative", version: "0.2.0" });

// --- reads (read token) -----------------------------------------------------
server.tool(
  "list_forwards",
  "List messages forwarded to Nico — from website chats, the scheduled poller, or pushed in by an agent. Use this to summarize what's new for him. Newest first.",
  {
    limit: z.number().int().min(1).max(500).optional().describe("Max items to return (default 50)."),
    unread_only: z.boolean().optional().describe("Only items not yet marked read."),
    category: z.string().optional().describe('Filter by category, e.g. "coordination", "interest", "other".'),
  },
  async ({ limit, unread_only, category }) => {
    if (!READ_TOKEN) return fail("OWNER_READ_TOKEN is not set for this MCP server, so the feed can't be read.");
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    if (unread_only) params.set("unread", "1");
    if (category) params.set("category", category);
    const qs = params.toString();
    const { ok, status, body } = await api(`/api/forwards${qs ? `?${qs}` : ""}`, READ_TOKEN);
    if (!ok) return fail(`Couldn't read the feed (HTTP ${status}): ${body?.message ?? "unknown error"}`);
    if (!body.items?.length) return text(`No forwarded messages${unread_only ? " (unread)" : ""}. Unread total: ${body.unread ?? 0}.`);
    return text(JSON.stringify(body, null, 2));
  },
);

server.tool(
  "who_is_up",
  "Check who among Nico's Huddle friends is currently available for a spontaneous call, with what they're up for and until when.",
  {},
  async () => {
    if (!READ_TOKEN) return fail("OWNER_READ_TOKEN is not set for this MCP server.");
    const { ok, status, body } = await api("/api/owner/roster", READ_TOKEN);
    if (status === 503)
      return fail("The server hasn't enabled the owner roster (OWNER_MEMBER_ID is unset). See AGENT_SETUP.md.");
    if (!ok) return fail(`Couldn't read the roster (HTTP ${status}): ${body?.message ?? "unknown error"}`);
    const up = (body.members ?? []).filter((m) => m.available);
    if (!up.length) return text("Nobody is up for a call right now.");
    const lines = up.map((m) => {
      const acts = (m.activities ?? []).map((a) => a.label).join(", ");
      const until = m.availableUntil ? ` (until ${new Date(m.availableUntil).toLocaleTimeString()})` : "";
      return `- ${m.displayName}${until}${acts ? ` — up for: ${acts}` : ""}${m.note ? ` — "${m.note}"` : ""}`;
    });
    return text(`Up for a call right now:\n${lines.join("\n")}`);
  },
);

// --- writes (write token) — only registered when explicitly enabled ---------
if (WRITE_TOKEN) {
  server.tool(
    "forward_to_self",
    "Push an item into Nico's forwarding feed — a note, reminder, or something worth his attention.",
    {
      title: z.string().min(1).describe("Short subject line for the feed."),
      summary: z.string().optional().describe("1-2 sentences on what this is and why it matters. Defaults to the title."),
      url: z.string().url().optional().describe("A link to open, if relevant."),
      detail: z.string().optional().describe("Fuller context / body."),
      category: z.string().optional().describe('"coordination", "interest", or "other".'),
      external_id: z.string().optional().describe("Stable id to dedupe repeated pushes of the same item."),
    },
    async ({ title, summary, url, detail, category, external_id }) => {
      const { ok, status, body } = await api("/api/forwards", WRITE_TOKEN, {
        method: "POST",
        body: JSON.stringify({ title, summary, url, detail, category, externalId: external_id }),
      });
      if (!ok) return fail(`Couldn't forward (HTTP ${status}): ${body?.message ?? "unknown error"}`);
      if (body.deduped) return text("Already in the feed (same external_id) — nothing added.");
      return text(`Forwarded: "${body.forward?.title}" (id ${body.forward?.id}).`);
    },
  );

  server.tool(
    "mark_forwards_read",
    "Mark forwarded items as read. Pass specific ids, or omit to mark everything read.",
    { ids: z.array(z.string()).optional().describe("Forward ids to mark read; omit for all.") },
    async ({ ids }) => {
      const { ok, status, body } = await api("/api/forwards/read", WRITE_TOKEN, {
        method: "POST",
        body: JSON.stringify(ids ? { ids } : {}),
      });
      if (!ok) return fail(`Couldn't mark read (HTTP ${status}): ${body?.message ?? "unknown error"}`);
      return text(`Marked ${body.marked} item(s) read. Unread now: ${body.unread}.`);
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
// Never write to stdout — it's the JSON-RPC channel. Log to stderr only.
console.error(
  `ai-representative MCP server ready → ${BASE_URL} (${WRITE_TOKEN ? "read+write" : "read-only"})`,
);

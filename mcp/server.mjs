#!/usr/bin/env node
// MCP server for the AI Representative's private owner API.
//
// Exposes, as agent tools, the things only the representative's owner can see
// or do: read the forwarding feed, push a note into it, mark items read, and
// check who's up for a call on Huddle. It talks to a running server over HTTP,
// so run it anywhere and point it at your deployment with env vars:
//
//   REPRESENTATIVE_BASE_URL   base URL of the server   (default https://ai.nicohillbrand.com)
//   OWNER_TOKEN               gates the forwarding feed (required for the forward_* tools)
//   PRESENCE_DEVICE_TOKEN     a Huddle device token    (required for who_is_up)
//
// See ./README.md for how to wire this into a Claude agent and how to obtain
// the tokens.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.REPRESENTATIVE_BASE_URL ?? "https://ai.nicohillbrand.com").replace(/\/$/, "");
const OWNER_TOKEN = process.env.OWNER_TOKEN ?? "";
const DEVICE_TOKEN = process.env.PRESENCE_DEVICE_TOKEN ?? "";

/** A tool result carrying plain text (what the agent reads). */
const text = (s) => ({ content: [{ type: "text", text: s }] });
/** A tool result flagged as an error (the agent sees it failed). */
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

const server = new McpServer({ name: "ai-representative", version: "0.1.0" });

// --- forwarding feed (owner token) -----------------------------------------
server.tool(
  "list_forwards",
  "List messages forwarded to Nico — from website chats, the scheduled poller, or pushed in by an agent. Use this to summarize what's new for him. Newest first.",
  {
    limit: z.number().int().min(1).max(500).optional().describe("Max items to return (default 50)."),
    unread_only: z.boolean().optional().describe("Only items not yet marked read."),
    category: z.string().optional().describe('Filter by category, e.g. "coordination", "interest", "other".'),
  },
  async ({ limit, unread_only, category }) => {
    if (!OWNER_TOKEN) return fail("OWNER_TOKEN is not set for this MCP server, so the forwarding feed can't be read.");
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    if (unread_only) params.set("unread", "1");
    if (category) params.set("category", category);
    const qs = params.toString();
    const { ok, status, body } = await api(`/api/forwards${qs ? `?${qs}` : ""}`, OWNER_TOKEN);
    if (!ok) return fail(`Couldn't read the feed (HTTP ${status}): ${body?.message ?? "unknown error"}`);
    if (!body.items?.length) return text(`No forwarded messages${unread_only ? " (unread)" : ""}. Unread total: ${body.unread ?? 0}.`);
    return text(JSON.stringify(body, null, 2));
  },
);

server.tool(
  "forward_to_self",
  "Push an item into Nico's forwarding feed — a note, reminder, or something you found worth his attention. This is how an agent forwards things to him.",
  {
    title: z.string().min(1).describe("Short subject line for the feed."),
    summary: z.string().optional().describe("1-2 sentences on what this is and why it matters. Defaults to the title."),
    url: z.string().url().optional().describe("A link to open, if relevant."),
    detail: z.string().optional().describe("Fuller context / body."),
    category: z.string().optional().describe('"coordination", "interest", or "other".'),
    external_id: z.string().optional().describe("Stable id to dedupe repeated pushes of the same item."),
  },
  async ({ title, summary, url, detail, category, external_id }) => {
    if (!OWNER_TOKEN) return fail("OWNER_TOKEN is not set for this MCP server, so nothing can be forwarded.");
    const { ok, status, body } = await api("/api/forwards", OWNER_TOKEN, {
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
  "Mark forwarded items as read. Pass specific ids, or omit to mark everything read (e.g. after summarizing the feed for Nico).",
  {
    ids: z.array(z.string()).optional().describe("Forward ids to mark read; omit for all."),
  },
  async ({ ids }) => {
    if (!OWNER_TOKEN) return fail("OWNER_TOKEN is not set for this MCP server.");
    const { ok, status, body } = await api("/api/forwards/read", OWNER_TOKEN, {
      method: "POST",
      body: JSON.stringify(ids ? { ids } : {}),
    });
    if (!ok) return fail(`Couldn't mark read (HTTP ${status}): ${body?.message ?? "unknown error"}`);
    return text(`Marked ${body.marked} item(s) read. Unread now: ${body.unread}.`);
  },
);

// --- Huddle presence (device token) ----------------------------------------
server.tool(
  "who_is_up",
  "Check who among Nico's Huddle friends is currently available for a spontaneous call, with what they're up for and until when.",
  {},
  async () => {
    if (!DEVICE_TOKEN)
      return fail(
        "PRESENCE_DEVICE_TOKEN is not set for this MCP server. See the MCP README for how to mint one (pair with your own friend code).",
      );
    const { ok, status, body } = await api("/api/presence/roster", DEVICE_TOKEN);
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

const transport = new StdioServerTransport();
await server.connect(transport);
// Never write to stdout — it's the JSON-RPC channel. Log to stderr only.
console.error(`ai-representative MCP server ready → ${BASE_URL}`);

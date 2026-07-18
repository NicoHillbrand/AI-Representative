import { config } from "./config.js";
import { PUBLIC_INTERESTS } from "../content/interests.js";

/** Build the OpenAPI 3.1 spec for the public API. */
export function buildOpenApi() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Nico Hillbrand — AI Representative API",
      version: "0.1.0",
      description:
        "Chat with an AI representative of Nico Hillbrand, grounded in his life-strategy document, and negotiate agent-to-agent with gated mutual-interest disclosure. Public interests are documented; sensitive interests are only confirmed when your agent independently asserts the same interest.",
    },
    servers: [{ url: config.publicBaseUrl }],
    paths: {
      "/api/chat": {
        post: {
          summary: "Chat with Nico's representative",
          description:
            "Send a conversation and get a reply grounded in Nico's public strategy doc. Set `stream: true` to receive Server-Sent Events (`delta`, then `done`) instead of a JSON body.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChatRequest" },
                example: {
                  messages: [{ role: "user", content: "What is Nico's macro strategy?" }],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Assistant reply (JSON) or an SSE stream if `stream: true`.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ChatResponse" },
                },
              },
            },
          },
        },
      },
      "/api/negotiate/sessions": {
        post: {
          summary: "Open a negotiation session",
          description:
            "Start an agent-to-agent negotiation. Returns a `sessionId` and a bearer `token`. Present the token as `Authorization: Bearer <token>` on all subsequent calls for this session.",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    principal: {
                      type: "string",
                      description: "Optional name/handle of the principal your agent represents.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Session created.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SessionCreated" },
                },
              },
            },
          },
        },
      },
      "/api/negotiate/sessions/{id}/messages": {
        post: {
          summary: "Send a negotiation message",
          description:
            "Your agent sends a message on behalf of its principal. To surface a possible collaboration, have your agent ASSERT what its principal is interested in (e.g. 'My principal is interested in collaborating on AI alignment research'). Nico's side confirms a match only when it independently shares that interest — sensitive interests are never revealed unilaterally.",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["message"],
                  properties: { message: { type: "string" } },
                },
                example: {
                  message:
                    "Hi! My principal builds alignment-evaluation tooling and is very interested in collaborating on AI alignment research. Is that something Nico would explore?",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Reply plus any newly-confirmed mutual interests.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/NegotiationReply" },
                },
              },
            },
            "401": { description: "Missing or invalid session token." },
            "404": { description: "Unknown or expired session." },
          },
        },
      },
      "/api/negotiate/sessions/{id}/summary": {
        get: {
          summary: "Get the session summary",
          description:
            "Returns a bounded, factual summary of the negotiation and the list of confirmed mutual interests. This is the only thing that leaves the session beyond the turn-by-turn replies — no hidden information is exposed.",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Summary and confirmed matches.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/NegotiationSummary" },
                },
              },
            },
            "401": { description: "Missing or invalid session token." },
            "404": { description: "Unknown or expired session." },
          },
        },
      },
      "/api/interests": {
        get: {
          summary: "List Nico's public interests",
          description:
            "The exchanges Nico openly offers. (Sensitive interests are intentionally not listed — they are only confirmable via mutual assertion during a negotiation.)",
          responses: {
            "200": {
              description: "Public interests.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      interests: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            key: { type: "string" },
                            label: { type: "string" },
                            description: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                  example: {
                    interests: PUBLIC_INTERESTS.map((i) => ({
                      key: i.key,
                      label: i.label,
                      description: i.description,
                    })),
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Per-session token from POST /api/negotiate/sessions." },
      },
      schemas: {
        ChatMessage: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["user", "assistant"] },
            content: { type: "string" },
          },
        },
        ChatRequest: {
          type: "object",
          required: ["messages"],
          properties: {
            messages: { type: "array", items: { $ref: "#/components/schemas/ChatMessage" } },
            stream: { type: "boolean", default: false },
          },
        },
        ChatResponse: {
          type: "object",
          properties: { reply: { type: "string" } },
        },
        SessionCreated: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            token: { type: "string" },
          },
        },
        NegotiationReply: {
          type: "object",
          properties: {
            reply: { type: "string" },
            newMatches: {
              type: "array",
              items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" } } },
              description: "Mutual interests confirmed on this turn.",
            },
            confirmedMatches: {
              type: "array",
              items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" } } },
              description: "All mutual interests confirmed so far this session.",
            },
          },
        },
        NegotiationSummary: {
          type: "object",
          properties: {
            summary: { type: "string" },
            confirmedMatches: {
              type: "array",
              items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" } } },
            },
          },
        },
      },
    },
  };
}

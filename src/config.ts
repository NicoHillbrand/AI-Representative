import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

export const config = {
  geminiApiKey: required("GEMINI_API_KEY"),
  port: Number(process.env.PORT ?? 8080),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "http://localhost:8080").replace(/\/$/, ""),
  model: process.env.MODEL ?? "gemini-3.5-flash",
  // The negotiation classifier is a simple task; run it on a cheaper model so a
  // turn doesn't cost a pricey main-model call twice. flash-lite also supports
  // "minimal" thinking, so classification is fast and cheap.
  classifierModel: process.env.CLASSIFIER_MODEL ?? "gemini-3.1-flash-lite",
  corsOrigins: process.env.CORS_ORIGINS ?? "",
  // --- Huddle presence overlay (specs/desktop-call-overlay.md) ---------------
  // Bootstrap codes for the FIRST member only (they join friendless). Everyone
  // else joins with a member's personal friend code. Blank this after
  // bootstrapping — friend codes keep working without it.
  huddleInviteCodes: (process.env.HUDDLE_INVITE_CODES ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean),
  // Call room template. "{room}" is replaced with a fresh random slug per
  // call, so both sides land in the same new room. Without "{room}" it's a
  // static group link. Jitsi needs no accounts; swap for a Meet-generating
  // integration later if desired.
  huddleCallLink: process.env.HUDDLE_CALL_LINK || "https://meet.jit.si/huddle-{room}",
  // Optional Telegram bot (from @BotFather). Powers out-of-overlay Huddle
  // notifications + availability-by-message, and representative chat for
  // anyone who messages the bot. Empty = bridge disabled.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  // --- Forwarding feed + owner API (src/forwarding/) --------------------------
  // Owner API auth, split into read and write scopes so a read-only consumer
  // (e.g. Nico's own agent over MCP) can't mutate state if it's compromised —
  // it can be *used* to read, but not to *change* anything.
  //   - write token: full authority (create forwards, mark read). OWNER_TOKEN
  //     is honored as the write token for backward compatibility.
  //   - read token: list the feed + read the owner's Huddle roster only.
  // A request that presents the write token is also allowed to read. Each
  // endpoint 503s when no token satisfying its scope is configured.
  ownerWriteToken: process.env.OWNER_WRITE_TOKEN ?? process.env.OWNER_TOKEN ?? "",
  ownerReadToken: process.env.OWNER_READ_TOKEN ?? "",
  // The owner's Huddle member id, so the read-only /api/owner/roster knows
  // whose availability to return. Find it in data/presence-members.json (or via
  // GET /api/presence/me with a device token). Blank disables that endpoint.
  ownerMemberId: process.env.OWNER_MEMBER_ID ?? "",
  // How often the scheduled poller runs, in hours (default twice a day).
  forwardPollHours: Number(process.env.FORWARD_POLL_HOURS ?? 12),
  // Which external sources the poller pulls from, comma-separated (keys from
  // src/forwarding/sources/). Empty = the scheduler stays idle (nothing polls).
  forwardSources: (process.env.FORWARD_SOURCES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

/** The whole public strategy doc, loaded once at startup and stuffed into the system prompt. */
export const PUBLIC_DOC = readFileSync(join(root, "content", "public-doc.md"), "utf8");

export const paths = { root };

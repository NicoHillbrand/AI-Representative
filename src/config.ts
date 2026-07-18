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
  // Reusable invite codes friends redeem once to pair a device. Empty = pairing disabled.
  huddleInviteCodes: (process.env.HUDDLE_INVITE_CODES ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean),
  // Call room template. "{room}" is replaced with a fresh random slug per
  // call, so both sides land in the same new room. Without "{room}" it's a
  // static group link. Jitsi needs no accounts; swap for a Meet-generating
  // integration later if desired.
  huddleCallLink: process.env.HUDDLE_CALL_LINK || "https://meet.jit.si/huddle-{room}",
};

/** The whole public strategy doc, loaded once at startup and stuffed into the system prompt. */
export const PUBLIC_DOC = readFileSync(join(root, "content", "public-doc.md"), "utf8");

export const paths = { root };

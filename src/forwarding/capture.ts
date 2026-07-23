import type { ChatMessage } from "../llm.js";
import { classifyChatForward } from "./classify.js";
import { addForward, type ForwardSource } from "./store.js";

/**
 * Glue between a finished representative exchange and the feed: run the loose
 * classifier over the conversation, store anything worth forwarding, and hand
 * back a short verdict to show the visitor.
 *
 * Best-effort — any failure yields `null` and the chat carries on unaffected.
 */
export interface CaptureResult {
  /** "forwarded" (stored + passed on), "declined" (intent but not worthy). */
  status: "forwarded" | "declined";
  /** One warm sentence for the visitor, from the classifier. */
  reason: string;
}

export async function captureChatForward(
  messages: ChatMessage[],
  replyText: string,
  source: ForwardSource,
): Promise<CaptureResult | null> {
  const verdict = await classifyChatForward(messages, replyText);
  // No forwarding attempt in this turn → nothing to say.
  if (!verdict || !verdict.intent) return null;

  if (!verdict.worthy) {
    return { status: "declined", reason: verdict.reason };
  }

  // Keep the tail of the conversation as detail so Nico sees the context, not
  // just the one-line summary.
  const detail = messages
    .slice(-6)
    .map((m) => `${m.role === "user" ? "Visitor" : "Rep"}: ${m.content}`)
    .join("\n\n");

  addForward({
    source,
    title: verdict.title || "Message for Nico",
    summary: verdict.summary,
    category: verdict.category,
    contact: verdict.contact || undefined,
    detail,
  });
  return { status: "forwarded", reason: verdict.reason };
}

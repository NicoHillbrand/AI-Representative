import { Type } from "@google/genai";
import { extractJson, type ChatMessage } from "../llm.js";
import { PUBLIC_INTERESTS } from "../../content/interests.js";

/**
 * The forwarding classifier — deliberately LOOSE. It runs on the cheap
 * classifier model and answers, with intuition rather than rules: is this
 * something Nico would plausibly want to see? A real coordination opportunity
 * or a genuine way of interacting with a person, or something in the orbit of
 * his interests — versus spam, noise, or an idle chat that isn't worth his
 * attention.
 *
 * Two entry points, same spirit:
 *   - classifyChatForward(): watches a live representative conversation. Only
 *     the summary + a short reason ever leave the server (the reason is shown
 *     back to the visitor), so this uses ONLY the PUBLIC interest list.
 *   - classifyCandidate(): judges an item a scheduled poller pulled in.
 */

// A light hint at what Nico tends to care about — public only, since the
// chat-side reason is shown to the visitor. Not an allow-list; the model is
// told these are examples, and things outside them can still be worth it.
const INTEREST_HINT = PUBLIC_INTERESTS.map((i) => `- ${i.label}: ${i.description}`).join("\n");

const CHAT_SYSTEM = `You watch conversations between visitors and Nico Hillbrand's AI representative on his website. Visitors can ask the representative to forward a message to Nico.

Your job, for the latest visitor turn, is to decide two things:

1. intent — is the visitor trying to get something to Nico? This includes an explicit "please forward this / tell Nico / can you pass this along", AND clear implicit cases: proposing a concrete collaboration, leaving contact details for follow-up, or making a specific ask that only Nico can answer.

2. worthy — IF there is intent, should it actually reach Nico? Use judgment, and lean permissive for anything real. Forward it when it is a genuine coordination opportunity, a real person wanting to interact or collaborate, feedback worth hearing, or something in the orbit of his interests. Do NOT forward spam, advertising, empty tests ("hi", "does this work"), abuse, or idle questions already answered by the representative.

Things can be worth forwarding even if they fall outside the interest examples below — a sincere, specific human reaching out is itself the point. The examples are only a hint at his orbit:
${INTEREST_HINT}

When there is intent, write:
- title: a short subject line for Nico's feed (max ~10 words).
- summary: 1-2 sentences telling Nico what this is and what the person wants.
- contact: any email/handle/link the visitor gave, else "".
- category: "coordination" (wants to work together / connect), "interest" (relevant to his topics), or "other".
- reason: one short sentence, addressed to the visitor, explaining your decision (e.g. "This looks like a concrete collaboration proposal, so I've passed it to Nico." or "This seems like a general question I can already help with, so I haven't forwarded it."). Keep it warm and honest.

If there is no intent, set intent=false and leave the other fields empty; reason may be "".`;

const CHAT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: { type: Type.BOOLEAN },
    worthy: { type: Type.BOOLEAN },
    category: { type: Type.STRING, enum: ["coordination", "interest", "other"] },
    title: { type: Type.STRING },
    summary: { type: Type.STRING },
    contact: { type: Type.STRING },
    reason: { type: Type.STRING },
  },
  required: ["intent", "worthy", "category", "title", "summary", "contact", "reason"],
};

export interface ChatForwardVerdict {
  intent: boolean;
  worthy: boolean;
  category: string;
  title: string;
  summary: string;
  contact: string;
  reason: string;
}

/** Render the recent conversation for the classifier. We give it the tail so
 * it has enough context to judge, but focus it on the latest visitor turn. */
function renderConversation(messages: ChatMessage[]): string {
  const tail = messages.slice(-8);
  return tail
    .map((m) => `${m.role === "user" ? "VISITOR" : "REPRESENTATIVE"}: ${m.content}`)
    .join("\n\n");
}

/**
 * Judge the latest visitor turn. `replyText` is the representative's response
 * to it (so the classifier can tell whether a question was already answered).
 * Returns null on any classifier error — forwarding is best-effort and must
 * never break the chat.
 */
export async function classifyChatForward(
  messages: ChatMessage[],
  replyText: string,
): Promise<ChatForwardVerdict | null> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;
  const convo = renderConversation([...messages, { role: "assistant", content: replyText }]);
  try {
    const v = await extractJson<ChatForwardVerdict>({
      system: CHAT_SYSTEM,
      messages: [{ role: "user", content: convo }],
      schema: CHAT_SCHEMA,
    });
    return v;
  } catch (err) {
    console.error("forwarding: chat classifier failed", err);
    return null;
  }
}

// --- scheduled candidates ----------------------------------------------------
const CANDIDATE_SYSTEM = `You curate a private feed for Nico Hillbrand from items pulled off external sites. Decide, with intuition rather than rules, whether an item is worth putting in front of him.

Forward it if it is genuinely relevant to his interests or a real coordination/collaboration opportunity. Skip generic news, low-signal chatter, and anything only loosely on-topic. Lean toward quality over quantity — this feed should stay worth reading.

His interest orbit (a hint, not a strict boundary):
${INTEREST_HINT}

If worthy, write a short title and a 1-2 sentence summary of why it matters to him. reason is a brief internal note (not shown to anyone).`;

const CANDIDATE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    worthy: { type: Type.BOOLEAN },
    category: { type: Type.STRING, enum: ["coordination", "interest", "other"] },
    title: { type: Type.STRING },
    summary: { type: Type.STRING },
    reason: { type: Type.STRING },
  },
  required: ["worthy", "category", "title", "summary", "reason"],
};

export interface CandidateVerdict {
  worthy: boolean;
  category: string;
  title: string;
  summary: string;
  reason: string;
}

export async function classifyCandidate(item: {
  title: string;
  body?: string;
  url?: string;
}): Promise<CandidateVerdict | null> {
  const content = [
    `TITLE: ${item.title}`,
    item.url ? `URL: ${item.url}` : "",
    item.body ? `CONTENT:\n${item.body.slice(0, 4000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    return await extractJson<CandidateVerdict>({
      system: CANDIDATE_SYSTEM,
      messages: [{ role: "user", content }],
      schema: CANDIDATE_SCHEMA,
    });
  } catch (err) {
    console.error("forwarding: candidate classifier failed", err);
    return null;
  }
}

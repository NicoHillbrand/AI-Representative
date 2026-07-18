import { randomBytes, randomUUID } from "node:crypto";
import type { ChatMessage } from "../llm.js";

export interface ConfirmedMatch {
  key: string;
  label: string;
  onMatch: string;
  confirmedAtTurn: number;
}

export interface Session {
  id: string;
  /** Bearer token the counterpart's agent must present on every call. */
  token: string;
  /** Name/handle of the counterpart's principal, if provided. */
  counterpartPrincipal?: string;
  createdAt: number;
  turns: number;
  /** Public conversation transcript (what the counterpart's agent saw). */
  transcript: ChatMessage[];
  /**
   * Interest keys the counterpart has asserted so far (across all turns).
   * Deduped. Used so we don't re-confirm the same match repeatedly.
   */
  assertedKeys: Set<string>;
  /** Matches confirmed so far. This — plus the public doc — is ALL the
   * conversational LLM ever learns about Nico's interests. */
  confirmedMatches: ConfirmedMatch[];
  closed: boolean;
}

const sessions = new Map<string, Session>();

// Sessions are ephemeral (in-memory). Expire them after this long to avoid
// unbounded growth. Restarting the server also clears everything.
const TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

export function createSession(counterpartPrincipal?: string): Session {
  const session: Session = {
    id: `neg_${randomUUID()}`,
    token: randomBytes(24).toString("base64url"),
    counterpartPrincipal,
    createdAt: Date.now(),
    turns: 0,
    transcript: [],
    assertedKeys: new Set(),
    confirmedMatches: [],
    closed: false,
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  const s = sessions.get(id);
  if (!s) return undefined;
  if (Date.now() - s.createdAt > TTL_MS) {
    sessions.delete(id);
    return undefined;
  }
  return s;
}

/** Constant-time-ish token check. */
export function authorize(session: Session, token: string | undefined): boolean {
  return !!token && token === session.token;
}

// Opportunistic cleanup of expired sessions.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > TTL_MS) sessions.delete(id);
  }
}, 1000 * 60 * 30).unref?.();

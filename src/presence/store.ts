import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.js";

/**
 * Presence store for the Huddle desktop overlay (specs/desktop-call-overlay.md).
 *
 * Members (identity + device tokens) persist to disk so friends don't have to
 * re-pair after a server restart. Availability signals are deliberately
 * in-memory only — they're transient by design and a restart clearing them is
 * acceptable.
 *
 * Activities carry per-friend visibility, so everything a viewer receives
 * (roster snapshots AND stream updates) is filtered per viewer here — a
 * client never gets activity data it isn't allowed to show.
 */

export interface Activity {
  label: string;
  /** "all", or the memberIds allowed to see this activity. */
  visibleTo: "all" | string[];
  /** Per-activity duration; falls back to the signal window when absent. */
  minutes?: number;
}

interface StoredActivity {
  label: string;
  visibleTo: "all" | string[];
  expiresAt: number;
}

export interface Signal {
  setAt: number;
  expiresAt: number;
  note?: string;
  activities: StoredActivity[];
}

export interface Member {
  id: string;
  displayName: string;
  /** Device tokens — one person may pair several devices under one name. */
  tokens: Set<string>;
  signal?: Signal;
}

/** What a specific viewer sees for one member. Deliberately no
 * online/connected state — this is an intent signal, not a presence tracker
 * (spec §12.6). */
export interface RosterEntry {
  memberId: string;
  displayName: string;
  available: boolean;
  availableUntil?: string;
  note?: string;
  /** Activities this viewer is allowed to see, each with its own expiry. */
  activities?: { label: string; availableUntil: string }[];
}

const members = new Map<string, Member>();
const byToken = new Map<string, Member>();

// --- persistence (members only, never signals) --------------------------------
const dataDir = join(paths.root, "data");
const dataFile = join(dataDir, "presence-members.json");

function load(): void {
  if (!existsSync(dataFile)) return;
  try {
    const raw = JSON.parse(readFileSync(dataFile, "utf8")) as {
      members?: { id: string; displayName: string; tokens: string[] }[];
    };
    for (const m of raw.members ?? []) {
      const member: Member = { id: m.id, displayName: m.displayName, tokens: new Set(m.tokens) };
      members.set(member.id, member);
      for (const t of member.tokens) byToken.set(t, member);
    }
  } catch (err) {
    console.error("presence: failed to load member file, starting empty", err);
  }
}

function save(): void {
  mkdirSync(dataDir, { recursive: true });
  const raw = {
    members: [...members.values()].map((m) => ({
      id: m.id,
      displayName: m.displayName,
      tokens: [...m.tokens],
    })),
  };
  writeFileSync(dataFile, JSON.stringify(raw, null, 2));
}

load();

// --- pairing & auth ------------------------------------------------------------
/**
 * Redeem an invite code. Pairing again with an already-known display name
 * (case-insensitive) attaches a new device token to the existing member, so
 * one person on two machines shows up once in the roster.
 */
export function pair(displayName: string): { member: Member; token: string } {
  const name = displayName.trim().slice(0, 40);
  const existing = [...members.values()].find(
    (m) => m.displayName.toLowerCase() === name.toLowerCase(),
  );
  const token = randomBytes(24).toString("base64url");
  let member: Member;
  if (existing) {
    member = existing;
    member.tokens.add(token);
  } else {
    member = { id: `mem_${randomUUID()}`, displayName: name, tokens: new Set([token]) };
    members.set(member.id, member);
  }
  byToken.set(token, member);
  save();
  return { member, token };
}

export function memberByToken(token: string | undefined): Member | undefined {
  return token ? byToken.get(token) : undefined;
}

// --- signals ---------------------------------------------------------------------
function entryFor(m: Member, viewerId: string): RosterEntry {
  const now = Date.now();
  const active = !!m.signal && now < m.signal.expiresAt;
  if (!active || !m.signal) {
    return { memberId: m.id, displayName: m.displayName, available: false };
  }
  // You always see your own activities in full; others only what's shared
  // with them. Individually lapsed activities disappear before the signal does.
  const visible = m.signal.activities.filter(
    (a) =>
      now < a.expiresAt &&
      (m.id === viewerId || a.visibleTo === "all" || a.visibleTo.includes(viewerId)),
  );
  return {
    memberId: m.id,
    displayName: m.displayName,
    available: true,
    availableUntil: new Date(m.signal.expiresAt).toISOString(),
    note: m.signal.note,
    ...(visible.length
      ? {
          activities: visible.map((a) => ({
            label: a.label,
            availableUntil: new Date(a.expiresAt).toISOString(),
          })),
        }
      : {}),
  };
}

const clampMins = (m: number) => Math.min(180, Math.max(15, Math.round(m)));

export function setSignal(
  member: Member,
  windowMinutes: number,
  note?: string,
  activities: Activity[] = [],
): RosterEntry {
  const windowMins = clampMins(windowMinutes);
  const now = Date.now();
  const stored: StoredActivity[] = activities.map((a) => ({
    label: a.label,
    visibleTo: a.visibleTo,
    expiresAt: now + clampMins(a.minutes ?? windowMins) * 60_000,
  }));
  member.signal = {
    setAt: now,
    // Available at least the chosen window, and long enough to cover every
    // activity's own duration.
    expiresAt: Math.max(now + windowMins * 60_000, ...stored.map((a) => a.expiresAt)),
    note: note?.trim().slice(0, 80) || undefined,
    activities: stored,
  };
  broadcastMember(member);
  return entryFor(member, member.id);
}

export function clearSignal(member: Member): void {
  if (!member.signal) return;
  member.signal = undefined;
  broadcastMember(member);
}

export function roster(viewerId: string): RosterEntry[] {
  return [...members.values()]
    .map((m) => entryFor(m, viewerId))
    .sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
}

// --- SSE fan-out -------------------------------------------------------------
// Every subscriber is tied to a viewing member so updates can be filtered
// per viewer before they leave the server.
type Send = (event: string, data: unknown) => void;
const subscribers = new Set<{ send: Send; viewerId: string }>();

export function subscribe(send: Send, viewerId: string): () => void {
  const sub = { send, viewerId };
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}

function broadcastMember(m: Member): void {
  for (const sub of subscribers) {
    try {
      sub.send("update", { member: entryFor(m, sub.viewerId) });
    } catch {
      subscribers.delete(sub);
    }
  }
}

// --- pings & call invites -----------------------------------------------------
// Both go only to the target member's connected devices. Throttled per
// event-type+sender→target so an accidental double-click doesn't double-buzz.
const lastDirect = new Map<string, number>();

function sendDirect(
  event: string,
  from: Member,
  toMemberId: string,
  data: Record<string, unknown>,
): { ok: true; delivered: boolean } | { ok: false; error: string } {
  const target = members.get(toMemberId);
  if (!target) return { ok: false, error: "unknown_member" };
  if (target.id === from.id) return { ok: false, error: "self_target" };
  const key = `${event}:${from.id}>${target.id}`;
  const now = Date.now();
  if (now - (lastDirect.get(key) ?? 0) < 3_000) return { ok: false, error: "too_fast" };
  lastDirect.set(key, now);
  let delivered = false;
  for (const sub of subscribers) {
    if (sub.viewerId !== target.id) continue;
    try {
      sub.send(event, {
        from: { memberId: from.id, displayName: from.displayName },
        ...data,
      });
      delivered = true;
    } catch {
      subscribers.delete(sub);
    }
  }
  return { ok: true, delivered };
}

export const pingMember = (from: Member, toMemberId: string) =>
  sendDirect("ping-from", from, toMemberId, {});

// --- call handshake ------------------------------------------------------------
// A call only happens by mutual consent: A requests (optionally attaching
// their own room link, e.g. a personal Google Meet), B accepts, THEN the
// link — or a room minted from the server template as fallback — is pushed
// to both. Requests expire quickly.
const pendingCalls = new Map<string, { expiresAt: number; link?: string }>(); // "fromId>toId"
const CALL_REQUEST_TTL = 2 * 60_000;

export function requestCall(from: Member, toMemberId: string, link?: string) {
  const result = sendDirect("call-request", from, toMemberId, {});
  if (result.ok)
    pendingCalls.set(`${from.id}>${toMemberId}`, { expiresAt: Date.now() + CALL_REQUEST_TTL, link });
  return result;
}

/** Accept a pending request from `fromMemberId`; pushes the requester's link
 * (or `fallbackUrl` when they didn't attach one) to BOTH sides. */
export function acceptCall(
  accepter: Member,
  fromMemberId: string,
  fallbackUrl: string,
): { ok: true; delivered: boolean; url: string } | { ok: false; error: string } {
  const key = `${fromMemberId}>${accepter.id}`;
  const pending = pendingCalls.get(key);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingCalls.delete(key);
    return { ok: false, error: "no_pending_request" };
  }
  pendingCalls.delete(key);
  const url = pending.link ?? fallbackUrl;
  const requester = members.get(fromMemberId);
  if (!requester) return { ok: false, error: "unknown_member" };
  let delivered = false;
  for (const sub of subscribers) {
    const isRequester = sub.viewerId === requester.id;
    const isAccepter = sub.viewerId === accepter.id;
    if (!isRequester && !isAccepter) continue;
    const peer = isRequester ? accepter : requester;
    try {
      sub.send("call-start", {
        peer: { memberId: peer.id, displayName: peer.displayName },
        url,
      });
      if (isRequester) delivered = true;
    } catch {
      subscribers.delete(sub);
    }
  }
  return { ok: true, delivered, url };
}

// Expire signals and tell everyone. Runs often enough that a lapsed window
// disappears from rosters within a few seconds (spec §11).
setInterval(() => {
  const now = Date.now();
  for (const m of members.values()) {
    if (m.signal && now >= m.signal.expiresAt) {
      m.signal = undefined;
      broadcastMember(m);
    }
  }
}, 15_000).unref?.();

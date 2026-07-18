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
  /** How long this OFFER stands (availability window for the activity);
   * falls back to the signal window when absent. */
  minutes?: number;
  /** Expected length of the call itself ("a 5-minute call on X") — a second,
   * independent time from the window above. Display-only. */
  durationMinutes?: number;
}

interface StoredActivity {
  label: string;
  visibleTo: "all" | string[];
  expiresAt: number;
  durationMinutes?: number;
}

export interface Signal {
  setAt: number;
  expiresAt: number;
  note?: string;
  activities: StoredActivity[];
}

/** A reusable call-type preset (the overlay's catalog, mirrored server-side
 * so the Telegram picker can offer the same options). */
export interface Preset {
  label: string;
  visibleTo: "all" | string[];
  /** Expected call length in minutes (optional, display-only). */
  durationMinutes?: number;
}

export interface Member {
  id: string;
  displayName: string;
  /** Device tokens — one person may pair several devices under one name. */
  tokens: Set<string>;
  /** Personal invite code: sharing it lets a friend add (or join and add)
   * you. Rotatable; doubles as the pairing secret for your own extra
   * devices. */
  friendCode: string;
  /** Mutual by construction: a is in b.friends iff b is in a.friends. */
  friends: Set<string>;
  /** Linked Telegram chat for out-of-overlay notifications (optional). */
  telegramChatId?: number;
  /** Call-type presets. Absent → DEFAULT_PRESETS. The overlay is the primary
   * editor (it re-syncs on every change); Telegram-only members edit via
   * /presets. */
  presets?: Preset[];
  signal?: Signal;
}

/** Events another channel (e.g. the Telegram bridge) may want to relay.
 * `live` flags say whether the affected member got it via a connected
 * overlay — relays typically only fire when they didn't. */
export type PresenceEvent =
  | { type: "ping"; from: Member; to: Member; live: boolean }
  | { type: "call-request"; from: Member; to: Member; live: boolean }
  | { type: "call-start"; requester: Member; accepter: Member; url: string; requesterLive: boolean; accepterLive: boolean }
  | { type: "went-available"; member: Member; friend: Member; live: boolean }
  | { type: "opportunity"; from: Member; to: Member; text: string; expiresAt: number; live: boolean };

let eventSink: ((e: PresenceEvent) => void) | undefined;
export function setEventSink(fn: (e: PresenceEvent) => void): void {
  eventSink = fn;
}
const emit = (e: PresenceEvent) => {
  try {
    eventSink?.(e);
  } catch (err) {
    console.error("presence event sink failed", err);
  }
};

/** What a specific viewer sees for one member. Deliberately no
 * online/connected state — this is an intent signal, not a presence tracker
 * (spec §12.6). */
export interface RosterEntry {
  memberId: string;
  displayName: string;
  available: boolean;
  availableUntil?: string;
  note?: string;
  /** Activities this viewer is allowed to see, each with its own expiry and
   * (optionally) the expected call length. */
  activities?: { label: string; availableUntil: string; durationMinutes?: number }[];
}

const members = new Map<string, Member>();
const byToken = new Map<string, Member>();

// --- persistence (members + friend graph, never signals) ----------------------
const dataDir = join(paths.root, "data");
const dataFile = join(dataDir, "presence-members.json");

function load(): void {
  if (!existsSync(dataFile)) return;
  try {
    const raw = JSON.parse(readFileSync(dataFile, "utf8")) as {
      members?: {
        id: string;
        displayName: string;
        tokens: string[];
        friendCode?: string;
        friends?: string[];
        telegramChatId?: number;
        presets?: Preset[];
      }[];
    };
    for (const m of raw.members ?? []) {
      const member: Member = {
        id: m.id,
        displayName: m.displayName,
        tokens: new Set(m.tokens),
        // Pre-friend-graph files lack these: mint a code, start friendless.
        friendCode: m.friendCode || generateCode(),
        friends: new Set(m.friends ?? []),
        telegramChatId: m.telegramChatId,
        presets: m.presets,
      };
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
      friendCode: m.friendCode,
      friends: [...m.friends],
      ...(m.telegramChatId ? { telegramChatId: m.telegramChatId } : {}),
      ...(m.presets ? { presets: m.presets } : {}),
    })),
  };
  writeFileSync(dataFile, JSON.stringify(raw, null, 2));
}

// Readable, unambiguous code like "kqm3-x7p2" (~40 bits — plenty for a
// rate-limited-by-obscurity friend gate).
function generateCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const chars = [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

load();

// --- pairing & auth ------------------------------------------------------------
/**
 * Pair a device using a code:
 *  - a member's friend code + THEIR display name → attach another device to
 *    that member (the code doubles as your own multi-device secret);
 *  - a member's friend code + any other name → create a new member and make
 *    the two friends (joining and adding the inviter in one step);
 *  - a bootstrap code (HUDDLE_INVITE_CODES env) → create a friendless member,
 *    or reattach by name — this is how the very first person gets in.
 */
export function pairWithCode(
  code: string,
  displayName: string,
  bootstrapCodes: string[],
): { ok: true; member: Member; token: string } | { ok: false; error: "invalid_code" } {
  const name = displayName.trim().slice(0, 40);
  const c = code.trim();
  const token = randomBytes(24).toString("base64url");

  const finish = (member: Member) => {
    member.tokens.add(token);
    byToken.set(token, member);
    members.set(member.id, member);
    save();
    return { ok: true as const, member, token };
  };
  const createMember = (): Member => ({
    id: `mem_${randomUUID()}`,
    displayName: name,
    tokens: new Set<string>(),
    friendCode: generateCode(),
    friends: new Set<string>(),
  });
  const byName = () =>
    [...members.values()].find((m) => m.displayName.toLowerCase() === name.toLowerCase());

  const codeOwner = c && [...members.values()].find((m) => m.friendCode === c);
  if (codeOwner) {
    if (codeOwner.displayName.toLowerCase() === name.toLowerCase()) return finish(codeOwner);
    const created = finish(createMember());
    befriend(created.member, codeOwner);
    return created;
  }
  if (c && bootstrapCodes.includes(c)) return finish(byName() ?? createMember());
  return { ok: false, error: "invalid_code" };
}

export function memberByToken(token: string | undefined): Member | undefined {
  return token ? byToken.get(token) : undefined;
}

// --- friend graph ---------------------------------------------------------------
function befriend(a: Member, b: Member): void {
  if (a.id === b.id || a.friends.has(b.id)) return;
  a.friends.add(b.id);
  b.friends.add(a.id);
  save();
  // Each side's overlay learns about its new friend immediately.
  sendTo(a.id, "update", { member: entryFor(b, a.id) });
  sendTo(b.id, "update", { member: entryFor(a, b.id) });
}

export function addFriendByCode(
  me: Member,
  code: string,
):
  | { ok: true; friend: { memberId: string; displayName: string } }
  | { ok: false; error: string } {
  const c = code.trim();
  const owner = c && [...members.values()].find((m) => m.friendCode === c);
  if (!owner) return { ok: false, error: "invalid_code" };
  if (owner.id === me.id) return { ok: false, error: "self_code" };
  befriend(me, owner);
  return { ok: true, friend: { memberId: owner.id, displayName: owner.displayName } };
}

/** Unilateral and mutual: removing a friend removes you from their side too. */
export function unfriend(me: Member, friendId: string): boolean {
  const other = members.get(friendId);
  if (!other || !me.friends.has(friendId)) return false;
  me.friends.delete(friendId);
  other.friends.delete(me.id);
  save();
  sendTo(me.id, "friend-removed", { memberId: other.id });
  sendTo(other.id, "friend-removed", { memberId: me.id });
  return true;
}

export function rotateFriendCode(me: Member): string {
  me.friendCode = generateCode();
  save();
  return me.friendCode;
}

// --- Telegram linking -----------------------------------------------------------
// Overlay asks for a one-time code → user opens t.me/<bot>?start=<code> → the
// bot redeems it, binding that Telegram chat to the member.
const tgLinkCodes = new Map<string, { memberId: string; expiresAt: number }>();
const TG_LINK_TTL = 10 * 60_000;

export function createTelegramLinkCode(member: Member): string {
  const code = generateCode().replace("-", "") + generateCode().replace("-", "");
  tgLinkCodes.set(code, { memberId: member.id, expiresAt: Date.now() + TG_LINK_TTL });
  return code;
}

/** One chat ↔ one member: unbinds the chat elsewhere first. */
export function bindTelegramChat(member: Member, chatId: number): void {
  for (const m of members.values()) if (m.telegramChatId === chatId) m.telegramChatId = undefined;
  member.telegramChatId = chatId;
  save();
}

export function redeemTelegramLinkCode(code: string, chatId: number): Member | undefined {
  const entry = tgLinkCodes.get(code.trim());
  tgLinkCodes.delete(code.trim());
  if (!entry || Date.now() > entry.expiresAt) return undefined;
  const member = members.get(entry.memberId);
  if (!member) return undefined;
  bindTelegramChat(member, chatId);
  return member;
}

export function unlinkTelegram(member: Member): void {
  member.telegramChatId = undefined;
  save();
}

export function memberByTelegramChat(chatId: number): Member | undefined {
  return [...members.values()].find((m) => m.telegramChatId === chatId);
}

// --- call-type presets ------------------------------------------------------------
// Same defaults as the overlay ships with — a Telegram-only member sees a
// sensible picker before they (or their overlay) ever customize anything.
export const DEFAULT_PRESETS: readonly string[] = [
  "get unstuck on a task",
  "help me escape a local minimum",
  "meditation",
  "coworking",
  "body doubling",
];

export function presetsFor(member: Member): Preset[] {
  return (
    member.presets ?? DEFAULT_PRESETS.map((label) => ({ label, visibleTo: "all" as const }))
  );
}

/** Replace the whole catalog (callers sanitize shape; we enforce caps).
 * Edits made anywhere (overlay push, Telegram /presets) reach the member's
 * own connected overlays live, so the two editors never diverge. */
export function setPresets(member: Member, presets: Preset[]): Preset[] {
  member.presets = presets
    .map((p) => ({
      label: p.label.trim().slice(0, 60),
      visibleTo: p.visibleTo === "all" ? ("all" as const) : p.visibleTo.slice(0, 100),
      ...(p.durationMinutes ? { durationMinutes: clampDuration(p.durationMinutes) } : {}),
    }))
    .filter((p) => p.label)
    .slice(0, 20);
  save();
  sendTo(member.id, "presets", { presets: member.presets });
  return member.presets;
}

/** Does this member have any overlay connected right now? */
export function hasLiveSubscriber(memberId: string): boolean {
  for (const sub of subscribers) if (sub.viewerId === memberId) return true;
  return false;
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
            ...(a.durationMinutes ? { durationMinutes: a.durationMinutes } : {}),
          })),
        }
      : {}),
  };
}

const clampMins = (m: number) => Math.min(180, Math.max(15, Math.round(m)));
// Call length may be tiny on purpose ("a 5-minute call") — separate clamp.
const clampDuration = (m: number) => Math.min(240, Math.max(1, Math.round(m)));

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
    ...(a.durationMinutes ? { durationMinutes: clampDuration(a.durationMinutes) } : {}),
  }));
  const wasActive = !!member.signal && now < member.signal.expiresAt;
  member.signal = {
    setAt: now,
    // Available at least the chosen window, and long enough to cover every
    // activity's own duration.
    expiresAt: Math.max(now + windowMins * 60_000, ...stored.map((a) => a.expiresAt)),
    note: note?.trim().slice(0, 80) || undefined,
    activities: stored,
  };
  broadcastMember(member);
  if (!wasActive) {
    for (const fid of member.friends) {
      const friend = members.get(fid);
      if (friend) emit({ type: "went-available", member, friend, live: hasLiveSubscriber(fid) });
    }
  }
  return entryFor(member, member.id);
}

export function clearSignal(member: Member): void {
  if (!member.signal) return;
  member.signal = undefined;
  broadcastMember(member);
}

/** Only yourself and your friends — nobody else's existence is disclosed. */
export function roster(viewer: Member): RosterEntry[] {
  return [viewer, ...[...viewer.friends].map((id) => members.get(id))]
    .filter((m): m is Member => !!m)
    .map((m) => entryFor(m, viewer.id))
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

function sendTo(viewerId: string, event: string, data: unknown): boolean {
  let delivered = false;
  for (const sub of subscribers) {
    if (sub.viewerId !== viewerId) continue;
    try {
      sub.send(event, data);
      delivered = true;
    } catch {
      subscribers.delete(sub);
    }
  }
  return delivered;
}

/** Signal changes go to the member's own devices and their friends' — never
 * to strangers on the same server. */
function broadcastMember(m: Member): void {
  for (const sub of subscribers) {
    if (sub.viewerId !== m.id && !m.friends.has(sub.viewerId)) continue;
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
  // Non-friends get the same error as nonexistent members — no probing.
  if (!target || !from.friends.has(target.id)) return { ok: false, error: "unknown_member" };
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

export const pingMember = (from: Member, toMemberId: string) => {
  const result = sendDirect("ping-from", from, toMemberId, {});
  if (result.ok) {
    const to = members.get(toMemberId);
    if (to) emit({ type: "ping", from, to, live: result.delivered });
  }
  return result;
};

// --- coordination opportunities --------------------------------------------------
// A post ("anyone up for climbing Saturday?") addressed to everyone you're
// friends with, one friend, or a chosen group. Same privacy stance as
// activities: the audience is enforced server-side, and only the poster ever
// sees who a post was addressed to. In-memory and expiring, like signals.
interface Opportunity {
  id: string;
  fromId: string;
  text: string;
  /** "all" (= the poster's friends) or specific memberIds. */
  audience: "all" | string[];
  createdAt: number;
  expiresAt: number;
}

export interface OpportunityView {
  id: string;
  from: { memberId: string; displayName: string };
  text: string;
  postedAt: string;
  expiresAt: string;
  mine: boolean;
  /** Only present on your own posts — recipients never see the list. */
  audience?: "all" | string[];
}

const opportunities = new Map<string, Opportunity>();
const OPP_MAX_ACTIVE = 5;
const OPP_DEFAULT_MINS = 240;
// Posts are more asynchronous than signals ("Saturday?") — allow up to a day.
const clampOppMins = (m: number) => Math.min(1440, Math.max(15, Math.round(m)));
const lastPost = new Map<string, number>();

function oppView(o: Opportunity, viewerId: string): OpportunityView {
  const poster = members.get(o.fromId);
  return {
    id: o.id,
    from: { memberId: o.fromId, displayName: poster?.displayName ?? "?" },
    text: o.text,
    postedAt: new Date(o.createdAt).toISOString(),
    expiresAt: new Date(o.expiresAt).toISOString(),
    mine: o.fromId === viewerId,
    ...(o.fromId === viewerId ? { audience: o.audience } : {}),
  };
}

/** Friendship is checked at view time, so unfriending hides the post. */
function canSeeOpp(o: Opportunity, viewerId: string): boolean {
  if (o.fromId === viewerId) return true;
  const poster = members.get(o.fromId);
  if (!poster?.friends.has(viewerId)) return false;
  return o.audience === "all" || o.audience.includes(viewerId);
}

function oppRecipients(o: Opportunity): Member[] {
  const poster = members.get(o.fromId);
  if (!poster) return [];
  const ids = o.audience === "all" ? [...poster.friends] : o.audience;
  return ids
    .map((id) => members.get(id))
    .filter((m): m is Member => !!m && poster.friends.has(m.id));
}

export function postOpportunity(
  from: Member,
  text: string,
  audience: "all" | string[],
  minutes?: number,
): { ok: true; opportunity: OpportunityView } | { ok: false; error: string } {
  const body = text.trim().slice(0, 200);
  if (!body) return { ok: false, error: "empty_text" };
  const now = Date.now();
  if (now - (lastPost.get(from.id) ?? 0) < 3_000) return { ok: false, error: "too_fast" };
  const active = [...opportunities.values()].filter((o) => o.fromId === from.id && now < o.expiresAt);
  if (active.length >= OPP_MAX_ACTIVE) return { ok: false, error: "too_many" };
  // Non-friends silently drop out of the audience — no probing.
  const aud: Opportunity["audience"] =
    audience === "all" ? "all" : [...new Set(audience)].filter((id) => from.friends.has(id));
  if (aud !== "all" && !aud.length) return { ok: false, error: "empty_audience" };
  lastPost.set(from.id, now);
  const opp: Opportunity = {
    id: `opp_${randomUUID()}`,
    fromId: from.id,
    text: body,
    audience: aud,
    createdAt: now,
    expiresAt: now + clampOppMins(minutes ?? OPP_DEFAULT_MINS) * 60_000,
  };
  opportunities.set(opp.id, opp);
  // The poster's own (other) devices learn about it too.
  sendTo(from.id, "opportunity", { opportunity: oppView(opp, from.id) });
  for (const r of oppRecipients(opp)) {
    const live = sendTo(r.id, "opportunity", { opportunity: oppView(opp, r.id) });
    emit({ type: "opportunity", from, to: r, text: body, expiresAt: opp.expiresAt, live });
  }
  return { ok: true, opportunity: oppView(opp, from.id) };
}

/** Poster-only. Recipients' overlays drop the post immediately. */
export function removeOpportunity(member: Member, id: string): boolean {
  const opp = opportunities.get(id);
  if (!opp || opp.fromId !== member.id) return false;
  opportunities.delete(id);
  sendTo(member.id, "opportunity-removed", { id });
  for (const r of oppRecipients(opp)) sendTo(r.id, "opportunity-removed", { id });
  return true;
}

export function opportunitiesFor(viewer: Member): OpportunityView[] {
  const now = Date.now();
  return [...opportunities.values()]
    .filter((o) => now < o.expiresAt && canSeeOpp(o, viewer.id))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((o) => oppView(o, viewer.id));
}

// --- call handshake ------------------------------------------------------------
// A call only happens by mutual consent: A requests (optionally attaching
// their own room link, e.g. a personal Google Meet), B accepts, THEN the
// link — or a room minted from the server template as fallback — is pushed
// to both. Requests expire quickly.
const pendingCalls = new Map<string, { expiresAt: number; link?: string }>(); // "fromId>toId"
const CALL_REQUEST_TTL = 2 * 60_000;

export function requestCall(from: Member, toMemberId: string, link?: string) {
  const result = sendDirect("call-request", from, toMemberId, {});
  if (result.ok) {
    pendingCalls.set(`${from.id}>${toMemberId}`, { expiresAt: Date.now() + CALL_REQUEST_TTL, link });
    const to = members.get(toMemberId);
    if (to) emit({ type: "call-request", from, to, live: result.delivered });
  }
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
  let accepterLive = false;
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
      if (isAccepter) accepterLive = true;
    } catch {
      subscribers.delete(sub);
    }
  }
  emit({ type: "call-start", requester, accepter, url, requesterLive: delivered, accepterLive });
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
  // Lapsed posts vanish silently — clients tick them out locally from
  // expiresAt, so no broadcast is needed.
  for (const [id, o] of opportunities) if (now >= o.expiresAt) opportunities.delete(id);
}, 15_000).unref?.();

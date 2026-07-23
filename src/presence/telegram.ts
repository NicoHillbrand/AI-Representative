import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { type ChatMessage } from "../llm.js";
import { respond } from "../representative.js";
import { captureChatForward } from "../forwarding/capture.js";
import { createSession, type Session } from "../negotiation/store.js";
import { processTurn, summarize } from "../negotiation/negotiate.js";
import {
  acceptCall,
  addFriendByCode,
  bindTelegramChat,
  groupsFor,
  hasLiveSubscriber,
  memberByTelegramChat,
  opportunitiesFor,
  removeGroup,
  resolveGroup,
  setGroup,
  pairWithCode,
  postOpportunity,
  presetsFor,
  redeemTelegramLinkCode,
  roster,
  setEventSink,
  setPresets,
  setSignal,
  clearSignal,
  unlinkTelegram,
  type Member,
  type PresenceEvent,
  type Preset,
  type FriendGroup,
  type SignalAudience,
} from "./store.js";

/**
 * Telegram bridge — one bot, two jobs:
 *
 *  1. For LINKED Huddle members (overlay settings → Telegram): out-of-overlay
 *     notifications (pings, call requests with an inline Accept button,
 *     friends going available, room links), and setting your availability via
 *     explicit commands (`/up`, the picker, `/clear`). Free text is never
 *     interpreted as availability — it always goes to the representative.
 *  2. For anyone else: chatting with the representative, same as the web UI.
 *
 * Relay rule: Telegram only fires when the member did NOT get the event on a
 * connected overlay (`live` flags from the store) — no double-buzzing.
 */

const TG = () => `https://api.telegram.org/bot${config.telegramBotToken}`;

let botUsername: string | undefined;
export const telegramEnabled = () => !!config.telegramBotToken;
export const telegramBotUsername = () => botUsername;

async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${TG()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body: any = await res.json().catch(() => ({ ok: false, description: "bad json" }));
  if (!body.ok) console.error(`telegram ${method} failed:`, body.description);
  return body.result;
}

const dm = (chatId: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id: chatId, text, ...extra });

const fmtMins = (m: number) => (m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`);

// A scheduled post's activity window, e.g. "Sat, Jul 25, 06:00 PM – 09:00 PM".
// Rendered in the server's timezone (Telegram gives us no per-user zone).
const fmtWhen = (startsAt: number, endsAt?: number): string => {
  const day = new Date(startsAt).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (!endsAt) return day;
  const end = new Date(endsAt).toLocaleString("en-US", { hour: "2-digit", minute: "2-digit" });
  return `${day} – ${end}`;
};

// --- outgoing notifications -----------------------------------------------------
function onPresenceEvent(e: PresenceEvent): void {
  if (e.type === "ping" && !e.live && e.to.telegramChatId) {
    dm(e.to.telegramChatId, `👋 ${e.from.displayName} pinged you on Huddle.`);
  } else if (e.type === "call-request" && !e.live && e.to.telegramChatId) {
    dm(e.to.telegramChatId, `📞 ${e.from.displayName} wants to call (expires in 2 min).`, {
      reply_markup: {
        inline_keyboard: [[{ text: "Accept call", callback_data: `accept:${e.from.id}` }]],
      },
    });
  } else if (e.type === "call-start") {
    if (!e.requesterLive && e.requester.telegramChatId)
      dm(e.requester.telegramChatId, `📞 ${e.accepter.displayName} accepted! Join: ${e.url}`);
    if (!e.accepterLive && e.accepter.telegramChatId)
      dm(e.accepter.telegramChatId, `📞 Call with ${e.requester.displayName}: ${e.url}`);
  } else if (e.type === "opportunity" && !e.live && e.to.telegramChatId) {
    const window = e.startsAt
      ? `📅 ${fmtWhen(e.startsAt, e.endsAt)}`
      : `stands for ${fmtMins(Math.round((e.expiresAt - Date.now()) / 60_000))}`;
    dm(e.to.telegramChatId, `📣 ${e.from.displayName} posted: "${e.text}" (${window})`);
  } else if (e.type === "went-available" && !e.live && e.friend.telegramChatId) {
    const acts = e.member.signal?.activities
      .map((a) => `${a.label}${a.durationMinutes ? ` (~${a.durationMinutes}min call)` : ""}`)
      .join(", ");
    dm(
      e.friend.telegramChatId,
      `🟢 ${e.member.displayName} is up for a call${acts ? ` — ${acts}` : ""}.`,
    );
  }
}

// --- availability ----------------------------------------------------------------
interface ActivityInput {
  label: string;
  durationMinutes?: number;
  /** Per-friend visibility, when known (preset picker); defaults to "all". */
  visibleTo?: "all" | string[];
  /** Group names (live references), when known (preset picker). */
  visibleToGroups?: string[];
}

function applyAvailability(
  member: Member,
  mins: number | undefined,
  activities: ActivityInput[],
  note?: string,
  audience?: SignalAudience & { label?: string },
): string {
  const entry = setSignal(
    member,
    mins ?? 60,
    note,
    activities.slice(0, 20).map((a) => ({
      label: a.label.slice(0, 60),
      visibleTo: a.visibleTo ?? ("all" as const),
      visibleToGroups: a.visibleToGroups,
      durationMinutes: a.durationMinutes,
    })),
    audience,
  );
  const until = entry.availableUntil ? new Date(entry.availableUntil) : undefined;
  const mm = until ? Math.round((until.getTime() - Date.now()) / 60_000) : mins ?? 60;
  const actText = activities
    .map((a) => `${a.label}${a.durationMinutes ? ` (~${a.durationMinutes}min call)` : ""}`)
    .join(", ");
  const noteText = note?.trim() ? ` (${note.trim()})` : "";
  const audText = audience?.label ? ` · only ${audience.label}` : "";
  return `🟢 You're reachable for ${mm} min${actText ? ` — ${actText}` : ""}${noteText}${audText}. Your friends' overlays just updated.`;
}

// --- /up wizard --------------------------------------------------------------------
// Bare /up walks you through going available ONE STEP AT A TIME, each its own
// message: activity (a preset or your own) → optional detail → how long you're
// up → call length → who can see it. Presets are only edited via /presets;
// here they're just quick choices. Every typed step echoes a confirmation.
interface UpWizard {
  step: "activity" | "detail" | "window" | "call" | "audience";
  presets: Preset[];
  friends: { memberId: string; displayName: string }[];
  groups: FriendGroup[];
  activityLabel?: string; // chosen preset label or typed activity
  fromPreset: boolean; // preset chosen (→ detail is an optional note) vs typed
  note?: string; // detail refining a preset
  mins: number; // how long you're reachable
  callMins?: number; // expected call length (undefined = unset)
  audEveryone: boolean; // audience = all friends (the default)
  audFriends: Set<number>;
  audGroups: Set<number>;
  /** The current step's message, so a typed answer can confirm on it and
   * toggles can re-render in place. */
  stepMessageId?: number;
}
const upWizards = new Map<number, UpWizard>(); // telegram chatId -> wizard

const PICKER_WINDOWS = [30, 60, 90];
const PICKER_CALLS = [5, 15, 30, 60]; // call-length options, minutes
const CANCEL_ROW = [{ text: "Cancel", callback_data: "uw:x" }];

async function startUpWizard(chatId: number, member: Member): Promise<void> {
  const w: UpWizard = {
    step: "activity",
    presets: presetsFor(member),
    friends: friendEntriesOf(member),
    groups: groupsFor(member),
    fromPreset: false,
    mins: 60,
    audEveryone: true,
    audFriends: new Set(),
    audGroups: new Set(),
  };
  upWizards.set(chatId, w);
  const rows = w.presets.map((p, i) => [{ text: p.label, callback_data: `uw:a:${i}` }]);
  rows.push([{ text: "✍️ Type my own", callback_data: "uw:atype" }]);
  rows.push(CANCEL_ROW);
  const sent = await dm(chatId, "What do you want to do? Pick a call type, or type your own:", {
    reply_markup: { inline_keyboard: rows },
  });
  w.stepMessageId = sent?.message_id;
}

// Preset chosen → detail is an OPTIONAL note (type it, or Skip).
async function sendDetailStep(chatId: number, w: UpWizard): Promise<void> {
  w.step = "detail";
  pending.set(chatId, { kind: "uw-detail" });
  const sent = await dm(chatId, `Add a detail to "${w.activityLabel}"? Type it below, or tap Skip:`, {
    reply_markup: { inline_keyboard: [[{ text: "Skip", callback_data: "uw:dskip" }], CANCEL_ROW] },
  });
  w.stepMessageId = sent?.message_id;
}

// Skipped presets → the typed text IS the activity.
async function sendTypeActivityStep(chatId: number, w: UpWizard): Promise<void> {
  w.step = "activity";
  pending.set(chatId, { kind: "uw-activity" });
  const sent = await dm(chatId, "Type the activity you have in mind:", {
    reply_markup: { inline_keyboard: [CANCEL_ROW] },
  });
  w.stepMessageId = sent?.message_id;
}

async function sendWindowStep(chatId: number, w: UpWizard): Promise<void> {
  w.step = "window";
  const rows = [PICKER_WINDOWS.map((m) => ({ text: `${m} min`, callback_data: `uw:w:${m}` })), CANCEL_ROW];
  const sent = await dm(chatId, "How long are you up for?", { reply_markup: { inline_keyboard: rows } });
  w.stepMessageId = sent?.message_id;
}

async function sendCallStep(chatId: number, w: UpWizard): Promise<void> {
  w.step = "call";
  const rows = [
    PICKER_CALLS.map((m) => ({ text: `${m} min`, callback_data: `uw:c:${m}` })),
    [{ text: "Not sure / skip", callback_data: "uw:cskip" }],
    CANCEL_ROW,
  ];
  const sent = await dm(chatId, "How long is the call/activity itself?", { reply_markup: { inline_keyboard: rows } });
  w.stepMessageId = sent?.message_id;
}

// Audience: Everyone (default, a built-in "group") + your groups + friends.
// Multi-select; ticking anyone specific turns Everyone off, and clearing all
// turns it back on.
function audienceKeyboard(w: UpWizard) {
  const rows: { text: string; callback_data: string }[][] = [];
  rows.push([{ text: `${w.audEveryone ? "☑" : "☐"} 🌍 Everyone`, callback_data: "uw:ae" }]);
  for (const [i, g] of w.groups.entries())
    rows.push([{ text: `${w.audGroups.has(i) ? "☑" : "☐"} #${g.name}`, callback_data: `uw:g:${i}` }]);
  for (let i = 0; i < w.friends.length; i += 2) {
    const row: { text: string; callback_data: string }[] = [];
    for (const j of [i, i + 1]) {
      const f = w.friends[j];
      if (f) row.push({ text: `${w.audFriends.has(j) ? "☑" : "☐"} ${f.displayName}`, callback_data: `uw:f:${j}` });
    }
    rows.push(row);
  }
  rows.push([{ text: "🟢 Go available", callback_data: "uw:go" }, { text: "Cancel", callback_data: "uw:x" }]);
  return { inline_keyboard: rows };
}

async function sendAudienceStep(chatId: number, w: UpWizard): Promise<void> {
  w.step = "audience";
  const sent = await dm(chatId, "Who can see it? Everyone by default — or tick friends/groups, then Go:", {
    reply_markup: audienceKeyboard(w),
  });
  w.stepMessageId = sent?.message_id;
}

// --- /post parsing ----------------------------------------------------------------
// "/post [minutes] [to <names>:] <text>" — the argument shapes:
//   climbing Saturday?                        → all friends, default window
//   90 to Ada, Bob: sauna tonight?            → 90 min, only Ada and Bob
//   to Ada Lovelace: chess?                   → names may contain spaces,
//                                               which is why the colon is the
//                                               delimiter (a plain "to be
//                                               honest..." post won't trigger).
// Exported for tests.
export function parsePostArgs(raw: string): {
  minutes?: number;
  toNames?: string[];
  text: string;
} {
  let rest = raw.trim();
  const minsMatch = rest.match(/^(\d+)\s*(?:min|m)?\s+(.*)$/is);
  const minutes = minsMatch ? parseInt(minsMatch[1], 10) : undefined;
  if (minsMatch) rest = minsMatch[2].trim();
  const toMatch = rest.match(/^to\s+([^:]+):\s*(.*)$/is);
  if (!toMatch) return { minutes, text: rest };
  const toNames = toMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
  return toNames.length
    ? { minutes, toNames, text: toMatch[2].trim() }
    : { minutes, text: rest };
}

/** Case-insensitive exact match first, then unique prefix ("ada" → "Ada L…"). */
function resolveFriendName(
  name: string,
  friendEntries: { memberId: string; displayName: string }[],
): { ok: true; memberId: string; displayName: string } | { ok: false; error: string } {
  const lower = name.toLowerCase();
  const exact = friendEntries.filter((f) => f.displayName.toLowerCase() === lower);
  const matches = exact.length
    ? exact
    : friendEntries.filter((f) => f.displayName.toLowerCase().startsWith(lower));
  if (matches.length === 1) return { ok: true, ...matches[0] };
  return {
    ok: false,
    error:
      matches.length === 0
        ? `No friend called "${name}". Your friends: ${
            friendEntries.map((f) => f.displayName).join(", ") || "(none yet)"
          }`
        : `"${name}" matches several friends (${matches
            .map((f) => f.displayName)
            .join(", ")}) — be more specific.`,
  };
}

const friendEntriesOf = (member: Member) =>
  roster(member)
    .filter((m) => m.memberId !== member.id)
    .map((m) => ({ memberId: m.memberId, displayName: m.displayName }));

/** One "to …" segment → memberIds. Group names win over friend names on an
 * exact match ("close" the group beats a friend who happens to be named
 * Close); friends still resolve by unique prefix. */
function resolveAudienceSegment(
  member: Member,
  name: string,
): { ok: true; ids: string[]; label: string; group: boolean } | { ok: false; error: string } {
  const group = resolveGroup(member, name);
  if (group) {
    if (!group.memberIds.length)
      return { ok: false, error: `Your group "${group.name}" has no members — /groups set adds some.` };
    return { ok: true, ids: group.memberIds, label: group.name, group: true };
  }
  const friend = resolveFriendName(name, friendEntriesOf(member));
  if (!friend.ok) {
    const groupNames = groupsFor(member).map((g) => g.name);
    return {
      ok: false,
      error: friend.error + (groupNames.length ? `\nYour groups: ${groupNames.join(", ")}` : ""),
    };
  }
  return { ok: true, ids: [friend.memberId], label: friend.displayName, group: false };
}

// --- guided button flows (the picker philosophy) --------------------------------
// Everything is button-first. Where free text is genuinely needed (a post's
// wording, a new call-type topic, a group name) we PROMPT for it with a
// ForceReply and capture the next plain message — no command syntax to
// memorize. `pending` records what a chat's next plain-text message means.
type Pending =
  | { kind: "preset-add" }
  | { kind: "uw-activity" } // /up wizard: typed custom activity
  | { kind: "uw-detail" } // /up wizard: optional detail on a chosen preset
  | { kind: "group-new" }
  | { kind: "post-text" };
const pending = new Map<number, Pending>();

function promptFor(chatId: number, p: Pending, text: string): Promise<any> {
  pending.set(chatId, p);
  return dm(chatId, text, { reply_markup: { force_reply: true } });
}

async function handlePending(chatId: number, member: Member, p: Pending, text: string): Promise<void> {
  if (p.kind === "post-text") {
    const body = text.trim().slice(0, 200);
    if (!body) {
      await dm(chatId, "Nothing to post — send /post again when you're ready.");
      return;
    }
    await openPostWizard(chatId, member, body);
    return;
  }
  if (p.kind === "uw-activity") {
    const w = upWizards.get(chatId);
    if (!w) {
      await dm(chatId, "That wizard expired — send /up again.");
      return;
    }
    const label = text.trim().slice(0, 60);
    if (!label) {
      pending.set(chatId, { kind: "uw-activity" }); // re-arm; still waiting
      await dm(chatId, "Empty — type the activity, or /up to start over.");
      return;
    }
    w.activityLabel = label;
    w.fromPreset = false;
    if (w.stepMessageId !== undefined)
      await tg("editMessageText", { chat_id: chatId, message_id: w.stepMessageId, text: `✍️ Activity: ${label}` });
    await sendWindowStep(chatId, w);
    return;
  }
  if (p.kind === "uw-detail") {
    const w = upWizards.get(chatId);
    if (!w) {
      await dm(chatId, "That wizard expired — send /up again.");
      return;
    }
    w.note = text.trim().slice(0, 80) || undefined;
    if (w.stepMessageId !== undefined)
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: w.stepMessageId,
        text: `✅ ${w.activityLabel}${w.note ? ` — ${w.note}` : ""}`,
      });
    await sendWindowStep(chatId, w);
    return;
  }
  if (p.kind === "preset-add") {
    const label = text.trim().slice(0, 60);
    if (!label) {
      await dm(chatId, "Empty — nothing added.");
      return;
    }
    setPresets(member, [...presetsFor(member), { label, visibleTo: "all" }]);
    await openPresetsManager(chatId, member);
    return;
  }
  if (p.kind === "group-new") {
    const canon = text.trim().replace(/\s+/g, " ").slice(0, 24);
    const result = setGroup(member, canon, []);
    if (!result.ok) {
      await dm(
        chatId,
        result.error === "too_many"
          ? "You already have 20 groups — delete one first."
          : 'That name won\'t work — 1–24 characters, no "," or ":", and not "all"/"everyone".',
      );
      return;
    }
    const edit: GroupEdit = { name: canon, friends: friendEntriesOf(member) };
    editingGroup.set(chatId, edit);
    await dm(chatId, `Group "${canon}" created. Tick who's in it:`, {
      reply_markup: groupEditorKeyboard(member, edit),
    });
    return;
  }
}

// --- /post wizard ----------------------------------------------------------------
// Bare /post captures the text (post-text prompt), then walks the poster through
// it ONE STEP PER MESSAGE, like /up: audience → timing. Timing is either
// OPEN-ENDED ("sometime" — people arrange it with you; stands for a chosen
// duration) or a SET TIME (a day + part of day → a scheduled startsAt/endsAt).
interface PostWizard {
  text: string;
  friends: { memberId: string; displayName: string }[];
  groups: FriendGroup[];
  audEveryone: boolean;
  audFriends: Set<number>;
  audGroups: Set<number>;
  scheduleDay?: number; // chosen day (local midnight ms), set-time path
  stepMessageId?: number;
}
const postWizards = new Map<number, PostWizard>();

// Open-ended durations (minutes): 4 h, 1 day, 3 days, 1 week.
const POST_DURATIONS: { mins: number; label: string }[] = [
  { mins: 240, label: "4 hours" },
  { mins: 1440, label: "1 day" },
  { mins: 4320, label: "3 days" },
  { mins: 10080, label: "1 week" },
];
// Parts of a day → a start/end hour window (local server time).
const POST_TIMES: { key: string; label: string; s: number; e: number }[] = [
  { key: "morning", label: "🌅 Morning (9–12)", s: 9, e: 12 },
  { key: "midday", label: "☀️ Midday (12–2)", s: 12, e: 14 },
  { key: "afternoon", label: "🌤 Afternoon (2–5)", s: 14, e: 17 },
  { key: "evening", label: "🌆 Evening (6–9)", s: 18, e: 21 },
  { key: "night", label: "🌙 Night (9–11)", s: 21, e: 23 },
  { key: "allday", label: "🗓 All day (9–9)", s: 9, e: 21 },
];

function dayMidnight(offset: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.getTime();
}
function dayLabel(offset: number): string {
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  return new Date(dayMidnight(offset)).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function postAudienceKeyboard(w: PostWizard) {
  const rows: { text: string; callback_data: string }[][] = [];
  rows.push([{ text: `${w.audEveryone ? "☑" : "☐"} 🌍 Everyone`, callback_data: "pw:ae" }]);
  for (const [i, g] of w.groups.entries())
    rows.push([{ text: `${w.audGroups.has(i) ? "☑" : "☐"} #${g.name}`, callback_data: `pw:g:${i}` }]);
  for (let i = 0; i < w.friends.length; i += 2) {
    const row: { text: string; callback_data: string }[] = [];
    for (const j of [i, i + 1]) {
      const f = w.friends[j];
      if (f) row.push({ text: `${w.audFriends.has(j) ? "☑" : "☐"} ${f.displayName}`, callback_data: `pw:f:${j}` });
    }
    rows.push(row);
  }
  rows.push([{ text: "Next →", callback_data: "pw:next" }, { text: "Cancel", callback_data: "pw:x" }]);
  return { inline_keyboard: rows };
}

async function openPostWizard(chatId: number, member: Member, text: string): Promise<void> {
  const w: PostWizard = {
    text,
    friends: friendEntriesOf(member),
    groups: groupsFor(member),
    audEveryone: true,
    audFriends: new Set(),
    audGroups: new Set(),
  };
  postWizards.set(chatId, w);
  const sent = await dm(
    chatId,
    `📣 "${text}"\nWho should see it? Everyone by default — or tick friends/groups, then Next:`,
    { reply_markup: postAudienceKeyboard(w) },
  );
  w.stepMessageId = sent?.message_id;
}

async function sendPostTimingStep(chatId: number, w: PostWizard): Promise<void> {
  const rows = [
    [{ text: "🗓 Sometime — people arrange it with you", callback_data: "pw:tnow" }],
    [{ text: "📅 At a set time", callback_data: "pw:tset" }],
    [{ text: "Cancel", callback_data: "pw:x" }],
  ];
  const sent = await dm(chatId, "When? Keep it open-ended, or pin a set time:", {
    reply_markup: { inline_keyboard: rows },
  });
  w.stepMessageId = sent?.message_id;
}

async function sendPostDurationStep(chatId: number, w: PostWizard): Promise<void> {
  const rows = [
    POST_DURATIONS.map((d) => ({ text: d.label, callback_data: `pw:d:${d.mins}` })),
    [{ text: "Cancel", callback_data: "pw:x" }],
  ];
  const sent = await dm(chatId, "How long should the post stand?", { reply_markup: { inline_keyboard: rows } });
  w.stepMessageId = sent?.message_id;
}

async function sendPostDayStep(chatId: number, w: PostWizard): Promise<void> {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let off = 0; off < 7; off += 2) {
    const row: { text: string; callback_data: string }[] = [];
    for (const o of [off, off + 1]) if (o < 7) row.push({ text: dayLabel(o), callback_data: `pw:day:${o}` });
    rows.push(row);
  }
  rows.push([{ text: "Cancel", callback_data: "pw:x" }]);
  const sent = await dm(chatId, "Which day?", { reply_markup: { inline_keyboard: rows } });
  w.stepMessageId = sent?.message_id;
}

async function sendPostTimeStep(chatId: number, w: PostWizard): Promise<void> {
  const now = Date.now();
  const isToday = w.scheduleDay === dayMidnight(0);
  const opts = isToday
    ? POST_TIMES.filter((t) => (w.scheduleDay ?? 0) + t.s * 3_600_000 > now - 60_000)
    : POST_TIMES;
  const list = opts.length ? opts : POST_TIMES; // late-night fallback; backend guards the past
  const rows = list.map((t) => [{ text: t.label, callback_data: `pw:tod:${t.key}` }]);
  rows.push([{ text: "Cancel", callback_data: "pw:x" }]);
  const sent = await dm(chatId, "What time of day?", { reply_markup: { inline_keyboard: rows } });
  w.stepMessageId = sent?.message_id;
}

/** Resolve the wizard's audience, post it, and return the confirmation text. */
function postFromWizard(
  member: Member,
  w: PostWizard,
  opts: { minutes?: number; when?: { startsAt: number; endsAt?: number } },
): string {
  const ids = new Set<string>();
  for (const i of w.audGroups) for (const id of w.groups[i]?.memberIds ?? []) ids.add(id);
  for (const i of w.audFriends) {
    const f = w.friends[i];
    if (f) ids.add(f.memberId);
  }
  const restricted = !w.audEveryone && ids.size > 0;
  const audienceLabel =
    !w.audEveryone && w.audGroups.size === 1 && w.audFriends.size === 0
      ? w.groups[[...w.audGroups][0]]?.name
      : undefined;
  const result = postOpportunity(member, w.text, restricted ? [...ids] : "all", opts.minutes, audienceLabel, opts.when);
  if (!result.ok) {
    return result.error === "too_many"
      ? "You already have 5 open posts — they expire on their own."
      : result.error === "too_fast"
        ? "Easy — you just posted. Give it a moment."
        : result.error === "bad_time"
          ? "That time has already passed (or is too far out) — send /post to try again."
          : "Couldn't post that.";
  }
  const o = result.opportunity;
  const audText = !restricted
    ? "all your friends"
    : audienceLabel
      ? `${audienceLabel} (${ids.size} friend${ids.size === 1 ? "" : "s"})`
      : `${ids.size} friend${ids.size === 1 ? "" : "s"}`;
  const when = o.startsAt
    ? `📅 ${fmtWhen(new Date(o.startsAt).getTime(), o.endsAt ? new Date(o.endsAt).getTime() : undefined)}`
    : `stands for ${fmtMins(Math.round((new Date(o.expiresAt).getTime() - Date.now()) / 60_000))}`;
  return `📣 Posted to ${audText} (${when}): "${o.text}"`;
}

// --- /presets manager ------------------------------------------------------------
// A preset is just a topic. Tap 🗑 to remove one, ➕ to add one.
function presetsManagerKeyboard(member: Member) {
  const rows: { text: string; callback_data: string }[][] = presetsFor(member).map((p, i) => [
    { text: `🗑 ${p.label}`, callback_data: `pst:rm:${i}` },
  ]);
  rows.push([{ text: "➕ New call type", callback_data: "pst:add" }]);
  rows.push([{ text: "Done", callback_data: "pst:done" }]);
  return { inline_keyboard: rows };
}

async function openPresetsManager(chatId: number, member: Member): Promise<void> {
  await dm(
    chatId,
    "Your call types (topics the /up picker offers). Tap 🗑 to remove one, or add a new one:",
    { reply_markup: presetsManagerKeyboard(member) },
  );
}

// --- /groups manager -------------------------------------------------------------
interface GroupEdit {
  name: string;
  /** Snapshot so friend indices stay valid across toggles. */
  friends: { memberId: string; displayName: string }[];
}
const editingGroup = new Map<number, GroupEdit>();

function groupsManagerKeyboard(member: Member) {
  const rows: { text: string; callback_data: string }[][] = groupsFor(member).map((g, i) => [
    { text: `${g.name} (${g.memberIds.length})`, callback_data: `grp:open:${i}` },
  ]);
  rows.push([{ text: "➕ New group", callback_data: "grp:new" }]);
  rows.push([{ text: "Done", callback_data: "grp:done" }]);
  return { inline_keyboard: rows };
}

async function openGroupsManager(chatId: number, member: Member): Promise<void> {
  await dm(chatId, "Your friend groups — tap one to edit its members, or make a new one:", {
    reply_markup: groupsManagerKeyboard(member),
  });
}

function groupEditorKeyboard(member: Member, edit: GroupEdit) {
  const inGroup = new Set(resolveGroup(member, edit.name)?.memberIds ?? []);
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < edit.friends.length; i += 2) {
    const row: { text: string; callback_data: string }[] = [];
    for (const j of [i, i + 1]) {
      const f = edit.friends[j];
      if (f) row.push({ text: `${inGroup.has(f.memberId) ? "☑" : "☐"} ${f.displayName}`, callback_data: `grpe:tf:${j}` });
    }
    rows.push(row);
  }
  rows.push([
    { text: "🗑 Delete group", callback_data: "grpe:del" },
    { text: "Back", callback_data: "grpe:back" },
  ]);
  return { inline_keyboard: rows };
}

// --- negotiation mode --------------------------------------------------------------
// /negotiate runs the gated mutual-interest protocol right in the chat: the
// user describes what they're after, the matching plane confirms overlaps
// bilaterally, /done delivers the summary. Uses the same engine as the
// public API, so all two-plane guarantees hold.
const negotiations = new Map<number, Session>(); // telegram chatId -> session

async function negotiationTurn(chatId: number, session: Session, text: string): Promise<void> {
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  try {
    const result = await processTurn(session, text.slice(0, 8000));
    const banner = result.newMatches.length
      ? result.newMatches.map((m) => `✅ Mutual interest confirmed: ${m.label}`).join("\n") + "\n\n"
      : "";
    await dm(chatId, `${banner}${result.reply}\n\n(say more, or /done for the summary)`);
  } catch (err) {
    console.error("telegram negotiation turn failed", err);
    await dm(chatId, "That turn failed — try again in a moment, or /done to wrap up.");
  }
}

async function endNegotiation(chatId: number, session: Session): Promise<void> {
  negotiations.delete(chatId);
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  try {
    const summary = await summarize(session);
    const matches = session.confirmedMatches.length
      ? "\n\nConfirmed mutual interests:\n" +
        session.confirmedMatches.map((m) => `✅ ${m.label}`).join("\n")
      : "\n\nNo mutual interests were confirmed this time.";
    await dm(chatId, `${summary}${matches}`);
  } catch (err) {
    console.error("telegram negotiation summary failed", err);
    await dm(chatId, "Couldn't produce the summary, but the session is closed.");
  }
}

// --- representative chat fallback ------------------------------------------------
const chatHistories = new Map<number, ChatMessage[]>(); // telegram chatId -> history
const HISTORY_MAX = 20;
// Context is bounded two ways: at most HISTORY_MAX messages, and at most
// this many characters in total — whichever bites first drops the OLDEST
// messages. /new resets on demand; this keeps it bounded automatically.
const HISTORY_CHAR_BUDGET = 24_000;
const hinted = new Set<number>();

function trimHistory(history: ChatMessage[]): ChatMessage[] {
  const trimmed = history.slice(-HISTORY_MAX);
  let total = trimmed.reduce((n, m) => n + m.content.length, 0);
  // Keep at least the latest exchange, however large.
  while (trimmed.length > 2 && total > HISTORY_CHAR_BUDGET) {
    total -= trimmed.shift()!.content.length;
  }
  return trimmed;
}

async function chatWithRepresentative(chatId: number, text: string): Promise<void> {
  const history = chatHistories.get(chatId) ?? [];
  history.push({ role: "user", content: text.slice(0, 4000) });
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  try {
    const reply = await respond(history);
    history.push({ role: "assistant", content: reply });
    chatHistories.set(chatId, trimHistory(history));
    await dm(chatId, reply);
    // Same loose forwarding pass as the web chat: if the person was trying to
    // reach Nico, tell them what the filter decided.
    const verdict = await captureChatForward(history, reply, "telegram").catch(() => null);
    if (verdict) await dm(chatId, verdict.status === "forwarded" ? `✅ ${verdict.reason}` : `ℹ️ ${verdict.reason}`);
  } catch (err) {
    console.error("telegram chat failed", err);
    await dm(chatId, "The representative didn't answer — try again in a moment.");
  }
}

// --- command overview --------------------------------------------------------------
// One source of truth for "what can I do here": /help shows it, and every
// fresh /start (with or without a link code) opens with it. Split into the two
// worlds this bot serves — coordinating with friends (Huddle) and talking to
// Nico's AI representative.
function commandOverview(member: Member | undefined): string {
  return member
    ? `🟢 Huddle — coordinate calls & activities with friends:
/up — go available for a spontaneous call right now
/post — propose something for later (a set time, or open-ended)
/status — who's up for a call, or other coordination opportunities
/clear — stop being available
/presets — your call/activity types
/groups — your friend groups
/code — your friend code (others add you with it)
/addfriend <code> — add a friend by their code
/unlink — disconnect Telegram

💬 Nico's AI representative:
Just type a message to chat with it.
/new — fresh chat (forget earlier messages)`
    : `💬 Nico's AI representative:
Ask me anything about Nico — just type.
/new — fresh chat (forget earlier messages)

🟢 Huddle — coordinate with Nico & friends:
/join <friend-code> <name> — join right here on Telegram (no install), or link an existing overlay from its settings.

/help — show this again.`;
}

// --- incoming --------------------------------------------------------------------
function mintFallbackUrl(): string {
  const room = randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x");
  return config.huddleCallLink.replace("{room}", room);
}

async function onMessage(msg: any): Promise<void> {
  if (msg.chat?.type !== "private" || typeof msg.text !== "string") return;
  const chatId: number = msg.chat.id;
  const text = msg.text.trim();
  const member = memberByTelegramChat(chatId);

  // A pending ForceReply prompt (add a call type, name a group, compose a post)
  // claims the next plain-text message. A command (leading "/") cancels it and
  // is handled normally.
  const pend = pending.get(chatId);
  if (pend) {
    pending.delete(chatId);
    if (member && !text.startsWith("/")) {
      await handlePending(chatId, member, pend, text);
      return;
    }
  }

  // /start <link-code> — from the overlay's deep link. Every /start ends
  // with the full command overview, so a fresh chat explains itself.
  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1];
    if (code) {
      const linked = redeemTelegramLinkCode(code, chatId);
      await dm(
        chatId,
        linked
          ? `Linked to your Huddle identity, ${linked.displayName} ✅\nYou'll get pings, call requests and friend updates here when your overlay is closed.\n\nHere's everything you can do:\n${commandOverview(linked)}`
          : "That link code is invalid or expired — get a fresh one from the overlay (settings → Telegram).",
      );
    } else {
      await dm(
        chatId,
        member
          ? `You're linked as ${member.displayName}. Here's what you can do:\n\n${commandOverview(member)}`
          : `Hi! I'm an AI representative. Here's what you can do:\n\n${commandOverview(undefined)}`,
      );
    }
    return;
  }

  if (text === "/help") {
    await dm(chatId, commandOverview(member));
    return;
  }

  // Telegram-only membership: no overlay required, ever. A friend's code is
  // the credential, exactly as in the overlay's onboarding.
  if (text.startsWith("/join")) {
    if (member) {
      await dm(chatId, `You're already in as ${member.displayName}.`);
      return;
    }
    const [, code, ...nameParts] = text.split(/\s+/);
    const name = nameParts.join(" ");
    if (!code || !name) {
      await dm(chatId, "Usage: /join <friend-code> <your name>\ne.g. /join kqm3-x7p2 Ada");
      return;
    }
    const result = pairWithCode(code, name, config.huddleInviteCodes);
    if (!result.ok) {
      await dm(chatId, "That code doesn't match anyone — ask your friend for theirs (/code shows it).");
      return;
    }
    bindTelegramChat(result.member, chatId);
    await dm(
      chatId,
      `Welcome, ${result.member.displayName}! You're in — right here on Telegram, no install needed.\nYour own friend code (share it to add people): ${result.member.friendCode}\n\nHere's everything you can do:\n${commandOverview(result.member)}`,
    );
    return;
  }

  if (member && text === "/code") {
    await dm(
      chatId,
      `Your friend code: ${member.friendCode}\nAnyone can join as your friend with: /join ${member.friendCode} TheirName — or enter it in the desktop overlay.`,
    );
    return;
  }

  if (member && text.startsWith("/addfriend")) {
    const code = text.split(/\s+/)[1];
    if (!code) {
      await dm(chatId, "Usage: /addfriend <their-friend-code>");
      return;
    }
    const result = addFriendByCode(member, code);
    await dm(
      chatId,
      result.ok
        ? `You and ${result.friend.displayName} are now friends.`
        : result.error === "self_code"
          ? "That's your own code."
          : "No one has that code — it may have been rotated.",
    );
    return;
  }

  // /new — wipe the representative-chat context for this Telegram chat.
  // Presence state (availability, friends, presets) is untouched; an open
  // negotiation keeps its own session and is unaffected too.
  if (text === "/new") {
    chatHistories.delete(chatId);
    await dm(
      chatId,
      "Fresh context — I've dropped our earlier chat messages here. (Availability, friends and presets are unaffected.)",
    );
    return;
  }

  if (text === "/negotiate") {
    const session = createSession(`telegram:${msg.from?.first_name ?? "counterpart"}`);
    negotiations.set(chatId, session);
    await dm(
      chatId,
      "Negotiation session open. Tell me what you (or your principal) are interested in — collaborations, exchanges, projects. Interests are only disclosed when they're mutual: if you assert something my principal is also privately interested in, we both find out; if not, nothing is revealed. /done when finished.",
    );
    return;
  }

  if (text === "/done") {
    const session = negotiations.get(chatId);
    if (session) await endNegotiation(chatId, session);
    else await dm(chatId, "No negotiation running — /negotiate starts one.");
    return;
  }

  if (member && text === "/unlink") {
    unlinkTelegram(member);
    await dm(chatId, "Unlinked. The overlay keeps working; Telegram notifications stop.");
    return;
  }

  if (member && text === "/status") {
    const roll = roster(member);
    const detail = (m: (typeof roll)[number]) =>
      `${
        m.activities?.length
          ? ` — ${m.activities
              .map((a) => `${a.label}${a.durationMinutes ? ` (~${a.durationMinutes}min call)` : ""}`)
              .join(", ")}`
          : ""
      }${m.note ? ` (${m.note})` : ""}`;
    // Your own signal first, so you can see (and sanity-check) what you set.
    const me = roll.find((m) => m.memberId === member.id);
    const myLeft = me?.availableUntil
      ? Math.round((new Date(me.availableUntil).getTime() - Date.now()) / 60_000)
      : 0;
    const mine = me?.available
      ? `You're up for ~${fmtMins(myLeft)}${detail(me)}`
      : "You're not signaled right now (/up to go available).";
    const up = roll.filter((m) => m.available && m.memberId !== member.id);
    const availability =
      `Your status:\n${me?.available ? "🟢 " : "⚪ "}${mine}\n\n` +
      (up.length
        ? "Up for a call:\n" + up.map((m) => `🟢 ${m.displayName}${detail(m)}`).join("\n")
        : "No one else is up right now.");
    // Telegram-only members have no overlay — /status is where they see
    // which coordination posts are still open.
    const posts = opportunitiesFor(member);
    const postLines = posts.length
      ? "\n\nOpen posts:\n" +
        posts
          .map((o) => {
            const when = o.startsAt
              ? `📅 ${fmtWhen(new Date(o.startsAt).getTime(), o.endsAt ? new Date(o.endsAt).getTime() : undefined)}`
              : `${fmtMins(Math.round((new Date(o.expiresAt).getTime() - Date.now()) / 60_000))} left`;
            return `📣 ${o.mine ? "You" : o.from.displayName}: "${o.text}" (${when})`;
          })
          .join("\n")
      : "";
    await dm(chatId, availability + postLines);
    return;
  }

  // /post — a coordination opportunity. Bare /post walks you through it with
  // buttons (compose → audience → how long); a typed "/post [minutes]
  // [to <names>:] <text>" still works as a shortcut.
  if (member && text.trim() === "/post") {
    await promptFor(
      chatId,
      { kind: "post-text" },
      "📣 What coordination opportunity do you want to share, or what activity do you want others to coordinate with you on?\nSend the text — I'll then ask who sees it and for how long.",
    );
    return;
  }
  if (member && text.startsWith("/post")) {
    const usage =
      "Usage: /post [minutes] [to <names>:] <text>\n" +
      "e.g. /post climbing Saturday morning?\n" +
      "/post to close: chess tonight? (a group — /groups manages them)\n" +
      "/post 90 to Ada, Bob: sauna in a bit? (names comma-separated, colon after)\n" +
      "Or just send /post on its own to do it with buttons.";
    const { minutes, toNames, text: body } = parsePostArgs(text.slice(5));
    if (!body) {
      await dm(chatId, usage);
      return;
    }
    let audience: "all" | string[] = "all";
    const audienceNames: string[] = [];
    let audienceLabel: string | undefined;
    // "to all:" / "to everyone:" is just the default spelled out.
    const names = toNames?.filter((n) => !["all", "everyone"].includes(n.toLowerCase()));
    if (names?.length) {
      const ids = new Set<string>();
      let groupCount = 0;
      for (const name of names) {
        const match = resolveAudienceSegment(member, name);
        if (!match.ok) {
          await dm(chatId, `${match.error}\n\n${usage}`);
          return;
        }
        for (const id of match.ids) ids.add(id);
        audienceNames.push(match.label);
        if (match.group) groupCount++;
      }
      audience = [...ids];
      // A single pure group keeps its name on the post ("to close").
      if (groupCount === 1 && names.length === 1) audienceLabel = audienceNames[0];
    }
    const result = postOpportunity(member, body, audience, minutes, audienceLabel);
    if (!result.ok) {
      await dm(
        chatId,
        result.error === "too_many"
          ? "You already have 5 open posts — they expire on their own, or remove one in the overlay."
          : result.error === "too_fast"
            ? "Easy — you just posted. Give it a moment."
            : "Couldn't post that.",
      );
      return;
    }
    const mins = Math.round(
      (new Date(result.opportunity.expiresAt).getTime() - Date.now()) / 60_000,
    );
    const audText =
      audience === "all"
        ? "all your friends"
        : audienceLabel
          ? `${audienceLabel} (${audience.length} friend${audience.length === 1 ? "" : "s"})`
          : [...new Set(audienceNames)].join(", ");
    await dm(
      chatId,
      `📣 Posted to ${audText} (stands for ${fmtMins(mins)}): "${result.opportunity.text}"`,
    );
    return;
  }

  if (member && text === "/clear") {
    clearSignal(member);
    await dm(chatId, "Cleared — you're no longer shown as available.");
    return;
  }

  if (member && text.startsWith("/up")) {
    // Step-by-step wizard, by design — no typed syntax. One prompt per message:
    // activity → detail → how long → call length → who sees it.
    await startUpWizard(chatId, member);
    return;
  }

  // /presets — see and edit the call-type catalog the /up picker offers.
  // Overlay users edit there (it re-syncs on every change and on launch, so
  // it wins); this is mainly for Telegram-only members.
  // Bare /presets opens the button manager; typed add/rm remain as shortcuts.
  if (member && text.trim() === "/presets") {
    await openPresetsManager(chatId, member);
    return;
  }
  if (member && text.startsWith("/presets")) {
    const [, sub, ...restArgs] = text.split(/\s+/);
    const current = presetsFor(member);
    const list = (presets: Preset[]) =>
      presets.length ? presets.map((p, i) => `${i + 1}. ${p.label}`).join("\n") : "(none)";
    if (sub === "add") {
      // A preset is just a topic (call length is chosen per-availability in /up).
      const label = restArgs.join(" ").trim().slice(0, 60);
      if (!label) {
        await dm(chatId, "Usage: /presets add <topic>\ne.g. /presets add rubber-duck a bug\n(Or just send /presets to manage them with buttons.)");
        return;
      }
      const updated = setPresets(member, [...current, { label, visibleTo: "all" }]);
      await dm(chatId, `Added. Your call types:\n${list(updated)}`);
      return;
    }
    if (sub === "rm") {
      const n = parseInt(restArgs[0] ?? "", 10);
      if (!Number.isFinite(n) || n < 1 || n > current.length) {
        await dm(chatId, `Usage: /presets rm <number 1–${current.length}> (see /presets for the list)`);
        return;
      }
      const updated = setPresets(member, current.filter((_, i) => i !== n - 1));
      await dm(chatId, `Removed. Your call types:\n${list(updated)}`);
      return;
    }
    await openPresetsManager(chatId, member);
    return;
  }

  // Bare /groups opens the button manager; typed set/add/drop/rm are shortcuts.
  if (member && text.trim() === "/groups") {
    await openGroupsManager(chatId, member);
    return;
  }
  // /groups — named friend sets for /post audiences. Shared with the
  // overlay's settings editor (same server-side list, live-synced).
  if (member && text.startsWith("/groups")) {
    const [, sub, groupName, ...restArgs] = text.split(/\s+/);
    const list = () => {
      const groups = groupsFor(member);
      if (!groups.length) return "(no groups yet)";
      const friendEntries = friendEntriesOf(member);
      const nameOf = (id: string) =>
        friendEntries.find((f) => f.memberId === id)?.displayName ?? "?";
      return groups
        .map((g) => `• ${g.name} — ${g.memberIds.map(nameOf).join(", ") || "(empty)"}`)
        .join("\n");
    };
    const usage =
      "/groups — list your groups\n" +
      "/groups set <name> <friend names, comma-separated> — create or replace one\n" +
      "  e.g. /groups set close Ada, Bob\n" +
      "/groups add <name> <friends> — add friends to it\n" +
      "/groups drop <name> <friends> — remove friends from it\n" +
      "/groups rm <name> — delete the whole group\n" +
      'Post to one with: /post to close: <text> (group names: one word, no ","/":").';
    if (sub === "add" || sub === "drop") {
      const memberNames = restArgs
        .join(" ")
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (!groupName || !memberNames.length) {
        await dm(chatId, usage);
        return;
      }
      const group = resolveGroup(member, groupName);
      if (!group) {
        await dm(chatId, `No group called "${groupName}". Make it with: /groups set ${groupName} <friends>`);
        return;
      }
      const ids = new Set(group.memberIds);
      for (const n of memberNames) {
        const match = resolveFriendName(n, friendEntriesOf(member));
        if (!match.ok) {
          await dm(chatId, match.error);
          return;
        }
        if (sub === "add") ids.add(match.memberId);
        else ids.delete(match.memberId);
      }
      const result = setGroup(member, group.name, [...ids]);
      if (!result.ok) {
        await dm(chatId, "Couldn't update that group — try again.");
        return;
      }
      await dm(chatId, `Updated. Your groups:\n${list()}`);
      return;
    }
    if (sub === "set") {
      const memberNames = restArgs
        .join(" ")
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (!groupName || !memberNames.length) {
        await dm(chatId, usage);
        return;
      }
      const ids: string[] = [];
      const resolved: string[] = [];
      for (const n of memberNames) {
        const match = resolveFriendName(n, friendEntriesOf(member));
        if (!match.ok) {
          await dm(chatId, match.error);
          return;
        }
        ids.push(match.memberId);
        resolved.push(match.displayName);
      }
      const result = setGroup(member, groupName, ids);
      if (!result.ok) {
        await dm(
          chatId,
          result.error === "too_many"
            ? "You already have 20 groups — remove one first (/groups rm <name>)."
            : 'That name won\'t work — one to 24 characters, no "," or ":", and not "all"/"everyone".',
        );
        return;
      }
      await dm(chatId, `Saved. Your groups:\n${list()}`);
      return;
    }
    if (sub === "rm") {
      if (!groupName) {
        await dm(chatId, usage);
        return;
      }
      const groups = removeGroup(member, groupName);
      await dm(chatId, groups ? `Removed. Your groups:\n${list()}` : `No group called "${groupName}".`);
      return;
    }
    await dm(chatId, `Your groups:\n${list()}\n\n${usage}`);
    return;
  }

  // An open negotiation session claims all free text until /done.
  const negotiation = negotiations.get(chatId);
  if (negotiation) {
    await negotiationTurn(chatId, negotiation, text);
    return;
  }

  // Free text always talks to the representative. Availability only changes
  // via explicit commands (/up, the picker, /clear) — a casual message must
  // never flip someone's status.
  if (!member && !hinted.has(chatId)) {
    hinted.add(chatId);
    await dm(
      chatId,
      "(You're chatting with the AI representative. Huddle users can link this bot from the overlay — settings → Telegram. /help shows everything you can do here.)",
    );
  }
  await chatWithRepresentative(chatId, text);
}

async function onCallback(cb: any): Promise<void> {
  const chatId: number | undefined = cb.message?.chat?.id;
  const messageId: number | undefined = cb.message?.message_id;
  const member = chatId !== undefined ? memberByTelegramChat(chatId) : undefined;
  const [action, ...args] = String(cb.data ?? "").split(":");
  const answer = (text?: string) =>
    tg("answerCallbackQuery", { callback_query_id: cb.id, ...(text ? { text } : {}) });

  if (member && action === "accept" && args[0]) {
    const result = acceptCall(member, args[0], mintFallbackUrl());
    await answer(
      result.ok
        ? "Accepted — the room link is on its way."
        : "That request expired — ask them to call again.",
    );
    return;
  }

  // /up wizard steps (uw:*). Single-choice steps confirm on the current
  // message and send the next prompt; the audience step multi-selects in place
  // then uw:go applies. uw:x cancels.
  if (member && chatId !== undefined && action === "uw") {
    const w = upWizards.get(chatId);
    if (!w) {
      await answer("This wizard expired — send /up again.");
      return;
    }
    const done = (text: string) =>
      messageId !== undefined
        ? tg("editMessageText", { chat_id: chatId, message_id: messageId, text })
        : dm(chatId, text);
    const sub = args[0];
    if (sub === "x") {
      upWizards.delete(chatId);
      pending.delete(chatId);
      await answer();
      await done("Okay — not going available.");
      return;
    }
    if (sub === "a") {
      const p = w.presets[parseInt(args[1] ?? "", 10)];
      if (!p) {
        await answer("That call type is gone.");
        return;
      }
      w.activityLabel = p.label;
      w.fromPreset = true;
      await answer();
      await done(`✅ Activity: ${p.label}`);
      await sendDetailStep(chatId, w);
      return;
    }
    if (sub === "atype") {
      await answer();
      await done("✍️ Type your activity below.");
      await sendTypeActivityStep(chatId, w);
      return;
    }
    if (sub === "dskip") {
      pending.delete(chatId);
      await answer();
      await done(`✅ Activity: ${w.activityLabel}`);
      await sendWindowStep(chatId, w);
      return;
    }
    if (sub === "w") {
      const m = parseInt(args[1] ?? "", 10);
      if (PICKER_WINDOWS.includes(m)) w.mins = m;
      await answer();
      await done(`✅ Up for ${w.mins} min`);
      await sendCallStep(chatId, w);
      return;
    }
    if (sub === "c" || sub === "cskip") {
      if (sub === "c") {
        const m = parseInt(args[1] ?? "", 10);
        if (PICKER_CALLS.includes(m)) w.callMins = m;
      }
      await answer();
      await done(w.callMins ? `✅ Call length: ~${w.callMins} min` : "✅ Call length: not set");
      await sendAudienceStep(chatId, w);
      return;
    }
    if (sub === "go") {
      upWizards.delete(chatId);
      const label = w.activityLabel?.trim();
      const activities = label
        ? [{ label, durationMinutes: w.callMins, visibleTo: "all" as const, visibleToGroups: undefined }]
        : [];
      const restricted = !w.audEveryone && (w.audFriends.size > 0 || w.audGroups.size > 0);
      const audFriendIds = [...w.audFriends]
        .map((i) => w.friends[i]?.memberId)
        .filter((x): x is string => !!x);
      const audGroupNames = [...w.audGroups].map((i) => w.groups[i]?.name).filter((x): x is string => !!x);
      const audLabels = [
        ...audGroupNames.map((n) => `#${n}`),
        ...[...w.audFriends].map((i) => w.friends[i]?.displayName).filter((x): x is string => !!x),
      ];
      const audience = restricted
        ? { visibleTo: audFriendIds, visibleToGroups: audGroupNames, label: audLabels.join(", ") }
        : undefined;
      const confirmation = applyAvailability(member, w.mins, activities, w.fromPreset ? w.note : undefined, audience);
      await answer();
      await done(confirmation);
      return;
    }
    // Audience toggles — re-render in place.
    if (sub === "ae") {
      w.audEveryone = true;
      w.audFriends.clear();
      w.audGroups.clear();
    } else if (sub === "g") {
      const i = parseInt(args[1] ?? "", 10);
      if (w.groups[i]) {
        w.audEveryone = false;
        w.audGroups.has(i) ? w.audGroups.delete(i) : w.audGroups.add(i);
      }
    } else if (sub === "f") {
      const i = parseInt(args[1] ?? "", 10);
      if (w.friends[i]) {
        w.audEveryone = false;
        w.audFriends.has(i) ? w.audFriends.delete(i) : w.audFriends.add(i);
      }
    }
    if (!w.audFriends.size && !w.audGroups.size) w.audEveryone = true; // nothing specific → everyone
    await answer();
    if (messageId !== undefined)
      await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: audienceKeyboard(w) });
    return;
  }

  // /post wizard (pw:*). Audience multi-selects in place → Next; timing is
  // open-ended (pw:tnow → duration) or a set time (pw:tset → day → part of
  // day). pw:x cancels.
  if (member && chatId !== undefined && action === "pw") {
    const w = postWizards.get(chatId);
    if (!w) {
      await answer("This wizard expired — send /post again.");
      return;
    }
    const done = (text: string) =>
      messageId !== undefined
        ? tg("editMessageText", { chat_id: chatId, message_id: messageId, text })
        : dm(chatId, text);
    const sub = args[0];
    if (sub === "x") {
      postWizards.delete(chatId);
      await answer();
      await done("Okay — not posting.");
      return;
    }
    if (sub === "next") {
      await answer();
      await done(`📣 "${w.text}"`);
      await sendPostTimingStep(chatId, w);
      return;
    }
    if (sub === "tnow") {
      await answer();
      await done("🗓 Open-ended — people arrange it with you.");
      await sendPostDurationStep(chatId, w);
      return;
    }
    if (sub === "tset") {
      await answer();
      await done("📅 At a set time.");
      await sendPostDayStep(chatId, w);
      return;
    }
    if (sub === "d") {
      postWizards.delete(chatId);
      await answer();
      await done(postFromWizard(member, w, { minutes: parseInt(args[1] ?? "", 10) }));
      return;
    }
    if (sub === "day") {
      const off = parseInt(args[1] ?? "", 10);
      if (!Number.isFinite(off)) {
        await answer();
        return;
      }
      w.scheduleDay = dayMidnight(off);
      await answer();
      await done(`📅 ${dayLabel(off)}`);
      await sendPostTimeStep(chatId, w);
      return;
    }
    if (sub === "tod") {
      postWizards.delete(chatId);
      const t = POST_TIMES.find((x) => x.key === args[1]);
      await answer();
      if (!t || w.scheduleDay === undefined) {
        await done("Something went wrong — send /post to try again.");
        return;
      }
      await done(
        postFromWizard(member, w, {
          when: { startsAt: w.scheduleDay + t.s * 3_600_000, endsAt: w.scheduleDay + t.e * 3_600_000 },
        }),
      );
      return;
    }
    // Audience toggles — re-render in place.
    if (sub === "ae") {
      w.audEveryone = true;
      w.audFriends.clear();
      w.audGroups.clear();
    } else if (sub === "g") {
      const i = parseInt(args[1] ?? "", 10);
      if (w.groups[i]) {
        w.audEveryone = false;
        w.audGroups.has(i) ? w.audGroups.delete(i) : w.audGroups.add(i);
      }
    } else if (sub === "f") {
      const i = parseInt(args[1] ?? "", 10);
      if (w.friends[i]) {
        w.audEveryone = false;
        w.audFriends.has(i) ? w.audFriends.delete(i) : w.audFriends.add(i);
      }
    }
    if (!w.audFriends.size && !w.audGroups.size) w.audEveryone = true;
    await answer();
    if (messageId !== undefined)
      await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: postAudienceKeyboard(w) });
    return;
  }

  // /presets manager: pst:add (prompt), pst:rm:<i>, pst:done.
  if (member && chatId !== undefined && action === "pst") {
    if (args[0] === "add") {
      await answer();
      await promptFor(chatId, { kind: "preset-add" }, 'Send the new call type — just a topic, e.g. "rubber-duck a bug".');
      return;
    }
    if (args[0] === "done") {
      await answer();
      if (messageId !== undefined)
        await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: "Done editing your call types." });
      return;
    }
    if (args[0] === "rm") {
      const i = parseInt(args[1] ?? "", 10);
      const cur = presetsFor(member);
      if (cur[i]) setPresets(member, cur.filter((_, k) => k !== i));
      await answer("Removed");
      if (messageId !== undefined)
        await tg("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: presetsManagerKeyboard(member),
        });
      return;
    }
    await answer();
    return;
  }

  // /groups manager: grp:new (prompt), grp:open:<i>, grp:done.
  if (member && chatId !== undefined && action === "grp") {
    if (args[0] === "new") {
      await answer();
      await promptFor(chatId, { kind: "group-new" }, "Name for the new group? (one word works best, e.g. close)");
      return;
    }
    if (args[0] === "done") {
      await answer();
      if (messageId !== undefined)
        await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: "Done with your groups." });
      return;
    }
    if (args[0] === "open") {
      const g = groupsFor(member)[parseInt(args[1] ?? "", 10)];
      if (!g) {
        await answer("That group is gone.");
        return;
      }
      const edit: GroupEdit = { name: g.name, friends: friendEntriesOf(member) };
      editingGroup.set(chatId, edit);
      await answer();
      if (messageId !== undefined)
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: `Editing "${g.name}" — tick who's in it:`,
          reply_markup: groupEditorKeyboard(member, edit),
        });
      return;
    }
    await answer();
    return;
  }

  // Group editor: grpe:tf:<i> toggle a friend in/out, grpe:del, grpe:back.
  if (member && chatId !== undefined && action === "grpe") {
    const edit = editingGroup.get(chatId);
    if (!edit) {
      await answer("This expired — send /groups again.");
      return;
    }
    if (args[0] === "back") {
      editingGroup.delete(chatId);
      await answer();
      if (messageId !== undefined)
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: "Your friend groups:",
          reply_markup: groupsManagerKeyboard(member),
        });
      return;
    }
    if (args[0] === "del") {
      editingGroup.delete(chatId);
      removeGroup(member, edit.name);
      await answer("Deleted");
      if (messageId !== undefined)
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: `Deleted "${edit.name}". Your friend groups:`,
          reply_markup: groupsManagerKeyboard(member),
        });
      return;
    }
    if (args[0] === "tf") {
      const f = edit.friends[parseInt(args[1] ?? "", 10)];
      if (f) {
        const cur = new Set(resolveGroup(member, edit.name)?.memberIds ?? []);
        cur.has(f.memberId) ? cur.delete(f.memberId) : cur.add(f.memberId);
        setGroup(member, edit.name, [...cur]);
      }
    }
    await answer();
    if (messageId !== undefined)
      await tg("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: groupEditorKeyboard(member, edit),
      });
    return;
  }

  await answer("Something went wrong.");
}

// --- lifecycle --------------------------------------------------------------------
export async function startTelegramBridge(): Promise<void> {
  if (!telegramEnabled()) return;
  const me = await tg("getMe", {});
  if (!me?.username) {
    console.error("Telegram bridge: getMe failed — check TELEGRAM_BOT_TOKEN. Bridge disabled.");
    return;
  }
  botUsername = me.username;
  setEventSink(onPresenceEvent);
  // Populate Telegram's "/" command menu (shown next to the input field and
  // as autocomplete while typing) — same catalog as /help.
  void tg("setMyCommands", {
    commands: [
      { command: "up", description: "Go available for a spontaneous call now" },
      { command: "post", description: "Propose something for later (set time or open-ended)" },
      { command: "status", description: "Who's up, or other coordination opportunities" },
      { command: "clear", description: "Stop being available" },
      { command: "presets", description: "Your call/activity types" },
      { command: "groups", description: "Your friend groups" },
      { command: "code", description: "Your friend code (others add you with it)" },
      { command: "addfriend", description: "Add a friend by their code" },
      { command: "new", description: "Fresh chat with Nico's representative" },
      { command: "join", description: "Join Huddle with a friend code" },
      { command: "unlink", description: "Disconnect Telegram notifications" },
      { command: "help", description: "Show the command overview" },
    ],
  });
  console.log(`Telegram bridge active: @${botUsername}`);

  let offset = 0;
  for (;;) {
    try {
      const updates = await tg("getUpdates", {
        timeout: 50,
        offset,
        allowed_updates: ["message", "callback_query"],
      });
      for (const u of updates ?? []) {
        offset = u.update_id + 1;
        try {
          if (u.message) await onMessage(u.message);
          else if (u.callback_query) await onCallback(u.callback_query);
        } catch (err) {
          console.error("telegram update failed", err);
        }
      }
    } catch (err) {
      console.error("telegram poll error", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

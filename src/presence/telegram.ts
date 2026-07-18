import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { type ChatMessage } from "../llm.js";
import { respond } from "../representative.js";
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
    dm(
      e.to.telegramChatId,
      `📣 ${e.from.displayName} posted: "${e.text}" (stands for ${fmtMins(
        Math.round((e.expiresAt - Date.now()) / 60_000),
      )})`,
    );
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
  );
  const until = entry.availableUntil ? new Date(entry.availableUntil) : undefined;
  const mm = until ? Math.round((until.getTime() - Date.now()) / 60_000) : mins ?? 60;
  const actText = activities
    .map((a) => `${a.label}${a.durationMinutes ? ` (~${a.durationMinutes}min call)` : ""}`)
    .join(", ");
  return `🟢 You're reachable for ${mm} min${actText ? ` — ${actText}` : ""}. Your friends' overlays just updated.`;
}

// --- /up preset picker --------------------------------------------------------------
// Bare /up shows the member's call-type presets — the same catalog the
// overlay composer offers, synced via POST /api/presence/presets — as
// toggleable inline buttons, so people can SEE and SELECT the options
// instead of typing them. The quick path ("/up 45 note") skips it.
interface Picker {
  /** Snapshot at open time — keeps callback indices valid if presets change. */
  presets: Preset[];
  selected: Set<number>;
  mins: number;
}
const pickers = new Map<number, Picker>(); // telegram chatId -> open picker

const PICKER_WINDOWS = [30, 60, 90];

function pickerKeyboard(p: Picker) {
  const rows: { text: string; callback_data: string }[][] = p.presets.map((preset, i) => [
    {
      text: `${p.selected.has(i) ? "☑" : "☐"} ${preset.label}${
        preset.durationMinutes ? ` (~${preset.durationMinutes}min)` : ""
      }`,
      callback_data: `up:t:${i}`,
    },
  ]);
  rows.push(
    PICKER_WINDOWS.map((m) => ({
      text: p.mins === m ? `· ${m} min ·` : `${m} min`,
      callback_data: `up:w:${m}`,
    })),
  );
  rows.push([
    { text: "🟢 Go available", callback_data: "up:go" },
    { text: "Cancel", callback_data: "up:x" },
  ]);
  return { inline_keyboard: rows };
}

async function openPicker(chatId: number, member: Member): Promise<void> {
  const picker: Picker = { presets: presetsFor(member), selected: new Set(), mins: 60 };
  pickers.set(chatId, picker);
  await dm(
    chatId,
    "Tick what you're up for (optional), pick how long you're reachable, then Go.\n(/presets manages this list; /up 45 <note> skips the picker.)",
    { reply_markup: pickerKeyboard(picker) },
  );
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
  } catch (err) {
    console.error("telegram chat failed", err);
    await dm(chatId, "The representative didn't answer — try again in a moment.");
  }
}

// --- command overview --------------------------------------------------------------
// One source of truth for "what can I do here": /help shows it, and every
// fresh /start (with or without a link code) opens with it.
const NEGOTIATE_HELP =
  "/negotiate — tell me what you're looking for; mutual interests with my principal get confirmed bilaterally, /done gives you the summary";

function commandOverview(member: Member | undefined): string {
  return member
    ? `/up — pick from your call types and go available (buttons)
/up [minutes] [note] — quick set, no picker
/presets — see or edit your call types
/status — who's up for a call, plus open posts
/clear — stop being available
/post [minutes] [to <names>:] <text> — post a coordination opportunity (default: all friends, 4 h) — e.g. /post to close: sauna?
/groups — named friend sets for /post audiences (e.g. "close")
/code — your friend code to share
/addfriend <code> — add a friend
${NEGOTIATE_HELP}
/new — fresh chat context (the representative forgets earlier messages)
/unlink — disconnect Telegram
Anything else: chat with the representative.`
    : `Ask me anything about my principal — just type.
${NEGOTIATE_HELP}
/join <friend-code> <name> — join the Huddle circle right here on Telegram (no install), or link an existing overlay from its settings.
/new — fresh chat context (the representative forgets earlier messages)
/help — show this overview again.`;
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
    const up = roster(member).filter((m) => m.available && m.memberId !== member.id);
    const availability = up.length
      ? "Up for a call:\n" +
        up
          .map(
            (m) =>
              `🟢 ${m.displayName}${
                m.activities?.length
                  ? ` — ${m.activities
                      .map((a) => `${a.label}${a.durationMinutes ? ` (~${a.durationMinutes}min call)` : ""}`)
                      .join(", ")}`
                  : ""
              }${m.note ? ` (${m.note})` : ""}`,
          )
          .join("\n")
      : "Nobody's signaled right now.";
    // Telegram-only members have no overlay — /status is where they see
    // which coordination posts are still open.
    const posts = opportunitiesFor(member);
    const postLines = posts.length
      ? "\n\nOpen posts:\n" +
        posts
          .map((o) => {
            const left = Math.round((new Date(o.expiresAt).getTime() - Date.now()) / 60_000);
            return `📣 ${o.mine ? "You" : o.from.displayName}: "${o.text}" (${fmtMins(left)} left)`;
          })
          .join("\n")
      : "";
    await dm(chatId, availability + postLines);
    return;
  }

  // /post — a coordination opportunity to all friends, one friend, a named
  // group ("/post to close: …"), or any mix, straight from chat.
  if (member && text.startsWith("/post")) {
    const usage =
      "Usage: /post [minutes] [to <names>:] <text>\n" +
      "e.g. /post climbing Saturday morning?\n" +
      "/post to close: chess tonight? (a group — /groups manages them)\n" +
      "/post 90 to Ada, Bob: sauna in a bit? (names comma-separated, colon after)";
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
    // "/up" alone opens the preset picker; "/up 45", "/up 45min focus time",
    // "/up focus time" set directly — a leading number (with optional
    // "min"/"m" suffix) is the window, the rest is the note.
    const [, first, ...rest] = text.split(/\s+/);
    if (!first) {
      await openPicker(chatId, member);
      return;
    }
    const mins = parseInt(first, 10);
    const note = (Number.isFinite(mins) ? rest : [first, ...rest]).join(" ").trim();
    await dm(
      chatId,
      applyAvailability(member, Number.isFinite(mins) ? mins : undefined, [], note || undefined),
    );
    return;
  }

  // /presets — see and edit the call-type catalog the /up picker offers.
  // Overlay users edit there (it re-syncs on every change and on launch, so
  // it wins); this is mainly for Telegram-only members.
  if (member && text.startsWith("/presets")) {
    const [, sub, ...restArgs] = text.split(/\s+/);
    const current = presetsFor(member);
    const list = (presets: Preset[]) =>
      presets.length
        ? presets
            .map(
              (p, i) =>
                `${i + 1}. ${p.label}${p.durationMinutes ? ` (~${p.durationMinutes}min call)` : ""}${
                  p.visibleTo !== "all" ? " (limited visibility)" : ""
                }`,
            )
            .join("\n")
        : "(none)";
    if (sub === "add") {
      const label = restArgs.join(" ").trim();
      if (!label) {
        await dm(chatId, "Usage: /presets add <call type>\ne.g. /presets add rubber-duck a bug");
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
    await dm(
      chatId,
      `Your call types (what the /up picker offers):\n${list(current)}\n\n/presets add <label> — add one\n/presets rm <n> — remove one${
        member.presets ? "" : "\n(These are the defaults — edit them and they become yours.)"
      }`,
    );
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
      "/groups rm <name> — delete one\n" +
      'Post to one with: /post to close: <text> (group names: one word, no ","/":").';
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

  // /up picker buttons: up:t:<i> toggle preset, up:w:<mins> window,
  // up:go apply, up:x cancel. Toggles re-render the keyboard in place.
  if (member && chatId !== undefined && action === "up") {
    const picker = pickers.get(chatId);
    if (!picker) {
      await answer("This picker expired — send /up again.");
      return;
    }
    if (args[0] === "x") {
      pickers.delete(chatId);
      await answer();
      if (messageId !== undefined)
        await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: "Okay — not going available." });
      return;
    }
    if (args[0] === "go") {
      pickers.delete(chatId);
      const chosen = [...picker.selected].sort((a, b) => a - b).map((i) => picker.presets[i]);
      const confirmation = applyAvailability(
        member,
        picker.mins,
        chosen.map((p) => ({
          label: p.label,
          durationMinutes: p.durationMinutes,
          visibleTo: p.visibleTo,
          visibleToGroups: p.visibleToGroups,
        })),
      );
      await answer();
      if (messageId !== undefined)
        await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: confirmation });
      else await dm(chatId, confirmation);
      return;
    }
    if (args[0] === "t") {
      const i = parseInt(args[1] ?? "", 10);
      if (picker.presets[i]) picker.selected.has(i) ? picker.selected.delete(i) : picker.selected.add(i);
    } else if (args[0] === "w") {
      const m = parseInt(args[1] ?? "", 10);
      if (PICKER_WINDOWS.includes(m)) picker.mins = m;
    }
    await answer();
    if (messageId !== undefined)
      await tg("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: pickerKeyboard(picker),
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
      { command: "help", description: "Overview of everything you can do" },
      { command: "up", description: "Go available — pick from your call types" },
      { command: "presets", description: "See or edit your call types" },
      { command: "status", description: "Who's up for a call, plus open posts" },
      { command: "clear", description: "Stop being available" },
      { command: "post", description: "Post a coordination opportunity to friends" },
      { command: "groups", description: "Named friend sets to post to (e.g. close)" },
      { command: "code", description: "Your friend code to share" },
      { command: "addfriend", description: "Add a friend by their code" },
      { command: "negotiate", description: "Find mutual interests, disclosed only when mutual" },
      { command: "done", description: "End the negotiation with a summary" },
      { command: "new", description: "Fresh chat context — forget earlier messages" },
      { command: "join", description: "Join the Huddle circle with a friend code" },
      { command: "unlink", description: "Disconnect Telegram notifications" },
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

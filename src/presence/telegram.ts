import { randomBytes } from "node:crypto";
import { Type } from "@google/genai";
import { config } from "../config.js";
import { extractJson, type ChatMessage } from "../llm.js";
import { respond } from "../representative.js";
import { createSession, type Session } from "../negotiation/store.js";
import { processTurn, summarize } from "../negotiation/negotiate.js";
import {
  acceptCall,
  addFriendByCode,
  bindTelegramChat,
  hasLiveSubscriber,
  memberByTelegramChat,
  pairWithCode,
  redeemTelegramLinkCode,
  roster,
  setEventSink,
  setSignal,
  clearSignal,
  unlinkTelegram,
  type Member,
  type PresenceEvent,
} from "./store.js";

/**
 * Telegram bridge — one bot, two jobs:
 *
 *  1. For LINKED Huddle members (overlay settings → Telegram): out-of-overlay
 *     notifications (pings, call requests with an inline Accept button,
 *     friends going available, room links), and setting your availability by
 *     message — either `/up 60 coworking` or plain language ("up for a call
 *     about the eval project in the next hour"), parsed by the cheap
 *     classifier model.
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

// --- natural-language availability ----------------------------------------------
// Exported for tests — the digit-loop workaround (string minutes) is easy to
// regress by "simplifying" the schema back to numbers.
export const INTENT_SYSTEM = `You read one Telegram message a user sent to their "Huddle" bot and decide what they want.
Huddle lets friends signal "I'm up for a spontaneous call in the next N minutes", optionally with topics/activities and a short note.

There are TWO independent times, do not conflate them (all minutes are digit strings like "60"):
- windowMinutes: how long the person is REACHABLE (the offer window). "in the next hour" → "60".
- durationMinutes (per activity): how long the CALL ITSELF would be. "a 5-minute call about X in the next hour" → windowMinutes "60", activities [{label:"X", durationMinutes:"5"}].

intents:
- "set_availability": they're saying they are (or want to be) available for a call. Extract windowMinutes (default "60") and activities: EVERY topic or activity they name becomes one {label, durationMinutes?} entry (durationMinutes only when a call length is stated). note = any remaining flavor text, short.
- "clear_availability": they say they're done / no longer available.
- "chat": anything else — a question or conversation not about their availability.`;

export const INTENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: { type: Type.STRING, enum: ["set_availability", "clear_availability", "chat"] },
    // Minutes as STRINGS on purpose: with NUMBER/INTEGER fields Gemini's
    // structured output can loop digits ("60.000..." / "60000...") until
    // MAX_TOKENS when the message contains two different durations. A quoted
    // string terminates cleanly; we parseInt in code.
    windowMinutes: { type: Type.STRING, description: "minutes, digits only, e.g. \"60\"" },
    activities: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          durationMinutes: { type: Type.STRING, description: "minutes, digits only, e.g. \"5\"" },
        },
        required: ["label"],
      },
    },
    note: { type: Type.STRING },
  },
  // activities is required (empty array when none): optional, the model
  // frequently stopped emitting after windowMinutes and dropped the topics.
  required: ["intent", "activities"],
};

interface IntentActivity {
  label: string;
  durationMinutes?: number;
}

interface Intent {
  intent: "set_availability" | "clear_availability" | "chat";
  windowMinutes?: number;
  activities?: IntentActivity[];
  note?: string;
}

const asMinutes = (v: unknown): number | undefined => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Raw schema shape (string minutes) → typed Intent. */
export function toIntent(raw: any): Intent {
  return {
    intent: raw.intent,
    windowMinutes: asMinutes(raw.windowMinutes),
    activities: Array.isArray(raw.activities)
      ? raw.activities
          .filter((a: any) => typeof a?.label === "string" && a.label.trim())
          .map((a: any) => ({ label: a.label.trim(), durationMinutes: asMinutes(a.durationMinutes) }))
      : undefined,
    note: typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : undefined,
  };
}

function applyAvailability(
  member: Member,
  mins: number | undefined,
  activities: IntentActivity[],
  note?: string,
): string {
  const entry = setSignal(
    member,
    mins ?? 60,
    note,
    activities.slice(0, 20).map((a) => ({
      label: a.label.slice(0, 60),
      visibleTo: "all" as const,
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
const hinted = new Set<number>();

async function chatWithRepresentative(chatId: number, text: string): Promise<void> {
  const history = chatHistories.get(chatId) ?? [];
  history.push({ role: "user", content: text.slice(0, 4000) });
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  try {
    const reply = await respond(history);
    history.push({ role: "assistant", content: reply });
    chatHistories.set(chatId, history.slice(-HISTORY_MAX));
    await dm(chatId, reply);
  } catch (err) {
    console.error("telegram chat failed", err);
    await dm(chatId, "The representative didn't answer — try again in a moment.");
  }
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

  // /start <link-code> — from the overlay's deep link.
  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1];
    if (code) {
      const linked = redeemTelegramLinkCode(code, chatId);
      await dm(
        chatId,
        linked
          ? `Linked to your Huddle identity, ${linked.displayName} ✅\nYou'll get pings, call requests and friend updates here when your overlay is closed.\nSet availability anytime: "/up 60 coworking" or just tell me in plain words. /help for more.`
          : "That link code is invalid or expired — get a fresh one from the overlay (settings → Telegram).",
      );
    } else {
      await dm(
        chatId,
        member
          ? `You're linked as ${member.displayName}. /help for commands.`
          : "Hi! I'm an AI representative — ask me anything about my principal.\nGot a friend code? /join <code> <your name> puts you in the Huddle circle right here — or link an existing overlay from its settings.",
      );
    }
    return;
  }

  if (text === "/help") {
    const negotiateHelp =
      "/negotiate — tell me what you're looking for; mutual interests with my principal get confirmed bilaterally, /done gives you the summary";
    await dm(
      chatId,
      member
        ? `/up [minutes] [note] — go available (or just say it in plain words)\n/status — who's up for a call\n/clear — stop being available\n/code — your friend code to share\n/addfriend <code> — add a friend\n${negotiateHelp}\n/unlink — disconnect Telegram\nAnything else: chat with the representative.`
        : `Ask me anything about my principal.\n${negotiateHelp}\n/join <friend-code> <name> — join the Huddle circle right here on Telegram (no install), or link an existing overlay from its settings.`,
    );
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
      `Welcome, ${result.member.displayName}! You're in — right here on Telegram, no install needed.\nYour own friend code (share it to add people): ${result.member.friendCode}\nTry: /up 60, /status, or just say "up for a call in the next hour". /help for everything.`,
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
    await dm(
      chatId,
      up.length
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
        : "Nobody's signaled right now.",
    );
    return;
  }

  if (member && text === "/clear") {
    clearSignal(member);
    await dm(chatId, "Cleared — you're no longer shown as available.");
    return;
  }

  if (member && text.startsWith("/up")) {
    // "/up", "/up 45", "/up 45min focus time", "/up focus time" all work:
    // a leading number (with optional "min"/"m" suffix) is the window, the
    // rest is the note.
    const [, first, ...rest] = text.split(/\s+/);
    const mins = first ? parseInt(first, 10) : NaN;
    const note = (Number.isFinite(mins) ? rest : [first ?? "", ...rest]).join(" ").trim();
    await dm(
      chatId,
      applyAvailability(member, Number.isFinite(mins) ? mins : undefined, [], note || undefined),
    );
    return;
  }

  // An open negotiation session claims all free text until /done.
  const negotiation = negotiations.get(chatId);
  if (negotiation) {
    await negotiationTurn(chatId, negotiation, text);
    return;
  }

  // Free text. Linked members get intent detection (availability vs chat);
  // everyone else talks straight to the representative.
  if (member) {
    try {
      const intent = toIntent(
        await extractJson<any>({
          system: INTENT_SYSTEM,
          messages: [{ role: "user", content: text.slice(0, 1000) }],
          schema: INTENT_SCHEMA,
        }),
      );
      if (intent.intent === "set_availability") {
        await dm(
          chatId,
          applyAvailability(member, intent.windowMinutes, intent.activities ?? [], intent.note),
        );
        return;
      }
      if (intent.intent === "clear_availability") {
        clearSignal(member);
        await dm(chatId, "Cleared — you're no longer shown as available.");
        return;
      }
    } catch (err) {
      console.error("telegram intent parse failed, falling through to chat", err);
    }
  } else if (!hinted.has(chatId)) {
    hinted.add(chatId);
    await dm(
      chatId,
      "(You're chatting with the AI representative. Huddle users can link this bot from the overlay — settings → Telegram.)",
    );
  }
  await chatWithRepresentative(chatId, text);
}

async function onCallback(cb: any): Promise<void> {
  const chatId: number | undefined = cb.message?.chat?.id;
  const member = chatId !== undefined ? memberByTelegramChat(chatId) : undefined;
  const [action, fromId] = String(cb.data ?? "").split(":");
  let toastText = "Something went wrong.";
  if (member && action === "accept" && fromId) {
    const result = acceptCall(member, fromId, mintFallbackUrl());
    toastText = result.ok
      ? "Accepted — the room link is on its way."
      : "That request expired — ask them to call again.";
  }
  await tg("answerCallbackQuery", { callback_query_id: cb.id, text: toastText });
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

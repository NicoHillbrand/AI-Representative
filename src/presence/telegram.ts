import { randomBytes } from "node:crypto";
import { Type } from "@google/genai";
import { config } from "../config.js";
import { extractJson, type ChatMessage } from "../llm.js";
import { respond } from "../representative.js";
import { createSession, type Session } from "../negotiation/store.js";
import { processTurn, summarize } from "../negotiation/negotiate.js";
import {
  acceptCall,
  hasLiveSubscriber,
  memberByTelegramChat,
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
    const acts = e.member.signal?.activities.map((a) => a.label).join(", ");
    dm(
      e.friend.telegramChatId,
      `🟢 ${e.member.displayName} is up for a call${acts ? ` — ${acts}` : ""}.`,
    );
  }
}

// --- natural-language availability ----------------------------------------------
const INTENT_SYSTEM = `You read one Telegram message a user sent to their "Huddle" bot and decide what they want.
Huddle lets friends signal "I'm up for a spontaneous call in the next N minutes", optionally with topics/activities and a short note.

intents:
- "set_availability": they're saying they are (or want to be) available for a call. Extract windowMinutes (default 60, clamp 15-180), activities (short topic labels they mention, e.g. "coworking", "the eval project"), and note (any remaining flavor text, short).
- "clear_availability": they say they're done / no longer available.
- "chat": anything else — a question or conversation not about their availability.`;

const INTENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: { type: Type.STRING, enum: ["set_availability", "clear_availability", "chat"] },
    windowMinutes: { type: Type.NUMBER },
    activities: { type: Type.ARRAY, items: { type: Type.STRING } },
    note: { type: Type.STRING },
  },
  required: ["intent"],
};

interface Intent {
  intent: "set_availability" | "clear_availability" | "chat";
  windowMinutes?: number;
  activities?: string[];
  note?: string;
}

function applyAvailability(member: Member, mins: number | undefined, activities: string[], note?: string): string {
  const entry = setSignal(
    member,
    mins ?? 60,
    note,
    activities.slice(0, 20).map((label) => ({ label: label.slice(0, 60), visibleTo: "all" as const })),
  );
  const until = entry.availableUntil ? new Date(entry.availableUntil) : undefined;
  const mm = until ? Math.round((until.getTime() - Date.now()) / 60_000) : mins ?? 60;
  return `🟢 You're up for a call for ${mm} min${
    activities.length ? ` — ${activities.join(", ")}` : ""
  }. Your friends' overlays just updated.`;
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
          : "Hi! I'm an AI representative — ask me anything about my principal.\nHuddle users: link me from the overlay (settings → Telegram) to get notifications here.",
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
        ? `/up [minutes] [note] — go available (or just say it in plain words)\n/status — who's up for a call\n/clear — stop being available\n${negotiateHelp}\n/unlink — disconnect Telegram\nAnything else: chat with the representative.`
        : `Ask me anything about my principal.\n${negotiateHelp}\nHuddle users: link from the overlay (settings → Telegram).`,
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
                    m.activities?.length ? ` — ${m.activities.map((a) => a.label).join(", ")}` : ""
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
    const [, minsRaw, ...rest] = text.split(/\s+/);
    const mins = Number(minsRaw);
    await dm(
      chatId,
      applyAvailability(member, Number.isFinite(mins) ? mins : undefined, [], rest.join(" ") || undefined),
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
      const intent = await extractJson<Intent>({
        system: INTENT_SYSTEM,
        messages: [{ role: "user", content: text.slice(0, 1000) }],
        schema: INTENT_SCHEMA,
      });
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

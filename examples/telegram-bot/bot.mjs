// Minimal Telegram bot bridging to an AI Representative server.
// Zero dependencies (Node 20+): long-polls the Telegram Bot API and forwards
// each chat to POST /api/chat, keeping per-chat history because the
// representative's API is stateless.
//
// Run:
//   1. Make a bot with @BotFather on Telegram, copy the token.
//   2. TELEGRAM_BOT_TOKEN=123:abc node bot.mjs
//      (optionally REPRESENTATIVE_URL=https://ai.nicohillbrand.com)

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN (get one from @BotFather).");
  process.exit(1);
}
const REP = (process.env.REPRESENTATIVE_URL ?? "https://ai.nicohillbrand.com").replace(/\/$/, "");
const TG = `https://api.telegram.org/bot${TOKEN}`;

// chatId -> [{role: "user"|"assistant", content}], capped so requests stay small.
const histories = new Map();
const HISTORY_MAX = 20;

async function tg(method, payload) {
  const res = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) console.error(`telegram ${method}:`, body.description);
  return body.result;
}

async function ask(history) {
  const res = await fetch(`${REP}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: history }),
  });
  if (!res.ok) throw new Error(`representative ${res.status}: ${await res.text()}`);
  return (await res.json()).reply;
}

async function onMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;

  if (text === "/start" || text === "/reset") {
    histories.delete(chatId);
    await tg("sendMessage", {
      chat_id: chatId,
      text:
        text === "/start"
          ? "Hi! I'm the Telegram face of an AI representative. Ask me anything about my principal — interests, strategy, ways to collaborate. /reset clears our conversation."
          : "Conversation cleared.",
    });
    return;
  }

  const history = histories.get(chatId) ?? [];
  history.push({ role: "user", content: text.slice(0, 4000) });

  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  try {
    const reply = await ask(history);
    history.push({ role: "assistant", content: reply });
    histories.set(chatId, history.slice(-HISTORY_MAX));
    await tg("sendMessage", { chat_id: chatId, text: reply });
  } catch (err) {
    console.error(err);
    await tg("sendMessage", {
      chat_id: chatId,
      text: "The representative didn't answer — try again in a moment.",
    });
  }
}

// --- long-poll loop ------------------------------------------------------------
let offset = 0;
console.log(`Bridging Telegram ↔ ${REP}`);
for (;;) {
  try {
    const updates = await tg("getUpdates", { timeout: 50, offset, allowed_updates: ["message"] });
    for (const u of updates ?? []) {
      offset = u.update_id + 1;
      if (u.message) await onMessage(u.message);
    }
  } catch (err) {
    console.error("poll error:", err.message);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

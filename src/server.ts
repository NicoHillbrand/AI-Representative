import express, { type Request, type Response, type NextFunction } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import type { ChatMessage } from "./llm.js";
import { respond, respondStream } from "./representative.js";
import { buildOpenApi } from "./openapi.js";
import { PUBLIC_INTERESTS } from "../content/interests.js";
import { createSession, getSession, authorize } from "./negotiation/store.js";
import { processTurn, summarize } from "./negotiation/negotiate.js";
import {
  pairWithCode,
  memberByToken,
  setSignal,
  clearSignal,
  roster,
  subscribe,
  pingMember,
  requestCall,
  acceptCall,
  addFriendByCode,
  unfriend,
  rotateFriendCode,
  createTelegramLinkCode,
  unlinkTelegram,
  postOpportunity,
  removeOpportunity,
  opportunitiesFor,
  setPresets,
  presetsFor,
  groupsFor,
  setGroup,
  removeGroup,
  resolveGroup,
  type Member,
  type Activity,
  type SignalAudience,
} from "./presence/store.js";
import { startTelegramBridge, telegramEnabled, telegramBotUsername } from "./presence/telegram.js";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- CORS -------------------------------------------------------------------
app.use((req: Request, res: Response, next: NextFunction) => {
  const origins = config.corsOrigins.trim();
  if (origins) {
    const origin = req.headers.origin;
    if (origins === "*") {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && origins.split(",").map((o) => o.trim()).includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- helpers ----------------------------------------------------------------
function validMessages(x: unknown): x is ChatMessage[] {
  return (
    Array.isArray(x) &&
    x.length > 0 &&
    x.every(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string",
    )
  );
}

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  return undefined;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      console.error(err);
      const status = typeof err?.status === "number" ? err.status : 500;
      const message = status === 500 ? "internal_error" : String(err?.message ?? err);
      if (!res.headersSent) res.status(status).json({ error: status === 429 ? "rate_limited" : "error", message });
    });
  };

// --- Public chat ------------------------------------------------------------
app.post(
  "/api/chat",
  wrap(async (req, res) => {
    const { messages, stream } = req.body ?? {};
    if (!validMessages(messages)) {
      res.status(400).json({ error: "bad_request", message: "Body must be { messages: [{role, content}], stream? }" });
      return;
    }
    if (stream) {
      await respondStream(messages, res);
    } else {
      const reply = await respond(messages);
      res.json({ reply });
    }
  }),
);

// --- Public interests -------------------------------------------------------
app.get("/api/interests", (_req, res) => {
  res.json({
    interests: PUBLIC_INTERESTS.map((i) => ({ key: i.key, label: i.label, description: i.description })),
  });
});

// --- Negotiation ------------------------------------------------------------
app.post("/api/negotiate/sessions", (req, res) => {
  const principal = typeof req.body?.principal === "string" ? req.body.principal.slice(0, 200) : undefined;
  const session = createSession(principal);
  res.status(201).json({ sessionId: session.id, token: session.token });
});

app.post(
  "/api/negotiate/sessions/:id/messages",
  wrap(async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "not_found", message: "Unknown or expired session." });
      return;
    }
    if (!authorize(session, bearer(req))) {
      res.status(401).json({ error: "unauthorized", message: "Missing or invalid session token." });
      return;
    }
    if (session.closed) {
      res.status(409).json({ error: "closed", message: "Session is closed." });
      return;
    }
    const message = req.body?.message;
    if (typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "bad_request", message: "Body must be { message: string }." });
      return;
    }
    const result = await processTurn(session, message.slice(0, 8000));
    res.json(result);
  }),
);

app.get(
  "/api/negotiate/sessions/:id/summary",
  wrap(async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "not_found", message: "Unknown or expired session." });
      return;
    }
    if (!authorize(session, bearer(req))) {
      res.status(401).json({ error: "unauthorized", message: "Missing or invalid session token." });
      return;
    }
    const summary = await summarize(session);
    res.json({
      summary,
      confirmedMatches: session.confirmedMatches.map((m) => ({ key: m.key, label: m.label })),
    });
  }),
);

// --- Huddle presence (desktop overlay; specs/desktop-call-overlay.md) --------
function presenceMember(req: Request, res: Response): Member | undefined {
  // The overlay uses fetch (headers work), but also accept ?token= so the
  // stream is easy to poke at with curl / EventSource.
  const token = bearer(req) ?? (typeof req.query.token === "string" ? req.query.token : undefined);
  const member = memberByToken(token);
  if (!member) {
    res.status(401).json({ error: "unauthorized", message: "Missing or invalid device token." });
  }
  return member;
}

// Pair with a friend's personal code (joins AND befriends them in one step),
// with your own code (adds this device to your identity), or with a
// bootstrap code from HUDDLE_INVITE_CODES (first member only, no friends).
app.post("/api/presence/pair", (req, res) => {
  const body = req.body ?? {};
  const code = typeof body.code === "string" ? body.code : body.inviteCode; // legacy field
  const { displayName } = body;
  if (typeof code !== "string" || typeof displayName !== "string" || !displayName.trim()) {
    res.status(400).json({ error: "bad_request", message: "Body must be { code, displayName }." });
    return;
  }
  const result = pairWithCode(code, displayName, config.huddleInviteCodes);
  if (!result.ok) {
    res.status(403).json({ error: "forbidden", message: "Invalid code — ask your friend for theirs (settings → My friend code)." });
    return;
  }
  res.status(201).json({
    deviceToken: result.token,
    memberId: result.member.id,
    displayName: result.member.displayName,
    friendCode: result.member.friendCode,
    callLink: config.huddleCallLink,
  });
});

// Your own identity: friend code to share, and rotation when it leaks.
app.get("/api/presence/me", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  res.json({
    memberId: member.id,
    displayName: member.displayName,
    friendCode: member.friendCode,
    telegram: {
      available: telegramEnabled(),
      linked: !!member.telegramChatId,
      botUsername: telegramBotUsername() ?? null,
    },
  });
});

// Telegram linking: overlay fetches a one-time deep link, user taps Start.
app.post("/api/presence/telegram/link-code", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  if (!telegramEnabled() || !telegramBotUsername()) {
    res.status(503).json({ error: "unavailable", message: "This server has no Telegram bot configured." });
    return;
  }
  const code = createTelegramLinkCode(member);
  res.json({ code, url: `https://t.me/${telegramBotUsername()}?start=${code}` });
});

app.delete("/api/presence/telegram", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  unlinkTelegram(member);
  res.sendStatus(204);
});

app.post("/api/presence/me/rotate-code", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  res.json({ friendCode: rotateFriendCode(member) });
});

// Friend graph: add by code (mutual immediately — sharing the code is the
// consent), remove unilaterally (drops both directions).
app.post("/api/presence/friends", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  const { code } = req.body ?? {};
  if (typeof code !== "string" || !code.trim()) {
    res.status(400).json({ error: "bad_request", message: "Body must be { code: string }." });
    return;
  }
  const result = addFriendByCode(member, code);
  if (!result.ok) {
    res.status(result.error === "self_code" ? 400 : 404).json({ error: result.error });
    return;
  }
  res.status(201).json({ friend: result.friend });
});

app.delete("/api/presence/friends/:id", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  if (!unfriend(member, req.params.id)) {
    res.status(404).json({ error: "not_found", message: "Not one of your friends." });
    return;
  }
  res.sendStatus(204);
});

/** Sanitize a client-sent activity list: caps, trims, and a strict
 * visibleTo shape ("all" or memberId strings). */
function parseActivities(x: unknown): Activity[] {
  if (!Array.isArray(x)) return [];
  return x.slice(0, 20).flatMap((a): Activity[] => {
    const label = typeof a?.label === "string" ? a.label.trim().slice(0, 60) : "";
    if (!label) return [];
    const visibleTo: Activity["visibleTo"] = Array.isArray(a.visibleTo)
      ? a.visibleTo.filter((v: unknown) => typeof v === "string").slice(0, 100)
      : "all";
    const visibleToGroups = Array.isArray(a.visibleToGroups)
      ? a.visibleToGroups.filter((v: unknown): v is string => typeof v === "string").slice(0, 20)
      : undefined;
    const minutes =
      typeof a.minutes === "number" && Number.isFinite(a.minutes) ? a.minutes : undefined;
    const durationMinutes =
      typeof a.durationMinutes === "number" && Number.isFinite(a.durationMinutes)
        ? a.durationMinutes
        : undefined;
    return [
      {
        label,
        visibleTo,
        ...(visibleToGroups?.length ? { visibleToGroups } : {}),
        minutes,
        durationMinutes,
      },
    ];
  });
}

// Call-type presets, two-way: the overlay reads the catalog at boot
// (`customized` says whether the member ever saved one — false means these
// are just the defaults and the overlay's local catalog should win)…
app.get("/api/presence/presets", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  res.json({ presets: presetsFor(member), customized: !!member.presets });
});

// …and mirrors its catalog here on every edit so the Telegram bot's /up
// picker offers the same options. Replaces the list.
app.post("/api/presence/presets", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  if (!Array.isArray(req.body?.presets)) {
    res.status(400).json({
      error: "bad_request",
      message: "Body must be { presets: [{label, visibleTo?, durationMinutes?}] }.",
    });
    return;
  }
  const presets = parseActivities(req.body.presets).map(
    ({ label, visibleTo, visibleToGroups, durationMinutes }) => ({
      label,
      visibleTo,
      visibleToGroups,
      durationMinutes,
    }),
  );
  res.json({ presets: setPresets(member, presets) });
});

// Named friend groups — reusable post audiences ("close", "climbing crew").
// Same sync model as presets: edited from the overlay or Telegram (/groups),
// pushed to the member's own devices via "groups" SSE events.
app.get("/api/presence/groups", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  res.json({ groups: groupsFor(member) });
});

app.post("/api/presence/groups", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  const { name, memberIds } = req.body ?? {};
  if (typeof name !== "string" || !Array.isArray(memberIds)) {
    res.status(400).json({
      error: "bad_request",
      message: "Body must be { name: string, memberIds: string[] } (replaces the group).",
    });
    return;
  }
  const result = setGroup(
    member,
    name,
    memberIds.filter((v: unknown): v is string => typeof v === "string"),
  );
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ groups: result.groups });
});

app.delete("/api/presence/groups/:name", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  const groups = removeGroup(member, req.params.name);
  if (!groups) {
    res.status(404).json({ error: "not_found", message: "No group with that name." });
    return;
  }
  res.json({ groups });
});

app.post("/api/presence/signal", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  const { windowMinutes, note, activities, visibleTo, visibleToGroups } = req.body ?? {};
  if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes)) {
    res.status(400).json({
      error: "bad_request",
      message: "Body must be { windowMinutes: number, note?: string, activities?: [{label, visibleTo}] }.",
    });
    return;
  }
  // Optional signal-level audience (who sees you're up at all). Absent or
  // "all" keeps the historical behavior: every friend. Same shape as an
  // activity's visibility.
  const audience: SignalAudience | undefined = Array.isArray(visibleTo)
    ? {
        visibleTo: visibleTo.filter((v: unknown): v is string => typeof v === "string").slice(0, 100),
        ...(Array.isArray(visibleToGroups)
          ? { visibleToGroups: visibleToGroups.filter((v: unknown): v is string => typeof v === "string").slice(0, 20) }
          : {}),
      }
    : undefined;
  const entry = setSignal(
    member,
    windowMinutes,
    typeof note === "string" ? note : undefined,
    parseActivities(activities),
    audience,
  );
  res.json(entry);
});

// Call handshake: request (optionally carrying the requester's own room
// link, e.g. a Google Meet) → accept → the link, or a room minted from the
// configured template, is pushed to both sides.
app.post("/api/presence/call-request", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  const { toMemberId, link } = req.body ?? {};
  if (typeof toMemberId !== "string") {
    res.status(400).json({ error: "bad_request", message: "Body must be { toMemberId: string, link?: string }." });
    return;
  }
  if (link !== undefined && (typeof link !== "string" || !/^https:\/\/\S+$/.test(link) || link.length > 400)) {
    res.status(400).json({ error: "bad_request", message: "link must be an https:// URL (max 400 chars)." });
    return;
  }
  const result = requestCall(member, toMemberId, link);
  if (!result.ok) {
    res.status(result.error === "too_fast" ? 429 : 400).json({ error: result.error });
    return;
  }
  res.json({ delivered: result.delivered });
});

app.post("/api/presence/call-accept", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  const { fromMemberId } = req.body ?? {};
  if (typeof fromMemberId !== "string") {
    res.status(400).json({ error: "bad_request", message: "Body must be { fromMemberId: string }." });
    return;
  }
  const room = randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x");
  const fallbackUrl = config.huddleCallLink.replace("{room}", room);
  const result = acceptCall(member, fromMemberId, fallbackUrl);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ url: result.url, requesterNotified: result.delivered });
});

// Coordination opportunities: post a proposal ("climbing Saturday?") to all
// your friends, one friend, a named group, or an ad-hoc set. Audience is
// enforced server-side; only the poster can take a post down early.
app.post("/api/presence/opportunities", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  const { text, audience, minutes, startsAt, endsAt } = req.body ?? {};
  if (typeof text !== "string" || !text.trim()) {
    res.status(400).json({
      error: "bad_request",
      message:
        'Body must be { text: string, audience?: "all" | memberId[] | {group: name}, minutes?: number, startsAt?: ISO, endsAt?: ISO }.',
    });
    return;
  }
  let aud: "all" | string[] = "all";
  let audLabel: string | undefined;
  if (Array.isArray(audience)) {
    aud = audience.filter((v: unknown): v is string => typeof v === "string").slice(0, 100);
  } else if (audience && typeof audience === "object" && typeof audience.group === "string") {
    const group = resolveGroup(member, audience.group);
    if (!group) {
      res.status(400).json({ error: "unknown_group" });
      return;
    }
    aud = group.memberIds;
    audLabel = group.name;
  }
  const mins = typeof minutes === "number" && Number.isFinite(minutes) ? minutes : undefined;
  // A scheduled post: startsAt (and optional endsAt) as ISO strings or epoch ms.
  const toEpoch = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
    return undefined;
  };
  const startEpoch = toEpoch(startsAt);
  const when = startEpoch !== undefined ? { startsAt: startEpoch, endsAt: toEpoch(endsAt) } : undefined;
  const result = postOpportunity(member, text, aud, mins, audLabel, when);
  if (!result.ok) {
    res
      .status(result.error === "too_fast" || result.error === "too_many" ? 429 : 400)
      .json({ error: result.error });
    return;
  }
  res.status(201).json({ opportunity: result.opportunity });
});

app.delete("/api/presence/opportunities/:id", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  if (!removeOpportunity(member, req.params.id)) {
    res.status(404).json({ error: "not_found", message: "Not one of your posts." });
    return;
  }
  res.sendStatus(204);
});

app.post("/api/presence/ping", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  const { toMemberId } = req.body ?? {};
  if (typeof toMemberId !== "string") {
    res.status(400).json({ error: "bad_request", message: "Body must be { toMemberId: string }." });
    return;
  }
  const result = pingMember(member, toMemberId);
  if (!result.ok) {
    res.status(result.error === "too_fast" ? 429 : 400).json({ error: result.error });
    return;
  }
  res.json({ delivered: result.delivered });
});

app.delete("/api/presence/signal", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  clearSignal(member);
  res.sendStatus(204);
});

app.get("/api/presence/roster", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  res.json({
    members: roster(member),
    opportunities: opportunitiesFor(member),
    groups: groupsFor(member),
    callLink: config.huddleCallLink,
  });
});

app.get("/api/presence/stream", (req, res) => {
  const member = presenceMember(req, res);
  if (!member) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("roster", {
    members: roster(member),
    opportunities: opportunitiesFor(member),
    groups: groupsFor(member),
    callLink: config.huddleCallLink,
  });
  const unsubscribe = subscribe(send, member.id);
  const ping = setInterval(() => send("ping", {}), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

// --- Docs -------------------------------------------------------------------
app.get("/openapi.json", (_req, res) => res.json(buildOpenApi()));

// --- Static frontend --------------------------------------------------------
app.use(express.static(publicDir));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(config.port, () => {
  console.log(`AI Representative listening on http://localhost:${config.port}`);
  console.log(`Model: ${config.model}`);
});

// Fire-and-forget: long-polls Telegram if TELEGRAM_BOT_TOKEN is set.
void startTelegramBridge();

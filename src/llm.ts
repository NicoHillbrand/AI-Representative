import { GoogleGenAI } from "@google/genai";
import { config } from "./config.js";

/**
 * Provider layer. Everything the app knows about the LLM lives here, so
 * swapping providers is a one-file change. Currently: Google Gemini.
 */

export const genai = new GoogleGenAI({ apiKey: config.geminiApiKey });

export type ChatMessage = { role: "user" | "assistant"; content: string };

/** Normalised error the server can map to an HTTP status + friendly message. */
export class LlmError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "LlmError";
  }
}

function normalizeError(err: unknown): LlmError {
  const raw = err instanceof Error ? err.message : String(err);
  if (/RESOURCE_EXHAUSTED|quota|\b429\b/i.test(raw)) {
    return new LlmError(
      429,
      "Gemini rate/quota limit hit. Wait ~30s and retry. (On the free tier this is ~a few requests/min; if you set a daily request quota in Google Cloud, this also fires when it's exhausted.)",
    );
  }
  if (/API_KEY_INVALID|API key not valid|PERMISSION_DENIED|\b401\b|\b403\b/i.test(raw)) {
    return new LlmError(401, "Gemini rejected the API key. Check GEMINI_API_KEY in .env.");
  }
  return new LlmError(502, "The language-model request failed. Please try again.");
}

/** Our neutral message shape → Gemini `contents` (Gemini uses "model", not "assistant"). */
function toContents(messages: ChatMessage[]) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

/**
 * Per-model thinking config. Kept low/off because our tasks (grounded chat,
 * classification, short negotiation replies) don't need deep reasoning, and
 * thinking tokens are billed as output.
 *   - Gemini 3.x: uses `thinkingLevel` ("minimal" only exists on flash-lite /
 *     3-flash; 3.5-flash's floor is "low"). `thinkingBudget` would 400 here.
 *   - Gemini 2.x flash: `thinkingBudget: 0` disables thinking (avoids the
 *     empty/truncated-reply quirk where thinking eats the whole token budget).
 *   - pro / anything else: leave the default.
 */
function thinkingConfigFor(model: string): Record<string, unknown> | undefined {
  if (/gemini-3/i.test(model)) {
    return { thinkingLevel: /lite/i.test(model) ? "minimal" : "low" };
  }
  if (/flash/i.test(model)) {
    return { thinkingBudget: 0 };
  }
  return undefined;
}

function baseConfig(model: string, system: string, maxTokens: number): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    systemInstruction: system,
    maxOutputTokens: maxTokens,
  };
  const thinking = thinkingConfigFor(model);
  if (thinking) cfg.thinkingConfig = thinking;
  return cfg;
}

/** One-shot completion returning plain text. */
export async function complete(opts: {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  model?: string;
}): Promise<string> {
  const model = opts.model ?? config.model;
  try {
    const resp = await genai.models.generateContent({
      model,
      contents: toContents(opts.messages),
      config: baseConfig(model, opts.system, opts.maxTokens ?? 4096),
    });
    return resp.text ?? "";
  } catch (err) {
    throw normalizeError(err);
  }
}

/**
 * Streaming completion. Calls `onDelta` for each text chunk and resolves with
 * the full concatenated text.
 */
export async function completeStream(
  opts: { system: string; messages: ChatMessage[]; maxTokens?: number; model?: string },
  onDelta: (text: string) => void,
): Promise<string> {
  const model = opts.model ?? config.model;
  try {
    const stream = await genai.models.generateContentStream({
      model,
      contents: toContents(opts.messages),
      config: baseConfig(model, opts.system, opts.maxTokens ?? 4096),
    });
    let full = "";
    for await (const chunk of stream) {
      const t = chunk.text ?? "";
      if (t) {
        full += t;
        onDelta(t);
      }
    }
    return full;
  } catch (err) {
    throw normalizeError(err);
  }
}

/**
 * Structured extraction constrained to a Gemini response schema. Runs on the
 * (cheaper, higher-free-limit) classifier model by default. Because the output
 * is schema-constrained JSON, it's safe to show the model the full interest
 * taxonomy — it can only ever emit the constrained shape, never free text back
 * to a counterpart.
 */
export async function extractJson<T>(opts: {
  system: string;
  messages: ChatMessage[];
  schema: unknown;
  maxTokens?: number;
  model?: string;
}): Promise<T> {
  const model = opts.model ?? config.classifierModel;
  const cfg = baseConfig(model, opts.system, opts.maxTokens ?? 2048);
  cfg.responseMimeType = "application/json";
  cfg.responseSchema = opts.schema;
  try {
    const resp = await genai.models.generateContent({
      model,
      contents: toContents(opts.messages),
      config: cfg,
    });
    return JSON.parse((resp.text ?? "").trim()) as T;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new LlmError(502, "The classifier returned malformed JSON. Please retry.");
    }
    throw normalizeError(err);
  }
}

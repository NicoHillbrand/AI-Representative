import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.js";

/**
 * Forwarding feed — a private inbox of things the representative (from chats)
 * or the scheduled poller (from external APIs) decided Nico should see.
 *
 * Persisted to disk (like the presence member file) so a restart doesn't lose
 * the feed. Read only through the owner-token-gated /api/forwards routes; the
 * store itself never filters by viewer because there is only one viewer (Nico).
 */

/** Where a forward came from. `scheduler:<sourceKey>` for polled items. */
export type ForwardSource = "chat" | "telegram" | "negotiation" | `scheduler:${string}`;

export interface Forward {
  id: string;
  createdAt: number;
  source: ForwardSource;
  /** The classifier's rough bucket ("coordination" | "interest" | "other").
   * Advisory only — the feed shows everything that was stored. */
  category?: string;
  title: string;
  /** One- or two-line gist, written by the classifier. */
  summary: string;
  /** Fuller context: the relevant slice of the conversation, or the item body. */
  detail?: string;
  /** Contact info the visitor volunteered, if any (so Nico can follow up). */
  contact?: string;
  /** Link for polled items (the HN story, article, etc.). */
  url?: string;
  /** Stable external id used to dedupe polled items across ticks. */
  externalId?: string;
  /** Nico has seen it (set via POST /api/forwards/read). */
  read?: boolean;
}

const items = new Map<string, Forward>();
const externalIds = new Set<string>();

// --- persistence -------------------------------------------------------------
const dataDir = join(paths.root, "data");
const dataFile = join(dataDir, "forwards.json");
// Keep the file bounded — the feed is a rolling inbox, not an archive.
const MAX_ITEMS = 2000;

function load(): void {
  if (!existsSync(dataFile)) return;
  try {
    const raw = JSON.parse(readFileSync(dataFile, "utf8")) as { items?: Forward[] };
    for (const f of raw.items ?? []) {
      items.set(f.id, f);
      if (f.externalId) externalIds.add(f.externalId);
    }
  } catch (err) {
    console.error("forwarding: failed to load feed file, starting empty", err);
  }
}

function save(): void {
  mkdirSync(dataDir, { recursive: true });
  // Newest first, capped.
  const all = [...items.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ITEMS);
  // Rebuild the maps if we trimmed anything, so memory tracks the file.
  if (all.length < items.size) {
    items.clear();
    externalIds.clear();
    for (const f of all) {
      items.set(f.id, f);
      if (f.externalId) externalIds.add(f.externalId);
    }
  }
  writeFileSync(dataFile, JSON.stringify({ items: all }, null, 2));
}

load();

// --- writes ------------------------------------------------------------------
export interface NewForward {
  source: ForwardSource;
  title: string;
  summary: string;
  category?: string;
  detail?: string;
  contact?: string;
  url?: string;
  externalId?: string;
}

/** Add a forward. Returns the stored record, or `undefined` if it was a
 * duplicate of an already-seen external item (deduped, not stored). */
export function addForward(f: NewForward): Forward | undefined {
  if (f.externalId && externalIds.has(f.externalId)) return undefined;
  const forward: Forward = {
    id: `fwd_${randomUUID()}`,
    createdAt: Date.now(),
    source: f.source,
    title: f.title.trim().slice(0, 200),
    summary: f.summary.trim().slice(0, 1000),
    ...(f.category ? { category: f.category.trim().slice(0, 40) } : {}),
    ...(f.detail ? { detail: f.detail.trim().slice(0, 4000) } : {}),
    ...(f.contact ? { contact: f.contact.trim().slice(0, 200) } : {}),
    ...(f.url ? { url: f.url.trim().slice(0, 500) } : {}),
    ...(f.externalId ? { externalId: f.externalId.slice(0, 200) } : {}),
  };
  items.set(forward.id, forward);
  if (forward.externalId) externalIds.add(forward.externalId);
  save();
  return forward;
}

/** Have we already forwarded this external item? (cheap pre-check for pollers
 * so they can skip the classifier call on items they've seen). */
export function hasExternalId(externalId: string): boolean {
  return externalIds.has(externalId);
}

// --- reads -------------------------------------------------------------------
export interface ListOptions {
  limit?: number;
  /** Only items created strictly after this epoch-ms timestamp. */
  since?: number;
  unreadOnly?: boolean;
  category?: string;
}

export function listForwards(opts: ListOptions = {}): Forward[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return [...items.values()]
    .filter((f) => (opts.since === undefined ? true : f.createdAt > opts.since))
    .filter((f) => (opts.unreadOnly ? !f.read : true))
    .filter((f) => (opts.category ? f.category === opts.category : true))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

export function unreadCount(): number {
  let n = 0;
  for (const f of items.values()) if (!f.read) n++;
  return n;
}

/** Mark specific ids read (or all, when no ids are given). Returns how many
 * items flipped from unread to read. */
export function markRead(ids?: string[]): number {
  let changed = 0;
  const targets = ids?.length ? ids : [...items.keys()];
  for (const id of targets) {
    const f = items.get(id);
    if (f && !f.read) {
      f.read = true;
      changed++;
    }
  }
  if (changed) save();
  return changed;
}

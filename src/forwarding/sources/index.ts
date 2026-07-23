import { hackernews } from "./hackernews.js";

/**
 * A pollable external source. The scheduler calls `fetchCandidates()` on each
 * tick; every candidate is deduped by `externalId` and run past the forwarding
 * classifier before anything reaches the feed. Add a new source by writing a
 * module that exports a `Source` and registering it in `ALL_SOURCES` below,
 * then enabling its `key` via the FORWARD_SOURCES env var.
 */
export interface Candidate {
  /** Stable id for dedupe across ticks (prefix with the source, e.g. "hn:123"). */
  externalId: string;
  title: string;
  /** Fuller text for the classifier to judge (optional). */
  body?: string;
  /** Link stored on the forward so Nico can open the item. */
  url?: string;
}

export interface Source {
  key: string;
  label: string;
  fetchCandidates(): Promise<Candidate[]>;
}

const ALL_SOURCES: Source[] = [hackernews];

/** Resolve the enabled source keys (from config) to their implementations,
 * warning about any unknown key so a typo in FORWARD_SOURCES is visible. */
export function resolveSources(keys: string[]): Source[] {
  return keys.flatMap((key) => {
    const src = ALL_SOURCES.find((s) => s.key === key);
    if (!src) {
      console.warn(`forwarding: unknown source "${key}" (known: ${ALL_SOURCES.map((s) => s.key).join(", ")})`);
      return [];
    }
    return [src];
  });
}

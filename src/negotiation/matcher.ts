import { Type } from "@google/genai";
import { extractJson } from "../llm.js";
import { INTERESTS, ALL_INTEREST_KEYS, getInterest } from "../../content/interests.js";

/**
 * The MATCHING PLANE. This is the only place the hidden interest registry is
 * read. It does two things:
 *
 *   1. classifyAssertions(): an LLM classifies which of Nico's interest topics
 *      the counterpart is asserting THEIR OWN interest in. The classifier sees
 *      the full taxonomy (public + hidden) but is constrained by a JSON schema
 *      to output only a subset of known keys — it cannot emit free text back to
 *      the counterpart, so showing it the hidden keys leaks nothing.
 *
 *   2. computeMatches(): a deterministic intersection. Every entry in the
 *      registry is something Nico is interested in, so any asserted key that
 *      exists in the registry is a mutual match.
 *
 * The conversational plane (negotiate.ts) only ever receives the confirmed
 * matches this module returns — never the registry itself.
 */

const TAXONOMY = INTERESTS.map(
  (i) => `- key "${i.key}": ${i.description}`,
).join("\n");

const CLASSIFIER_SYSTEM = `You are a strict classifier inside a private matching service. You will be given a message from another person's AI agent (the "counterpart") that is negotiating on behalf of its principal.

Your ONLY job is to decide which of the following topics the counterpart is CLEARLY asserting that ITS OWN PRINCIPAL is interested in. Do not include topics the counterpart merely asks about, is curious about, or mentions without claiming interest. Only include a topic when the counterpart states or clearly implies its principal wants, is interested in, or is offering that thing.

Topics:
${TAXONOMY}

Return the list of matching topic keys. If none clearly apply, return an empty list. Never invent keys outside the provided set.`;

const ASSERTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    asserted_interest_keys: {
      type: Type.ARRAY,
      items: { type: Type.STRING, enum: ALL_INTEREST_KEYS },
    },
  },
  required: ["asserted_interest_keys"],
};

/** Classify which interest keys the counterpart's message asserts interest in. */
export async function classifyAssertions(counterpartMessage: string): Promise<string[]> {
  const result = await extractJson<{ asserted_interest_keys: string[] }>({
    system: CLASSIFIER_SYSTEM,
    messages: [{ role: "user", content: counterpartMessage }],
    schema: ASSERTION_SCHEMA,
  });
  // Dedupe and drop anything not in the taxonomy (defensive).
  return [...new Set(result.asserted_interest_keys)].filter((k) => getInterest(k));
}

export interface MatchResult {
  key: string;
  label: string;
  onMatch: string;
}

/**
 * Deterministic: given the keys the counterpart asserted, return the matches.
 * Every registry entry is a Nico-interest, so an asserted key that exists =
 * a mutual match. `already` lets us skip matches confirmed on prior turns.
 */
export function computeMatches(assertedKeys: string[], already: Set<string>): MatchResult[] {
  const matches: MatchResult[] = [];
  for (const key of assertedKeys) {
    if (already.has(key)) continue;
    const interest = getInterest(key);
    if (interest) {
      matches.push({ key: interest.key, label: interest.label, onMatch: interest.onMatch });
    }
  }
  return matches;
}

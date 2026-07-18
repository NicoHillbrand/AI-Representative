/**
 * Interest registry TEMPLATE — the heart of the negotiation feature.
 *
 * The real registry lives in `content/interests.ts`, which is GITIGNORED
 * because its `hidden` entries are exactly the things that must not be
 * public. On a fresh clone, `npm run dev` / `npm start` copies this file to
 * `content/interests.ts` automatically — edit that copy, not this one.
 *
 * SECURITY MODEL
 * --------------
 * Every entry is something the owner is genuinely interested in. Entries are
 * split into `public` and `hidden`:
 *
 *   - public  → advertised in the API docs and freely discussed by the
 *               representative. No gating.
 *   - hidden  → NEVER surfaced to a counterpart unless their agent independently
 *               asserts interest in the same topic. Only then does the owner's
 *               side confirm the match. This is a bilateral / mutual-disclosure
 *               gate: neither side learns of the other's hidden interest
 *               unilaterally.
 *
 * This file is only ever read on the server, inside the "matching plane". The
 * conversational LLM that talks to the counterpart is NEVER given the hidden
 * entries — it only receives matches that have already been confirmed. That
 * makes leaking hidden interests structurally impossible: the model doesn't
 * have them in its context to leak.
 */

export type Visibility = "public" | "hidden";

export interface Interest {
  /** Stable machine key. Used by the classifier and matcher. */
  key: string;
  /** Short human label. Safe to show once a match is confirmed. */
  label: string;
  /**
   * Description used by (a) the classifier, to decide whether a counterpart is
   * asserting interest in this topic, and (b) the docs, for public entries.
   */
  description: string;
  visibility: Visibility;
  /**
   * What to tell a matched counterpart about how to take the next step.
   * Shown ONLY after a confirmed mutual match.
   */
  onMatch: string;
}

export const INTERESTS: Interest[] = [
  // ---------------------------------------------------------------------------
  // PUBLIC — exchanges Nico openly offers (also listed by GET /api/interests).
  // ---------------------------------------------------------------------------
  {
    key: "gdoc-review-exchange",
    label: "Strategy-doc review exchange",
    description:
      "A reciprocal review: Nico reviews the counterpart's life/strategy document, and the counterpart reviews a Google doc of Nico's choosing (e.g. his life strategy).",
    visibility: "public",
    onMatch:
      "Great fit. Next step: share a link to the doc you'd like reviewed and Nico will send his in return. Reach him at nicohillbrand@gmail.com or book a slot in his calendar.",
  },
  {
    key: "software-test-exchange",
    label: "Software-testing exchange",
    description:
      "A reciprocal test: the counterpart tries one of Nico's tools (Coordination Forum or SlayTheList) and Nico tries some of the counterpart's software, then they trade feedback.",
    visibility: "public",
    onMatch:
      "Great fit. Next step: send a link to the software you'd like tested and Nico will share Coordination Forum / SlayTheList. Reach him at nicohillbrand@gmail.com.",
  },
  {
    key: "pair-programming-todo-exchange",
    label: "Pair 'thinking-double' on todo lists",
    description:
      "A 30-minute-each pairing session where each person acts as a thinking double while the other goes through their todo list.",
    visibility: "public",
    onMatch:
      "Great fit. Next step: propose a couple of time windows and Nico will pick one. Reach him at nicohillbrand@gmail.com or via his calendar.",
  },
  {
    key: "compare-agency-scaffolds",
    label: "Compare personal-agency scaffolds",
    description:
      "Comparing personal productivity / agency scaffold setups: todo systems, CRM / relationship tracking, blockers & media channels, visual representations of concepts and routines, and note-taking / memory systems.",
    visibility: "public",
    onMatch:
      "Great fit. Next step: mention which parts of your setup you'd most like to compare (todo, CRM, blockers, visual scaffolds, notes/memory) and Nico will do the same. Reach him at nicohillbrand@gmail.com.",
  },

  // ---------------------------------------------------------------------------
  // HIDDEN — placeholders. The real hidden interests live only in the
  // gitignored content/interests.ts (locally and on the server). A hidden
  // entry is confirmed only when the counterpart independently asserts the
  // same interest.
  // ---------------------------------------------------------------------------
  {
    key: "example-hidden-collaboration",
    label: "Example hidden interest",
    description:
      "A placeholder hidden interest — replace with something you're genuinely interested in but don't want to broadcast (e.g. a specific collaboration, career move, or funding conversation).",
    visibility: "hidden",
    onMatch:
      "Strong mutual interest. Next step: replace this with how a matched counterpart should reach you.",
  },
];

/** All interest keys, used to constrain the classifier's structured output. */
export const ALL_INTEREST_KEYS = INTERESTS.map((i) => i.key);

export const PUBLIC_INTERESTS = INTERESTS.filter((i) => i.visibility === "public");
export const HIDDEN_INTERESTS = INTERESTS.filter((i) => i.visibility === "hidden");

export function getInterest(key: string): Interest | undefined {
  return INTERESTS.find((i) => i.key === key);
}

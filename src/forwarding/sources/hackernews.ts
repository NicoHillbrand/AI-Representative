import { PUBLIC_INTERESTS } from "../../../content/interests.js";
import type { Candidate, Source } from "./index.js";

/**
 * Example source: recent Hacker News stories matching Nico's public interests.
 *
 * Uses the keyless Algolia HN Search API. We search a few terms drawn from the
 * public interest list and hand every hit to the classifier, which does the
 * real relevance judgment — this source just casts a reasonable net. It's a
 * template: copy the shape for any JSON/RSS API you want to poll.
 */

const HN_ENDPOINT = "https://hn.algolia.com/api/v1/search_by_date";
const HITS_PER_TERM = 15;
const MAX_TERMS = 6;

interface HnHit {
  objectID: string;
  title?: string;
  url?: string;
  story_text?: string;
  points?: number;
}

/** Query terms: the public interest labels (short, distinctive phrases). */
function searchTerms(): string[] {
  return PUBLIC_INTERESTS.map((i) => i.label)
    .filter((l) => l && l.length <= 60)
    .slice(0, MAX_TERMS);
}

async function searchHn(term: string): Promise<HnHit[]> {
  const url = `${HN_ENDPOINT}?query=${encodeURIComponent(term)}&tags=story&hitsPerPage=${HITS_PER_TERM}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HN search "${term}" -> HTTP ${res.status}`);
  const body = (await res.json()) as { hits?: HnHit[] };
  return body.hits ?? [];
}

export const hackernews: Source = {
  key: "hackernews",
  label: "Hacker News",
  async fetchCandidates(): Promise<Candidate[]> {
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const term of searchTerms()) {
      let hits: HnHit[] = [];
      try {
        hits = await searchHn(term);
      } catch (err) {
        console.error("forwarding: HN fetch failed for term", term, err);
        continue;
      }
      for (const h of hits) {
        if (!h.title || seen.has(h.objectID)) continue;
        seen.add(h.objectID);
        candidates.push({
          externalId: `hn:${h.objectID}`,
          title: h.title,
          body: h.story_text || undefined,
          url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        });
      }
    }
    return candidates;
  },
};

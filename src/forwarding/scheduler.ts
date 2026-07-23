import { config } from "../config.js";
import { addForward, hasExternalId } from "./store.js";
import { classifyCandidate } from "./classify.js";
import { resolveSources, type Source } from "./sources/index.js";

/**
 * The scheduled poller. Every FORWARD_POLL_HOURS it walks each enabled source,
 * skips items already in the feed, asks the classifier whether each new item is
 * worth Nico's attention, and files the worthy ones. Idle (never starts) when
 * FORWARD_SOURCES is empty.
 *
 * Deliberately conservative: per-item errors are logged and skipped so one bad
 * source or classifier hiccup never aborts a whole run.
 */

async function pollSource(source: Source): Promise<number> {
  let candidates;
  try {
    candidates = await source.fetchCandidates();
  } catch (err) {
    console.error(`forwarding: source "${source.key}" fetch failed`, err);
    return 0;
  }
  let stored = 0;
  for (const c of candidates) {
    // Cheap pre-filter: never spend a classifier call on something we've
    // already forwarded.
    if (hasExternalId(c.externalId)) continue;
    const verdict = await classifyCandidate({ title: c.title, body: c.body, url: c.url });
    if (!verdict || !verdict.worthy) continue;
    const added = addForward({
      source: `scheduler:${source.key}`,
      title: verdict.title || c.title,
      summary: verdict.summary,
      category: verdict.category,
      url: c.url,
      externalId: c.externalId,
    });
    if (added) stored++;
  }
  return stored;
}

async function runOnce(sources: Source[]): Promise<void> {
  for (const source of sources) {
    const n = await pollSource(source);
    if (n) console.log(`forwarding: filed ${n} item(s) from ${source.label}`);
  }
}

/** Start the interval loop. Returns immediately; a first run kicks off shortly
 * after boot so a freshly deployed feed isn't empty until the first interval. */
export function startForwardScheduler(): void {
  const sources = resolveSources(config.forwardSources);
  if (!sources.length) return; // nothing enabled — stay idle
  const hours = Number.isFinite(config.forwardPollHours) && config.forwardPollHours > 0 ? config.forwardPollHours : 12;
  const intervalMs = hours * 60 * 60_000;
  console.log(
    `forwarding: polling ${sources.map((s) => s.label).join(", ")} every ${hours}h`,
  );
  const tick = () => {
    void runOnce(sources).catch((err) => console.error("forwarding: poll run failed", err));
  };
  // First run 30s after boot (let the server settle), then on the interval.
  setTimeout(tick, 30_000).unref?.();
  setInterval(tick, intervalMs).unref?.();
}

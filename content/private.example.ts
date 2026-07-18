/**
 * Private context for the chat representative — the counterpart to the public
 * strategy doc. Everything configured here reaches the representative's system
 * prompt but never git: the real `content/private.ts` is gitignored (this
 * template bootstraps it on first run).
 *
 * Two mechanisms:
 *
 *   1. PRIVATE_CONTEXT — inline text spliced verbatim into the system prompt.
 *      Use it for secrets with reveal conditions, personal details, standing
 *      instructions.
 *
 *   2. PRIVATE_SOURCES — pointers to files elsewhere on this machine (other
 *      repos' READMEs, project notes, docs that update over time). Each file
 *      is re-read whenever it changes on disk, so the representative stays
 *      current without a restart. Point at specific files, not directories,
 *      and keep them prompt-sized. A missing file is skipped with a warning,
 *      never a crash.
 *
 * NOTE the security difference from `interests.ts`:
 *   - hidden interests are structurally unleakable (never in the chat model's
 *     context; only the matching plane sees them).
 *   - private context IS in the chat model's context, guarded only by its
 *     instructions — a determined jailbreak can extract it. Put things here
 *     only if instruction-level secrecy is enough.
 *
 * When deploying, copy your real `private.ts` to the server by hand (it won't
 * arrive via git) — and remember source paths must exist on the server too.
 */

export interface PrivateSource {
  /** Short heading shown to the model above the file's content. */
  label: string;
  /** Absolute path, or relative to this project's root. */
  path: string;
  /**
   * Optional instructions for how the representative should treat this
   * source (e.g. "discuss freely" or "only mention if asked about X").
   * Default: it's additional background the representative may draw on.
   */
  note?: string;
}

export const PRIVATE_CONTEXT = "";

export const PRIVATE_SOURCES: PrivateSource[] = [
  // { label: "MyProject README", path: "C:/code/my-project/README.md",
  //   note: "Current state of Nico's side project; discuss freely." },
];

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { paths } from "./config.js";
import { PRIVATE_CONTEXT, PRIVATE_SOURCES, type PrivateSource } from "../content/private.js";

/**
 * Assembles the private slice of the representative's system prompt:
 * the inline PRIVATE_CONTEXT plus every readable PRIVATE_SOURCES file.
 * Source files are cached by mtime and re-read when they change on disk,
 * so edits to other repos/notes show up without a server restart.
 */

const cache = new Map<string, { mtimeMs: number; text: string }>();
const warned = new Set<string>();

function readSource(source: PrivateSource): string | null {
  const abs = isAbsolute(source.path) ? source.path : join(paths.root, source.path);
  try {
    const { mtimeMs } = statSync(abs);
    const hit = cache.get(abs);
    if (!hit || hit.mtimeMs !== mtimeMs) {
      cache.set(abs, { mtimeMs, text: readFileSync(abs, "utf8") });
      warned.delete(abs);
    }
    return cache.get(abs)!.text;
  } catch {
    if (!warned.has(abs)) {
      warned.add(abs);
      console.warn(`[private-context] cannot read "${source.label}" at ${abs} — skipping it.`);
    }
    return null;
  }
}

/** The full private block, or "" when nothing is configured/readable. */
export function privateContextBlock(): string {
  const parts: string[] = [];
  if (PRIVATE_CONTEXT.trim()) parts.push(PRIVATE_CONTEXT.trim());
  for (const source of PRIVATE_SOURCES) {
    const text = readSource(source);
    if (text === null) continue;
    parts.push(
      [
        `=== BEGIN PRIVATE SOURCE: ${source.label} ===`,
        ...(source.note ? [source.note, ""] : []),
        text.trim(),
        `=== END PRIVATE SOURCE: ${source.label} ===`,
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

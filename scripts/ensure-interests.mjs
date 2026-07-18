// Fresh clones don't have content/interests.ts (gitignored — its hidden
// entries are private). Bootstrap it from the committed template so
// dev/start/typecheck work out of the box.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const real = join(root, "content", "interests.ts");
const example = join(root, "content", "interests.example.ts");

if (!existsSync(real)) {
  copyFileSync(example, real);
  console.log(
    "[setup] created content/interests.ts from interests.example.ts — edit it to make it yours (it stays out of git)."
  );
}

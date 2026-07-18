// Fresh clones don't have the private content files (gitignored — their
// contents are private). Bootstrap them from the committed templates so
// dev/start/typecheck work out of the box.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const name of ["interests.ts", "private.ts"]) {
  const real = join(root, "content", name);
  const example = join(root, "content", name.replace(/\.ts$/, ".example.ts"));
  if (!existsSync(real)) {
    copyFileSync(example, real);
    console.log(
      `[setup] created content/${name} from its .example template — edit it to make it yours (it stays out of git).`
    );
  }
}

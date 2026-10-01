// Shared "am I the entry module?" guard for this directory's CLI scripts.
//
// A bare `import.meta.url === \`file://${process.argv[1]}\`` string compare
// is wrong in two ways. First, it's a raw string compare: a space in the
// path is unescaped in one side's file:// URL and not the other, so it never
// matches. Second, process.argv[1] is always the literal path the user
// typed — Node never resolves it — while import.meta.url normally *is*
// resolved to the realpath, so a symlinked invocation makes the two sides
// disagree even with no space involved. `node --preserve-symlinks-main`
// leaves import.meta.url unresolved too, which only hides the symlink case
// and does nothing for the space case. Either way, the guard can be
// silently false: main() never runs, the script prints nothing and exits 0
// — which reads as a clean pass instead of a skipped run. Resolving *both*
// sides to their realpath before comparing is correct regardless of which
// side(s) Node happened to resolve.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    // realpathSync throws ENOENT if argv[1] (or the import.meta.url path)
    // isn't an existing path at all (e.g. this module imported with an
    // unrelated or missing argv[1]) — that's not main-module execution
    // either.
    return false;
  }
}

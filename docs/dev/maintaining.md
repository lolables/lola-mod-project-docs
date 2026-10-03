# Maintaining docs-discipline

Step-by-step procedures for recurring maintainer changes. For why the
machinery is shaped this way, see [architecture.md](architecture.md).

## Add a document format

1. Vendor a parser if one is needed:
   - pin it in `.taskfiles/vendor/package.json`;
   - add a bundle entry in `.taskfiles/scripts/build-vendor.sh`;
   - add the package, and any transitive dependency, to the hardcoded
     package list in that same script that `LICENSES.md` is generated from;
   - run `task vendor`.
2. Write `scripts/formats/<name>.mjs` exporting `{ name, extensions,
   readmeNames, parse }`. `parse` returns the `DocModel` with exact 1-based
   lines; count them with `formats/text.mjs` (`splitLines`, `countLines`,
   `lineStarts`) so line endings are handled the same way as in every other
   adapter.
3. Add it to `FORMATS` in `scripts/formats/index.mjs`.
4. Write `tests/scripts/docs-organization/__fixtures__/formats/sample.<ext>`
   as the same document as `sample.md`, line for line. The conformance test
   picks it up automatically and fails until the model matches.
5. Write `tests/scripts/docs-organization/format-<name>.test.mjs` for the
   format's own constructs, with negative cases.
6. Add the format to `reference/supported-formats.md` and the README's
   "Supported formats" section.

Done when `task check` is green.

## Bump dependencies

`task deps:bump` moves every vendored dependency to its latest release in one
pass. It needs network access to the npm registry, `api.github.com`, and
`raw.githubusercontent.com`.

- **npm toolchain:** every `devDependencies` entry in
  `.taskfiles/vendor/package.json` goes to `@latest`, major versions included,
  and stays pinned exactly. The lockfile is rewritten too.
- **GitHub Linguist data:** `.taskfiles/vendor/linguist-pin.json` moves to
  Linguist's latest release tag. Every file it lists is re-hashed at that tag.
- **Bundles:** `task vendor` then regenerates `scripts/vendor/`.

Sample run with everything already current. A run that bumps something
prints npm's `changed N packages` and `bump-linguist-pin: v9.7.0 -> v9.8.0`
instead:

```text
$ task deps:bump
task: [deps:bump] cd .taskfiles/vendor && npm install --save-exact --package-lock=true $(node -p "...")
up to date in 343ms
task: [deps:bump] node .taskfiles/scripts/bump-linguist-pin.mjs
bump-linguist-pin: already at v9.7.0
task: [vendor] cd .taskfiles/vendor && npm install
up to date in 485ms
task: [vendor] bash "/workspace/.taskfiles/scripts/build-vendor.sh"
build-linguist-data: 1068 extensions, 185 filenames, 186 exclude patterns
build-vendor: wrote module/skills/docs-organization/scripts/vendor/{merval,markdown-it,asciidoctor}.mjs, module/skills/docs-organization/scripts/vendor/linguist.json, and LICENSES.md
```

Then:

1. Review `git diff`. The new Linguist hashes are trust-on-first-use, so
   check the `linguist.json` diff for unexpected changes. For a major npm
   bump, read the package's changelog.
2. If `LICENSES.md` generation fails with `no license text for <pkg>`, a new
   transitive dependency appeared. Add it to the package list in
   `.taskfiles/scripts/build-vendor.sh`.
3. Run `task check`, then commit `package.json`, the lockfile,
   `linguist-pin.json`, and the regenerated `scripts/vendor/`. Both pin
   files sit under a `vendor/` path, so a global `vendor/` ignore rule will
   hide them; use `git add -f` if so.

Dependabot still opens npm PRs, but only `task deps:bump` changes the
Linguist pin. GitHub Actions, the cleanroom base image, uv, and lola are out
of scope for the task: Dependabot handles the first two, and the last two are
bumped by hand.

Done when `task check` is green and CI's `git diff` check of
`scripts/vendor/` passes after its own `task vendor` run.

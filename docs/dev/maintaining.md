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

## Bump the GitHub Linguist data

`.taskfiles/scripts/build-linguist-data.mjs` pins the fetched Linguist tag
(`TAG`) and a SHA-256 per fetched file (`PINNED`). Dependabot never bumps
them, and `task vendor` needs network access to `raw.githubusercontent.com`.

1. Edit `TAG`.
2. Update every hash in `PINNED` to match the files at the new tag.
3. Run `task vendor`, then commit the regenerated `scripts/vendor/`.

Done when CI's `git diff` check of `scripts/vendor/` passes after its own
`task vendor` run.

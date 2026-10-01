# Known issues in the app CLI

Open defects, ordered by severity. Each entry names the file, the evidence,
and a proposed fix.

## 1. `--dry-run` still writes the lockfile

**Evidence:** `cmd/sync.go:88` calls `lockfile.Write(path, resolved)`
unconditionally; the `dryRun` flag checked at line 61 only skips the artifact
download loop starting at line 94.

**Impact:** Running `app sync --dry-run` mutates `app.lock` on disk, so a
user inspecting a planned change silently commits it instead.

**Proposed fix:** Guard the `lockfile.Write` call at line 88 with the same
`if !dryRun` condition used at line 94, and add a regression test that runs
`sync --dry-run` twice and asserts the lockfile's mtime is unchanged.

## 2. Resolver ignores `--offline` for transitive dependencies

**Evidence:** `internal/resolver/resolve.go:142` passes `offline: false` to
`fetchIndex` for transitive dependency lookups, even though the top-level
call at line 40 correctly forwards the CLI's `--offline` flag.

**Impact:** `app install --offline` fails with a network error instead of
resolving entirely from the local pool when a dependency has transitive
requirements.

**Proposed fix:** Thread the `offline` bool from the resolver's top-level
call through to `fetchIndex` at line 142 instead of hardcoding `false`.

## 3. Cache key omits platform triple for native artifacts

**Evidence:** `internal/cache/pool.go:57` builds the cache key from
`name + "@" + version` only; the platform triple is appended at line 61 but
only for packages where `manifest.HasNativeCode` is true, and that field is
never set by the manifest parser in `internal/manifest/parse.go`.

**Impact:** Native artifacts built for different platforms collide in the
shared pool, so a machine that installs both an amd64 and arm64 build of the
same version can silently serve the wrong binary.

**Proposed fix:** Set `HasNativeCode` from the manifest's `artifacts[].os`
field during parsing, or simplest: always include the platform triple in the
cache key regardless of `HasNativeCode`.

## 4. `app key rotate` leaves the old key marked trusted after `--force`

**Evidence:** `cmd/key.go:203` calls `keystore.Prune(oldKeyID)` only when the
overlap window (`--valid-for`, default `720h`) has elapsed; `--force` at line
198 skips the wait but does not call `Prune`.

**Impact:** A forced rotation leaves the compromised key in the trusted set,
which is the exact case `--force` exists to handle urgently.

**Proposed fix:** Call `keystore.Prune(oldKeyID)` unconditionally when
`--force` is set, immediately after the new key is published at line 195.

## 5. `app repo build` does not bump the index revision on a no-op run

**Evidence:** `cmd/repo.go:76` computes `newRevision` from
`len(releases)`, so re-running the command after only editing a release's
description (which does not change the release count) leaves `revision`
unchanged in the emitted index.

**Impact:** Mirrors that poll on `revision` never see description-only
edits, so `app search` on a mirror returns stale metadata indefinitely.

**Proposed fix:** Derive `newRevision` from a hash of the full index
contents, or increment it on every `repo build` invocation regardless of
whether the release count changed.

## 6. `app yank` does not remove the yanked release from `latest`

**Evidence:** `cmd/yank.go:34` sets `release.Yanked = true` and writes the
index, but never checks whether `tags["latest"]` currently points at the
yanked release's revision.

**Impact:** `app install pkg` with no version continues to resolve to a
release its publisher just withdrew as broken.

**Proposed fix:** After setting `Yanked = true`, if `tags["latest"]` equals
the yanked release, reassign it to the newest non-yanked release before
writing the index.

## 7. Namespace collision check is case-sensitive

**Evidence:** `internal/registry/namespace.go:19` compares new namespace
registrations with `existing == candidate`, a plain string equality.

**Impact:** `Acme/tools` and `acme/tools` register as distinct namespaces on
the same registry, letting an unrelated publisher claim a name that only
differs by case from an established one.

**Proposed fix:** Normalize both sides with `strings.ToLower` before the
comparison at line 19, and reject registration if the lowercased form
already exists under a different publisher.

## 8. `--verbose` output on `app sync` does not include the resolver's chosen version reason

**Evidence:** `cmd/sync.go:112` logs the resolved version for each package
under `--verbose` but omits the constraint that selected it, even though
`internal/resolver/resolve.go:88` already tracks `chosenBy` per package.

**Impact:** Debugging a version conflict requires re-running the resolver
with a separate flag instead of reading the `--verbose` output that already
claims to explain the resolution.

**Proposed fix:** Include `chosenBy` in the log line at `cmd/sync.go:112`,
formatted the same way `app why` already renders it.

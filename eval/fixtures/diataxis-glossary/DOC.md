# Glossary

Terms used across the `app` documentation, in alphabetical order.

**Artifact** — a single built output produced from a package's source, such as
a compiled binary or a wheel. Artifacts are what `app sync` actually downloads
and installs.

**Blob** — the raw, content-addressed bytes of an artifact or manifest,
stored under its digest in the cache. Blobs are never modified once written.

**Cache key** — the string `app` derives from a package name, version, and
platform triple to look up a cached artifact without re-resolving it.

**Channel** — a named update track (`stable`, `beta`, `nightly`) that a
registry publishes independently, each with its own index.

**Checksum** — a SHA-256 hash of an artifact's bytes, recorded in the
manifest and verified after every download before install.

**Dependency** — a package that another package's manifest declares as
required, identified by name and a version constraint.

**Digest** — the content address of a blob: the hex-encoded SHA-256 hash used
as its storage key and as the reference other manifests point to.

**Index** — the signed list of packages, versions, and digests that a
repository publishes; `app repo build` regenerates it after every change.

**Lockfile** — the resolver's recorded output: exact versions and digests for
every dependency in a project, so a later `app sync` is reproducible.

**Manifest** — the metadata file describing a single package: its name,
version, dependencies, and artifact checksums.

**Mirror** — a read-only copy of a repository's index and blobs, used to
distribute load or serve a region without write access to the origin.

**Namespace** — the prefix (`org/package`) that scopes a package name to its
publisher and prevents collisions across unrelated registries.

**Pin** — a manifest entry that locks a dependency to an exact version,
overriding the resolver's normal constraint-solving for that package.

**Pool** — the on-disk directory where `app` stores downloaded blobs, keyed
by digest, shared across all projects on a machine.

**Publisher** — the identity, verified by a signing key, that is authorized
to push new releases into a namespace on a registry.

**Registry** — a server that hosts one or more repositories and serves their
indexes and blobs over HTTPS.

**Release** — a specific version of a package, published once and
immutable; a new release is required to change any artifact.

**Repository** — a named collection of releases under a single index on a
registry, scoped to one or more channels.

**Resolver** — the component that reads a project's manifests and dependency
constraints and computes a consistent set of versions, written to the
lockfile.

**Revision** — the monotonically increasing counter attached to an index
each time `app repo build` republishes it.

**Signing key** — the private key a publisher uses to sign an index or
release; `app key rotate` replaces it without invalidating prior releases.

**Snapshot** — a saved copy of an index at a specific revision, used to pin
a mirror or a CI job to a known state.

**Tag** — a mutable alias (`latest`, `lts`) that a repository maps to a
specific release; unlike a release, a tag's target can change.

**Yank** — marking a published release as unavailable for new installs
without deleting its blobs, used to withdraw a broken version.

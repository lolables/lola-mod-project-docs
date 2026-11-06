# gridctl

gridctl requires Node.js ≥ 20 and listens on port 8080 by default.

## Install

1. Run step 3 of the setup guide first.
2. Pass 2 arguments: the grid name and the region.
3. Wait until the command prints `ready`; it times out after 30 seconds.

## Behavior

- A run exits 2 on a usage error, as RFC 2119 terms describe.
- Each record carries a SHA-256 per file, and text meets WCAG 4.5:1.
- A section over 100 lines (one range at 150 lines or fewer) is split.
- A change needs 2 reviewers, and 2 users must approve a release.
- Lane 4 checks links; Python 3 scripts and Go 1.22 are both supported.
- Create a new branch, then install the latest release.

Now run `gridctl apply`. You can now open the dashboard. The old flag no
longer exists, and the newly created grid shows files touched recently.

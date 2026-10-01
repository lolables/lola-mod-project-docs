# pagekit

pagekit checks and publishes a small Markdown site.

## Checks

| Script | What it checks |
| --- | --- |
| `tools/lint.sh` | trailing whitespace and missing SPDX license headers |
| `tools/fmt.sh` | rewrites `*` and `+` list markers to `-` |

Key scripts include `tools/lint.sh` and `tools/fmt.sh`.

## Publishing

Preview a release without tagging or uploading anything:

```bash
tools/deploy.sh --dry-run
```

When the preview looks right, run `tools/release.sh`. It tags the release
and hands it to `tools/deploy.sh --target production`. A site may hold at
most 500 pages (`MAX_PAGES` in `config.sh`); a larger site fails the
release.

## Project structure

```text
tools/               check, format, and publish scripts
docs/                site content
config.sh            site limits
tests/lint.bats      tests for lint.sh
tests/headers.bats   tests for headers.sh
```

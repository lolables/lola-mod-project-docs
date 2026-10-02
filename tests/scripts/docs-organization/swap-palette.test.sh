#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../../../module/skills/docs-organization/scripts/swap-palette.sh"
FIXTURES="$HERE/__fixtures__"

fail_count=0
pass_count=0
check() {
  local label="$1"; shift
  if "$@"; then
    echo "PASS: $label"; pass_count=$((pass_count + 1))
  else
    echo "FAIL: $label"; fail_count=$((fail_count + 1))
  fi
}

dir=$(mktemp -d -t swap-palette-test.XXXXXX)
trap 'rm -rf "$dir"' EXIT

# A real diagram keeps its body and gains the requested palette header.
rc=0; out=$(bash "$SCRIPT" citrus "$FIXTURES/good.mmd" 2>/dev/null) || rc=$?
check "good diagram exits 0" test "$rc" -eq 0
check "good diagram keeps its flowchart body" grep -q 'A\[Input\] --> B\[Process\]' <<< "$out"

# An empty input (what `swap-palette.sh p f > f` leaves behind once the
# shell truncates f) must fail loudly, not print a header-only diagram.
: > "$dir/empty.mmd"
rc=0; out=$(bash "$SCRIPT" citrus "$dir/empty.mmd" 2>"$dir/err") || rc=$?
check "empty input exits 2" test "$rc" -eq 2
check "empty input prints nothing on stdout" test -z "$out"
check "empty input explains itself on stderr" grep -q 'no diagram body' "$dir/err"

# A file holding only an init header and classDefs has no diagram either.
printf '%%%%{init: {"theme":"base"}}%%%%\nclassDef sysA fill:#000\n\n' > "$dir/header-only.mmd"
rc=0; bash "$SCRIPT" citrus "$dir/header-only.mmd" >/dev/null 2>&1 || rc=$?
check "header-only input exits 2" test "$rc" -eq 2

# Unknown palette names are rejected.
rc=0; bash "$SCRIPT" nope "$FIXTURES/good.mmd" >/dev/null 2>&1 || rc=$?
check "unknown palette exits 2" test "$rc" -eq 2

# --- .md: swap mermaid fences in place, every other byte untouched ---

LINT="$HERE/../../../module/skills/docs-organization/scripts/lint-mermaid.mjs"
# Everything outside ```mermaid … ``` fences, fence lines included.
outside_fences() { awk '/^```mermaid/ {print; skip=1; next} skip && /^```/ {skip=0} !skip {print}' "$1"; }

# The /docs-update regression: the header landed above `# Title` and the
# classDefs after the closing fence.
md="$FIXTURES/fenced-low-contrast.md"
rc=0; bash "$SCRIPT" solar "$md" > "$dir/swapped.md" 2>"$dir/err" || rc=$?
check "md: exits 0" test "$rc" -eq 0
check "md: first line is still the title" test "$(head -n1 "$dir/swapped.md")" = "# Title"
check "md: non-mermaid lines byte-identical" cmp -s <(outside_fences "$md") <(outside_fences "$dir/swapped.md")
check "md: init header directly follows the opening fence" \
  test "$(grep -A1 '^```mermaid$' "$dir/swapped.md" | tail -n1 | cut -c1-8)" = '%%{init:'
check "md: palette classDef sits inside the fence" \
  test "$(awk '/^```mermaid/ {f=1; next} /^```/ {f=0} f && /classDef sysA fill:#2f6dab/' "$dir/swapped.md" | wc -l)" -eq 1
check "md: old low-contrast classDef is gone" bash -c "! grep -q 'fill:#ffff00' '$dir/swapped.md'"
rc=0; node "$LINT" "$dir/swapped.md" >/dev/null 2>&1 || rc=$?
check "md: swapped file lints clean" test "$rc" -eq 0

# --block N (1-based) swaps only that fence.
two="$FIXTURES/fenced-blocks.md"
rc=0; bash "$SCRIPT" --block 2 citrus "$two" > "$dir/b2.md" 2>/dev/null || rc=$?
check "--block 2: exits 0" test "$rc" -eq 0
check "--block 2: non-mermaid lines byte-identical" cmp -s <(outside_fences "$two") <(outside_fences "$dir/b2.md")
check "--block 2: first fence untouched" cmp -s <(sed -n '1,/^```$/p' "$two") <(sed -n '1,/^```$/p' "$dir/b2.md")
check "--block 2: second fence gets the citrus header" grep -q "'primaryColor': '#a55726'" "$dir/b2.md"
check "--block 2: exactly one init header" test "$(grep -c '^%%{init:' "$dir/b2.md")" -eq 1
check "--block 2: custom classDef is kept" grep -q 'classDef myCustomClass fill:#3e6fa0' "$dir/b2.md"

# lint-mermaid's `block` field is exactly what --block takes: no arithmetic.
block=$(node "$LINT" --json "$two" | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8")).results;
  process.stdout.write(String(r.flatMap((x) => x.findings).find((f) => f.code === "UNAPPROVED_CLASSNAME").block));
') || true
check "lint block field for the 2nd fence is 2" test "$block" = 2
rc=0; bash "$SCRIPT" --block "$block" citrus "$two" > "$dir/by-field.md" 2>/dev/null || rc=$?
check "--block <block field>: exits 0" test "$rc" -eq 0
check "--block <block field> swaps exactly that fence" cmp -s "$dir/b2.md" "$dir/by-field.md"

# --- mixed ``` and ~~~ fences: block numbers agree between lint and swap,
# regardless of which fence character each diagram uses. ---

# Everything outside either fence type, fence lines included.
outside_mixed_fences() {
  awk '
    !skip && /^```mermaid$/ { print; skip=1; closer="```"; next }
    !skip && /^~~~mermaid$/ { print; skip=1; closer="~~~"; next }
    skip && $0 == closer { skip=0; next }
    !skip { print }
  ' "$1"
}

mixed="$FIXTURES/mixed-fences.md"
mixed_block=$(node "$LINT" --json "$mixed" | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8")).results;
  process.stdout.write(String(r.flatMap((x) => x.findings).find((f) => f.code === "UNAPPROVED_CLASSNAME").block));
') || true
check "lint block field for the ~~~ fence is 2" test "$mixed_block" = 2

rc=0; bash "$SCRIPT" --block 2 citrus "$mixed" > "$dir/mixed-b2.md" 2>/dev/null || rc=$?
check "mixed --block 2: exits 0" test "$rc" -eq 0
check "mixed --block 2: non-fence lines byte-identical" \
  cmp -s <(outside_mixed_fences "$mixed") <(outside_mixed_fences "$dir/mixed-b2.md")
check "mixed --block 2: first (backtick) fence untouched" \
  cmp -s <(sed -n '1,/^```$/p' "$mixed") <(sed -n '1,/^```$/p' "$dir/mixed-b2.md")
check "mixed --block 2: second (tilde) fence gets the citrus header" \
  grep -q "'primaryColor': '#a55726'" "$dir/mixed-b2.md"
check "mixed --block 2: exactly one init header" test "$(grep -c '^%%{init:' "$dir/mixed-b2.md")" -eq 1
check "mixed --block 2: custom classDef in the tilde fence is kept" \
  grep -q 'classDef myCustomClass fill:#3e6fa0' "$dir/mixed-b2.md"

# No --block: every fence is swapped.
rc=0; bash "$SCRIPT" solar "$two" > "$dir/all.md" 2>/dev/null || rc=$?
check "all fences: exits 0" test "$rc" -eq 0
check "all fences: one header per fence" test "$(grep -c '^%%{init:' "$dir/all.md")" -eq 2
check "all fences: non-mermaid lines byte-identical" cmp -s <(outside_fences "$two") <(outside_fences "$dir/all.md")

# A file without a trailing newline keeps that property.
# shellcheck disable=SC2016 # literal markdown fences, nothing to expand
printf '# T\n\n```mermaid\nflowchart LR\n  A --> B\n```\ntail' > "$dir/nonl.md"
bash "$SCRIPT" solar "$dir/nonl.md" > "$dir/nonl.out"
check "md: missing final newline preserved" test "$(tail -c4 "$dir/nonl.out")" = "tail"

# Refusals: exit 2, nothing on stdout, a reason on stderr.
refuses() {
  local label="$1" pattern="$2"; shift 2
  local rc=0 out
  out=$(bash "$SCRIPT" "$@" 2>"$dir/err") || rc=$?
  check "$label: exits 2" test "$rc" -eq 2
  check "$label: prints nothing on stdout" test -z "$out"
  check "$label: explains on stderr" grep -qi -- "$pattern" "$dir/err"
}
refuses "--block past the last fence" 'block 3' --block 3 solar "$two"
refuses "--block 0" 'positive integer' --block 0 solar "$two"
refuses "--block non-numeric" 'positive integer' --block x solar "$two"
refuses "--block empty" 'positive integer' --block "" solar "$two"
refuses "--block without a value" 'usage' solar "$two" --block
refuses "--block on a .mmd" 'whole diagram' --block 1 solar "$FIXTURES/good.mmd"
refuses "unknown option" 'unknown option' --blocks 1 solar "$two"
refuses "extra argument" 'usage' solar "$two" extra
printf '# No diagrams\n' > "$dir/none.md"
refuses ".md without mermaid fences" 'no mermaid' solar "$dir/none.md"
# Matches the .mmd empty-file message: `p f.md > f.md` truncates f.md to
# nothing before this reads it, so the same redirect hint applies here too.
refuses ".md without mermaid fences hints at redirect" 'redirected onto the input' solar "$dir/none.md"
: > "$dir/empty.md"
refuses "empty .md hints at redirect" 'redirected onto the input' solar "$dir/empty.md"
# shellcheck disable=SC2016 # literal markdown fences, nothing to expand
printf -- '- item\n\n  ```mermaid\n  flowchart LR\n    A --> B\n  ```\n' > "$dir/indented.md"
refuses "indented fence" 'indented' solar "$dir/indented.md"
printf "%%%%{init: {'theme': 'base'}\nflowchart LR\n  A --> B\n" > "$dir/open-header.mmd"
refuses "unterminated init header" 'unterminated' solar "$dir/open-header.mmd"

# .mmd: only palette classDefs are replaced; custom ones survive.
printf 'flowchart LR\n  A --> B\n  classDef sysA fill:#ffff00,color:#fff\n  classDef mine fill:#123456\n  class A sysA\n' > "$dir/custom.mmd"
bash "$SCRIPT" solar "$dir/custom.mmd" > "$dir/custom.out"
check "mmd: custom classDef kept" grep -q 'classDef mine fill:#123456' "$dir/custom.out"
check "mmd: sysA classDef replaced" test "$(grep -c 'classDef sysA' "$dir/custom.out")" -eq 1
check "mmd: low-contrast sysA fill gone" bash -c "! grep -q 'fill:#ffff00' '$dir/custom.out'"

# A header written `%%{ init: …` is replaced, not duplicated.
printf "%%%%{ init: {'theme': 'base'}}%%%%\nflowchart LR\n  A --> B\n" > "$dir/spaced.mmd"
bash "$SCRIPT" solar "$dir/spaced.mmd" > "$dir/spaced.out"
check "mmd: spaced init header replaced" test "$(grep -c 'init' "$dir/spaced.out")" -eq 1

# --- .markdown is swapped like .md ---
cp "$FIXTURES/fenced-low-contrast.md" "$dir/same.markdown"
rc=0; bash "$SCRIPT" solar "$dir/same.markdown" > "$dir/same.out" 2>/dev/null || rc=$?
check ".markdown: exits 0" test "$rc" -eq 0
check ".markdown: swapped like .md" cmp -s "$dir/swapped.md" "$dir/same.out"

# A fence inside an admonition is nested: refused, not corrupted.
# shellcheck disable=SC2016 # literal markdown fences, nothing to expand
printf -- '!!! note\n    ```mermaid\n    flowchart LR\n      A --> B\n    ```\n' > "$dir/admon.md"
refuses "fence in an admonition" 'indented' solar "$dir/admon.md"

# A closing fence indented 1-3 spaces is valid CommonMark; the swap keeps it
# (and the rest of the file) byte for byte, only the body in between changes.
# shellcheck disable=SC2016 # literal markdown fences, nothing to expand
printf -- '# T\n\n```mermaid\nflowchart LR\n  A --> B\n  ```\n' > "$dir/indented-closer.md"
rc=0; bash "$SCRIPT" solar "$dir/indented-closer.md" > "$dir/indented-closer.out" 2>"$dir/err" || rc=$?
check "indented closer: exits 0" test "$rc" -eq 0
check "indented closer: closing fence line preserved byte for byte" \
  cmp -s <(tail -n1 "$dir/indented-closer.md") <(tail -n1 "$dir/indented-closer.out")

# An unclosed fence with no final newline swaps successfully and idempotently.
# (The output of each swap is itself fed back in as a .md — extractMermaidBlocks
# and swap-palette.sh both key off the extension, not the content.)
# shellcheck disable=SC2016 # literal markdown fences, nothing to expand
printf '# T\n\n```mermaid\nflowchart LR\n  A --> B' > "$dir/unclosed.md"
rc=0; bash "$SCRIPT" solar "$dir/unclosed.md" > "$dir/unclosed.out.md" 2>"$dir/err" || rc=$?
check "unclosed fence (no final newline): exits 0" test "$rc" -eq 0
rc=0; bash "$SCRIPT" solar "$dir/unclosed.out.md" > "$dir/unclosed.out2.md" 2>/dev/null || rc=$?
check "unclosed fence: second swap exits 0" test "$rc" -eq 0
check "unclosed fence: idempotent (second swap byte-identical)" cmp -s "$dir/unclosed.out.md" "$dir/unclosed.out2.md"

# --- CRLF / CR-only docs keep their own line endings after a swap ---

# shellcheck disable=SC2016 # literal markdown fences, nothing to expand
printf '# T\r\n\r\n```mermaid\r\nflowchart LR\r\n  A --> B\r\n```\r\ntail\r\n' > "$dir/crlf.md"
rc=0; bash "$SCRIPT" solar "$dir/crlf.md" > "$dir/crlf.out.md" 2>"$dir/err" || rc=$?
check "CRLF: exits 0" test "$rc" -eq 0
check "CRLF: no bare-LF line endings" bash -c "! grep -qP '(?<!\r)\n' '$dir/crlf.out.md'"
rc=0; bash "$SCRIPT" solar "$dir/crlf.out.md" > "$dir/crlf.out2.md" 2>/dev/null || rc=$?
check "CRLF: second swap exits 0" test "$rc" -eq 0
check "CRLF: second swap is byte-identical" cmp -s "$dir/crlf.out.md" "$dir/crlf.out2.md"

# shellcheck disable=SC2016 # literal markdown fences, nothing to expand
printf '# T\r\r```mermaid\rflowchart LR\r  A --> B\r```\rtail\r' > "$dir/cr.md"
rc=0; bash "$SCRIPT" solar "$dir/cr.md" > "$dir/cr.out.md" 2>"$dir/err" || rc=$?
check "CR-only: exits 0" test "$rc" -eq 0
check "CR-only: no bare-LF line endings" bash -c "! grep -qP '\n' '$dir/cr.out.md'"
rc=0; bash "$SCRIPT" solar "$dir/cr.out.md" > "$dir/cr.out2.md" 2>/dev/null || rc=$?
check "CR-only: second swap exits 0" test "$rc" -eq 0
check "CR-only: second swap is byte-identical" cmp -s "$dir/cr.out.md" "$dir/cr.out2.md"

# --- .adoc: swap delimited mermaid blocks in place ---
outside_adoc_blocks() { awk '/^(\.\.\.\.|----)$/ {print; skip=!skip; next} !skip {print}' "$1"; }
adoc="$FIXTURES/fenced-low-contrast.adoc"
rc=0; bash "$SCRIPT" solar "$adoc" > "$dir/swapped.adoc" 2>"$dir/err" || rc=$?
check "adoc: exits 0" test "$rc" -eq 0
check "adoc: first line is still the title" test "$(head -n1 "$dir/swapped.adoc")" = "= Title"
check "adoc: lines outside the block byte-identical" cmp -s <(outside_adoc_blocks "$adoc") <(outside_adoc_blocks "$dir/swapped.adoc")
check "adoc: init header directly follows the opening delimiter" \
  test "$(grep -A1 '^\.\.\.\.$' "$dir/swapped.adoc" | sed -n 2p | cut -c1-8)" = '%%{init:'
check "adoc: old low-contrast classDef is gone" bash -c "! grep -q 'fill:#ffff00' '$dir/swapped.adoc'"
rc=0; node "$LINT" "$dir/swapped.adoc" >/dev/null 2>&1 || rc=$?
check "adoc: swapped file lints clean" test "$rc" -eq 0

two_adoc="$FIXTURES/fenced-blocks.adoc"
rc=0; bash "$SCRIPT" --block 2 citrus "$two_adoc" > "$dir/b2.adoc" 2>/dev/null || rc=$?
check "adoc --block 2: exits 0" test "$rc" -eq 0
check "adoc --block 2: first block untouched" cmp -s <(head -n 9 "$two_adoc") <(head -n 9 "$dir/b2.adoc")
check "adoc --block 2: exactly one init header" test "$(grep -c '^%%{init:' "$dir/b2.adoc")" -eq 1
check "adoc --block 2: custom classDef is kept" grep -q 'classDef myCustomClass fill:#3e6fa0' "$dir/b2.adoc"

printf '[mermaid]\nflowchart LR\n  A --> B\n' > "$dir/para.adoc"
refuses "adoc [mermaid] paragraph" 'indented or nested' solar "$dir/para.adoc"

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]

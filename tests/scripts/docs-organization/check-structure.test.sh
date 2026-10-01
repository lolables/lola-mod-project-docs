#!/usr/bin/env bash
set -euo pipefail

# Isolate from the host's git config (commit.gpgsign, core.hooksPath,
# init.defaultBranch, safe.directory, etc.) so tests run identically on
# every dev machine and CI runner. Requires git ≥ 2.32.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../../../module/skills/docs-organization/scripts/check-structure.sh"

mktmp() {
  mktemp -d -t check-structure-test.XXXXXX
}

fail_count=0
pass_count=0

assert_grep() {
  local pattern="$1" haystack="$2" label="$3"
  if echo "$haystack" | grep -q "$pattern"; then
    echo "PASS: $label"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL: $label"
    echo "  expected pattern: $pattern"
    echo "  got: $haystack"
    fail_count=$((fail_count + 1))
  fi
}

refute_grep() {
  local pattern="$1" haystack="$2" label="$3"
  if echo "$haystack" | grep -q "$pattern"; then
    echo "FAIL: $label"
    echo "  unexpected pattern: $pattern"
    echo "  got: $haystack"
    fail_count=$((fail_count + 1))
  else
    echo "PASS: $label"
    pass_count=$((pass_count + 1))
  fi
}

# Builds canon/{a,b,c}.md and mod/ holding symlinks a.md, b.md into canon/.
make_symlink_tree() {
  git init -q
  echo "# Test" > README.md
  mkdir canon mod
  for n in a b c; do echo "# $n" > "canon/$n.md"; done
  ln -s ../canon/a.md mod/a.md
  ln -s ../canon/b.md mod/b.md
}

# Test 1: empty repo flags missing README
dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
out=$(bash "$SCRIPT" 2>&1 || true)
assert_grep '"code": *"MISSING_README"' "$out" "empty repo flags MISSING_README"
popd > /dev/null
rm -rf "$dir"

# Test 2: project uses docs/, no docs/superpowers gitignore entry -> flagged
dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
echo "# Test" > README.md
mkdir docs; echo "notes" > docs/notes.md
echo "node_modules/" > .gitignore
out=$(bash "$SCRIPT" 2>&1 || true)
assert_grep '"code": *"MISSING_GITIGNORE_SUPERPOWERS"' "$out" "missing superpowers gitignore (docs/ present)"
popd > /dev/null
rm -rf "$dir"

# Test 2b: no docs/ dir at all -> the preventive entry is not demanded (no noise)
dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
echo "# Test" > README.md
echo "node_modules/" > .gitignore
out=$(bash "$SCRIPT" 2>&1 || true)
assert_grep '"status": *"ok"' "$out" "no docs/ dir -> no superpowers-gitignore blocker"
popd > /dev/null
rm -rf "$dir"

# Test 2c: outside a git repo, docs/ present, no .gitignore at all — the
# gitignore check has no ignore machinery to query and nothing can yet be
# accidentally committed, so it must not produce a false MISSING_GITIGNORE_SUPERPOWERS
# blocker (or any other finding).
dir=$(mktmp); pushd "$dir" > /dev/null
echo "# Test" > README.md
mkdir docs; echo "notes" > docs/notes.md
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'MISSING_GITIGNORE_SUPERPOWERS' "$out" "non-git-repo: no false gitignore blocker"
popd > /dev/null
rm -rf "$dir"

# Test 3: everything good
dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
echo "# Test" > README.md
echo "docs/superpowers/" > .gitignore
out=$(bash "$SCRIPT" 2>&1 || true)
assert_grep '"status": *"ok"' "$out" "clean repo returns ok"
popd > /dev/null
rm -rf "$dir"

# Test 3b: gitignore entries a fixed regex misses, but git itself honors,
# must not produce a false MISSING_GITIGNORE_SUPERPOWERS blocker.
dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
echo "# Test" > README.md
mkdir docs; echo "notes" > docs/notes.md
printf '/docs/superpowers/\n' > .gitignore
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'MISSING_GITIGNORE_SUPERPOWERS' "$out" "leading-slash gitignore entry is honored"
popd > /dev/null
rm -rf "$dir"

dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
echo "# Test" > README.md
mkdir docs; echo "notes" > docs/notes.md
printf 'docs/superpowers/**\n' > .gitignore
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'MISSING_GITIGNORE_SUPERPOWERS' "$out" "double-star gitignore entry is honored"
popd > /dev/null
rm -rf "$dir"

dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
echo "# Test" > README.md
mkdir docs; echo "notes" > docs/notes.md
printf 'docs/superpowers/\r\n' > .gitignore
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'MISSING_GITIGNORE_SUPERPOWERS' "$out" "CRLF gitignore entry is honored"
popd > /dev/null
rm -rf "$dir"

dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
echo "# Test" > README.md
mkdir docs; echo "notes" > docs/notes.md
printf 'superpowers/\n' > docs/.gitignore
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'MISSING_GITIGNORE_SUPERPOWERS' "$out" "nested docs/.gitignore entry is honored"
popd > /dev/null
rm -rf "$dir"

# Test 3c: run from a subdirectory yields the same result as running from
# the repo root — the checks must not depend on cwd.
dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
echo "# Test" > README.md
mkdir docs; echo "notes" > docs/notes.md
echo "docs/superpowers/" > .gitignore
pushd docs > /dev/null
out=$(bash "$SCRIPT" 2>&1 || true)
popd > /dev/null
assert_grep '"status": *"ok"' "$out" "run from subdirectory: no false MISSING_README"
refute_grep 'MISSING_GITIGNORE_SUPERPOWERS' "$out" "run from subdirectory: gitignore check still finds root .gitignore"
popd > /dev/null
rm -rf "$dir"

# Test 4: superpowers tracked accidentally.
# This test deliberately simulates the broken state where someone committed
# a file under docs/superpowers/ — the check we expect SUPERPOWERS_IN_GIT
# to catch. Two things to handle:
#   1. The repo's local .gitignore omits the docs/superpowers/ entry on
#      purpose, BUT the user running this test may have docs/superpowers/
#      in their global gitignore (~/.config/git/ignore) because they
#      adopted this skill's convention. We bypass with `git add -f`.
#   2. A fresh tempdir repo has no committer identity, so set one locally.
dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
git config user.email "test@test.invalid"
git config user.name  "test"
echo "# Test" > README.md
mkdir -p docs/superpowers
echo "leaked" > docs/superpowers/spec.md
echo "node_modules/" > .gitignore  # deliberately missing the entry
git add README.md .gitignore
git add -f docs/superpowers/spec.md  # force past any global gitignore
git commit -q -m "oops"
out=$(bash "$SCRIPT" 2>&1 || true)
assert_grep '"code": *"SUPERPOWERS_IN_GIT"' "$out" "tracked superpowers files flagged"
popd > /dev/null
rm -rf "$dir"

# Test: a regular file among symlinks, with a same-named twin in the target dir → FORKED_COPY
dir=$(mktmp); pushd "$dir" > /dev/null
make_symlink_tree
echo "# c, edited locally" > mod/c.md
git add README.md canon mod
out=$(bash "$SCRIPT" 2>&1 || true)
assert_grep '"code": *"FORKED_COPY"' "$out" "forked copy among symlinks is flagged"
assert_grep 'mod/c.md' "$out" "FORKED_COPY names the copy"
assert_grep 'canon' "$out" "FORKED_COPY names the canonical directory"
if echo "$out" | python3 -m json.tool > /dev/null; then
  echo "PASS: FORKED_COPY output is valid JSON"; pass_count=$((pass_count + 1))
else
  echo "FAIL: FORKED_COPY output is not valid JSON"; echo "  got: $out"; fail_count=$((fail_count + 1))
fi
popd > /dev/null; rm -rf "$dir"

# Test: a regular file among symlinks that is byte-identical to its tracked
# twin has not diverged — no FORKED_COPY.
dir=$(mktmp); pushd "$dir" > /dev/null
make_symlink_tree
cp canon/c.md mod/c.md
git add README.md canon mod
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'FORKED_COPY' "$out" "byte-identical copy is not flagged"
popd > /dev/null; rm -rf "$dir"

# Test: all-symlink directory → no FORKED_COPY
dir=$(mktmp); pushd "$dir" > /dev/null
make_symlink_tree
git add README.md canon mod
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'FORKED_COPY' "$out" "directory of only symlinks is not flagged"
popd > /dev/null; rm -rf "$dir"

# Test: a regular file with no twin in the target dir → no FORKED_COPY
dir=$(mktmp); pushd "$dir" > /dev/null
make_symlink_tree
echo "# local only" > mod/extra.md
git add README.md canon mod
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'FORKED_COPY' "$out" "a file with no canonical twin is not flagged"
popd > /dev/null; rm -rf "$dir"

# Test: symlinks under a dot-directory are out of scope
dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
echo "# Test" > README.md
mkdir -p canon .agent/mod
for n in a c; do echo "# $n" > "canon/$n.md"; done
ln -s ../../canon/a.md .agent/mod/a.md
echo "# c copy" > .agent/mod/c.md
git add README.md canon .agent
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'FORKED_COPY' "$out" "dot-directory symlink trees are out of scope"
popd > /dev/null; rm -rf "$dir"

# Test: a path with a double quote still yields valid JSON
dir=$(mktmp); pushd "$dir" > /dev/null
make_symlink_tree
echo '# quoted' > 'canon/q"x.md'
echo '# quoted copy' > 'mod/q"x.md'
git add README.md canon mod
out=$(bash "$SCRIPT" 2>&1 || true)
assert_grep 'FORKED_COPY' "$out" "quoted filename is flagged"
if echo "$out" | python3 -m json.tool > /dev/null; then
  echo "PASS: quoted filename keeps JSON valid"; pass_count=$((pass_count + 1))
else
  echo "FAIL: quoted filename broke JSON"; echo "  got: $out"; fail_count=$((fail_count + 1))
fi
popd > /dev/null; rm -rf "$dir"

# T-a: a directory symlink is not "a directory of symlinks" — a symlink
# whose target is a directory must not be treated as a file-symlink pair.
dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
echo "# Test" > README.md
mkdir -p docs packages/api/docs
echo "# docs readme" > docs/README.md
echo "# api readme" > packages/api/README.md
echo "# x" > packages/api/docs/x.md
ln -s ../packages/api/docs docs/api
git add README.md docs packages
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'FORKED_COPY' "$out" "directory symlink is not treated as a file symlink"
popd > /dev/null; rm -rf "$dir"

# T-b: a single file symlink is not "a directory of symlinks" — need at
# least two symlinks into the same directory before a bare regular file
# there is suspicious.
dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
mkdir docs
echo "# a" > docs/a.md
ln -s docs/a.md a.md
echo "# root readme" > README.md
echo "# docs readme" > docs/README.md
echo "# root c" > c.md
echo "# docs c" > docs/c.md
git add README.md docs a.md c.md
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'FORKED_COPY' "$out" "a single symlink does not make siblings suspicious"
popd > /dev/null; rm -rf "$dir"

# T-c: README.md and index.md are conventional per-directory files, not
# forks, even when a same-named file sits in the symlink target too.
dir=$(mktmp); pushd "$dir" > /dev/null
make_symlink_tree
echo "# mod readme" > mod/README.md
echo "# canon readme" > canon/README.md
git add README.md canon mod
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'FORKED_COPY' "$out" "README.md is exempt from FORKED_COPY"
popd > /dev/null; rm -rf "$dir"

# T-d: the twin must be tracked. A same-named file that merely exists on
# disk (but was never git-added) is not evidence of a fork.
dir=$(mktmp); pushd "$dir" > /dev/null
make_symlink_tree
echo "# c, edited locally" > mod/c.md
git add README.md canon/a.md canon/b.md mod  # canon/c.md deliberately not added
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'FORKED_COPY' "$out" "untracked twin is not flagged"
popd > /dev/null; rm -rf "$dir"

# T-e: a filename containing a raw control byte (ESC) must still be flagged
# and must still produce valid JSON.
dir=$(mktmp); pushd "$dir" > /dev/null
make_symlink_tree
esc_name=$'e\x1bx.md'
echo "# esc canon" > "canon/$esc_name"
echo "# esc mod, edited locally" > "mod/$esc_name"
git add README.md canon mod
out=$(bash "$SCRIPT" 2>&1 || true)
assert_grep '"code": *"FORKED_COPY"' "$out" "control-char filename is flagged"
if echo "$out" | python3 -m json.tool > /dev/null; then
  echo "PASS: control-char filename keeps JSON valid"; pass_count=$((pass_count + 1))
else
  echo "FAIL: control-char filename broke JSON"; echo "  got: $out"; fail_count=$((fail_count + 1))
fi
popd > /dev/null; rm -rf "$dir"

# T-f: a symlink-holding directory literally named with git pathspec magic
# syntax must not defeat detection — the check must never pass a directory
# name to git as a pathspec.
dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
echo "# Test" > README.md
mkdir canon ":(glob)m"
for n in a b c; do echo "# $n" > "canon/$n.md"; done
ln -s ../canon/a.md ":(glob)m/a.md"
ln -s ../canon/b.md ":(glob)m/b.md"
echo "# c, edited locally" > ":(glob)m/c.md"
git --literal-pathspecs add README.md canon ":(glob)m"
out=$(bash "$SCRIPT" 2>&1 || true)
assert_grep '"code": *"FORKED_COPY"' "$out" "pathspec-magic directory name is still flagged"
popd > /dev/null; rm -rf "$dir"

# T-g: a symlink whose target lies outside the repo must not make a
# same-named file elsewhere on disk look like a fork.
dir=$(mktmp); pushd "$dir" > /dev/null
extdir=$(mktmp)
echo "# ext link1" > "$extdir/link1.md"
echo "# ext link2" > "$extdir/link2.md"
echo "# ext real"  > "$extdir/real.md"
git init -q
echo "# Test" > README.md
mkdir mod
ln -s "$extdir/link1.md" mod/link1.md
ln -s "$extdir/link2.md" mod/link2.md
echo "# real, tracked" > mod/real.md
git add README.md mod
out=$(bash "$SCRIPT" 2>&1 || true)
refute_grep 'FORKED_COPY' "$out" "symlink target outside the repo is out of scope"
popd > /dev/null; rm -rf "$dir" "$extdir"


# Test: a failing `git check-ignore` is an internal error (exit 2), never a
# false MISSING_GITIGNORE_SUPERPOWERS blocker.
dir=$(mktmp); pushd "$dir" > /dev/null
git init -q
echo "# Test" > README.md
mkdir docs
mkdir fakebin
# shellcheck disable=SC2016 # $1 and $@ belong to the generated script, not this one
printf '#!/usr/bin/env bash\n[ "$1" = check-ignore ] && exit 128\nexec %s "$@"\n' "$(command -v git)" > fakebin/git
chmod +x fakebin/git
rc=0; out=$(PATH="$PWD/fakebin:$PATH" bash "$SCRIPT" 2>&1) || rc=$?
if [ "$rc" -eq 2 ] && ! echo "$out" | grep -q MISSING_GITIGNORE_SUPERPOWERS; then
  echo "PASS: check-ignore failure exits 2 without a false blocker"; pass_count=$((pass_count + 1))
else
  echo "FAIL: check-ignore failure should exit 2 with no blocker (rc=$rc)"; echo "  got: $out"; fail_count=$((fail_count + 1))
fi
popd > /dev/null
rm -rf "$dir"

echo ""
echo "Results: $pass_count passed, $fail_count failed"
if [ "$fail_count" -gt 0 ]; then
  exit 1
fi

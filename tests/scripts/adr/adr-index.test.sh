#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../../../module/skills/adr/scripts/adr-index.sh"

mktmp() { mktemp -d -t adr-index-test.XXXXXX; }

fail_count=0; pass_count=0
assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $label"; pass_count=$((pass_count + 1))
  else
    echo "FAIL: $label"
    diff <(echo "$expected") <(echo "$actual") || true
    fail_count=$((fail_count + 1))
  fi
}

# Test 1: empty directory → minimal index.
dir=$(mktmp); pushd "$dir" > /dev/null
mkdir -p docs/dev/adr
bash "$SCRIPT" docs/dev/adr
got=$(cat docs/dev/adr/index.md)
expected="# Architectural Decision Records

No ADRs yet. Use /adr-new to create one."
assert_eq "$expected" "$got" "empty dir produces stub index"
popd > /dev/null; rm -rf "$dir"

# Test 2: two ADRs, one proposed, one accepted.
dir=$(mktmp); pushd "$dir" > /dev/null
mkdir -p docs/dev/adr
cat > docs/dev/adr/0001-use-postgres.md <<'EOF'
---
status: accepted
date: 2026-05-01
---

# Use Postgres
EOF
cat > docs/dev/adr/0002-cache-strategy.md <<'EOF'
---
status: proposed
date: 2026-05-13
---

# Cache strategy
EOF
bash "$SCRIPT" docs/dev/adr
got=$(cat docs/dev/adr/index.md)
expected="# Architectural Decision Records

| ID | Title | Status | Date |
|----|-------|--------|------|
| [0001](0001-use-postgres.md) | Use Postgres | accepted | 2026-05-01 |
| [0002](0002-cache-strategy.md) | Cache strategy | proposed | 2026-05-13 |"
assert_eq "$expected" "$got" "two ADRs produce sorted table"
popd > /dev/null; rm -rf "$dir"

# Test 3: malformed ADR (no frontmatter) → warning marker but still indexed.
dir=$(mktmp); pushd "$dir" > /dev/null
mkdir -p docs/dev/adr
cat > docs/dev/adr/0001-broken.md <<'EOF'
# Broken
EOF
bash "$SCRIPT" docs/dev/adr
got=$(cat docs/dev/adr/index.md)
expected="# Architectural Decision Records

| ID | Title | Status | Date |
|----|-------|--------|------|
| [0001](0001-broken.md) | Broken | unknown | unknown |"
assert_eq "$expected" "$got" "malformed ADR shows unknown status"
popd > /dev/null; rm -rf "$dir"

# Test 4: pipe in title is escaped so it can't break the table.
dir=$(mktmp); pushd "$dir" > /dev/null
mkdir -p docs/dev/adr
cat > docs/dev/adr/0001-pipe.md <<'EOF'
---
status: accepted
date: 2026-05-01
---

# Use A | B
EOF
bash "$SCRIPT" docs/dev/adr
got=$(cat docs/dev/adr/index.md)
expected="# Architectural Decision Records

| ID | Title | Status | Date |
|----|-------|--------|------|
| [0001](0001-pipe.md) | Use A \\| B | accepted | 2026-05-01 |"
assert_eq "$expected" "$got" "pipe in title is escaped"
popd > /dev/null; rm -rf "$dir"

# Test 5: CRLF front matter leaves no stray \r in the cells.
dir=$(mktmp); pushd "$dir" > /dev/null
mkdir -p docs/dev/adr
printf -- '---\r\nstatus: accepted\r\ndate: 2026-05-01\r\n---\r\n\r\n# CRLF Title\r\n' \
  > docs/dev/adr/0001-crlf.md
bash "$SCRIPT" docs/dev/adr
got=$(cat docs/dev/adr/index.md)
expected="# Architectural Decision Records

| ID | Title | Status | Date |
|----|-------|--------|------|
| [0001](0001-crlf.md) | CRLF Title | accepted | 2026-05-01 |"
assert_eq "$expected" "$got" "CRLF front matter produces clean cells"
popd > /dev/null; rm -rf "$dir"

# Test 6: quoted front-matter values lose their surrounding quotes.
dir=$(mktmp); pushd "$dir" > /dev/null
mkdir -p docs/dev/adr
cat > docs/dev/adr/0001-quoted.md <<'EOF'
---
status: "accepted"
date: '2026-05-01'
---

# Quoted Values
EOF
bash "$SCRIPT" docs/dev/adr
got=$(cat docs/dev/adr/index.md)
expected="# Architectural Decision Records

| ID | Title | Status | Date |
|----|-------|--------|------|
| [0001](0001-quoted.md) | Quoted Values | accepted | 2026-05-01 |"
assert_eq "$expected" "$got" "quoted front-matter values are unquoted"
popd > /dev/null; rm -rf "$dir"

# Test 7: a filename with a space gets a valid, percent-encoded link.
dir=$(mktmp); pushd "$dir" > /dev/null
mkdir -p docs/dev/adr
cat > "docs/dev/adr/0001-my decision.md" <<'EOF'
---
status: proposed
date: 2026-05-20
---

# My Decision
EOF
bash "$SCRIPT" docs/dev/adr
got=$(cat docs/dev/adr/index.md)
expected="# Architectural Decision Records

| ID | Title | Status | Date |
|----|-------|--------|------|
| [0001](0001-my%20decision.md) | My Decision | proposed | 2026-05-20 |"
assert_eq "$expected" "$got" "filename with a space is percent-encoded"
popd > /dev/null; rm -rf "$dir"

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]

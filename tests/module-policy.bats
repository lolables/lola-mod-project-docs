bats_require_minimum_version 1.5.0

# Repo-specific policy for module/: the public names users depend on and
# the explicit-invocation contract. Generic structure checks live in the
# shared lint-structure.sh, which must stay identical with lola-mod-template.

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  BROKEN="$BATS_TEST_TMPDIR/module"
}

# A copy of the real module, so each negative test breaks exactly one rule.
copy_module() { cp -R "$REPO/module" "$BROKEN"; }

skills_are_explicit() {
  local s desc rc=0
  for s in "$1"/skills/*/SKILL.md; do
    desc="$(sed -n '2,/^---$/p' "$s" | grep -m1 '^description:')"
    case "$desc" in
      "description: DO NOT AUTO-INVOKE."* | "description: \"DO NOT AUTO-INVOKE."* | "description: 'DO NOT AUTO-INVOKE."*) ;;
      *) echo "skill lacks the DO NOT AUTO-INVOKE. prefix: $s"; rc=1 ;;
    esac
  done
  return "$rc"
}

# The prose rule itself says `.claude/skills/...` (literal ellipsis); only a
# concrete path segment after skills/ is a hardcoded install path.
no_hardcoded_skill_paths() {
  local rc=0
  grep -rnE --exclude-dir=vendor '\.claude/skills/[A-Za-z0-9_$-]' "$1" || rc=$?
  case "$rc" in
    0) echo "hardcoded .claude/skills path; use \$SKILL_DIR"; return 1 ;;
    1) return 0 ;;
    *) echo "grep failed (exit $rc) scanning $1"; return 1 ;;
  esac
}

public_names_present() {
  local c s rc=0
  for c in docs-init docs-audit docs-update diagram-test adr-new adr-review; do
    [ -f "$1/commands/$c.md" ] || { echo "missing command: $c"; rc=1; }
  done
  for s in docs-organization adr; do
    [ -f "$1/skills/$s/SKILL.md" ] || { echo "missing skill: $s"; rc=1; }
  done
  node -e '
    const fs = require("fs");
    const path = require("path");
    const dir = process.argv[1];
    let ok = true;
    for (const p of ["solar", "federation", "citrus", "parchment"]) {
      let j;
      try {
        j = JSON.parse(fs.readFileSync(path.join(dir, p + ".json"), "utf8"));
      } catch (e) {
        console.log(`palette ${p}: ${e.message}`);
        ok = false;
        continue;
      }
      for (const k of ["sysA", "sysB", "sysC", "sysD", "sysE", "sysF"]) {
        if (!j.nodes || !j.nodes[k]) { console.log(`palette ${p}: missing nodes.${k}`); ok = false; }
      }
      if (!j.edgeLabel) { console.log(`palette ${p}: missing edgeLabel`); ok = false; }
    }
    process.exit(ok ? 0 : 1);
  ' "$1/skills/docs-organization/reference/palettes" || rc=1
  return "$rc"
}

@test "real module: every skill carries the DO NOT AUTO-INVOKE. prefix" {
  run -0 skills_are_explicit "$REPO/module"
}

@test "a skill without the DO NOT AUTO-INVOKE. prefix fails" {
  copy_module
  sed -i.bak 's/^description: DO NOT AUTO-INVOKE\. /description: /' "$BROKEN/skills/adr/SKILL.md"
  run -1 skills_are_explicit "$BROKEN"
  [[ "$output" == *"skill lacks the DO NOT AUTO-INVOKE. prefix"*skills/adr/SKILL.md* ]]
}

@test "real module: no hardcoded .claude/skills path" {
  run -0 no_hardcoded_skill_paths "$REPO/module"
}

@test "a hardcoded .claude/skills path in a command fails" {
  copy_module
  echo 'Run `bash ~/.claude/skills/adr/scripts/adr-index.sh`.' >> "$BROKEN/commands/adr-new.md"
  run -1 no_hardcoded_skill_paths "$BROKEN"
  [[ "$output" == *commands/adr-new.md* ]]
  [[ "$output" == *"hardcoded .claude/skills path; use \$SKILL_DIR"* ]]
}

@test "the prose prohibition .claude/skills/... does not trip the path check" {
  copy_module
  echo 'Do not hardcode `.claude/skills/...` anywhere.' >> "$BROKEN/commands/adr-new.md"
  run -0 no_hardcoded_skill_paths "$BROKEN"
}

@test "a .claude/skills path inside vendor/ is ignored" {
  copy_module
  echo '// see .claude/skills/x' >> "$BROKEN/skills/docs-organization/scripts/vendor/asciidoctor.mjs"
  run -0 no_hardcoded_skill_paths "$BROKEN"
}

@test "real module: every public command, skill, and palette name exists" {
  run -0 public_names_present "$REPO/module"
}

@test "a removed slash command fails" {
  copy_module
  rm "$BROKEN/commands/adr-review.md"
  run -1 public_names_present "$BROKEN"
  [[ "$output" == *"missing command: adr-review"* ]]
}

@test "a renamed skill fails" {
  copy_module
  mv "$BROKEN/skills/adr" "$BROKEN/skills/decisions"
  run -1 public_names_present "$BROKEN"
  [[ "$output" == *"missing skill: adr"* ]]
}

@test "a palette missing a class fails" {
  copy_module
  node -e '
    const f = process.argv[1];
    const j = JSON.parse(require("fs").readFileSync(f, "utf8"));
    delete j.nodes.sysC;
    require("fs").writeFileSync(f, JSON.stringify(j));
  ' "$BROKEN/skills/docs-organization/reference/palettes/citrus.json"
  run -1 public_names_present "$BROKEN"
  [[ "$output" == *"palette citrus: missing nodes.sysC"* ]]
}

@test "a removed palette fails" {
  copy_module
  rm "$BROKEN/skills/docs-organization/reference/palettes/parchment.json"
  run -1 public_names_present "$BROKEN"
  [[ "$output" == *"palette parchment"* ]]
}

@test "a missing scan directory fails instead of passing silently" {
  run -1 no_hardcoded_skill_paths "$BATS_TEST_TMPDIR/absent"
  [[ "$output" == *"grep failed"* ]]
}

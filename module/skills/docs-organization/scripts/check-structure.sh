#!/usr/bin/env bash
set -euo pipefail

# Emits structural drift findings as JSON on stdout. Messages may embed file
# paths, so add_finding JSON-escapes them.
# Exit code: 0 = no findings, 1 = findings, 2 = internal error.

# Format registry: which README names satisfy the README rule and which file
# extensions are docs. Resolved before the cd below, while BASH_SOURCE is
# still valid relative to the caller's cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! readme_list=$(node "$SCRIPT_DIR/formats/index.mjs" --readmes) \
  || ! ext_list=$(node "$SCRIPT_DIR/formats/index.mjs" --extensions); then
  echo '{"status": "error", "message": "format registry (formats/index.mjs) failed"}'
  exit 2
fi
mapfile -t readme_names <<< "$readme_list"
mapfile -t doc_exts <<< "$ext_list"

is_doc() {
  local lower="${1,,}" ext
  for ext in "${doc_exts[@]}"; do
    case "$lower" in *?"$ext") return 0;; esac
  done
  return 1
}

# README.<ext> and index.<ext> are conventional per-directory files, not forks.
is_conventional_name() {
  local n
  for n in "${readme_names[@]}"; do [ "$1" = "$n" ] && return 0; done
  case "$1" in index.*) is_doc "$1" && return 0;; esac
  return 1
}

findings=()

# Run every check from the repo root, regardless of the cwd the caller
# invoked us from: relative paths below (README.md, docs/, .gitignore, git
# ls-files output) are all root-relative. `in_git_repo` is computed once and
# reused by every check gated on git being available.
in_git_repo=0
if git rev-parse --git-dir > /dev/null 2>&1; then
  in_git_repo=1
  cd "$(git rev-parse --show-toplevel)"
fi

json_escape() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/\\r}
  # Filenames can carry other raw control bytes (e.g. ESC). JSON forbids
  # unescaped control characters in strings, so \u-escape whatever the
  # replacements above didn't already handle.
  case "$s" in
    *[[:cntrl:]]*)
      local out="" i c n
      for (( i = 0; i < ${#s}; i++ )); do
        c="${s:i:1}"
        n=$(printf '%d' "'$c")
        if [ "$n" -ge 1 ] && [ "$n" -le 31 ]; then
          out="$out$(printf '\\u%04x' "'$c")"
        else
          out="$out$c"
        fi
      done
      s="$out"
      ;;
  esac
  printf '%s' "$s"
}

add_finding() {
  local code="$1" severity="$2" message
  message=$(json_escape "$3")
  findings+=("{\"code\": \"$code\", \"severity\": \"$severity\", \"message\": \"$message\"}")
}

# Check 1: a README in any registered format, present and non-empty.
readme_found=0
for name in "${readme_names[@]}"; do
  if [ -f "$name" ] && [ -s "$name" ]; then readme_found=1; break; fi
done
if [ "$readme_found" -eq 0 ]; then
  readme_choices=$(printf '%s, ' "${readme_names[@]}")
  add_finding "MISSING_README" "blocker" \
    "README is missing or empty (any of: ${readme_choices%, }). Run /docs-init to scaffold one."
fi

# Check 2: if the project uses a docs/ tree, docs/superpowers/ must be gitignored
# (it holds working planning artifacts that must never be committed). A repo with
# no docs/ directory is not using the workflow, so demanding the preventive entry
# there is noise, not a defect — skip the check. The moment superpowers writes
# docs/superpowers/, docs/ exists and the check fires before anything is committed.
#
# Ask git itself rather than pattern-matching .gitignore text: git's own
# ignore-matching handles anchoring (`/docs/superpowers/`), globs
# (`docs/superpowers/**`), CRLF line endings, and nested .gitignore files
# (docs/.gitignore) correctly, where a single fixed regex cannot. The probed
# path is never created and need not exist — `--no-index` queries ignore
# rules only, without consulting the index or worktree. Outside a git repo
# there is no ignore machinery to ask, and nothing can be accidentally
# committed yet, so the check is skipped rather than guessed from file text.
if [ -d docs ] && [ "$in_git_repo" -eq 1 ]; then
  # check-ignore exits 0 = ignored, 1 = not ignored, anything else = git
  # failed. A failure must not read as "not ignored" (a false blocker).
  ignore_rc=0
  git check-ignore -q --no-index docs/superpowers/probe.md || ignore_rc=$?
  if [ "$ignore_rc" -eq 1 ]; then
    add_finding "MISSING_GITIGNORE_SUPERPOWERS" "blocker" \
      "docs/superpowers/ must be in .gitignore. /docs-init or /docs-update can add it."
  elif [ "$ignore_rc" -ne 0 ]; then
    echo '{"status": "error", "message": "git check-ignore failed"}'
    exit 2
  fi
fi

# Check 3: no docs/superpowers files are tracked.
if [ "$in_git_repo" -eq 1 ]; then
  if git ls-files docs/superpowers 2>/dev/null | grep -q .; then
    add_finding "SUPERPOWERS_IN_GIT" "blocker" \
      "Files under docs/superpowers/ are tracked in git. Run git rm --cached on them."
  fi
fi

# Check 4: if docs/dev/adr exists, expect an index.md.
if [ -d docs/dev/adr ] && [ ! -f docs/dev/adr/index.md ]; then
  add_finding "MISSING_ADR_INDEX" "warning" \
    "docs/dev/adr/ exists but index.md is missing. Run adr-index.sh."
fi
if [ -d docs/adr ] && [ ! -f docs/adr/index.md ]; then
  add_finding "MISSING_ADR_INDEX" "warning" \
    "docs/adr/ exists but index.md is missing. Run adr-index.sh."
fi

# Check 5: a regular doc file beside two or more file symlinks into the same
# directory, where that directory has a same-named tracked file, is a copy
# that risks forking from its canonical twin. Editing a symlink writes
# through to the target; editing the copy silently does not. Only plain
# file symlinks count — a directory symlink is not "a directory of
# symlinks" — and at least two of them must point into the same directory
# before a bare regular file sitting there is suspicious. README.<ext> and
# index.<ext> are conventional per-directory files, not forks, so they're
# exempt. The twin must itself be tracked: a same-named file that merely
# exists on disk is not evidence of a fork. Scope follows SKILL.md: tracked
# files only, nothing under a dot-directory. A copy that is still
# byte-identical to its twin has not forked yet — only a copy whose
# content has actually diverged is flagged.
if [ "$in_git_repo" -eq 1 ]; then
  root=$(pwd -P)

  md_dirs=()
  md_names=()
  md_paths=()

  pair_dirs=()
  pair_targets=()
  pair_counts=()

  while IFS= read -r -d '' entry; do
    mode=${entry%% *}
    f=${entry#*$'\t'}
    case "/$f" in */.*/*) continue;; esac

    case "$mode" in
      100644|100755)
        is_doc "$f" || continue
        d=${f%/*}; [ "$d" = "$f" ] && d=.
        name=${f##*/}
        md_dirs+=("$d")
        md_names+=("$name")
        md_paths+=("$f")
        ;;
      120000)
        # Dangling links and links to a directory (rather than a file) are
        # out of scope: a directory symlink is not "a directory of symlinks".
        [ -f "$f" ] || continue
        d=${f%/*}; [ "$d" = "$f" ] && d=.
        raw=$(readlink "$f") || continue
        rd=${raw%/*}; [ "$rd" = "$raw" ] && rd=.
        link_phys=$(cd "$d" 2>/dev/null && pwd -P) || continue
        target_dir=$(cd "$d" 2>/dev/null && cd "$rd" 2>/dev/null && pwd -P) || continue
        [ "$target_dir" = "$link_phys" ] && continue
        # A target outside the repo can't be diffed against by path; skip it.
        case "$target_dir" in
          "$root") target_rel=.;;
          "$root"/*) target_rel=${target_dir#"$root"/};;
          *) continue;;
        esac

        found=0
        i=0
        while [ "$i" -lt "${#pair_dirs[@]}" ]; do
          if [ "${pair_dirs[$i]}" = "$d" ] && [ "${pair_targets[$i]}" = "$target_rel" ]; then
            pair_counts[i]=$((pair_counts[i] + 1))
            found=1
            break
          fi
          i=$((i + 1))
        done
        if [ "$found" -eq 0 ]; then
          pair_dirs+=("$d")
          pair_targets+=("$target_rel")
          pair_counts+=(1)
        fi
        ;;
      *) continue;;
    esac
  done < <(git ls-files -s -z)

  i=0
  while [ "$i" -lt "${#pair_dirs[@]}" ]; do
    if [ "${pair_counts[$i]}" -ge 2 ]; then
      link_dir="${pair_dirs[$i]}"
      target_rel="${pair_targets[$i]}"
      j=0
      while [ "$j" -lt "${#md_dirs[@]}" ]; do
        if [ "${md_dirs[$j]}" = "$link_dir" ]; then
          name="${md_names[$j]}"
          f="${md_paths[$j]}"
          if ! is_conventional_name "$name"; then
            if [ "$target_rel" = "." ]; then
              twin="$name"
            else
              twin="$target_rel/$name"
            fi
            if git --literal-pathspecs ls-files --error-unmatch -- "$twin" > /dev/null 2>&1 \
              && ! cmp -s "$f" "$twin"; then
              add_finding "FORKED_COPY" "warning" \
                "$f is a regular file among symlinks into $target_rel/, and has diverged from its tracked twin $twin. Diff the two, then replace $f with a symlink or record why it differs."
            fi
          fi
        fi
        j=$((j + 1))
      done
    fi
    i=$((i + 1))
  done
fi

# Emit JSON.
if [ "${#findings[@]}" -eq 0 ]; then
  echo '{"status": "ok", "findings": []}'
  exit 0
fi

joined=$(IFS=,; echo "${findings[*]}")
echo "{\"status\": \"findings\", \"findings\": [$joined]}"
exit 1

#!/usr/bin/env bash
# Run one gate command. human mode: run it as-is. llm mode: log its output to
# .test-output/<name>.log; print "<name>: OK" on success, or (to stderr) the
# log plus "<name>: FAILED (exit N, log: <path>)" on failure. The command's
# exit code always wins.
#
# Usage: quiet-gate.sh --mode human|llm <name> -- <command> [args...]
set -uo pipefail

usage() { echo "quiet-gate: $1" >&2; echo "usage: quiet-gate.sh --mode human|llm <name> -- <command> [args...]" >&2; exit 2; }

{ [ "${1:-}" = --mode ] && [ $# -ge 2 ]; } || usage "--mode is required"
MODE="$2"; shift 2
case "$MODE" in
  human|llm) ;;
  *) usage "--mode must be human or llm" ;;
esac

{ [ $# -ge 1 ] && [ "$1" != -- ]; } || usage "a gate name is required"
NAME="$1"; shift
# The name becomes a filename; refuse anything that could leave .test-output/.
[[ "$NAME" =~ ^[A-Za-z0-9:_-]+$ ]] || usage "gate name may contain only letters, digits, ':', '_' and '-'"

[ "${1:-}" = -- ] || usage "'--' must separate the gate name from the command"
shift
[ $# -ge 1 ] || usage "a command is required after '--'"

if [ "$MODE" = human ]; then exec "$@"; fi

mkdir -p .test-output || { echo "quiet-gate: cannot create .test-output" >&2; exit 2; }
# ':' becomes '__' (not '-') so "a:b" and "a-b" cannot share a log.
LOG=".test-output/${NAME//:/__}.log"
# No stdin: a gate that reads it would otherwise hang with its prompt hidden in the log.
"$@" </dev/null >"$LOG" 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
  echo "$NAME: OK"
else
  cat "$LOG" >&2
  echo "$NAME: FAILED (exit $rc, log: $LOG)" >&2
fi
exit "$rc"

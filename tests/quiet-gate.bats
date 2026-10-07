bats_require_minimum_version 1.5.0

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  QG="$REPO/.taskfiles/scripts/quiet-gate.sh"
  cd "$BATS_TEST_TMPDIR" || return
}

@test "llm mode prints one OK line on stdout, nothing on stderr, and keeps the log" {
  run --separate-stderr bash "$QG" --mode llm demo:gate -- bash -c 'echo noisy; echo more'
  [ "$status" -eq 0 ]
  [ "$output" = "demo:gate: OK" ]
  [ -z "$stderr" ]
  grep -q noisy .test-output/demo__gate.log
}

@test "gate names differing only by ':' versus '-' get distinct logs" {
  bash "$QG" --mode llm a:b -- echo colon
  bash "$QG" --mode llm a-b -- echo dash
  grep -q colon .test-output/a__b.log
  grep -q dash .test-output/a-b.log
}

@test "llm mode sends the log and FAILED line to stderr, none to stdout, and passes the exit code through" {
  run --separate-stderr bash "$QG" --mode llm demo -- bash -c 'echo the-evidence; exit 3'
  [ "$status" -eq 3 ]
  [ -z "$output" ]
  [[ "$stderr" == *the-evidence* ]]
  [[ "$stderr" == *"demo: FAILED (exit 3, log: .test-output/demo.log)"* ]]
}

@test "llm mode captures stderr into the log" {
  run --separate-stderr bash "$QG" --mode llm demo -- bash -c 'echo to-stderr >&2'
  [ "$status" -eq 0 ]
  [ "$output" = "demo: OK" ]
  [ -z "$stderr" ]
  grep -q to-stderr .test-output/demo.log
}

@test "llm mode gives the command no stdin" {
  run bash "$QG" --mode llm demo -- cat <<<"leaked"
  [ "$status" -eq 0 ]
  [ ! -s .test-output/demo.log ]
}

@test "llm mode passes through exit 127 for a missing command" {
  run -127 --separate-stderr bash "$QG" --mode llm demo -- no-such-command-xyz
  [ "$status" -eq 127 ]
  [[ "$stderr" == *"demo: FAILED (exit 127"* ]]
}

@test "an unwritable .test-output is a usage-class error, not a gate failure" {
  touch .test-output
  run --separate-stderr bash "$QG" --mode llm demo -- true
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"quiet-gate: cannot create .test-output"* ]]
}

@test "human mode passes output and exit code through untouched" {
  run bash "$QG" --mode human demo -- bash -c 'echo direct; exit 4'
  [ "$status" -eq 4 ]
  [ "$output" = direct ]
  [ ! -e .test-output ]
}

@test "human mode keeps an argument with spaces intact" {
  run bash "$QG" --mode human demo -- bash -c 'printf %s "$1"' _ "two words"
  [ "$status" -eq 0 ]
  [ "$output" = "two words" ]
}

@test "an invalid mode is a usage error" {
  run --separate-stderr bash "$QG" --mode shouty demo -- true
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"--mode must be human or llm"* ]]
}

@test "a missing --mode is a usage error" {
  run --separate-stderr bash "$QG" demo -- true
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"--mode is required"* ]]
}

@test "a missing gate name is a usage error" {
  run --separate-stderr bash "$QG" --mode llm
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"a gate name is required"* ]]
}

@test "a missing -- separator is a usage error" {
  run --separate-stderr bash "$QG" --mode llm demo true
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"'--' must separate"* ]]
}

@test "a missing command is a usage error" {
  run --separate-stderr bash "$QG" --mode llm demo --
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"a command is required"* ]]
}

@test "a name that could escape .test-output is rejected" {
  run --separate-stderr bash "$QG" --mode llm ../escape -- true
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"gate name may contain only"* ]]
  [ ! -e escape.log ]
  [ ! -e .test-output ]
}

@test "names with a slash, no characters, or whitespace are rejected" {
  for bad in "a/b" "" "has space"; do
    run --separate-stderr bash "$QG" --mode llm "$bad" -- true
    [ "$status" -eq 2 ]
    [[ "$stderr" == *"gate name may contain only"* ]]
    [ ! -e .test-output ]
  done
}

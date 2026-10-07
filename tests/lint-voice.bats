bats_require_minimum_version 1.5.0

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  LV="$REPO/.taskfiles/scripts/lint-voice.mjs"
  cd "$BATS_TEST_TMPDIR" || return
}

# Writes $2 (printf format) to file $1.
doc() { printf -- "$2" >"$1"; }

@test "each word class is reported with its file, line, text, and reason" {
  doc a.md 'ok\nIt actively runs.\nSimply do it.\nSeamlessly done.\nA robust tool.\nComprehensive docs.\nPowerful stuff.\nEffortlessly fast.\nWe leverage it.\n'
  run -1 node "$LV" --mode llm a.md
  [[ "$output" == *'a.md:2: "actively" — '* ]]
  [[ "$output" == *'a.md:3: "Simply" — '* ]]
  [[ "$output" == *'a.md:4: "Seamlessly" — '* ]]
  [[ "$output" == *'a.md:5: "robust" — '* ]]
  [[ "$output" == *'a.md:6: "Comprehensive" — '* ]]
  [[ "$output" == *'a.md:7: "Powerful" — '* ]]
  [[ "$output" == *'a.md:8: "Effortlessly" — '* ]]
  [[ "$output" == *'a.md:9: "leverage" — '* ]]
  [[ "$output" == *"8 findings"* ]]
}

@test "inflected forms of leverage are reported" {
  doc a.md 'Leveraging it.\nShe leveraged it.\nIt leverages it.\n'
  run -1 node "$LV" --mode llm a.md
  [[ "$output" == *'a.md:1: "Leveraging"'* ]]
  [[ "$output" == *'a.md:2: "leveraged"'* ]]
  [[ "$output" == *'a.md:3: "leverages"'* ]]
}

@test "scaffold phrases are reported, including curly apostrophe and the spelled-out form" {
  doc a.md "It's worth noting a thing.\nIt’s worth noting a thing.\nIt is worth noting a thing.\nRun it in order to win.\n"
  run -1 node "$LV" --mode llm a.md
  [[ "$output" == *"a.md:1: \"It's worth noting\""* ]]
  [[ "$output" == *"a.md:2: \"It’s worth noting\""* ]]
  [[ "$output" == *'a.md:3: "It is worth noting"'* ]]
  [[ "$output" == *'a.md:4: "in order to" — wordy; use "to"'* ]]
}

@test "matching is case-insensitive" {
  doc a.md 'ROBUST and RoBuSt.\n'
  run -1 node "$LV" --mode llm a.md
  [[ "$output" == *'a.md:1: "ROBUST"'* ]]
  [[ "$output" == *'a.md:1: "RoBuSt"'* ]]
}

@test "a phrase wrapped across two lines is reported at its first line" {
  doc a.md 'Fine.\nWe run this in order\nto win.\n'
  run -1 node "$LV" --mode llm a.md
  [[ "$output" == *'a.md:2: "in order to"'* ]]
}

@test "only whole words match: simplify, robustness, simplistic, comprehension pass" {
  doc a.md 'We simplify. Robustness matters. A simplistic view. Comprehension helps. Overleverage.\n'
  run -0 node "$LV" --mode llm a.md
  [ -z "$output" ]
}

@test "words in fenced code, inline code, and link targets are not scanned" {
  doc a.md 'Intro.\n\n```sh\nrobust simply\n```\n\nUse `robust` here.\n\nSee [docs](https://example.com/robust-simply) now.\n'
  run -0 node "$LV" --mode llm a.md
  [ -z "$output" ]
}

@test "words in front matter are not scanned" {
  doc a.md '---\ndescription: a robust thing\n---\n\nBody.\n'
  run -0 node "$LV" --mode llm a.md
  [ -z "$output" ]
}

@test "a word on line 3 of a wrapped paragraph reports line 3 of the file" {
  doc a.md '# Title\n\nFirst line of prose\nsecond line of prose\nthird line is robust\nfourth.\n'
  run -1 node "$LV" --mode llm a.md
  [[ "$output" == *'a.md:5: "robust"'* ]]
}

@test "a line number after front matter and a code block stays the source line" {
  doc a.md '---\nt: x\n---\n\n```\ncode\n```\n\nA robust word.\n'
  run -1 node "$LV" --mode llm a.md
  [[ "$output" == *'a.md:9: "robust"'* ]]
}

@test "llm mode prints nothing for a clean file" {
  doc a.md 'Plain words only.\n'
  run -0 --separate-stderr node "$LV" --mode llm a.md
  [ -z "$output" ]
  [ -z "$stderr" ]
}

@test "findings across several files are all reported" {
  doc a.md 'robust\n'
  doc b.md 'fine\n\npowerful\n'
  run -1 node "$LV" --mode llm a.md b.md
  [[ "$output" == *'a.md:1: "robust"'* ]]
  [[ "$output" == *'b.md:3: "powerful"'* ]]
  [[ "$output" == *"2 findings"* ]]
}

@test "human mode reports findings without colour codes when not a terminal" {
  doc a.md 'robust\n'
  run -1 node "$LV" --mode human a.md
  [[ "$output" == *'a.md:1: "robust"'* ]]
  [[ "$output" != *$'\033'* ]]
}

@test "a missing file is a usage-class error" {
  run -2 --separate-stderr node "$LV" --mode llm nope.md
  [[ "$stderr" == *"lint-voice:"*"nope.md"* ]]
}

@test "no file arguments is a usage error" {
  run -2 --separate-stderr node "$LV"
  [[ "$stderr" == *"usage: lint-voice.mjs"* ]]
}

@test "an invalid --mode is a usage error" {
  doc a.md 'fine\n'
  run -2 --separate-stderr node "$LV" --mode loud a.md
  [[ "$stderr" == *"--mode must be human or llm"* ]]
}

@test "--mode without a value is a usage error" {
  run -2 --separate-stderr node "$LV" --mode
  [[ "$stderr" == *"--mode requires a value"* ]]
}

@test "headings and table cells are not prose and are not scanned" {
  doc a.md '# A robust heading\n\n| Col | Powerful |\n| --- | --- |\n| robust | simply |\n'
  run -0 node "$LV" --mode llm a.md
  [ -z "$output" ]
}

@test "a blockquote is someone else's words and is not scanned" {
  doc a.md 'Intro.\n\n> They simply leverage it.\n'
  run -0 node "$LV" --mode llm a.md
  [ -z "$output" ]
}

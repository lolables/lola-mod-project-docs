@test "release --dry-run does not tag" {
  run bash tools/release.sh --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == would* ]]
}

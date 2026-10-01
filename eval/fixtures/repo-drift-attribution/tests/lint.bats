@test "lint passes on a clean file" {
  run bash tools/lint.sh docs
  [ "$status" -eq 0 ]
}

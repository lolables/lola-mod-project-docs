@test "headers flags a script without SPDX" {
  run bash tools/headers.sh tools
  [ "$status" -eq 1 ]
}

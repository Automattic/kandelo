#!/usr/bin/env bash
# Bound the Formula-support files exposed by disposable Homebrew tap clones.

homebrew_prune_formula_support_tests_from_tapped_clone() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew-formula-support-inputs: expected one tapped-clone root" >&2
    return 2
  fi

  local tapped_root="$1"
  local git_root support_root test_relative test_root test_tree unsafe_entry unsafe_path
  if [ ! -d "$tapped_root" ] || [ -L "$tapped_root" ]; then
    echo "homebrew-formula-support-inputs: tapped clone must be a real directory" >&2
    return 2
  fi
  tapped_root="$(cd "$tapped_root" && pwd -P)"
  git_root="$(git -C "$tapped_root" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "$git_root" ] || [ ! -d "$git_root" ]; then
    echo "homebrew-formula-support-inputs: tapped clone is not a Git checkout" >&2
    return 2
  fi
  git_root="$(cd "$git_root" && pwd -P)"
  if [ "$git_root" != "$tapped_root" ]; then
    echo "homebrew-formula-support-inputs: tapped clone root differs from its Git root" >&2
    return 2
  fi

  support_root="$tapped_root/Kandelo/formula_support"
  test_relative="Kandelo/formula_support/test"
  test_root="$tapped_root/$test_relative"
  if [ ! -e "$test_root" ] && [ ! -L "$test_root" ]; then
    return 0
  fi
  if [ ! -d "$support_root" ] || [ -L "$support_root" ]; then
    echo "homebrew-formula-support-inputs: Formula support root must be a real directory" >&2
    return 2
  fi
  if [ -f "$test_root" ] && [ ! -L "$test_root" ]; then
    return 0
  fi
  if [ ! -d "$test_root" ] || [ -L "$test_root" ]; then
    echo "homebrew-formula-support-inputs: reserved Formula support test path must be a real directory" >&2
    return 2
  fi

  test_tree="$(git -C "$tapped_root" ls-tree HEAD -- "$test_relative")"
  if ! printf '%s\n' "$test_tree" | awk '
      NF == 0 { exit 1 }
      NR != 1 || $1 != "040000" || $2 != "tree" { exit 1 }
      END { if (NR != 1) exit 1 }
    '; then
    echo "homebrew-formula-support-inputs: reserved Formula support test directory is not bound to HEAD" >&2
    return 2
  fi

  unsafe_entry="$(
    git -C "$tapped_root" ls-tree -r HEAD -- "$test_relative" |
      awk '$1 != "100644" && $1 != "100755" { print; exit }'
  )"
  if [ -n "$unsafe_entry" ]; then
    echo "homebrew-formula-support-inputs: Formula support tests contain an unsafe Git object: $unsafe_entry" >&2
    return 2
  fi
  unsafe_path="$(
    find "$test_root" -mindepth 1 \
      \( -type l -o \( ! -type f -a ! -type d \) \) -print -quit
  )"
  if [ -n "$unsafe_path" ]; then
    echo "homebrew-formula-support-inputs: Formula support tests contain a symlink or special file: ${unsafe_path#"$tapped_root/"}" >&2
    return 2
  fi

  # This is an exact path inside a disposable clone already validated by the
  # caller. Removing it makes the identity exclusion an execution boundary:
  # Formula helpers and direct runners cannot load test files transitively.
  rm -rf -- "$test_root"
  if [ -e "$test_root" ] || [ -L "$test_root" ]; then
    echo "homebrew-formula-support-inputs: could not remove Formula support tests from tapped clone" >&2
    return 1
  fi
}

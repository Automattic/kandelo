#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
source "$root/scripts/package-fork-library-build.sh"
kandelo_package_build_fork_library "$here" kandelo-ffi-adapter libkandelo-ffi-adapter.a

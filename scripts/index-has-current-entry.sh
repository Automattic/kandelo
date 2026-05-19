#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 <index.toml> <package> <arch> <cache-key-sha> <revision>" >&2
  exit 2
fi

index="$1"
pkg="$2"
arch="$3"
sha="$4"
rev="$5"

[ -s "$index" ] || exit 1

awk -v pkg="$pkg" -v arch="$arch" -v sha="$sha" -v rev="$rev" '
  function reset_package() {
    in_pkg = 0
    in_arch = 0
    revision_match = 0
    success = 0
    sha_match = 0
  }

  function matches() {
    return in_pkg && revision_match && in_arch && success && sha_match
  }

  $0 == "[[packages]]" {
    if (matches()) {
      found = 1
      exit
    }
    reset_package()
    next
  }

  $0 == "name = \"" pkg "\"" {
    in_pkg = 1
    next
  }

  in_pkg && $0 == "revision = " rev {
    revision_match = 1
    next
  }

  in_pkg && $0 ~ /^\[packages\.binary\./ {
    in_arch = ($0 == "[packages.binary." arch "]")
    success = 0
    sha_match = 0
    next
  }

  in_pkg && in_arch && $0 == "status = \"success\"" {
    success = 1
    next
  }

  in_pkg && in_arch && $0 == "cache_key_sha = \"" sha "\"" {
    sha_match = 1
    next
  }

  END {
    if (matches()) {
      found = 1
    }
    exit found ? 0 : 1
  }
' "$index"

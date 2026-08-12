#!/usr/bin/env bash
# Write rustc's host target through a file so the outer dev-shell banner and
# Nix realization progress cannot be mistaken for machine data.
set -euo pipefail

out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out)
      out="${2:-}"
      shift 2
      ;;
    *)
      echo "write-dev-shell-host-target: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$out" ] || [[ "$out" != /* ]] || [ ! -f "$out" ] ||
   [ -L "$out" ]; then
  echo "write-dev-shell-host-target: --out must name an existing absolute regular file" >&2
  exit 2
fi

host_target="$(rustc -vV | awk '
  /^host:/ {
    count += 1
    if ($0 !~ /^host: [A-Za-z0-9_.-]+$/) exit 2
    target = substr($0, 7)
  }
  END {
    if (count != 1 || target == "") exit 2
    print target
  }
')" || {
  echo "write-dev-shell-host-target: rustc did not report one valid host target" >&2
  exit 1
}
if ! [[ "$host_target" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "write-dev-shell-host-target: rustc did not report one valid host target" >&2
  exit 1
fi

chmod 0600 "$out"
printf '%s\n' "$host_target" >"$out"
echo "write-dev-shell-host-target: wrote validated host target"

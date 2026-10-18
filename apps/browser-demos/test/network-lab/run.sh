#!/bin/bash
# Run the separate-networks session test: two computers, each behind its own
# NAT, find each other with STUN only. Needs Docker: Docker Engine on Linux,
# or Docker Desktop on macOS, which supplies the Linux VM whose network
# namespaces the lab is built from. On Linux the test also relays the dev
# server from the Docker bridge gateway (see kandelo-network-lab.spec.ts).
#
# Docker is a host capability, not a repo-declared tool, so its CLI is found
# here, before the dev shell replaces PATH, and passed in as KANDELO_DOCKER.
# Everything else runs in the dev shell.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker_cli="$(command -v docker || true)"
if [ -z "$docker_cli" ]; then
  echo "network lab: no docker CLI on PATH; install Docker (Docker Desktop on macOS)" >&2
  exit 1
fi
port="${KANDELO_PLAYWRIGHT_PORT:-5493}"
# The lab's STUN server, on its "internet" address (see lab.sh).
stun='[{"urls":"stun:203.0.113.1:3478"}]'
exec ../../scripts/dev-shell.sh bash -c '
  export KANDELO_NETWORK_LAB=1 KANDELO_DOCKER="$1" KANDELO_PLAYWRIGHT_PORT="$2" VITE_KANDELO_ICE_SERVERS="$3"
  shift 3
  # One lab at a time: each runs two Chromiums and two Kandelo machines in
  # the Docker VM, and parallel labs exhaust its memory.
  exec npx playwright test test/kandelo-network-lab.spec.ts --project=chromium --workers=1 "$@"
' bash "$docker_cli" "$port" "$stun" "$@"

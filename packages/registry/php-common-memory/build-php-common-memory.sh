#!/usr/bin/env bash
set -euo pipefail
recipe="$(cd "$(dirname "$0")" && pwd)"
exec bash "$recipe/../php/build-php.sh" --common-memory

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PHP_PACKAGE_DIR="$SCRIPT_DIR"
export PHP_BUILD_VARIANT=zts-embed
exec bash "$SCRIPT_DIR/../php/build-php.sh"

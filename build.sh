#!/bin/bash
set -euo pipefail
echo "build.sh is deprecated; delegating to ./run.sh setup" >&2
exec "$(dirname "$0")/run.sh" setup "$@"

#!/usr/bin/env bash
# Private recipe control; keep unrelated dependency cache inputs unchanged.
graphics_cts_build_jobs() {
    python3 - <<'PY'
import os
import sys
value = os.environ.get('WASM_POSIX_LOCAL_BUILD_JOBS', '2')
if not value or len(value) > 32 or any(c < '0' or c > '9' for c in value):
    raise SystemExit('WASM_POSIX_LOCAL_BUILD_JOBS must be an exact positive integer')
jobs = int(value)
if not 0 < jobs <= sys.maxsize:
    raise SystemExit('WASM_POSIX_LOCAL_BUILD_JOBS must be an exact positive integer')
print(jobs)
PY
}

# Package-local selection; keep unrelated package cache inputs unchanged.
jsoncpp_build_jobs() {
    if [ "${WASM_POSIX_LOCAL_BUILD_JOBS+x}" = x ]; then
        python3 - <<'PY'
import os
import sys
value = os.environ["WASM_POSIX_LOCAL_BUILD_JOBS"]
if not value or any(c < "0" or c > "9" for c in value) or len(value) > 32:
    raise SystemExit("WASM_POSIX_LOCAL_BUILD_JOBS must be an exact positive integer")
jobs = int(value)
if not 0 < jobs <= sys.maxsize:
    raise SystemExit("WASM_POSIX_LOCAL_BUILD_JOBS must be positive and fit usize")
print(jobs)
PY
    else
        sysctl -n hw.ncpu 2>/dev/null || nproc
    fi
}

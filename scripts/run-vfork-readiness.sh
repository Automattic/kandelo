#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/run-vfork-readiness.sh mechanism|integration" >&2
  exit 2
fi

case "$1" in
  mechanism) integration=false ;;
  integration) integration=true ;;
  *) echo "usage: scripts/run-vfork-readiness.sh mechanism|integration" >&2;
     exit 2 ;;
esac
test -n "${IN_NIX_SHELL:-}" || {
  echo "run through scripts/dev-shell.sh" >&2
  exit 2
}

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
if [ "$(pwd -P)" != "$repo_root" ]; then
  echo "run scripts/run-vfork-readiness.sh from the repository root" >&2
  exit 2
fi

bash scripts/test-vfork-readiness-interface.sh

# Keep concurrent worktrees from silently reusing an unrelated Vite server.
# Callers may still pin a reviewed port explicitly (for example in CI).
if [ -z "${KANDELO_PLAYWRIGHT_PORT:-}" ]; then
  repo_checksum="$(printf '%s' "$repo_root" | cksum | awk '{print $1}')"
  KANDELO_PLAYWRIGHT_PORT=$((20000 + (repo_checksum % 20000)))
  export KANDELO_PLAYWRIGHT_PORT
fi

bash scripts/build-programs.sh

(
  cd host
  npm run build
)

host_tests=(
  test/vfork-lifetime.test.ts
  test/vfork-workspace.test.ts
  test/vfork-production-mechanism.test.ts
  test/vfork-mechanism-trace.test.ts
  test/fork-mechanism-trace.test.ts
  test/vfork-side-module-fixture.test.ts
  test/worker-quiescence.test.ts
  test/vfork-lifecycle-guest.test.ts
  test/fork-process-continuation.test.ts
  test/fork-borrowed-replay.test.ts
  test/fork-from-dlopen-side-module-e2e.test.ts
  test/fork-memory-clone-guest.test.ts
  test/process-table-replication.test.ts
  test/dylink-fork-archive.test.ts
)
browser_tests=(
  test/vfork-lifecycle.spec.ts
  test/borrowed-fork-replay.spec.ts
)

if $integration; then
  host_tests+=(
    test/prepared-exec-target.test.ts
    test/secure-exec.test.ts
    test/nosuid-exec.test.ts
    test/spawn-credential-order.test.ts
  )
  browser_tests+=(
    test/prepared-exec-target.spec.ts
    test/nosuid-exec.spec.ts
  )
fi

(
  cd host
  KANDELO_REQUIRE_SIDE_MODULE_FORK_E2E=1 npx vitest run "${host_tests[@]}"
)

host_target="$(rustc -vV | sed -n 's/^host: //p')"
if [ -z "$host_target" ]; then
  echo "rustc -vV did not report a host target" >&2
  exit 2
fi
cargo test -p fork-instrument --target "$host_target"

if $integration; then
  cargo test -p kandelo --target "$host_target" \
    credentials -- --nocapture
fi

(
  cd apps/browser-demos
  npx playwright test "${browser_tests[@]}" \
    --project=chromium --project=firefox --project=webkit
)

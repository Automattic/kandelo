#!/usr/bin/env bash

# Classify changed paths that can alter browser process-memory ownership or
# the differential physical-memory sentinel itself. Keep every new long-lived
# browser/kernel-worker owner of WebAssembly.Memory in this list.

process_memory_telemetry_changed_files() {
  local status=0
  grep -E \
    -e '^\.github/actions/setup-nix/' \
    -e '^\.github/workflows/process-memory-retirement-telemetry\.yml$' \
    -e '^\.github/scripts/(process-memory-telemetry-(scope|gate)|test-process-memory-telemetry-control)\.sh$' \
    -e '^apps/browser-demos/public/trap-signal-test\.html$' \
    -e '^apps/browser-demos/process-memory-(linux-accounting|rss-telemetry)\.ts$' \
    -e '^apps/browser-demos/scripts/process-memory-retirement-rss\.ts$' \
    -e '^apps/browser-demos/test/process-memory-(retirement|rss-telemetry)\.spec\.ts$' \
    -e '^apps/browser-demos/vite\.config\.ts$' \
    -e '^host/src/(browser-kernel-host|browser-kernel-protocol|browser-kernel-worker-entry|channel|constants|deferred-worker-handle|host-owned-process-reap|kernel-realm-destroy|kernel-worker|kernel|process-generation-detach|process-memory-creator-gate|process-memory|thread-allocator|thread-exit-coordinator|thread-worker-disposition|worker-adapter-browser|worker-entry-browser|worker-main|worker-protocol|worker-quiescence)\.ts$' \
    -e '^host/src/(dri|framebuffer|webgl)/' \
    -e '^host/src/vfs/memory-fs\.ts$' \
    -e '^host/test/(channel-listener-reclamation|dri-registry|host-owned-process-reap|kernel-host-destroy|process-view-teardown|webgl-submit-queue|worker-quiescence)\.test\.ts$' \
    -e '^host/test/process-generation-detach.*\.test\.ts$' \
    -e '^host/test/process-memory.*\.test\.ts$' \
    -e '^host/test/fixtures/process-memory-reclamation-' \
    -e '^packages/registry/kernel/build-kernel\.sh$' \
    -e '^scripts/(build-musl|dev-shell)\.sh$' \
    -e '^(package|apps/browser-demos/package|host/package)(-lock)?\.json$' \
    || status=$?
  # No matches is a valid out-of-scope result. Syntax, I/O, and other grep
  # failures must propagate so a broken classifier cannot skip the matrix.
  if [[ "$status" -eq 1 ]]; then
    return 0
  fi
  return "$status"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  process_memory_telemetry_changed_files
fi

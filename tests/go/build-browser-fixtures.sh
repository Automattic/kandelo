#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
go_bin="${GO_KANDELO_BIN:-$repo_root/../go-kandelo/bin/go}"
publish_dir="$repo_root/.context/go-browser"

if [[ ! -x "$go_bin" ]]; then
  echo "Go fork binary not found: $go_bin" >&2
  exit 1
fi

mkdir -p "$repo_root/.context"
output_dir="$(mktemp -d "$repo_root/.context/go-browser-build.XXXXXX")"
trap 'rm -rf "$output_dir"' EXIT
REPO_ROOT="$repo_root"
source "$repo_root/scripts/build-programs-abi-stamp.sh"

build_probe() {
  local source_dir="$1"
  local output_name="$2"
  local package="${3:-.}"
  (
    cd "$repo_root/tests/go/$source_dir"
    GO111MODULE=off GOOS=kandelo GOARCH=wasm "$go_bin" build -o "$output_dir/$output_name.wasm" "$package"
  )
  record_built_program_output "$output_dir/$output_name.wasm"
}

build_probe browser-basic basic
build_probe credentials-basic credentials-basic
build_probe user-basic user-basic
(
  cd "$repo_root/tests/go/user-basic"
  GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm CC=wasm32posix-cc \
    "$go_bin" build -o "$output_dir/user-cgo-basic.wasm" .
)
record_built_program_output "$output_dir/user-cgo-basic.wasm"
build_probe second-m second-m
(
  cd "$repo_root/tests/go/second-m"
  GO111MODULE=off GOOS=kandelo GOARCH=wasm "$go_bin" build \
    -ldflags=-kandelothreadslots=1 -o "$output_dir/one-slot-second-m.wasm" .
)
record_built_program_output "$output_dir/one-slot-second-m.wasm"
build_probe clone-handoff clone-handoff
build_probe scheduler scheduler
build_probe scheduler exit-worker ./exit-worker
build_probe scheduler concurrent-clone ./concurrent-clone
build_probe scheduler locked-thread ./locked-thread
build_probe scheduler locked-exit ./locked-exit
(
  cd "$repo_root/tests/go/scheduler/slot-pressure"
  GO111MODULE=off GOOS=kandelo GOARCH=wasm "$go_bin" build \
    -ldflags=-kandelothreadslots=64 -o "$output_dir/slot-pressure.wasm" .
)
record_built_program_output "$output_dir/slot-pressure.wasm"
(
  cd "$repo_root/tests/go/scheduler/slot-pressure"
  GO111MODULE=off GOOS=kandelo GOARCH=wasm "$go_bin" build \
    -ldflags=-kandelothreadslots=1024 -o "$output_dir/slot-pressure-1024.wasm" .
)
record_built_program_output "$output_dir/slot-pressure-1024.wasm"
build_probe scheduler sysmon ./sysmon
build_probe socket-basic socket-basic
build_probe netpoll-basic netpoll-basic
build_probe net-basic net-basic
build_probe http-basic http-basic
(
  cd "$repo_root/tests/go/http-basic"
  GO111MODULE=off GOOS=kandelo GOARCH=wasm CGO_ENABLED=0 \
    GOCACHE="$output_dir/preempt-gocache" "$go_bin" build \
    -gcflags='net/http=-d=maymorestack=runtime.mayMoreStackPreempt' \
    -o "$output_dir/http-preempt.wasm" .
)
record_built_program_output "$output_dir/http-preempt.wasm"
build_probe exec-basic exec-basic
build_probe os-stdlib os-pwd ./pwd
wasm32posix-cc "$repo_root/tests/sortix/os-test/basic/spawn/posix_spawn_file_actions_addfchdir.c" \
  -o "$output_dir/spawn-fchdir.wasm"
record_built_program_output "$output_dir/spawn-fchdir.wasm"

GO111MODULE=off GOOS=kandelo GOARCH=wasm "$go_bin" test -c -o "$output_dir/atomic-test.wasm" internal/runtime/atomic
record_built_program_output "$output_dir/atomic-test.wasm"
GO111MODULE=off GOOS=kandelo GOARCH=wasm "$go_bin" test -c -o "$output_dir/sync-test.wasm" sync
record_built_program_output "$output_dir/sync-test.wasm"
GO111MODULE=off GOOS=kandelo GOARCH=wasm "$go_bin" test -c -o "$output_dir/user-test.wasm" os/user
record_built_program_output "$output_dir/user-test.wasm"
GO111MODULE=off GOOS=kandelo GOARCH=wasm "$go_bin" test -c -o "$output_dir/os-test.wasm" os
record_built_program_output "$output_dir/os-test.wasm"
GO111MODULE=off GOOS=kandelo GOARCH=wasm "$go_bin" test -c -o "$output_dir/os-exec-test.wasm" os/exec
record_built_program_output "$output_dir/os-exec-test.wasm"
GO111MODULE=off GOOS=kandelo GOARCH=wasm "$go_bin" test -c -o "$output_dir/tar-test.wasm" archive/tar
record_built_program_output "$output_dir/tar-test.wasm"
GO111MODULE=off GOOS=kandelo GOARCH=wasm "$go_bin" test -c -o "$output_dir/syscall-test.wasm" syscall
record_built_program_output "$output_dir/syscall-test.wasm"

if [ -n "${GO_KANDELO_XSYS_SOURCE_DIR:-}" ]; then
  if [ ! -f "$GO_KANDELO_XSYS_SOURCE_DIR/go.mod" ]; then
    echo "x/sys source directory not found: $GO_KANDELO_XSYS_SOURCE_DIR" >&2
    exit 1
  fi
  (
    cd "$GO_KANDELO_XSYS_SOURCE_DIR"
    GOWORK=off GOOS=kandelo GOARCH=wasm CGO_ENABLED=0 "$go_bin" test -c \
      -o "$output_dir/xsys-unix-test.wasm" ./unix
  )
  record_built_program_output "$output_dir/xsys-unix-test.wasm"
fi

if [ -n "${GO_KANDELO_DEPENDENCY_WORKFILE:-}" ]; then
  if [ ! -f "$GO_KANDELO_DEPENDENCY_WORKFILE" ]; then
    echo "Go dependency workfile not found: $GO_KANDELO_DEPENDENCY_WORKFILE" >&2
    exit 1
  fi
  for entry in \
    "bbolt go.etcd.io/bbolt" \
    "readline github.com/chzyer/readline" \
    "logrus github.com/sirupsen/logrus" \
    "ct-x509 github.com/google/certificate-transparency-go/x509"; do
    read -r fixture_name package_name <<< "$entry"
    GOWORK="$GO_KANDELO_DEPENDENCY_WORKFILE" GOOS=kandelo GOARCH=wasm CGO_ENABLED=0 \
      "$go_bin" test -c -o "$output_dir/$fixture_name-test.wasm" "$package_name"
    record_built_program_output "$output_dir/$fixture_name-test.wasm"
  done
fi

stamp_built_program_outputs

mkdir -p "$publish_dir"
mv "$output_dir"/*.wasm "$publish_dir/"
printf 'Go browser fixtures built in %s\n' "$publish_dir"

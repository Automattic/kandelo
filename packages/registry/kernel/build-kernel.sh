#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT="$REPO_ROOT/target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"
source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"

cd "$REPO_ROOT"

if ! cargo -V | grep -q 'nightly'; then
    if command -v nix >/dev/null 2>&1; then
        echo "build-kernel: active cargo is not nightly; re-entering scripts/dev-shell.sh" >&2
        exec bash "$REPO_ROOT/scripts/dev-shell.sh" bash "$SCRIPT_DIR/build-kernel.sh"
    fi
    echo "build-kernel: active cargo does not support -Z build-std and nix is unavailable" >&2
    exit 1
fi

cargo build --release -p kandelo -Z build-std=core,alloc

if [ ! -f "$OUT" ]; then
    echo "build-kernel: expected output not found: $OUT" >&2
    exit 1
fi

wasm_require_exports "$OUT" \
    __abi_version \
    kernel_alloc_scratch \
    kernel_blocking_retry_release \
    kernel_blocking_retry_token \
    kernel_commit_process_exit \
    kernel_create_process \
    kernel_create_process_with_stdio \
    kernel_dequeue_signal \
    kernel_exec_commit \
    kernel_exec_target_cancel \
    kernel_exec_target_prepare \
    kernel_exec_target_read \
    kernel_exec_target_size \
    kernel_fork_process \
    kernel_get_cwd \
    kernel_get_dirfd_path \
    kernel_get_fd_path \
    kernel_get_parent_pid \
    kernel_get_process_exit_signal \
    kernel_get_process_state \
    kernel_get_socket_timeout_ms \
    kernel_handle_channel \
    kernel_has_sa_nocldstop \
    kernel_host_adapter_manifest_len \
    kernel_host_adapter_manifest_ptr \
    kernel_ipc_shm_lookup_mapping_for_task \
    kernel_ipc_shm_record_mapping_for_process \
    kernel_ipc_shm_record_mapping_for_task \
    kernel_ipc_shmat_for_process \
    kernel_ipc_shmat_for_task \
    kernel_ipc_shmdt_addr_for_process \
    kernel_ipc_shmdt_addr_for_task \
    kernel_ipc_shmdt_for_process \
    kernel_ipc_shmdt_for_task \
    kernel_is_fd_nonblock \
    kernel_mark_process_signaled \
    kernel_mq_descriptor_msgsize \
    kernel_msqid_ds_bytes \
    kernel_pcm_claim_transport \
    kernel_pcm_clock_update \
    kernel_pcm_reconcile \
    kernel_pcm_transport_len \
    kernel_pcm_transport_ptr \
    kernel_pick_signal_target_tid \
    kernel_pick_tcp_listener_target \
    kernel_pipe_has_readers \
    kernel_posix_timer_fire \
    kernel_process_metadata_begin \
    kernel_process_metadata_cancel \
    kernel_process_metadata_commit \
    kernel_process_metadata_stage \
    kernel_reap_exited_child \
    kernel_remove_process \
    kernel_semctl_array_bytes \
    kernel_semid_ds_bytes \
    kernel_set_current_tid \
    kernel_set_cwd \
    kernel_shmid_ds_bytes \
    kernel_spawn_exec_commit \
    kernel_spawn_exec_target_prepare \
    kernel_spawn_process \
    kernel_spawn_reserved_process \
    kernel_spawn_scratch_begin \
    kernel_spawn_scratch_cancel \
    kernel_spawn_scratch_capacity \
    kernel_spawn_scratch_pointer \
    kernel_spawn_scratch_retained_capacity \
    kernel_take_process_timer_cleanup \
    kernel_thread_exit \
    kernel_thread_has_deliverable \
    kernel_transfer_channel_execute \
    kernel_transfer_io_execute \
    kernel_transfer_scratch_begin \
    kernel_transfer_scratch_cancel \
    kernel_transfer_scratch_capacity \
    kernel_transfer_scratch_pointer \
    kernel_validate_task \
    kernel_wait_child_poll

wasm_require_target_aware_exec_authority "$OUT"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    # WHY: a resolver build owns only its sealed output directory. Writing a
    # checkout-wide resolver mirror here would leak an untracked side effect
    # across package transactions and destroy the caller's candidate identity.
    mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
    cp "$OUT" "$WASM_POSIX_DEP_OUT_DIR/kandelo-kernel.wasm"
    echo "build-kernel: installed $WASM_POSIX_DEP_OUT_DIR/kandelo-kernel.wasm"
    exit 0
fi

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary kernel "$OUT" kandelo-kernel.wasm

mkdir -p "$REPO_ROOT/host/wasm"
cp "$OUT" "$REPO_ROOT/host/wasm/kandelo-kernel.wasm"
echo "build-kernel: installed host/wasm/kandelo-kernel.wasm"

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ABI_CUSTOM_SECTION,
  ABI_KERNEL_EXPORT,
  ABI_SYSCALL_NAMES,
  ABI_SYSCALLS,
  ABI_VERSION,
  CHANNEL_STATUS,
  CH_ARG_SIZE,
  CH_ARGS,
  CH_ARGS_COUNT,
  CH_DATA,
  CH_DATA_SIZE,
  CH_ERRNO,
  CH_HEADER_SIZE,
  CH_RETURN,
  CH_SIG_BASE,
  CH_SIG_FLAGS,
  CH_SIG_HANDLER,
  CH_SIG_OLD_MASK,
  CH_SIG_SIGNUM,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  HOST_ADAPTER_MANIFEST_FIELDS,
  HOST_ADAPTER_MANIFEST_MAGIC,
  HOST_ADAPTER_MANIFEST_SIZE,
  HOST_ADAPTER_MANIFEST_VERSION,
  HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS,
  HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES,
  HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS,
  HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
  HOST_ADAPTER_VERSION,
  HOST_ADAPTER_WORKER_FEATURES,
  HOST_INTERCEPTED_SYSCALLS,
  PROCESS_MEMORY_DEFAULT_INITIAL_PAGES,
  PROCESS_MEMORY_DEFAULT_MAX_PAGES,
  PROCESS_MEMORY_DEFAULT_THREAD_SLOTS,
  PROCESS_MEMORY_FALLBACK_BRK_BASE,
  PROCESS_MEMORY_FORK_SAVE_BUFFER_SIZE,
  PROCESS_MEMORY_FORK_SAVE_CONTROL_PREFIX_SIZE,
  PROCESS_MEMORY_LEGACY_MMAP_BASE,
  PROCESS_MEMORY_MAIN_CHANNEL_PRIMARY_PAGE,
  PROCESS_MEMORY_MAIN_CHANNEL_SPILL_PAGE,
  PROCESS_MEMORY_MAIN_FORK_SAVE_PAGE,
  PROCESS_MEMORY_PAGES_PER_THREAD_SLOT,
  PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_CHANNEL_SPILL_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_DECL_EXPORT,
  PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE,
  PROCESS_MEMORY_THREAD_SLOTS_NONE,
  PROCESS_MEMORY_THREAD_SLOTS_USE_HOST_DEFAULT,
  PROCESS_MEMORY_WASM_PAGE_SIZE,
  STRUCT_SIZE_WASM_DIRENT,
  STRUCT_SIZE_WASM_POLL_FD,
  STRUCT_SIZE_WASM_STAT,
  STRUCT_SIZE_WASM_STATFS,
  STRUCT_SIZE_WASM_TIMESPEC,
  SYSCALL_ARGS,
} from "../src/generated/abi";

const snapshot = JSON.parse(
  readFileSync(new URL("../../abi/snapshot.json", import.meta.url), "utf8"),
);

interface NamedNumber {
  name: string;
  number: number;
}

function fieldOffset(name: string): number {
  const field = snapshot.channel_header.fields.find((f: { name: string }) => f.name === name);
  if (!field) throw new Error(`missing channel_header field ${name}`);
  return field.offset;
}

function statusNumber(name: string): number {
  const status = snapshot.channel_status_codes.find((s: { name: string }) => s.name === name);
  if (!status) throw new Error(`missing channel_status_codes entry ${name}`);
  return status.number;
}

function signalOffset(name: string): number {
  const slot = snapshot.channel_signal_area.slots.find((s: { name: string }) => s.name === name);
  if (!slot) throw new Error(`missing channel_signal_area slot ${name}`);
  return slot.offset;
}

function namedNumberMap(entries: NamedNumber[]): Record<string, number> {
  return Object.fromEntries(entries.map(({ name, number }) => [name, number]));
}

function hostAdapterManifestField(name: string): { offset: number; size: number } {
  const field = snapshot.host_adapter.manifest_fields.find((f: { name: string }) => f.name === name);
  if (!field) throw new Error(`missing host_adapter manifest field ${name}`);
  return { offset: field.offset, size: field.size };
}

describe("generated host ABI bindings", () => {
  it("match the ABI version and channel layout snapshot", () => {
    expect(ABI_VERSION).toBe(snapshot.abi_version);
    expect(snapshot.custom_sections).toContain(ABI_CUSTOM_SECTION);
    expect(snapshot.kernel_exports.some((e: { name: string }) => e.name === ABI_KERNEL_EXPORT)).toBe(true);

    expect(CH_STATUS).toBe(fieldOffset("status"));
    expect(CH_SYSCALL).toBe(fieldOffset("syscall"));
    expect(CH_ARGS).toBe(fieldOffset("args"));
    expect(CH_RETURN).toBe(fieldOffset("ret"));
    expect(CH_ERRNO).toBe(fieldOffset("errno"));

    expect(CH_ARG_SIZE).toBe(8);
    expect(CH_ARGS_COUNT).toBe(6);
    expect(CH_HEADER_SIZE).toBe(snapshot.channel_header.size);
    expect(CH_DATA).toBe(snapshot.channel_buffers.data_offset);
    expect(CH_DATA_SIZE).toBe(snapshot.channel_buffers.data_size);
    expect(CH_TOTAL_SIZE).toBe(snapshot.channel_buffers.min_channel_size);
  });

  it("match status and signal delivery metadata", () => {
    expect(CHANNEL_STATUS.Idle).toBe(statusNumber("Idle"));
    expect(CHANNEL_STATUS.Pending).toBe(statusNumber("Pending"));
    expect(CHANNEL_STATUS.Complete).toBe(statusNumber("Complete"));
    expect(CHANNEL_STATUS.Error).toBe(statusNumber("Error"));

    expect(CH_SIG_BASE).toBe(snapshot.channel_signal_area.base);
    expect(CH_SIG_SIGNUM).toBe(signalOffset("SIG_SIGNUM"));
    expect(CH_SIG_HANDLER).toBe(signalOffset("SIG_HANDLER"));
    expect(CH_SIG_FLAGS).toBe(signalOffset("SIG_FLAGS"));
    expect(CH_SIG_OLD_MASK).toBe(signalOffset("SIG_OLD_MASK"));
  });

  it("match Rust-owned syscall and struct metadata", () => {
    expect(HOST_INTERCEPTED_SYSCALLS).toEqual(
      namedNumberMap(snapshot.host_intercepted_syscalls),
    );
    expect(ABI_SYSCALLS).toEqual(namedNumberMap(snapshot.syscalls));
    expect(ABI_SYSCALL_NAMES[ABI_SYSCALLS.Seek]).toBe("lseek");
    expect(ABI_SYSCALL_NAMES[ABI_SYSCALLS.Llseek]).toBe("_llseek");
    expect(ABI_SYSCALL_NAMES[ABI_SYSCALLS.Getrandom]).toBe("getrandom");
    expect(ABI_SYSCALL_NAMES[ABI_SYSCALLS.TimerGetoverrun]).toBe("timer_getoverrun");
    expect(ABI_SYSCALL_NAMES[HOST_INTERCEPTED_SYSCALLS.SYS_EXECVE]).toBe("execve");
    expect(ABI_SYSCALL_NAMES[HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN]).toBe("spawn");

    expect(STRUCT_SIZE_WASM_STAT).toBe(snapshot.marshalled_structs.WasmStat.size);
    expect(STRUCT_SIZE_WASM_DIRENT).toBe(snapshot.marshalled_structs.WasmDirent.size);
    expect(STRUCT_SIZE_WASM_TIMESPEC).toBe(snapshot.marshalled_structs.WasmTimespec.size);
    expect(STRUCT_SIZE_WASM_POLL_FD).toBe(snapshot.marshalled_structs.WasmPollFd.size);
    expect(STRUCT_SIZE_WASM_STATFS).toBe(snapshot.marshalled_structs.WasmStatfs.size);

    expect(SYSCALL_ARGS).toEqual(snapshot.syscall_arg_descriptors);
  });

  it("match Rust-owned host adapter manifest metadata", () => {
    expect(HOST_ADAPTER_VERSION).toBe(snapshot.host_adapter.version);
    expect(HOST_ADAPTER_MANIFEST_MAGIC).toBe(snapshot.host_adapter.manifest.magic);
    expect(HOST_ADAPTER_MANIFEST_VERSION).toBe(snapshot.host_adapter.manifest.manifest_version);
    expect(HOST_ADAPTER_MANIFEST_SIZE).toBe(snapshot.host_adapter.manifest.manifest_size);
    expect(HOST_ADAPTER_REQUIRED_WORKER_FEATURES).toBe(
      snapshot.host_adapter.required_worker_features,
    );
    expect(HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES).toBe(
      snapshot.host_adapter.optional_kernel_features,
    );
    expect(HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS).toEqual(
      snapshot.host_adapter.required_kernel_exports,
    );
    expect(HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS).toEqual(
      snapshot.host_adapter.optional_kernel_exports,
    );

    expect(Object.entries(HOST_ADAPTER_WORKER_FEATURES)).toEqual(
      snapshot.host_adapter.worker_features.map((f: { name: string; bit: number }) => [
        f.name,
        f.bit,
      ]),
    );

    for (const fieldName of Object.keys(HOST_ADAPTER_MANIFEST_FIELDS)) {
      expect(
        HOST_ADAPTER_MANIFEST_FIELDS[
          fieldName as keyof typeof HOST_ADAPTER_MANIFEST_FIELDS
        ],
      ).toEqual(hostAdapterManifestField(fieldName));
    }
  });

  it("match Rust-owned process memory layout metadata", () => {
    const layout = snapshot.process_memory_layout;
    expect(PROCESS_MEMORY_WASM_PAGE_SIZE).toBe(layout.wasm_page_size);
    expect(PROCESS_MEMORY_FORK_SAVE_BUFFER_SIZE).toBe(layout.fork_save_buffer_size);
    expect(PROCESS_MEMORY_FORK_SAVE_CONTROL_PREFIX_SIZE)
      .toBe(layout.fork_save_control_prefix_size);
    expect(PROCESS_MEMORY_DEFAULT_INITIAL_PAGES).toBe(layout.defaults.initial_pages);
    expect(PROCESS_MEMORY_DEFAULT_MAX_PAGES).toBe(layout.defaults.max_pages);
    expect(PROCESS_MEMORY_DEFAULT_THREAD_SLOTS).toBe(layout.defaults.thread_slots);
    expect(PROCESS_MEMORY_LEGACY_MMAP_BASE).toBe(layout.legacy.mmap_base);
    expect(PROCESS_MEMORY_FALLBACK_BRK_BASE).toBe(layout.legacy.fallback_brk_base);
    expect(PROCESS_MEMORY_THREAD_SLOT_DECL_EXPORT)
      .toBe(layout.process_wasm_declarations.thread_slot_export);
    expect(PROCESS_MEMORY_THREAD_SLOTS_USE_HOST_DEFAULT)
      .toBe(layout.process_wasm_declarations.use_host_default);
    expect(PROCESS_MEMORY_THREAD_SLOTS_NONE).toBe(layout.process_wasm_declarations.none);

    expect(PROCESS_MEMORY_MAIN_FORK_SAVE_PAGE)
      .toBe(layout.main_control.pages.find((p: { name: string }) => p.name === "fork_save_scratch").page_offset);
    expect(PROCESS_MEMORY_MAIN_CHANNEL_PRIMARY_PAGE)
      .toBe(layout.main_control.pages.find((p: { name: string }) => p.name === "syscall_channel_primary").page_offset);
    expect(PROCESS_MEMORY_MAIN_CHANNEL_SPILL_PAGE)
      .toBe(layout.main_control.pages.find((p: { name: string }) => p.name === "syscall_channel_spill").page_offset);

    expect(PROCESS_MEMORY_PAGES_PER_THREAD_SLOT).toBe(layout.thread_slot.pages_per_slot);
    expect(PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE)
      .toBe(layout.thread_slot.pages.find((p: { name: string }) => p.name === "tls_control").page_offset);
    expect(PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE)
      .toBe(layout.thread_slot.pages.find((p: { name: string }) => p.name === "fork_save_scratch").page_offset);
    expect(PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE)
      .toBe(layout.thread_slot.pages.find((p: { name: string }) => p.name === "syscall_channel_primary").page_offset);
    expect(PROCESS_MEMORY_THREAD_SLOT_CHANNEL_SPILL_PAGE)
      .toBe(layout.thread_slot.pages.find((p: { name: string }) => p.name === "syscall_channel_spill").page_offset);
  });
});

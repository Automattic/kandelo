import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ABI_CUSTOM_SECTION,
  ABI_KERNEL_EXPORT,
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
  HOST_INTERCEPTED_SYSCALLS,
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

    expect(STRUCT_SIZE_WASM_STAT).toBe(snapshot.marshalled_structs.WasmStat.size);
    expect(STRUCT_SIZE_WASM_DIRENT).toBe(snapshot.marshalled_structs.WasmDirent.size);
    expect(STRUCT_SIZE_WASM_TIMESPEC).toBe(snapshot.marshalled_structs.WasmTimespec.size);
    expect(STRUCT_SIZE_WASM_POLL_FD).toBe(snapshot.marshalled_structs.WasmPollFd.size);
    expect(STRUCT_SIZE_WASM_STATFS).toBe(snapshot.marshalled_structs.WasmStatfs.size);

    expect(SYSCALL_ARGS).toEqual(snapshot.syscall_arg_descriptors);
  });
});

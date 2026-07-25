type WasmValueType = "i32" | "i64";

interface WasmFunctionSignature {
  readonly parameters: readonly WasmValueType[];
  readonly result: WasmValueType;
}

function unsignedLeb128(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function wasmString(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [...unsignedLeb128(bytes.length), ...bytes];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...unsignedLeb128(payload.length), ...payload];
}

function signatures(
  pointerWidth: 4 | 8,
): Record<string, WasmFunctionSignature> {
  const pointer: WasmValueType = pointerWidth === 4 ? "i32" : "i64";
  const i32 = "i32" as const;
  const i64 = "i64" as const;
  return {
    kernel_alloc_scratch: {
      parameters: [i32],
      result: pointer,
    },
    kernel_dequeue_signal: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_drain_audio: {
      parameters: [pointer, i32],
      result: i32,
    },
    kernel_drain_wakeup_events: {
      parameters: [pointer, i32, i32],
      result: i32,
    },
    kernel_enum_procs: {
      parameters: [pointer, i32],
      result: i32,
    },
    kernel_get_cwd: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_get_fd_path: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_getrusage: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_getsockopt: {
      parameters: [i32, i32, i32, pointer, i32, pointer, i32],
      result: i32,
    },
    kernel_handle_channel: {
      parameters: [pointer, i32, i32],
      result: i32,
    },
    kernel_inject_datagram: {
      parameters: [
        i32, i32, i32, i32, i32, i32,
        i32, i32, i32, i32, i32,
        pointer, i32,
      ],
      result: i32,
    },
    kernel_ioctl: {
      parameters: [i32, i32, pointer, i32, i32],
      result: i32,
    },
    kernel_ipc_shm_read_chunk: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_ipc_shm_write_chunk: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_mq_drain_notification: {
      parameters: [pointer, i32],
      result: i32,
    },
    kernel_pipe2: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_pipe_read: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_pipe_write: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_poll: {
      parameters: [pointer, i32, i32, i32],
      result: i32,
    },
    kernel_pty_master_read: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_pty_master_write: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_push_process_metadata_entry: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_read_proc_maps: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_recv: {
      parameters: [i32, pointer, i32, i32],
      result: i32,
    },
    kernel_select: {
      parameters: [
        i32,
        pointer, i32,
        pointer, i32,
        pointer, i32,
        i32,
      ],
      result: i32,
    },
    kernel_send: {
      parameters: [i32, pointer, i32, i32],
      result: i32,
    },
    kernel_set_cwd: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_socketpair: {
      parameters: [i32, i32, i32, pointer, i32],
      result: i32,
    },
    kernel_spawn_process: {
      parameters: [i32, i32, pointer, pointer],
      result: i32,
    },
    kernel_tcgetattr: {
      parameters: [i32, pointer, i32],
      result: i32,
    },
    kernel_tcsetattr: {
      parameters: [i32, i32, pointer, i32],
      result: i32,
    },
    kernel_truncate: {
      parameters: [pointer, i32, i64],
      result: i32,
    },
    kernel_uname: {
      parameters: [pointer, i32],
      result: i32,
    },
    kernel_wait_child_poll: {
      parameters: [i32, i32, i32, i32, i32, pointer, i32],
      result: i32,
    },
  };
}

/**
 * Build genuine Wasm exports that forward to mutable JavaScript test doubles.
 *
 * Production scratch regions reject structural `{ exports }` objects. Tests
 * keep that invariant honest by importing their mocks into a real module and
 * re-exporting the resulting native WebAssembly functions. The resolver is
 * intentionally late-bound so a test may replace a mock without mutating the
 * non-extensible genuine exports namespace.
 */
export function createKernelScratchTestInstance(
  pointerWidth: 4 | 8,
  memory: WebAssembly.Memory,
  resolveExports: () => Record<string, unknown>,
  allocator: (capacity: number) => number | bigint,
): WebAssembly.Instance {
  const entries = Object.entries(signatures(pointerWidth));
  const memoryIsShared = typeof SharedArrayBuffer !== "undefined"
    && memory.buffer instanceof SharedArrayBuffer;
  const valueType = (type: WasmValueType): number =>
    type === "i32" ? 0x7f : 0x7e;
  const typePayload: number[] = [
    ...unsignedLeb128(entries.length),
  ];
  const importPayload: number[] = [
    ...unsignedLeb128(entries.length + 1),
    ...wasmString("scratch"),
    ...wasmString("memory"),
    2, // memory import
    ...(memoryIsShared
      // WHY: Wasm import types distinguish shared and unshared memories.
      // Shared memories require an advertised maximum; the broad wasm32
      // ceiling accepts every valid test-memory maximum while preserving the
      // exact shared-state bit that instance identity validation relies on.
      ? [0x03, 0, ...unsignedLeb128(65_536)]
      : [0x00, 0]),
  ];
  const exportPayload: number[] = [
    ...unsignedLeb128(entries.length + 1),
    ...wasmString("memory"),
    2,
    0,
  ];
  const imports: Record<string, (...args: Array<number | bigint>) => number | bigint>
    = {};

  entries.forEach(([name, signature], index) => {
    typePayload.push(
      0x60,
      ...unsignedLeb128(signature.parameters.length),
      ...signature.parameters.map(valueType),
      1,
      valueType(signature.result),
    );
    importPayload.push(
      ...wasmString("scratch"),
      ...wasmString(name),
      0,
      ...unsignedLeb128(index),
    );
    exportPayload.push(
      ...wasmString(name),
      0,
      ...unsignedLeb128(index),
    );
    imports[name] = (...args) => {
      if (name === "kernel_alloc_scratch") {
        return allocator(Number(args[0]));
      }
      const implementation = resolveExports()[name];
      if (typeof implementation !== "function") {
        throw new Error(`missing test implementation for ${name}`);
      }
      const result = Reflect.apply(implementation, undefined, args);
      return signature.result === "i64"
        ? BigInt(result as bigint | number)
        : Number(result);
    };
  });

  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...section(1, typePayload),
    ...section(2, importPayload),
    ...section(7, exportPayload),
  ]);
  const module = new WebAssembly.Module(bytes);
  return new WebAssembly.Instance(module, {
    scratch: {
      ...imports,
      memory,
    },
  });
}

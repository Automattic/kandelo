/** Synchronous capture in the executing process worker, with no trace-ID cache. */
import * as wire from "./generated/program-extensions";
import { checkedWasmGuestPointerOffset, type WasmGuestPointer } from "./wasm-guest-pointer";
import { WasmDebugInfo } from "./wasm-debug-info";

const encoder = new TextEncoder();
const MAX_STACK_CHARACTERS = 64 * 1024;
export interface WasmStackFrame { index: number; pc?: number; name?: string }

export function parseWasmStack(stack: string, maximum: number): { frames: WasmStackFrame[]; truncated: boolean } {
  const frames: WasmStackFrame[] = [];
  let truncated = stack.length > MAX_STACK_CHARACTERS;
  for (const line of stack.slice(0, MAX_STACK_CHARACTERS).split("\n")) {
    // Match the final engine location, never a location-looking substring in
    // an untrusted Wasm function name. WebKit's ordinary stacks omit the PC.
    const match = /(?:^|[:@])wasm-function\[(\d+)\](?::0x([0-9a-fA-F]+))?\)?\s*$/.exec(line);
    if (!match || !(line.trimStart().startsWith("at ") || line.includes("@"))) continue;
    const index = Number(match[1]);
    const pc = match[2] === undefined ? undefined : Number.parseInt(match[2], 16);
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff || (pc !== undefined && !Number.isSafeInteger(pc))) continue;
    if (frames.length === maximum) { truncated = true; break; }
    const name = line.includes("@") ? line.slice(0, line.indexOf("@"))
      : /^\s*at (.*?) \(/.exec(line)?.[1];
    frames.push({ index, pc, name: name?.trim() || undefined });
  }
  return { frames, truncated };
}

export function captureWasmStackText(): string {
  // V8 otherwise captures only ten frames. Other engines do not expose this
  // setting. Restore the previous descriptor even when stack formatting fails.
  const descriptor = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
  const formatter = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  let replacedFormatter = false;
  try {
    if (descriptor?.writable) Object.defineProperty(Error, "stackTraceLimit", { ...descriptor, value: wire.STACK_MAX_FRAMES + 16 });
    // V8 exposes native CallSites here. Tooling formatters can turn Wasm
    // locations into JS line/column text and discard the function index.
    // Request the native representation synchronously, then restore tooling.
    if (typeof (Error as ErrorConstructor & { captureStackTrace?: unknown }).captureStackTrace === "function" && (!formatter || formatter.configurable || formatter.writable)) {
      Object.defineProperty(Error, "prepareStackTrace", {
        configurable: formatter?.configurable ?? true, enumerable: formatter?.enumerable ?? false,
        writable: true, value: (_error: unknown, sites: unknown[]) => sites.map(site => `    at ${String(site)}`).join("\n"),
      });
      replacedFormatter = true;
    }
    return new Error().stack ?? "";
  } finally {
    if (replacedFormatter) {
      if (formatter) Object.defineProperty(Error, "prepareStackTrace", formatter);
      else Reflect.deleteProperty(Error, "prepareStackTrace");
    }
    if (descriptor?.writable) Object.defineProperty(Error, "stackTraceLimit", descriptor);
  }
}

/** All state, metadata, memory access and capture remain in this worker. */
export function createStackCaptureImport(
  memory: WebAssembly.Memory,
  ptrWidth: 4 | 8,
  programBytes: ArrayBuffer | (() => ArrayBuffer),
  singleGuestModule: () => boolean,
  capture: () => string = captureWasmStackText,
): (pointer: WasmGuestPointer, capacity: number, maximumFrames: number) => number {
  let metadata: WasmDebugInfo | undefined;
  return (pointer, capacity, maximumFrames) => {
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > wire.STACK_MAX_PACKET_BYTES || !Number.isInteger(maximumFrames) || maximumFrames < 1 || maximumFrames > wire.STACK_MAX_FRAMES) return wire.STACK_INVALID_ARGUMENT;
    if (capacity < wire.STACK_HEADER_BYTES) return wire.STACK_BUFFER_TOO_SMALL;
    let offset: number;
    try {
      offset = checkedWasmGuestPointerOffset(pointer, ptrWidth, "stack capture");
      if (offset > memory.buffer.byteLength || capacity > memory.buffer.byteLength - offset) return wire.STACK_INVALID_ADDRESS;
    } catch { return wire.STACK_INVALID_ADDRESS; }
    let frames: ReturnType<typeof parseWasmStack>;
    let known: boolean;
    try {
      known = singleGuestModule();
      if (known) metadata ??= new WasmDebugInfo(typeof programBytes === "function" ? programBytes() : programBytes);
      frames = parseWasmStack(capture(), maximumFrames);
    } catch { return wire.STACK_INVALID_ARGUMENT; }

    const packet = new Uint8Array(capacity);
    const view = new DataView(packet.buffer);
    let used = wire.STACK_HEADER_BYTES as number;
    let count = 0;
    let flags = frames.truncated ? wire.STACK_FLAG_TRUNCATED as number : 0;
    if (!known) flags |= wire.STACK_FLAG_MODULE_UNRESOLVED;
    else packet.set(metadata!.sha256, wire.STACK_MODULE_HASH_OFFSET);
    for (const frame of frames.frames) {
      const resolved = known ? metadata!.resolve(frame.index, frame.pc) : undefined;
      if (!resolved) flags |= wire.STACK_FLAG_MODULE_UNRESOLVED;
      const rawName = resolved?.name ?? frame.name;
      const nameBuffer = new Uint8Array(wire.STACK_MAX_NAME_BYTES);
      const name = rawName === undefined ? new Uint8Array() : (() => {
        const encoded = encoder.encodeInto(rawName, nameBuffer);
        if (encoded.read !== rawName.length) flags |= wire.STACK_FLAG_TRUNCATED;
        return nameBuffer.subarray(0, encoded.written);
      })();
      const file = resolved?.location ? encoder.encode(resolved.location.file) : new Uint8Array();
      const length = wire.STACK_FRAME_HEADER_BYTES + name.length + file.length;
      if (length > capacity - used) { flags |= wire.STACK_FLAG_TRUNCATED; break; }
      let frameFlags = resolved ? wire.STACK_FRAME_MODULE_KNOWN as number : 0;
      if (frame.pc !== undefined) frameFlags |= wire.STACK_FRAME_HAS_PC;
      if (name.length) frameFlags |= wire.STACK_FRAME_HAS_NAME;
      if (resolved?.location) frameFlags |= wire.STACK_FRAME_HAS_SOURCE;
      view.setUint32(used, frame.index, true);
      view.setUint32(used + wire.STACK_FRAME_FLAGS_OFFSET, frameFlags, true);
      view.setBigUint64(used + wire.STACK_FRAME_PC_OFFSET, BigInt(frame.pc ?? 0), true);
      view.setUint32(used + wire.STACK_FRAME_LINE_OFFSET, resolved?.location?.line ?? 0, true);
      view.setUint32(used + wire.STACK_FRAME_COLUMN_OFFSET, resolved?.location?.column ?? 0, true);
      view.setUint32(used + wire.STACK_FRAME_NAME_LENGTH_OFFSET, name.length, true);
      view.setUint32(used + wire.STACK_FRAME_FILE_LENGTH_OFFSET, file.length, true);
      packet.set(name, used + wire.STACK_FRAME_HEADER_BYTES);
      packet.set(file, used + wire.STACK_FRAME_HEADER_BYTES + name.length);
      used += length;
      count++;
    }
    view.setUint32(0, wire.STACK_MAGIC, true);
    view.setUint16(wire.STACK_VERSION_OFFSET, wire.STACK_VERSION, true);
    view.setUint16(wire.STACK_FLAGS_OFFSET, flags, true);
    view.setUint32(wire.STACK_COUNT_OFFSET, count, true);
    view.setUint32(wire.STACK_LENGTH_OFFSET, used, true);
    // Re-read after synchronous formatting: a host callback can grow memory.
    // No view of guest storage is retained, transferred or used across await.
    new Uint8Array(memory.buffer, offset, used).set(packet.subarray(0, used));
    return used;
  };
}

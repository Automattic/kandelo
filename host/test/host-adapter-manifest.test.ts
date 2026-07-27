import { describe, expect, it, vi } from "vitest";
import {
  ABI_VERSION,
  CH_DATA,
  CH_DATA_SIZE,
  CH_HEADER_SIZE,
  CH_TOTAL_SIZE,
  HOST_ADAPTER_MANIFEST_FIELDS,
  HOST_ADAPTER_MANIFEST_MAGIC,
  HOST_ADAPTER_MANIFEST_SIZE,
  HOST_ADAPTER_MANIFEST_VERSION,
  HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES,
  HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS,
  HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
  HOST_ADAPTER_VERSION,
  HOST_ADAPTER_WORKER_FEATURES,
} from "../src/generated/abi";
import {
  readKernelHostAdapterManifest,
  validateKernelHostAdapterManifest,
  type HostAdapterManifest,
} from "../src/host-adapter-manifest";
import {
  createKernelEntryGatedInstance,
  createKernelEntryScopedInstance,
  KernelEntryGate,
  readValidatedKernelHostAdapterManifestScalar,
} from "../src/kernel-entry-gate";

const MANIFEST_OFFSET = 64;

describe("host adapter manifest validation", () => {
  it("reads and validates a current Rust-owned manifest", () => {
    const memory = createMemory();
    writeManifest(memory);
    const instance = createKernelEntryGatedInstance(
      createInstance(memory),
      new KernelEntryGate(),
    );

    const manifest = validateKernelHostAdapterManifest(
      instance,
      memory,
      HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
    );

    expect(manifest).toEqual({
      magic: HOST_ADAPTER_MANIFEST_MAGIC,
      manifestVersion: HOST_ADAPTER_MANIFEST_VERSION,
      manifestSize: HOST_ADAPTER_MANIFEST_SIZE,
      abiVersion: ABI_VERSION,
      requiredHostAdapterVersion: HOST_ADAPTER_VERSION,
      requiredWorkerFeatures: HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
      optionalKernelFeatures: HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES,
      channelHeaderSize: CH_HEADER_SIZE,
      channelDataOffset: CH_DATA,
      channelDataSize: CH_DATA_SIZE,
      channelMinSize: CH_TOTAL_SIZE,
    });
  });

  it("reads the manifest through one active initialization scope only", () => {
    const memory = createMemory();
    writeManifest(memory);
    const gate = new KernelEntryGate();
    const owner = createKernelEntryGatedInstance(
      createInstance(memory),
      gate,
    );
    let scoped!: WebAssembly.Instance;
    let manifest!: HostAdapterManifest;

    gate.runOrDeferVoidIngress("manifest validation", (scope) => {
      scoped = createKernelEntryScopedInstance(owner, scope);
      manifest = validateKernelHostAdapterManifest(
        scoped,
        memory,
        HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
      );
    });

    expect(manifest.magic).toBe(HOST_ADAPTER_MANIFEST_MAGIC);
    expect(() =>
      readValidatedKernelHostAdapterManifestScalar(
        scoped,
        "kernel_host_adapter_manifest_ptr",
      )
    ).toThrow(/scope (?:is no longer active|.*(?:ended|revoked))|outside.*scope/i);
  });

  it("rejects gated and scoped instance/Memory generation mismatches", () => {
    const ownedMemory = createMemory();
    const foreignMemory = createMemory();
    writeManifest(ownedMemory);
    writeManifest(foreignMemory);
    const pointer = vi.fn(() => MANIFEST_OFFSET);
    const gate = new KernelEntryGate();
    const owner = createKernelEntryGatedInstance(
      createInstance(ownedMemory, {
        kernel_host_adapter_manifest_ptr: pointer,
      }),
      gate,
    );

    expect(() => readKernelHostAdapterManifest(owner, foreignMemory))
      .toThrow(/does not own the supplied WebAssembly\.Memory/);
    expect(pointer).not.toHaveBeenCalled();

    gate.runOrDeferVoidIngress("manifest memory ownership", (scope) => {
      const scoped = createKernelEntryScopedInstance(owner, scope);
      expect(() => readKernelHostAdapterManifest(scoped, foreignMemory))
        .toThrow(/does not own the supplied WebAssembly\.Memory/);
      expect(pointer).not.toHaveBeenCalled();
      expect(readKernelHostAdapterManifest(scoped, ownedMemory).magic)
        .toBe(HOST_ADAPTER_MANIFEST_MAGIC);
    });
    expect(pointer).toHaveBeenCalledOnce();
  });

  it("does not turn manifest inspection into generic export authority", () => {
    const memory = createMemory();
    const instance = createKernelEntryGatedInstance(
      createInstance(memory),
      new KernelEntryGate(),
    );
    const coerce = vi.fn(() => "kernel_host_adapter_manifest_ptr");

    expect(() =>
      readValidatedKernelHostAdapterManifestScalar(
        instance,
        "kernel_alloc_scratch" as never,
      )
    ).toThrow(/not a host-adapter manifest scalar/i);
    expect(() =>
      readValidatedKernelHostAdapterManifestScalar(
        instance,
        { toString: coerce } as never,
      )
    ).toThrow(/not a host-adapter manifest scalar/i);
    expect(coerce).not.toHaveBeenCalled();
  });

  it("rejects missing required kernel exports", () => {
    const memory = createMemory();
    writeManifest(memory);
    const instance = createInstance(
      memory,
      { kernel_alloc_scratch: undefined },
    );

    expect(() =>
      validateKernelHostAdapterManifest(
        instance,
        memory,
        HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
      ),
    ).toThrow(/kernel_alloc_scratch/);
  });

  it.each([
    "kernel_clear_process_metadata",
    "kernel_push_process_metadata_entry",
    "kernel_set_cwd",
  ])("rejects a kernel missing required scratch transfer export %s", (name) => {
    const memory = createMemory();
    writeManifest(memory);
    const instance = createInstance(memory, { [name]: undefined });

    expect(() =>
      validateKernelHostAdapterManifest(
        instance,
        memory,
        HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
      ),
    ).toThrow(name);
  });

  it("rejects unsupported worker feature bits", () => {
    const memory = createMemory();
    writeManifest(memory);
    const instance = createInstance(memory);
    const supportedFeatures =
      HOST_ADAPTER_REQUIRED_WORKER_FEATURES &
      ~HOST_ADAPTER_WORKER_FEATURES.atomics_wait_async;

    expect(() =>
      validateKernelHostAdapterManifest(instance, memory, supportedFeatures),
    ).toThrow(/atomics_wait_async/);
  });

  it("rejects out-of-bounds manifest pointers", () => {
    const memory = createMemory();
    writeManifest(memory);
    const instance = createInstance(memory, {
      kernel_host_adapter_manifest_ptr: () => BigInt(memory.buffer.byteLength),
    });

    expect(() => readKernelHostAdapterManifest(instance, memory)).toThrow(
      /out of bounds/,
    );
  });

  it("rejects structural and proxied generation forgeries before reading exports", () => {
    const memory = createMemory();
    writeManifest(memory);
    const forged = {
      exports: {
        kernel_host_adapter_manifest_ptr: () => MANIFEST_OFFSET,
        kernel_host_adapter_manifest_len: () => HOST_ADAPTER_MANIFEST_SIZE,
      },
    } as unknown as WebAssembly.Instance;

    expect(() => readKernelHostAdapterManifest(forged, memory)).toThrow(
      /WebAssembly\.Instance|receiver|incompatible/i,
    );

    const raw = createInstance(memory);
    expect(() => readKernelHostAdapterManifest(
      new Proxy(raw, {}),
      memory,
    )).toThrow(/WebAssembly\.Instance|receiver|incompatible/i);
    expect(() => readKernelHostAdapterManifest(
      raw,
      new Proxy(memory, {}),
    )).toThrow(/does not own the supplied WebAssembly\.Memory/i);
  });
});

function createMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
}

function createInstance(
  memory: WebAssembly.Memory,
  overrides: Record<string, unknown> = {},
): WebAssembly.Instance {
  const exports: Record<string, () => bigint> = {};
  for (const exportName of HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS) {
    exports[exportName] = () => 0n;
  }
  exports.kernel_host_adapter_manifest_ptr = () => BigInt(MANIFEST_OFFSET);
  exports.kernel_host_adapter_manifest_len = () =>
    BigInt(HOST_ADAPTER_MANIFEST_SIZE);

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete exports[name];
      continue;
    }
    if (typeof value !== "function") {
      throw new TypeError(`test export ${name} must be a function`);
    }
    exports[name] = () => BigInt(Reflect.apply(value, undefined, []));
  }

  const entries = Object.entries(exports);
  const typeSection = [
    1,
    0x60,
    0,
    1,
    0x7e,
  ];
  const importSection = [
    ...unsignedLeb128(entries.length + 1),
    ...wasmString("manifest"),
    ...wasmString("memory"),
    2,
    0x03,
    1,
    1,
  ];
  const exportSection = [
    ...unsignedLeb128(entries.length + 1),
    ...wasmString("memory"),
    2,
    0,
  ];
  const imports: Record<string, () => bigint> = {};
  entries.forEach(([name, implementation], index) => {
    importSection.push(
      ...wasmString("manifest"),
      ...wasmString(name),
      0,
      0,
    );
    exportSection.push(
      ...wasmString(name),
      0,
      ...unsignedLeb128(index),
    );
    imports[name] = implementation;
  });
  const module = new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...wasmSection(1, typeSection),
    ...wasmSection(2, importSection),
    ...wasmSection(7, exportSection),
  ]));
  return new WebAssembly.Instance(module, {
    manifest: {
      ...imports,
      memory,
    },
  });
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

function wasmSection(id: number, payload: number[]): number[] {
  return [id, ...unsignedLeb128(payload.length), ...payload];
}

function writeManifest(
  memory: WebAssembly.Memory,
  overrides: Partial<HostAdapterManifest> = {},
): void {
  const manifest: HostAdapterManifest = {
    magic: HOST_ADAPTER_MANIFEST_MAGIC,
    manifestVersion: HOST_ADAPTER_MANIFEST_VERSION,
    manifestSize: HOST_ADAPTER_MANIFEST_SIZE,
    abiVersion: ABI_VERSION,
    requiredHostAdapterVersion: HOST_ADAPTER_VERSION,
    requiredWorkerFeatures: HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
    optionalKernelFeatures: HOST_ADAPTER_OPTIONAL_KERNEL_FEATURES,
    channelHeaderSize: CH_HEADER_SIZE,
    channelDataOffset: CH_DATA,
    channelDataSize: CH_DATA_SIZE,
    channelMinSize: CH_TOTAL_SIZE,
    ...overrides,
  };

  const view = new DataView(memory.buffer, MANIFEST_OFFSET);
  setU32(view, "magic", manifest.magic);
  setU16(view, "manifestVersion", manifest.manifestVersion);
  setU16(view, "manifestSize", manifest.manifestSize);
  setU32(view, "abiVersion", manifest.abiVersion);
  setU32(
    view,
    "requiredHostAdapterVersion",
    manifest.requiredHostAdapterVersion,
  );
  setU32(view, "requiredWorkerFeatures", manifest.requiredWorkerFeatures);
  setU32(view, "optionalKernelFeatures", manifest.optionalKernelFeatures);
  setU32(view, "channelHeaderSize", manifest.channelHeaderSize);
  setU32(view, "channelDataOffset", manifest.channelDataOffset);
  setU32(view, "channelDataSize", manifest.channelDataSize);
  setU32(view, "channelMinSize", manifest.channelMinSize);
}

function setU16(
  view: DataView,
  field: keyof typeof HOST_ADAPTER_MANIFEST_FIELDS,
  value: number,
): void {
  view.setUint16(HOST_ADAPTER_MANIFEST_FIELDS[field].offset, value, true);
}

function setU32(
  view: DataView,
  field: keyof typeof HOST_ADAPTER_MANIFEST_FIELDS,
  value: number,
): void {
  view.setUint32(HOST_ADAPTER_MANIFEST_FIELDS[field].offset, value, true);
}

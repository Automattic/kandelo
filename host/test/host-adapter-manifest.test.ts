import { describe, expect, it } from "vitest";
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

const MANIFEST_OFFSET = 64;

describe("host adapter manifest validation", () => {
  it("reads and validates a current Rust-owned manifest", () => {
    const memory = createMemory();
    writeManifest(memory);
    const instance = createInstance();

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

  it("rejects missing required kernel exports", () => {
    const memory = createMemory();
    writeManifest(memory);
    const instance = createInstance({ kernel_alloc_scratch: undefined });

    expect(() =>
      validateKernelHostAdapterManifest(
        instance,
        memory,
        HOST_ADAPTER_REQUIRED_WORKER_FEATURES,
      ),
    ).toThrow(/kernel_alloc_scratch/);
  });

  it("rejects unsupported worker feature bits", () => {
    const memory = createMemory();
    writeManifest(memory);
    const instance = createInstance();
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
    const instance = createInstance({
      kernel_host_adapter_manifest_ptr: () => BigInt(memory.buffer.byteLength),
    });

    expect(() => readKernelHostAdapterManifest(instance, memory)).toThrow(
      /out of bounds/,
    );
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
  overrides: Record<string, unknown> = {},
): WebAssembly.Instance {
  const exports: Record<string, unknown> = {};
  for (const exportName of HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS) {
    exports[exportName] = () => 0;
  }
  exports.kernel_host_adapter_manifest_ptr = () => BigInt(MANIFEST_OFFSET);
  exports.kernel_host_adapter_manifest_len = () => HOST_ADAPTER_MANIFEST_SIZE;
  Object.assign(exports, overrides);

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete exports[name];
  }

  return { exports } as unknown as WebAssembly.Instance;
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

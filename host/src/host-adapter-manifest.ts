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
  HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS,
  HOST_ADAPTER_VERSION,
  HOST_ADAPTER_WORKER_FEATURES,
} from "./generated/abi";

export interface HostAdapterManifest {
  magic: number;
  manifestVersion: number;
  manifestSize: number;
  abiVersion: number;
  requiredHostAdapterVersion: number;
  requiredWorkerFeatures: number;
  optionalKernelFeatures: number;
  channelHeaderSize: number;
  channelDataOffset: number;
  channelDataSize: number;
  channelMinSize: number;
}

type ManifestExport = () => number | bigint;

export function detectHostAdapterWorkerFeatures(): number {
  let features = 0;
  if (typeof SharedArrayBuffer === "function") {
    features |= HOST_ADAPTER_WORKER_FEATURES.shared_array_buffer;
  }
  if (typeof Atomics.wait === "function") {
    features |= HOST_ADAPTER_WORKER_FEATURES.atomics_wait;
  }
  const atomicsWithWaitAsync = Atomics as typeof Atomics & {
    waitAsync?: unknown;
  };
  if (typeof atomicsWithWaitAsync.waitAsync === "function") {
    features |= HOST_ADAPTER_WORKER_FEATURES.atomics_wait_async;
  }
  return features;
}

export function readKernelHostAdapterManifest(
  instance: WebAssembly.Instance,
  memory: WebAssembly.Memory,
): HostAdapterManifest {
  const ptrFn = requiredManifestExport(
    instance,
    "kernel_host_adapter_manifest_ptr",
  );
  const lenFn = requiredManifestExport(
    instance,
    "kernel_host_adapter_manifest_len",
  );

  const pointer = wasmPointerToNumber(
    ptrFn(),
    "kernel_host_adapter_manifest_ptr",
  );
  const length = wasmPointerToNumber(
    lenFn(),
    "kernel_host_adapter_manifest_len",
  );
  if (length < HOST_ADAPTER_MANIFEST_SIZE) {
    throw new Error(
      `kernel host adapter manifest is too small: ${length} bytes ` +
        `(expected at least ${HOST_ADAPTER_MANIFEST_SIZE})`,
    );
  }
  if (pointer + HOST_ADAPTER_MANIFEST_SIZE > memory.buffer.byteLength) {
    throw new Error(
      `kernel host adapter manifest is out of bounds: ptr=${pointer} ` +
        `size=${HOST_ADAPTER_MANIFEST_SIZE} memory=${memory.buffer.byteLength}`,
    );
  }

  const view = new DataView(
    memory.buffer,
    pointer,
    HOST_ADAPTER_MANIFEST_SIZE,
  );
  return {
    magic: u32(view, "magic"),
    manifestVersion: u16(view, "manifestVersion"),
    manifestSize: u16(view, "manifestSize"),
    abiVersion: u32(view, "abiVersion"),
    requiredHostAdapterVersion: u32(view, "requiredHostAdapterVersion"),
    requiredWorkerFeatures: u32(view, "requiredWorkerFeatures"),
    optionalKernelFeatures: u32(view, "optionalKernelFeatures"),
    channelHeaderSize: u32(view, "channelHeaderSize"),
    channelDataOffset: u32(view, "channelDataOffset"),
    channelDataSize: u32(view, "channelDataSize"),
    channelMinSize: u32(view, "channelMinSize"),
  };
}

export function validateKernelHostAdapterManifest(
  instance: WebAssembly.Instance,
  memory: WebAssembly.Memory,
  supportedFeatures = detectHostAdapterWorkerFeatures(),
): HostAdapterManifest {
  const manifest = readKernelHostAdapterManifest(instance, memory);

  if (manifest.magic !== HOST_ADAPTER_MANIFEST_MAGIC) {
    throw new Error(
      `kernel host adapter manifest has invalid magic: ${manifest.magic}`,
    );
  }
  if (manifest.manifestVersion !== HOST_ADAPTER_MANIFEST_VERSION) {
    throw new Error(
      `kernel host adapter manifest version ${manifest.manifestVersion} ` +
        `is not supported by host manifest reader ${HOST_ADAPTER_MANIFEST_VERSION}`,
    );
  }
  if (manifest.manifestSize !== HOST_ADAPTER_MANIFEST_SIZE) {
    throw new Error(
      `kernel host adapter manifest size ${manifest.manifestSize} ` +
        `does not match host reader size ${HOST_ADAPTER_MANIFEST_SIZE}`,
    );
  }
  if (manifest.abiVersion !== ABI_VERSION) {
    throw new Error(
      `kernel host adapter manifest ABI version ${manifest.abiVersion} ` +
        `does not match host ABI version ${ABI_VERSION}`,
    );
  }
  if (manifest.requiredHostAdapterVersion > HOST_ADAPTER_VERSION) {
    throw new Error(
      `kernel requires host adapter version ` +
        `${manifest.requiredHostAdapterVersion}, but this host supports ` +
        `${HOST_ADAPTER_VERSION}`,
    );
  }

  const missingFeatures =
    manifest.requiredWorkerFeatures & ~supportedFeatures;
  if (missingFeatures !== 0) {
    throw new Error(
      `kernel requires unsupported worker features: ` +
        formatFeatureMask(missingFeatures),
    );
  }

  assertManifestChannelField(
    "channel header size",
    manifest.channelHeaderSize,
    CH_HEADER_SIZE,
  );
  assertManifestChannelField(
    "channel data offset",
    manifest.channelDataOffset,
    CH_DATA,
  );
  assertManifestChannelField(
    "channel data size",
    manifest.channelDataSize,
    CH_DATA_SIZE,
  );
  assertManifestChannelField(
    "channel minimum size",
    manifest.channelMinSize,
    CH_TOTAL_SIZE,
  );

  for (const exportName of HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS) {
    if (typeof instance.exports[exportName] !== "function") {
      throw new Error(
        `kernel wasm is missing required host adapter export ${exportName}`,
      );
    }
  }

  return manifest;
}

function requiredManifestExport(
  instance: WebAssembly.Instance,
  name: string,
): ManifestExport {
  const value = instance.exports[name];
  if (typeof value !== "function") {
    throw new Error(
      `kernel wasm is missing required host adapter export ${name}`,
    );
  }
  return value as ManifestExport;
}

function wasmPointerToNumber(value: number | bigint, exportName: string): number {
  const numberValue = typeof value === "bigint" ? Number(value) : value;
  if (
    !Number.isSafeInteger(numberValue) ||
    numberValue < 0
  ) {
    throw new Error(
      `${exportName} returned invalid manifest pointer/length ${String(value)}`,
    );
  }
  return numberValue;
}

function u16(
  view: DataView,
  field: keyof typeof HOST_ADAPTER_MANIFEST_FIELDS,
): number {
  return view.getUint16(HOST_ADAPTER_MANIFEST_FIELDS[field].offset, true);
}

function u32(
  view: DataView,
  field: keyof typeof HOST_ADAPTER_MANIFEST_FIELDS,
): number {
  return view.getUint32(HOST_ADAPTER_MANIFEST_FIELDS[field].offset, true);
}

function assertManifestChannelField(
  label: string,
  actual: number,
  expected: number,
): void {
  if (actual !== expected) {
    throw new Error(
      `kernel host adapter manifest ${label} ${actual} ` +
        `does not match generated host ABI value ${expected}`,
    );
  }
}

function formatFeatureMask(mask: number): string {
  const names: string[] = [];
  let knownMask = 0;
  for (const [name, bit] of Object.entries(HOST_ADAPTER_WORKER_FEATURES)) {
    knownMask |= bit;
    if ((mask & bit) !== 0) names.push(name);
  }
  const unknown = mask & ~knownMask;
  if (unknown !== 0) names.push(`unknown(0x${unknown.toString(16)})`);
  return names.length === 0 ? "none" : names.join(", ");
}

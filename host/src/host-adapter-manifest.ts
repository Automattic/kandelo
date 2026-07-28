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
import {
  hasValidatedKernelEntryExport,
  readValidatedKernelHostAdapterManifestScalar,
  type KernelHostAdapterManifestScalarExport,
  validateKernelEntryMemoryOwnership,
} from "./kernel-entry-gate";

// WHY: kernel initialization crosses host hooks before the manifest is read.
// Capture every intrinsic that receives the private kernel Memory, its backing
// buffer, or a view over those bytes before userland can replace globals or
// configurable prototype accessors.
const IntrinsicDataView = DataView;
const IntrinsicNumber = Number;
const IntrinsicTypeError = TypeError;
const intrinsicApply = Reflect.apply;
const intrinsicNumberIsSafeInteger = Number.isSafeInteger;
const intrinsicObjectEntries = Object.entries;
const intrinsicObjectSetPrototypeOf = Object.setPrototypeOf;
const intrinsicArrayPush = Array.prototype.push;
const intrinsicArrayJoin = Array.prototype.join;
const intrinsicMemoryBuffer = Object.getOwnPropertyDescriptor(
  WebAssembly.Memory.prototype,
  "buffer",
)!.get!;
const intrinsicArrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;
const intrinsicSharedArrayBufferByteLength =
  typeof SharedArrayBuffer === "undefined"
    ? null
    : Object.getOwnPropertyDescriptor(
      SharedArrayBuffer.prototype,
      "byteLength",
    )!.get!;
const intrinsicDataViewGetUint16 = DataView.prototype.getUint16;
const intrinsicDataViewGetUint32 = DataView.prototype.getUint32;

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

function wasmMemoryBuffer(memory: WebAssembly.Memory): ArrayBufferLike {
  return intrinsicApply(
    intrinsicMemoryBuffer,
    memory,
    [],
  ) as ArrayBufferLike;
}

function bufferByteLength(buffer: ArrayBufferLike): number {
  try {
    return intrinsicApply(
      intrinsicArrayBufferByteLength,
      buffer,
      [],
    ) as number;
  } catch {
    if (intrinsicSharedArrayBufferByteLength !== null) {
      return intrinsicApply(
        intrinsicSharedArrayBufferByteLength,
        buffer,
        [],
      ) as number;
    }
    throw new IntrinsicTypeError(
      "kernel Memory has no genuine attached buffer",
    );
  }
}

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
  // WHY: a valid pointer in one kernel generation says nothing about a
  // different generation's Memory. Authenticate the pair before reading any
  // bytes so a larger unrelated linear memory cannot satisfy the range check.
  validateKernelEntryMemoryOwnership(instance, memory);
  const pointer = wasmPointerToNumber(
    requiredManifestExportValue(
      instance,
      "kernel_host_adapter_manifest_ptr",
    ),
    "kernel_host_adapter_manifest_ptr",
  );
  const length = wasmPointerToNumber(
    requiredManifestExportValue(
      instance,
      "kernel_host_adapter_manifest_len",
    ),
    "kernel_host_adapter_manifest_len",
  );
  if (length < HOST_ADAPTER_MANIFEST_SIZE) {
    throw new Error(
      `kernel host adapter manifest is too small: ${length} bytes ` +
        `(expected at least ${HOST_ADAPTER_MANIFEST_SIZE})`,
    );
  }
  const buffer = wasmMemoryBuffer(memory);
  const memoryByteLength = bufferByteLength(buffer);
  if (pointer > memoryByteLength - HOST_ADAPTER_MANIFEST_SIZE) {
    throw new Error(
      `kernel host adapter manifest is out of bounds: ptr=${pointer} ` +
        `size=${HOST_ADAPTER_MANIFEST_SIZE} memory=${memoryByteLength}`,
    );
  }

  const view = new IntrinsicDataView(
    buffer,
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

  for (
    let index = 0;
    index < HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS.length;
    index++
  ) {
    const exportName = HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS[index]!;
    if (!hasValidatedKernelEntryExport(instance, exportName)) {
      throw new Error(
        `kernel wasm is missing required host adapter export ${exportName}`,
      );
    }
  }

  return manifest;
}

function requiredManifestExportValue(
  instance: WebAssembly.Instance,
  name: KernelHostAdapterManifestScalarExport,
): number | bigint {
  if (!hasValidatedKernelEntryExport(instance, name)) {
    throw new Error(
      `kernel wasm is missing required host adapter export ${name}`,
    );
  }
  return readValidatedKernelHostAdapterManifestScalar(
    instance,
    name,
  );
}

function wasmPointerToNumber(value: number | bigint, exportName: string): number {
  const numberValue = typeof value === "bigint"
    ? IntrinsicNumber(value)
    : value;
  if (
    !intrinsicNumberIsSafeInteger(numberValue) ||
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
  return intrinsicApply(
    intrinsicDataViewGetUint16,
    view,
    [HOST_ADAPTER_MANIFEST_FIELDS[field].offset, true],
  ) as number;
}

function u32(
  view: DataView,
  field: keyof typeof HOST_ADAPTER_MANIFEST_FIELDS,
): number {
  return intrinsicApply(
    intrinsicDataViewGetUint32,
    view,
    [HOST_ADAPTER_MANIFEST_FIELDS[field].offset, true],
  ) as number;
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
  const names = intrinsicObjectSetPrototypeOf([], null) as string[];
  let knownMask = 0;
  const entries = intrinsicObjectEntries(HOST_ADAPTER_WORKER_FEATURES);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const name = entry[0];
    const bit = entry[1];
    knownMask |= bit;
    if ((mask & bit) !== 0) {
      intrinsicApply(intrinsicArrayPush, names, [name]);
    }
  }
  const unknown = mask & ~knownMask;
  if (unknown !== 0) {
    intrinsicApply(
      intrinsicArrayPush,
      names,
      [`unknown(0x${unknown.toString(16)})`],
    );
  }
  return names.length === 0
    ? "none"
    : intrinsicApply(intrinsicArrayJoin, names, [", "]) as string;
}

import { PACKAGE_MAINTENANCE_WIRE as wire } from "./generated/abi";

const ByteArray = Uint8Array;
const setBytes = Uint8Array.prototype.set;
const apply = Reflect.apply;
const byteLengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!;

const operations = {
  enter: wire.OP_ENTER,
  leave: wire.OP_LEAVE,
  recovery: wire.OP_RECOVERY,
  uploadInventory: wire.OP_UPLOAD_INVENTORY,
  begin: wire.OP_BEGIN,
  resume: wire.OP_RESUME,
  verifyInstalled: wire.OP_VERIFY_INSTALLED,
  prepare: wire.OP_PREPARE,
  stage: wire.OP_STAGE,
  verifyStaged: wire.OP_VERIFY_STAGED,
  commit: wire.OP_COMMIT,
  cancel: wire.OP_CANCEL,
  discard: wire.OP_DISCARD,
  progress: wire.OP_PROGRESS,
  stagingFile: wire.OP_STAGING_FILE,
  restartStagingFile: wire.OP_RESTART_STAGING_FILE,
  compactionNeeded: wire.OP_COMPACTION_NEEDED,
} as const;

export interface PackageMaintenanceRequest {
  action: keyof typeof operations;
  index?: number;
  offset?: number;
  data?: Uint8Array;
}

export interface PackageMaintenanceResponse {
  status: number;
  errorKind: number;
  data: Uint8Array;
}

export class PackageMaintenanceError extends Error {
  constructor(readonly errno: number, readonly kind: number) {
    super(`Package maintenance refused (errno ${errno}, reason ${kind})`);
    this.name = "PackageMaintenanceError";
  }
}

export function copyPackageMaintenanceRequest(request: PackageMaintenanceRequest): PackageMaintenanceRequest {
  const { action, index = 0, offset = 0, data } = request;
  if (!Object.hasOwn(operations, action)) throw new TypeError("Unknown package maintenance action");
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff || !Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("Invalid package maintenance index or offset");
  }
  if (data !== undefined && !(data instanceof ByteArray)) {
    throw new RangeError("Package maintenance accepts at most 64 KiB per message");
  }
  const length = data === undefined ? 0 : apply(byteLengthGetter, data, []) as number;
  if (length > wire.MAX_BUFFER_BYTES) throw new RangeError("Package maintenance accepts at most 64 KiB per message");
  if (action === "enter" && length !== 0) {
    throw new TypeError("The kernel worker supplies the current runtime contract");
  }
  const snapshot = data === undefined ? undefined : new ByteArray(length);
  if (snapshot !== undefined) apply(setBytes, snapshot, [data]);
  return { action, index, offset, data: snapshot };
}

export function packageMaintenanceOpcode(action: PackageMaintenanceRequest["action"]): number {
  return operations[action];
}

export async function performPackageMaintenanceWithCompaction(
  request: PackageMaintenanceRequest,
  invoke: (request: PackageMaintenanceRequest) => PackageMaintenanceResponse,
  compactor: { settle(): Promise<void>; compactForMaintenance(): Promise<void> } | null,
  assertActive: () => void,
): Promise<PackageMaintenanceResponse> {
  const command = copyPackageMaintenanceRequest(request);
  const action = command.action;
  if (action === "prepare" || action === "stage" || action === "commit"
    || action === "discard" || action === "restartStagingFile") {
    await compactor?.settle();
    assertActive();
    const query: PackageMaintenanceRequest = { action: "compactionNeeded", index: packageMaintenanceOpcode(action) };
    const advice = invoke(query);
    if (advice.status < 0) return advice;
    if (advice.status !== 0 && advice.status !== 1) throw new Error("Kernel returned invalid compaction advice");
    if (advice.status === 1) {
      if (compactor === null) throw new Error("Package maintenance requires persistent compaction support");
      await compactor.compactForMaintenance();
      assertActive();
      const after = invoke(query);
      if (after.status < 0) return after;
      if (after.status !== 0) throw new Error("Package maintenance still requires compaction; retry after other mutations finish");
    }
  }
  assertActive();
  return invoke(command);
}

export function checkedPackageMaintenanceResponse(value: unknown): PackageMaintenanceResponse {
  if (!value || typeof value !== "object") throw new TypeError("Invalid package maintenance response");
  const response = value as PackageMaintenanceResponse;
  if (!Number.isSafeInteger(response.status) || !Number.isSafeInteger(response.errorKind)
      || response.status < -0x8000_0000 || response.status > 0x7fff_ffff
      || response.errorKind < 0 || response.errorKind > wire.ERROR_INVALID_STATE
      || !(response.data instanceof Uint8Array) || response.data.byteLength > wire.MAX_BUFFER_BYTES
      || response.data.buffer.byteLength > wire.MAX_BUFFER_BYTES
      || (typeof SharedArrayBuffer !== "undefined" && response.data.buffer instanceof SharedArrayBuffer)) {
    throw new TypeError("Invalid package maintenance response");
  }
  if (response.status < 0) throw new PackageMaintenanceError(-response.status, response.errorKind);
  return response;
}

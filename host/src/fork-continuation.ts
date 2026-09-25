import { WASM_PAGE_SIZE } from "./constants";
import { WPK_FORK_LINKED_FRAME_POINTER_WIDTHS } from "./generated/abi";

// WHAT USED TO BE HERE: `readLinkedFrameFormat`, a host decoder of the
// `kandelo.wpk_fork.linked_frames` descriptor, and the section/version/flag
// constants it checked. The fork module decodes that descriptor at admission
// now (`fm_admit_activation`, lane F stage 1b) -- pointer width, fixed prefix
// and the full format check -- so the host keeps only the anchor word below.

export class ContinuationAllocationError extends Error {
  constructor(
    readonly errno: number,
    readonly requestedSize: number,
    message: string,
  ) {
    super(message);
    this.name = "ContinuationAllocationError";
  }
}

export function writeForkContinuationAnchor(
  memory: WebAssembly.Memory,
  anchorAddr: number,
  ptrWidth: 4 | 8,
  moduleBufferAddr: number,
): void {
  const view = new DataView(memory.buffer);
  if (ptrWidth === 8) view.setBigUint64(anchorAddr, BigInt(moduleBufferAddr), true);
  else view.setUint32(anchorAddr, moduleBufferAddr, true);
}

export function readForkContinuationAnchor(
  memory: WebAssembly.Memory,
  anchorAddr: number,
  ptrWidth: 4 | 8,
): number {
  const view = new DataView(memory.buffer);
  const value = ptrWidth === 8
    ? Number(view.getBigUint64(anchorAddr, true))
    : view.getUint32(anchorAddr, true);
  const pointerFormat = linkedFramePointerFormat(ptrWidth);
  if (!pointerFormat) {
    throw new Error(`unsupported fork continuation pointer width ${ptrWidth}`);
  }
  const root = value - pointerFormat.chunkHeaderSize;
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || !Number.isSafeInteger(root)
    || root <= 0
    || root % WASM_PAGE_SIZE !== 0
    || root + WASM_PAGE_SIZE > memory.buffer.byteLength
  ) {
    throw new Error(`invalid fork continuation anchor ${String(value)}`);
  }
  // WHY: this boundary can prove the outer allocation geometry without
  // executing or compiling the guest module. The child worker later validates
  // the complete linked-frame chain against that module's format descriptor;
  // treating this lightweight check as full chain validation would create a
  // second, incomplete parser in the syscall dispatcher.
  return value;
}

// WHY: descriptor parsing must use the same Rust-generated layout table as
// publication guards; recomputing it here would let a future ABI change pass
// release validation and fail only when the host begins a continuation.
function linkedFramePointerFormat(ptrWidth: number) {
  return WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(({ bytes }) => bytes === ptrWidth);
}


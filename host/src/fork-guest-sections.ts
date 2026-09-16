/**
 * The three facts the host reads out of a fork-instrumented GUEST module.
 *
 * Named for the guest deliberately. An earlier name put it under
 * `fork-module-*`, which is the co-resident Rust module's namespace and a
 * different thing entirely -- and the surface budget noticed before a reader
 * did, filing 165 lines of guest-section reading onto the module-facing
 * surface. "Module" here means the wasm module behind an activation.
 *
 * Each is here because only the host holds what it reads:
 *
 *  - the module's `kandelo.wpk_fork.module_state` custom section, reachable
 *    only through `WebAssembly.Module.customSections`;
 *  - a pointer word in guest memory, which the host is the one with a
 *    `DataView` over;
 *  - the SHA-256 of the module's own bytes, which never enter guest memory.
 *
 * What did NOT come back with them is the 60-line descriptor DECODER the attic
 * had. `worker-main` asked that decoder exactly one question -- does this side
 * module's pointer width match the process? -- and `fork_codec`'s
 * `module_state.rs` already validates the same descriptor field for field when
 * it reads an arena. Two implementations of one format is what this lane
 * removes, so this reads the one byte the question needs and leaves the
 * validation where the arena reader already does it.
 */

import {
  WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE,
  WPK_FORK_MODULE_STATE_FORMAT_MAGIC,
  WPK_FORK_MODULE_STATE_FORMAT_SECTION,
  WPK_FORK_MODULE_STATE_FORMAT_VERSION,
  WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET,
} from "./generated/abi";

const WASM_PAGE_SIZE = 65_536;

/**
 * The pointer width one activation's module-state format declares.
 *
 * Framing is checked -- magic, version, declared size -- because a wrong
 * pointer width read out of the wrong bytes is a number that looks fine.
 */
export function readForkModuleStatePointerWidth(
  module: WebAssembly.Module,
): 4 | 8 {
  const sections = WebAssembly.Module.customSections(
    module,
    WPK_FORK_MODULE_STATE_FORMAT_SECTION,
  );
  if (sections.length !== 1) {
    throw new Error(
      `expected one ${WPK_FORK_MODULE_STATE_FORMAT_SECTION} section, `
        + `found ${sections.length}`,
    );
  }
  const bytes = new Uint8Array(sections[0]!);
  if (bytes.byteLength !== WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE) {
    throw new Error(
      `module-state descriptor has ${bytes.byteLength} bytes, `
        + `expected ${WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE}`,
    );
  }
  if (WPK_FORK_MODULE_STATE_FORMAT_MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error("module-state descriptor has invalid magic");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== WPK_FORK_MODULE_STATE_FORMAT_VERSION) {
    throw new Error(`unsupported module-state descriptor version ${version}`);
  }
  if (view.getUint16(6, true) !== WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE) {
    throw new Error("module-state descriptor declares an invalid size");
  }
  const ptrWidth = view.getUint8(8);
  if (ptrWidth === 4 || ptrWidth === 8) return ptrWidth;
  throw new Error(`unsupported module-state pointer width ${ptrWidth}`);
}

/**
 * The KFMS arena root a module buffer's prefix points at, or 0.
 *
 * This is how a fork CHILD finds the arena its parent sealed: the address is
 * written into the inherited continuation's prefix, which survives the fork
 * because it is in shared memory, and no JavaScript closure does.
 */
export function readForkModuleStateRoot(
  memory: WebAssembly.Memory,
  moduleBufferAddr: number,
  ptrWidth: 4 | 8,
): number {
  if (!Number.isSafeInteger(moduleBufferAddr) || moduleBufferAddr <= 0) {
    throw new Error(`invalid module-state module buffer ${moduleBufferAddr}`);
  }
  const at = moduleBufferAddr
    + WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET * ptrWidth;
  const view = new DataView(memory.buffer);
  const root = ptrWidth === 8
    ? Number(view.getBigUint64(at, true))
    : view.getUint32(at, true);
  if (!Number.isSafeInteger(root)) {
    throw new Error("module-state root-prefix pointer is out of range");
  }
  if (root !== 0 && root % WASM_PAGE_SIZE !== 0) {
    throw new Error("module-state root-prefix pointer is not page-aligned");
  }
  return root;
}

const SHA256_INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight32(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

/**
 * SHA-256 of a module's bytes: the template id that binds an activation to the
 * exact module behind it.
 *
 * SYNCHRONOUS, and hand-rolled for that reason alone. The dylink path computes
 * this while registering a side module, inside a synchronous activation owner,
 * and the browser has no synchronous SHA-256; `crypto.subtle.digest` is a
 * Promise and additionally refuses `SharedArrayBuffer`-backed views, which is
 * what a module staged into guest memory would be.
 *
 * ONE implementation, where the attic had two. The async `crypto.subtle`
 * sibling computed the same 32 bytes by a different route, which is the exact
 * duplication this lane exists to remove -- and the one that can disagree
 * silently, since nothing compared their outputs.
 *
 * NOT a Wasm capability limit, and it should not be read as one: the module
 * could hash these bytes. What stops it is that they would have to be staged
 * through guest memory first, and a side module is far larger than the staging
 * slab. See census 179.
 */
export function computeForkModuleTemplateId(
  bytes: ArrayBuffer | ArrayBufferView,
): Uint8Array {
  const source = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const totalLength = Math.ceil((source.byteLength + 9) / 64) * 64;
  if (!Number.isSafeInteger(totalLength)) {
    throw new RangeError("fork module template is too large to hash safely");
  }

  const state = new Uint32Array(SHA256_INITIAL_STATE);
  const schedule = new Uint32Array(64);
  const block = new Uint8Array(64);
  const blockView = new DataView(block.buffer);
  const bitLength = BigInt(source.byteLength) * 8n;

  for (let offset = 0; offset < totalLength; offset += 64) {
    block.fill(0);
    const sourceEnd = Math.min(offset + 64, source.byteLength);
    if (offset < sourceEnd) block.set(source.subarray(offset, sourceEnd));
    if (source.byteLength >= offset && source.byteLength < offset + 64) {
      block[source.byteLength - offset] = 0x80;
    }
    if (offset + 64 === totalLength) blockView.setBigUint64(56, bitLength, false);

    for (let word = 0; word < 16; word++) {
      schedule[word] = blockView.getUint32(word * 4, false);
    }
    for (let word = 16; word < 64; word++) {
      const x = schedule[word - 15]!;
      const y = schedule[word - 2]!;
      const sigma0 = rotateRight32(x, 7) ^ rotateRight32(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight32(y, 17) ^ rotateRight32(y, 19) ^ (y >>> 10);
      schedule[word] =
        (schedule[word - 16]! + sigma0 + schedule[word - 7]! + sigma1) >>> 0;
    }

    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let round = 0; round < 64; round++) {
      const upper =
        rotateRight32(e, 6) ^ rotateRight32(e, 11) ^ rotateRight32(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 =
        (h + upper + choose + SHA256_ROUND_CONSTANTS[round]! + schedule[round]!) >>> 0;
      const lower =
        rotateRight32(a, 2) ^ rotateRight32(a, 13) ^ rotateRight32(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (lower + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let word = 0; word < state.length; word++) {
    digestView.setUint32(word * 4, state[word]!, false);
  }
  return digest;
}

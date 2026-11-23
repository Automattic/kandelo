import * as G from './generated/program-extensions';

import { MemoryGroupProtocolFault } from './memory-group-protocol';

const Q = G.MEMORY_GROUP_WAIT_HEADER / 4;
const FIRST = G.MEMORY_GROUP_WAIT_NODES;
const STRIDE = G.MEMORY_GROUP_WAIT_NODE_BYTES;
const CAPACITY = (G.MEMORY_GROUP_PAGE_BYTES - FIRST) / STRIDE;

let queueUnlockModule: WebAssembly.Module | undefined;
const queueUnlocks = new WeakMap<WebAssembly.Memory, () => void>();
const physicalStores = new WeakMap<WebAssembly.Memory, (address: number, value: number) => void>();

/** Internal disposable owning kernel/process Worker setup only. This imports the already-owned
 * group backing; it allocates no linear memory and grants no image authority.
 * Weak keys do not keep a retired backing alive through its bound native call.
 */
export function prepareMemoryGroupQueueUnlock(memory: WebAssembly.Memory): void {
  queueUnlock(memory);
}
function queueUnlock(memory: WebAssembly.Memory): () => void {
  const cached = queueUnlocks.get(memory);
  if (cached) return cached;
  const store = prepareMemoryGroupPhysicalStore(memory);
  const unlock = () => { store(G.MEMORY_GROUP_WAIT_HEADER, 0); };
  queueUnlocks.set(memory, unlock);
  return unlock;
}

/** Mechanical foreign-memory store for the disposable owning Worker. The
 * Rust kernel supplies the physical address and retains all ownership policy.
 * Compile this before publishing a resource or acquiring any shared lock. */
export function prepareMemoryGroupPhysicalStore(memory: WebAssembly.Memory): (address: number, value: number) => void {
  const cached = physicalStores.get(memory);
  if (cached) return cached;
  // [RUNTIME-WORKAROUND: JSC-GROUP-MUTEX-STORE-STALL] Suspected JSC boundary:
  // host Atomics.store(lock, 0) stalls under native Wasm contention. Use the
  // same sequentially consistent store in Wasm. Compile/bind before locking.
  // (module (import "env" "memory" (memory 0 65536 shared))
  //   (func (export "store") (param i32 i32)
  //     local.get 0 local.get 1 i32.atomic.store))
  const module = queueUnlockModule ??= new WebAssembly.Module(new Uint8Array([
    0,97,115,109,1,0,0,0,1,6,1,96,2,127,127,0,2,18,1,3,101,110,118,6,
    109,101,109,111,114,121,2,3,0,128,128,4,3,2,1,0,7,9,1,5,115,116,
    111,114,101,0,0,10,12,1,10,0,32,0,32,1,254,23,2,0,11,
  ]));
  const instance = new WebAssembly.Instance(module, { env: { memory } });
  const store = instance.exports.store;
  if (typeof store !== 'function') throw new MemoryGroupProtocolFault('Missing native group queue store');
  const write = (address: number, value: number) => { store(address, value); };
  physicalStores.set(memory, write);
  return write;
}


/** Validate before mutation without allocating while the process-shared lock
 * is held. A repeated node forms a cycle, which the capacity bound rejects.
 * The second traversal stays under the same lock and needs no copied list.
 */
function validateWaitingNodes(words: Int32Array): void {
  let previous = 0, count = 0;
  for (let at = words[Q + 1] >>> 0; at; at = words[at / 4 + 1] >>> 0) {
    if (at < FIRST || at >= G.MEMORY_GROUP_PAGE_BYTES || (at - FIRST) % STRIDE
        || count >= CAPACITY || Atomics.load(words, at / 4) !== G.MEMORY_GROUP_WAIT_WAITING) {
      throw new MemoryGroupProtocolFault('Corrupt memory-group wait queue');
    }
    count++; previous = at;
  }
  const allocated = words[Q + 4] >>> 0;
  if ((words[Q + 2] >>> 0) !== previous || allocated > CAPACITY || allocated < count) {
    throw new MemoryGroupProtocolFault('Corrupt memory-group wait accounting');
  }
}

/** Internal kernel/process-Worker operation. C waiters park on private queue
 * nodes, so notifying the translated payload word directly cannot wake them.
 * Keep this queue's lock across payload/status publication and ordered wake.
 * The callback must be synchronous and use only already-preflighted stores.
 * Native runtime observers park on the physical status word; wake them after
 * unlocking without including them in the guest-visible waiter count.
 * This neither cancels an execution replica nor authorizes storage reuse.
 */
export function publishMemoryGroupNotification(
  memory: WebAssembly.Memory,
  address: number,
  count: number,
  publish: () => void,
): number {
  return publishNotification(memory, address, count, publish, false);
}

/** Kernel ingress must remain available while a participant holds Q. A busy
 * attempt performs no stores or notifications; the owner retains publication. */
export function tryPublishMemoryGroupNotification(
  memory: WebAssembly.Memory,
  address: number,
  count: number,
  publish: () => void,
): number | 'busy' {
  return publishNotification(memory, address, count, publish, true);
}

function publishNotification(memory: WebAssembly.Memory, address: number, count: number,
  publish: () => void, nonblocking: false): number;
function publishNotification(memory: WebAssembly.Memory, address: number, count: number,
  publish: () => void, nonblocking: true): number | 'busy';
function publishNotification(memory: WebAssembly.Memory, address: number, count: number,
  publish: () => void, nonblocking: boolean): number | 'busy' {
  if (!Number.isSafeInteger(address) || address < 0 || address % 4
      || address + 4 > memory.buffer.byteLength
      || !Number.isSafeInteger(count) || count < 0 || count > 0xffffffff) {
    throw new RangeError('Invalid group notification');
  }
  const words = new Int32Array(memory.buffer);
  // [RUNTIME-WORKAROUND: JSC-GROUP-MUTEX-STORE-STALL] Select the prepared call before Q.
  const unlock = queueUnlocks.get(memory);
  if (nonblocking) {
    if (Atomics.compareExchange(words, Q, 0, 1) !== 0) return 'busy';
  } else {
    while (Atomics.compareExchange(words, Q, 0, 1) !== 0) Atomics.wait(words, Q, 1);
  }
  let woken = 0;
  try {
    // Validate the entire linked list before any publication, including nodes
    // which will not be woken. Cycles or stale/free nodes are host faults.
    validateWaitingNodes(words);
    publish();
    let previous = 0;
    for (let at = words[Q + 1] >>> 0; at;) {
      const index = at / 4, next = words[index + 1] >>> 0;
      if (woken < count && (words[index + 2] >>> 0) === address) {
        if (previous) words[previous / 4 + 1] = next; else words[Q + 1] = next;
        if ((words[Q + 2] >>> 0) === at) words[Q + 2] = previous;
        Atomics.store(words, index, G.MEMORY_GROUP_WAIT_NOTIFIED);
        Atomics.notify(words, index, 1);
        // The returning waiter owns node recycling and the allocated count.
        woken++;
      } else previous = at;
      at = next;
    }
  } finally {
    if (unlock) unlock(); else Atomics.store(words, Q, 0);
    Atomics.notify(words, Q, 1);
  }
  Atomics.notify(words, address / 4, count);
  return woken;
}

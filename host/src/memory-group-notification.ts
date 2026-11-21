import * as G from './generated/program-extensions';

import { MemoryGroupProtocolFault } from './memory-group-protocol';

const Q = G.MEMORY_GROUP_WAIT_HEADER / 4;
const FIRST = G.MEMORY_GROUP_WAIT_NODES;
const STRIDE = G.MEMORY_GROUP_WAIT_NODE_BYTES;
const CAPACITY = (G.MEMORY_GROUP_PAGE_BYTES - FIRST) / STRIDE;

let queueUnlockModule: WebAssembly.Module | undefined;
const queueUnlocks = new WeakMap<WebAssembly.Memory, () => void>();
// Independent scalar scratch only; no group view or authority is cached here.
const pinnedPageScratch = new WeakMap<WebAssembly.Memory, Uint32Array>();

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
  // Only this generated metadata word is reachable through the cached closure.
  const unlock = () => { store(G.MEMORY_GROUP_WAIT_HEADER, 0); };
  queueUnlocks.set(memory, unlock);
  return unlock;
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

/** Copied state of this exact replica's actual queue registration. A waiting
 * node may be between publication and native park; observing it grants no
 * execution-stop, notification or storage-retirement authority. */
export function inspectMemoryGroupReplicaWait(memory: WebAssembly.Memory, root: number, replica: number):
  'none' | 'waiting' | 'returning' | 'busy' {
  if (!Number.isSafeInteger(replica) || replica < G.MEMORY_GROUP_PAGE_BYTES
      || replica % G.MEMORY_GROUP_REPLICA_BYTES || replica > memory.buffer.byteLength - G.MEMORY_GROUP_REPLICA_BYTES
      || !Number.isSafeInteger(root) || root < G.MEMORY_GROUP_PAGE_BYTES || root % G.MEMORY_GROUP_PAGE_BYTES
      || root > memory.buffer.byteLength - G.MEMORY_GROUP_ROOT_HEADER_BYTES) {
    throw new MemoryGroupProtocolFault('Invalid replica wait observation');
  }
  const words = new Int32Array(memory.buffer), control = replica / 4;
  if ((words[control + G.MEMORY_GROUP_REPLICA_ROOT / 4] >>> 0) !== root
      || (words[control + G.MEMORY_GROUP_REPLICA_MAGIC_OFFSET / 4] >>> 0) !== G.MEMORY_GROUP_REPLICA_MAGIC) {
    throw new MemoryGroupProtocolFault('Stale replica wait observation');
  }
  // [RUNTIME-WORKAROUND: JSC-GROUP-MUTEX-STORE-STALL] Select the prepared call before Q.
  const unlock = queueUnlocks.get(memory);
  if (Atomics.compareExchange(words, Q, 0, 1) !== 0) return 'busy';
  try {
    validateWaitingNodes(words);
    const at = Atomics.load(words, control + G.MEMORY_GROUP_REPLICA_WAIT_NODE / 4) >>> 0;
    let linked = 0, linkedAt = 0;
    for (let node = words[Q + 1] >>> 0; node; node = words[node / 4 + 1] >>> 0) {
      if ((words[node / 4 + 4] >>> 0) === replica) { linked++; linkedAt = node; }
    }
    if (!at) {
      if (linked) throw new MemoryGroupProtocolFault('Replica lost observed wait ownership');
      return 'none';
    }
    if (at < FIRST || at >= G.MEMORY_GROUP_PAGE_BYTES || (at - FIRST) % STRIDE
        || (words[at / 4 + 3] >>> 0) !== root || (words[at / 4 + 4] >>> 0) !== replica) {
      throw new MemoryGroupProtocolFault('Observed wait belongs to another replica');
    }
    const state = Atomics.load(words, at / 4);
    if (state < G.MEMORY_GROUP_WAIT_WAITING || state > G.MEMORY_GROUP_WAIT_STOPPED
        || (words[Q + 4] >>> 0) === 0
        || (state === G.MEMORY_GROUP_WAIT_WAITING ? linked !== 1 || linkedAt !== at : linked !== 0)) {
      throw new MemoryGroupProtocolFault('Invalid observed replica wait state');
    }
    return state === G.MEMORY_GROUP_WAIT_WAITING ? 'waiting' : 'returning';
  } finally { if (unlock) unlock(); else Atomics.store(words, Q, 0); Atomics.notify(words, Q, 1); }
}

/** Read-only queue retirement proof. An unlinked notified/stopped node still
 * owns storage until its returning native waiter recycles it. Peer images may
 * remain waiting; never drain their nodes to retire this root. */
export function memoryGroupImageWaitsRetired(memory: WebAssembly.Memory, root: number): boolean | 'busy' {
  return memoryGroupWaitsRetired(memory, root, (words, at) => (words[at + 3] >>> 0) === root);
}

/** Collect physical target pins, including nodes already unlinked by notify
 * or stop. A returning waiter alone retires those pins. */
export function memoryGroupPinnedPages(memory: WebAssembly.Memory, root: number): Set<number> | 'busy' {
  // Capture scalar targets under the lock; build the result Set afterwards.
  let targets = pinnedPageScratch.get(memory);
  if (!targets) {
    targets = new Uint32Array(CAPACITY);
    pinnedPageScratch.set(memory, targets);
  }
  let count = 0;
  const status = memoryGroupWaitsRetired(memory, root, (words, at) => {
    const address = words[at + 2] >>> 0;
    if (address % 4 || address > memory.buffer.byteLength - 4) throw new MemoryGroupProtocolFault('Invalid pinned wait target');
    targets[count++] = Math.floor(address / G.MEMORY_GROUP_PAGE_BYTES);
    return false;
  });
  return status === 'busy' ? status : new Set(targets.subarray(0, count));
}

/** A retired thread must leave no node of its own, and no live peer may still
 * be parked on the control/scratch storage that is about to be reused. */
export function memoryGroupReplicaWaitsRetired(memory: WebAssembly.Memory, root: number, replica: number,
  ranges: readonly { start: number; end: number }[]): boolean | 'busy' {
  return memoryGroupWaitsRetired(memory, root, (words, at) => {
    if ((words[at + 3] >>> 0) === root && (words[at + 4] >>> 0) === replica) return true;
    const address = words[at + 2] >>> 0;
    for (let index = 0; index < ranges.length; index++) {
      if (address >= ranges[index].start && address < ranges[index].end) return true;
    }
    return false;
  });
}
function memoryGroupWaitsRetired(memory: WebAssembly.Memory, root: number,
  owns: (words: Int32Array, index: number) => boolean): boolean | 'busy' {
  if (!Number.isSafeInteger(root) || root < G.MEMORY_GROUP_PAGE_BYTES || root % G.MEMORY_GROUP_PAGE_BYTES
      || root > memory.buffer.byteLength - G.MEMORY_GROUP_ROOT_HEADER_BYTES) throw new MemoryGroupProtocolFault('Invalid retiring root');
  const words = new Int32Array(memory.buffer);
  // [RUNTIME-WORKAROUND: JSC-GROUP-MUTEX-STORE-STALL] Select the prepared call before Q.
  const unlock = queueUnlocks.get(memory);
  if (Atomics.compareExchange(words, Q, 0, 1) !== 0) return 'busy';
  try {
    validateWaitingNodes(words);
    let allocated = 0, retired = true;
    for (let at = FIRST; at < G.MEMORY_GROUP_PAGE_BYTES; at += STRIDE) {
      const state = Atomics.load(words, at / 4);
      if (state === G.MEMORY_GROUP_WAIT_FREE) continue;
      if (state < G.MEMORY_GROUP_WAIT_WAITING || state > G.MEMORY_GROUP_WAIT_STOPPED) {
        throw new MemoryGroupProtocolFault('Corrupt retiring wait node');
      }
      allocated++;
      if (owns(words, at / 4)) retired = false;
    }
    if (allocated !== (words[Q + 4] >>> 0)) throw new MemoryGroupProtocolFault('Corrupt retiring wait count');
    return retired;
  } finally { if (unlock) unlock(); else Atomics.store(words, Q, 0); Atomics.notify(words, Q, 1); }
}

/** Exact local replica owner only. A busy queue is a retry, never a reason to
 * block kernel teardown behind a possibly interrupted participant. Stop the
 * source/checkpoint first, then retry its queued wait drain until it succeeds.
 * No result here authorizes recycling a wait node or any physical allocation.
 */
export function tryControlMemoryGroupReplicaWait(
  memory: WebAssembly.Memory, root: number, replica: number,
  operation: 'pause' | 'stop', epoch = 0,
): boolean {
  if (!Number.isSafeInteger(replica) || replica < G.MEMORY_GROUP_PAGE_BYTES
      || replica % G.MEMORY_GROUP_REPLICA_BYTES
      || replica > memory.buffer.byteLength - G.MEMORY_GROUP_REPLICA_BYTES
      || !Number.isSafeInteger(root) || root < G.MEMORY_GROUP_PAGE_BYTES
      || root % G.MEMORY_GROUP_PAGE_BYTES || root > memory.buffer.byteLength - G.MEMORY_GROUP_ROOT_HEADER_BYTES
      || (operation === 'pause' && (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > 0xffffffff))) {
    throw new MemoryGroupProtocolFault('Invalid local replica controls');
  }
  const words = new Int32Array(memory.buffer), index = replica / 4;
  if ((words[index + G.MEMORY_GROUP_REPLICA_ROOT / 4] >>> 0) !== root
      || (words[index + G.MEMORY_GROUP_REPLICA_MAGIC_OFFSET / 4] >>> 0) !== G.MEMORY_GROUP_REPLICA_MAGIC) {
    throw new MemoryGroupProtocolFault('Stale local replica controls');
  }
  if (operation === 'stop') {
    Atomics.store(words, index + G.MEMORY_GROUP_REPLICA_RUN / 4, 0);
    Atomics.notify(words, index + G.MEMORY_GROUP_REPLICA_REQUEST / 4);
    Atomics.notify(words, index + G.MEMORY_GROUP_REPLICA_ACK / 4);
  } else if ((Atomics.load(words, index + G.MEMORY_GROUP_REPLICA_REQUEST / 4) >>> 0) !== epoch) {
    throw new MemoryGroupProtocolFault('Pause no longer owns its requested epoch');
  }
  // [RUNTIME-WORKAROUND: JSC-GROUP-MUTEX-STORE-STALL] Select the prepared call before Q.
  const unlock = queueUnlocks.get(memory);
  if (Atomics.compareExchange(words, Q, 0, 1) !== 0) return false;
  try {
    validateWaitingNodes(words);
    const at = Atomics.load(words, index + G.MEMORY_GROUP_REPLICA_WAIT_NODE / 4) >>> 0;
    let linked = false, replicaLinked = false, predecessor = 0, previous = 0;
    for (let node = words[Q + 1] >>> 0; node; node = words[node / 4 + 1] >>> 0) {
      if (node === at) { linked = true; predecessor = previous; }
      if ((words[node / 4 + 4] >>> 0) === replica) replicaLinked = true;
      previous = node;
    }
    if (!at) {
      if (replicaLinked) {
        throw new MemoryGroupProtocolFault('Replica lost its queued wait ownership');
      }
      return true;
    }
    if (at < FIRST || at >= G.MEMORY_GROUP_PAGE_BYTES || (at - FIRST) % STRIDE
        || (words[at / 4 + 3] >>> 0) !== root || (words[at / 4 + 4] >>> 0) !== replica) {
      throw new MemoryGroupProtocolFault('Wait node names another replica');
    }
    const state = Atomics.load(words, at / 4);
    if ((state === G.MEMORY_GROUP_WAIT_WAITING) !== linked
        || state < G.MEMORY_GROUP_WAIT_WAITING || state > G.MEMORY_GROUP_WAIT_STOPPED
        || (words[Q + 4] >>> 0) === 0) {
      throw new MemoryGroupProtocolFault('Replica wait is no longer owned');
    }
    if (operation === 'pause') {
      if (state === G.MEMORY_GROUP_WAIT_STOPPED) throw new MemoryGroupProtocolFault('Stopped wait cannot acknowledge pause');
      // Keep the target physically pinned and its native timeout/FIFO intact.
      // C checks this request after retiring its node and before source return.
      Atomics.store(words, index + G.MEMORY_GROUP_REPLICA_ACK / 4, epoch);
      Atomics.notify(words, index + G.MEMORY_GROUP_REPLICA_ACK / 4);
    } else {
      if (linked) {
        const previous = predecessor, next = words[at / 4 + 1] >>> 0;
        if (previous) words[previous / 4 + 1] = next; else words[Q + 1] = next;
        if ((words[Q + 2] >>> 0) === at) words[Q + 2] = previous;
      }
      Atomics.store(words, at / 4, G.MEMORY_GROUP_WAIT_STOPPED);
      Atomics.notify(words, at / 4, 1);
    }
    return true;
  } finally { if (unlock) unlock(); else Atomics.store(words, Q, 0); Atomics.notify(words, Q, 1); }
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

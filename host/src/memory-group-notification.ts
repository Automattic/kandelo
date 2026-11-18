import * as G from './generated/program-extensions';

import { MemoryGroupProtocolFault } from './memory-group-protocol';

const Q = G.MEMORY_GROUP_WAIT_HEADER / 4;
const FIRST = G.MEMORY_GROUP_WAIT_NODES;
const STRIDE = G.MEMORY_GROUP_WAIT_NODE_BYTES;
const CAPACITY = (G.MEMORY_GROUP_PAGE_BYTES - FIRST) / STRIDE;

function waitingNodes(words: Int32Array): number[] {
  const nodes: number[] = [], seen = new Set<number>();
  let previous = 0;
  for (let at = words[Q + 1] >>> 0; at; at = words[at / 4 + 1] >>> 0) {
    if (at < FIRST || at >= G.MEMORY_GROUP_PAGE_BYTES || (at - FIRST) % STRIDE
        || seen.has(at) || nodes.length >= CAPACITY
        || Atomics.load(words, at / 4) !== G.MEMORY_GROUP_WAIT_WAITING) {
      throw new MemoryGroupProtocolFault('Corrupt memory-group wait queue');
    }
    seen.add(at); nodes.push(at); previous = at;
  }
  const allocated = words[Q + 4] >>> 0;
  if ((words[Q + 2] >>> 0) !== previous || allocated > CAPACITY || allocated < nodes.length) {
    throw new MemoryGroupProtocolFault('Corrupt memory-group wait accounting');
  }
  return nodes;
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
  if (Atomics.compareExchange(words, Q, 0, 1) !== 0) return false;
  try {
    const nodes = waitingNodes(words), at = Atomics.load(words, index + G.MEMORY_GROUP_REPLICA_WAIT_NODE / 4) >>> 0;
    if (!at) {
      if (nodes.some(node => (words[node / 4 + 4] >>> 0) === replica)) {
        throw new MemoryGroupProtocolFault('Replica lost its queued wait ownership');
      }
      return true;
    }
    if (at < FIRST || at >= G.MEMORY_GROUP_PAGE_BYTES || (at - FIRST) % STRIDE
        || (words[at / 4 + 3] >>> 0) !== root || (words[at / 4 + 4] >>> 0) !== replica) {
      throw new MemoryGroupProtocolFault('Wait node names another replica');
    }
    const state = Atomics.load(words, at / 4), position = nodes.indexOf(at);
    if ((state === G.MEMORY_GROUP_WAIT_WAITING) !== (position >= 0)
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
      if (position >= 0) {
        const previous = nodes[position - 1] ?? 0, next = words[at / 4 + 1] >>> 0;
        if (previous) words[previous / 4 + 1] = next; else words[Q + 1] = next;
        if ((words[Q + 2] >>> 0) === at) words[Q + 2] = previous;
      }
      Atomics.store(words, at / 4, G.MEMORY_GROUP_WAIT_STOPPED);
      Atomics.notify(words, at / 4, 1);
    }
    return true;
  } finally { Atomics.store(words, Q, 0); Atomics.notify(words, Q, 1); }
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
  if (!Number.isSafeInteger(address) || address < 0 || address % 4
      || address + 4 > memory.buffer.byteLength
      || !Number.isSafeInteger(count) || count < 0 || count > 0xffffffff) {
    throw new RangeError('Invalid group notification');
  }
  const words = new Int32Array(memory.buffer);
  while (Atomics.compareExchange(words, Q, 0, 1) !== 0) Atomics.wait(words, Q, 1);
  let woken = 0;
  try {
    // Validate the entire linked list before any publication, including nodes
    // which will not be woken. Cycles or stale/free nodes are host faults.
    const nodes = waitingNodes(words);
    publish();
    let previous = 0;
    for (const at of nodes) {
      const index = at / 4, next = words[index + 1] >>> 0;
      if (woken < count && (words[index + 2] >>> 0) === address) {
        if (previous) words[previous / 4 + 1] = next; else words[Q + 1] = next;
        if ((words[Q + 2] >>> 0) === at) words[Q + 2] = previous;
        Atomics.store(words, index, G.MEMORY_GROUP_WAIT_NOTIFIED);
        Atomics.notify(words, index, 1);
        // The returning waiter owns node recycling and the allocated count.
        woken++;
      } else previous = at;
    }
  } finally {
    Atomics.store(words, Q, 0); Atomics.notify(words, Q, 1);
  }
  Atomics.notify(words, address / 4, count);
  return woken;
}

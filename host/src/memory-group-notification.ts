import * as G from './generated/program-extensions';
import { MEMORY_GROUP_ACCESS_BYTES } from './generated/group-memory-access';
import { MemoryGroupProtocolFault } from './memory-group-protocol';

/** Normal SDK primitives execute against the actual imported group backing.
 * No helper owns pages, group identity, budgets or retirement policy. */
interface SDKMemoryAccess {
  version(): number;
  length(root: number, maximum: number): bigint;
  check(root: number, maximum: number, address: bigint, length: bigint, rights: number): number;
  span(root: number, maximum: number, address: bigint, length: bigint, rights: number): bigint;
  store(address: number, value: number): void;
  notify(address: number, count: number, nonblocking: number): bigint;
  wait_fork_replay(replica: number): number;
}
interface Publication { readonly publish: () => void; failed: boolean; error?: unknown }
interface PreparedAccess {
  readonly native: SDKMemoryAccess;
  readonly translation: Pick<SDKMemoryAccess, 'length' | 'check' | 'span'>;
  publish(address: number, count: number, publish: () => void, nonblocking: boolean): number | 'busy';
}
let accessModule: WebAssembly.Module | undefined;
const accesses = new WeakMap<WebAssembly.Memory, PreparedAccess>();
function prepared(memory: WebAssembly.Memory): PreparedAccess {
  const cached = accesses.get(memory);
  if (cached) return cached;
  const module = accessModule ??= new WebAssembly.Module(MEMORY_GROUP_ACCESS_BYTES);
  let publication: Publication | undefined;
  const instance = new WebAssembly.Instance(module, { env: { memory }, [G.MEMORY_GROUP_HOST_ACCESS_MODULE]: { publish: () => {
    if (!publication) return 1;
    try { publication.publish(); return 0; }
    catch (error) { publication.failed = true; publication.error = error; return 1; }
  } } });
  const native = instance.exports as unknown as SDKMemoryAccess;
  if (['version', 'length', 'check', 'span', 'store', 'notify', 'wait_fork_replay'].some(name => typeof instance.exports[name] !== 'function')
      || native.version() !== G.MEMORY_GROUP_HOST_ACCESS_VERSION) throw new MemoryGroupProtocolFault('Incompatible SDK memory access helper');
  const owner: PreparedAccess = { native, translation: { length: native.length, check: native.check, span: native.span }, publish: (address, count, publish, nonblocking) => {
    if (publication) throw new MemoryGroupProtocolFault('Reentrant group publication');
    const current: Publication = { publish, failed: false };
    publication = current;
    try {
      const result = Number(native.notify(address, count, nonblocking ? 1 : 0));
      if (result === G.MEMORY_GROUP_HOST_ACCESS_PUBLICATION_FAILED) {
        if (current.failed) throw current.error;
        throw new MemoryGroupProtocolFault('Missing bounded publication');
      }
      if (result === G.MEMORY_GROUP_HOST_ACCESS_BUSY) return 'busy';
      if (result === G.MEMORY_GROUP_HOST_ACCESS_BOUNDS) throw new RangeError('Invalid group notification');
      if (result < 0) throw new MemoryGroupProtocolFault('Corrupt memory-group wait queue');
      return result;
    } finally {
      publication = undefined;
    }
  } };
  accesses.set(memory, owner);
  return owner;
}
export function memoryGroupAccess(memory: WebAssembly.Memory): Pick<SDKMemoryAccess, 'length' | 'check' | 'span'> { return prepared(memory).translation; }
/** Bind before entering any process-shared critical section. */
export function prepareMemoryGroupQueueUnlock(memory: WebAssembly.Memory): void { prepared(memory); }
export function prepareMemoryGroupPhysicalStore(memory: WebAssembly.Memory): (address: number, value: number) => void {
  // [RUNTIME-WORKAROUND: JSC-GROUP-MUTEX-STORE-STALL] Preserve the prepared
  // Wasm atomic store for foreign locks; the engine cause remains suspected.
  return prepared(memory).native.store;
}
export function publishMemoryGroupNotification(memory: WebAssembly.Memory, address: number, count: number, publish: () => void): number {
  const result = publishNotification(memory, address, count, publish, false);
  if (result === 'busy') throw new MemoryGroupProtocolFault('Blocking notification refused');
  return result;
}
export function tryPublishMemoryGroupNotification(memory: WebAssembly.Memory, address: number, count: number, publish: () => void): number | 'busy' {
  return publishNotification(memory, address, count, publish, true);
}
function publishNotification(memory: WebAssembly.Memory, address: number, count: number, publish: () => void, nonblocking: boolean): number | 'busy' {
  if (!Number.isSafeInteger(address) || address < 0 || address > 0xffffffff
      || !Number.isSafeInteger(count) || count < 0 || count > 0xffffffff) throw new RangeError('Invalid group notification');
  return prepared(memory).publish(address, count, publish, nonblocking);
}

export function prepareMemoryGroupForkReplay(memory: WebAssembly.Memory): (replica: number) => number {
  return prepared(memory).native.wait_fork_replay;
}

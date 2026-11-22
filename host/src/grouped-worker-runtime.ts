import { prepareMemoryGroupQueueUnlock } from './memory-group-notification';
import * as G from './generated/program-extensions';
import { MemoryGroupImportGuard } from './memory-group-import-guard';
import { MemoryGroupProtocolFault } from './memory-group-protocol';
import { decodeProcessMemoryDescriptor, type GroupReplicaMemoryExpectation, type GroupReplicaMemoryDescriptor } from './process-memory-descriptor';
import { GroupProcessAddressSpace } from './process-address-space';
import { trapProcessWorker } from './fork-worker-import-exceptions';
import type { GroupedWorkerWait32 } from './worker-channel-ipc';
import { wasmModuleImports } from './wasm-module-reflection';

function fail(message: string): never { throw new MemoryGroupProtocolFault(message); }

/** Refuse implicit guest execution before thread patching can remove evidence. */
export function assertDeferredGroupedStart(programBytes: ArrayBuffer): void {
    // Engines do not reflect the start section. Walk validated section lengths
    // so forged/stale metadata cannot run a start before replica binding.
    const bytes = new Uint8Array(programBytes);
    let offset = 8;
    while (offset < bytes.length) {
      const id = bytes[offset++]!; let length = 0, shift = 0, byte: number;
      do {
        if (offset >= bytes.length || shift > 28) return fail('Malformed grouped Wasm section');
        byte = bytes[offset++]!; length += (byte & 127) * 2 ** shift; shift += 7;
      } while (byte & 128);
      if (length > bytes.length - offset) return fail('Malformed grouped Wasm section extent');
      if (id === 8) return fail('Grouped program must defer its start until replica binding');
      offset += length;
    }
 }

/** Worker-local execution binding reconstructed only from the launch owner's
 * authenticated parent transport. This object neither admits tasks nor
 * authorizes published-page reclamation. Ordinary entry messages cannot mint it.
 */
export class GroupedWorkerRuntime {
  readonly source: GroupProcessAddressSpace;
  readonly descriptor: GroupReplicaMemoryDescriptor;
  private backing: WebAssembly.Memory | undefined;
  private readonly guard = new MemoryGroupImportGuard();
  private wait: GroupedWorkerWait32 | undefined;
  private bound = false;
  private validatedModule: WebAssembly.Module | undefined;

  constructor(envelope: unknown, expected: GroupReplicaMemoryExpectation) {
    // Refresh the received memory32 backing before the decoder creates views.
    const memoryField = envelope && typeof envelope === 'object'
      ? Object.getOwnPropertyDescriptor(envelope, 'memory') : undefined;
    if (!memoryField || !Object.hasOwn(memoryField, 'value')) fail('Grouped Worker requires owned memory transport');
    try { Reflect.apply(WebAssembly.Memory.prototype.grow, memoryField.value, [0]); }
    catch { fail('Grouped Worker requires genuine shared memory32 storage'); }
    const backing = memoryField.value as WebAssembly.Memory, task = { ...expected.receipt };
    const decoded = decodeProcessMemoryDescriptor(envelope, { ...expected, assertLive: () => {
      expected.assertLive();
      const control = new DataView(backing.buffer, expected.replica, G.MEMORY_GROUP_REPLICA_BYTES);
      if (Atomics.load(new Int32Array(backing.buffer, expected.replica + G.MEMORY_GROUP_REPLICA_RUN, 1), 0) !== 1
          || control.getBigUint64(G.MEMORY_GROUP_REPLICA_SERIAL, true) !== task.serial
          || control.getBigUint64(G.MEMORY_GROUP_REPLICA_GENERATION, true) !== task.generation
          || control.getUint32(G.MEMORY_GROUP_REPLICA_ROOT, true) !== expected.root) {
        fail('Grouped Worker source is stopped or belongs to a different image');
      }
    } });
    if (!(decoded.source instanceof GroupProcessAddressSpace) || decoded.descriptor.kind === 'linear') {
      fail('Grouped Worker requires an admitted virtual source');
    }
    this.source = decoded.source; this.descriptor = decoded.descriptor; this.backing = decoded.memory;
  }
  get memory(): WebAssembly.Memory {
    if (!this.backing) return fail('Grouped Worker storage is retired');
    return this.backing;
  }
  readonly wait32: GroupedWorkerWait32 = (address, expected, timeout) => {
    if (!this.backing) return trapProcessWorker();
    if (!this.wait) return fail('Grouped Worker wait used before replica binding');
    return this.wait(address, expected, timeout);
  };
  get stopRequested(): boolean {
    if (!this.backing) return true;
    return Atomics.load(new Int32Array(this.backing.buffer,
      this.descriptor.replica + G.MEMORY_GROUP_REPLICA_RUN, 1), 0) === 0;
  }
  validate(module: WebAssembly.Module, programBytes: ArrayBuffer, pid: number, tid: number): void {
    if (this.bound || this.validatedModule || !this.backing) return fail('Grouped Worker module cannot be rebound');
    const d = this.descriptor;
    if (d.receipt.pid !== pid || d.receipt.tid !== tid) return fail('Grouped Worker task identity disagrees with its receipt');
    const sections = WebAssembly.Module.customSections(module, G.MEMORY_GROUP_SECTION);
    if (sections.length !== 1 || sections[0]!.byteLength > 4096) return fail('Missing or oversized grouped artifact declaration');
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sections[0]!)); }
    catch { return fail('Invalid grouped artifact declaration'); }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || metadata.version !== G.MEMORY_GROUP_VERSION || metadata.layout !== G.MEMORY_GROUP_LAYOUT
        || metadata.threadAttach !== 2 || metadata.cooperativeStop !== 3 || metadata.executionBarrier !== 1
        || metadata.orderedWaitQueue !== 2 || metadata.accessProfile !== 'outlined'
        || !Number.isSafeInteger(metadata.initialPages) || (metadata.initialPages as number) < 0
        || (metadata.initialPages as number) > this.source.byteLength / G.MEMORY_GROUP_PAGE_BYTES
        || !Number.isSafeInteger(metadata.maximumPages) || (metadata.maximumPages as number) > 65536
        || (metadata.maximumPages as number) < d.maximumVirtualPages
        || typeof metadata.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sourceSha256)
        || typeof metadata.helpersSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.helpersSha256)) {
      return fail('Incompatible grouped artifact layout or virtual limits');
    }
    const memories = wasmModuleImports(module).filter(entry => entry.kind === 'memory');
    if (memories.length !== 1 || memories[0]!.module !== G.MEMORY_GROUP_MODULE
        || memories[0]!.name !== G.MEMORY_GROUP_IMPORT) return fail('Grouped program must import only its versioned physical memory');
    assertDeferredGroupedStart(programBytes);
    this.validatedModule = module;
  }
  imports(imports: WebAssembly.Imports): WebAssembly.Imports {
    if (!this.validatedModule) return fail('Grouped imports require validated program metadata');
    // This is the final outer guard, after exception normalization/import routing.
    const guarded = this.guard.wrap(imports);
    if (guarded.env) delete (guarded.env as Record<string, unknown>).memory;
    guarded[G.MEMORY_GROUP_MODULE] = { [G.MEMORY_GROUP_IMPORT]: this.memory };
    return guarded;
  }
  bind(instance: WebAssembly.Instance, mode: 0 | 1 | 2): void {
    if (this.bound || !this.validatedModule || !this.backing) return fail('Grouped replica cannot be bound');
    const e = instance.exports, d = this.descriptor;
    const globals = ['__vm_root', '__vm_scratch', '__vm_replica'].map(name => e[name]);
    if (globals.some(value => !(value instanceof WebAssembly.Global) || typeof value.value !== 'number')
        || typeof e.__vm_checkpoint !== 'function' || typeof e.__vm_worker_wait32 !== 'function'
        || typeof e.__vm_initialize !== 'function') return fail('Grouped program lacks its native replica binding exports');
    for (const [index, value] of [d.root, d.scratch, d.replica].entries()) {
      (globals[index] as WebAssembly.Global).value = value;
    }
    const checkpoint = e.__vm_checkpoint as (root: number, replica: number) => void;
    const wait = e.__vm_worker_wait32 as (address: number, expected: number, timeout: bigint, root: number, replica: number) => number;
    this.guard.bindCheckpoint(() => checkpoint(d.root, d.replica));
    this.wait = (address, expected, timeout) => wait(address, expected, timeout, d.root, d.replica);
    // [RUNTIME-WORKAROUND: JSC-GROUP-MUTEX-STORE-STALL] Suspected release
    // latency also affects process-Worker notifications of loader locks. Bind
    // before guest execution, in this already admitted disposable owner realm.
    prepareMemoryGroupQueueUnlock(this.memory);
    this.bound = true;
    (e.__vm_initialize as (mode: number) => void)(mode);
  }
  detach(): void {
    this.guard.detach(); this.wait = undefined; this.validatedModule = undefined;
    this.source.detachHostAccess(); this.backing = undefined;
  }
}

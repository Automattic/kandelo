import { HOST_ADAPTER_VERSION, MEMORY_GROUP_PROTOCOL } from './generated/abi';
import * as G from './generated/program-extensions';
import { GroupedWorkerRuntime } from './grouped-worker-runtime';
import { MemoryGroupProtocolFault, memoryGroupU32 } from './memory-group-protocol';
import { decodeStoppedGroupedWorkerIdentity, type GroupReplicaMemoryExpectation, type ProcessMemoryEnvelope } from './process-memory-descriptor';
import type { MemoryGroupTaskReceipt } from './memory-group-protocol';
import type { CentralizedWorkerInitMessage, CentralizedThreadInitMessage } from './worker-protocol';
import type { WasmModuleCache } from './wasm-module-cache';
import type { WorkerHandle } from './worker-adapter';

const { prepare: PREPARE, ready: READY, launch: LAUNCH, cancel: CANCEL } = MEMORY_GROUP_PROTOCOL.retirement_control.worker_messages;
type Expectation = Omit<GroupReplicaMemoryExpectation, 'assertLive'>;
type Init = CentralizedWorkerInitMessage | CentralizedThreadInitMessage;
export type GroupedWorkerInit = Omit<CentralizedWorkerInitMessage, 'memory'> | Omit<CentralizedThreadInitMessage, 'memory'>;

function fail(message: string): never { throw new MemoryGroupProtocolFault(message); }
function own(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return fail('Worker initialization requires plain owned records');
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.values(fields).some(field => !Object.hasOwn(field, 'value'))
      || (keys && (Object.keys(fields).length !== keys.length || keys.some(key => !Object.hasOwn(fields, key))))) {
    return fail('Unexpected Worker initialization fields or accessors');
  }
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
}
function expectation(value: unknown): Expectation {
  const data = own(value, ['receipt', 'root', 'replica', 'scratch', 'maximumPhysicalPages', 'maximumVirtualPages', 'scratchBytes']);
  const receipt = own(data.receipt, ['group', 'pid', 'tid', 'serial', 'generation']);
  if (!memoryGroupU32(receipt.group as number, receipt.pid as number, receipt.tid as number)
      || !(receipt.group as number) || (receipt.group as number) > 0x7fffffff
      || (receipt.pid as number) <= 1 || (receipt.tid as number) <= 1
      || typeof receipt.serial !== 'bigint' || receipt.serial <= 0n || receipt.serial > 0xffffffffffffffffn
      || typeof receipt.generation !== 'bigint' || receipt.generation < 0n || receipt.generation > 0xffffffffffffffffn
      || !memoryGroupU32(data.root as number, data.replica as number, data.scratch as number,
        data.maximumPhysicalPages as number, data.maximumVirtualPages as number, data.scratchBytes as number)
      || (data.root as number) < G.MEMORY_GROUP_PAGE_BYTES || (data.root as number) % G.MEMORY_GROUP_PAGE_BYTES
      || (data.replica as number) < G.MEMORY_GROUP_PAGE_BYTES || (data.replica as number) % G.MEMORY_GROUP_PAGE_BYTES
      || data.scratch !== (data.replica as number) + G.MEMORY_GROUP_REPLICA_BYTES
      || (data.maximumPhysicalPages as number) < 2 || (data.maximumPhysicalPages as number) > G.MEMORY_GROUP_MAXIMUM_PAGES
      || (data.maximumVirtualPages as number) < 1 || (data.maximumVirtualPages as number) > 65536
      || (data.scratchBytes as number) < G.MEMORY_GROUP_PAGE_BYTES || (data.scratchBytes as number) % G.MEMORY_GROUP_PAGE_BYTES) {
    return fail('Invalid memory-free Worker admission expectation');
  }
  return Object.freeze({ ...data, receipt: Object.freeze(receipt) }) as unknown as Expectation;
}
function ready(expected: Expectation) {
  return { type: READY, receipt: expected.receipt, version: G.MEMORY_GROUP_VERSION, hostAdapter: HOST_ADAPTER_VERSION,
    threadAttach: 2, cooperativeStop: 3, executionBarrier: 1, orderedWaitQueue: 2,
    forkReplay: G.MEMORY_GROUP_FORK_REPLAY_VERSION } as const;
}
/** Start the exact normal Worker entry without exposing any process backing. */
export function createGroupedWorkerPrepare(expected: Expectation): unknown {
  return { type: PREPARE, expected: expectation(expected) };
}
/** The caller keeps ownership of this handle on timeout/failure. Neither a
 * timeout nor readiness authorizes task cancellation, page reuse or reclamation.
 */
export function observeGroupedWorkerReady(worker: WorkerHandle, expected: Expectation): { result: Promise<void>; cancel(reason: Error): void } {
  const wanted = ready(expectation(expected));
  let cancel!: (reason: Error) => void;
  const result = new Promise<void>((resolve, reject) => {
    let settled = false;
    const clean = () => { worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
    const error = (reason: Error) => { if (settled) return; settled = true; clean(); reject(reason); };
    const exit = (code: number) => error(new MemoryGroupProtocolFault(`Grouped Worker exited before readiness (${code})`));
    const message = (value: unknown) => {
      try {
        const data = own(value, Object.keys(wanted)), task = own(data.receipt, Object.keys(wanted.receipt));
        for (const [key, value] of Object.entries(wanted)) {
          if (key !== 'receipt' && data[key] !== value) fail('Incompatible grouped Worker entry');
        }
        for (const [key, value] of Object.entries(wanted.receipt)) {
          if (task[key] !== value) fail('Grouped Worker readiness names another admission');
        }
        if (!settled) { settled = true; clean(); resolve(); }
      } catch (reason) { error(reason instanceof Error ? reason : new Error(String(reason))); }
    };
    cancel = error;
    worker.on('message', message); worker.on('error', error); worker.on('exit', exit);
  });
  return { result, cancel };
}
export async function waitForGroupedWorkerReady(worker: WorkerHandle, expected: Expectation, timeoutMs = 10000): Promise<void> {
  const observation = observeGroupedWorkerReady(worker, expected);
  const timeout = setTimeout(() => observation.cancel(new MemoryGroupProtocolFault('Grouped Worker readiness timed out')), timeoutMs);
  try { await observation.result; } finally { clearTimeout(timeout); }
}
/** Send only after readiness and exact Rust publication have both succeeded. */
export function createGroupedWorkerLaunch(init: GroupedWorkerInit, envelope: ProcessMemoryEnvelope,
    cache?: WasmModuleCache): unknown {
  const data = own(init);
  if (Object.hasOwn(data, 'memory')) return fail('Grouped launch must carry its backing exactly once');
  // The caller's optional module is never a proof about these bytes. Only
  // the kernel Worker's compiler can supply the module in its launch message.
  delete data.programModule;
  delete data.cachedGroupProgram;
  if (data.type === 'centralized_init' && data.programBytes instanceof ArrayBuffer) {
    const compiled = cache?.cachedProgramForOwnedBytes(data.programBytes);
    if (compiled) data.cachedGroupProgram = compiled;
  }
  return { type: LAUNCH, init: data, envelope };
}

/** An actual kernel-selected cancellation of a scalar-only prepared realm. */
export function createGroupedWorkerCancellation(receipt: MemoryGroupTaskReceipt): unknown {
  return { type: CANCEL, receipt: { ...receipt } };
}

type ReceivedInitialization =
  | { init: Init; grouped?: GroupedWorkerRuntime; stopped?: undefined }
  | { init?: undefined; grouped?: undefined; stopped: MemoryGroupTaskReceipt };

/** One-shot authenticated parent transport shared by Node and browser entries.
 * Ordinary callers retain their existing init contract. A grouped launch must
 * first establish a separate memory-free expectation on this same channel.
 */
export async function receiveGroupedWorkerInitialization(
  first: unknown,
  receiveNext: () => Promise<unknown>,
  post: (message: unknown) => void,
): Promise<ReceivedInitialization> {
  const kind = first && typeof first === 'object' ? Object.getOwnPropertyDescriptor(first, 'type') : undefined;
  if (kind?.value !== PREPARE) {
    if (kind?.value === LAUNCH) return fail('Grouped launch arrived without its readiness handshake');
    return { init: first as Init };
  }
  const prepare = own(first, ['type', 'expected']), expected = expectation(prepare.expected);
  // Install the second listener before acknowledging readiness.
  const next = receiveNext(); post(ready(expected));
  const value = await next;
  const type = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'type') : undefined;
  if (type?.value === CANCEL) {
    const cancel = own(value, ['type', 'receipt']), receipt = own(cancel.receipt, Object.keys(expected.receipt));
    if (Object.entries(expected.receipt).some(([key, value]) => receipt[key] !== value)) {
      return fail('Grouped cancellation names another admission');
    }
    // The one launch listener is consumed and no guest storage was received.
    // The ordinary entry wrapper now publishes its actual terminal fence.
    return { stopped: expected.receipt };
  }
  const launch = own(value, ['type', 'init', 'envelope']);
  if (launch.type !== LAUNCH) return fail('Expected one admitted grouped launch');
  const init = own(launch.init);
  if (Object.hasOwn(init, 'memory') || init.pid !== expected.receipt.pid
      || (init.type !== 'centralized_init' && init.type !== 'centralized_thread_init')
      || (init.type === 'centralized_init' ? expected.receipt.tid !== init.pid : init.tid !== expected.receipt.tid)) {
    return fail('Grouped launch disagrees with its prepared Worker identity');
  }
  let grouped: GroupedWorkerRuntime;
  try {
    const program = init.type === 'centralized_init' && init.cachedGroupProgram instanceof WebAssembly.Module
      && init.programBytes instanceof ArrayBuffer ? { bytes: init.programBytes, module: init.cachedGroupProgram } : undefined;
    delete init.cachedGroupProgram;
    grouped = new GroupedWorkerRuntime(launch.envelope, { ...expected, assertLive: () => {} }, program);
  }
  catch (error) {
    // Stop can win after the parent sends launch but before this realm decodes
    // it. Keep every identity/layout check; only a genuine RUN=0 launch may
    // finish without constructing a guest instance or an address space.
    try {
      const stopped = decodeStoppedGroupedWorkerIdentity(launch.envelope, { ...expected, assertLive: () => {} });
      return { stopped };
    } catch { throw error; }
  }
  return { init: { ...init, memory: grouped.memory } as unknown as Init, grouped };
}

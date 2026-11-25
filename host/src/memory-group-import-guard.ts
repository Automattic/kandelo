import { MemoryGroupProtocolFault } from './memory-group-protocol';
import { trapProcessWorker } from './fork-worker-import-exceptions';

interface GuardedCall { target?: Function }

/** Internal process-Worker guard. Bind the admitted instance's native Wasm
 * checkpoint before initialization, outside the exception-normalizing import
 * adapters. A JS-thrown RuntimeError is not an equivalent stop mechanism.
 * This factory neither admits an image nor proves terminal quiescence.
 */
export class MemoryGroupImportGuard {
  private checkpoint: (() => void) | undefined;
  private bound = false;
  private closed = false;
  private readonly calls: GuardedCall[] = [];
  private readonly wrappers = new WeakMap<Function, Function>();

  bindCheckpoint(checkpoint: () => void): void {
    if (this.closed || this.bound || typeof checkpoint !== 'function') {
      throw new MemoryGroupProtocolFault('Group import checkpoint cannot be rebound');
    }
    this.checkpoint = checkpoint; this.bound = true;
  }
  private check(): void {
    if (this.closed) return trapProcessWorker();
    if (!this.checkpoint) throw new MemoryGroupProtocolFault('Group import owner is not live');
    this.checkpoint();
  }
  private wrapFunction(target: Function): Function {
    const existing = this.wrappers.get(target);
    if (existing) return existing;
    const call: GuardedCall = { target }, owner = this;
    function wrapped(this: unknown, ...args: unknown[]): unknown {
      owner.check();
      const target = call.target;
      if (!target) throw new MemoryGroupProtocolFault('Group import callable was retired');
      try { return Reflect.apply(target, this, args); }
      finally {
        // Also check exceptional returns. A stop requested inside a blocking
        // host call must escape guest handlers before they can use old memory.
        owner.check();
      }
    }
    this.calls.push(call); this.wrappers.set(target, wrapped);
    return wrapped;
  }
  wrap(imports: WebAssembly.Imports): WebAssembly.Imports {
    if (this.closed) throw new MemoryGroupProtocolFault('Group import owner is retired');
    const readRecord = (value: object): [string, unknown][] => {
      if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new MemoryGroupProtocolFault('Group import bindings must be plain owned records');
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some(d => !Object.hasOwn(d, 'value'))) {
        throw new MemoryGroupProtocolFault('Group import bindings cannot contain accessors');
      }
      return Object.entries(descriptors).map(([name, descriptor]) => [name, descriptor.value]);
    };
    // Finish structural validation before retaining even the first callback.
    const modules = readRecord(imports).map(([name, module]) => [name, readRecord(module as object)] as const);
    const result = Object.create(null) as WebAssembly.Imports;
    for (const [name, fields] of modules) {
      const module = Object.create(null) as Record<string, any>;
      for (const [field, value] of fields) module[field] = typeof value === 'function' ? this.wrapFunction(value) : value;
      result[name] = module;
    }
    return result;
  }
  detach(): void {
    this.closed = true; this.checkpoint = undefined;
    for (const call of this.calls) call.target = undefined;
    this.calls.length = 0;
    // WeakMap keys cannot keep original import closures/backings alive. Its
    // values capture only the cleared owner/call records after detachment.
  }
}

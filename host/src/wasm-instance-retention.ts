/**
 * Keep process-memory Wasm instances alive for the life of their Worker.
 *
 * [RUNTIME-WORKAROUND: JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN]
 * JavaScriptCore crashes the web content process when one thread grows a
 * shared `WebAssembly.Memory` by at least one page while another thread
 * destroys an instance that imports it, whether the garbage collector frees
 * the instance or its Worker is closed or terminated. A standalone
 * reproduction is in tests/runtime-workarounds/<ID>/. On JavaScriptCore the
 * browser worker entry enables retention, so an instance bound to process
 * memory (the thread's main instance, or a side module after dlclose) is
 * destroyed only with its Worker, which the kernel terminates when no thread
 * of that process can grow the memory any more.
 *
 * Other engines leave retention disabled: their instances are collected as
 * soon as they are unreachable.
 *
 * @internal
 */
const retainedInstances = new Set<WebAssembly.Instance>();
let retaining = false;

/** Retain every later process-memory instance until this Worker ends. */
export function retainWasmInstancesUntilWorkerEnds(): void {
  retaining = true;
}

/** Record one instance that imports process memory. */
export function noteProcessMemoryInstance(instance: WebAssembly.Instance): void {
  if (retaining) retainedInstances.add(instance);
}

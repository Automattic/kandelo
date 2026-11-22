import type { AuditAllowance } from "../support/wasm-memory-write-audit";

// Exact authorities in the maintained guest FFI adapter fixture.
export const nodeNativeSourceMemoryAllowances: readonly AuditAllowance[] = [
  {
    "key": "crates/kandelo-ffi-adapter/tests/execute-fixtures.mjs::run::wasm-instance-authority::WebAssembly.instantiate(await readFile(join(directory,`${name}-callee.wasm`)))",
    "disposition": "non-kernel",
    "why": "This standalone host code-generator fixture allocates its own private test memory, table and globals and loads only its generated adapter/callee modules. It never creates a Kandelo kernel or receives a running kernel memory/export. This is unit evidence, not Node FFI or guest-process acceptance.",
    "authorityOwner": "process-memory"
  },
  {
    "key": "crates/kandelo-ffi-adapter/tests/execute-fixtures.mjs::run::wasm-memory-authority::new WebAssembly.Memory({initial:2,maximum:65536,shared:true})",
    "disposition": "non-kernel",
    "why": "This standalone host code-generator fixture allocates its own private test memory, table and globals and loads only its generated adapter/callee modules. It never creates a Kandelo kernel or receives a running kernel memory/export. This is unit evidence, not Node FFI or guest-process acceptance.",
    "authorityOwner": "process-memory"
  },
  {
    "key": "crates/kandelo-ffi-adapter/tests/execute-fixtures.mjs::run.load::wasm-instance-authority::WebAssembly.instantiate(await readFile(join(directory,file)),{env:{ memory,__indirect_function_table:table,__stack_pointer:stack, __table_base:new WebAssembly.Global({value:'i32',mutable:false},base), kandelo_ffi_dispatch_closure:dispatch, }})",
    "disposition": "non-kernel",
    "why": "This standalone host code-generator fixture allocates its own private test memory, table and globals and loads only its generated adapter/callee modules. It never creates a Kandelo kernel or receives a running kernel memory/export. This is unit evidence, not Node FFI or guest-process acceptance.",
    "authorityOwner": "process-memory"
  }
];

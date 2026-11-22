import type { AuditAllowance } from "../support/wasm-memory-write-audit";

// Exact reviewed sites in preserved native-reference fixtures and the pinned
// guest dependency. These records grant no production kernel authority.
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
  },
  {
    "key": "tests/nodejs/upstream/async-wrap-native-controls.cjs::<module>::dynamic-code-contract::eval(readFileSync(process.argv[2],'utf8'))",
    "disposition": "non-kernel",
    "why": "This preserved standalone native-reference control evaluates or constructs its selected test JavaScript outside any Kandelo machine. Its callers supply reference source/values, never a live kernel Memory, exports or scratch authority. This does not activate the old frontend or qualify the new CLI."
  },
  {
    "key": "tests/nodejs/upstream/constants-native-controls.cjs::<module>::dynamic-code-contract::eval(readFileSync(process.argv[2],'utf8'))",
    "disposition": "non-kernel",
    "why": "This preserved standalone native-reference control evaluates or constructs its selected test JavaScript outside any Kandelo machine. Its callers supply reference source/values, never a live kernel Memory, exports or scratch authority. This does not activate the old frontend or qualify the new CLI."
  },
  {
    "key": "tests/nodejs/upstream/constructor-name-reference-controls.js::<module>::dynamic-code-contract::Function('return function(){}')",
    "disposition": "non-kernel",
    "why": "This preserved standalone native-reference control evaluates or constructs its selected test JavaScript outside any Kandelo machine. Its callers supply reference source/values, never a live kernel Memory, exports or scratch authority. This does not activate the old frontend or qualify the new CLI."
  },
  {
    "key": "tests/nodejs/upstream/decoder-native-controls.cjs::<module>::dynamic-code-contract::eval(code)",
    "disposition": "non-kernel",
    "why": "This preserved standalone native-reference control evaluates or constructs its selected test JavaScript outside any Kandelo machine. Its callers supply reference source/values, never a live kernel Memory, exports or scratch authority. This does not activate the old frontend or qualify the new CLI."
  },
  {
    "key": "tests/nodejs/upstream/icu-native-controls.cjs::<module>::dynamic-code-contract::eval(source)",
    "disposition": "non-kernel",
    "why": "This preserved standalone native-reference control evaluates or constructs its selected test JavaScript outside any Kandelo machine. Its callers supply reference source/values, never a live kernel Memory, exports or scratch authority. This does not activate the old frontend or qualify the new CLI."
  },
  {
    "key": "tests/nodejs/upstream/options-native-controls.cjs::<module>::dynamic-code-contract::eval(readFileSync(process.argv[2],'utf8'))",
    "disposition": "non-kernel",
    "why": "This preserved standalone native-reference control evaluates or constructs its selected test JavaScript outside any Kandelo machine. Its callers supply reference source/values, never a live kernel Memory, exports or scratch authority. This does not activate the old frontend or qualify the new CLI."
  },
  {
    "key": "tests/nodejs/upstream/types-native-controls.cjs::<module>::dynamic-code-contract::eval(code)",
    "disposition": "non-kernel",
    "why": "This preserved standalone native-reference control evaluates or constructs its selected test JavaScript outside any Kandelo machine. Its callers supply reference source/values, never a live kernel Memory, exports or scratch authority. This does not activate the old frontend or qualify the new CLI."
  },
  {
    "key": "tests/nodejs/upstream/types-shared-controls.js::<module>::dynamic-code-contract::Function('return arguments')",
    "disposition": "non-kernel",
    "why": "This preserved standalone native-reference control evaluates or constructs its selected test JavaScript outside any Kandelo machine. Its callers supply reference source/values, never a live kernel Memory, exports or scratch authority. This does not activate the old frontend or qualify the new CLI."
  },
  {
    "key": "third_party/nodejs/upstream/deps/undici/undici.js::lib/dispatcher/client-h1.js.lazyllhttp::wasm-instance-authority::new WebAssembly.Instance(mod, { env: { /** * @param {number} p * @param {number} at * @param {number} len * @returns {number} */ wasm_on_url: /* @__PURE__ */ __name((p, at, len) => { return 0; }, \"wasm_on_url\"), /** * @param {number} p * @param {number} at * @param {number} len * @returns {number} */ wasm_on_status: /* @__PURE__ */ __name((p, at, len) => { assert(currentParser.ptr === p); const start = at - currentBufferPtr + currentBufferRef.byteOffset; return currentParser.onStatus(new FastBuffer(currentBufferRef.buffer, start, len)); }, \"wasm_on_status\"), /** * @param {number} p * @returns {number} */ wasm_on_message_begin: /* @__PURE__ */ __name((p) => { assert(currentParser.ptr === p); return currentParser.onMessageBegin(); }, \"wasm_on_message_begin\"), /** * @param {number} p * @param {number} at * @param {number} len * @returns {number} */ wasm_on_header_field: /* @__PURE__ */ __name((p, at, len) => { assert(currentParser.ptr === p); const start = at - currentBufferPtr + currentBufferRef.byteOffset; return currentParser.onHeaderField(new FastBuffer(currentBufferRef.buffer, start, len)); }, \"wasm_on_header_field\"), /** * @param {number} p * @param {number} at * @param {number} len * @returns {number} */ wasm_on_header_value: /* @__PURE__ */ __name((p, at, len) => { assert(currentParser.ptr === p); const start = at - currentBufferPtr + currentBufferRef.byteOffset; return currentParser.onHeaderValue(new FastBuffer(currentBufferRef.buffer, start, len)); }, \"wasm_on_header_value\"), /** * @param {number} p * @param {number} statusCode * @param {0|1} upgrade * @param {0|1} shouldKeepAlive * @returns {number} */ wasm_on_headers_complete: /* @__PURE__ */ __name((p, statusCode, upgrade, shouldKeepAlive) => { assert(currentParser.ptr === p); return currentParser.onHeadersComplete(statusCode, upgrade === 1, shouldKeepAlive === 1); }, \"wasm_on_headers_complete\"), /** * @param {number} p * @param {number} at * @param {number} len * @returns {number} */ wasm_on_body: /* @__PURE__ */ __name((p, at, len) => { assert(currentParser.ptr === p); const start = at - currentBufferPtr + currentBufferRef.byteOffset; return currentParser.onBody(new FastBuffer(currentBufferRef.buffer, start, len)); }, \"wasm_on_body\"), /** * @param {number} p * @returns {number} */ wasm_on_message_complete: /* @__PURE__ */ __name((p) => { assert(currentParser.ptr === p); return currentParser.onMessageComplete(); }, \"wasm_on_message_complete\") } })",
    "disposition": "non-kernel",
    "why": "The unchanged pinned Undici dependency creates its llhttp parser instance inside the Node JavaScript realm, using parser callback imports and the module's own memory. It receives no Kandelo kernel Memory or kernel export namespace. This ownership review does not provide a guest Wasm backend or establish Fetch acceptance.",
    "authorityOwner": "process-memory"
  }
];

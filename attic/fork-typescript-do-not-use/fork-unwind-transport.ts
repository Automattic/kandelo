/**
 * Private Wasm-EH transport used while serializing a fork continuation.
 *
 * This tag is process-owned and shared by the main instance and every loaded
 * side module in the same Worker. It is not a program exception: instrumented
 * catch-all clauses rethrow it, each activation commits its frame while it
 * propagates, and only the worker entry boundary consumes it.
 */

export {
  WPK_FORK_UNWIND_TAG_IMPORT_MODULE as FORK_UNWIND_TAG_IMPORT_MODULE,
  WPK_FORK_UNWIND_TAG_IMPORT_NAME as FORK_UNWIND_TAG_IMPORT_NAME,
  WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY as FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY,
  WPK_FORK_UNWIND_TRANSPORT_SECTION as FORK_UNWIND_TRANSPORT_SECTION,
  WPK_FORK_UNWIND_TRANSPORT_VERSION as FORK_UNWIND_TRANSPORT_VERSION,
} from "./generated/abi";

export function createForkUnwindTag(): WebAssembly.Tag {
  if (typeof WebAssembly.Tag !== "function") {
    throw new Error("WebAssembly exception tags are required for fork instrumentation");
  }
  return new WebAssembly.Tag({ parameters: [] });
}

export function requireForkUnwindTag(
  tag: unknown,
  context: string,
): WebAssembly.Tag {
  if (typeof WebAssembly.Tag !== "function") {
    throw new Error(`${context}: WebAssembly exception tags are unavailable`);
  }
  if (!(tag instanceof WebAssembly.Tag)) {
    throw new TypeError(`${context}: missing valid process-owned fork unwind tag`);
  }
  return tag;
}

export function isForkUnwindException(
  value: unknown,
  tag: WebAssembly.Tag,
): value is WebAssembly.Exception {
  return (
    typeof WebAssembly.Exception === "function"
    && value instanceof WebAssembly.Exception
    && value.is(tag)
  );
}

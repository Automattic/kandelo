/**
 * The browser's half of `#wasm-artifact-module-source`: deliberately nothing.
 *
 * Node can register a synchronous loader, because its bytes are one file read
 * away. A browser's are not: they arrive over `fetch`, and every read of an
 * artifact is synchronous by construction -- `kernel.ts` needs a pointer width
 * in the middle of building an import object, and `worker-main.ts` needs a
 * verdict before it compiles a program. So a browser realm must install at a
 * point that is already `await`-shaped, which is its worker entry, and there is
 * nothing for a synchronous loader to do here.
 *
 * That asymmetry is the same one `kernel.wasm` itself already has between the
 * two hosts -- read synchronously on one, fetched on the other -- not a
 * Node-first design. The platform-observable behaviour after installation is
 * identical.
 *
 * This file exists so the browser condition resolves to something that imports
 * no `node:` builtins, rather than the driver having to branch at runtime.
 */
export {};

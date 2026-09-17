/**
 * The artifact reader's mutable state, in a module with no imports.
 *
 * # Why this is separate from the driver
 *
 * The driver's `#wasm-artifact-module-source` side-effect import registers a
 * loader on Node, which makes installation a property of resolution rather than
 * a ritual every entry point repeats. But an ES module's imports are evaluated
 * BEFORE its own body, so a registration arriving through that import reached
 * the driver's `let loader = null` while it was still in its temporal dead
 * zone:
 *
 *     ReferenceError: Cannot access 'loader' before initialization
 *
 * Moving the state into a module that imports nothing fixes it by ordering
 * rather than by luck: this file's body has run before either the driver's or
 * the source's can, whichever of them the graph reaches first.
 *
 * That is the same shape as the earlier attempt's failure, which died on a
 * genuine import cycle between the reader's Node source and
 * `binary-resolver.ts`. Both are the same lesson: the piece everyone needs
 * first has to depend on nobody.
 *
 * Nothing here decides anything about an artifact. It holds two references.
 */

/** The instantiated module's exports, or null until one is installed. */
let installed: unknown = null;

/** A host's synchronous source for the module's bytes, or null. */
let loader: (() => BufferSource | WebAssembly.Module) | null = null;

export function getInstalledModule(): unknown {
  return installed;
}

export function setInstalledModule(value: unknown): void {
  installed = value;
}

export function getModuleLoader():
  | (() => BufferSource | WebAssembly.Module)
  | null {
  return loader;
}

export function setModuleLoader(
  load: (() => BufferSource | WebAssembly.Module) | null,
): void {
  loader = load;
}

/**
 * How a process instantiates a side module: as built, without its
 * `__wasm_init_memory` start for a borrowed replay, or rewritten for page
 * tables. A borrowed replay with page tables never runs `__wasm_init_memory`.
 */
export const SIDE_MODULE_FORMS = [
  "plain",
  "startless",
  "paged",
  "paged-borrowed",
] as const;
export type SideModuleForm = typeof SIDE_MODULE_FORMS[number];

/** What one load of a side module compiled. */
export interface CompiledSideModule {
  readonly source: WebAssembly.Module;
  readonly instance: WebAssembly.Module;
  readonly runsInitMemory: boolean;
}

/**
 * One compiled side module that a process hands to its fork children.
 *
 * WHY: a fork child replays every `dlopen` of its parent. The result of a
 * compile or a page-table rewrite depends only on the side module bytes and
 * the form, so the child takes the parent's result.
 */
export interface SharedSideModule {
  /** SHA-256 of the side module bytes as hex, then the form. */
  readonly key: string;
  readonly source: WebAssembly.Module;
  /** The module to instantiate, with its bytes, when it is not `source`. */
  readonly instance?: {
    readonly module: WebAssembly.Module;
    readonly bytes: SharedArrayBuffer;
  };
  readonly runsInitMemory: boolean;
}

export interface SideModuleStore {
  take(
    name: string,
    wasmBytes: Uint8Array,
    form: SideModuleForm,
  ): CompiledSideModule | undefined;
  publish(
    name: string,
    wasmBytes: Uint8Array,
    form: SideModuleForm,
    compiled: CompiledSideModule,
    instanceBytes: Uint8Array | undefined,
  ): void;
}

export function sharedSideModuleKey(
  templateId: Readonly<Uint8Array>,
  form: SideModuleForm,
): string {
  let hex = "";
  for (const byte of templateId) hex += byte.toString(16).padStart(2, "0");
  return `${hex}:${form}`;
}

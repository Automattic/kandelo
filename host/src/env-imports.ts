/**
 * The `env` imports a user program may carry, and the check that refuses any
 * other.
 *
 * WHY: before ABI 46 the SDK linked with `--allow-undefined` and the host
 * filled every unknown `env` function import with a stub that threw
 * "Unimplemented import" when called, and faked several C++ runtime
 * functions in JavaScript. A program that needed a function Kandelo lacks
 * therefore loaded and crashed later, on first use. Executables now link
 * against the generated allowance, and the host refuses, before
 * instantiation, any program importing something it does not provide.
 *
 * The allowed set is read from the generated ABI, never listed here:
 * `HOST_ENV_IMPORTS` (what the host supplies to every program) plus the
 * imports fork instrumentation adds after linking, which the host's fork
 * runtime supplies. Imports from other modules (`kernel`) are validated
 * where the kernel import object is built.
 */
import {
  HOST_ENV_IMPORTS,
  WPK_FORK_GLOBAL_IMPORTS,
  WPK_FORK_REQUIRED_IMPORTS,
  WPK_FORK_REQUIRED_TABLE_IMPORTS,
  WPK_FORK_UNWIND_TAG_IMPORT_MODULE,
  WPK_FORK_UNWIND_TAG_IMPORT_NAME,
} from "./generated/abi";
import { wasmModuleImports } from "./wasm-module-reflection";

type ImportKind = WebAssembly.ImportExportKind | "tag";

function declaredEnvImports(): ReadonlyMap<string, ImportKind> {
  const declared = new Map<string, ImportKind>();
  for (const { name, kind } of HOST_ENV_IMPORTS) declared.set(name, kind);
  for (const { module, name } of WPK_FORK_REQUIRED_IMPORTS) {
    if (module === "env") declared.set(name, "function");
  }
  for (const { module, name } of WPK_FORK_REQUIRED_TABLE_IMPORTS) {
    if (module === "env") declared.set(name, "table");
  }
  for (const { module, name } of WPK_FORK_GLOBAL_IMPORTS) {
    if (module === "env") declared.set(name, "global");
  }
  if (WPK_FORK_UNWIND_TAG_IMPORT_MODULE === "env") {
    declared.set(WPK_FORK_UNWIND_TAG_IMPORT_NAME, "tag");
  }
  return declared;
}

const DECLARED_ENV_IMPORTS = declaredEnvImports();

/**
 * Throw if `module` imports from `env` a name the host does not provide, or
 * a provided name as a different kind of import.
 */
export function assertDeclaredEnvImports(module: WebAssembly.Module): void {
  for (const imported of wasmModuleImports(module)) {
    if (imported.module !== "env") continue;
    const kind = DECLARED_ENV_IMPORTS.get(imported.name);
    if (kind === undefined) {
      throw new Error(
        `program imports env.${imported.name}, which Kandelo does not provide; ` +
          "rebuild it with the current SDK",
      );
    }
    if ((imported.kind as ImportKind) !== kind) {
      throw new Error(
        `program imports env.${imported.name} as a ${imported.kind}, but Kandelo ` +
          `provides it as a ${kind}; rebuild it with the current SDK`,
      );
    }
  }
}

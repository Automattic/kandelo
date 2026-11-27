/** Import namespaces are required interfaces, not optional metadata to ignore. */
import {
  KGPU_IMPORT,
  KGPU_MODULE,
  KLOG_IMPORT,
  KLOG_MODULE,
  RESERVED_MODULE_PREFIX,
  STACK_IMPORT,
  STACK_MODULE,
  MEMORY_GROUP_MODULE,
  MEMORY_GROUP_IMPORT,
  MEMORY_GROUP_GROWTH_MODULE,
  MEMORY_GROUP_GROWTH_IMPORT,
} from "./generated/program-extensions";

interface Import { readonly module: string; readonly name: string; readonly kind: string }
interface FunctionImport {
  readonly module: string; readonly name: string;
  readonly signature: { readonly params: readonly number[]; readonly results: readonly number[] };
}
/** Each implemented extension module and its single `(pointer, i32, i32) -> i32` import. */
const EXTENSION_IMPORTS: ReadonlyMap<string, string> = new Map([
  [STACK_MODULE, STACK_IMPORT],
  [KLOG_MODULE, KLOG_IMPORT],
  [KGPU_MODULE, KGPU_IMPORT],
]);
const EXTENSION_IMPORT_NAMES: ReadonlySet<string> = new Set([...EXTENSION_IMPORTS.values(), MEMORY_GROUP_GROWTH_IMPORT]);
const implemented = new Set<string>(EXTENSION_IMPORTS.keys());

/** Artifact policy for the explicitly selected shared-memory backend. */
export const GROUPED_WORKER_EXTENSIONS: ReadonlySet<string> = new Set([
  STACK_MODULE, KLOG_MODULE, KGPU_MODULE, MEMORY_GROUP_MODULE, MEMORY_GROUP_GROWTH_MODULE,
]);

/** Whether an import names an extension function, from any module. */
export function isProgramExtensionImportName(name: string): boolean {
  return EXTENSION_IMPORT_NAMES.has(name);
}

export function describeProgramExtensionFailures(
  imports: readonly Import[],
  functions: readonly FunctionImport[],
  memoryPointerWidths: readonly number[],
  supported: ReadonlySet<string> = implemented,
): string[] {
  const failures: string[] = [];
  for (const entry of imports) {
    if (entry.module === MEMORY_GROUP_MODULE && supported.has(MEMORY_GROUP_MODULE)) {
      if (entry.name !== MEMORY_GROUP_IMPORT || entry.kind !== "memory"
          || memoryPointerWidths.length !== 1 || memoryPointerWidths[0] !== 4) {
        failures.push(`incompatible grouped memory import ${entry.module}.${entry.name}`);
      }
      continue;
    }
    if (entry.module === MEMORY_GROUP_GROWTH_MODULE && supported.has(MEMORY_GROUP_GROWTH_MODULE)) {
      const matches = functions.filter(candidate => candidate.module === entry.module && candidate.name === entry.name);
      if (entry.name !== MEMORY_GROUP_GROWTH_IMPORT || entry.kind !== 'function'
          || memoryPointerWidths.length !== 1 || memoryPointerWidths[0] !== 4 || matches.length !== 1
          || matches.some(({ signature }) => signature.params.length !== 1 || signature.params[0] !== 0x7f
            || signature.results.length !== 1 || signature.results[0] !== 0x7f)) {
        failures.push(`incompatible grouped growth import ${entry.module}.${entry.name}`);
      }
      continue;
    }
    if (!entry.module.startsWith(RESERVED_MODULE_PREFIX) && !EXTENSION_IMPORT_NAMES.has(entry.name)) continue;
    const identity = `${entry.module}.${entry.name}`;
    const expectedName = EXTENSION_IMPORTS.get(entry.module);
    if (expectedName === undefined || !supported.has(entry.module)) {
      failures.push(`unsupported required program extension ${identity}`);
      continue;
    }
    if (entry.name !== expectedName || entry.kind !== "function") {
      failures.push(`unsupported import in program extension ${identity} (${entry.kind})`);
      continue;
    }
    const width = memoryPointerWidths[0];
    if (memoryPointerWidths.length !== 1 || (width !== 4 && width !== 8)) {
      failures.push(`${identity} requires one process memory`);
      continue;
    }
    const expected = [width === 8 ? 0x7e : 0x7f, 0x7f, 0x7f];
    const matches = functions.filter(candidate => candidate.module === entry.module && candidate.name === entry.name);
    if (matches.length === 0 || matches.some(({ signature }) => signature.params.length !== expected.length || signature.params.some((type, index) => type !== expected[index]) || signature.results.length !== 1 || signature.results[0] !== 0x7f)) {
      failures.push(`${identity} has an incompatible function signature`);
    }
  }
  return failures;
}

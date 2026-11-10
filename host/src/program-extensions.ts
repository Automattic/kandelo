/** Import namespaces are required interfaces, not optional metadata to ignore. */
import { RESERVED_MODULE_PREFIX, STACK_IMPORT, STACK_MODULE } from "./generated/program-extensions";

interface Import { readonly module: string; readonly name: string; readonly kind: string }
interface FunctionImport {
  readonly module: string; readonly name: string;
  readonly signature: { readonly params: readonly number[]; readonly results: readonly number[] };
}
const implemented = new Set<string>([STACK_MODULE]);
export function describeProgramExtensionFailures(
  imports: readonly Import[],
  functions: readonly FunctionImport[],
  memoryPointerWidths: readonly number[],
  supported: ReadonlySet<string> = implemented,
): string[] {
  const failures: string[] = [];
  for (const entry of imports) {
    if (!entry.module.startsWith(RESERVED_MODULE_PREFIX) && entry.name !== STACK_IMPORT) continue;
    const identity = `${entry.module}.${entry.name}`;
    if (entry.module !== STACK_MODULE || !supported.has(entry.module)) {
      failures.push(`unsupported required program extension ${identity}`);
      continue;
    }
    if (entry.name !== STACK_IMPORT || entry.kind !== "function") {
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

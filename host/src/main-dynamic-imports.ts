/**
 * SPIKE PROTOTYPE (brandonpayton/shared-lib-exec-spike): imports of an
 * executable that was linked against shared libraries.
 *
 * Not production code. See
 * docs/plans/2026-11-15-shared-library-executables-spike.md on the report
 * branch.
 *
 * The SDK links such an executable with `wasm-ld --experimental-pic
 * -Bdynamic`; wasm-ld turns every symbol a library defines into an import
 * (`env.<fn>`, `GOT.mem.<data>`, `GOT.func.<fn>`) and records the libraries
 * in `dylink.0`, which the SDK renames to `kandelo.dylink.0`. The libraries
 * are loaded by a generated guest constructor through ordinary `dlopen`
 * (RTLD_GLOBAL), i.e. after the executable has been instantiated. So:
 *
 * - each function import is satisfied by a tiny generated Wasm stub that
 *   tail-calls (`return_call_indirect`) through a private funcref table, so
 *   no stub or JavaScript frame stays on the stack once the call is made;
 * - each GOT import is a fresh mutable global;
 * - after every committed dlopen the host fills table slots and GOT values
 *   from the dynamic linker's global scope.
 *
 * Calling an unresolved function traps (null table entry).
 */
import {
  readWasmCustomSectionPayload,
  readWasmFunctionImports,
  type WasmFunctionImportType,
} from "./constants";
import { wasmModuleImports } from "./wasm-module-reflection";

export const MAIN_DYLINK_SECTION = "kandelo.dylink.0";

export function isDynamicMainProgram(programBytes: ArrayBuffer): boolean {
  return readWasmCustomSectionPayload(programBytes, MAIN_DYLINK_SECTION) !== null;
}

export interface MainDynamicLookup {
  /** A function or data global visible in the process's global scope. */
  lookup(name: string): Function | WebAssembly.Global | undefined;
  /** Function-table index for a function, adding it when absent. */
  functionIndex(name: string): number | null;
}

export interface MainDynamicImports {
  /** Names this module's env imports may use beyond the host's own set. */
  readonly dynamicEnvFunctions: ReadonlySet<string>;
  readonly importObject: Record<string, Record<string, WebAssembly.ExportValue>>;
  /** Fill what the global scope now provides; return still-unresolved names. */
  resolve(scope: MainDynamicLookup): string[];
}

const NUMERIC = new Set([0x7f, 0x7e, 0x7d, 0x7c]);

function uleb(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

function name(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  return [...uleb(bytes.length), ...bytes];
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

function vector(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

/** One module: table `t` (funcref, n entries) and stub `f<k>` per import. */
function buildStubModule(imports: readonly WasmFunctionImportType[]): Uint8Array {
  const typeKeys = new Map<string, number>();
  const types: number[][] = [];
  const funcTypes: number[] = [];
  for (const imported of imports) {
    const { params, results } = imported.signature;
    for (const code of [...params, ...results]) {
      if (!NUMERIC.has(code)) {
        throw new Error(
          `dynamic import env.${imported.name} has a non-numeric signature`,
        );
      }
    }
    const key = `${params.join(",")}->${results.join(",")}`;
    let index = typeKeys.get(key);
    if (index === undefined) {
      index = types.length;
      typeKeys.set(key, index);
      types.push([0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results]);
    }
    funcTypes.push(index);
  }
  const n = imports.length;
  const codes = imports.map((imported, k) => {
    const body: number[] = [0x00]; // no locals
    imported.signature.params.forEach((_, i) => body.push(0x20, ...uleb(i)));
    body.push(0x41, ...sleb(k)); // i32.const k
    body.push(0x13, ...uleb(funcTypes[k]!), 0x00); // return_call_indirect type, table 0
    body.push(0x0b);
    return [...uleb(body.length), ...body];
  });
  const exports = [
    [...name("t"), 0x01, 0x00],
    ...imports.map((_, k) => [...name(`f${k}`), 0x00, ...uleb(k)]),
  ];
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vector(types)),
    ...section(3, vector(funcTypes.map((t) => uleb(t)))),
    ...section(4, vector([[0x70, 0x00, ...uleb(n)]])),
    ...section(7, vector(exports)),
    ...section(10, vector(codes)),
  ];
  return new Uint8Array(bytes);
}

function sleb(value: number): number[] {
  const out: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

export function createMainDynamicImports(
  module: WebAssembly.Module,
  programBytes: ArrayBuffer,
  isHostEnvImport: (name: string) => boolean,
  ptrWidth: 4 | 8,
): MainDynamicImports {
  const functionImports = readWasmFunctionImports(programBytes).filter(
    (imported) => imported.module === "env" && !isHostEnvImport(imported.name),
  );
  const stubs = functionImports.length === 0
    ? null
    : new WebAssembly.Instance(
        new WebAssembly.Module(buildStubModule(functionImports) as BufferSource),
      );
  const stubTable = stubs?.exports.t as WebAssembly.Table | undefined;
  const env: Record<string, WebAssembly.ExportValue> = {};
  functionImports.forEach((imported, k) => {
    env[imported.name] = stubs!.exports[`f${k}`] as WebAssembly.ExportValue;
  });
  const unresolvedFunctions = new Map(
    functionImports.map((imported, k) => [imported.name, k] as const),
  );

  const got: Record<string, Record<string, WebAssembly.Global>> = {
    "GOT.mem": {},
    "GOT.func": {},
  };
  const unresolvedGot = new Set<string>();
  for (const imported of wasmModuleImports(module)) {
    if (imported.module !== "GOT.mem" && imported.module !== "GOT.func") continue;
    got[imported.module]![imported.name] = new WebAssembly.Global(
      { value: ptrWidth === 8 ? "i64" : "i32", mutable: true },
      ptrWidth === 8 ? 0n : 0,
    );
    unresolvedGot.add(`${imported.module}.${imported.name}`);
  }

  const importObject: Record<string, Record<string, WebAssembly.ExportValue>> = { env };
  if (Object.keys(got["GOT.mem"]!).length) importObject["GOT.mem"] = got["GOT.mem"]!;
  if (Object.keys(got["GOT.func"]!).length) importObject["GOT.func"] = got["GOT.func"]!;

  return {
    dynamicEnvFunctions: new Set(functionImports.map((i) => i.name)),
    importObject,
    resolve(scope: MainDynamicLookup): string[] {
      for (const [symbol, k] of [...unresolvedFunctions]) {
        const value = scope.lookup(symbol);
        if (typeof value !== "function") continue;
        stubTable!.set(k, value as never);
        unresolvedFunctions.delete(symbol);
      }
      for (const key of [...unresolvedGot]) {
        const [space, symbol] = key.startsWith("GOT.mem.")
          ? ["GOT.mem", key.slice(8)] as const
          : ["GOT.func", key.slice(9)] as const;
        const value = scope.lookup(symbol);
        let address: number | null = null;
        if (space === "GOT.mem" && value instanceof WebAssembly.Global) {
          address = Number(value.value);
        } else if (space === "GOT.func" && typeof value === "function") {
          address = scope.functionIndex(symbol);
        }
        if (address === null) continue;
        got[space]![symbol]!.value = ptrWidth === 8 ? BigInt(address) : address;
        unresolvedGot.delete(key);
      }
      return [...unresolvedFunctions.keys(), ...unresolvedGot];
    },
  };
}

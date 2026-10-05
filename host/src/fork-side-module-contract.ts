/**
 * The fork contract a main program makes with the side modules it may load.
 *
 * WHY: fork instrumentation only rebuilds, in a fork child, the frames the
 * instrumenter proved a child can return through. For a program that can
 * dlopen, wasm-fork-instrument's default (`--side-modules=traced-entries`)
 * analyzes the main program as if no side-module code can return through a
 * fork child into main-program frames. That assumption is what lets the
 * instrumented set stay small; this check makes it true at load time.
 *
 * A side module can reach a main-program function whose fork child returns
 * to its caller ("fork-returning", for example `fork` itself or a function
 * that daemonizes) only by importing it, directly or through `GOT.func`, or
 * by calling a function pointer the program handed it. The main program
 * records its fork-returning functions that are exported or address-taken in
 * the custom section below. A side module that imports one is refused; if any
 * fork-returning function is address-taken at all, every side module is
 * refused, because any of them may be handed that pointer. Refusing is a
 * truthful dlopen failure (POSIX allows dlopen to fail), reported through
 * dlerror(). A program built with `--side-modules=assume-all-entries-fork-returning`
 * is instrumented for every side-module entry and imposes no restriction.
 *
 * Section `kandelo.wpk_fork.dlopen_contract`, UTF-8 text, one record per line,
 * fields separated by a tab:
 *   v1
 *   mode\t<traced-entries | assume-all-entries-fork-returning>
 *   address-taken\t<0 | 1>     a fork-returning function is address-taken
 *   fork-returning\t<name>     exported or address-taken (repeated)
 */

import type { DecodedWasmImportDescriptor } from "./constants";

export const FORK_SIDE_MODULE_CONTRACT_SECTION = "kandelo.wpk_fork.dlopen_contract";

export type ForkSideModuleMode =
  | "traced-entries"
  | "assume-all-entries-fork-returning";

export interface ForkSideModuleContract {
  readonly mode: ForkSideModuleMode;
  readonly addressTakenForkReturning: boolean;
  readonly forkReturning: ReadonlySet<string>;
}

/** Parse the contract text; malformed or unknown versions fail loudly. */
export function parseForkSideModuleContract(text: string): ForkSideModuleContract {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines[0] !== "v1") {
    throw new Error(
      `${FORK_SIDE_MODULE_CONTRACT_SECTION}: unsupported version ${JSON.stringify(lines[0] ?? "")}`,
    );
  }
  let mode: ForkSideModuleMode | undefined;
  let addressTaken: boolean | undefined;
  const forkReturning = new Set<string>();
  for (const line of lines.slice(1)) {
    const tab = line.indexOf("\t");
    const key = tab < 0 ? line : line.slice(0, tab);
    const value = tab < 0 ? "" : line.slice(tab + 1);
    if (key === "mode") {
      if (value !== "traced-entries" && value !== "assume-all-entries-fork-returning") {
        throw new Error(`${FORK_SIDE_MODULE_CONTRACT_SECTION}: unknown mode ${JSON.stringify(value)}`);
      }
      mode = value;
    } else if (key === "address-taken") {
      if (value !== "0" && value !== "1") {
        throw new Error(`${FORK_SIDE_MODULE_CONTRACT_SECTION}: address-taken must be 0 or 1`);
      }
      addressTaken = value === "1";
    } else if (key === "fork-returning") {
      if (value.length === 0) {
        throw new Error(`${FORK_SIDE_MODULE_CONTRACT_SECTION}: empty fork-returning name`);
      }
      forkReturning.add(value);
    } else {
      throw new Error(`${FORK_SIDE_MODULE_CONTRACT_SECTION}: unknown record ${JSON.stringify(key)}`);
    }
  }
  if (mode === undefined || addressTaken === undefined) {
    throw new Error(`${FORK_SIDE_MODULE_CONTRACT_SECTION}: missing mode or address-taken record`);
  }
  return { mode, addressTakenForkReturning: addressTaken, forkReturning };
}

/** The main program's contract, or undefined when it records none. */
export function readForkSideModuleContract(
  module: WebAssembly.Module,
): ForkSideModuleContract | undefined {
  const sections = WebAssembly.Module.customSections(
    module,
    FORK_SIDE_MODULE_CONTRACT_SECTION,
  );
  if (sections.length === 0) return undefined;
  if (sections.length !== 1) {
    throw new Error(`${FORK_SIDE_MODULE_CONTRACT_SECTION}: duplicated section`);
  }
  return parseForkSideModuleContract(new TextDecoder().decode(sections[0]));
}

/** Throw a dlerror-ready message if `name` may not be loaded. */
export function checkSideModuleForkContract(
  name: string,
  imports: readonly DecodedWasmImportDescriptor[],
  contract: ForkSideModuleContract | undefined,
): void {
  if (!contract || contract.mode === "assume-all-entries-fork-returning") return;
  const remedy =
    "Rebuild the main program with wasm-fork-instrument " +
    "--side-modules=assume-all-entries-fork-returning to load libraries that can do this.";
  if (contract.addressTakenForkReturning) {
    throw new Error(
      `${name}: refused by the main program's fork contract: one of its ` +
        "fork-returning functions is address-taken, so any side module could " +
        `call it and return through a fork child into frames that were not instrumented. ${remedy}`,
    );
  }
  for (const entry of imports) {
    const callable =
      (entry.module === "env" && entry.kind === "function") ||
      entry.module === "GOT.func";
    if (callable && contract.forkReturning.has(entry.name)) {
      throw new Error(
        `${name}: refused by the main program's fork contract: it imports ` +
          `${entry.name}, whose fork child can return through frames that were ` +
          `not instrumented for side-module callers. ${remedy}`,
      );
    }
  }
}

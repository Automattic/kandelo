import type { Plugin } from "vite";

/** The graph fields this build invariant consumes. Native bundler handles
 * remain owned by Vite/Rolldown; neither the policy nor its fixtures invents
 * those handles or depends on their representation. */
export interface WorkerChunkEvidence {
  readonly type: "chunk";
  readonly isEntry: boolean;
  readonly facadeModuleId: string | null;
  readonly fileName: string;
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
  readonly importedBindings?: Readonly<Record<string, readonly string[]>>;
}
export type WorkerBundleEvidence = Readonly<Record<string, WorkerChunkEvidence | { readonly type: "asset" }>>;

/** A stripped worker entry must remain terminal. Missing graph evidence is
 * a build failure; guessing bindings would silently emit a broken module. */
export function assertTerminalWorkerEntries(
  facades: ReadonlySet<string>,
  bundle: WorkerBundleEvidence,
  fail: (message: string) => never = message => { throw new Error(message); },
): void {

  const strippedEntries = new Set<string>();
  const emittedEntryByFacade = new Map<string, string>();
  for (const output of Object.values(bundle)) {
    if (
      output.type !== "chunk" || !output.isEntry ||
      output.facadeModuleId === null ||
      !facades.has(output.facadeModuleId)
    ) continue;
    const prior = emittedEntryByFacade.get(output.facadeModuleId);
    if (prior !== undefined && prior !== output.fileName) {
      fail(
        `stripped worker entry ${output.facadeModuleId} resolves to multiple emitted chunks: ${prior}, ${output.fileName}`,
      );
    }
    emittedEntryByFacade.set(output.facadeModuleId, output.fileName);
    strippedEntries.add(output.fileName);
  }
  for (const facade of facades) {
    if (!emittedEntryByFacade.has(facade)) {
      fail(
        `stripped worker entry ${facade} has no emitted entry chunk`,
      );
    }
  }
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk") continue;
    for (const imported of output.dynamicImports) {
      if (strippedEntries.has(imported)) {
        fail(
          `worker chunk ${output.fileName} imports worker entry ${imported} whose exports are stripped`,
        );
      }
    }
    for (const imported of output.imports) {
      if (!strippedEntries.has(imported)) continue;
      if (output.importedBindings === undefined) {
        fail(
          `worker chunk ${output.fileName} does not report imported bindings for stripped worker entry ${imported}`,
        );
      }
      fail(
        `worker chunk ${output.fileName} imports worker entry ${imported} whose exports are stripped`,
      );
    }
  }
}

/**
 * [RUNTIME-WORKAROUND: WEBKIT-WORKER-ENTRY-EXPORTS]
 * WebKit 26.6 re-evaluates a module Worker entry when its dynamic import
 * imports a helper back from that entry. The standalone registry regression
 * proves the installed handler loses initialization after reporting ready.
 * Keep terminal entries self-contained and reject imports of an
 * entry whose synthetic unused exports this build transform removes.
 *
 * Earlier Vite 8 builds did not honor preserveEntrySignatures here. The graph
 * invariant remains required if a future bundler makes this transform dead.
 */
export function dropWorkerEntryExports(): Plugin {
  const strippedEntryFacades = new Set<string>();
  return {
    name: "drop-worker-entry-exports",
    enforce: "post",
    renderChunk(code, chunk) {
      if (!chunk.isEntry) return null;
      const stripped = code.replace(/\bexport\s*\{[^}]*\}\s*;?\s*$/, "");
      if (stripped === code) return null;
      if (chunk.facadeModuleId === null) {
        this.error(
          `stripped worker entry ${chunk.fileName} lacks a stable facade identity`,
        );
      }
      strippedEntryFacades.add(chunk.facadeModuleId);
      return { code: stripped, map: null };
    },
    generateBundle(_options, bundle) {
      assertTerminalWorkerEntries(strippedEntryFacades, bundle, message => this.error(message));
    },
  };
}

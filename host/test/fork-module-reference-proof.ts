// Shared test reader for the co-resident fork-module's per-kind reference
// proof-of-use (Phase 6 D6.5). A fresh fork CHILD whose carried references were
// reconstructed THROUGH the module posts a single `fork_module_references`
// message carrying one count per reference kind; the kernel worker forwards it
// as a `fork-module` host diagnostic whose text lists every kind:
//
//   fork_module_references=<funcref> externrefs_resolved=<externref>
//     exnrefs_reconstructed=<exnref> gc_nodes_reconstructed=<gc>
//
// `moduleReferenceProof(diagnostics, kind)` returns the reconstructed count for
// one kind, or `null` when the module never drove a reconstruction (silent JS
// fallback / flag off) — the message is emitted ONLY when some kind's count is
// positive (the D7b lesson: a `=0` diagnostic broke the d_01 poll), so a null
// result is the honest "the module did not drive this" signal.

import type { HostDiagnostic } from "../src/host-diagnostic";

export type ModuleReferenceKind = "funcref" | "externref" | "exnref" | "gc";

const KIND_PATTERNS: Record<ModuleReferenceKind, RegExp> = {
  funcref: /fork_module_references=(\d+)/,
  externref: /externrefs_resolved=(\d+)/,
  exnref: /exnrefs_reconstructed=(\d+)/,
  gc: /gc_nodes_reconstructed=(\d+)/,
};

export function moduleReferenceProof(
  hostDiagnostics: readonly HostDiagnostic[],
  kind: ModuleReferenceKind,
): number | null {
  const pattern = KIND_PATTERNS[kind];
  for (const diagnostic of hostDiagnostics) {
    if (diagnostic.source !== "fork-module") continue;
    const match = pattern.exec(diagnostic.message);
    if (match) return Number(match[1]);
  }
  return null;
}

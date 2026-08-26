import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = readFileSync(
  resolve(repoRoot, "scripts", "publish-package-source.sh"),
  "utf8",
);

describe("package-source publication contract", () => {
  it("regenerates the runtime projection in the exact publish registry order", () => {
    const sync = script.indexOf('"$KANDELO_ROOT/scripts/sync-package-source.sh"');
    const registry = script.indexOf(
      'export WASM_POSIX_DEPS_REGISTRY="$PACKAGE_SOURCE_ROOT/packages:$KANDELO_ROOT/packages/registry"',
    );
    const projectionCheck = script.indexOf(
      "build-deps program-index-context-ensure",
    );
    const packageLoop = script.indexOf("while IFS= read -r pkg; do");

    expect(sync).toBeGreaterThan(-1);
    expect(registry).toBeGreaterThan(-1);
    expect(registry).toBeLessThan(sync);
    expect(projectionCheck).toBeGreaterThan(registry);
    expect(projectionCheck).toBeLessThan(sync);
    expect(packageLoop).toBeGreaterThan(sync);
  });

  it("materializes declared program dependencies for source builds", () => {
    const lines = script.split(/\r?\n/);
    const archiveStage = lines.findIndex((line) => line.trim() === "archive-stage \\");
    expect(archiveStage).toBeGreaterThan(-1);

    const invocation = lines.slice(archiveStage, archiveStage + 10);
    const arch = invocation.indexOf('      --arch "$arch" \\');
    const binaries = invocation.indexOf(
      '      --binaries-dir "$KANDELO_ROOT/binaries" \\',
    );
    const out = invocation.indexOf('      --out "$out_dir" \\');

    expect(arch).toBeGreaterThan(-1);
    expect(binaries).toBeGreaterThan(arch);
    expect(out).toBeGreaterThan(binaries);
    expect(script.match(/--binaries-dir/g)).toHaveLength(1);
  });

  it("admits the complete selection before publication and preserves policy failures", () => {
    const policyHelper = script.indexOf("publication_ledger_for_roots()");
    const selectionGate = script.indexOf("if ! publication_ledger_for_roots");
    const typedBlockerOutput = script.indexOf(
      '"$policy_roots" "$PUBLICATION_EXPECTED" "$PUBLICATION_BLOCKERS"',
      selectionGate,
    );
    const blockerValidation = script.indexOf(
      "publication blocker report is malformed",
      typedBlockerOutput,
    );
    const metadataGuard = script.indexOf(
      'requested package $pkg is missing publishable metadata after sync',
      blockerValidation,
    );
    const blockerMembership = script.indexOf(
      '"$PUBLICATION_BLOCKERS" >/dev/null',
      metadataGuard,
    );
    const nonbuildableError = script.indexOf(
      "selected package $pkg has no publishable ledger entry",
      blockerMembership,
    );
    const policyOmission = script.indexOf(
      'omit $pkg (blocked by $blocker_chain)',
      blockerMembership,
    );
    const firstBuild = script.indexOf("build_publish_one() {");
    const archiveStage = script.indexOf("archive-stage \\");
    const failurePolicyRecheck = script.indexOf(
      'publication_ledger_for_roots "$pkg" "$policy_recheck"',
      archiveStage,
    );
    const failedIndexWrite = script.indexOf(
      '--status failed \\',
      failurePolicyRecheck,
    );

    expect(policyHelper).toBeGreaterThan(-1);
    expect(script).toContain("staging-reuse expected");
    expect(script).toContain('--require-root "$roots"');
    expect(script).toContain('--blocked-output "$blocked_output"');
    expect(script).toContain('policy_roots="all"');
    expect(script).toContain(
      'policy_roots="$(IFS=,; echo "${REQUESTED_PACKAGES[*]}")"',
    );
    expect(script).toContain(
      'echo "publish-package-source: omit $pkg (blocked by $blocker_chain)"',
    );
    expect(script).toContain(
      'echo "publish-package-source: requested package $pkg is missing publishable metadata after sync"',
    );
    expect(script).toContain('publication_selected "$pkg" || continue');
    expect(script).not.toContain("policy_probe");
    expect(selectionGate).toBeGreaterThan(policyHelper);
    expect(typedBlockerOutput).toBeGreaterThan(selectionGate);
    expect(blockerValidation).toBeGreaterThan(typedBlockerOutput);
    expect(selectionGate).toBeLessThan(firstBuild);
    expect(metadataGuard).toBeGreaterThan(blockerValidation);
    expect(blockerMembership).toBeGreaterThan(metadataGuard);
    expect(nonbuildableError).toBeGreaterThan(blockerMembership);
    expect(policyOmission).toBeGreaterThan(blockerMembership);
    expect(failurePolicyRecheck).toBeGreaterThan(archiveStage);
    expect(failedIndexWrite).toBeGreaterThan(failurePolicyRecheck);

    const guardedFailure = script.slice(
      failurePolicyRecheck,
      failedIndexWrite,
    );
    expect(guardedFailure).toContain(
      "canonical index left unchanged",
    );
    expect(guardedFailure).toContain("return 1");

    const initialGate = script.slice(selectionGate, blockerValidation);
    expect(initialGate).toContain(
      "selected package publication is not admitted",
    );
    expect(initialGate).toContain("exit 1");
    expect(initialGate).not.toContain("omit $pkg");
  });
});

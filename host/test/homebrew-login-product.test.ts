import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  assertLocalTestHomebrewTapBundle,
  assertLocalTestHomebrewProvenance,
  createLocalTestPrivilegedProgramProjections,
  installLocalTestHomebrewTapBundle,
  LOCAL_TEST_HOMEBREW_TAP_BUNDLE_PATH,
} from "../src/homebrew-vfs-builder";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { parsePrivilegedProgramProjections } from "../src/vfs/privileged-projection";
import { appendProcessTreeRssSample } from "../../scripts/measure-homebrew-vfork-rss";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function readJson(path: string): any {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
}

describe("ABI 43 Homebrew login product", () => {
  it("selects the login, sudo, Ruby, and shell roots", () => {
    const brewfile = readFileSync(
      resolve(repositoryRoot, "homebrew/main-shell.Brewfile"),
      "utf8",
    );
    for (const formula of ["login", "sudo-lite", "sudo", "ruby", "bash"]) {
      expect(brewfile).toContain(`brew "kandelo-dev/tap-core/${formula}"`);
    }

    const lock = readJson("homebrew/main-shell-migration-lock.json");
    expect(lock.catalog.tap_commit).toBe(
      "af70e3ba06367dbafb8a95fabbacc3e1352b58b2",
    );
    expect(lock.packages.map((entry: any) => entry.formula.name)).toEqual(
      expect.arrayContaining(["login", "sudo-lite", "sudo", "ruby", "bash"]),
    );
  });

  it("keeps the ordinary prefix nosuid and closes the trusted projection group", () => {
    const lock = readJson("homebrew/main-shell-migration-lock.json");
    expect(lock.product.ordinary_prefix_mount).toEqual({ nosuid: true });
    expect(lock.product.registry_bridge).toBe(false);

    const artifactDigests = {
      login: createHash("sha256").update("login").digest("hex"),
      "sudo-lite": createHash("sha256").update("sudo-lite").digest("hex"),
      sudo: createHash("sha256").update("sudo").digest("hex"),
    };
    const bottleDigests = {
      login: "1".repeat(64),
      "sudo-lite": "2".repeat(64),
      sudo: "3".repeat(64),
    };
    const projections = createLocalTestPrivilegedProgramProjections(
      lock.product.privileged_programs,
      { artifactDigests, bottleDigests },
    );
    expect(() => parsePrivilegedProgramProjections(projections)).not.toThrow();
    expect(projections.map((entry) => entry.destinationPath)).toEqual([
      "/usr/bin/login",
      "/usr/bin/sudo-lite",
      "/usr/bin/sudo",
    ]);
    for (const projection of projections) {
      expect(projection).toMatchObject({
        uid: 0,
        gid: 0,
        mode: 0o4755,
        mountPoint: "trusted-root-product",
      });
    }
  });

  it("admits local-test provenance only at the review-pending local boundary", () => {
    const provenance = {
      schema: 1,
      provenance_kind: "local-test",
      promotable: false,
      published: false,
    };
    expect(() =>
      assertLocalTestHomebrewProvenance(provenance, {
        localHarness: true,
        reviewPendingArtifact: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertLocalTestHomebrewProvenance(provenance, {
        localHarness: false,
        reviewPendingArtifact: true,
      }),
    ).toThrow(/local harness/i);
    expect(() =>
      assertLocalTestHomebrewProvenance(provenance, {
        localHarness: true,
        reviewPendingArtifact: false,
      }),
    ).toThrow(/review-pending/i);
    expect(() =>
      assertLocalTestHomebrewProvenance(
        { ...provenance, promotable: true },
        { localHarness: true, reviewPendingArtifact: true },
      ),
    ).toThrow(/not promotable/i);
  });

  it("rejects local-test sidecars before the publisher mutates a tap", () => {
    const root = mkdtempSync(resolve(tmpdir(), "kandelo-local-sidecar-"));
    try {
      writeFileSync(
        resolve(root, "local-test-provenance.json"),
        `${JSON.stringify({
          schema: 1,
          provenance_kind: "local-test",
          promotable: false,
          published: false,
        })}\n`,
      );
      const result = spawnSync(
        "bash",
        [
          resolve(repositoryRoot, "scripts/homebrew-publish-sidecars.sh"),
          "--tap-root",
          resolve(root, "must-not-be-created"),
          "--release-tag",
          "bottles-abi-v43",
          "--status",
          "success",
          "--formula",
          "login",
          "--arch",
          "wasm32",
          "--sidecar-root",
          root,
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /local-test provenance is not publishable/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects local provenance at selection finalization before tap reads", () => {
    const root = mkdtempSync(resolve(tmpdir(), "kandelo-local-finalizer-"));
    try {
      const result = spawnSync(
        "python3",
        [
          resolve(
            repositoryRoot,
            "scripts/finalize-homebrew-main-shell-release.py",
          ),
          "--source-root",
          repositoryRoot,
          "--tap-root",
          root,
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /local-test provenance is not promotable or selectable/i,
      );
      expect(result.stderr).not.toMatch(/tap root|tap checkout/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps Ruby pristine and requires the installed executable inventory audit", () => {
    const lock = readJson("homebrew/main-shell-migration-lock.json");
    expect(lock.product.ruby).toEqual({
      source_policy: "pristine-upstream",
      forbid_source_patches: true,
      forbid_ac_cv_func_vfork_no: true,
      required_config_defines: [
        "HAVE_VFORK",
        "HAVE_WORKING_VFORK",
        "HAVE_WORKING_FORK",
      ],
      required_stock_executables: [
        "bundle",
        "bundler",
        "erb",
        "gem",
        "irb",
        "minitest",
        "rake",
        "rdoc",
        "ri",
        "ruby",
        "syntax_suggest",
        "test-unit",
        "typeprof",
      ],
      instrumented_executable: "ruby",
    });
    const builder = readFileSync(
      resolve(repositoryRoot, "scripts/homebrew-bottle-build.sh"),
      "utf8",
    );
    expect(builder).toContain("instrumented-ruby.wasm");
    expect(builder).toContain("ruby-runtime.zip");
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    expect(harness).toContain("ruby-installed-inventory.json");
    expect(harness).toContain("runtime_archive_executables");
    expect(harness).toContain("normal-upstream-install");
    expect(harness).toContain("make install failed, copying lib manually");
    expect(harness).toContain("required_stock_executables");
    expect(harness).toContain("instrumented-ruby.wasm");
  });

  it("keeps the local harness complete, detached, and non-promotable", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    expect(harness).toContain("git worktree add --detach");
    expect(harness).not.toContain(
      'git -C "$KANDELO_LOGIN_TAP_ROOT" worktree add',
    );
    expect(harness).toMatch(
      /git clone --no-local --no-checkout\s*\\?\s*"\$KANDELO_LOGIN_TAP_ROOT"/,
    );
    expect(harness).toContain("formula_closure[]");
    expect(harness).toContain("homebrew-bottle-build.sh");
    expect(harness).toContain("KANDELO_HOMEBREW_PROVENANCE_KIND=local-test");
    expect(harness).toContain("--review-pending-artifact");
    expect(harness).toContain("--project=chromium");
    expect(harness).toContain("--project=firefox");
    expect(harness).toContain("--project=webkit");
    expect(harness).toContain("local-test-provenance.json");
    expect(harness).not.toContain("GITHUB_ACTIONS=true");
  });

  it("runs every local bottle in the protected Formula and recipe identities", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    expect(harness).toContain(
      'KANDELO_LOGIN_BUILD_USER="kandelo-homebrew-build"',
    );
    expect(harness).toContain(
      'KANDELO_LOGIN_RECIPE_USER="kandelo-homebrew-recipe"',
    );
    expect(harness).toMatch(
      /for reserved_user in "\$KANDELO_LOGIN_BUILD_USER" "\$KANDELO_LOGIN_RECIPE_USER"; do[\s\S]*fail "reserved Homebrew identity already exists:/,
    );
    expect(harness).toContain(
      'KANDELO_HOMEBREW_BUILD_USER="$KANDELO_LOGIN_BUILD_USER"',
    );
    expect(harness).toContain(
      'KANDELO_HOMEBREW_RECIPE_USER="$KANDELO_LOGIN_RECIPE_USER"',
    );
    expect(harness).toContain(
      'KANDELO_HOMEBREW_SHARED_TEMP="$KANDELO_LOGIN_SHARED_TEMP"',
    );
    expect(harness).toContain('KANDELO_HOMEBREW_SUDO_BIN=/usr/bin/sudo');
    expect(harness).toContain(
      'KANDELO_HOMEBREW_SYSTEMD_RUN_BIN=/usr/bin/systemd-run',
    );
    expect(harness).toContain(
      'WASM_POSIX_XTASK_BIN="$KANDELO_LOGIN_XTASK_BIN"',
    );
    expect(harness.indexOf("seal-homebrew-formula-checker.sh")).toBeLessThan(
      harness.indexOf('mapfile -t KANDELO_LOGIN_FORMULAE'),
    );
    expect(harness).toContain("build-deps program-index-selected");
    expect(harness).toMatch(
      /formula_isolation_env=\([\s\S]*HOMEBREW_CACHE="\$formula_host_cache"[\s\S]*HOMEBREW_TEMP="\$formula_host_temp"[\s\S]*KANDELO_HOMEBREW_BUILD_USER=/,
    );
  });

  it("shares one exact protected isolation environment with build and verification", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    const environment = harness.match(
      /formula_isolation_env=\(([\s\S]*?)\n  \)/,
    )?.[1];
    expect(environment).toBeDefined();
    expect(environment).not.toContain("KANDELO_HOMEBREW_LOCAL_BUILD_EVIDENCE");
    for (const assignment of [
      'HOMEBREW_CACHE="$formula_host_cache"',
      'HOMEBREW_TEMP="$formula_host_temp"',
      'KANDELO_HOMEBREW_BUILD_USER="$KANDELO_LOGIN_BUILD_USER"',
      'KANDELO_HOMEBREW_RECIPE_USER="$KANDELO_LOGIN_RECIPE_USER"',
      'KANDELO_HOMEBREW_SHARED_TEMP="$KANDELO_LOGIN_SHARED_TEMP"',
      "KANDELO_HOMEBREW_SUDO_BIN=/usr/bin/sudo",
      "KANDELO_HOMEBREW_SYSTEMD_RUN_BIN=/usr/bin/systemd-run",
      "KANDELO_HOMEBREW_SYSTEMCTL_BIN=/usr/bin/systemctl",
      "KANDELO_HOMEBREW_GETENT_BIN=/usr/bin/getent",
      "KANDELO_HOMEBREW_PGREP_BIN=/usr/bin/pgrep",
      "KANDELO_HOMEBREW_PKILL_BIN=/usr/bin/pkill",
      'WASM_POSIX_XTASK_BIN="$KANDELO_LOGIN_XTASK_BIN"',
    ]) {
      expect(environment).toContain(assignment);
    }
    expect(harness).toMatch(
      /env "\$\{formula_isolation_env\[@\]\}" "\$\{formula_build_evidence_env\[@\]\}" \\\n+    bash scripts\/homebrew-bottle-build\.sh/,
    );
    expect(harness).toMatch(
      /env "\$\{formula_isolation_env\[@\]\}" \\\n+  KANDELO_HOMEBREW_LOCAL_DEPENDENCY_CACHE=[\s\S]*?bash scripts\/homebrew-verify-poured-bottle\.sh/,
    );
    expect(harness).not.toContain("builder_env=(");
  });

  it("provisions one protected Formula browser cache before every build", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    const provision = harness.indexOf(
      "bash scripts/homebrew-provision-formula-browser.sh",
    );
    const formulaLoop = harness.indexOf(
      'for full_name in "${KANDELO_LOGIN_FORMULAE[@]}"; do',
    );
    expect(provision).toBeGreaterThan(
      harness.indexOf("npm --prefix apps/browser-demos ci"),
    );
    expect(provision).toBeLessThan(formulaLoop);
    expect(harness.slice(provision, formulaLoop)).toContain(
      '--shared-temp "$KANDELO_LOGIN_SHARED_TEMP"',
    );
    expect(harness.slice(provision, formulaLoop)).toContain(
      '--build-user "$KANDELO_LOGIN_BUILD_USER"',
    );
    expect(harness.slice(provision, formulaLoop)).toContain(
      '--sudo-bin /usr/bin/sudo',
    );
    expect(harness).toContain(
      'PLAYWRIGHT_BROWSERS_PATH="$KANDELO_LOGIN_SHARED_TEMP/ms-playwright"',
    );
  });

  it("retires only the source-built target before local bottle verification", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    const builder = readFileSync(
      resolve(repositoryRoot, "scripts/homebrew-bottle-build.sh"),
      "utf8",
    );
    const buildCall = harness.indexOf("bash scripts/homebrew-bottle-build.sh");
    const verifyCall = harness.indexOf(
      "bash scripts/homebrew-verify-poured-bottle.sh",
    );
    expect(buildCall).toBeGreaterThan(0);
    expect(verifyCall).toBeGreaterThan(buildCall);
    expect(harness.slice(buildCall, verifyCall)).toContain(
      "--retire-source-install",
    );
    const retireCall = builder.indexOf(
      "homebrew_patched_launcher_retire_source_target",
    );
    const teardown = builder.indexOf("homebrew_patched_launcher_teardown");
    expect(retireCall).toBeGreaterThan(0);
    expect(retireCall).toBeLessThan(teardown);
    expect(builder.slice(retireCall, teardown)).not.toContain("rm -rf");
  });

  it("prebuilds the exact rootfs before the fetch-only Formula runtime projection", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    const sourceBuild = harness.indexOf("--force-source-build resolve rootfs");
    const fetchOnly = harness.indexOf(
      "for package in dash coreutils grep sed rootfs; do",
    );
    expect(sourceBuild).toBeGreaterThan(harness.indexOf("bash build.sh"));
    expect(sourceBuild).toBeLessThan(fetchOnly);
    expect(harness.slice(fetchOnly)).toContain("--fetch-only resolve");
    expect(harness).toContain(
      'cmp "$KANDELO_LOGIN_SOURCE/host/wasm/rootfs.vfs" \\\n' +
        '  "$KANDELO_LOGIN_SOURCE/binaries/programs/wasm32/rootfs.vfs"',
    );
    expect(harness).toContain(
      'dash,coreutils,grep,sed,rootfs "$KANDELO_LOGIN_FORMULA_TEST_INDEX"',
    );
  });

  it("stages the workflow-equivalent admitted kernel before Formula tests", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    const platformBuild = harness.indexOf("bash build.sh");
    const kernelBuild = harness.indexOf(
      "bash packages/registry/kernel/build-kernel.sh",
    );
    const formulaIndex = harness.indexOf(
      'KANDELO_LOGIN_FORMULA_TEST_INDEX="$KANDELO_LOGIN_SOURCE/target/',
    );

    expect(kernelBuild).toBeGreaterThan(platformBuild);
    expect(kernelBuild).toBeLessThan(formulaIndex);
    expect(harness.slice(kernelBuild, formulaIndex)).toContain(
      "bash scripts/resolve-binary.sh kernel.wasm",
    );
    expect(harness.slice(kernelBuild, formulaIndex)).toContain(
      'cmp "$KANDELO_LOGIN_FORMULA_TEST_KERNEL" \\\n' +
        '  "$KANDELO_LOGIN_SOURCE/host/wasm/kandelo-kernel.wasm"',
    );
  });

  it("materializes libc++ inside the protected Formula sysroot", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    const programsBuild = harness.indexOf("bash scripts/build-programs.sh");
    const materialize = harness.indexOf(
      'KANDELO_LOGIN_LIBCXX_PREFIX="$("$KANDELO_LOGIN_XTASK_BIN"',
    );
    const formulaBuild = harness.indexOf(
      'mapfile -t KANDELO_LOGIN_FORMULAE',
    );
    expect(materialize).toBeGreaterThan(programsBuild);
    expect(materialize).toBeLessThan(formulaBuild);
    expect(harness).toContain(
      'install -m 0644 "$KANDELO_LOGIN_LIBCXX_PREFIX/lib/$archive" \\\n' +
        '    "$KANDELO_LOGIN_SOURCE/sysroot/lib/$archive"',
    );
    expect(harness).toContain(
      'cp -a "$KANDELO_LOGIN_LIBCXX_PREFIX/include/c++/v1" \\\n' +
        '  "$KANDELO_LOGIN_SOURCE/sysroot/include/c++/v1"',
    );
    expect(harness).toMatch(
      /homebrew_assert_tree_symlinks_contained \\\n\s+"\$KANDELO_LOGIN_SOURCE\/sysroot" sysroot/,
    );
  });

  it("admits only the canonical protected pkill-to-pgrep host alias", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    expect(harness).toContain(
      'KANDELO_LOGIN_PKILL_TARGET="$(readlink -f -- /usr/bin/pkill',
    );
    expect(harness).toContain(
      '[ "$KANDELO_LOGIN_PKILL_TARGET" = /usr/bin/pgrep ]',
    );
    expect(harness).toContain(
      '[ "$(stat -c \'%u\' /usr/bin/pkill 2>/dev/null || true)" = 0 ]',
    );
    expect(harness).toContain(
      'the Linux builder has an unsafe /usr/bin/pkill alias',
    );
  });

  it("binds the final prepared local tap bundle into the ordinary product", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    fs.mkdirWithOwner("/opt", 0o755, 1000, 1000);
    fs.mkdirWithOwner("/opt/kandelo", 0o755, 1000, 1000);
    fs.mkdirWithOwner("/opt/kandelo/homebrew", 0o755, 1000, 1000);
    fs.mkdirWithOwner("/opt/kandelo/homebrew/var", 0o755, 1000, 1000);
    fs.mkdirWithOwner(
      "/opt/kandelo/homebrew/var/kandelo",
      0o755,
      1000,
      1000,
    );
    const bytes = new TextEncoder().encode("exact local tap bundle");
    const binding = installLocalTestHomebrewTapBundle(fs, bytes, {
      sourceCommit: "1".repeat(40),
      preparedCommit: "2".repeat(40),
    });
    expect(binding).toMatchObject({
      path: LOCAL_TEST_HOMEBREW_TAP_BUNDLE_PATH,
      source_commit: "1".repeat(40),
      prepared_commit: "2".repeat(40),
      bytes: bytes.byteLength,
    });
    expect(() =>
      assertLocalTestHomebrewTapBundle(fs, binding),
    ).not.toThrow();
    const staged = fs.lstat(LOCAL_TEST_HOMEBREW_TAP_BUNDLE_PATH);
    expect({ mode: staged.mode & 0o7777, uid: staged.uid, gid: staged.gid })
      .toEqual({ mode: 0o444, uid: 0, gid: 0 });
    const ordinaryAncestor = fs.lstat(
      "/opt/kandelo/homebrew/var/kandelo",
    );
    expect({ uid: ordinaryAncestor.uid, gid: ordinaryAncestor.gid }).toEqual({
      uid: 1000,
      gid: 1000,
    });

    fs.unlink(LOCAL_TEST_HOMEBREW_TAP_BUNDLE_PATH);
    fs.createFileWithOwner(
      LOCAL_TEST_HOMEBREW_TAP_BUNDLE_PATH,
      0o444,
      0,
      0,
      new TextEncoder().encode("modified local tap bundle"),
    );
    expect(() => assertLocalTestHomebrewTapBundle(fs, binding)).toThrow(
      /changed identity/i,
    );
    fs.unlink(LOCAL_TEST_HOMEBREW_TAP_BUNDLE_PATH);
    expect(() => assertLocalTestHomebrewTapBundle(fs, binding)).toThrow(
      /missing/i,
    );

    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    const composer = readFileSync(
      resolve(
        repositoryRoot,
        "scripts/build-homebrew-main-shell-closure.sh",
      ),
      "utf8",
    );
    expect(composer).toContain("git -C \"$TAP_ROOT\" bundle create");
    expect(composer).toContain("--local-test-tap-bundle");
    expect(harness).toContain("KANDELO_LOGIN_PREPARED_TAP_COMMIT");
    const nodeLifecycle = readFileSync(
      resolve(repositoryRoot, "scripts/homebrew-main-shell-node-smoke.ts"),
      "utf8",
    );
    const browserLifecycle = readFileSync(
      resolve(
        repositoryRoot,
        "apps/browser-demos/pages/homebrew-vfs-test/main.ts",
      ),
      "utf8",
    );
    for (const lifecycle of [nodeLifecycle, browserLifecycle]) {
      expect(lifecycle).toContain(
        "file:///opt/kandelo/homebrew/var/kandelo/local-test/homebrew-tap-core.bundle",
      );
      expect(lifecycle).toContain("assertLocalTestHomebrewTapBundle");
    }
    expect(nodeLifecycle + browserLifecycle).not.toContain(
      "https://github.com/Kandelo-dev/homebrew-tap-core.git",
    );
  });

  it("prepares the native Linux builder before any expensive work", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    expect(harness).toContain("[ -x /usr/bin/sudo ]");
    expect(harness).toContain("/usr/bin/sudo -n true");
    const submodules = readFileSync(
      resolve(repositoryRoot, ".gitmodules"),
      "utf8",
    );
    expect(submodules).toContain(
      "url = https://github.com/PocketCluster/libc-test.git",
    );
    expect(submodules).not.toContain("url = git@github.com:");
    expect(harness).toMatch(
      /git -C "\$KANDELO_LOGIN_SOURCE" submodule sync --recursive/,
    );
    expect(harness).toMatch(
      /git -C "\$KANDELO_LOGIN_SOURCE"[\s\\]*-c 'url\.https:\/\/github\.com\/\.insteadOf=git@github\.com:'[\s\\]*submodule update --init --recursive/,
    );
    expect(harness).toMatch(
      /formula_out="\$KANDELO_LOGIN_BUILD_ROOT\/\$formula"\n\s*mkdir "\$formula_out"[\s\S]*tee "\$formula_out\/build\.log"/,
    );
  });

  it("reads the canonical builder bottle cellar field", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    const builder = readFileSync(
      resolve(repositoryRoot, "scripts/homebrew-bottle-build.sh"),
      "utf8",
    );
    expect(builder).toContain("to_entries[0].value.bottle");
    expect(builder).toContain(".[$key].bottle.rebuild");
    expect(builder).toContain(".[$key].formula.pkg_version");
    expect(harness).toContain("'.[$key].bottle.cellar'");
    expect(harness).not.toContain(
      "'.[$key].bottle.tags.wasm32_kandelo.cellar'",
    );
    const verifier = readFileSync(
      resolve(repositoryRoot, "scripts/homebrew-verify-poured-bottle.sh"),
      "utf8",
    );
    expect(verifier).toContain('FORMULA_KEY="${TAP_NAME}/${FORMULA}"');
    expect(verifier).toContain("keys == [$formula_key]");
    expect(verifier).toContain(".[$formula_key].formula.pkg_version");
    expect(verifier).not.toContain("keys == [$formula]");
  });

  it("restores only exact bootstrap roots before build and verification", () => {
    const launcher = readFileSync(
      resolve(repositoryRoot, "scripts/homebrew-patched-launcher.sh"),
      "utf8",
    );
    expect(launcher).toContain(
      "homebrew_patched_launcher_restore_invoker_bootstrap_roots()",
    );
    expect(launcher).toContain('"$prefix/var/homebrew/locks"');
    expect(launcher).toContain('"${HOMEBREW_CACHE:-}"');
    expect(launcher).toContain('"${HOMEBREW_TEMP:-}"');
    expect(launcher).toContain("bootstrap root has an unexpected owner");
    expect(launcher).not.toMatch(/chown[^\n]*-R[^\n]*"\$prefix"/);
    expect(launcher).not.toMatch(/chown[^\n]*-R[^\n]*var\/homebrew(?:"|\s)/);

    for (const script of [
      "scripts/homebrew-bottle-build.sh",
      "scripts/homebrew-verify-poured-bottle.sh",
    ]) {
      const consumer = readFileSync(resolve(repositoryRoot, script), "utf8");
      const handoff = consumer.indexOf(
        "homebrew_patched_launcher_restore_invoker_bootstrap_roots",
      );
      const firstPrefixRead = consumer.indexOf('$("$BREW_BIN" --prefix)');
      expect(handoff).toBeGreaterThan(-1);
      expect(firstPrefixRead).toBeGreaterThan(handoff);
    }
  });

  it("binds sidecars to non-empty absolute local build roots", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    expect(harness).toContain("KANDELO_LOGIN_FORBIDDEN_ROOTS_JSON");
    expect(harness).toContain("$KANDELO_LOGIN_WORK_ROOT");
    expect(harness).not.toContain("KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON='[]'");
    expect(harness).toContain("formula-source");
    expect(harness).toContain("formula-verify");
    expect(harness).toContain("build_formula_sha256");
    expect(harness).toContain("formula_source_sha256");
    expect(harness).toContain("archived_formula_sha256");
    expect(harness).toContain("archived_formula_report_sha256");
    expect(harness).toContain(
      ".packages[0].bottles[0].archived_formula_sha256",
    );
    expect(harness).toContain(
      ".bottles[0].built_from.formula_sha256",
    );
    expect(harness).toContain(
      '[ "$archived_formula_report_sha256" = "$archived_formula_sha256" ]',
    );
    expect(harness).not.toMatch(
      /archived_formula_report_sha256" = "\$build_formula_sha256/,
    );
    expect(harness).toContain(
      'KANDELO_HOMEBREW_FORMULA_SOURCE_ROOT="$formula_source_root"',
    );
    expect(harness).toContain(
      'KANDELO_HOMEBREW_TAP_ROOT="$formula_verify_root"',
    );
    const formulaIdentityCheck = harness.indexOf(
      "ruby scripts/homebrew-formula-source-digest.rb",
    );
    expect(formulaIdentityCheck).toBeGreaterThan(-1);
    expect(
      harness.indexOf("--equivalent-excluding-bottle", formulaIdentityCheck),
    ).toBeGreaterThan(formulaIdentityCheck);
    expect(
      harness.indexOf(
        '"$formula_source_root/Formula/$formula.rb"',
        formulaIdentityCheck,
      ),
    ).toBeGreaterThan(formulaIdentityCheck);
    expect(
      harness.indexOf(
        '"$formula_verify_root/Formula/$formula.rb"',
        formulaIdentityCheck,
      ),
    ).toBeGreaterThan(formulaIdentityCheck);
    expect(harness).toMatch(
      /--tap-root "\$formula_verify_root"[\s\\]*--tap-repository/,
    );
    expect(harness).toMatch(/--tap-checkout-commit "\$build_tap_commit"/);
    expect(harness).toContain(
      'sidecar_formula_report="$sidecars/Kandelo/formula/$formula.json"',
    );
    expect(
      harness.indexOf("bash scripts/homebrew-generate-sidecars-from-env.sh"),
    ).toBeLessThan(
      harness.indexOf(
        'cp -p "$sidecars/Formula/$formula.rb" "$KANDELO_LOGIN_LOCAL_TAP/Formula/$formula.rb"',
      ),
    );
  });

  it("rejects any Formula drift outside the reconstructed bottle block", () => {
    const root = mkdtempSync(resolve(tmpdir(), "kandelo-formula-identity-"));
    const source = resolve(root, "source.rb");
    const bottled = resolve(root, "bottled.rb");
    const drifted = resolve(root, "drifted.rb");
    const digest = resolve(
      repositoryRoot,
      "scripts/homebrew-formula-source-digest.rb",
    );
    try {
      writeFileSync(source, 'class Ruby < Formula\n  desc "Ruby"\nend\n');
      writeFileSync(
        bottled,
        'class Ruby < Formula\n  desc "Ruby"\n\n' +
          "  bottle do\n" +
          '    root_url "https://ghcr.io/v2/example/tap"\n' +
          `    sha256 cellar: :any, wasm32_kandelo: "${"1".repeat(64)}"\n` +
          "  end\n\nend\n",
      );
      writeFileSync(
        drifted,
        readFileSync(bottled, "utf8").replace('desc "Ruby"', 'desc "Drift"'),
      );
      const equivalent = spawnSync(
        "ruby",
        [digest, "--equivalent-excluding-bottle", source, bottled],
        { encoding: "utf8" },
      );
      expect(equivalent.status, equivalent.stderr).toBe(0);
      const changed = spawnSync(
        "ruby",
        [digest, "--equivalent-excluding-bottle", source, drifted],
        { encoding: "utf8" },
      );
      expect(changed.status).toBe(1);
      expect(changed.stderr).toMatch(
        /differ outside canonical bottle metadata/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reseals the exact Formula checker between batched Formulae", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    expect(harness).toContain("KANDELO_LOGIN_XTASK_SHA256");
    expect(harness).toContain("KANDELO_LOGIN_XTASK_UID");
    expect(harness).toContain("reseal_formula_test_checker()");
    expect(harness).toContain("Formula test checker identity changed during");
    expect(harness).toContain("Formula test checker bytes changed during");
    expect(harness).toContain("Formula test checker reseal failed after");
    const sidecars = harness.indexOf(
      "bash scripts/homebrew-generate-sidecars-from-env.sh",
    );
    const reseal = harness.indexOf(
      'reseal_formula_test_checker "$formula sidecar generation"',
      sidecars,
    );
    const nextTapMutation = harness.indexOf(
      'rsync -a --delete "$sidecars/Kandelo/"',
      sidecars,
    );
    expect(sidecars).toBeGreaterThan(-1);
    expect(reseal).toBeGreaterThan(sidecars);
    expect(nextTapMutation).toBeGreaterThan(reseal);
  });

  it("binds the browser fixture to the exact generated login product report", () => {
    const creator = readFileSync(
      resolve(
        repositoryRoot,
        "scripts/create-homebrew-guest-lifecycle-fixture.ts",
      ),
      "utf8",
    );
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    const browser = readFileSync(
      resolve(
        repositoryRoot,
        "apps/browser-demos/pages/homebrew-vfs-test/main.ts",
      ),
      "utf8",
    );
    expect(creator).toContain("compositionReport");
    expect(creator).toContain('"--composition-report"');
    expect(harness).toContain(
      '--composition-report "$KANDELO_LOGIN_WORK_ROOT/composition-report.json"',
    );
    expect(creator).toContain("privilegedProduct");
    expect(creator).toContain('"--privileged-product"');
    expect(browser).toContain("loaded.compositionReportBytes");
    expect(browser).toContain("loaded.privilegedProductBytes");
    expect(browser).toContain("privilegedProduct.imageBytes");
    expect(browser).not.toContain("KANDELO_LOGIN_COMPOSITION_REPORT_PATH");
    expect(harness).toContain(
      '--privileged-product "$KANDELO_LOGIN_WORK_ROOT/main-shell.vfs.privileged.vfs"',
    );
    expect(harness).toContain(".stats.expected == 3");
    expect(harness).not.toContain(".stats.expected == 6");
  });

  it("requires the exact dependency-first Formula build sequence", () => {
    const checker = readFileSync(
      resolve(repositoryRoot, "scripts/check-homebrew-main-shell-brewfile.mjs"),
      "utf8",
    );
    expect(checker).toMatch(
      /assertExactSequence\(\s*actualClosure,\s*lock\.formula_closure,/,
    );
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    expect(harness).toContain("homebrew-formula-runtime-closure.rb");
    expect(
      harness.lastIndexOf("homebrew-formula-runtime-closure.rb"),
    ).toBeLessThan(harness.lastIndexOf("homebrew-bottle-build.sh"));
    expect(harness).toContain("dependency must precede its consumer");
  });

  it("makes exact Node and Chromium process-tree RSS evidence mandatory", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    expect(harness).toContain("KANDELO_LOGIN_RSS_REPORT");
    expect(harness).toContain('--rss-report "$KANDELO_LOGIN_RSS_REPORT"');
    expect(harness).toContain("KANDELO_LOGIN_RSS_REPORT_PATH");
    expect(harness).toMatch(/rss:\$rss\[0\]/);
    expect(harness).not.toMatch(/RSS: exact samples are recorded only when/);
  });

  it("installs exact detached JavaScript dependencies before npx consumers", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    const rootInstall = harness.indexOf("npm ci");
    const appInstall = harness.indexOf("npm --prefix apps/browser-demos ci");
    expect(rootInstall).toBeGreaterThan(
      harness.indexOf('cd "$KANDELO_LOGIN_SOURCE"'),
    );
    expect(appInstall).toBeGreaterThan(rootInstall);
    expect(rootInstall).toBeLessThan(harness.indexOf("npx tsx"));
    expect(appInstall).toBeLessThan(harness.indexOf("npx playwright"));
  });

  it("records the exact process inventory behind an RSS total", () => {
    const root = mkdtempSync(resolve(tmpdir(), "kandelo-rss-sample-"));
    const report = resolve(root, "rss.json");
    try {
      appendProcessTreeRssSample({
        phase: "unit-sample",
        roots: new Map([["vitest", process.pid]]),
        out: report,
      });
      const document = JSON.parse(readFileSync(report, "utf8"));
      expect(document).toMatchObject({
        schema: 1,
        unit: "KiB",
        scope: "exact sampled process trees",
        provenance: {
          schema: 1,
          provenance_kind: "local-test",
          promotable: false,
          published: false,
        },
      });
      expect(document.samples).toHaveLength(1);
      expect(document.samples[0].roots[0].processes).toEqual(
        expect.arrayContaining([expect.objectContaining({ pid: process.pid })]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe local harness inputs before creating output", () => {
    const harness = resolve(repositoryRoot, "scripts/run-login-stack-local.sh");
    const root = mkdtempSync(resolve(tmpdir(), "kandelo-login-harness-"));
    const tap = resolve(root, "tap");
    const tapLink = resolve(root, "tap-link");
    const existingWork = resolve(root, "existing-work");
    mkdirSync(tap);
    mkdirSync(existingWork);
    symlinkSync(tap, tapLink);
    try {
      const unknown = spawnSync("bash", [harness, "--unknown"], {
        encoding: "utf8",
      });
      expect(unknown.status).toBe(2);
      expect(unknown.stderr).toMatch(/unknown flag/);

      const existing = spawnSync(
        "bash",
        [harness, "--tap-root", tap, "--work-root", existingWork],
        { encoding: "utf8", env: { ...process.env, IN_NIX_SHELL: "pure" } },
      );
      expect(existing.status).toBe(2);
      expect(existing.stderr).toMatch(/work root must not exist/);

      const symlink = spawnSync(
        "bash",
        [
          harness,
          "--tap-root",
          tapLink,
          "--work-root",
          resolve(root, "new-work"),
        ],
        { encoding: "utf8", env: { ...process.env, IN_NIX_SHELL: "pure" } },
      );
      expect(symlink.status).toBe(2);
      expect(symlink.stderr).toMatch(/tap root must be a real directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a dirty tap before Linux build setup", () => {
    const harness = resolve(repositoryRoot, "scripts/run-login-stack-local.sh");
    const root = realpathSync(
      mkdtempSync(resolve(tmpdir(), "kandelo-login-dirty-tap-")),
    );
    const tap = resolve(root, "tap");
    mkdirSync(tap);
    try {
      for (const args of [
        ["init", "-q"],
        ["config", "user.name", "Kandelo Test"],
        ["config", "user.email", "test@kandelo.invalid"],
        ["commit", "--allow-empty", "-q", "-m", "fixture"],
      ]) {
        const git = spawnSync("git", ["-C", tap, ...args], {
          encoding: "utf8",
        });
        expect(git.status, git.stderr).toBe(0);
      }
      writeFileSync(resolve(tap, "untracked"), "must reject\n");
      const result = spawnSync(
        "bash",
        [harness, "--tap-root", tap, "--work-root", resolve(root, "new-work")],
        { encoding: "utf8", env: { ...process.env, IN_NIX_SHELL: "pure" } },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/tap checkout must be completely clean/);
      expect(() => readFileSync(resolve(root, "new-work"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires publisher authority for the Node privileged-program peer", () => {
    const host = readFileSync(
      resolve(repositoryRoot, "host/src/node-kernel-host.ts"),
      "utf8",
    );
    const worker = readFileSync(
      resolve(repositoryRoot, "host/src/node-kernel-worker-entry.ts"),
      "utf8",
    );
    expect(host).toContain("snapshotPublishedPrivilegedProgramBrowserMount");
    expect(host).toContain(
      "privilegedProduct?: PublishedPrivilegedProgramProduct",
    );
    expect(worker).toMatch(
      /kind\s*===\s*"published-privileged-program-product"/,
    );
    expect(worker).toContain('mountPoint: "/usr/bin"');
  });

  it("authenticates imported lazy seals before reading product sources", () => {
    const smoke = readFileSync(
      resolve(repositoryRoot, "scripts/homebrew-main-shell-node-smoke.ts"),
      "utf8",
    );
    const importImage = smoke.indexOf("MemoryFileSystem.fromImage");
    const authenticateSeals = smoke.indexOf(
      "await fs.verifyImportedLazyAtomicGroupSeals()",
      importImage,
    );
    const readProductSources = smoke.indexOf(
      "await createNodePrivilegedProduct",
      importImage,
    );
    expect(importImage).toBeGreaterThan(-1);
    expect(authenticateSeals).toBeGreaterThan(importImage);
    expect(readProductSources).toBeGreaterThan(authenticateSeals);
  });

  it("runs all nine product interactions through the generated login product", () => {
    const node = readFileSync(
      resolve(repositoryRoot, "scripts/homebrew-main-shell-node-smoke.ts"),
      "utf8",
    );
    const browser = readFileSync(
      resolve(
        repositoryRoot,
        "apps/browser-demos/pages/homebrew-vfs-test/main.ts",
      ),
      "utf8",
    );
    for (const source of [node, browser]) {
      expect(source).toContain("/usr/bin/login");
      expect(source).toContain("automatic-maker-login-ok");
      expect(source).toContain("maker-id-ok");
      expect(source).toContain("sudo-list-ok");
      expect(source).toContain("sudo-id-ok");
      expect(source).toContain("failed-sudo-password-ok");
      expect(source).toContain("ordinary-login-ok");
      expect(source).toContain("nosuid-copy-rejected");
      expect(source).toContain("ruby-child-${repetition}-reaped");
      expect(source).toContain("repetition <= 3");
      expect(source).toContain("ruby-stock-tools-ok");
      expect(source).toContain("brew-tap-install-execute-ok");
      for (const phase of [
        "before-boot",
        "before-ruby",
        "peak",
        "after-child-reaping",
        "after-three-repetitions",
      ]) {
        expect(source).toContain(`"${phase}"`);
      }
    }
    expect(node).toContain("spawnFromVfs");
    expect(node).toContain("pty: true");
    expect(browser).toContain("waitFrom");
  });

  it("binds versions, vfork evidence, and Ruby identities into the report", () => {
    const harness = readFileSync(
      resolve(repositoryRoot, "scripts/run-login-stack-local.sh"),
      "utf8",
    );
    const browserSpec = readFileSync(
      resolve(
        repositoryRoot,
        "apps/browser-demos/test/homebrew-login-lifecycle.spec.ts",
      ),
      "utf8",
    );
    expect(browserSpec).toContain("browser.version()");
    expect(browserSpec).toContain("KANDELO_LOGIN_BROWSER_IDENTITY_PATH");
    expect(harness).toContain("browser-identities.json");
    expect(harness).toContain("runtime_evidence:$runtime[0]");
    expect(harness).toContain("--slurpfile ruby_inventory");
    expect(harness).toContain("--slurpfile browser_identities");
    expect(harness).toContain("vfork_fork_mode_evidence");
  });
});

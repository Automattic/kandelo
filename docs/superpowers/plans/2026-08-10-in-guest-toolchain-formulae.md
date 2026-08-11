# In-Guest Toolchain Formulae Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish browser-capable admitted wasm32 Kandelo bottles for LLVM 21.1.7, the Kandelo SDK, and the selected libc++ revision, with one same-tap dependency closure that later products can select by naming `kandelo-sdk`.

**Architecture:** The tap owns two new ordinary Formulae backed by sealed tap recipes and reuses the existing `libcxx` Formula. `clang` cross-builds Clang, LLD, and the LLVM archive utilities from the LLVM 21.1.7 source archive, while `kandelo-sdk` packages the exact Kandelo wrappers, sysroot, glue, examples, and notices selected by ABI staging. The current libc++ bottle is Node-only, so the protected request must select it with `clang` and `kandelo-sdk`, compose the exact candidate `browser-main-shell`, and prove that complete closure in Node and Chromium. Promotion then projects runtime support from those protected product-evidence records into each Formula admission. Candidate and canonical bytes still use the existing ABI-staging/GHCR path; there is no alternate artifact path.

**Tech Stack:** Homebrew Ruby Formula DSL, Bash tap recipes, CMake/Ninja, LLVM 21.1.7, Kandelo wasm32 SDK, Python ABI-staging coordinator, GHCR OCI artifacts.

## Global Constraints

- Work in new clean worktrees created with the superpowers:using-git-worktrees skill; never modify the active dirty `emdash/homebrew-pr-staging-1q1w6` or `emdash/homebrew-tap-abi-staging-reconcile-1q1w6` worktrees.
- The Kandelo base must contain `d52b9bea2` (commit
  `[Pages] Preserve Phase B product authority`), including final site assembly
  from the private canonical product map; the tap base must contain `b6a8bb8`.
- Initial public language scope is C and C++ on wasm32 only.
- LLVM, Clang, LLD, resource headers, and matching host table-generation tools are version 21.1.7.
- Host CMake, Ninja, Python, and table-generation tools are build inputs only and must not appear in either runtime bottle.
- `kandelo-sdk` is the single root Formula selected by products; it depends on same-tap `clang` and `libcxx`.
- `clang` owns Clang resource headers and executable LLVM tools. `libcxx` owns target C++ headers and archives. `kandelo-sdk` owns wrappers, target sysroot, glue, examples, and SDK notices.
- The checked-in `libcxx/wasm32` metadata currently says `browser_compatible = false` and `runtime_support = ["node"]`. It is not eligible for the browser closure until protected evidence produces a new successful browser-capable admission. Reverify the existing exact bottle when its source and bytes remain valid; do not bump the Formula revision merely to change generated admission metadata.
- The current `public-candidate-browser` verification launches Playwright without the `ASSET_ROOT`, `TAP_REVISION`, and `SELECTION_PATH` inputs used by its exact-candidate cases, so those cases skip. That receipt must never authorize `browser_compatible = true`. For this closure, only successful protected `browser-main-shell` product evidence that binds the exact three candidate layers may authorize the browser claim.
- Every source URL and digest is closed. The SDK source lock names the exact Kandelo commit used by the staging request.
- Bottle payloads publish only through the ABI-qualified candidate and canonical GHCR namespaces. Do not add a GitHub Release compiler archive or a compiler VFS image.
- Generated programs may use ordinary C/C++ runtime behavior, but fork-family support is outside this release because no in-guest fork instrumenter is shipped.
- Never hand-edit generated Formula bottle blocks, `Kandelo/formula/*.json`, or `Kandelo/metadata.json`; the protected publisher owns those projections.
- Run every command that needs Kandelo build dependencies through `scripts/dev-shell.sh`.

---

## Delivery Order

1. Land Tasks 1–4 in a tap pull request and the wrapper/source-request work in a matching Kandelo pull request.
2. Before dispatching reconciliation, complete the shell plan through protected Node evidence and the Pages plan through protected browser evidence. The exact Kandelo request head must contain the `browser-main-shell` lazy selection plus `main-shell-toolchain-node` and `main-shell-toolchain-browser` definitions.
3. Let staging select and verify `libcxx/wasm32`, build and verify `clang`, then `kandelo-sdk`, compose the candidate shell, and publish the exact Node/browser product-evidence record.
4. Merge source changes in the staging-prescribed order. Promotion may then project `runtime_support = ["node", "browser"]` and `browser_compatible = true`, publish canonical layers, and issue immutable admissions.
5. Finish canonical shell locks, Pages readiness, exact-seven final-site
   assembly through the private product map, and public activation only after
   anonymous readback succeeds for all three admissions.

If the hosted Pages canary runs while step 3 is still waiting on promotion, its
bounded hold result is diagnostic only. Do not call it ready or use it for
activation; rerun the canary after step 4 and require the exact post-admission
ready result.

## File and Interface Map

### Tap files

- Create `Formula/clang.rb`: public LLVM tool Formula and installed layout.
- Create `Kandelo/recipes/clang/recipe.json`: sealed recipe inventory.
- Create `Kandelo/recipes/clang/build.sh`: isolated cross-build entrypoint.
- Create `Kandelo/recipes/clang/patches/0001-kandelo-deterministic-runtime.patch`: remove unavailable random-device behavior.
- Create `Kandelo/recipes/clang/patches/0002-kandelo-vfs-output.patch`: make LLVM output commit correctly on Kandelo VFS.
- Create `Kandelo/recipes/clang/patches/0003-kandelo-wasm-only-lld.patch`: retain only the Wasm LLD driver.
- Create `Formula/kandelo-sdk.rb`: SDK root Formula and dependency closure.
- Create `Kandelo/recipes/kandelo-sdk/recipe.json`: sealed SDK recipe inventory.
- Create `Kandelo/recipes/kandelo-sdk/build.sh`: package the exact SDK tree into the Formula prefix.
- Create `Kandelo/recipes/kandelo-sdk/source-lock.json`: exact Kandelo source and ABI identity.
- Modify `Kandelo/staging/formula-build-inputs.toml`: declare complete source custody for both Formulae.
- Regenerate `Kandelo/staging/generated/formula-build-inputs.json` with the protected policy generator.
- Modify `Kandelo/formula_support/test/kandelo_formula_support_test.rb`: static Formula and recipe contract tests.
- Modify `scripts/abi_staging/tests/test_formula_inventory.py`: inventory coverage for the two new Formulae.
- Modify `Kandelo/staging/promotion-policy.toml`: bind the three Formula runtime claims to exact protected `browser-main-shell` product evidence.
- Modify `.github/workflows/abi-staging-reconcile.yml`: make promotion consume the published product-evidence locators.
- Modify `scripts/abi_staging/handoff.py`: carry each selected Formula's direct same-architecture dependency identities into the authenticated VFS composition input.
- Modify `scripts/abi_staging/promotion.py`, `tap_metadata.py`, `records.py`, and `cli.py`: derive, carry, publish, and revalidate evidence-backed runtime claims.
- Modify `scripts/abi_staging/tests/test_handoff.py`, `test_promotion.py`, `test_tap_metadata.py`, `test_records.py`, and `test_cli.py`, plus `scripts/check_abi_staging_workflows.rb`: fail closed on absent, skipped, mismatched, or unrelated dependencies/product evidence.

### Kandelo source files consumed by the tap

- Modify `sdk/kandelo/bin/wasm32posix-cc`, `wasm32posix-c++`, `wasm32posix-ar`, `wasm32posix-ranlib`, `wasm32posix-nm`, `wasm32posix-strip`, `wasm32posix-configure`, and `wasm32posix-pkg-config`: make the checked-in scripts the Formula-layout wrapper authority.
- Modify `sdk/kandelo/README.md`: document the Formula opt-path defaults and supported overrides.
- Create `sdk/test/kandelo-wrappers.test.ts`: keep the wrapper layout independent of any developer workstation or browser transport.
- Modify `docs/homebrew-publishing.md`: distinguish per-Formula candidate verification from product evidence that is allowed to set runtime-support metadata.
- Reuse `sdk/config.site` and `libc/glue`.
- Reuse the dev-shell-produced `sysroot` only through the sealed staging build input.
- Use `602d179e0:packages/registry/clang/build-clang.sh` only as a source of validated LLVM porting knowledge; do not carry its local checkout/build directories or project-registry transport.

### Stable runtime layout produced by the Formulae

~~~text
/opt/kandelo/homebrew/opt/clang/libexec/llvm/bin/clang
/opt/kandelo/homebrew/opt/clang/libexec/llvm/bin/clang++
/opt/kandelo/homebrew/opt/clang/libexec/llvm/bin/wasm-ld
/opt/kandelo/homebrew/opt/clang/libexec/llvm/bin/llvm-{ar,ranlib,nm}
/opt/kandelo/homebrew/opt/clang/libexec/llvm/lib/clang/21/include

/opt/kandelo/homebrew/opt/libcxx/include/c++/v1
/opt/kandelo/homebrew/opt/libcxx/lib/libc++.a
/opt/kandelo/homebrew/opt/libcxx/lib/libc++abi.a

/opt/kandelo/homebrew/opt/kandelo-sdk/libexec/wasm32posix/sysroot
/opt/kandelo/homebrew/opt/kandelo-sdk/libexec/wasm32posix/glue
/opt/kandelo/homebrew/opt/kandelo-sdk/libexec/wasm32posix/glue-objects
/opt/kandelo/homebrew/opt/kandelo-sdk/bin/wasm32posix-*
/opt/kandelo/homebrew/opt/kandelo-sdk/bin/{cc,c++,ar,ranlib,nm}
/opt/kandelo/homebrew/opt/kandelo-sdk/share/kandelo-sdk
~~~

The shell-integration plan creates the generic public compatibility links `/usr/lib/llvm` and `/usr/wasm32posix` from these Formula-owned opt paths.

### Formula dependency graph

~~~text
kandelo-sdk
├── clang
│   └── libcxx
└── libcxx
~~~

## Task 1: Seal the Clang tap recipe and Formula contract

**Files:**

- Create: `Formula/clang.rb`
- Create: `Kandelo/recipes/clang/recipe.json`
- Create: `Kandelo/recipes/clang/build.sh`
- Create: `Kandelo/recipes/clang/patches/0001-kandelo-deterministic-runtime.patch`
- Create: `Kandelo/recipes/clang/patches/0002-kandelo-vfs-output.patch`
- Create: `Kandelo/recipes/clang/patches/0003-kandelo-wasm-only-lld.patch`
- Modify: `Kandelo/formula_support/test/kandelo_formula_support_test.rb`

**Interfaces:**

- Consumes: LLVM source archive `llvm-project-21.1.7.src.tar.xz` with SHA-256 `e5b65fd79c95c343bb584127114cb2d252306c1ada1e057899b6aacdd445899e`; `WASM_POSIX_DEP_LIBCXX_DIR`; `WASM_POSIX_SYSROOT`; `WASM_POSIX_LLVM_DIR`; `WASM_POSIX_DEP_OUT_DIR`.
- Produces: Formula `kandelo-dev/tap-core/clang`; executable paths under `libexec/llvm/bin`; resource headers under `libexec/llvm/lib/clang/21/include`; no host tablegen executable in the install prefix.

- [ ] **Step 1: Write failing static contract tests**

Append focused Minitest cases that parse the Formula and recipe:

~~~ruby
def test_clang_formula_uses_a_sealed_tap_recipe
  formula = (TAP_ROOT/"Formula/clang.rb").read
  assert_includes formula, "class Clang < Formula"
  assert_includes formula, "KANDELO_TAP_RECIPE = true"
  assert_includes formula, 'version "21.1.7"'
  assert_includes formula, 'depends_on "kandelo-dev/tap-core/libcxx"'
  assert_includes formula, 'kandelo_validate_wasm_artifact'
  refute_includes formula, "KANDELO_REGISTRY_BRIDGE"
end

def test_clang_recipe_has_only_reviewed_runtime_outputs
  recipe = JSON.parse((TAP_ROOT/"Kandelo/recipes/clang/recipe.json").read)
  assert_equal 1, recipe.fetch("schema")
  assert_equal "build.sh", recipe.fetch("entrypoint")
  assert_equal ["kandelo-dev/tap-core/libcxx"], recipe.fetch("dependencies")
  names = recipe.fetch("files").map { |entry| entry.fetch("path") }
  assert_equal [
    "build.sh",
    "patches/0001-kandelo-deterministic-runtime.patch",
    "patches/0002-kandelo-vfs-output.patch",
    "patches/0003-kandelo-wasm-only-lld.patch",
  ], names
end
~~~

- [ ] **Step 2: Run the tests and confirm the missing Formula/recipe failure**

Run:

~~~bash
ruby -Itest Kandelo/formula_support/test/kandelo_formula_support_test.rb \
  -n '/clang_formula|clang_recipe/'
~~~

Expected: FAIL because `Formula/clang.rb` and `Kandelo/recipes/clang/recipe.json` do not exist.

- [ ] **Step 3: Add the Formula with the closed install layout**

Use this Formula shape; the recipe digest is the exact SHA-256 of the completed canonical `recipe.json`:

~~~ruby
require (Tap.fetch("kandelo-dev", "tap-core").path/
  "Kandelo/formula_support/kandelo_formula_support").to_s

class Clang < Formula
  include KandeloFormulaSupport

  KANDELO_TAP_RECIPE = true

  desc "LLVM C and C++ compiler toolchain for Kandelo"
  homepage "https://llvm.org/"
  url "https://github.com/llvm/llvm-project/releases/download/llvmorg-21.1.7/llvm-project-21.1.7.src.tar.xz"
  version "21.1.7"
  sha256 "e5b65fd79c95c343bb584127114cb2d252306c1ada1e057899b6aacdd445899e"
  license "Apache-2.0" => { with: "LLVM-exception" }

  depends_on "cmake" => :build
  depends_on "ninja" => :build
  depends_on "python@3.13" => :build
  depends_on "llvm@21" => :build
  depends_on KandeloFormulaSupport::BinaryenRequirement => :build
  depends_on KandeloFormulaSupport::WabtRequirement => [:build, :test]
  depends_on "kandelo-dev/tap-core/libcxx"

  skip_clean "libexec/llvm/bin"

  def install
    kandelo_require_arch!("wasm32")
    out = kandelo_build_tap_recipe(
      manifest_sha256: CLANG_RECIPE_MANIFEST_SHA256,
      script_env: {
        "WASM_POSIX_DEP_CMAKE" => formula_opt_bin("cmake")/"cmake",
        "WASM_POSIX_DEP_NINJA" => formula_opt_bin("ninja")/"ninja",
        "WASM_POSIX_DEP_PYTHON" => formula_opt_bin("python@3.13")/"python3.13",
        "WASM_POSIX_DEP_LLVM21_DIR" => formula_opt_prefix("llvm@21"),
      },
    )
    llvm = libexec/"llvm"
    llvm.install out/"bin", out/"lib"
    %w[clang clang++ wasm-ld llvm-ar llvm-ranlib llvm-nm].each do |name|
      kandelo_validate_wasm_artifact llvm/"bin"/name, fork: :forbidden
      bin.install_symlink llvm/"bin"/name
    end
    (share/"licenses/clang").install out/"LICENSE.TXT"
  end

  test do
    assert_match(/clang version 21\.1\.7/,
      kandelo_run_wasm(bin/"clang", ["--version"]))
    assert_match(/LLD 21\.1\.7/,
      kandelo_run_wasm(bin/"wasm-ld", ["--version"]))
    %w[llvm-ar llvm-ranlib llvm-nm].each do |name|
      assert_match(/LLVM version 21\.1\.7/,
        kandelo_run_wasm(bin/name, ["--version"]))
    end
    assert_path_exists share/"licenses/clang/LICENSE.TXT"
    refute_path_exists libexec/"llvm/bin/llvm-tblgen"
    refute_path_exists libexec/"llvm/bin/clang-tblgen"
  end
end
~~~

Define `CLANG_RECIPE_MANIFEST_SHA256` as a 64-character literal immediately below `KANDELO_TAP_RECIPE` after Step 5 computes it. Do not commit a zero digest.

- [ ] **Step 4: Port the prototype patches into reviewable patch files and build one wasm-only toolchain**

`build.sh` must:

1. require `wasm32` and every declared input;
2. apply the three patch files with `patch -p1`;
3. assert both `llvm-tblgen` and `clang-tblgen` report LLVM 21;
4. configure only the WebAssembly backend, Clang, and Wasm LLD;
5. install only the six runtime tools, Clang resource headers, and LLVM license.

Before configuring, bind the cross-compiler wrappers to the selected dependency rather than an ambient SDK copy:

~~~bash
test -f "$WASM_POSIX_DEP_LIBCXX_DIR/lib/libc++.a"
test -f "$WASM_POSIX_DEP_LIBCXX_DIR/lib/libc++abi.a"
export WASM_POSIX_LIBCXX_DIR="$WASM_POSIX_DEP_LIBCXX_DIR"
~~~

Use these core configure flags:

~~~bash
"$WASM_POSIX_DEP_CMAKE" -G Ninja \
  -S "$WASM_POSIX_DEP_SOURCE_DIR/llvm" \
  -B "$WASM_POSIX_DEP_WORK_DIR/wasm32" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_SYSTEM_NAME=Generic \
  -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
  -DCMAKE_C_COMPILER=wasm32posix-cc \
  -DCMAKE_CXX_COMPILER=wasm32posix-c++ \
  -DCMAKE_AR=wasm32posix-ar \
  -DCMAKE_RANLIB=wasm32posix-ranlib \
  -DCMAKE_NM=wasm32posix-nm \
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
  -DLLVM_TABLEGEN="$WASM_POSIX_DEP_LLVM21_DIR/bin/llvm-tblgen" \
  -DCLANG_TABLEGEN="$WASM_POSIX_DEP_LLVM21_DIR/bin/clang-tblgen" \
  -DLLVM_ENABLE_PROJECTS='clang;lld' \
  -DLLVM_TARGETS_TO_BUILD=WebAssembly \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-unknown \
  -DLLVM_HOST_TRIPLE=wasm32-unknown-unknown \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_ENABLE_ZLIB=OFF \
  -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF \
  -DLLVM_ENABLE_TERMINFO=OFF \
  -DLLVM_ENABLE_LIBEDIT=OFF \
  -DLLVM_ENABLE_EH=OFF \
  -DLLVM_ENABLE_RTTI=OFF \
  -DCLANG_ENABLE_ARCMT=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
  -DCLANG_ENABLE_PLUGIN_SUPPORT=OFF

"$WASM_POSIX_DEP_CMAKE" --build "$WASM_POSIX_DEP_WORK_DIR/wasm32" \
  --target clang lld llvm-ar llvm-ranlib llvm-nm -- -j1
~~~

Copy only the reviewed runtime surface into the recipe output:

~~~bash
build="$WASM_POSIX_DEP_WORK_DIR/wasm32"
out="$WASM_POSIX_DEP_OUT_DIR"
mkdir -p "$out/bin" "$out/lib/clang/21"
for name in clang wasm-ld llvm-ar llvm-ranlib llvm-nm; do
  test -f "$build/bin/$name"
  cp "$build/bin/$name" "$out/bin/$name"
  chmod 0755 "$out/bin/$name"
done
ln -s clang "$out/bin/clang++"
cp -R "$build/lib/clang/21/include" "$out/lib/clang/21/include"
cp "$WASM_POSIX_DEP_SOURCE_DIR/llvm/LICENSE.TXT" "$out/LICENSE.TXT"
chmod 0644 "$out/LICENSE.TXT"
~~~

The patch files must encode these exact behavioral changes:

- replace `std::random_device`-seeded backoff and LLD shuffling with deterministic constants on Wasm;
- treat the Kandelo VFS as local in `llvm/lib/Support/Unix/Path.inc`;
- make `FileOutputBuffer` explicitly write mapped bytes before unmap on Wasm;
- disable `F_mmap` in the Wasm LLD writer;
- remove COFF, ELF, Mach-O, and MinGW drivers and links from the built `lld` executable.

At the end of `build.sh`, reject undeclared runtime files:

~~~bash
runtime_files="$WASM_POSIX_DEP_WORK_DIR/runtime-files.txt"
find "$WASM_POSIX_DEP_OUT_DIR" -type f -print | \
  LC_ALL=C sort > "$runtime_files"
for forbidden in llvm-tblgen clang-tblgen cmake ninja python; do
  if grep -F "/$forbidden" "$runtime_files"; then
    echo "clang runtime contains build-host tool $forbidden" >&2
    exit 1
  fi
done
~~~

Walk every output entry without following symlinks and reject anything outside
`bin/{clang,clang++,wasm-ld,llvm-ar,llvm-ranlib,llvm-nm}`,
`lib/clang/21/include/**`, and `LICENSE.TXT`. Require `clang++` to be the single
relative symlink `clang`, every executable to be mode `0755`, and every header
or notice to be a regular mode-`0644` file. The broad `find`/forbidden-name
check above is supplemental; it is not the whitelist.

- [ ] **Step 5: Generate and seal the recipe manifest**

Generate canonical `recipe.json` from the four recipe files with this exact command. It records the schema, dependency contract, entrypoint, mode, SHA-256, and byte count in ordinal path order:

~~~bash
python3 - <<'PY'
from hashlib import sha256
from pathlib import Path
import json
import stat

root = Path("Kandelo/recipes/clang")
paths = [
    "build.sh",
    "patches/0001-kandelo-deterministic-runtime.patch",
    "patches/0002-kandelo-vfs-output.patch",
    "patches/0003-kandelo-wasm-only-lld.patch",
]
files = []
for relative in sorted(paths):
    path = root / relative
    body = path.read_bytes()
    files.append({
        "bytes": len(body),
        "mode": f"{stat.S_IMODE(path.stat().st_mode):04o}",
        "path": relative,
        "sha256": sha256(body).hexdigest(),
    })
document = {
    "schema": 1,
    "dependencies": ["kandelo-dev/tap-core/libcxx"],
    "entrypoint": "build.sh",
    "files": files,
}
(root / "recipe.json").write_text(
    json.dumps(document, indent=2) + "\n",
    encoding="utf-8",
)
PY
~~~

Then calculate:

~~~bash
clang_recipe_sha="$(python3 -c 'from hashlib import sha256; from pathlib import Path; print(sha256(Path("Kandelo/recipes/clang/recipe.json").read_bytes()).hexdigest())')"
test "${#clang_recipe_sha}" -eq 64
~~~

Use `apply_patch` to set `CLANG_RECIPE_MANIFEST_SHA256` to that exact value. Re-run the manifest generator and require `git diff --exit-code Kandelo/recipes/clang/recipe.json` so the Formula digest and manifest cannot drift.

- [ ] **Step 6: Run the focused tests and Formula audits**

Run:

~~~bash
ruby -Itest Kandelo/formula_support/test/kandelo_formula_support_test.rb \
  -n '/clang_formula|clang_recipe/'
ruby -c Formula/clang.rb
python3 -m scripts.abi_staging.cli policy-check --tap-root "$PWD"
~~~

Expected: all commands exit 0.

- [ ] **Step 7: Commit the Clang Formula**

~~~bash
git add Formula/clang.rb Kandelo/recipes/clang \
  Kandelo/formula_support/test/kandelo_formula_support_test.rb
git commit -m "clang: add Kandelo LLVM 21 toolchain formula"
~~~

## Task 2: Package the exact Kandelo SDK as the dependency root

**Files:**

- Create: `Formula/kandelo-sdk.rb`
- Create: `Kandelo/recipes/kandelo-sdk/recipe.json`
- Create: `Kandelo/recipes/kandelo-sdk/build.sh`
- Create: `Kandelo/recipes/kandelo-sdk/source-lock.json`
- Modify: `Kandelo/formula_support/test/kandelo_formula_support_test.rb`
- Modify in the matching Kandelo PR: `sdk/kandelo/bin/wasm32posix-cc`
- Modify in the matching Kandelo PR: `sdk/kandelo/bin/wasm32posix-c++`
- Modify in the matching Kandelo PR: `sdk/kandelo/bin/wasm32posix-ar`
- Modify in the matching Kandelo PR: `sdk/kandelo/bin/wasm32posix-ranlib`
- Modify in the matching Kandelo PR: `sdk/kandelo/bin/wasm32posix-nm`
- Modify in the matching Kandelo PR: `sdk/kandelo/bin/wasm32posix-strip`
- Modify in the matching Kandelo PR: `sdk/kandelo/bin/wasm32posix-configure`
- Modify in the matching Kandelo PR: `sdk/kandelo/bin/wasm32posix-pkg-config`
- Create in the matching Kandelo PR: `sdk/kandelo/notices/MUSL-COPYRIGHT`
- Modify in the matching Kandelo PR: `sdk/kandelo/README.md`
- Create in the matching Kandelo PR: `sdk/test/kandelo-wrappers.test.ts`

**Interfaces:**

- Consumes: exact clean Kandelo source archive; `WASM_POSIX_SYSROOT`; `WASM_POSIX_GLUE_DIR`; `WASM_POSIX_DEP_CLANG_DIR`; `WASM_POSIX_DEP_LIBCXX_DIR`.
- Produces: Formula `kandelo-dev/tap-core/kandelo-sdk`; wrappers and conventional aliases in `bin`; SDK tree in `libexec/wasm32posix`; examples/notices in `share/kandelo-sdk`.
- Wrapper defaults: LLVM root `/opt/kandelo/homebrew/opt/clang/libexec/llvm`; SDK root `/opt/kandelo/homebrew/opt/kandelo-sdk/libexec/wasm32posix`; libc++ root `/opt/kandelo/homebrew/opt/libcxx`. Supported overrides are exactly `WASM_POSIX_LLVM_DIR`, `WASM_POSIX_SYSROOT`, `WASM_POSIX_GLUE_DIR`, `WASM_POSIX_GLUE_OBJ_DIR`, `WASM_POSIX_CLANG_RESOURCE_DIR`, and `WASM_POSIX_LIBCXX_DIR`.

- [ ] **Step 1: Write failing SDK layout and dependency tests**

~~~ruby
def test_kandelo_sdk_formula_is_the_toolchain_dependency_root
  formula = (TAP_ROOT/"Formula/kandelo-sdk.rb").read
  assert_includes formula, "KANDELO_TAP_RECIPE = true"
  assert_includes formula, 'depends_on "kandelo-dev/tap-core/clang"'
  assert_includes formula, 'depends_on "kandelo-dev/tap-core/libcxx"'
  refute_includes formula, "KANDELO_REGISTRY_BRIDGE"
  assert_includes formula, '%w[cc c++ ar ranlib nm]'
end

def test_kandelo_sdk_source_lock_is_exact
  lock = JSON.parse((TAP_ROOT/
    "Kandelo/recipes/kandelo-sdk/source-lock.json").read)
  assert_equal 1, lock.fetch("schema")
  assert_match(/\A[0-9a-f]{40}\z/,
    lock.fetch("source").fetch("commit"))
  assert_match(/\A[0-9a-f]{64}\z/,
    lock.fetch("source").fetch("archive_sha256"))
  assert_match(/\A[0-9a-f]{40}\z/,
    lock.fetch("source").fetch("tree"))
  assert_equal(
    [
      "COPYING", "COPYING.runtime", "LICENSE", "libc/glue",
      "sdk/config.site", "sdk/kandelo",
    ],
    lock.fetch("paths").map { |entry| entry.fetch("path") },
  )
  lock.fetch("paths").each do |entry|
    assert_match(/\A[0-9a-f]{40}\z/, entry.fetch("git_object"))
    assert_match(/\A[0-9a-f]{64}\z/, entry.fetch("ledger_sha256"))
  end
  assert_operator lock.fetch("kandelo_abi"), :>, 0
end
~~~

Create `sdk/test/kandelo-wrappers.test.ts` with a static contract that initially fails against the prototype C++ layout:

~~~typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sdkRoot = fileURLToPath(new URL("..", import.meta.url));
const wrapper = (name: string) => readFileSync(
  resolve(sdkRoot, "kandelo/bin", name),
  "utf8",
);

describe("Kandelo in-guest wrappers", () => {
  it("uses stable Formula-owned compiler, SDK, and libc++ roots", () => {
    const cc = wrapper("wasm32posix-cc");
    expect(cc).toContain("/opt/kandelo/homebrew/opt/clang/libexec/llvm");
    expect(cc).toContain("/opt/kandelo/homebrew/opt/kandelo-sdk/libexec/wasm32posix");
    expect(cc).toContain("/opt/kandelo/homebrew/opt/libcxx");
    expect(cc).toContain("-nostdinc++");
    expect(cc).toContain("include/c++/v1");
    expect(cc).toContain("lib/libc++.a");
    expect(cc).toContain("lib/libc++abi.a");
  });

  it("contains no workstation path or browser transport", () => {
    const text = [
      "wasm32posix-cc", "wasm32posix-c++", "wasm32posix-ar",
      "wasm32posix-ranlib", "wasm32posix-nm", "wasm32posix-strip",
      "wasm32posix-configure", "wasm32posix-pkg-config",
    ].map(wrapper).join("\n");
    expect(text).not.toMatch(/\/Users\/|\/nix\/store\/|https?:\/\//u);
  });

  it("vendors the exact pinned musl notice into the source archive", () => {
    expect(readFileSync(
      resolve(sdkRoot, "kandelo/notices/MUSL-COPYRIGHT"),
      "utf8",
    )).toBe(readFileSync(resolve(sdkRoot, "../libc/musl/COPYRIGHT"), "utf8"));
  });
});
~~~

- [ ] **Step 2: Run the tests and confirm the missing SDK Formula failure**

Run:

~~~bash
ruby -Itest Kandelo/formula_support/test/kandelo_formula_support_test.rb \
  -n '/kandelo_sdk_formula|kandelo_sdk_source_lock/'
kandelo_worktree="${KANDELO_WORKTREE:?set to the matching clean Kandelo worktree}"
(
  cd "$kandelo_worktree"
  scripts/dev-shell.sh bash -euo pipefail -c \
    'cd sdk && npx vitest run test/kandelo-wrappers.test.ts'
)
~~~

Expected: the tap test fails because the Formula and source lock do not exist, and the SDK test fails because the prototype still links libc++ from the SDK sysroot.

- [ ] **Step 3: Productionize the checked-in Kandelo wrappers**

Update all eight scripts and `sdk/kandelo/README.md` together. Copy the exact
pinned `libc/musl/COPYRIGHT` bytes to
`sdk/kandelo/notices/MUSL-COPYRIGHT`; this tracked notice is required because a
GitHub source archive records the musl submodule commit but does not contain
the submodule's files. The equality test above preserves its provenance. The
compiler driver must derive these defaults without inspecting its own
host-side install location:

~~~bash
LLVM_DIR="${WASM_POSIX_LLVM_DIR:-/opt/kandelo/homebrew/opt/clang/libexec/llvm}"
SDK_DIR="/opt/kandelo/homebrew/opt/kandelo-sdk/libexec/wasm32posix"
SYSROOT="${WASM_POSIX_SYSROOT:-$SDK_DIR/sysroot}"
GLUE_DIR="${WASM_POSIX_GLUE_DIR:-$SDK_DIR/glue}"
GLUE_OBJ_DIR="${WASM_POSIX_GLUE_OBJ_DIR:-$SDK_DIR/glue-objects}"
RESOURCE_DIR="${WASM_POSIX_CLANG_RESOURCE_DIR:-$LLVM_DIR/lib/clang/21}"
LIBCXX_DIR="${WASM_POSIX_LIBCXX_DIR:-/opt/kandelo/homebrew/opt/libcxx}"
~~~

Resolve Clang, LLD, and LLVM utilities only below `$LLVM_DIR/bin` unless the corresponding environment override deliberately changes that root. On C++ compilation add `-nostdinc++ -isystem "$LIBCXX_DIR/include/c++/v1"`; on C++ link use absolute `$LIBCXX_DIR/lib/libc++.a` and `$LIBCXX_DIR/lib/libc++abi.a`. Never copy those headers or archives into the SDK sysroot. `/usr/lib/llvm` and `/usr/wasm32posix` remain shell compatibility paths created by the shell plan, but they are not wrapper defaults.

Run the SDK test until it passes, then commit these Kandelo-owned sources before capturing the source lock:

~~~bash
kandelo_worktree="${KANDELO_WORKTREE:?set to the matching clean Kandelo worktree}"
(
  cd "$kandelo_worktree"
  scripts/dev-shell.sh bash -euo pipefail -c \
    'cd sdk && npx vitest run test/kandelo-wrappers.test.ts'
  git add sdk/kandelo/bin sdk/kandelo/notices/MUSL-COPYRIGHT \
    sdk/kandelo/README.md \
    sdk/test/kandelo-wrappers.test.ts
  git commit -m "sdk: stabilize in-guest Formula toolchain paths"
)
~~~

- [ ] **Step 4: Capture one exact Kandelo source identity**

From the clean Kandelo implementation worktree, enter
`scripts/dev-shell.sh bash` first, then run:

~~~bash
kandelo_commit="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
kandelo_tree="$(git rev-parse 'HEAD^{tree}')"
kandelo_url="https://github.com/Automattic/kandelo/archive/$kandelo_commit.tar.gz"
sdk_source_tmp="$(mktemp -d)"
trap 'rm -rf -- "$sdk_source_tmp"' EXIT
source_archive="$sdk_source_tmp/kandelo-sdk-source.tar.gz"
curl --fail --location --proto '=https' --tlsv1.2 \
  "$kandelo_url" --output "$source_archive"
kandelo_sha="$(python3 -c 'from hashlib import sha256; import sys; from pathlib import Path; print(sha256(Path(sys.argv[1]).read_bytes()).hexdigest())' "$source_archive")"
kandelo_abi="$(sed -n 's/^pub const ABI_VERSION: u32 = \([0-9][0-9]*\);/\1/p' \
  crates/shared/src/lib.rs)"
test "${#kandelo_commit}" -eq 40
test "${#kandelo_tree}" -eq 40
test "${#kandelo_sha}" -eq 64
test -n "$kandelo_abi"
~~~

For each path, record the exact Git object plus a SHA-256 over Git's NUL-delimited recursive tree ledger:

~~~bash
for source_path in COPYING COPYING.runtime LICENSE libc/glue \
  sdk/config.site sdk/kandelo; do
  git_object="$(git rev-parse "HEAD:$source_path")"
  ledger_sha256="$(git ls-tree -r -z --full-tree HEAD -- "$source_path" | \
    python3 -c 'from hashlib import sha256; import sys; print(sha256(sys.stdin.buffer.read()).hexdigest())')"
  test "${#git_object}" -eq 40
  test "${#ledger_sha256}" -eq 64
  printf '%s %s %s\n' "$source_path" "$git_object" "$ledger_sha256"
done
~~~

Use `apply_patch` to record those exact values in `source-lock.json` and the Formula `url`/`sha256`. The JSON key order and types are fixed: top-level `schema`, `source`, `kandelo_abi`, and `paths`; `source` contains `repository`, `commit`, `tree`, `archive_url`, and `archive_sha256`; each ordinal path entry contains `path`, `git_object`, and `ledger_sha256`. Use the captured literals from the commands above and require the Minitest schema assertions to pass before committing.

- [ ] **Step 5: Add the SDK Formula**

Use this installation contract:

~~~ruby
class KandeloSdk < Formula
  include KandeloFormulaSupport

  KANDELO_TAP_RECIPE = true

  desc "C and C++ development kit for Kandelo"
  homepage "https://github.com/Automattic/kandelo"
  version "0.1.0"
  license all_of: [
    "GPL-2.0-or-later",
    "MIT",
  ]

  depends_on KandeloFormulaSupport::WabtRequirement => :test
  depends_on "kandelo-dev/tap-core/clang"
  depends_on "kandelo-dev/tap-core/libcxx"

  def install
    kandelo_require_arch!("wasm32")
    out = kandelo_build_tap_recipe(
      manifest_sha256: KANDELO_SDK_RECIPE_MANIFEST_SHA256,
      script_env: {},
    )
    bin.install Dir[out/"bin/*"]
    libexec.install out/"wasm32posix"
    (share/"kandelo-sdk").install Dir[out/"share/kandelo-sdk/*"]
    %w[cc c++ ar ranlib nm].each do |name|
      target = "wasm32posix-#{name}"
      bin.install_symlink target => name
    end
  end

  test do
    %w[
      wasm32posix-cc wasm32posix-c++ wasm32posix-ar
      wasm32posix-ranlib wasm32posix-nm cc c++ ar ranlib nm
    ].each { |name| assert_path_exists bin/name }
    assert_path_exists libexec/"wasm32posix/sysroot/lib/libc.a"
    assert_path_exists libexec/"wasm32posix/glue/channel_syscall.c"
    assert_path_exists libexec/"wasm32posix/glue-objects/channel_syscall.o"
    assert_path_exists share/"kandelo-sdk/examples/hello.c"
    assert_path_exists share/"kandelo-sdk/licenses/KANDELO-GPL-2.0"
    assert_path_exists share/"kandelo-sdk/licenses/KANDELO-RUNTIME-MIT"
    assert_path_exists share/"kandelo-sdk/licenses/KANDELO-LICENSING"
    assert_path_exists share/"kandelo-sdk/licenses/MUSL-COPYRIGHT"
    wrappers = (bin/"wasm32posix-cc").read + (bin/"wasm32posix-c++").read
    refute_match(%r{/Users/|/private/tmp/|/home/runner/|/nix/store/}, wrappers)
    refute_path_exists libexec/"wasm32posix/sysroot/include/c++"
    refute_path_exists libexec/"wasm32posix/sysroot/lib/libc++.a"
    refute_path_exists libexec/"wasm32posix/sysroot/lib/libc++abi.a"
  end
end
~~~

Set the Formula URL and SHA to Step 4’s exact values, and set `KANDELO_SDK_RECIPE_MANIFEST_SHA256` after Step 7.

- [ ] **Step 6: Implement the sealed SDK packaging recipe**

`build.sh` copies only reviewed paths and compiles glue objects with the target compiler:

~~~bash
set -euo pipefail
test "$WASM_POSIX_DEP_TARGET_ARCH" = wasm32
test -f "$WASM_POSIX_SYSROOT/lib/libc.a"
test -x "$WASM_POSIX_DEP_CLANG_DIR/libexec/llvm/bin/clang"
test -x "$WASM_POSIX_DEP_CLANG_DIR/libexec/llvm/bin/wasm-ld"
test -f "$WASM_POSIX_DEP_LIBCXX_DIR/include/c++/v1/vector"
test -f "$WASM_POSIX_DEP_LIBCXX_DIR/lib/libc++.a"
test -f "$WASM_POSIX_DEP_LIBCXX_DIR/lib/libc++abi.a"
test -d "$WASM_POSIX_DEP_SOURCE_DIR/sdk/kandelo/bin"
test -d "$WASM_POSIX_DEP_SOURCE_DIR/libc/glue"
test -f "$WASM_POSIX_DEP_SOURCE_DIR/COPYING"
test -f "$WASM_POSIX_DEP_SOURCE_DIR/COPYING.runtime"
test -f "$WASM_POSIX_DEP_SOURCE_DIR/LICENSE"
test -f "$WASM_POSIX_DEP_SOURCE_DIR/sdk/kandelo/notices/MUSL-COPYRIGHT"

out="$WASM_POSIX_DEP_OUT_DIR"
sdk="$out/wasm32posix"
mkdir -p "$out/bin" "$sdk/sysroot" "$sdk/glue" \
  "$sdk/glue-objects" "$out/share/kandelo-sdk/examples" \
  "$out/share/kandelo-sdk/licenses"

cp -R "$WASM_POSIX_SYSROOT/." "$sdk/sysroot/"
rm -rf -- "$sdk/sysroot/include/c++"
rm -f -- "$sdk/sysroot/lib/libc++.a" \
  "$sdk/sysroot/lib/libc++abi.a" \
  "$sdk/sysroot/lib/libc++experimental.a"
cp -R "$WASM_POSIX_DEP_SOURCE_DIR/libc/glue/." "$sdk/glue/"
cp "$WASM_POSIX_DEP_SOURCE_DIR/sdk/config.site" "$sdk/config.site"
cp "$WASM_POSIX_DEP_SOURCE_DIR/sdk/kandelo/bin/"* "$out/bin/"

export WASM_POSIX_LLVM_DIR="$WASM_POSIX_DEP_CLANG_DIR/libexec/llvm"
export WASM_POSIX_SYSROOT
export WASM_POSIX_GLUE_DIR="$sdk/glue"
export WASM_POSIX_GLUE_OBJ_DIR="$sdk/glue-objects"
export WASM_POSIX_CLANG_RESOURCE_DIR=\
"$WASM_POSIX_DEP_CLANG_DIR/libexec/llvm/lib/clang/21"
export WASM_POSIX_LIBCXX_DIR="$WASM_POSIX_DEP_LIBCXX_DIR"
sdk_cc="$WASM_POSIX_DEP_SOURCE_DIR/sdk/kandelo/bin/wasm32posix-cc"

for source in channel_syscall compiler_rt cxxrt dlopen; do
  "$sdk_cc" -O2 -c "$sdk/glue/$source.c" \
    -o "$sdk/glue-objects/$source.o"
done

printf '#include <stdio.h>\nint main(void){puts("hello from Kandelo C");}\n' \
  > "$out/share/kandelo-sdk/examples/hello.c"
printf '#include <iostream>\nint main(){std::cout<<"hello from Kandelo C++\\n";}\n' \
  > "$out/share/kandelo-sdk/examples/hello.cpp"
cp "$WASM_POSIX_DEP_SOURCE_DIR/COPYING" \
  "$out/share/kandelo-sdk/licenses/KANDELO-GPL-2.0"
cp "$WASM_POSIX_DEP_SOURCE_DIR/COPYING.runtime" \
  "$out/share/kandelo-sdk/licenses/KANDELO-RUNTIME-MIT"
cp "$WASM_POSIX_DEP_SOURCE_DIR/LICENSE" \
  "$out/share/kandelo-sdk/licenses/KANDELO-LICENSING"
cp "$WASM_POSIX_DEP_SOURCE_DIR/sdk/kandelo/notices/MUSL-COPYRIGHT" \
  "$out/share/kandelo-sdk/licenses/MUSL-COPYRIGHT"
~~~

Copy the wrappers verbatim. The Kandelo source commit is their authority; the recipe must not patch packaged defaults, inject browser URLs, or substitute build-host/Cellar paths.

- [ ] **Step 7: Seal the SDK recipe and reject duplicated ownership**

Generate `recipe.json` in canonical path order. Its `dependencies` must be exactly:

~~~json
[
  "kandelo-dev/tap-core/clang",
  "kandelo-dev/tap-core/libcxx"
]
~~~

Use this exact generator after `build.sh` and `source-lock.json` are final:

~~~bash
python3 - <<'PY'
from hashlib import sha256
from pathlib import Path
import json
import stat

root = Path("Kandelo/recipes/kandelo-sdk")
files = []
for relative in ["build.sh", "source-lock.json"]:
    path = root / relative
    body = path.read_bytes()
    files.append({
        "bytes": len(body),
        "mode": f"{stat.S_IMODE(path.stat().st_mode):04o}",
        "path": relative,
        "sha256": sha256(body).hexdigest(),
    })
document = {
    "schema": 1,
    "dependencies": [
        "kandelo-dev/tap-core/clang",
        "kandelo-dev/tap-core/libcxx",
    ],
    "entrypoint": "build.sh",
    "files": files,
}
(root / "recipe.json").write_text(
    json.dumps(document, indent=2) + "\n",
    encoding="utf-8",
)
PY
~~~

Add checks that:

- no `include/c++/v1` or `libc++.a` file exists in the SDK output;
- no Clang executable or resource header exists in the SDK output;
- no local LLVM checkout, build directory, VFS archive, or object cache enters the recipe tree;
- every wrapper is mode `0755` and every notice is mode `0644`.

Compute the recipe digest and set the Formula constant with `apply_patch`, as in Task 1 Step 5. Re-run the generator and require `git diff --exit-code Kandelo/recipes/kandelo-sdk/recipe.json`.

- [ ] **Step 8: Run focused tests**

Run:

~~~bash
ruby -Itest Kandelo/formula_support/test/kandelo_formula_support_test.rb \
  -n '/kandelo_sdk_formula|kandelo_sdk_source_lock/'
ruby -c Formula/kandelo-sdk.rb
python3 -m scripts.abi_staging.cli policy-check --tap-root "$PWD"
kandelo_worktree="${KANDELO_WORKTREE:?set to the matching clean Kandelo worktree}"
(
  cd "$kandelo_worktree"
  scripts/dev-shell.sh bash -euo pipefail -c \
    'cd sdk && npx vitest run test/kandelo-wrappers.test.ts'
)
~~~

Expected: all commands exit 0.

- [ ] **Step 9: Commit the SDK Formula**

~~~bash
git add Formula/kandelo-sdk.rb Kandelo/recipes/kandelo-sdk \
  Kandelo/formula_support/test/kandelo_formula_support_test.rb
git commit -m "kandelo-sdk: add in-guest development kit formula"
~~~

## Task 3: Bind complete staging source custody and inventory

**Files:**

- Modify: `Kandelo/staging/formula-build-inputs.toml`
- Modify: `Kandelo/staging/generated/formula-build-inputs.json`
- Modify: `scripts/abi_staging/tests/test_formula_inventory.py`
- Test: `scripts/abi_staging/tests/test_policy.py`

**Interfaces:**

- Consumes: Formulae and recipe trees from Tasks 1–2; the exact Kandelo request head.
- Produces: protected build-input records for `clang/wasm32` and `kandelo-sdk/wasm32`; no ambient host paths.

- [ ] **Step 1: Add a failing inventory test**

~~~python
def test_toolchain_formulae_have_closed_build_inputs(self):
    inventory = load_formula_build_inputs(
        TAP_ROOT / "Kandelo/staging/formula-build-inputs.toml",
        tap_root=TAP_ROOT,
    )
    by_name = {item.name: item for item in inventory.formulae}
    self.assertIn("wasm32", by_name["libcxx"].architectures)
    self.assertEqual(("wasm32",), by_name["clang"].architectures)
    self.assertIn("Kandelo/recipes/clang", by_name["clang"].tap_paths)
    self.assertEqual(("wasm32",), by_name["kandelo-sdk"].architectures)
    self.assertIn("Kandelo/recipes/kandelo-sdk",
                  by_name["kandelo-sdk"].tap_paths)
    for path in (
        "COPYING", "COPYING.runtime", "LICENSE", "libc/glue",
        "sdk/config.site", "sdk/kandelo",
    ):
        self.assertIn(path, by_name["kandelo-sdk"].kandelo_paths)
~~~

- [ ] **Step 2: Run the test and confirm both entries are absent**

Run:

~~~bash
python3 -m unittest \
  scripts.abi_staging.tests.test_formula_inventory.FormulaInventoryTests.test_toolchain_formulae_have_closed_build_inputs
~~~

Expected: FAIL with a missing `clang` or `kandelo-sdk` key. The existing `libcxx` entry must already include `wasm32`; do not change its Formula source or revision unless the selected bottle bytes actually need to change.

- [ ] **Step 3: Add exact Formula build-input entries**

Add:

~~~toml
[[formulae]]
name = "clang"
architectures = ["wasm32"]
profiles = ["kandelo-common"]
kandelo_paths = []
tap_paths = ["Kandelo/recipes/clang"]

[[formulae]]
name = "kandelo-sdk"
architectures = ["wasm32"]
profiles = ["kandelo-common"]
kandelo_paths = [
  "COPYING",
  "COPYING.runtime",
  "LICENSE",
  "libc/glue",
  "sdk/config.site",
  "sdk/kandelo",
]
tap_paths = ["Kandelo/recipes/kandelo-sdk"]
~~~

The common profile already captures `flake.nix`, `flake.lock`, the `libc/musl`
gitlink through `libc`, `sdk`, and the Formula support runtime. Keep the
explicit SDK paths because source-custody reports must explain the
package-owned subset. Do not name `libc/musl/COPYRIGHT` as a parent-repository
capture path: it is internal to the submodule. The pinned gitlink plus Task 2's
byte-equality test binds the tracked vendored notice to that exact submodule
content.

- [ ] **Step 4: Regenerate and verify the protected policy projection**

~~~bash
python3 -m scripts.abi_staging.cli policy-generate \
  --tap-root "$PWD" \
  --out Kandelo/staging/generated/formula-build-inputs.json
python3 -m scripts.abi_staging.cli policy-check --tap-root "$PWD"
python3 -m unittest \
  scripts.abi_staging.tests.test_policy \
  scripts.abi_staging.tests.test_formula_inventory
~~~

Expected: all commands exit 0, and the generated JSON contains each Formula exactly once.

- [ ] **Step 5: Commit staging inventory**

~~~bash
git add Kandelo/staging/formula-build-inputs.toml \
  Kandelo/staging/generated/formula-build-inputs.json \
  scripts/abi_staging/tests/test_formula_inventory.py
git commit -m "staging: register toolchain formula build inputs"
~~~

## Task 4: Bind runtime metadata to exact protected product evidence

**Files:**

- Modify: `Kandelo/staging/promotion-policy.toml`
- Modify: `.github/workflows/abi-staging-reconcile.yml`
- Modify: `scripts/abi_staging/tap_metadata.py`
- Modify: `scripts/abi_staging/handoff.py`
- Modify: `scripts/abi_staging/promotion.py`
- Modify: `scripts/abi_staging/records.py`
- Modify: `scripts/abi_staging/cli.py`
- Modify: `scripts/abi_staging/tests/test_promotion.py`
- Modify: `scripts/abi_staging/tests/test_handoff.py`
- Modify: `scripts/abi_staging/tests/test_tap_metadata.py`
- Modify: `scripts/abi_staging/tests/test_records.py`
- Modify: `scripts/abi_staging/tests/test_cli.py`
- Modify: `scripts/check_abi_staging_workflows.rb`
- Modify in the matching Kandelo worktree: `docs/homebrew-publishing.md`

**Interfaces:**

- Consumes: one successful, non-overridden `browser-main-shell` product-evidence record for the exact request/source, its authenticated `resolved-inputs` layer, exact `homebrew-libcxx`, `homebrew-clang`, and `homebrew-kandelo-sdk` candidate-layer identities, protected definition digests for `main-shell-toolchain-node` and `main-shell-toolchain-browser`, and each selected Formula's `direct_dependencies` from the exact tap plan.
- Produces: authenticated composition inputs whose dependency edges survive candidate-to-canonical reissue, plus an optional `runtime_claim` on the promotion decision and Formula metadata update; for the three toolchain Formulae it contains runtime support exactly `['node', 'browser']`, `browser_compatible = true`, and one evidence binding per host. The Formula sidecar receives only the two public runtime fields; the admission retains the complete evidence binding.

- [ ] **Step 1: Write failing evidence-authority and projection tests**

Add fixtures for one successful `browser-main-shell` product-evidence record whose
`resolved_formula_layers` bind the exact candidate layers. Cover all of these
cases before implementation:

- the current `public-candidate-browser` Formula receipt alone cannot create a
  browser claim;
- a successful product record with both protected definition digests produces
  runtime support in the canonical order `['node', 'browser']`;
- absent product evidence, `accepted-with-override` product evidence, a failed
  host receipt, the wrong request/source/product, a foreign definition digest,
  or a mismatched Formula layer makes a policy-covered promotion ineligible;
- evidence for `homebrew-clang` cannot stand for `homebrew-libcxx` or
  `homebrew-kandelo-sdk`;
- the metadata patch changes the selected bottle's `runtime_support` and
  `browser_compatible` fields together with the exact four existing projection
  paths, without changing Formula source intent or bottle bytes;
- landed-projection and admission validation fail if either public field or any
  runtime-evidence identity is changed;
- a historical admission without `runtime_claim` still validates and cannot be
  reinterpreted as a new browser claim.
- the composition handoff emits `clang -> libcxx` and
  `kandelo-sdk -> [clang, libcxx]` from the exact same-architecture tap plan,
  and rejects an undeclared, cross-architecture, foreign-tap, duplicate, or
  reordered dependency;
- canonical descriptor reissue preserves those direct edges while changing
  only candidate transport authority.

Use this new update shape in the focused tests:

~~~python
runtime_claim = {
    "runtime_support": ["node", "browser"],
    "browser_compatible": True,
    "evidence": [
        {
            "host": "node",
            "product_id": "browser-main-shell",
            "definition_id": "main-shell-toolchain-node",
            "definition_sha256": "a" * 64,
            "product_evidence_sha256": "c" * 64,
        },
        {
            "host": "browser",
            "product_id": "browser-main-shell",
            "definition_id": "main-shell-toolchain-browser",
            "definition_sha256": "b" * 64,
            "product_evidence_sha256": "c" * 64,
        },
    ],
}
~~~

The real digests are derived from protected source and public OCI bytes; the
literal fixture digests above never enter policy or production records.

- [ ] **Step 2: Run the focused tests and confirm metadata currently preserves the Node-only claim**

Run from the clean tap worktree:

~~~bash
python3 -m unittest \
  scripts.abi_staging.tests.test_handoff \
  scripts.abi_staging.tests.test_promotion \
  scripts.abi_staging.tests.test_tap_metadata \
  scripts.abi_staging.tests.test_records \
  scripts.abi_staging.tests.test_cli
ruby scripts/check_abi_staging_workflows.rb
~~~

Expected: FAIL because promotion has no product-evidence input and
`plan_formula_metadata_patch` currently preserves the old libc++ runtime fields.

- [ ] **Step 3: Add one protected runtime-claim policy**

Extend `promotion-policy.toml` with this exact bounded rule:

~~~toml
[[runtime_claims]]
architecture = "wasm32"
formulae = ["clang", "kandelo-sdk", "libcxx"]
product_id = "browser-main-shell"

[[runtime_claims.requirements]]
host = "node"
definition_id = "main-shell-toolchain-node"

[[runtime_claims.requirements]]
host = "browser"
definition_id = "main-shell-toolchain-browser"
~~~

Update `load_promotion_policy` to reject unknown keys, duplicate Formulae,
duplicate hosts, unsupported hosts/architectures, noncanonical ordering, an
empty Formula set, or a claim without both Node and browser requirements. The
policy names definition IDs; their SHA-256 identities come from the exact
Kandelo request head and must match the successful product record.

- [ ] **Step 4: Make promotion consume authenticated product evidence**

Change `plan-promotion` to depend on `publish-product-evidence`, download the
exact `abi-staging-product-evidence-*` locator artifacts into a bounded clean
directory, and pass that directory to `plan-workflow-promotion`. Update the
workflow checker to require this edge, download, and CLI argument.

Do not add or dispatch a post-admission closed-selection, bottle-mirror, or
compatibility publisher for this closure. The admitted Formula records and
their canonical composition descriptors are already the exact inputs consumed
by Pages readiness; another aggregate would be a second selector and could
become a second compiler-byte distribution path. The final Pages producer
derives the complete root set from the product manifest and authenticates each
admission anonymously before canonical recomposition.

The promotion CLI must, without credentials:

1. fetch each immutable locator and require the product-evidence artifact type;
2. fetch and validate its `runtime-bundle`, `resolved-inputs`, and factual
   receipt layers through the existing contextual product-evidence validator;
3. require request digest, Kandelo source commit/tree, target ABI, product ID,
   successful outcome, and `promotion_state == 'eligible'` to match;
4. map each protected definition ID to the digest in the exact Kandelo
   `abi/staging/evidence-definitions.generated.json` source;
5. require the relevant `resolved_formula_layers` entry to equal the exact
   candidate layer selected by the Formula decision; and
6. reject unused, duplicated, mutable, credentialed, overridden, or
   candidate-mismatched evidence.

Do not infer browser support from the host name in a per-Formula verification
receipt, and do not allow an override to create a runtime-support claim.

In the same protected handoff path, add the exact plan-derived direct
dependencies to `prepare_composition_input`. Emit full
`kandelo-dev/tap-core/<formula>` identities in deterministic Formula-plan
order. The matching Kandelo descriptor producer versions and authenticates
that field; promotion's canonical descriptor reissue must preserve it exactly.
Neither `required_by_products` nor browser source may be used to reconstruct
direct dependency edges.

Audit every tap-side consumer with:

~~~bash
rg -n 'vfs-composition-descriptor\.v1|required_by' \
  scripts/abi_staging .github/workflows
~~~

Current candidates must publish the versioned descriptor/media type containing
`dependencies`; promotion and product composition must require it. Historical
record validation may continue accepting the old version only on an explicit
historical path. Reject a schema/media-type mismatch, a candidate-to-canonical
dependency change, or a dependency absent from the exact resolved Formula
graph.

- [ ] **Step 5: Carry and project the claim without breaking historical records**

Add an optional `runtime_claim` to `PromotionDecisionV1` and
`FormulaMetadataUpdateV1`. New policy-covered decisions require it; historical
records without it retain their old schema interpretation. Validate the exact
keys shown in Step 1, canonical host order, `browser_compatible` equivalence to
the presence of `browser`, and all digest/ID formats.

In `plan_formula_metadata_patch`, update the selected sidecar bottle with:

~~~python
existing.update({
    "runtime_support": list(runtime_claim["runtime_support"]),
    "browser_compatible": runtime_claim["browser_compatible"],
})
~~~

Bind the complete claim into the Formula metadata update and admission record.
`validate_formula_metadata_patch`, `validate_formula_admission_projection`,
post-write readback, CLI serialization/recovery, Pages admission projection,
and every constructor/fixture found by `rg 'PromotionDecisionV1|FormulaMetadataUpdateV1'`
must preserve and revalidate it. The existing four-path CAS remains exact; no
fifth metadata file is introduced.

- [ ] **Step 6: Document and run the complete staging gate**

Update `docs/homebrew-publishing.md` to say explicitly:

- per-Formula candidate tests prove bottle structure, Homebrew pour/test, and
  Node execution where applicable;
- the current Playwright candidate receipt is not runtime-claim authority
  because its exact-candidate cases are unconfigured and skip;
- only a successful exact product closure can add browser support; and
- product evidence changes metadata authority, never bottle identity or bytes.

Run:

~~~bash
python3 -m unittest discover -s scripts/abi_staging/tests -p 'test_*.py'
python3 -m scripts.abi_staging.cli policy-check --tap-root "$PWD"
python3 -m scripts.abi_staging.cli tap-metadata-check --tap-root "$PWD"
ruby scripts/check_abi_staging_workflows.rb
~~~

Expected: all commands exit 0, including historical-fixture compatibility and
negative workflow-edge tests.

- [ ] **Step 7: Commit the evidence-backed staging authority**

Commit the tap-owned changes in the clean tap worktree:

~~~bash
git add Kandelo/staging/promotion-policy.toml \
  .github/workflows/abi-staging-reconcile.yml \
  scripts/abi_staging/tap_metadata.py scripts/abi_staging/promotion.py \
  scripts/abi_staging/handoff.py scripts/abi_staging/records.py \
  scripts/abi_staging/cli.py \
  scripts/abi_staging/tests/test_handoff.py \
  scripts/abi_staging/tests/test_promotion.py \
  scripts/abi_staging/tests/test_tap_metadata.py \
  scripts/abi_staging/tests/test_records.py \
  scripts/abi_staging/tests/test_cli.py \
  scripts/check_abi_staging_workflows.rb
git commit -m "staging: bind runtime claims to product evidence"
~~~

Commit `docs/homebrew-publishing.md` with the matching Kandelo staging-source
changes; do not edit either active staging worktree named in Global Constraints.

## Task 5: Verify, promote, and admit the complete three-Formula closure

**Files:**

- Generated by protected workflows: `Kandelo/formula/clang.json`
- Generated by protected workflows: `Kandelo/formula/kandelo-sdk.json`
- Regenerated by protected workflows: `Kandelo/formula/libcxx.json`
- Generated by protected workflows: `Kandelo/metadata.json`
- Operational evidence: immutable candidate, Formula-verification,
  `browser-main-shell` product-evidence, promotion, and admission records in
  GHCR.

**Interfaces:**

- Consumes: merged tap Formula commit; exact Kandelo pull-request head and
  request asset; selected order `libcxx`, `clang`, then `kandelo-sdk`; exact
  candidate `browser-main-shell`; successful protected Node/browser toolchain
  definitions from the two downstream implementation plans.
- Produces: anonymous canonical admissions for all three Formulae, including
  bottle layer, link manifest, Formula metadata projection, runtime support
  exactly `["node", "browser"]`, `browser_compatible = true`, and the exact
  product-evidence binding for each selected wasm32 bottle. Pages readiness
  consumes those admissions and canonical composition descriptors directly.

- [ ] **Step 1: Run the complete local tap test gate before publishing a request**

Run from the clean tap worktree:

~~~bash
ruby -Itest Kandelo/formula_support/test/kandelo_formula_support_test.rb
python3 -m unittest discover -s scripts/abi_staging/tests -p 'test_*.py'
python3 -m scripts.abi_staging.cli policy-check --tap-root "$PWD"
python3 -m scripts.abi_staging.cli tap-metadata-check --tap-root "$PWD"
~~~

Expected: all commands exit 0.

- [ ] **Step 2: Publish the exact Kandelo staging request**

Use the request-feed workflow from the matching clean Kandelo branch. Record its immutable public request asset URL, then dispatch:

~~~bash
request_asset_url="${REQUEST_ASSET_URL:?set to the immutable public request asset}"
gh workflow run abi-staging-reconcile.yml \
  --repo kandelo-dev/homebrew-tap-core \
  --ref main \
  -f "request_asset_url=$request_asset_url"
~~~

Expected: the coordinator selects `libcxx/wasm32`, `clang/wasm32`, and
`kandelo-sdk/wasm32` as one closed dependency graph, orders them
dependency-first, composes the candidate `browser-main-shell`, and emits no
unsealed or ambient input. The existing Node-only libc++ metadata and the
skipping `public-candidate-browser` receipt are not accepted as browser-claim
evidence.

- [ ] **Step 3: Verify candidate records and runtime contents**

Download the workflow’s public candidate/verification records without credentials and require:

~~~text
libcxx:
  include: include/c++/v1 and unwind headers
  lib: libc++.a, libc++abi.a, libc++experimental.a
  evidence: real Node and browser load/run support

clang:
  bin: clang, clang++, wasm-ld, llvm-ar, llvm-ranlib, llvm-nm
  resource headers: lib/clang/21/include
  absent: llvm-tblgen, clang-tblgen, cmake, ninja, python

kandelo-sdk:
  bin: wasm32posix-cc, wasm32posix-c++, wasm32posix-ar,
       wasm32posix-ranlib, wasm32posix-nm, cc, c++, ar, ranlib, nm
  SDK: sysroot, glue, glue-objects, config.site, examples, notices
  absent: libc++ headers/archives and Clang executable/resource files
~~~

Also require Formula tests to execute `clang --version`, `wasm-ld --version`,
and all three LLVM utility version commands as Kandelo programs. The protected
`main-shell-toolchain-node` and `main-shell-toolchain-browser` product evidence
must compile, link, and execute C and C++ through the exact candidate shell and
must name all three candidate lazy layers. A metadata-only rewrite, skipped
Playwright case, or generic browser boot is not sufficient evidence.

- [ ] **Step 4: Merge source changes and wait for canonical admission**

After all three candidate verification receipts and the exact shell's Node and
browser product evidence are successful, merge the tap and Kandelo source pull
requests in the staging-prescribed order. Let reconciliation publish Formula
metadata updates, canonical layers, anonymous public readback, and immutable
admission records. Do not modify generated sidecars by hand. If protected
verification proves the current libc++ bottle bytes unchanged, retain its
Formula revision and admit those exact bytes with the new product evidence.

Do not publish an aggregate selection or bottle mirror after admission. The
next plan gives the three immutable admissions to the existing generic Pages
readiness path, which authenticates their canonical manifests and composition
descriptors before recomposing `browser-main-shell`.

- [ ] **Step 5: Prove anonymous canonical readback**

From the completed protected workflow, copy the three immutable admission manifest references into the named variables. From the clean, merged tap worktree, perform a bounded anonymous read of each admission and its canonical bottle record:

~~~bash
libcxx_admission="${LIBCXX_ADMISSION_REFERENCE:?set from the protected handoff}"
clang_admission="${CLANG_ADMISSION_REFERENCE:?set from the protected handoff}"
sdk_admission="${KANDELO_SDK_ADMISSION_REFERENCE:?set from the protected handoff}"

env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  LIBCXX_ADMISSION_REFERENCE="$libcxx_admission" \
  CLANG_ADMISSION_REFERENCE="$clang_admission" \
  KANDELO_SDK_ADMISSION_REFERENCE="$sdk_admission" \
  python3 - <<'PY'
from hashlib import sha256
from pathlib import Path
import json
import os

from scripts.abi_staging.canonical import parse_canonical_bytes
from scripts.abi_staging.oci import UrllibOciTransportV1, fetch_public_record
from scripts.abi_staging.promotion import (
    ADMISSION_RECORD_MEDIA_TYPE,
    CANONICAL_BOTTLE_MANIFEST_MEDIA_TYPE,
)
from scripts.abi_staging.records import validate_admission_record

def locator(reference: str) -> dict[str, str]:
    repository, digest = reference.rsplit("@", 1)
    return {
        "repository": repository,
        "digest": digest,
        "immutable_reference": reference,
    }

transport = UrllibOciTransportV1(username="", token="")
references = {
    "libcxx": os.environ["LIBCXX_ADMISSION_REFERENCE"],
    "clang": os.environ["CLANG_ADMISSION_REFERENCE"],
    "kandelo-sdk": os.environ["KANDELO_SDK_ADMISSION_REFERENCE"],
}
for formula, reference in references.items():
    fetched = fetch_public_record(
        locator(reference),
        transport=transport,
        expected_artifact_type=ADMISSION_RECORD_MEDIA_TYPE,
        required_layer_roles=("immutable-record-bytes",),
    )
    record = parse_canonical_bytes(
        fetched.config.body,
        maximum_bytes=16 * 1024 * 1024,
    )
    validate_admission_record(record)
    update = record["admission"]["formula_metadata_update"]
    assert record["common"]["outcome"] == "success"
    assert update["formula"] == formula
    assert update["architecture"] == "wasm32"
    claim = update["runtime_claim"]
    assert claim["runtime_support"] == ["node", "browser"]
    assert claim["browser_compatible"] is True
    assert [(item["host"], item["product_id"], item["definition_id"])
            for item in claim["evidence"]] == [
        ("node", "browser-main-shell", "main-shell-toolchain-node"),
        ("browser", "browser-main-shell", "main-shell-toolchain-browser"),
    ]
    canonical = record["admission"]["canonical"]
    bottle = fetch_public_record(
        locator(canonical["immutable_reference"]),
        transport=transport,
        expected_artifact_type=CANONICAL_BOTTLE_MANIFEST_MEDIA_TYPE,
        required_layer_roles=(
            "bottle-layer",
            "bottle-metadata",
            "vfs-composition-descriptor",
        ),
    )
    assert sha256(bottle.manifest).hexdigest() == canonical["sha256"]
    assert len(bottle.manifest) == canonical["bytes"]
    assert record["admission"]["canonical_public_readback_sha256"] == canonical["sha256"]

    metadata = json.loads(Path(f"Kandelo/formula/{formula}.json").read_text())
    selected = [entry for entry in metadata["bottles"] if entry["arch"] == "wasm32"]
    assert len(selected) == 1
    assert selected[0]["browser_compatible"] is True
    assert selected[0]["runtime_support"] == ["node", "browser"]
    print(formula, canonical["immutable_reference"])
PY
~~~

Expected:

- exactly one current successful admission each for `libcxx/wasm32`, `clang/wasm32`, and `kandelo-sdk/wasm32`;
- each canonical SHA-256 equals anonymous readback SHA-256;
- each selected metadata projection says `browser_compatible = true` and `runtime_support = ["node", "browser"]`;
- each admission binds the exact successful `browser-main-shell` product
  evidence and both protected toolchain definition digests;
- `kandelo-sdk` dependencies resolve to the admitted `clang` and `libcxx` identities;
- candidate references do not appear in canonical Formula metadata.

- [ ] **Step 6: Record the handoff for canonical Pages readiness**

Save these immutable values in the implementation PR notes:

~~~text
tap main commit
Kandelo source commit
target ABI
clang admission manifest reference
clang canonical layer SHA-256 and bytes
kandelo-sdk admission manifest reference
kandelo-sdk canonical layer SHA-256 and bytes
libcxx admission manifest reference
libcxx canonical layer SHA-256 and bytes
~~~

Canonical readiness in the Pages plan discovers and authenticates these
admissions through staging; it must not paste their values into browser source
or create an aggregate compiler archive.

## Plan Verification

Before declaring this plan complete:

~~~bash
git status --short
ruby -Itest Kandelo/formula_support/test/kandelo_formula_support_test.rb
python3 -m unittest discover -s scripts/abi_staging/tests -p 'test_*.py'
python3 -m scripts.abi_staging.cli policy-check --tap-root "$PWD"
python3 -m scripts.abi_staging.cli tap-metadata-check --tap-root "$PWD"
~~~

Completion additionally requires successful protected candidate verification,
successful exact Node/browser `browser-main-shell` product evidence, canonical
promotion, immutable admissions, and anonymous readback for all three
Formulae. Local tests alone are not completion evidence.

# kd-1mr.4 — Missing rootfs/shell Formulae Disposition

Port the 4 packages kd-0hns left blocked because they had no Homebrew Formula:
ncurses, bash, curl, nethack. Base: kd-0hns `37bcd20d8`.

## Result: 2 ported, 2 blocked

| Package | Status | Evidence |
|---------|--------|----------|
| **ncurses** | ✅ PORTED | Formula/ncurses.rb (10 terminal-util outputs); bottle built+tested+bottled (sha `829ba627…`); sidecar `homebrew-validate: ok`; fork `not-required`; GHCR https url. |
| **bash** | ✅ PORTED | Formula/bash.rb; bottle built+tested+bottled (sha `d853cbef…`); fork `required`; GHCR https url; `depends_on ncurses@6.5` closure satisfied in the combined tap. |
| **curl** | ⛔ BLOCKED | `depends_on` libcurl@8.11.1, zlib@1.3.1, openssl@3.3.2 — none have a Homebrew Formula in any convoy branch, so curl's sidecar dependency closure is unsatisfiable. Needs the dependent-runtime wave (kd-xhdd/kd-yuef) to port those first. |
| **nethack** | ⛔ BLOCKED | Needs a sidecar-generator extension: nethack ships a runtime **data tree** (`share/nethack/nhdat`, symbols, license) that the current `package_links_and_env()` (bin/-symlinks-only for programs) cannot express as link-manifest entries. Also needs the build-script WORK_DIR sandbox fix (as done for ncurses/bash) and Formula authoring. depends_on ncurses (now available). |

## Verification (xtask homebrew-validate, dev-shell, aarch64-apple-darwin)

- ncurses sidecar (standalone): `homebrew-validate: ok (packages=1, bottles=1, link_manifests=1, provenance_reports=1)`.
- Combined rootfs/shell tap (14 packages = kd-0hns 12 + ncurses + bash):
  `homebrew-validate: ok (packages=14, bottles=14, link_manifests=14, provenance_reports=14)`.
  bash dependency closure: `bash deps: ['ncurses@6.5'] | fork: required` — satisfied.
- ncurses `brew test` node smoke: `infocmp -V` → `ncurses 6.5.20240427` (exit 0).
- bash `brew test` node smoke: `bash -c "echo bash-homebrew-smoke"` → matched (exit 0).

## Key fixes that unblocked the ports

1. **Homebrew sandbox** blocks writes to the source tree. Each build script
   hardcoded `$SCRIPT_DIR/...` scratch dirs; redirected ncurses' (src, host-build,
   terminfo, wasm-build, bin) and bash's (src, bin) to `WASM_POSIX_DEP_WORK_DIR` /
   `_OUT_DIR` (the pattern dash already used). Also fixed ncurses `BIN_DIR` to
   `$WORK_DIR/bin` so the build-deps resolver (which bash uses to link libtinfo)
   builds ncurses sandbox-safe.
2. **fork_instrumentation model** (also a kd-0hns correction): package.toml
   `outputs[].fork_instrumentation` is the build policy `{auto, disabled}`; the
   sidecar disposition `{not-required, required, disabled, unknown}` is derived by
   the generator from a `FORK_INSTRUMENTED_PROGRAMS` set. Reverted kd-0hns's
   invalid package.toml values and fixed the generator.
3. **Local build prerequisites**: musl submodule + `sysroot/lib/libc.a`,
   `npm ci` (tsx), `packages/registry/kernel/build-kernel.sh`, and
   `scripts/build-fork-instrument-tool.sh` (→ `tools/bin/wasm-fork-instrument`)
   must exist before a Formula's `brew install --build-bottle` / `brew test`.

## Follow-ups

- curl: remains blocked on the libcurl/zlib/openssl port wave. Keep on kd-1mr.4
  or split to a curl-specific bead once its deps land.
- nethack: needs the sidecar-generator data-tree extension — a focused follow-up.

## Publication caveat

As with kd-0hns, the sidecars record canonical GHCR urls but the bottle bytes
are not uploaded (needs `packages:write` GH_TOKEN + outward push). Structurally
publishable; byte upload deferred to the trusted publish flow (kd-yuef).

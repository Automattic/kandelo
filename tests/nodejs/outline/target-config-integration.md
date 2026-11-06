# Explicit Kandelo engine target

Checkpoint source137 replaces SpiderMonkey's inherited Linux target tuple and
Linux compiler macro with an explicit wasm32 Kandelo/Unix target. Its real SDK
still generates wasm32-unknown-unknown code against the existing POSIX/musl ABI.
The Node target remains exactly26.13.0 and the audited source/native pins are
unchanged. This is project-owned configuration work, not an external defect.

Six pinned Mozilla files admit the target, publish Kandelo OS/kernel metadata,
keep XP_UNIX, and select the truthful recipe-local __kandelo__ marker together
with actual SDK Wasm/Unix facts. Linux, WASI and Emscripten identities are not
accepted as that marker's target. Unsupported Kandelo CPU variants are rejected.
Other supported platform canonicalization remains unchanged in focused controls.

Rust dependency code generation remains wasm32-unknown-unknown, whose actual
Rust target_os is unknown. The selector admits its real C/Wasm ABI without
pretending Rust implements Linux or a complete Kandelo standard library. Full
Kandelo Rust std adoption remains a separate SDK/toolchain transition.

Existing POSIX thread/mutex/clock/mmap/entropy owners remain selected. The musl
15-byte thread-name limit is retained explicitly instead of depending on a Linux
branch. The existing configure DL_LIBS probe supplies the actual dynamic-loader
dependency; weak libc stubs do not replace it. The generic libc++ codecvt path
uses the declared target library. These selected paths require a real combined
engine build and execution before support can be claimed.

Mozilla's generic process-creation timestamp fallback records its real first
initialization time. It does not make Kandelo's existing procfs starttime0 into
accurate process birth. Process-birth precision, clock/suspend behavior, memory
and entropy semantics and the full Rust std surface remain implementation gaps.
No accepted platform exclusion or fabricated public capability closes them.

## Evidence and limits

Root checks reconstruct all six exact preimages and postimages, composing the
inherited0002 Rust patch before new0110. Existing VM0109, native memory, Worker,
lock/default-trigger and module owners are preserved. The normal recipe patch
directory is already hashed. Source closure still checks676 Node inputs; the
new target patch is separately covered by the declared engine patch directory.
The root patch normalizes empty context and uses a zero-context config.sub
hunk to avoid tab-context whitespace diagnostics. All six postimages roundtrip
unchanged. Fourteen package source checks, bundle check and shell syntax pass.

Twelve focused configure-control rows exercise exact pinned function bodies,
actual SDK preprocessing, config.sub and Rust target/cfg facts. They compare
before/after admission, actual compiler identity, ABI selection and five other
platforms. Decorator/dependency orchestration is intentionally absent; these
are not a whole configure run. The preexisting matching SDK driver/plugin is
selected explicitly; no provisioning, compilation or product setup occurs.
Their exact artifact identities are recorded. They do not prove current SDK
freshness after main's separate installed-path changes.

The sealed private evidence also retains three SDK syntax-only component checks
and a compiled native thread-name policy control using an explicit musl-rule
test double. Those checks predate root integration and are not guest threading
or current-artifact conformance. Symbol presence alone proves no runtime API.
The first root package invocation failed before collection because its Vitest
path was wrong. Its exit/log is retained; the corrected source-only invocation
passes14 checks, with global product setup disabled.

## Freshness and remaining work

This target transition changes engine bytes and engine/reverse-dependency cache
identities. It changes no SDK/plugin/libc source, public ABI, target pin or memory
ceiling. It does not restamp the stale accepted engine116. Main reconciliation
also imported filesystem/image/SDK-driver path changes and kernel recipe4;
review their ordinary freshness consequences before the next targeted build.
The separately sealed calltypes-plugin recovery proposal is not integrated.

Complete normal configure, selected C++/Rust/ICU/backends, linking/imports and
actual threading/naming/clocks/memory/random/dynamic-loader behavior remain
unvalidated. All19 families remain partial; no API or family is closed. No
combined source117–137 engine or four-host acceptance exists. Overall suites
and full product rebuilds remain deferred. See the exact source/evidence ledger
[target-config-finding-progress.json](target-config-finding-progress.json).

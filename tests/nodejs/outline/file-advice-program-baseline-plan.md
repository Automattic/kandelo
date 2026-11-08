# Proposed file-advice program-baseline transition

This plan preserves the producer observation below. A later source-only review
of main `5f484a853eec0b81e31a82ab6da6d5cfb30852a6` found 219 registry
manifests: 79 libraries, 124 programs and 16 source packages. The added
`rust-native-fixtures` library contains source/vendor ZIP material; its
resolver generation is ABI keyed, but it is not a Wasm module to stamp.
The older closure counts below remain historical source reachability,
not accepted resolver build plans. See the [review and inventory addendum](file-advice-program-baseline-review.json).

This is a design packet under the user's explicit decision to plan a new program
baseline. Artifact rebuilds and the full product rebuild remain deferred. No
runtime, constant, snapshot, gate, package, test or artifact changed here.
[The machine-readable plan](file-advice-program-baseline-plan.json) and
[artifact inventory](file-advice-program-baseline-inventory.json) contain the
bounded source inventory and existing artifact identities. Neither executes a
migration or authorizes the later rebuild sequence.

## Current contract and proposed successor

The immutable observation is commit `9bfbdb2249f65e5da3227b5215a24bec7ae15ee2`.
Observed `origin/main` is `c3703ba28d6efaff3a4cd1e3e6f53573cb58b064`; its program
ABI and supported gate remain55. No network fetch was performed by this author.
Tentative successor **56** is current N+1, not a reservation: reconcile actual
main and concurrent ABI work immediately before implementation. Host-adapter
version is4; raising that alone cannot cover this program-visible errno change.
The advice patch itself adds no kernel-host wire/import/export. If a later strict
admission implementation changes that separate contract, classify and version it
explicitly; no automatic4→5 change is proposed or waived here.

The exact protected55 digest is:
`1358eca04a8d33fa5bcc27d1c672af2f6e7aaf466a398ad598d991347b1a4415`.
The successor digest is deliberately unset. It must come from the authorized
source-derived snapshot, which normally requires building kernel Wasm.

The strict format1 gate in `tools/xtask/src/supported_program_baseline.rs:13–47`
compares source, snapshot, declared epoch and digest. The main dispatcher also
runs it before bootstrap/local-build/build-deps/bundle/stamp/VFS operations
(`tools/xtask/src/main.rs:124–137`). A bare55→56 edit or ordinary snapshot update
will fail that gate; this is not a reason to bypass it.

## Exact semantic transition

`crates/kernel/src/wasm_api.rs:7290` currently returns0 unconditionally for307.
The reviewed private source routes actual full64-bit channel offset/length to
`runtime-core::sys_fadvise`, retaining the existing syscall number and ABI slots.
Admission order is actual invalid/closed/O_PATH descriptor or missing OFD→EBADF,
pipe/FIFO→ESPIPE, then negative offset/length or advice outside0..5→EINVAL.
Valid hints still return0, including zero length, beyondEOF and large positive
ranges. They do not change data, cursor, flags, file size or fabricated cache
state. Ignoring advisory optimization is permitted; missing error admission was
the gap. Negative-offset policy is the reviewed Linux-compatible choice, not a
separate POSIX mandate. Offset+length need not be computed.

Existing musl `posix_fadvise` negates the raw syscall return: errors are positive
API return values and do not set errno. Both guest widths need later genuine
channel/libc verification. No fork-v20 kind, channel layout, import/export or
struct change is proposed by this slice. None of that waives the semantic epoch
rule in `docs/abi-versioning.md:256–258`. The original capsule's no-bump assessment
is superseded by its immutable ABI follow-on and independent review.

## Baseline and admission policy

Keep the existing exact format1 validator. In the coherent successor change,
archive an exact copy of the old gate, source/snapshot identities and decision
under a new history path such as `abi/baseline-history/v55.json`; this is proposed
metadata, not an existing multi-version gate. Update the active
`abi/supported-program-baseline.json` only to the real successor epoch/digest.
The archive must not become an old-digest acceptance list. Do not provide an
unimplemented compatibility dispatcher or JS version switch.

A successor kernel must refuse old55 programs before execution. One concrete
remaining prerequisite is current legacy admission: `host/src/constants.ts:2527–2557`
permits absent version/contract markers with warnings, and
`host/src/worker-main.ts:2991–3029` also skips missing markers or missing expected
metadata. Therefore the strict build gate alone is not strict runtime admission.
Implement a genuine successor admission policy over launch, exec, worker, fork,
side-module and dynamic-link consumers; preserve access/feature/role/error checks.
Prove missing/malformed/duplicate/wrong markers cannot silently reach constructors
or `_start`. Do not fake identity with filenames, environment or relabelled bytes.

All seven present55 fixture files matched their pinned hashes/sizes during this
read-only inventory. The manifest identifies six fixtures and producer
`e4bca8639e4b6853080ca7f3a09b0e95488c9d50`; the seventh raw-fork artifact
is separately pinned. Preserve the manifest, its six fixture bytes and producer,
and the separately pinned raw-fork bytes and metadata unchanged. Do not assign
the manifest producer to the additional raw-fork artifact. Preserve
`scripts/build-program-baseline.py` as the historical55 producer, not a means to
rebuild55 with the successor SDK. Add a separately identified successor cohort
only after actual artifacts exist. Its producer/hashes cannot be guessed now.

The current55 success harness cannot truthfully remain a current-runtime positive
test after an incompatible baseline switch. Keep its output/semantic assertions
as historical55 coverage against an identified matching55 cohort; add successor
positive fixtures and explicit55-on-successor refusal tests. Do not turn the
original frozen programs into successor binaries or silently weaken assertions.
Existing package ownership/raw-fork helpers also use55 fixtures and need explicit
historical versus active roles.

## Concrete affected inventory

| Owner | Existing scope | Required later transition |
| --- | --- | --- |
| Registry libraries/programs | 218 manifests:78 libraries,124 program-kind,16 source-kind | All202 compiled/image recipe keys bind epoch; resolve new keys for each selected target/architecture. Program-kind includes non-Wasm archives/images; do not stamp those as modules. |
| Node closure | `node`, `spidermonkey`, `libcxx`, `openssl`, `node-cares`, `node-codecs`, `node-llhttp`, `node-ncrypto`, `node-simdjson`, `node-sqlite` | New actual resolver generations; engine9 plus node wrapper. No copied/relabelled55 engine. |
| Product closures | Rootfs21 and shell163 source-reachable packages;20 declared VFS products | Produce real selected resolver plans before rebuild. Shell count is not a validated plan: cargo requests openssl3.3.2 but registry is3.5.9. Preserve and reconcile that recipe conflict normally. |
| Tools and SDK | xtask, program/shared crates, fork instrumenter, musl/glue/sysroots for wasm32/wasm64, SDK driver | Rebuild actual ABI owners and linked outputs; validate freshness. Unchanged verified source archives remain reusable. Recorded manifest `kernel_abi` fields are not enforced and do not replace the resolver's actual ABI; no blanket metadata renumbering. |
| Snapshot/generated consumers | Normal dump-abi output includes snapshot, ABI/glue/limits/process/channel/syscall/thread/spawn/device headers, host ABI TS and host import list | Generate normally and review actual changed leaves. Regenerate/test standalone resolver bundle. SourceOnly keys, reserved child build-key env and generated ShellBuildID must stay coherent. |
| Programs and originals | Main/side modules, direct test/example outputs, original associations, materialized receipts | Fresh compile/link/instrument/stamp from successor source; verify exact contract/build-key receipts. Re-instrumenting/restamping an already-linked55 program does not rebuild libc. |
| VFS and cached generations | Eager/lazy product composition, aggregate/member receipts, selected binary projection, original store | New complete image/program reference cohort; preserve old generation bytes. SourceOnly compiled cache uses arch+abi+key, while16 source-kind payloads remain ABI-agnostic. No shared-cache deletion or old-generation overwrite. |

The inventory lists every manifest/output/dependency and20 product definitions by
exact source hash, plus seven55 fixtures, existing projection metadata, accepted
engine239 artifact/receipt and its historical Node-host kernel/image identities.
It is a declared source and existing-evidence inventory, not a complete physical
cache, remote release or installed-computer survey. Existing engine239 evidence
is ABI55 history; no new-epoch or current-source conformance is inferred.

## Later sequence and gates

1. Preserve the entire55 evidence/cohort, review this plan and reserve actualN+1
   against main. Continue unrelated compatibility source work meanwhile.
2. In a later authorized implementation phase compose kernel307, semantic epoch
   history, exact baseline/admission and fixture-role changes together. Keep
   readahead, unrelated syscall changes and any fork-wire transition separate.
3. When targeted build authorization is granted, run normal
   `scripts/check-abi-version.sh update` in the declared dev shell. It first builds
   kernel Wasm; it is explicitly **not allowed now**. Obtain the real digest,
   update the active gate coherently and run ordinary ABI/source/baseline checks.
4. Rebuild tools/SDK/sysroots and the standalone resolver bundle through normal
   owners, then the kernel and minimal real guest file-advice controls. Retain
   each actual compilation/cache result and uncertainty; planned nodes are not
   compiled-node counts. Test real fd/OFD lifetimes, error precedence, full64-bit
   arguments, positive libc error returns/unchanged errno and no-effect hints on
   both widths and all four hosts, with identified native references.
5. Prove successor/55/missing-marker/mixed-cohort admission, image lazy references,
   worker/dlopen/exec paths, no pre-rejection constructors and file preservation.
   Only then expand to product closures within separately approved rebuild scope.
6. Create the new frozen cohort from final actual producer artifacts; preserve
   historical55 positives and current cross-epoch negatives. Validate eager/lazy
   VFS, normal receipts, cancellation/lifecycle and complete rollback cohorts.
   Overall suites and full product rebuild remain subject to existing deferrals.

Saved-computer compatibility is separate from persistence readability. No journal
rebind, truncation, deletion or older-generation fallback may disguise a mismatch.
No automatic transactional package upgrade is implemented by this plan. Preserve
old storage and explain rebuild/export requirements; use genuine supported data
migration/fresh successor images, not executable relabelling. Rollback selects a
complete matching55 host/kernel/program/image/binding cohort, not a55 runtime
forced over successor-mutated data. Do not promise automatic storage rollback.

## Staging, release and remaining failures

Current `docs/package-management.md:29` describes local SourceOnly and no remote
prebuilt channel. Legacy release workflows/catalogs remain, including an ABI6
`abi/manifest.json`. Also, current docs describe `abi/staging` and
`classify-exact-abi-staging.sh`, but neither exists in the observed HEAD or main
Git tree. Do not claim that an operational exactN→N+1 staging system exists.
The real local transition needs no invented remote publication step. Any later
hosted release must first reconcile actual workflow/guard ownership, protect and
verify the complete old55 history, stage exact reviewed sources/receipts in a new
namespace and promote complete immutable products. Partial inventory must retain
the last complete site. No publish, merge or deploy is authorized.

The optional WASI patch is not passed by choosing a new baseline. Existing native
reference7/7 versus candidate6/7 preserves revoked borrowed-fd result8 versus0;
Darwin lacks the POSIX_FADV branch while guest musl exposes it. Guest dispatch,
JSAPI and POSIX branch remain uncompiled/unexecuted in this evidence. Preserve
that public nonpass and resolve the real configured error/admission owner before
acceptance; do not rename it unsupported or a platform boundary. Current source still lacks17 imports including fd_advise; the optional source
would leave16 others only after real acceptance. The nested guest Wasm backend
remains a required gap, deferred last.

Original producer accounting stays29 compiler attempts/2 failures. The historical
R2 Rust executable is unavailable; its retained source/command/raw4-of-5 result
must not be reconstructed as original passing evidence. This design adds zero
tests, runtime probes, compilations, builds, artifact changes or root writes.
It does not activate fadvise/WASI or complete any compatibility finding.

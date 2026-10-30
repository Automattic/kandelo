# Persistent data and executable compatibility

Persistence stores files, not suspended processes or a kernel/host runtime.
A filesystem that can still be read is not necessarily a filesystem whose
programs the current kernel can execute. These are separate admission checks.
Do not fix an executable mismatch by rebinding a journal to another base,
discarding the journal, selecting an older generation, or removing ABI checks.

**First-release boundary:** persistence and the computer UX ship before
transactional software upgrades. Saved computers from this release will not
work in the next release; export important files before updating Kandelo.
The UI shows this warning during creation, retention and reopen. This policy
does not permit deleting incompatible storage or claiming upgrades exist.

## Independently versioned formats

| Layer | Current version(s) | Admission owner |
| --- | --- | --- |
| Saved computer metadata | 2, with the known prototype schema 1 readable | `BrowserComputerStore` |
| Storage backend identifier | `kandelo-opfs-image-v1` | Computer library |
| Persistent image manifest | `kandelo-fixed-rootfs-image-v6` | Image control reader |
| Generation binding | `kandelo-active-rootfs-binding-v1` | Image control reader / Rust selection policy |
| Checked image | `KDIIMG1`, version 1 | Rust `persistent_image` |
| VFSI container | 1 or 2, with an explicit supported feature-bit mask | Rust `kandelo_image_fs` |
| KIFS filesystem body | 1 or 2 | Rust image filesystem reader |
| Overlay journal | `KOVL`, version 1 | Rust `persistent_overlay` |
| Overlay checkpoint index | 1–5 | Rust `persistent_overlay_index` |
| Journal inode record | 1 | Rust rootfs replay |
| Original-program reference | 1 | Rust `fork-instrument` |

These numbers do not advance with a kernel-host ABI bump or every build.
Changing a disk layout requires an explicit version/feature change and reader
policy. Unknown required features must be refused, not silently dropped on
export. Unknown manifests or checked-image formats must not be treated as
damage that permits falling back to an older generation. Interrupted-creation
collection must preserve newer, malformed, or unreadable metadata; only a
known creation marker with no metadata and no installed data can be collected.

Existing journals are opened without truncating incomplete tails. Recovery
retains a logical committed end, validates filesystem metadata, and leaves
physical repair until a subsequent real transaction. A failed admission must
not modify the source journal. A new empty journal still needs its initial
header written and flushed. A failed repair poisons that writer rather than
acknowledging later transactions against uncertain state.

Kernel-worker destruction closes initialization admission synchronously on
both hosts. Already-admitted initialization drains before storage teardown;
it cannot start a new compactor or publish readiness after cancellation.
An active compactor stops before its journal and index handles close.

## What a narrow program contract actually contains

An executable compatibility check must include everything an existing program
actually uses, not just exported function names. This does not promise that
every checked interface is already stable across releases:

- Wasm imports, their signatures, required features, and entry/exit conventions.
- Syscall IDs, argument representations, return values, errno, blocking and
  interruption semantics, and guest-visible structures.
- The channel layout, signal slots, TLS and process-memory fields directly
  accessed by the already-linked libc. Today's libc accesses these directly;
  they cannot be declared private without changing the implementation.
- Dynamic-linking conventions and the fork continuation protocol used by a
  prepared executable. Regenerating instrumentation does not replace its libc.

The kernel/host adapter contract can evolve separately where neither program
code nor its linked libc observes it. Main's program/kernel-host surface split
is the prerequisite for this work, not evidence that all older binaries now
run unchanged. An exact current-program digest is still a strict admission
rule, not a supported-baseline compatibility policy.

The initial declared baseline is program ABI 55 and the exact digest recorded
in `abi/supported-program-baseline.json`. `xtask check-program-baseline` checks
it against the source-derived program surface, independently of ordinary
snapshot regeneration, and refuses a stale snapshot. Bootstrap, local package
builds, image commands, package bundling and program stamping also enforce it. The baseline
does not include kernel-host-only sections: the kernel and host can change
together without forcing user programs to be rebuilt.

This first gate is deliberately exact. It refuses new program-surface fields
as well as changed or removed fields, even if the ordinary snapshot classifier
calls the change additive. A required-extension mechanism is not implemented;
do not work around that by accepting arbitrary old digests or giving new
requirements the old identity. Future extensions need explicit admission and
negative tests before this restriction can be relaxed. Existing syscall IDs,
structures and directly accessed libc layouts retain their meaning.

`abi/program-fixtures/v55` contains six frozen, previously compiled executables
with exact byte lengths, hashes and source provenance. Compatibility tests
load those bytes without rebuilding or restamping them, covering output,
spawn/wait, filesystem metadata, private mappings, threads, and fork/exec
environment isolation. The Node cohort passes. All three browser engines also
run these unchanged programs while offline, after verifying the installed
bytes against the frozen manifest. Combined release acceptance remains
required; these examples do not replace semantic
conformance suites or prove every program compatible.

An incompatible change needs either a bounded Rust adapter that preserves the
old guest representation/semantics or a deliberately new program baseline.
Do not add a list of old digests without those tests. In particular, changes
to signal or channel layouts cannot be solved by a JavaScript version check.
Moving libc to a smaller stable gateway can hide future internal layouts, but
does not retroactively decouple programs linked against today's channel.

## Staged fork compatibility

For this iteration the fork instrumentation contract is versioned, not declared
stable. Its linked-frame, module-state, reference, exception and capability
descriptors have explicit format versions checked before launch. The current
program digest also binds this surface; the ABI-55 baseline is a regression
gate for this release, not a promise to freeze the unfinished fork protocol.
A future incompatible fork change needs an explicit compatibility decision and
corresponding version/baseline changes, not a silent snapshot refresh.

User-built forking programs cannot be automatically upgraded in this stage.
They may require rebuilding and instrumentation with the current SDK after a
contract change. Admission must refuse incompatible programs before execution,
preserve their files, and explain the rebuild requirement. A mere tool build
change is not evidence of incompatibility. Ordinary nonforking programs are
not subject to an instrumentation requirement just because they are custom.

Packaged programs use verified prebuilt replacements. A maintenance upgrade
must replace already installed package files and unresolved lazy references as
one compatible package/dependency set. It does not require an automatic guest
compiler, mandatory retention of original Wasm, or an archive of old runtimes.

In the future stage, accept uninstrumented user programs and prepare them on
demand. Retain their exact original bytes in a protected, known store, with a
verified association to the executable, its permissions and instrumentation
contract. Do not expose execute-only source bytes through a publicly readable
original store. When an upgrade invalidates derived instrumentation, restore
the original as the authoritative source and prepare it on next use; eager
preparation is optional. Activation and invalidation must be recoverable and
must not overwrite user replacements. Existing explicit preparer prototypes
do not implement this automatic lifecycle.

## Original-program retention prototype

The version-1 original-reference codec lives in `wasm-artifact`, so native
tooling and the kernel can use the same bounded Rust reader. The artifact
reader's only repository dependency is the program ABI crate, not kernel-host
metadata.
The thread-slot export name stays unchanged and remains re-exported through
the existing shared interface. This separation does not change the supported
program baseline or the reference's 44-byte representation.

The preparer can inspect this reference without rewriting a program:

```sh
wasm-fork-instrument prepared.wasm --original-reference
```

It prints the original byte length and lowercase SHA-256 separated by a tab,
or `none` when a valid module has no reference. Invalid containers, duplicate
references, unsupported versions and components are refused. The inspection
does not authenticate a package, locate or verify the original bytes, or grant
execute permission. Native package code can separately use `verify_original`
to check the exact content binding, a byte budget and raw-program admission.
These are integration primitives, not automatic execution.

The current producer-side integration accepts an optional `original_wasm`
artifact path on a program's `[[outputs]]` declaration. This association is
not a separate executable or runtime-file member and does not move a scalar
executable into a package directory. It participates in the package cache key;
unsafe, duplicate and overlapping artifact paths are refused. Canonical cache
admission requires the declared raw bytes to match the output's embedded
length/digest and, for SourceOnly, its complete cache receipt. Originals may
not carry executable or special permission bits.

For such recipes the resolver supplies a private
`WASM_POSIX_BUILD_ORIGINAL_STORE` below the build work root. The preparer's
normal transformation branch uses it when no explicit store was selected, so
recipes that instrument before installation retain the input before replacing
it. Inspection modes do not use the store. The installer consumes the
resolver's exact output metadata without compiling Cargo inside a sealed
recipe, captures nonfork originals before removing compiler facts, verifies
the content association in Rust and copies the declared companion before
publishing the executable. Missing or corrupt originals refuse publication.
Existing store entries with writable, executable, special or symlink state
are refused without repairing them or accepting different bytes.

SourceOnly publication now carries these declarations through its canonical
receipt, selected program index, materialized-member receipt and aggregate
authority. The executable keeps its ordinary flat or package-directory path.
Its original is copied without execute/write/special bits into
`programs/<arch>/.originals/<package>/<cache-key>/<original_wasm>`. This reserved
namespace cannot be an ordinary executable/package projection entry.

The companion generation is published before executable activation. An equal
existing generation is reused without replacement; a different one is refused
and left intact. A failed executable activation may leave an unselected
companion generation, but must not select an executable with missing originals.
Old companion generations remain available. Publication reopens directory
ancestry without following symlinks, syncs staged directories and ancestor links
before activation and rechecks companion content and ancestry before changing
the executable. This native build-publication ordering is not the unfinished
guest package-upgrade transaction or a device power-loss guarantee.

The Node build resolver derives the original role only from the selected
package declaration and cache identity. Aggregate receipt ownership is exact:
missing, extra, wrong-generation, unsafe-mode and caller-invented role records
are refused. Originals retain stable-file and SHA-256 verification but are not
subjected to executable ABI/fork admission or accepted as executable outputs.
Unrequested originals are hashed in bounded chunks; explicitly captured bytes
count toward the snapshot session's aggregate byte limit. The
`programOriginalWasmArtifact()` lookup exposes the selected association metadata
under SourceOnly, not an ambient original-store search or permission to execute.

Sealed installation checks each output against resolver-supplied metadata,
including recipes that deliberately disable fork instrumentation. Their
portable output declarations must agree with that script policy; publication
does not weaken the declared policy to accommodate a mismatch. Browser package
root inspection accepts the same optional `originalWasm` association, validates
its portable Unicode path and artifact collisions, and keeps companions out of
the executable-import list. This metadata is not runtime access authorization.

The advisory artifact-closure check includes retained originals in its native
resolver requests and memoized file set. Companion changes invalidate reuse
even when the executable is unchanged; mode, ownership and ctime participate
in the stamp, and non-regular final paths are refused. This build-tool memo is
not a program-preparation authorization or a replacement for the resolver's
current package/content checks.

The `less` recipe is the first SourceOnly producer to declare an original.
Both shell image-population paths register associated originals as read-only,
content-addressed lazy files at `/usr/lib/kandelo/originals/<sha256>.wasm`,
without embedding their bodies into the base image. Existing lazy executables
from explicitly selected program dependencies do not suppress companion
registration. Imported programs outside that direct dependency set retain
their base-owned identity; their originals must be delivered by the base's
producer. A conflicting existing original or executable is refused rather than
replaced.

Image delivery resolves the original from the same selected package generation
as the executable, never through a basename search. Direct dependency roots are
checked against the selected canonical generation without requiring an aggregate
projection that may not exist during a dependency build. Aggregate consumers
bind both actual files to one selected receipt. Stable reads check regular-file
identity, length, SHA-256 and non-writable/non-executable original modes. The
Rust image module checks the complete executable container and its embedded
original length/digest. A missing or stripped reference cannot silently omit a
declared original; a reference without a selected association also fails.

The normal SourceOnly `less` build and actual image save/reload have been
validated, including raw-original verification and the snapshot path used to
collect lazy assets. Its 465,635-byte original adds 12,288 image bytes as lazy
metadata, not another embedded executable body. This is a scoped package/image
proof, not a rebuilt shell, WordPress or browser release. Runtime-side module
originals, archive members without individual digests and automatic install/exec
preparation remain unfinished. The existing web
checkpoint predates this producer/publication work.

The rootfs generator now delivers originals for both eager and lazy programs
through the same Rust image-reference checks. The native resolver provides a
versioned, bounded file of exact direct-dependency bindings instead of requiring
an aggregate projection or nested Cargo/index generation during a sealed build.
It verifies the selected cache generation and ordinary cache admission before
issuing bindings, using each dependency's actual architecture. The shared reader
checks actual prepared and raw files against those bindings; Rust checks the
executable container and original reference. Unrelated non-Wasm package data
does not become a program merely because another dependency has an original.
Conversely, renaming a declared program to a data filename cannot suppress
reference validation. Unsupported lazy-reference names fail before registration.

An actual native resolver recipe consuming the real `less` package now stages
the selected executable, generates a rootfs image and reopens its readonly,
digest-bound lazy original. The raw body stays outside the image. This proves
the rootfs delivery path, not that every base-image recipe has opted into
retention, that a full release was rebuilt, or that preparation is automatic.

The native package resolver's Default policy now also publishes immutable
original generations before changing cache-backed executable mirrors. Scalar
and package-directory layouts are unchanged. Original contents and directory
ancestry are rechecked before both executable quarantine and activation;
ordinary error rollback restores the prior executable mirror. Equal companion
generations are reused, unequal ones are refused and earlier generations stay.

Default asset lookup admits a reserved original path only when it exactly
matches a selected output's package, architecture, cache key and declaration.
It pins the complete ordinary executable closure first, then resolves the raw
file from that same canonical generation. Originals are included in asset
collection but remain data, never executable-policy outputs. Coherent batches
resolve each owning executable once and preserve the caller's request order.
A missing executable cannot fall back to an ambient literal original file.

Manual direct-local install sessions remain refused for original-bearing
packages. Their session identity is separate from the cache key and they need
complete original staging before activation; cache-backed publication must not
silently select such a session. This is distinct from the working Default
source-build/cache publication path, and from guest package upgrades.

For nonfork raw modules, explicit binding without instrumentation is available:

```sh
wasm-fork-instrument raw.wasm -o bound.wasm \
  --original-store /var/lib/kandelo/programs --retain-uninstrumented
wasm-fork-instrument bound.wasm --verify-original /path/to/raw.wasm
```

Binding still applies raw-program admission and bounded atomic output. The
read-only verification command checks the requested original bytes, not just
the reference, and requires a regular non-symlink retained file without write,
execute or special permission bits. It creates no output and grants no
execution authority.

The native instrumentation tool now accepts an explicit store:

```sh
wasm-fork-instrument program.wasm -o prepared.wasm \
  --original-store /var/lib/kandelo/programs
```

It retains the exact validated, uninstrumented bytes, including compiler facts
and custom sections, at `originals/<sha256>.wasm`. Entries are published without
replacing an existing entry, which must match the original. The prepared output
contains a versioned `kandelo.original-program` section with its source byte
length and SHA-256. Output publication remains atomic and bounded; a prepared
artifact cannot be registered as its own original. Outputs inside the originals
directory are refused. Inputs without an explicit or resolver-selected store
keep the existing behavior.

The Rust `load_original` API verifies the retained bytes and the caller's byte
budget before re-preparation. The explicit host-tool path regenerates a prepared
program from that binding, with permissions taken from the requested input:

```sh
wasm-fork-instrument prepared.wasm -o prepared.wasm \
  --original-store /var/lib/kandelo/programs --reprepare-from-original
```

Missing, changed or unsupported references fail without replacing the output;
the tool does not reinstrument old transformed code. This is an
artifact-retention prototype, **not automatic browser exec-time preparation**
or a cross-release ABI compatibility claim. The reference is a content
binding, not a signature or an
authorization to execute; ordinary execute permissions still belong to the
requested program. The native store is trusted tool-owned state, not a sandbox
against other native processes that can modify its directories.

Before integrating on-demand preparation with guest exec, require:

1. Package/install paths retain originals before transformation and preserve the
   executable's actual credentials, modes and dependencies.
2. A trusted preparation service runs outside persistent UI realms, with bounded
   input/output/work budgets, cancellation and atomic derived-artifact publish.
3. A derived cache key binds the source, exact preparer identity, options,
   optimizer, compiler facts, dependency closure and supported program baseline.
   A format-version number alone is not sufficient to invalidate buggy output.
4. Exec revalidates output through normal Rust artifact admission and never
   rewrites a running executable's inode or treats cache permissions as authority.
5. Node and browser exercise the same preparation decisions, including missing
   originals, stale derived output, concurrent preparation and interrupted writes.

### Private preparer descriptor I/O

The CLI accepts either a positional input path or `--input-fd FD`, and either
`--output PATH` or `--output-fd FD`. Descriptor numbers must be at least three.
Input descriptors must be readonly regular files. The preparer snapshots from
offset zero with positioned reads; inherited shared offsets do not change.
It duplicates inherited handles into owned close-on-exec handles and marks
the supplied descriptors close-on-exec in the helper, so the optimizer cannot
inherit those capabilities. The controller must close any other inherited
aliases before launching the helper.

Output descriptors must be writable, empty, unlinked regular files without
append mode, and must not alias the source. The helper does not truncate them,
copy source permissions onto them, or publish a pathname. Transformation and
validation finish before the first positioned output write; writes use a
fixed-size buffer and finish with a sync. A write or sync failure can leave
partial private staging bytes. The controller must discard that staging
artifact rather than execute it. Successful helper completion is not itself
an atomic executable/cache publication operation. Path outputs retain their
existing atomic replacement behavior.

`--bind-original` validates and binds the raw input's content identity without
creating an original store. It ignores `WASM_POSIX_BUILD_ORIGINAL_STORE` and
conflicts with explicit retention/re-preparation and inspection modes. This
lets a controller that already owns the original avoid creating a second
named copy, especially for execute-only sources. The reference still grants
neither permission to read the original nor permission to execute the output.

These CLI capabilities are a prerequisite for a private preparation service,
not automatic install/exec integration. Trusted helper selection, registered
original access, aggregate workspace limits, cancellation and sealed derived
cache publication remain the controller's responsibility. Descriptor I/O
requires a POSIX host; ordinary pathname I/O remains available elsewhere.

The normal package and SDK path pass the descriptor harness on Node and all
three automated browser engines, including offline regeneration after OPFS
reopen. Output matches the native optimized artifact and executes normally.
The same combined run checks frozen supported programs and the SDK's Rust
descriptor-clone boundaries: 18 Node cases and six browser cases pass in
`preparer-descriptor-integrated-1031-035316-136f`. The initial Node refusal
exposed an SDK target-selection gap, fixed by selecting normal POSIX
descriptor cloning for Kandelo rather than adding helper-specific behavior.
This evidence does not establish automatic service execution, cold offline
application startup, native Safari or total compiler memory bounds.

The final current-package rerun is
`preparer-descriptor-sealed-integration-1031-040948-e962`: the same 18 Node and
six browser cases pass after removing a whitespace-only patch context line
and confirming byte-identical patched standard-library source.

The portable Rust binding foundation is implemented in
`runtime-core::program_preparation`, but is not connected to automatic execution.
`exec_target::preparation_plan` uses only the retained target's fully observed
bytes: incomplete reads, a wrong owner or observed drift fail without reopening
the diagnostic pathname or changing source credentials. The plan binds exact
source/original content, preparer identity, optional optimizer, options,
dependency closure and program baseline. ABI or contract mismatches are not
repairable by re-instrumentation. It refuses known fork surface as an unbound
raw original, nested/invalid references and changed memory data models.

The derived-cache receipt prototype has a fixed 216-byte version-1 encoding,
independent of disk and program ABI versions. Unknown versions, nonzero reserved
fields, stale identities and changed output fail verification. Raw input and
output byte limits are separate. A tighter raw-work limit need not invalidate
an already valid cached output; the original size is checked before loading it
for actual preparation. These are byte limits, not proof of an aggregate
compiler/kernel heap bound. Preparation binding now uses a separate bounded
Rust metadata reader rather than the full artifact-fact catalog. Its caller
sets `metadata_bytes` and `metadata_work_items`, separately from source,
original and output byte limits. The reader fallibly admits only type-kind,
function-index and exported-function-index tables; growth includes replacement
overlap. Names, signatures and custom-section bodies are not retained or
cloned. Scalar type decoding charges parameter, result and field counts before
walking them. Recursive groups and compact imports are charged before expansion.

Table initialization uses a scalar visitor without an allocating control stack;
control/vector-table instructions are refused before opaque decoding. The ABI
accessor accepts the SDK's constant, optional constructor calls and trivial
wrappers (at most four links), with locals, lookups and operators charged to
the same work limit. It does not execute arbitrary ABI getter code or interpret
a nested block's `end` as the function's return. Memory data models and known
typed fork surface still participate in admission. The reader is not a full
WebAssembly validator or a replacement for the normal fork/compile checks.

Resource refusal stays distinct from malformed code: table admission or
allocation failure is `ENOMEM`, record-work exhaustion is `E2BIG`, and malformed
metadata or an unsupported ABI marker is `ENOEXEC`. Receipt format and profile
identity are unchanged; resource limits do not become content identities.

The reader reserves a conservative 4 KiB diagnostic allowance in its requested
metadata budget. This is not a physical allocator reservation. The parser's
error construction can still allocate a small String/Box infallibly on malformed
input under actual allocator exhaustion. The isolated inspection path below
contains that failure; it does not make direct in-kernel parser calls fallible.
Compiler process/workspace admission and the trusted transformation executor
remain explicit before claiming complete automatic-preparation memory/ENOMEM
behavior. Ordinary artifact consumers still use the fuller catalog and have
a separate hardening audit.

The receipt checks integrity, ABI and reference binding; it is not a signature,
proof of a correct transformation, the full fork validator, or execution
authority. A trusted current-runtime executor and sealed cache publication are
still required. Original lookup must enforce its registered access policy: a
hash must not grant access to another user's private raw/compiler data, even
through a cache hit. A changed prepared source must match its registered
source/original association before automatic regeneration; do not silently
discard a user's binary edits just because an old reference remains present.
Retain source permission authority separately from the
prepared execution image; a readonly derived OFD alone does not preserve procfs
read checks or `fexecve`. Final commit must check the original source length and
generation, not substitute the derived code's different byte length.

Native tests use the actual instrumenter on the frozen raw fork program and
verify its output through this portable reader. They do not exercise a new
Node/browser service. Already admitted programs must retain the ordinary fast
path; absence of a new receipt must not force re-preparation of every package.

### Failure-contained Rust inspection

`kandelo-program-policy` builds a small Rust/Wasm inspection module, not a
second kernel. Its only import is a private, unshared linear memory created
inside a disposable worker. It has no filesystem, OPFS, process, network or
live-kernel-memory capability. Source bytes are independent copies. Node and
browser adapters use the same module and fixed result protocol.

The version-1 inspection record is exactly 160 bytes. It binds source length
and SHA-256, metadata/work limits, ABI and contract identity, original content
reference, pointer width and the metadata needed for a preparation decision.
This is an ephemeral trusted-runtime message, not a filesystem record, cache
receipt or guest-supplied certificate. Its source digest does not authenticate
its other fields. Only output from the current trusted inspection worker may
enter the parser-free kernel path; never recover these records from saved
computer files or accept a caller's invented record.

The standalone module caps input at 64 MiB, requested live Rust allocations
at 96 MiB, and private linear memory at 128 MiB. Callers can request smaller
limits. The controller admits aggregate jobs before worker construction,
charging declared linear-memory maximum, independent input copies, the fixed
result and adapter overhead. Node also caps and charges the JavaScript young
heap, old heap and stack. These are explicit workspace controls, not a
universal bound on engine compilation, allocator overhead or whole-system
physical memory.

Malformed-input diagnostic allocation failure traps only the inspection
instance. The worker reports allocation refusal when the allocator flag is
available, otherwise a trap. Every outcome awaits exact worker termination
before releasing its job/workspace charge. Failed retirement retains both
the worker handle and admission until a later successful drain. Closing the
controller stops admission synchronously, cancels admitted work, drains
retirements and disposes the browser bootstrap URL. Browser bootstrap code
is bounded and loaded once per controller before an offline inspection phase;
it is current runtime code, not an archive of old runtimes.

Rust can decode the fixed record and verify exact source/budget binding,
construct a preparation plan, check original/output content and bind a paired
execution image without reparsing Wasm metadata. A native denial-of-allocation
test covers those parser-free operations. The initial preparation decision
requests transformation for a raw program importing the fork primitive without
prepared fork surface; already prepared programs and nonfork programs do not
become compiler jobs merely because the preparer changed. A `NotNeeded`
decision is not full executable admission: ordinary artifact/fork validation,
compilation, source permission checks and final commit still apply.

This worker and parser-free path are implemented but not connected to ordinary
automatic install/exec. Original access authorization, trusted helper launch,
sealed output custody and cache publication remain required. Production must
not call the direct parsing methods and claim inspection-worker containment.

The initial-tool launch primitive uses kernel-host adapter 4 without changing
program ABI 55. Rust can retain a readonly, anonymous current-runtime tool for a
pending child's initial generation, then require the same complete observation
and spawn commit as any other executable. The shared host wrapper snapshots
code bytes inside its admitted entry; a busy gate retains no new program.
Scratch and entry validation precede a serialized host-only ownership handoff;
failure before handoff discards the unclaimed image, while failure after
invocation cannot close a handle Rust may have consumed.
Anonymous host code has a stable readonly/nosuid storage view for final mount
checks. Executing an own-process procfd also retains the actual OFD after its
pathname moves or disappears, including when exec closes that descriptor.
This makes pinned tool launch possible; it does not select/authenticate the
tool, allocate the private compiler workspace or complete the controller.

Ordinary top-level VFS-path launches now use retained target authority too.
Both hosts set requested credentials and working directory before lookup,
then read, admit and compile the exact retained object. The initial commit
refuses an existing image, registered channel, nonzero generation or pending
guest spawn. Interpreter selection and secure-exec state come from Rust, not
from reopening the original pathname after compilation. Host-supplied raw
program bytes retain their separate by-reference path. These launch changes
do not themselves bind a prepared image or authorize a retained original.

The normal `wasm-fork-instrument` package now builds the same Rust preparer as
a Kandelo guest, using the existing SDK and private target-selection patches.
A Node guest prototype prepares a fork/shared-mapping program, retains its
original, matches native output byte-for-byte, executes the result and
re-prepares it in place. This includes the guest Binaryen optimizer, rather
than delegating compilation to a remote service. Receipt:
`guest-preparer-optimized-execution-1030-134508-8aea`. The registry package
build also passes (`guest-preparer-normal-package-1030-135807-7d55`). These
receipts alone do not establish browser behavior. The subsequent three-engine
browser cohort validates the installed frozen program bytes and exact selected
preparer/optimizer artifacts, then disables networking before executing,
preparing and re-preparing programs. Re-preparation creates and executes a
distinct, initially absent output, so retaining the original output cannot
satisfy the test. Corrupt retained originals fail without replacing existing
output. Receipt: `offline-preparer-bounded-proof-1030-143749-2f2d`. Four Node
cases additionally cover missing originals and an input-budget violation;
together with six frozen-program cases, all ten pass in
`normal-guest-preparer-reviewed-node-1030-143522-1f7f`.

This is explicit CLI preparation, not automatic exec-time integration or a
memory/throughput guarantee for arbitrary compiler inputs. Compiler temporary
files belong on bounded image-backed storage, not the RAM-only `/tmp` mount.
The shell image now provides the normal preparer package lazily and reuses
the SDK archive's existing optimizer. All 175 normal build nodes and 11
products pass. The deployed 24-case cohort includes launching both tools from
the ordinary shell before and after refresh in all three engines, together
with UI/services and source-free WordPress/MariaDB post/media recovery.
Receipt: `program-checkpoint-combined-browser-1030-151304-f7ed`. This still
does not make preparation automatic during installation or execution.

The reproducible offline browser gate owns a production-built fixture server;
it does not reuse a developer's server or require private `.context` scripts:

```sh
scripts/dev-shell.sh ./run.sh prepare-browser
scripts/dev-shell.sh node apps/browser-demos/node_modules/@playwright/test/cli.js \
  test --config apps/browser-demos/playwright-program-compatibility.config.ts \
  --project=chromium --project=firefox --project=webkit --workers=1
```

Its production entry is opt-in, not a new computer template. The dedicated
configuration excludes unrelated browser specs and deletes its own temporary
site on teardown. Ordinary development-server suites do not run this offline
proof without its prepared server. Both memory-backed and OPFS-backed cases
are declared. The latter reopens its existing journal with no new source-image
request, initializes the current runtime helpers, then disables networking
again before regenerating and executing output from the persisted original.
Declaration alone is not acceptance of both cases on every engine.
The six-case owned-server cohort now passes in Chromium, Firefox and WebKit:
`offline-preparer-persistent-final-proof-1030-150138-c185`. Every case observes
exactly one source-image request; the OPFS cases regenerate a fresh output
from the reopened retained original, compare it with the native tool and
execute it with networking disabled again.

This gate tests offline computation in an initialized current runtime, not
offline cold application startup. The WebKit automation offline switch refuses
a fresh nested blob worker after its owning worker has restarted, while an
already initialized owner works. A standalone local HTTP/worker probe with no
Kandelo code reproduces that distinction; restoring connectivity lets the same
fresh blob URL work. The fixture therefore bootstraps helpers before each
offline phase on every engine. No production fallback, relaxed artifact check
or remote compiler is involved. Native Safari with a genuinely disconnected
network has not been tested by this probe.
Run the standalone probe with
`scripts/dev-shell.sh node apps/browser-demos/test/fixtures/offline-nested-blob-probe.mjs`.
It uses only a local HTTP server and plain workers, checks the online and
already-initialized offline controls, and reports whether the fresh-owner
failure reproduces. This is test-tool evidence, not a native Safari finding.

## Original source and prepared image ownership

Re-instrumentation must retain two different files: the original executable
whose permissions authorize execution, and the prepared image whose bytes run.
The internal Rust paired backing now retains both raw regular-file handles in
one kernel-global object. It does not reopen a pathname or copy the image into
each process. Independent procfs opens have independent cursors; duplicate,
fork-inherited and transferred descriptions share their actual cursor state.
Queued descriptor transfers and shared mappings keep both files alive even
after the initiating process exits. A hidden source-description reference also
keeps its advisory-lock identity alive until that ownership ends.

Final descriptor release and final mapping unpin transfer explicit, bounded
cleanup effects out of the global table. Existing I/O-aware cleanup boundaries
close both raw host constituents, even if the first close reports an error.
There is no host-I/O destructor or newly allocated close queue. Removing a
process sweeps orphaned locks after releasing these resources; mapping teardown
also completes that sweep before returning to the host.

The readonly view reads prepared bytes and reports their length and a distinct
file identity, while procfs access checks use live source permissions and its
link follows source deletion. Metadata mutations through the view are refused.
Rust-backed image generations detect same-length writes; host-backed images
also check inode, mode, length and modification/change timestamps. These checks
are not a content seal or proof that a trusted preparer produced the image.

The internal exec path now separates a live source-authority snapshot from
prepared-image observations. Source mode, owner, group, filesystem flags and
file identity authorize execution; image length, bytes and pointer width drive
compilation and the incoming address space. A pair binds the exact retained
source bytes by length/SHA-256, not the raw-original reference's digest. New
preparations refresh source permissions rather than freezing credentials at
pair creation. Saved descriptors and procfs executable links resolve their own
retained source even after another exec, unlink or pathname replacement.

Conversion stages new image observations and a new description before replacing
only the target ledger's reference. It never changes an OFD a guest descriptor
also owns. Conversion refusal preserves the old token and descriptions; exec
commit still consumes its token on either success or refusal. Commit compares
source metadata and mount policy, streams the source digest before and after
image-byte comparison, then checks the image stamp and source generation.
Readonly procfs opens still require source read permission; an execute-only
`O_PATH` source lease does not grant image reads. Private-image writer custody
and sealing remain necessary; metadata stamps do not protect against arbitrary
host mutations that preserve those stamps.

This is not enabled automatic execution. No guest or host export can create or
bind these pairs yet. Original access authorization, trusted bounded helper
completion and sealed cache publication still need integration. Direct-source
preparation plans deliberately refuse pairs rather than hashing image bytes as
if they were source bytes. The normal exec path remains in place; native exec
state tests do not establish browser paired execution or package upgrades.

## Upgrades without archived runtimes

Use one current trusted runtime. Upgrade packaged software through deliberate,
journaled transactions with an explicit package-owned file inventory, handling
user-modified configuration and rollback. Do not automatically replace the
immutable base under an existing journal: inode identity, deletions, hard links,
package ownership and user edits make a blind overlay rebase unsafe. A future
foundation-image upgrade needs a real three-way package/data plan, not just a
new base URL. Future original-program retention addresses derived
instrumentation; it does not repair an incompatible syscall ABI or upgrade a
database schema.

Lazy references are part of package upgrade planning, not a URL substitution
operation. An unresolved reference still names expected content, size, archive
membership and dependencies. A new location can supply the same verified
content; replacing that content requires a package upgrade. Retaining resolved
files while changing unresolved references must not mix incompatible package
versions or overwrite user edits. The durable provider/inode activation needed
for these updates is not implemented yet. Missing old providers must fail
explicitly rather than fetching unrelated latest bytes.

The upgrade policy must distinguish three operations:

- **Relocation:** change the provider location while retaining the exact
  expected content identity. Both resolved and unresolved files remain the
  same package version; a new location is not permission to accept new bytes.
- **Package update:** install a verified, compatible package closure. Compare
  every owned path with the old inventory, including already resolved files.
  Retain unchanged content where possible, refuse user-modified file conflicts,
  and activate new lazy bindings with the package namespace atomically.
- **Unavailable provider:** retain already installed content. Report missing
  unresolved content explicitly, and offer a verified relocation or package
  update; do not silently fetch a different build.

Resolution is a cache/materialization state, not an upgrade boundary. Updating
only unresolved references can mix library and executable versions. Durable
provider records, rollback references and interruption tests are prerequisites
for accepting this policy, not functionality provided by this document.

The native activation foundation can prepare and commit a canonical batch of
existing leaf-inode replacements, namespace timestamps, and an inventory-file
replacement in one journal transaction. It checks expected old inode identities,
refuses live file or mapping references and unsynchronized writeback, reserves
publication and reclamation memory before committing, and retains immutable-base
name markers through compaction. All publication after the commit is infallible.
An interrupted final flush is outcome-uncertain: the old live graph remains,
the failed journal refuses further writes, and reopening determines whether the
old or new complete transaction is present.

This is an internal primitive, not an exposed package updater. It does not
authenticate packages, detect in-place user edits, provide maintenance admission,
or install durable lazy-provider records. Directory/special-node updates,
set-ID regular leaves, and transactions exceeding the journal's size limit
are refused without weakening permissions or splitting the commit. The release goal
still requires the ownership inventory, maintenance coordinator, durable lazy
provider activation, and Node/browser upgrade acceptance.

Ordinary persistent namespace and metadata writers also refuse records that
recovery cannot admit. Immutable regular/lazy set-ID leaves cannot be linked,
unlinked or renamed while preserving those unsupported permission records;
created FIFO/socket nodes cannot acquire set-ID permissions. These operations
return `EPERM` before writing, rather than acknowledging an unreopenable
journal or silently stripping existing permissions. Supported directory setgid
and sticky special-file modes remain available. This is an explicit current
persistent-permission limitation, not complete set-ID mutation support.

The first release requires explicit compatibility warnings and integrated
persistence validation. Transactional package/lazy-reference upgrades remain
follow-up work. Persistent images are not advertised as permanently compatible.

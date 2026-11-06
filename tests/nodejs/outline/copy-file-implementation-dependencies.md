# Descriptor-owned filesystem copying

Source128 selects the copy owner’s reflink header by actual availability.
Targeted engine127failed on an absent linux/fs.h selected by the existing
package macro;it also recorded an unresolved SDK calltypes-plugin crash.
Both failures remain saved. The corrected header compiles through the actual
SDK in normal and legacy-macro control modes.20zero-directory controls and
12package checks pass;the43-case portable matrix retains1errno mismatch.
Accepted engine116remains stale;source117–128is uncompiled as a full engine.
All19families remain partial;overall suites/full product rebuild stay deferred.
See [copy ownership](copy-file-implementation-dependencies.md).


Source127 imports exact public copyFile/copyFileSync and promise algorithms
from pinned Node26.13.0. The native owner opens real source/destination fds,
checks inode identity before truncating,uses O_EXCL on the actual destination
open and transfers at most8192bytes at once. Real metadata operations and
source/destination close errors follow reviewed pinned libuv precedence.
Opened destinations are removed after copy failure;failed exclusive opens
never remove another operation's destination. Best-effort cloning falls back
after an actual failure;forced cloning fails ENOSYS without a platform ioctl.
No reflink success is synthesized.

Callbacks/promises use the shared native work/FSReq machinery with owned path
snapshots,associated memory,error path+dest and request roots. Worker byte
copying enters no JavaScript. Bootstrap overrides legacy public relays and
routes lexical synchronous callers through the same owner.

Empty guest directories have a real entry-count stat size of zero. The owner
checks the existing fd's S_IFDIR after destination/metadata/clone stages,
preserving their error precedence. It returns EISDIR and cleans up rather than
silently reporting an empty-file copy. Source and symlink metadata are intact.

## Focused evidence

Root35frontend checks pass:6new public groups plus29affected filesystem groups.
These use actual pinned native Node dependencies,not Kandelo guest JSAPI.
Seven complete references,six selected sections,628guarded inputs,generation,
bootstrap syntax,native unity order and zero-fuzz/reverse-exact engine105
registration pass. An initial source-check fixture omitted a staged header;
its failure log is retained and the corrected fixture mirrors recipe staging.
Twelve package-input checks pass,separately. Two complete unchanged upstream
files pass in both candidate-wrapper/native modes(4runs);their assertions and
platform identity are unchanged. They exercise native dependency operations,
not the portable fd owner.

Root strictly compiled the portable fd owner and reran20zero-directory
controls(all pass) plus43native/fault/race controls(42pass,1nonpass). Zero-dir
controls use real host fds with transparently exposed guest-like directory
size;they are not guest-kernel tests. The43case matrix includes actual24-way
exclusive races,binary boundaries,metadata,partial/error I/O and cleanup.

## Unresolved differences and remaining owners

Directory source returns EISDIR while pinned Darwin sendfile returns ENOTSUP.
This is an unresolved platform/error compatibility difference,not an accepted
exclusion. Concurrent source shrink reaches EOF and stops in the candidate;
three earlier native-only observations include two timed-out copies after
actual shrink. Candidate zero-byte write returns EIO;the reference loop can
make no progress. These guards remain explicit differences pending contract
review;they are robustness controls,not passing native parity or a declared
external runtime defect. No assertion was weakened.

The sealed private handoff's sanitizer executable produced no output and was
killed;no sanitizer pass or cause is established. Native clone-success and
host-specific chmod branches remain untested. Actual guest FSReq queue,
shutdown/cancellation,GC/OOM/realm,byte-path/error/metadata/clone behavior and
four-host conformance remain open. Source117–127is uncompiled and accepted116
is stale. No package/engine/kernel/product compilation or overall suite ran
for this slice;one standalone host helper compiled. No performance claim.
Kernel/host ABI and exact audited target/source/native pins are unchanged.

## Source128 build follow-up

Targeted127engine compilation failed on missing linux/fs.h. The header had
selected that include from __linux__,which the existing engine recipe defines
although the guest SDK lacks that header. Source128 selects the actual header
with __has_include;FICLONE still gates the real ioctl and force still truthfully
fails when it is absent. This is capability selection,not a fabricated ioctl.
The package’s inherited Linux target/macro remains separate portability debt
to replace with accurate platform feature configuration;this fix does not
claim to remove it or establish a Linux guest identity.

Two actual SDK Wasm object compilations pass,normal target and explicit legacy
package-macro control. Initial fixture checks failed on an unused driver linker
argument and missing declared C++ headers;both logs are retained. The corrected
control uses resolved libcxx headers and suppresses only the irrelevant driver
argument warning. The portable host helper was rebuilt:20zero-directory passes
and43controls(42pass1existing errno nonpass). Twelve package checks pass.
No additional frontend or upstream runs were needed for this header-only edit;
source127’s35frontend/4upstream runs retain their original scope.

The failed127log also shows an SDK-owned KandeloCallTypes referencedFn stack
and frontend exit139. Its cause/recovery relationship remains unresolved;no
external compiler defect or workaround is claimed. No127artifact was accepted
and128was not rebuilt as a complete engine. Overall58package/engine compile
attempts are now recorded;full product rebuilds and overall suites remain0.
Separate adversarial reviews found lock Promise/snapshot/retention defects
and JWK private-codec/error-state defects;fixes are in private worktrees and
are not part of128or passing guest evidence.

# OS frontend and real POSIX state owners

PROC-004/005 now have full pinned OS frontend source and real POSIX owners
for uname/hostname, home/passwd/user bytes, temporary-directory policy,
endianness and priority operations. Resource/CPU/interface measurements and
constants remain incomplete. No process-family or four-host closure follows.
The exact target and frozen audit remain unchanged.

## Source and actual state

os-platform-adapter.js embeds full unchanged Node 26.13.0 lib/os.js and
checked countBinaryOnes/getCIDR sections. The manifest retains full Node OS,
credentials, encoding and libuv POSIX references. Native operations live in
os-operations.h/native-os.cpp and patch 0069, not JavaScript presets or the
embedding host. The existing os object is populated with the pinned module's
actual descriptors so the values/error owner and public builtin retain the
same namespace identity. Constants retain the audited partial guest seed;
copying the full frontend does not supply missing native constants.

uname supplies actual guest kernel sysname/version/release/machine, instead
of claiming a Linux release or an empty version. Hostname comes from libc's
gethostname, without a fake file/fallback answer. HOME, including empty
strings, follows libuv's environment-first policy; otherwise getpwuid_r of
the actual effective uid supplies passwd home. Home capacity uses the real
compiled PATH_MAX and errors with ENOBUFS as the Node native caller does.

Passwd lookup retries EINTR and grows its actual scratch buffer on ERANGE.
UID/GID/name/home/shell come from the actual passwd record, never USER/SHELL
presets or root constants. All borrowed strings are copied before releasing
scratch storage or allocating JS values. The bridge copies byte arrays;
frontend conversion preserves native encoding choices, case/NUL behavior,
Buffer output and getter exceptions. Private codec decode/copy entry points
bypass mutable public Buffer.from/isEncoding/toString/slice methods, matching
the native conversion boundary. Private UTF-16 encoding tags map to the
existing UCS-2 primitive; non-string encoding objects are not inspected.
No raw passwd/environment pointer or
mutex scope survives a JS allocation. UTF-8 and other conversion still depend
on the existing candidate Buffer algorithms and engine storage owners.

Temporary directory follows the pinned credentials function: safe native
TMPDIR/TMP/TEMP precedence, ignore empty values and remove one trailing
slash except root, then the pinned POSIX /tmp fallback. Privilege/auxiliary
state and permission/worker policy remain the existing process-state owner's
separate obligations; this slice does not invent a new security policy.

getpriority/setpriority call actual libc PRIO_PROCESS operations, clearing
errno before ambiguous successful -1 priority results and preserving actual
status. The pinned frontend supplies overloads/int32/range validation and
SystemError context. Endianness inspects compiled target byte storage.
These add no host import, syscall, wire format or ABI. Recipe revision 55
selects changed JS/prefix, native owner inputs and patch registration.

## Measurement prerequisites and truthful failures

Current sys_getrusage fills zeros, and sys_sysinfo returns fixed uptime/load/
memory/process values. They are Kandelo accounting gaps, not an established
browser/engine limitation. Wrapping them as real Node measurements would
retain wrong-success behavior, so this owner does not do so. Full kernel,
engine and host accounting/lifecycle ownership is still required.

The old OS preset CPU/model/times, 1 GiB/512 MiB totals, zero load, empty
interfaces, wall-clock process-relative uptime and cpus-length parallelism
are removed. cpus, freemem, totalmem, loadavg, networkInterfaces, uptime and
availableParallelism now explicitly throw ERR_METHOD_NOT_IMPLEMENTED.
Those are seven implementation gaps, not passing compatibility or accepted
platform exclusions. The five separately tracked false process/heap/report
claims elsewhere remain open; removing OS presets does not resolve them.

Guest priority state is real, but current raw syscalls restrict non-self
process queries, have incomplete permission/group/user policy, and do not
supply complete scheduler effects. Native host get/setpriority controls do
not prove these guest semantics. Uname fields describe the guest kernel,
not its embedding operating system. Complete uname/machine/hostname lifecycle
and libc/VFS/passwd/credentials/error behavior still need guest evidence.

## Evidence and exact boundaries

Seven new OS controls and eighteen affected process-state/readline/Buffer
controls pass (25 total). A targeted native C++ build compiles the exact portable header
and actual POSIX calls; no guest engine/package/product build occurs. Native
Node supplies Buffer/engine/UV/constants in the frontend fixture. These
controls compare actual uname/hostname/endian, empty/unset/oversized HOME,
temp precedence, user encodings/getter failures, priority validation/errors,
descriptors and explicit unsupported behavior against the exact reference.
The constants input is native control data, not validation of the partial
guest constants seed. Earlier 15-pass stages before home-capacity/self-PID refinement and a
25-pass stage before final private-encoding refinement remain historical,
with exact source/executable copies. Final private-byte controls compare all
user encodings under public Buffer method replacement. Native helper and
Node frontend controls are separate from uncompiled guest StringBytes/JSAPI.

Normal source-only execution uses an explicit native Node OS dependency
control and needs no private compiled artifact. The reported portable-owner
run explicitly selects KANDELO_OS_NATIVE_HELPER; a configured missing helper
raises its actual spawn failure rather than silently changing the backend.
A separate seven-control source-only run checks that default boundary; it is
not added to API coverage or portable-owner evidence.

The helper transport is an owned child. For priority operations only, pid 0
maps to the actual Node control process so get/set observe one real process's
state; production calls libc inside the guest and needs no such mapping.
Priority changes stay within owned test processes. This is an explicit native
transport boundary, not a guest identity or policy substitution.

Three unchanged upstream files pass in candidate/native modes: OS EOL,
home-without-environment and process priorities. Standard NODE_OPTIONS
propagates the candidate preload to the homedir child, so the child assertion
actually exercises the candidate. Native priority permission-conditioned
branches remain unchanged; a file pass does not prove privilege elevation or
full priority ranges on other hosts. No assertion, skip list or platform
identity changes. Full OS and binding-monkeypatch tests remain future coverage
with their actual owner/harness prerequisites; they are not counted as passed.

## Remaining implementation and validation

Implement actual guest process/thread CPU times and resource accounting,
engine heap/external/ArrayBuffer measurements, OS memory budgets/free usage,
CPU inventory/affinity/parallelism, kernel uptime/load and interface tables.
Correct unsupported owner activation only when it can return actual state.
Complete guest OS constants/aliases/conditions, priority cross-process/
credential/scheduler semantics and safe environment/permission/worker rules.
Unexpected uname initialization failure currently raises SystemError, while
the target native path has an assertion/fatal edge; exact startup/fatal
policy remains an unvalidated deviation, not a proven matching branch.

Guest JSAPI/byte/error/GC/realm bridge is uncompiled, and none of the four
hosts has current artifact validation. Source patch/include/registration,
hash and syntax checks are not compiled runtime evidence. After the breadth
pass, run unchanged applicable OS/process/permission/network/accounting
coverage and native differentials over identified guest artifacts within the
existing build authorization. Preserve all unsupported, skipped, failure,
timeout and harness states; none become passing conformance by relabeling.

The subsequent resource-usage slice reached targeted engine76 acceptance.
Five previously tracked wrong-success numeric/report/space values are removed;
actual nominal GC budget is measured, while guest usage/report/space providers
remain implementation gaps. See resource-usage-implementation-dependencies.md
for original evidence, native/guest scope and remaining requirements. No
overall suite/full product rebuild or family closure is established.

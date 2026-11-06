The stat watcher slice implements guest metadata polling for watchFile and
unwatchFile, with the pinned public StatWatcher algorithms and a real native
STATWATCHER owner. It is source work pending engine integration/build and
four-host validation. Source137's bootstrap no-ops remain in the integrated
product until the separate integration delta installs these real routes.

The complete stored Node26.13.0 references and exact selected body identities
are recorded in stat-watcher-sources.json. generate-stat-watcher.py checks the
unchanged public watchFile/unwatchFile and StatWatcher selections. The entire
libuv fs-poll.c and uv__to_stat function body execute unchanged. Their private
port supplies actual native request submission, monotonic one-shot deadlines,
active/ref state, asynchronous close queues and owned allocation retirement.
These private C++ structs are not libuv's binary ABI. Time storage preserves
64-bit target/time_t64 values even when guest long is 32 bits; no post-2038
truncation or fabricated metadata is substituted.

native-stat-watcher.cpp submits actual guest POSIX stat work to the existing
native pthread queue. Only that worker executes stat, with EINTR retry. The
owning thread receives completion and invokes the unchanged poll algorithm;
there is no synchronous stat on the JS call path or Node/host filesystem
observer substituted for the guest backend. Each polling context owns its path
copy. Stop leaves an in-flight request owned until its real completion retires
that context; shutdown stops all parents, joins/cancels native work, then drains
native closes without user callbacks. No borrowed worker path outlives its
allocation and no JS value or GC root enters a worker.

The actual native class owns reserved state/frame/callback slots, async ID,
default-trigger ID, provider STATWATCHER, receiver validation, context list and
active/closing roots. Native onchange lookup and callability happen before
entering its actual callback scope. Current/previous records come from real
stat fields in native typed arrays. Close callback preparation finishes before
publishing a new closing root. Throwing native material constructors release
their original js_malloc bodies. Inactive weak GC transfers only native state
to the asynchronous close queue, with no resurrection or JS callback during
finalization. Already-closed state retires once. The existing async destroy
registry may allocate while Finalized queues an ID; only intrusive close-list
publication is allocation-free, not the entire close/destroy path.

The copied public algorithms own listener overloads, normalized path identity,
first-watcher options, reference counters, Number/BigInt Stats construction,
stop nextTick and EventEmitter behavior. Missing files and changed errors use
the pinned algorithm's real negative status and zero missing-stat record;
repeated identical errors are suppressed. Reappearance retains the last valid
previous stat. The legacy public StatWatcher.start no-op is preserved because
that method is intentionally a no-op in the exact pin; the actual private
start symbol dispatches a real native poll owner.

The shared clock extension samples actual CLOCK_MONOTONIC milliseconds once
and updates existing ELD and stat-poll contexts at the same native cache point.
It creates no new environment/account on lookup or shutdown. The separate
shell delta combines referenced watcher/pending-close liveness and minimum
backend delay with ELD/locks/providers, and adds a bounded close phase after
native work retirement. Global due order and callback phases across independent
JS/ELD/stat timer registries, and the existing poll(0)/bounded-wait topology,
remain open until real engine integration/host observations. No equivalent
libuv global phase behavior is inferred from these source hooks.

Native allocations use the existing process allocation/claim ledger. StartPoll
passes an actual existing owning account for the polling context and copied
path. State, loop and work records have their own real claims. Contextless
portable controls remain pending; account retirement moves real retained costs
to the pending pool, and exact last close frees the material. These are
requested allocation/object capacities, not allocator/control-block overhead,
admission limits or RSS. The actual primary-environment JSAPI projection and
GC pressure remain unvalidated in this slice.

Focused evidence uses exact native26 plus a separately named host component:
unchanged public algorithms and the actual portable owner over native async
POSIX stat workers and one-shot uv scheduling. It does not use Node watchFile
as the candidate backend. Component dependencies include Node Events/path,
Stats validation/constructors, actual observed NAPI async IDs and Node async
scope primitives. This validates those component contracts, not the uncompiled
SpiderMonkey class/provider/GC/frame/realm implementation or guest loop. A
separate one-line internal/util.setOwnProperty correction is a prerequisite:
the own value must be returned, so a lazy Stats Date getter returns the stored
Date on its first access. The original failed first-access assertion is kept.

Remaining scope is explicit. The native class/realm/GC/exception/worker teardown
source has not compiled or run in SpiderMonkey. Complete internal HandleWrap/
AsyncWrap prototype and internal binding constructor/descriptors/global aliased
stats-buffer interoperability are not supplied by a JS wrapper's exports.
Current native snapshots are owned fresh arrays; Node's binding-global array
alias semantics need coordinated filesystem binding ownership if treated as an
observable internal contract. Transfer/clone restrictions require engine checks;
no native slot is serialized as JS metadata. OOM/init-hook/getter reentry and
full callback/error/clock order still require the actual engine. A host component
NAPI resource is not a native STATWATCHER provider conformance pass.

fs.watch/FSWatcher native notifications and promises.watch remain separate
unimplemented owners. Enabled public VFS/provider routing, permissions, and
VFS/OPFS metadata precision/change propagation remain implementation gaps;
real polling cannot invent timestamps or birthtime absent from the guest stat
interface. The unchanged generic libuv conversion uses the documented ctime
fallback where no creation field exists. No whole-filesystem API closure,
current guest/four-host runtime conformance, sanitizer or performance result is
claimed. The completed audit ledger, target/source/native pins and unrelated
Claude/npm/Bun work are unchanged.

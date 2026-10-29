//! Program-visible artifact and fork-instrumentation contracts.
//!
//! This crate deliberately has no dependency on kernel/host-only metadata.
#![no_std]

/// Kernel ABI version.
///
/// This number is baked into every compiled user program (wasm custom section
/// `wasm-posix-abi`) and exported by the kernel as `__abi_version`. The host
/// refuses to launch binaries whose ABI does not match the running kernel.
///
/// **Bump this whenever the binary-level contract between user programs and
/// the kernel changes in a way that breaks backward compatibility.**
///
/// The structural snapshot at `abi/snapshot.json` is the source of truth for
/// what that contract covers — field offsets of marshalled structs, channel
/// header layout, syscall numbers, and kernel export signatures. CI
/// regenerates the snapshot and compares it to the committed copy; any diff
/// requires bumping `ABI_VERSION` in the same commit.
///
/// See `docs/abi-versioning.md` for the full policy.
///
/// 13: process memory layout ABI is Rust-declared; per-pthread slots
///     use explicit TLS/control, fork-save, channel, and spill pages,
///     with a wasm-declared reserved thread-slot count.
/// 15: remove the obsolete `kernel_set_mode` export; the kernel is always
///     the shared point of contact for all programs.
/// 16: process creation takes explicit stdio descriptor kinds and removes the
///     post-creation stdin pipe mutation export.
/// 17: intentionally skipped during release coordination.
/// 18: fork frame cursors are absolute save-buffer addresses, isolating
///     concurrent pthread unwind payloads.
/// 19: bridged TCP EPIPE delivery raises SIGPIPE unless the caller suppresses
///     it, matching the signal contract of local stream writes.
/// 20: mremap rejects unsupported flag bits instead of silently accepting
///     them under the existing syscall number.
/// 21: missing, PID-zero, and reaped procfs paths report ENOENT instead of
///     returning synthetic success through stat/access/path operations.
/// 22: socket addresses, option pointers, accepted descriptors, multicast,
///     routing, hostname errors, and inherited socket state are reconciled.
/// 23: TCP FIN, EOF, EPIPE, wakeup, bridge-reader, and queued-data behavior
///     use the required real-reader kernel export.
/// 24: datagram admission, Unix EAGAIN, blocking, readiness, wakeups, and
///     finite deadlines expose queue pressure consistently.
/// 25: broadcast errors, MSG_TRUNC results, and zero-length output pointers
///     follow the reconciled datagram contract.
/// 26: wait/signal, mmap, exec, descriptor/socket/shared-memory inheritance,
///     fork metadata, epoll, sleep, and forced-removal state are preserved.
/// 27: rebuilt PHP programs require the cooperative VM-interrupt host hook,
///     and POSIX timer notifications use validated fixed-width signal fields.
/// 28: host path, clock/timer, exec/spawn, worker, and persistent-VFS behavior
///     is aligned across Node and browser runtime boundaries.
/// 29: cancellation-point function types, 64-bit argument slots, lseek state,
///     and select/pselect signal interruption are reconciled.
/// 30: launch environments and unchanged-ID chown operations preserve their
///     process, authorization, and backend-error semantics.
/// 31: operation-wide file-size preflight and exact-thread SIGXFSZ delivery
///     are required for write-family operations.
/// 32: component-wise path, symlink, mount, errno, and current-directory
///     resolution use one canonical namespace contract.
/// 33: no-follow symlink ownership requires the lchown host surface and its
///     descriptor/flag behavior.
/// 34: pathconf uses 64-bit result storage, live-object queries, and the
///     required host marshalling surface.
/// 35: wait/status/rusage, WNOWAIT, stop/continue, blocking, and pthread-exit
///     lifecycle use the reconciled process wire contract.
/// 36: side-module replay-control memory and concurrent pthread-fork
///     arbitration share one host/guest continuation contract.
/// 37: pending host-delegated AF_INET stream connects expose EINPROGRESS then
///     EALREADY to non-blocking callers while blocking callers wait for the
///     same host handshake to complete or fail.
/// 38: sched_getaffinity marshals its fixed kernel mask across process memory,
///     validates live task identity, and exposes the Linux raw return contract.
/// 39: kernel-owned POSIX timer expiration preserves exact thread targets,
///     SI_TIMER metadata, overruns, and finite signal-wait deadlines through
///     the required host timer-fire export.
/// 40: advisory locks are kernel-owned, use stable file/OFD identities and
///     bounded dynamic storage, report ENOLCK distinctly, and no longer
///     require the host_fcntl_lock import; fork/exec OFD state is versioned.
/// 41: main-thread, pthread, and side-module fork continuations reserve 60 KiB
///     so valid wide call stacks do not overwrite adjacent host control state.
/// 42: process and thread identities come from one kernel-owned allocator,
///     while fork continuations use transactional, dynamically allocated
///     linked chunks instead of a fixed-capacity save buffer. Process creation
///     and fork exports return kernel-allocated identities; instrumented
///     modules declare the continuation format and import reserve, commit, and
///     replay hooks.
/// 43: fork artifacts prove activation-state safety explicitly. Activation
///     references, complete exceptions, mutable reference globals, and mutable
///     tables are serialized as versioned process-owned recipes and rebuilt
///     with fresh instance-local identities before continuation replay.
///     Variable-sized host writes into reusable kernel spawn storage and fresh
///     kernel-owned large-I/O storage use tokenized begin/copy/execute
///     transactions; vector I/O executes as one scalar operation, obsolete
///     raw scalar/vector I/O exports and the decomposed-write budget export are
///     removed, and positioned host I/O preserves exact signed-i64 offsets
///     without changing the shared cursor. Paired host append imports report
///     one atomic append's written prefix and exact ending offset before Rust
///     advances the shared cursor. System V IPC control transfers plus
///     caller-native signal-stack, interval-timer, POSIX message-queue,
///     filesystem-statistics, and system-information records use required
///     pointer-width-aware kernel structure sizes. Host-deferred retries retain
///     exact kernel targets through required token/release exports, and their
///     signal interruption policy requires exact target, deliverability,
///     descriptor-mode, and socket-timeout query exports. Each channel request
///     also carries generated, one-shot flags that distinguish `__syscall_cp`
///     from a plain syscall with the same number and defer signal delivery for
///     completions consumed outside libc's post-syscall trampoline. OSS PCM
///     ioctl transfers use request-sized arguments, `/dev/dsp` descriptors
///     share a refcounted stream across fork and exec, and the host consumes a
///     versioned bounded transport paced by the audio clock. evdev
///     `/dev/input/event{0,1}` join the kernel device surface additively: the
///     kernel gains the `kernel_input_event` and `kernel_set_input_canvas_dims`
///     exports and the `E`-magic `EVIOC*` ioctl family, and — like `/dev/dsp` —
///     shares one refcounted event ring per open file description across `dup`,
///     `fork`, and `exec` so a buffered record is delivered once rather than
///     duplicated into each descendant. These are new surfaces, not changes to
///     existing 43 contracts, so they ride ABI 43.
/// 44: `WasmStat` grows 88→96 with a trailing `st_rdev: u64` (offset 88, the
///     slot the libc `struct kstat` already reserved). Virtual device nodes
///     report a Linux-encoded `dev_t` — `/dev/input/event{N}` is char major
///     13, minor 64+N — so a `stat().st_rdev` uniquely identifies an evdev
///     node. Required by the real libinput path backend
///     (`udev_device_new_from_devnum`), which is handed only the `st_rdev`
///     and must recover the devnode from it. The same epoch carries the
///     Wayland stack's other contract changes, structural and semantic:
///     the `SO_PEERCRED` option (peer credentials; it used to fail with
///     `ENOPROTOOPT`), the evdev `EVIOCGPHYS`/`EVIOCGUNIQ`/`EVIOCGPROP`
///     ioctl family, `DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE`, a blocking read
///     of `/dev/dri/card0` that waits for an event instead of returning 0,
///     dma-buf `lseek` on prime fds, epoll registrations keyed on (fd, open
///     file description) and inherited across fork/spawn, epoll fds that
///     report readiness inside poll, prime fds that stay referenced while in
///     flight over SCM_RIGHTS, and the `kernel_epoll_watched_fd` export. docs/abi-versioning.md ("ABI 44") lists
///     each with why it belongs to this epoch.
/// 45: the DRI desktop stack (GPU-tier buffers, layer shell, the toolkit
///     ports). The kernel's `host_gl_present` import now returns a status
///     (`i32`), a new `host_gbm_gpu_bo_create` import backs
///     `DRM_IOCTL_WPK_CREATE_GPU_BO` (previously ENOSYS), `GLIO_CREATE_SURFACE`
///     attributes grow a target-bo field, a `host_kms_connector_mm` import
///     reports the connector's physical size, and the kernel exports
///     `kernel_swap_poll_sigmask` / `kernel_restore_poll_sigmask`. Semantic changes ride along:
///     epoll_pwait holds its signal mask for the whole
///     wait and a signal ends a parked wait, SA_RESTART alone decides whether
///     an interrupted wait restarts, sendmsg/recvmsg gather every iovec, a
///     new thread's stack pointer is 16-byte aligned, the GL command stream
///     gains three ops and a query, /dev/input/event1 is an absolute
///     pointer, inotify fails with ENOSYS, and a MAP_FIXED mapping inside a
///     mapping carves it. docs/abi-versioning.md ("ABI 45") lists each.
/// 46: fork metadata survives tools that run after instrumentation. The
///     imported-globals and imported-tables sections move to format 2: the
///     record word that held the import's position is reserved (zero) and
///     hosts find the import by kind, module and name, because wasm-opt may
///     remove or reorder imports. Hosts require only the linked-frame
///     imports (`__wpk_fork_frame_reserve/commit/next`) as a set; the other
///     fork-runtime imports may be absent when the module never calls them.
///     The instrumenter declares the Wasm features its code uses in
///     `target_features` and runs wasm-opt over its own output.
///     Fork sinks: the instrumenter may stop the fork unwind at a boundary
///     function, which calls the new `env.__wpk_fork_boundary` import; the
///     child then enters through the new `wpk_fork_resume_sink` export, and
///     the `kandelo.wpk_fork.boundaries` section lists the boundaries.
///     docs/abi-versioning.md ("ABI 46") lists each.
/// 47: honest program links and kernel-owned host stdin. `HOST_ENV_IMPORTS`
///     declares every `env` import the host provides; executables link against
///     the generated allowance instead of `--allow-undefined`, and the host
///     refuses a program importing anything else. Host-supplied stdin is a
///     kernel pipe on fd 0 (`kernel_install_host_stdin_pipe`), shared across
///     fork/dup/exec, instead of a host handle answered per pid. The GL
///     command stream gains OP_BLEND_FUNC_SEPARATE, OP_BLEND_EQUATION_SEPARATE
///     and QOP_FINISH.
/// 48: opaque channel transport (the guest self-marshals each syscall's
///     pointer arguments into one bounded record, and `TEARDOWN` joins the
///     channel status values), kernel-owned syscall argument marshalling
///     (`sendmsg`/`recvmsg`, the scatter/gather family, SysV IPC and mqueue
///     arguments are read and written by the kernel in the caller's data
///     model; the fixed kernel-scratch iovec/msghdr wires and the SysV
///     sizing exports are gone), a per-process pointer width registered once
///     instead of carried in channel argument slot 5 (which returns
///     `preadv2`/`pwritev2` their `flags`), the dispatch-only kernel export
///     cut, network-interface ioctls served by the kernel, and kernel-owned
///     readiness: epoll interest lists live on the epoll open file
///     description, socket readiness is decided by the kernel from facts the
///     host reports, and blocking waits carry monotonic deadlines.
///     docs/abi-versioning.md ("ABI 48") lists each.
/// 49: the kernel owns the root filesystem. `/` and the scratch mounts are
///     in-kernel filesystems built from the VFS image (new `kernel_rootfs_*`
///     and `kernel_set_*` exports, `env.host_image_read` and
///     `env.host_fetch_deferred` imports, the KLZY image section), and the
///     remaining host filesystem imports follow a handle-only contract (one
///     path component relative to a directory handle; the path-taking
///     `host_open`/`host_stat`/... family is gone). docs/abi-versioning.md
///     ("ABI 49") lists each.
/// 50: guest networking reaches other machines through host-owned segments.
///     The kernel imports `host_udp_source_address` to learn the real IPv4
///     source of a non-loopback UDP route instead of assuming a demo subnet,
///     `host_udp_bind` of a specific address fails with `EADDRNOTAVAIL`
///     unless the host owns it, and `FIONREAD` on a datagram socket reports
///     the next packet's size. Remote TCP adds the `host_net_connect_from`,
///     `host_net_local_endpoint` and `host_net_shutdown` imports and the
///     `kernel_tcp_connection_id` / `kernel_reset_tcp_connection` exports;
///     a host-backed shutdown keeps its
///     connection handle until close, and accepted connections report the
///     routed local address. docs/abi-versioning.md ("ABI 50") lists each.
/// 51: epoll notification delivery, edge/one-shot rearming, registration
///     lifetime, nesting validation, fairness, and stream half-close readiness.
/// 52: processes import `kernel_heap_safepoint`. The syscall glue bounds its
///     channel wait and calls it after a timeout so a JavaScriptCore VM can
///     finish a collection that is suspected to be handed to a blocked thread
///     and to starve other workers' collections. docs/abi-versioning.md
///     ("ABI 52").
/// 53: the extended-attribute syscalls marshal their arguments and carry
///     channel scalar contracts. docs/abi-versioning.md ("ABI 53") lists each.
/// 54: the rust-first kernel batch (one unreleased epoch for the whole
///     batch PR). The kernel decides what an exec or spawn runs
///     (`kernel_spawn_process` reads the SYS_SPAWN request itself; the spawn
///     scratch reservation exports are gone; `kernel_process_metadata_read`;
///     `kernel_exec_target_admit`); later commits of the batch fold their
///     changes in here. docs/abi-versioning.md ("ABI 54") lists each.
/// 55: programs bind only to the program surface. The `kandelo.abi.contract`
///     digest every program carries now covers `ABI_VERSION` plus the snapshot
///     sections `xtask dump-abi` marks as the program surface
///     (`abi_surfaces`), not kernel exports, kernel imports, host-adapter
///     metadata or kernel-host wire formats. Those bump the kernel-host
///     version, `abi::HOST_ADAPTER_VERSION` (now 2, checked exactly), instead
///     of this. docs/abi-versioning.md ("ABI 55").
/// 56: combine main's program-surface digest with kernel-owned graphics
///     sessions, shared contexts, acknowledged surfaces and retained storage.
///     One epoch covers the unpublished graphics compatibility effort.
pub const ABI_VERSION: u32 = 56;


pub mod abi {
    /// Name of the wasm custom section in which user programs embed their
    /// ABI version (single little-endian u32). The kernel host rejects
    /// binaries whose value does not match [`crate::ABI_VERSION`].
    pub const ABI_CUSTOM_SECTION: &str = "wasm-posix-abi";

    /// Name of the wasm global exported by the kernel that carries its
    /// [`crate::ABI_VERSION`] at load time (i32, immutable).
    pub const ABI_KERNEL_EXPORT: &str = "__abi_version";

    /// Globals that each user process instance is expected to expose so
    /// the host can thread channel / TLS state through fork and exec.
    pub const PROCESS_EXPECTED_GLOBALS: &[&str] = &["__channel_base", "__tls_base"];

    /// Kind of an import the host supplies to a user program from `env`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum HostEnvImportKind {
        Function,
        Global,
        Memory,
        Table,
        Tag,
    }

    impl HostEnvImportKind {
        pub const fn as_str(self) -> &'static str {
            match self {
                Self::Function => "function",
                Self::Global => "global",
                Self::Memory => "memory",
                Self::Table => "table",
                Self::Tag => "tag",
            }
        }
    }

    /// One import the host supplies to a user program from the `env` module.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct HostEnvImport {
        pub name: &'static str,
        pub kind: HostEnvImportKind,
        /// Allowed to stay undefined when an executable is linked. False only
        /// for imports a later build step adds (none today outside the fork
        /// runtime, which is declared by `WPK_FORK_REQUIRED_*`).
        pub link_time: bool,
        pub reason: &'static str,
    }

    /// The `env` imports the host really provides to user programs, besides
    /// the fork runtime's imports (declared by `WPK_FORK_REQUIRED_IMPORTS`,
    /// `WPK_FORK_REQUIRED_TABLE_IMPORTS`, `WPK_FORK_GLOBAL_IMPORTS`, and the
    /// unwind tag, which fork instrumentation adds after linking).
    ///
    /// WHY one declaration: the SDK's link-time allowance
    /// (`libc/glue/kandelo-host-imports.txt`) and the host's load-time check
    /// are both generated from this list, so a program can leave a symbol
    /// undefined only if the host will supply it. C and C++ library functions
    /// never belong here; they come from libc, libc++abi, or libc++. Before
    /// ABI 47 the SDK linked with `--allow-undefined` and the host stubbed any
    /// unknown import with a throwing function, so configure checks accepted
    /// functions Kandelo lacks and programs trapped when they first called one.
    pub const HOST_ENV_IMPORTS: &[HostEnvImport] = &[
        HostEnvImport { name: "memory", kind: HostEnvImportKind::Memory, link_time: true, reason: "process linear memory" },
        HostEnvImport { name: "__channel_base", kind: HostEnvImportKind::Global, link_time: true, reason: "syscall channel base address" },
        HostEnvImport { name: "__c_longjmp", kind: HostEnvImportKind::Tag, link_time: true, reason: "setjmp/longjmp exception tag shared with the host" },
        HostEnvImport { name: "__cpp_exception", kind: HostEnvImportKind::Tag, link_time: true, reason: "C++ exception tag shared with the host" },
        HostEnvImport { name: "__wasm_dlopen_main", kind: HostEnvImportKind::Function, link_time: true, reason: "dynamic loader: main-program handle" },
        HostEnvImport { name: "__wasm_dlopen_prepare", kind: HostEnvImportKind::Function, link_time: true, reason: "dynamic loader: stage a side module" },
        HostEnvImport { name: "__wasm_dlopen_next", kind: HostEnvImportKind::Function, link_time: true, reason: "dynamic loader: advance a staged load" },
        HostEnvImport { name: "__wasm_dlopen_commit", kind: HostEnvImportKind::Function, link_time: true, reason: "dynamic loader: commit a staged load" },
        HostEnvImport { name: "__wasm_dlopen", kind: HostEnvImportKind::Function, link_time: true, reason: "dynamic loader: single-step load" },
        HostEnvImport { name: "__wasm_dlsym", kind: HostEnvImportKind::Function, link_time: true, reason: "dynamic loader: symbol lookup" },
        HostEnvImport { name: "__wasm_dlclose", kind: HostEnvImportKind::Function, link_time: true, reason: "dynamic loader: unload" },
        HostEnvImport { name: "__wasm_dlerror", kind: HostEnvImportKind::Function, link_time: true, reason: "dynamic loader: last error text" },
        HostEnvImport { name: "__wasm_posix_vm_interrupt_after", kind: HostEnvImportKind::Function, link_time: true, reason: "host timer that sets a VM interrupt flag (PHP max_execution_time)" },
    ];

    /// Pointer-sensitive value types used by program-artifact function
    /// requirements. `Pointer` resolves to i32 for wasm32 artifacts and i64
    /// for wasm64 artifacts.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ProgramArtifactValueType {
        Pointer,
        I32,
        I64,
        FuncRef,
        ExternRef,
        ExnRef,
        AnyRef,
    }

    /// One required function import in an instrumented program artifact.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ProgramArtifactImport {
        pub module: &'static str,
        pub name: &'static str,
        pub params: &'static [ProgramArtifactValueType],
        pub results: &'static [ProgramArtifactValueType],
    }

    /// One required private table import in an instrumented program artifact.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ProgramArtifactTableImport {
        pub module: &'static str,
        pub name: &'static str,
        pub table64: bool,
        pub element: ProgramArtifactValueType,
        pub minimum: u64,
        pub maximum: Option<u64>,
    }

    /// One immutable global import that fork instrumentation adds to a
    /// program artifact.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ProgramArtifactGlobalImport {
        pub module: &'static str,
        pub name: &'static str,
        pub value: ProgramArtifactValueType,
    }

    /// One required function export in an instrumented program artifact.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ProgramArtifactExport {
        pub name: &'static str,
        pub params: &'static [ProgramArtifactValueType],
        pub results: &'static [ProgramArtifactValueType],
    }

    /// ABI 42+ linked-continuation metadata and function surface.
    ///
    /// WHY this lives in `shared::abi`: these names and descriptor fields are
    /// consumed before a program starts, by the instrumenter, host, and package
    /// publisher. Keeping the publication contract in
    /// Rust-owned ABI metadata makes `dump-abi` record drift instead of
    /// allowing a newly instrumented program to publish successfully and fail
    /// only when its first `fork()` reaches the host.
    pub const WPK_FORK_LINKED_FRAME_FORMAT_SECTION: &str = "kandelo.wpk_fork.linked_frames";
    pub const WPK_FORK_LINKED_FRAME_FORMAT_MAGIC: [u8; 4] = *b"KLCF";
    pub const WPK_FORK_LINKED_FRAME_FORMAT_VERSION: u16 = 1;
    pub const WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE: u16 = 24;
    pub const WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT: u8 = 8;
    pub const WPK_FORK_LINKED_FRAME_FLAG_TRANSACTIONAL_NODES: u16 = 1 << 0;
    pub const WPK_FORK_LINKED_FRAME_FLAG_ABORT_UNWINDING: u16 = 1 << 1;
    pub const WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS: u16 =
        WPK_FORK_LINKED_FRAME_FLAG_TRANSACTIONAL_NODES | WPK_FORK_LINKED_FRAME_FLAG_ABORT_UNWINDING;
    pub const WPK_FORK_LINKED_FRAME_POINTER_WIDTHS: &[u8] = &[4, 8];

    /// ABI 43+ activation-owned module-state recipe format.
    ///
    /// WHY this is shared ABI rather than host-private metadata: an
    /// instrumented activation writes the arena before the host copies linear
    /// memory, and a fresh child instance validates and consumes it. Every
    /// literal below therefore crosses the instrumenter/guest/host boundary.
    pub const WPK_FORK_MODULE_STATE_FORMAT_SECTION: &str = "kandelo.wpk_fork.module_state";
    pub const WPK_FORK_MODULE_STATE_FORMAT_MAGIC: [u8; 4] = *b"KFMD";
    pub const WPK_FORK_MODULE_STATE_FORMAT_VERSION: u16 = 1;
    pub const WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE: u16 = 24;
    pub const WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT: u8 = 8;
    pub const WPK_FORK_MODULE_STATE_FLAG_ROOT_PREFIX_POINTER: u16 = 1 << 0;
    pub const WPK_FORK_MODULE_STATE_FLAG_EXPLICIT_OWNERS: u16 = 1 << 1;
    pub const WPK_FORK_MODULE_STATE_FLAG_SPARSE_TABLES: u16 = 1 << 2;
    pub const WPK_FORK_MODULE_STATE_REQUIRED_FLAGS: u16 =
        WPK_FORK_MODULE_STATE_FLAG_ROOT_PREFIX_POINTER
            | WPK_FORK_MODULE_STATE_FLAG_EXPLICIT_OWNERS
            | WPK_FORK_MODULE_STATE_FLAG_SPARSE_TABLES;
    pub const WPK_FORK_MODULE_STATE_KNOWN_FLAGS: u16 = WPK_FORK_MODULE_STATE_REQUIRED_FLAGS;
    pub const WPK_FORK_MODULE_STATE_ARENA_VERSION: u16 = 1;
    pub const WPK_FORK_MODULE_STATE_RECORD_VERSION: u16 = 1;
    pub const WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET: u32 = 1;
    pub const WPK_FORK_MODULE_STATE_POINTER_WIDTHS: &[u8] = &[4, 8];

    pub const WPK_FORK_MODULE_STATE_CHUNK_MAGIC: [u8; 4] = *b"KFMC";
    pub const WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT: u16 = 1 << 0;
    pub const WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED: u16 = 1 << 1;
    pub const WPK_FORK_MODULE_STATE_CHUNK_KNOWN_FLAGS: u16 =
        WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT | WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED;

    pub const WPK_FORK_MODULE_STATE_RECORD_MAGIC: [u8; 4] = *b"KFMR";
    pub const WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE: u16 = 1;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE: u16 = 2;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL: u16 = 3;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE: u16 = 4;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE: u16 = 5;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS: u16 = 6;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS: u16 = 7;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENTS: u16 = 8;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_GLOBAL_BINDINGS: u16 = 9;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_ACTIVATION_CONTINUATIONS: u16 = 10;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_TABLE_BINDINGS: u16 = 11;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE_SEGMENT: u16 = 12;
    pub const WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENT_SEGMENT: u16 = 13;

    /// One recognized module-state arena record kind.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ForkModuleStateRecordKind {
        pub number: u16,
        pub name: &'static str,
    }

    pub const WPK_FORK_MODULE_STATE_RECORD_KINDS: &[ForkModuleStateRecordKind] = &[
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE,
            name: "module",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE,
            name: "reference_recipe",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL,
            name: "mutable_global",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE,
            name: "table",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE,
            name: "table_page",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS,
            name: "element_segments",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS,
            name: "data_segments",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENTS,
            name: "replay_events",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
            name: "imported_global_bindings",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_ACTIVATION_CONTINUATIONS,
            name: "activation_continuations",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_TABLE_BINDINGS,
            name: "imported_table_bindings",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE_SEGMENT,
            name: "reference_recipe_segment",
        },
        ForkModuleStateRecordKind {
            number: WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENT_SEGMENT,
            name: "replay_event_segment",
        },
    ];

    pub const WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE: u16 = 32;
    pub const WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE: u16 =
        WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE + 8;
    pub const WPK_FORK_MODULE_STATE_MODULE_RECORD_KNOWN_FLAGS: u32 = 0;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE: u16 = 8;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32: u8 = 1;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64: u8 = 2;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32: u8 = 3;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64: u8 = 4;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128: u8 = 5;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF: u8 = 6;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF: u8 = 7;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF: u8 = 8;
    pub const WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF: u8 = 9;
    pub const WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE: u16 = 32;
    pub const WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE: u16 =
        WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE + 24;
    pub const WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES: u32 = 1 << 0;
    pub const WPK_FORK_MODULE_STATE_TABLE_KNOWN_FLAGS: u32 =
        WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES;
    pub const WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE: u16 = 16;
    pub const WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE: u16 = 8;
    pub const WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE: u16 = 8;
    pub const WPK_FORK_MODULE_STATE_DATA_SEGMENT_HEADER_SIZE: u16 = 8;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENTS_OWNER: u32 = 1;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENTS_MAGIC: [u8; 4] = *b"KFRE";
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENTS_VERSION: u16 = 2;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENTS_HEADER_SIZE: u16 = 40;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENT_SIZE: u16 = 8;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENTS_KNOWN_FLAGS: u16 = 0;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_VERSION: u16 = 1;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_CAPACITY: u32 = 4080;
    pub const WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_KNOWN_FLAGS: u16 = 0;
    pub const WPK_FORK_REFERENCE_TRANSACTION_OWNER: u32 = 1;
    pub const WPK_FORK_REFERENCE_TRANSACTION_MAGIC: [u8; 4] = *b"KFRV";
    pub const WPK_FORK_REFERENCE_TRANSACTION_VERSION: u16 = 2;
    pub const WPK_FORK_REFERENCE_TRANSACTION_MANIFEST_SIZE: u16 = 96;
    pub const WPK_FORK_REFERENCE_TRANSACTION_FLAG_SEALED: u32 = 1 << 0;
    pub const WPK_FORK_REFERENCE_TRANSACTION_KNOWN_FLAGS: u32 =
        WPK_FORK_REFERENCE_TRANSACTION_FLAG_SEALED;
    pub const WPK_FORK_REFERENCE_SEGMENT_MAGIC: [u8; 4] = *b"KFRS";
    pub const WPK_FORK_REFERENCE_SEGMENT_HEADER_SIZE: u16 = 40;
    pub const WPK_FORK_REFERENCE_SEGMENT_KNOWN_FLAGS: u16 = 0;
    pub const WPK_FORK_REFERENCE_NODE_RECORD_SIZE: u16 = 48;
    pub const WPK_FORK_REFERENCE_VECTOR_INDEX_SIZE: u16 = 16;
    pub const WPK_FORK_REFERENCE_SECTION_NODES: u16 = 1;
    pub const WPK_FORK_REFERENCE_SECTION_EDGES: u16 = 2;
    pub const WPK_FORK_REFERENCE_SECTION_SCALARS: u16 = 3;
    pub const WPK_FORK_REFERENCE_SECTION_VECTOR_INDEX: u16 = 4;
    pub const WPK_FORK_REFERENCE_SECTION_VECTOR_ENTRIES: u16 = 5;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_OWNER: u32 = 2;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC: [u8; 4] = *b"KFBG";
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_VERSION: u16 = 1;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE: u16 = 40;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDINGS_KNOWN_FLAGS: u16 = 0;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER: u8 = 1;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT: u8 = 2;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE: u8 = 3;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL: u8 = 4;
    pub const WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT: u8 = 5;
    pub const WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX: &str = "__wpk_fork_global_";
    pub const WPK_FORK_ACTIVATION_CONTINUATIONS_OWNER: u32 = 3;
    pub const WPK_FORK_ACTIVATION_CONTINUATIONS_MAGIC: [u8; 4] = *b"KFAC";
    pub const WPK_FORK_ACTIVATION_CONTINUATIONS_VERSION: u16 = 1;
    pub const WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_ACTIVATION_CONTINUATION_ENTRY_SIZE: u16 = 16;
    pub const WPK_FORK_ACTIVATION_CONTINUATIONS_KNOWN_FLAGS: u16 = 0;
    pub const WPK_FORK_ACTIVATION_CONTINUATION_ENTRY_KNOWN_FLAGS: u32 = 0;
    pub const WPK_FORK_IMPORTED_TABLE_BINDINGS_OWNER: u32 = 4;
    pub const WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC: [u8; 4] = *b"KFBT";
    pub const WPK_FORK_IMPORTED_TABLE_BINDINGS_VERSION: u16 = 1;
    pub const WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE: u16 = 24;
    pub const WPK_FORK_IMPORTED_TABLE_BINDINGS_KNOWN_FLAGS: u16 = 0;
    pub const WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE: u8 = 1;
    pub const WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT: u8 = 2;
    pub const WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX: &str = "__wpk_fork_table_";
    pub const WPK_FORK_MODULE_STATE_MIN_TABLE_PAGE_SHIFT: u8 = 4;
    pub const WPK_FORK_MODULE_STATE_MAX_TABLE_PAGE_SHIFT: u8 = 20;
    /// Exact sparse-page geometry emitted by the ABI 43 instrumenter.
    pub const WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT: u8 = 10;

    /// ABI 43 imported-global ownership metadata. A fresh child consumes this
    /// before module instantiation, which is earlier than KFMS restore and is
    /// therefore the only phase that can preserve immutable exports and
    /// constant initializers that observe imported globals.
    pub const WPK_FORK_IMPORTED_GLOBALS_SECTION: &str = "kandelo.wpk_fork.imported_globals";
    pub const WPK_FORK_IMPORTED_GLOBALS_MAGIC: [u8; 4] = *b"KFIG";
    /// Format 2 (ABI 46): the record word at offset 20 is reserved and must
    /// be zero. Format 1 stored the import's position there, which wasm-opt
    /// invalidates by removing or reordering imports; hosts now resolve the
    /// import by kind, module and name.
    pub const WPK_FORK_IMPORTED_GLOBALS_VERSION: u16 = 2;
    pub const WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE: u16 = 16;
    pub const WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_IMPORTED_GLOBAL_FLAG_MUTABLE: u8 = 1 << 0;
    pub const WPK_FORK_IMPORTED_GLOBAL_FLAG_SHARED: u8 = 1 << 1;
    pub const WPK_FORK_IMPORTED_GLOBAL_KNOWN_FLAGS: u8 =
        WPK_FORK_IMPORTED_GLOBAL_FLAG_MUTABLE | WPK_FORK_IMPORTED_GLOBAL_FLAG_SHARED;
    pub const WPK_FORK_IMPORTED_TABLES_SECTION: &str = "kandelo.wpk_fork.imported_tables";
    pub const WPK_FORK_IMPORTED_TABLES_MAGIC: [u8; 4] = *b"KFIT";
    /// Format 2 (ABI 46): as for imported globals, offset 20 is reserved.
    pub const WPK_FORK_IMPORTED_TABLES_VERSION: u16 = 2;
    pub const WPK_FORK_IMPORTED_TABLES_HEADER_SIZE: u16 = 16;
    pub const WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE: u16 = 24;
    pub const WPK_FORK_IMPORTED_TABLE_FLAG_TABLE64: u8 = 1 << 0;
    pub const WPK_FORK_IMPORTED_TABLE_KNOWN_FLAGS: u8 = WPK_FORK_IMPORTED_TABLE_FLAG_TABLE64;

    /// Kernel-facing lazy-linkage section of a VFS image ("KLZY").
    ///
    /// A VFS image's trailing sections are otherwise JSON, and JSON is the
    /// host's persistence form for host authority: fetch URLs, transports,
    /// integrity digests, activation seals, and per-builder image metadata.
    /// Exactly two facts in it are kernel-relevant — a lazy file's real size,
    /// and an archive member's `(archive_id, source_path, size)` — and the
    /// kernel already consumes both in binary today through RTFS v3's
    /// `KIND_LAZY_FILE` entries. `KLZY` moves that same kernel-needed subset
    /// into the image itself, so the kernel can read an image's lazy linkage
    /// without a JSON parser and without the host walking the tree first.
    ///
    /// The section is appended after the image-metadata section and announced
    /// by `VFS_IMAGE_FLAG_HAS_KERNEL_LAZY`. Readers that predate it stop at
    /// the metadata section and never observe either the flag or the bytes.
    ///
    /// Layout (all little-endian), following the `KFIG` idiom:
    ///
    /// Header (`VFS_IMAGE_KERNEL_LAZY_HEADER_SIZE` = 20 bytes): `+0` magic
    /// `KLZY`, `+4` version (u16), `+6` header size (u16), `+8` archive-group
    /// count (u32), `+12` file-record count (u32), `+16` reserved (u32, 0).
    ///
    /// Then `group_count` group records
    /// (`VFS_IMAGE_KERNEL_LAZY_GROUP_HEADER_SIZE` = 24 bytes + name): `+0`
    /// record size (u32, `24 + mount_prefix_len`), `+4` archive id (nonzero
    /// u32, strictly increasing), `+8` archive byte length (u64), `+16` flags
    /// (u16), `+18` reserved (u16, 0), `+20` mount-prefix length (u32),
    /// followed by the UTF-8 mount prefix.
    ///
    /// Then `file_count` file records
    /// (`VFS_IMAGE_KERNEL_LAZY_FILE_HEADER_SIZE` = 24 bytes + path): `+0`
    /// record size (u32, `24 + source_path_len`), `+4` inode number (nonzero
    /// u32, unique), `+8` real size in bytes (u64), `+16` archive id (u32; `0`
    /// means a URL-backed single lazy file rather than an archive member),
    /// `+20` source-path length (u32; zero exactly when the archive id is
    /// zero), followed by the UTF-8 source path relative to the archive root.
    ///
    /// `archive_id` is assigned by the image writer rather than minted at
    /// boot, so the kernel's archive table and the host's fetch table cannot
    /// drift. It is an image-local ordinal and carries no transport meaning.
    pub const VFS_IMAGE_KERNEL_LAZY_MAGIC: [u8; 4] = *b"KLZY";
    pub const VFS_IMAGE_KERNEL_LAZY_VERSION: u16 = 1;
    pub const VFS_IMAGE_KERNEL_LAZY_HEADER_SIZE: u16 = 20;
    pub const VFS_IMAGE_KERNEL_LAZY_GROUP_HEADER_SIZE: u16 = 24;
    pub const VFS_IMAGE_KERNEL_LAZY_FILE_HEADER_SIZE: u16 = 24;
    /// No group flag is defined yet. A `SOURCE_PATH_DERIVED` bit — "every
    /// member's source path is its VFS path with `mount_prefix + '/'`
    /// stripped" — is reachable here, but only for a writer that PROVES the
    /// invariant per group and falls back to explicit paths otherwise. Today's
    /// images satisfy it, but that is a property of today's builders, not of
    /// the format, so the writer encodes every source path explicitly.
    pub const VFS_IMAGE_KERNEL_LAZY_GROUP_KNOWN_FLAGS: u16 = 0;
    /// Announces the trailing `KLZY` section in the VFS image header's flags
    /// word. Bits 0-3 are `HAS_LAZY`, `HAS_LAZY_ARCHIVES`, `HAS_METADATA`, and
    /// `HAS_TYPED_LAZY_ARCHIVES` (see `crates/runtime-core/src/kandelo_image_fs.rs`).
    pub const VFS_IMAGE_FLAG_HAS_KERNEL_LAZY: u32 = 1 << 4;

    /// ABI 43 structural Wasm GC reconstruction catalog.
    ///
    /// GC object identities cannot cross Store or worker boundaries. The
    /// catalog lets the fresh child allocate the same typed object graph and
    /// then fill its scalar and reference fields without retaining parent
    /// instance references.
    pub const WPK_FORK_GC_CODEC_SECTION: &str = "kandelo.wpk_fork.gc_codec";
    pub const WPK_FORK_GC_CODEC_MAGIC: [u8; 4] = *b"KFGC";
    pub const WPK_FORK_GC_CODEC_VERSION: u16 = 1;
    pub const WPK_FORK_GC_CODEC_HEADER_SIZE: u16 = 16;
    pub const WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE: u16 = 44;
    pub const WPK_FORK_GC_CODEC_FIELD_RECORD_SIZE: u16 = 12;

    /// ABI 43 exact-tag exception reconstruction catalog.
    ///
    /// A tag is instance-local, so copied `exnref` values cannot be replayed
    /// by importing a JavaScript-side reference. The instrumented activation
    /// publishes deterministic tag ordinals and payload layouts instead. The
    /// fresh child reconstructs each exception using its own corresponding tag.
    pub const WPK_FORK_EXCEPTION_CODEC_SECTION: &str = "kandelo.wpk_fork.exception_codec";
    pub const WPK_FORK_EXCEPTION_CODEC_VERSION: u8 = 1;
    pub const WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE: u16 = 8;
    pub const WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE: u16 = 16;

    /// Private zero-payload tag used to unwind instrumented Wasm without
    /// manufacturing values for arbitrary function result types.
    pub const WPK_FORK_UNWIND_TAG_IMPORT_MODULE: &str = "env";
    pub const WPK_FORK_UNWIND_TAG_IMPORT_NAME: &str = "__wpk_fork_unwind";
    pub const WPK_FORK_UNWIND_TRANSPORT_SECTION: &str = "kandelo.wpk_fork.unwind_transport";
    pub const WPK_FORK_UNWIND_TRANSPORT_VERSION: u8 = 1;
    pub const WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY: u8 = 0;

    /// Fixed instance-local identities recreated by static initializers.
    pub const WPK_FORK_STATIC_ROOT_CATALOG_EXPORT: &str = "__wpk_fork_static_root_catalog";
    pub const WPK_FORK_STATIC_ROOT_CATALOG_SECTION: &str = "kandelo.wpk_fork.static_root_catalog";
    pub const WPK_FORK_STATIC_ROOT_CATALOG_MAGIC: [u8; 4] = *b"KFSR";
    pub const WPK_FORK_STATIC_ROOT_CATALOG_VERSION: u16 = 1;
    pub const WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE: u16 = 12;
    pub const WPK_FORK_STATIC_ROOT_HARVEST_EXPORT: &str = "__wpk_fork_static_root_harvest";

    /// Versioned instrumentation claims required by ABI 43.
    ///
    /// Role flags say which call graph was transformed. In ABI 43,
    /// `SIDE_ENTRY` means complete side-module boundary coverage: callers of
    /// every function import and unresolved function-reference dispatch are
    /// resumable even if fork occurs in a different module. The
    /// activation-state bit proves all replay state has a fresh-instance
    /// reconstruction owner.
    pub const WPK_FORK_CAPABILITIES_SECTION: &str = "kandelo.wpk_fork.capabilities";
    pub const WPK_FORK_CAPABILITIES_VERSION: u8 = 1;
    pub const WPK_FORK_CAP_SIDE_ENTRY: u8 = 1 << 0;
    pub const WPK_FORK_CAP_DYLINK_MAIN: u8 = 1 << 1;
    pub const WPK_FORK_CAP_ACTIVATION_STATE_SAFE: u8 = 1 << 2;
    pub const WPK_FORK_CAP_KNOWN_MASK: u8 =
        WPK_FORK_CAP_SIDE_ENTRY | WPK_FORK_CAP_DYLINK_MAIN | WPK_FORK_CAP_ACTIVATION_STATE_SAFE;
    pub const WPK_FORK_CAP_REQUIRED_FLAGS: u8 = WPK_FORK_CAP_ACTIVATION_STATE_SAFE;

    pub const WPK_FORK_FRAME_IMPORT_MODULE: &str = "env";
    pub const WPK_FORK_FRAME_IMPORT_RESERVE: &str = "__wpk_fork_frame_reserve";
    pub const WPK_FORK_FRAME_IMPORT_COMMIT: &str = "__wpk_fork_frame_commit";
    pub const WPK_FORK_FRAME_IMPORT_NEXT: &str = "__wpk_fork_frame_next";
    /// The linked-frame imports every instrumented activation calls. They are
    /// all-or-nothing; the other `WPK_FORK_REQUIRED_IMPORTS` serve optional
    /// state and may be absent when nothing calls them (ABI 46: wasm-opt runs
    /// after instrumentation and removes unused imports).
    pub const WPK_FORK_CORE_FRAME_IMPORTS: [&str; 3] = [
        WPK_FORK_FRAME_IMPORT_RESERVE,
        WPK_FORK_FRAME_IMPORT_COMMIT,
        WPK_FORK_FRAME_IMPORT_NEXT,
    ];
    pub const WPK_FORK_FRAME_IMPORT_PEEK: &str = "__wpk_fork_frame_peek";
    pub const WPK_FORK_RESUME_IMPORT_PEEK: &str = "__wpk_fork_resume_peek";
    pub const WPK_FORK_RESUME_IMPORT_TABLE: &str = "__wpk_fork_resume_table";

    /// Fork boundaries (sinks; docs/plans/2026-10-02-fork-sinks.md). A module
    /// that has boundary functions imports `env.__wpk_fork_boundary: () -> ()`:
    /// the deepest boundary on the stack calls it after committing its own
    /// frame, instead of rethrowing the unwind tag. The host seals the
    /// capture, forks, and begins parent replay before it returns. Such a
    /// module also exports `wpk_fork_resume_sink(sig_index)`, the child entry
    /// for a continuation rooted at a boundary, and lists its boundary
    /// functions in `kandelo.wpk_fork.boundaries`.
    pub const WPK_FORK_BOUNDARY_IMPORT: &str = "__wpk_fork_boundary";
    pub const WPK_FORK_RESUME_SINK_EXPORT: &str = "wpk_fork_resume_sink";
    pub const WPK_FORK_BOUNDARIES_SECTION: &str = "kandelo.wpk_fork.boundaries";

    pub const WPK_FORK_MODULE_STATE_IMPORT_MODULE: &str = "env";
    pub const WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT: &str =
        "__wpk_fork_module_state_record_commit";
    pub const WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND: &str =
        "__wpk_fork_module_state_record_find";
    pub const WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE: &str =
        "__wpk_fork_module_state_record_reserve";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT: &str =
        "__wpk_fork_module_state_table_dirty_count";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK: &str =
        "__wpk_fork_module_state_table_dirty_mark";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE: &str =
        "__wpk_fork_module_state_table_dirty_page";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_STATE_OWNED: &str =
        "__wpk_fork_module_state_table_state_owned";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_BEGIN: &str =
        "__wpk_fork_module_state_table_mutation_begin";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_COMMIT: &str =
        "__wpk_fork_module_state_table_mutation_commit";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_ABORT: &str =
        "__wpk_fork_module_state_table_mutation_abort";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_RECONCILE: &str =
        "__wpk_fork_module_state_table_reconcile";
    pub const WPK_FORK_MODULE_STATE_IMPORT_TABLE_GENERATION_ADDR: &str =
        "__wpk_fork_module_state_table_generation_addr";

    pub const WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE: &str = "env";
    pub const WPK_FORK_EXCEPTION_IMPORT_ACTIVATION: &str = "__wpk_fork_module_activation";
    pub const WPK_FORK_EXCEPTION_IMPORT_BROKER_ENCODE: &str = "__wpk_fork_ref_exn_broker_encode";
    pub const WPK_FORK_EXCEPTION_IMPORT_BROKER_THROW_RECIPE: &str =
        "__wpk_fork_ref_exn_broker_throw_recipe";
    pub const WPK_FORK_EXCEPTION_IMPORT_CACHE_INDEX: &str = "__wpk_fork_ref_exn_cache_index";
    pub const WPK_FORK_EXCEPTION_IMPORT_CLAIM: &str = "__wpk_fork_ref_exn_claim";
    pub const WPK_FORK_EXCEPTION_IMPORT_DEFINE: &str = "__wpk_fork_ref_exn_define";
    pub const WPK_FORK_EXCEPTION_IMPORT_INGRESS_THROW: &str = "__wpk_fork_ref_exn_ingress_throw";
    pub const WPK_FORK_EXCEPTION_IMPORT_LOAD: &str = "__wpk_fork_ref_exn_load";
    pub const WPK_FORK_EXCEPTION_IMPORT_LOOKUP: &str = "__wpk_fork_ref_exn_lookup";
    pub const WPK_FORK_EXCEPTION_IMPORT_ROUTE: &str = "__wpk_fork_ref_exn_route";

    pub const WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE: &str = "env";
    pub const WPK_FORK_REFERENCE_IMPORT_DECODE_ANYREF: &str = "__wpk_fork_ref_decode_anyref";
    pub const WPK_FORK_REFERENCE_IMPORT_DECODE_EXNREF: &str = "__wpk_fork_ref_decode_exnref";
    pub const WPK_FORK_REFERENCE_IMPORT_DECODE_EXTERNREF: &str = "__wpk_fork_ref_decode_externref";
    pub const WPK_FORK_REFERENCE_IMPORT_DECODE_FUNCREF: &str = "__wpk_fork_ref_decode_funcref";
    pub const WPK_FORK_REFERENCE_IMPORT_ENCODE_ANYREF: &str = "__wpk_fork_ref_encode_anyref";
    pub const WPK_FORK_REFERENCE_IMPORT_ENCODE_EXNREF: &str = "__wpk_fork_ref_encode_exnref";
    pub const WPK_FORK_REFERENCE_IMPORT_ENCODE_EXTERNREF: &str = "__wpk_fork_ref_encode_externref";
    pub const WPK_FORK_REFERENCE_IMPORT_ENCODE_FUNCREF: &str = "__wpk_fork_ref_encode_funcref";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_BROKER_ENCODE: &str = "__wpk_fork_ref_gc_broker_encode";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_CAPTURE_LAYOUT: &str =
        "__wpk_fork_ref_gc_capture_layout";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_CLAIM: &str = "__wpk_fork_ref_gc_claim";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_DEFINE: &str = "__wpk_fork_ref_gc_define";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_I31: &str = "__wpk_fork_ref_gc_i31";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_LOAD: &str = "__wpk_fork_ref_gc_load";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_LOOKUP: &str = "__wpk_fork_ref_gc_lookup";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_PAYLOAD_LEN: &str = "__wpk_fork_ref_gc_payload_len";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_BEGIN: &str =
        "__wpk_fork_ref_gc_provenance_begin";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_END: &str =
        "__wpk_fork_ref_gc_provenance_end";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_REF: &str =
        "__wpk_fork_ref_gc_provenance_ref";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_ROUTE: &str = "__wpk_fork_ref_gc_route";
    pub const WPK_FORK_REFERENCE_IMPORT_GC_TRANSIT: &str = "__wpk_fork_ref_gc_transit";
    pub const WPK_FORK_REFERENCE_IMPORT_SCRATCH_RELEASE: &str = "__wpk_fork_ref_scratch_release";
    pub const WPK_FORK_REFERENCE_IMPORT_SCRATCH_RESERVE: &str = "__wpk_fork_ref_scratch_reserve";
    pub const WPK_FORK_REFERENCE_IMPORT_VECTOR_APPEND: &str = "__wpk_fork_ref_vector_append";
    pub const WPK_FORK_REFERENCE_IMPORT_VECTOR_BEGIN: &str = "__wpk_fork_ref_vector_begin";
    pub const WPK_FORK_REFERENCE_IMPORT_VECTOR_FINISH: &str = "__wpk_fork_ref_vector_finish";
    pub const WPK_FORK_REFERENCE_IMPORT_VECTOR_GET: &str = "__wpk_fork_ref_vector_get";

    pub const WPK_FORK_EXCEPTION_EXPORT_DECODE: &str = "__wpk_fork_ref_decode_exnref";
    pub const WPK_FORK_EXCEPTION_EXPORT_ENCODE: &str = "__wpk_fork_ref_encode_exnref";
    pub const WPK_FORK_EXCEPTION_EXPORT_ABORT: &str = "__wpk_fork_ref_exn_abort";
    pub const WPK_FORK_EXCEPTION_EXPORT_CLEAR: &str = "__wpk_fork_ref_exn_clear";
    pub const WPK_FORK_EXCEPTION_EXPORT_ENCODE_INGRESS: &str = "__wpk_fork_ref_exn_encode_ingress";
    pub const WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE: &str = "__wpk_fork_exception_materialize";
    pub const WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE: &str = "__wpk_fork_ref_exn_throw_recipe";
    pub const WPK_FORK_EXCEPTION_EXPORT_THROW_SLOT: &str = "__wpk_fork_ref_exn_throw_slot";
    pub const WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE: &str = "__wpk_fork_ref_gc_allocate";
    pub const WPK_FORK_REFERENCE_EXPORT_GC_ENCODE_SLOT: &str = "__wpk_fork_ref_gc_encode_slot";
    pub const WPK_FORK_REFERENCE_EXPORT_GC_FILL: &str = "__wpk_fork_ref_gc_fill";
    pub const WPK_FORK_REFERENCE_EXPORT_GC_PUBLISH_EXTERNREF: &str =
        "__wpk_fork_ref_gc_publish_externref";
    pub const WPK_FORK_REFERENCE_EXPORT_GC_PROBE: &str = "__wpk_fork_ref_gc_probe";

    pub const WPK_FORK_EXPORT_ABORT_BEGIN: &str = "wpk_fork_abort_begin";
    pub const WPK_FORK_EXPORT_ABORT_END: &str = "wpk_fork_abort_end";
    pub const WPK_FORK_EXPORT_MODULE_BOOTSTRAP: &str = "wpk_fork_module_bootstrap";
    pub const WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP: &str = "wpk_fork_module_thread_bootstrap";
    pub const WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE: &str =
        "wpk_fork_module_state_finish_restore";
    pub const WPK_FORK_EXPORT_MODULE_STATE_RESTORE: &str = "wpk_fork_module_state_restore";
    pub const WPK_FORK_EXPORT_MODULE_STATE_SAVE: &str = "wpk_fork_module_state_save";
    pub const WPK_FORK_EXPORT_MODULE_TABLE_STATE_SAVE: &str = "wpk_fork_module_table_state_save";
    pub const WPK_FORK_EXPORT_MODULE_TABLE_STATE_RESTORE: &str =
        "wpk_fork_module_table_state_restore";
    pub const WPK_FORK_EXPORT_RESUME_START: &str = "wpk_fork_resume_start";
    pub const WPK_FORK_EXPORT_RESUME_THREAD: &str = "wpk_fork_resume_thread";
    pub const WPK_FORK_EXPORT_REWIND_BEGIN: &str = "wpk_fork_rewind_begin";
    pub const WPK_FORK_EXPORT_REWIND_END: &str = "wpk_fork_rewind_end";
    pub const WPK_FORK_EXPORT_STATE: &str = "wpk_fork_state";
    pub const WPK_FORK_EXPORT_UNWIND_BEGIN: &str = "wpk_fork_unwind_begin";
    pub const WPK_FORK_EXPORT_UNWIND_END: &str = "wpk_fork_unwind_end";

    use ProgramArtifactValueType::{AnyRef, ExnRef, ExternRef, FuncRef, I32, I64, Pointer};

    /// Exact process-worker import that seeds main-program fork discovery.
    ///
    /// Side modules continue to enter through `env.fork`; this requirement is
    /// therefore validated conditionally only when a program imports
    /// `kernel.kernel_fork`.
    pub const WPK_FORK_PROCESS_IMPORT: ProgramArtifactImport = ProgramArtifactImport {
        module: "kernel",
        name: "kernel_fork",
        params: &[I32],
        results: &[I32],
    };

    /// Process-worker import the syscall glue calls after a bounded wait
    /// times out (ABI 52).
    ///
    /// JavaScriptCore is suspected to keep a blocked worker's heap access, so
    /// a collection that began in its VM could finish only when that thread
    /// allocates from JavaScript (suspected cause, not a confirmed WebKit
    /// defect; see docs/browser-support.md). The host import allocates, then
    /// returns the next wait bound in nanoseconds, or a negative value when
    /// its engine needs no bound.
    /// `libc/glue/channel_syscall.c` declares it outside `libc.a`, so the
    /// package import audit adds it to the SDK contract from this
    /// declaration.
    pub const HEAP_SAFEPOINT_PROCESS_IMPORT: ProgramArtifactImport = ProgramArtifactImport {
        module: "kernel",
        name: "kernel_heap_safepoint",
        params: &[],
        results: &[I64],
    };

    pub const WPK_FORK_REQUIRED_IMPORTS: &[ProgramArtifactImport] = &[
        ProgramArtifactImport {
            module: WPK_FORK_FRAME_IMPORT_MODULE,
            name: WPK_FORK_FRAME_IMPORT_COMMIT,
            params: &[Pointer],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_FRAME_IMPORT_MODULE,
            name: WPK_FORK_FRAME_IMPORT_NEXT,
            params: &[Pointer],
            results: &[Pointer],
        },
        ProgramArtifactImport {
            module: WPK_FORK_FRAME_IMPORT_MODULE,
            name: WPK_FORK_FRAME_IMPORT_PEEK,
            params: &[Pointer],
            results: &[Pointer],
        },
        ProgramArtifactImport {
            module: WPK_FORK_FRAME_IMPORT_MODULE,
            name: WPK_FORK_FRAME_IMPORT_RESERVE,
            params: &[Pointer],
            results: &[Pointer],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT,
            params: &[Pointer],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND,
            params: &[I32, I32, I32, I32],
            results: &[Pointer],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE,
            params: &[I32, I32, I32, Pointer],
            results: &[Pointer],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK,
            params: &[I32, I64, I64],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE,
            params: &[I32, I32],
            results: &[I64],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_ABORT,
            params: &[],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_BEGIN,
            params: &[],
            results: &[I64],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_COMMIT,
            params: &[I32, I64, I64],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_RECONCILE,
            params: &[],
            results: &[I64],
        },
        ProgramArtifactImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_STATE_OWNED,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_DECODE_FUNCREF,
            params: &[I32],
            results: &[FuncRef],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_ENCODE_FUNCREF,
            params: &[FuncRef],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_BROKER_ENCODE,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_BROKER_THROW_RECIPE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_CACHE_INDEX,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_CLAIM,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_DEFINE,
            params: &[I32, I32, I32, I32, Pointer, I32, Pointer, I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_INGRESS_THROW,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_LOAD,
            params: &[I32, I32, I32, I32, Pointer, I32, Pointer, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_LOOKUP,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_ROUTE,
            params: &[I32, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_BROKER_ENCODE,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_CAPTURE_LAYOUT,
            params: &[I32, I32, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_CLAIM,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_DEFINE,
            params: &[I32, I32, I32, I32, I32, Pointer, I32, I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_I31,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_LOAD,
            params: &[I32, I32, I32, I32, I32, Pointer, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_LOOKUP,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_PAYLOAD_LEN,
            params: &[I32, I32, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_BEGIN,
            params: &[I32, I32, I32, I32, I64, I64, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_END,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_PROVENANCE_REF,
            params: &[I32, I32, I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_ROUTE,
            params: &[I32, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_SCRATCH_RELEASE,
            params: &[Pointer, Pointer],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_SCRATCH_RESERVE,
            params: &[Pointer],
            results: &[Pointer],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_VECTOR_APPEND,
            params: &[I32, I32],
            results: &[],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_VECTOR_BEGIN,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_VECTOR_FINISH,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_VECTOR_GET,
            params: &[I32, I32],
            results: &[I32],
        },
        ProgramArtifactImport {
            module: WPK_FORK_FRAME_IMPORT_MODULE,
            name: WPK_FORK_RESUME_IMPORT_PEEK,
            params: &[I32],
            results: &[I32],
        },
    ];

    pub const WPK_FORK_REQUIRED_TABLE_IMPORTS: &[ProgramArtifactTableImport] = &[
        ProgramArtifactTableImport {
            module: WPK_FORK_REFERENCE_CODEC_IMPORT_MODULE,
            name: WPK_FORK_REFERENCE_IMPORT_GC_TRANSIT,
            table64: false,
            element: AnyRef,
            minimum: 1,
            maximum: None,
        },
        ProgramArtifactTableImport {
            module: WPK_FORK_FRAME_IMPORT_MODULE,
            name: WPK_FORK_RESUME_IMPORT_TABLE,
            table64: false,
            element: FuncRef,
            minimum: 1,
            maximum: None,
        },
    ];

    /// Immutable globals fork instrumentation imports, which the host's fork
    /// runtime supplies per Worker: the activation index the exception and GC
    /// codecs read, and the address of the shared table-generation fence
    /// (always i64, whatever the pointer width). Like the lists above, these
    /// are `env` imports a program may carry although no link left them
    /// undefined, so import checks read them from here.
    pub const WPK_FORK_GLOBAL_IMPORTS: &[ProgramArtifactGlobalImport] = &[
        ProgramArtifactGlobalImport {
            module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
            name: WPK_FORK_EXCEPTION_IMPORT_ACTIVATION,
            value: I32,
        },
        ProgramArtifactGlobalImport {
            module: WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            name: WPK_FORK_MODULE_STATE_IMPORT_TABLE_GENERATION_ADDR,
            value: I64,
        },
    ];

    pub const WPK_FORK_REQUIRED_EXPORTS: &[ProgramArtifactExport] = &[
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_DECODE,
            params: &[I32],
            results: &[ExnRef],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_ENCODE,
            params: &[ExnRef],
            results: &[I32],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_ABORT,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_CLEAR,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_ENCODE_INGRESS,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXCEPTION_EXPORT_THROW_SLOT,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_REFERENCE_EXPORT_GC_ENCODE_SLOT,
            params: &[I32],
            results: &[I32],
        },
        ProgramArtifactExport {
            name: WPK_FORK_REFERENCE_EXPORT_GC_FILL,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_REFERENCE_EXPORT_GC_PROBE,
            params: &[I32],
            results: &[I64],
        },
        ProgramArtifactExport {
            name: WPK_FORK_REFERENCE_EXPORT_GC_PUBLISH_EXTERNREF,
            params: &[I32, ExternRef],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_STATIC_ROOT_HARVEST_EXPORT,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_ABORT_BEGIN,
            params: &[Pointer],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_ABORT_END,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_BOOTSTRAP,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_STATE_RESTORE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_STATE_SAVE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_TABLE_STATE_RESTORE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_TABLE_STATE_SAVE,
            params: &[I32],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_REWIND_BEGIN,
            params: &[Pointer],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_REWIND_END,
            params: &[],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_STATE,
            params: &[],
            results: &[I32],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_UNWIND_BEGIN,
            params: &[Pointer],
            results: &[],
        },
        ProgramArtifactExport {
            name: WPK_FORK_EXPORT_UNWIND_END,
            params: &[],
            results: &[],
        },
    ];

    /// Return the version-1 linked-chunk header size for one pointer width.
    pub const fn wpk_fork_linked_chunk_header_size(pointer_width: u8) -> Option<u32> {
        match pointer_width {
            4 => Some(32),
            8 => Some(56),
            _ => None,
        }
    }

    /// Return the version-1 linked-frame-node header size for one pointer
    /// width, including the required eight-byte alignment.
    pub const fn wpk_fork_linked_node_header_size(pointer_width: u8) -> Option<u32> {
        match pointer_width {
            4 => Some(24),
            8 => Some(32),
            _ => None,
        }
    }

    /// Return the version-1 module-state chunk header size for one pointer
    /// width, including the required eight-byte alignment.
    pub const fn wpk_fork_module_state_chunk_header_size(pointer_width: u8) -> Option<u32> {
        match pointer_width {
            4 => Some(40),
            8 => Some(56),
            _ => None,
        }
    }

}

//! Typed linker failures.
//!
//! `host/src/dylink.ts` reports every failure as `new Error(template string)`.
//! Three consumers then have to re-derive the failure's meaning: the staged
//! `dlopen` driver (which must decide whether to roll back), `dlerror()` (which
//! must render a POSIX message), and the fork archive (which must decide
//! whether a replay is recoverable). A typed enum makes that a `match` instead
//! of a substring test, which is the V2 case for moving it.
//!
//! Rendering to a `dlerror()` string is `Display`'s job and lives here so the
//! three executors cannot drift.

use alloc::string::String;
use core::fmt;

pub type DylinkResult<T> = Result<T, DylinkError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DylinkError {
    /// The bytes are not a WebAssembly module at all.
    NotAWasmBinary,
    /// Structurally invalid module bytes. The engine is the validation
    /// authority; this is only for the sections the linker itself reads.
    MalformedModule(&'static str),
    /// No `dylink.0` section: this is a main module, not a side module.
    NotASharedLibrary,
    /// A `dylink.0` sub-section is truncated or self-inconsistent.
    MalformedDylinkSection(&'static str),
    /// An active element segment whose offset is not a compile-time constant.
    UnplaceableElementSegment,

    // ---- Dependency resolution ----
    /// A `DT_NEEDED` entry could not be located.
    DependencyNotFound { library: String, dependency: String },
    /// A dependency that must already be loaded is absent from linker state.
    DependencyMissing { library: String, dependency: String },
    /// The `DT_NEEDED` graph contains a cycle the planner refuses to guess at.
    DependencyCycle { library: String },

    // ---- Symbol resolution (ELF semantics; see `got.rs`) ----
    /// A strong (non-weak) undefined symbol. ELF makes this a load-time
    /// failure for data relocations and for address-taken functions; only a
    /// WEAK undefined symbol legitimately resolves to zero.
    UndefinedSymbol { library: String, symbol: String, kind: &'static str },
    /// The symbol exists but with the wrong kind for the GOT namespace.
    SymbolKindMismatch { library: String, symbol: String, expected: &'static str },
    /// The same symbol appears in both `GOT.mem` and `GOT.func`.
    ConflictingSymbolKind { library: String, symbol: String },

    // ---- Placement ----
    AllocatorUnavailable { library: String },
    AllocationEscapesMemory { library: String },
    /// Replay found the table already grown past the parent's base.
    ReplayTablePastBase { library: String, current: u64, parent: u64 },
    InvalidReplayTableBase { library: String },
    /// A replay archive entry does not describe this module's memory region.
    ArchivedAllocationMismatch { library: String },
    ArchivedMappingEscapesMemory { library: String },
    MissingMappingOwnership { library: String },
    ZeroMemoryModuleOwnsMappings { library: String },

    // ---- TLS ----
    MissingTlsExport { library: String, export: &'static str },
    InvalidTlsSize { library: String },
    InvalidTlsAlign { library: String },
    InvalidTlsBase { library: String },
    MisalignedTlsBase { library: String },
    TlsEscapesReservation { library: String },
    UnexpectedReplayTlsState { library: String },
    MissingReplayTlsBase { library: String },

    // ---- Borrowed (vfork) replay ----
    ActiveDataSegmentInBorrowedReplay { index: u32 },
    UnrecognizedStartFunction { index: u32 },
    BorrowedReplayRequiresSharedMemory { library: String },
    BorrowedReplayCannotResume { library: String },

    // ---- Handles ----
    InvalidHandle { handle: u32 },
    /// A staged `dlopen` transaction token that is not live.
    UnknownTransaction { token: u32 },
    /// Replay asked for a handle the allocator would not have produced.
    HandleOutOfRange { handle: u32 },
    DuplicateLibrary { library: String },

    // ---- Fork artifact admission (contracts evaluated at the loader's call site) ----
    IncompleteForkInstrumentation { library: String },
    ForkActivationOwnerUnavailable { library: String, reason: String },
    MissingReplayActivationId { library: String },
    UnexpectedReplayActivationId { library: String },
    ActivationIdMismatch { library: String, prepared: u32, expected: u32 },
    MissingSavedGotValue { library: String, symbol: String },
    ConflictingSavedGotValue { library: String, symbol: String },

    // ---- Executor contract ----
    /// The executor answered an act with a result of the wrong shape. This is a
    /// host bug, not a guest one.
    ActResultMismatch { expected: &'static str },
    /// The planner was driven out of order.
    UnexpectedActSequence,
}

impl fmt::Display for DylinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DylinkError::NotAWasmBinary => write!(f, "not a WebAssembly binary"),
            DylinkError::MalformedModule(why) => write!(f, "malformed module: {why}"),
            DylinkError::NotASharedLibrary => {
                write!(f, "not a shared library (no dylink.0 section)")
            }
            DylinkError::MalformedDylinkSection(why) => {
                write!(f, "malformed dylink.0 section: {why}")
            }
            DylinkError::UnplaceableElementSegment => {
                write!(f, "element segment offset is not a compile-time constant")
            }
            DylinkError::DependencyNotFound { library, dependency } => {
                write!(f, "{library}: dependency {dependency} not found")
            }
            DylinkError::DependencyMissing { library, dependency } => {
                write!(f, "{library}: loaded dependency {dependency} is missing")
            }
            DylinkError::DependencyCycle { library } => {
                write!(f, "{library}: cyclic DT_NEEDED dependency graph")
            }
            DylinkError::UndefinedSymbol { library, symbol, kind } => {
                write!(f, "{library}: undefined symbol: {symbol} (GOT.{kind})")
            }
            DylinkError::SymbolKindMismatch { library, symbol, expected } => {
                write!(f, "{library}: symbol {symbol} is not a {expected}")
            }
            DylinkError::ConflictingSymbolKind { library, symbol } => {
                write!(f, "{library}: GOT symbol {symbol} is both mem and func")
            }
            DylinkError::AllocatorUnavailable { library } => {
                write!(f, "{library}: no side-module memory allocator configured")
            }
            DylinkError::AllocationEscapesMemory { library } => {
                write!(f, "{library}: allocation escapes linear memory")
            }
            DylinkError::ReplayTablePastBase { library, current, parent } => write!(
                f,
                "{library}: replay table already at {current}, past parent base {parent}"
            ),
            DylinkError::InvalidReplayTableBase { library } => {
                write!(f, "{library}: invalid replay table base")
            }
            DylinkError::ArchivedAllocationMismatch { library } => {
                write!(f, "{library}: archived allocation does not match its dylink memory region")
            }
            DylinkError::ArchivedMappingEscapesMemory { library } => {
                write!(f, "{library}: archived process mapping escapes copied linear memory")
            }
            DylinkError::MissingMappingOwnership { library } => {
                write!(f, "{library}: fork replay is missing process mapping ownership")
            }
            DylinkError::ZeroMemoryModuleOwnsMappings { library } => {
                write!(f, "{library}: zero-memory side module owns archived mappings")
            }
            DylinkError::MissingTlsExport { library, export } => {
                write!(f, "{library}: TLS-bearing side modules must export {export}")
            }
            DylinkError::InvalidTlsSize { library } => {
                write!(f, "{library}: invalid side-module TLS size")
            }
            DylinkError::InvalidTlsAlign { library } => {
                write!(f, "{library}: invalid side-module TLS alignment")
            }
            DylinkError::InvalidTlsBase { library } => {
                write!(f, "{library}: invalid side-module TLS base")
            }
            DylinkError::MisalignedTlsBase { library } => {
                write!(f, "{library}: side-module TLS base is misaligned")
            }
            DylinkError::TlsEscapesReservation { library } => {
                write!(f, "{library}: TLS range escapes the module reservation")
            }
            DylinkError::UnexpectedReplayTlsState { library } => {
                write!(f, "{library}: fork replay supplied TLS state for a module without TLS")
            }
            DylinkError::MissingReplayTlsBase { library } => {
                write!(f, "{library}: fork replay is missing a valid side-module TLS base")
            }
            DylinkError::ActiveDataSegmentInBorrowedReplay { index } => write!(
                f,
                "borrowed replay requires passive data segments; segment {index} is active"
            ),
            DylinkError::UnrecognizedStartFunction { index } => write!(
                f,
                "borrowed replay cannot suppress unrecognized start function {index}; \
                 expected exported __wasm_init_memory"
            ),
            DylinkError::BorrowedReplayRequiresSharedMemory { library } => {
                write!(f, "{library}: borrowed replay requires shared memory")
            }
            DylinkError::BorrowedReplayCannotResume { library } => {
                write!(f, "{library}: borrowed replay cannot resume an in-flight dlopen initializer")
            }
            DylinkError::InvalidHandle { handle } => write!(f, "invalid handle {handle}"),
            DylinkError::UnknownTransaction { token } => {
                write!(f, "unknown dlopen transaction {token}")
            }
            DylinkError::HandleOutOfRange { handle } => {
                write!(f, "replay handle {handle} is outside the allocator range")
            }
            DylinkError::DuplicateLibrary { library } => {
                write!(f, "{library}: already loaded; archive entries must be unique")
            }
            DylinkError::IncompleteForkInstrumentation { library } => write!(
                f,
                "{library}: incomplete wasm-fork-instrument exports; \
                 rebuild the side module"
            ),
            DylinkError::ForkActivationOwnerUnavailable { library, reason } => {
                write!(f, "{library}: fork activation cannot be coordinated: {reason}")
            }
            DylinkError::MissingReplayActivationId { library } => {
                write!(f, "{library}: fork replay is missing its archived activation id")
            }
            DylinkError::UnexpectedReplayActivationId { library } => write!(
                f,
                "{library}: fork replay supplied an activation id for an uninstrumented module"
            ),
            DylinkError::ActivationIdMismatch { library, prepared, expected } => write!(
                f,
                "{library}: activation owner returned {prepared}, but replay requires {expected}"
            ),
            DylinkError::MissingSavedGotValue { library, symbol } => {
                write!(f, "{library}: fork replay has no saved GOT.func.{symbol} value")
            }
            DylinkError::ConflictingSavedGotValue { library, symbol } => {
                write!(f, "{library}: GOT.func.{symbol} has a conflicting saved value")
            }
            DylinkError::ActResultMismatch { expected } => {
                write!(f, "link executor returned the wrong result kind; expected {expected}")
            }
            DylinkError::UnexpectedActSequence => {
                write!(f, "link plan was driven out of order")
            }
        }
    }
}

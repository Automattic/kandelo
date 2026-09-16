//! `LinkAct` — the eight JS-API acts, as data.
//!
//! ## Why this type exists
//!
//! `host/src/dylink.ts` interleaves deterministic linker computation with the
//! JS-API calls that realize it. That interleaving is what forces the whole
//! 4,188-line file to be TypeScript, and it is why `crates/host-native` has no
//! linker at all: there is no seam to implement.
//!
//! The K5 grounding enumerated every JS-API act in the file by walking all 16
//! call sites (`docs/plans/2026-09-09-k5-dynamic-linker-grounding.md` §2.1).
//! There are eight kinds, not the four the census asserted. Every one has a
//! `wasmtime` 48 equivalent, and all eight collapse into ONE typed executor:
//!
//! | act | browser / Node | wasmtime |
//! |---|---|---|
//! | [`LinkAct::Compile`] | `new WebAssembly.Module` | `Module::new` |
//! | [`LinkAct::NewGlobal`] | `new WebAssembly.Global` | `Global::new` |
//! | [`LinkAct::ReadGlobal`] | `Global.value` get | `Global::get` |
//! | [`LinkAct::WriteGlobal`] | `Global.value` set | `Global::set` |
//! | [`LinkAct::GrowTable`] / [`LinkAct::WriteTable`] | `Table.grow` / `.set` | `Table::grow` / `set` |
//! | [`LinkAct::GrowMemory`] | `Memory.grow` | `Memory::grow` |
//! | [`LinkAct::NewTag`] | `new WebAssembly.Tag` | `Tag::new` |
//! | [`LinkAct::Instantiate`] | import object + `new WebAssembly.Instance` | `Instance::new` |
//!
//! `WebAssembly.Module.customSections` — the ninth occurrence in the file — is
//! NOT an act here: [`crate::wasm::custom_section`] reads the same bytes
//! deterministically, so it never reaches the executor.
//!
//! ## The ordered-binding requirement, and how this type honours it
//!
//! `wasm-ld` can emit two import entries with the same `(module, name)`. The
//! JS API resolves imports in **declaration order**, calling `Get` once per
//! entry, so a stateful `Proxy` can hand back a different value on the second
//! read. `dylink.ts` depends on exactly this (`functionImportReads`,
//! `:1785-1789`; the reasoning is written at `:1877-1881`), and the fork seam
//! depends on it in turn: eager, name-keyed enumeration would collapse the
//! duplicates and capture the wrong provider.
//!
//! [`LinkAct::Instantiate`] therefore carries `bindings: Vec<ImportBinding>`
//! with **exactly one entry per import declaration, in declaration order**, and
//! [`ImportBinding::position`] restates that ordinal so a mis-ordered executor
//! is a detectable bug rather than a silent mis-binding. The invariant is
//! checked by construction in [`ImportPlan::finish`] and asserted again by
//! [`ImportPlan::validate_against`].
//!
//! That single shape serves all three executors:
//!
//! - **wasmtime**: `Instance::new(store, module, &[Extern])` takes an ordered
//!   positional slice. The `Vec` *is* the argument; duplicates need no special
//!   handling at all.
//! - **browser / Node**: a ~25-line counting `Proxy` whose `get` pops the next
//!   binding for that `(module, name)`. The ordering dependency becomes
//!   explicit data instead of an emergent property of proxy traps.
//!
//! This is strictly better than today's design, and it is the reason D3 chose a
//! pure planner over a co-resident wasm module: a wasm module cannot construct
//! a `WebAssembly.Global`, so it would have to import the ability to — new host
//! surface, a V4 regression.

use alloc::string::String;
use alloc::vec::Vec;

use crate::error::{DylinkError, DylinkResult};
use crate::wasm::{ExternKind, ImportDecl, ValType};

macro_rules! opaque_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(pub u32);

        impl $name {
            pub const fn index(self) -> u32 {
                self.0
            }
        }
    };
}

opaque_id! {
    /// A compiled module the executor is holding for the planner.
    ModuleId
}
opaque_id! {
    /// An instantiated module the executor is holding for the planner.
    InstanceId
}
opaque_id! {
    /// A `WebAssembly.Global` / `wasmtime::Global` the executor is holding.
    GlobalId
}
opaque_id! {
    /// A `WebAssembly.Tag` / `wasmtime::Tag` the executor is holding.
    TagId
}

/// A pointer-width scalar. The linker's arithmetic is done in `u64` and
/// narrowed at the boundary, so a wasm32 process cannot silently carry a value
/// that does not fit — the TypeScript relied on `Number.isSafeInteger` checks
/// scattered across 30 call sites to get the same guarantee.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum WasmValue {
    I32(u32),
    I64(u64),
}

impl WasmValue {
    pub fn address(width: PointerWidth, value: u64) -> DylinkResult<Self> {
        Ok(match width {
            PointerWidth::W32 => WasmValue::I32(
                u32::try_from(value)
                    .map_err(|_| DylinkError::MalformedModule("address exceeds 32 bits"))?,
            ),
            PointerWidth::W64 => WasmValue::I64(value),
        })
    }

    pub fn as_u64(self) -> u64 {
        match self {
            WasmValue::I32(value) => u64::from(value),
            WasmValue::I64(value) => value,
        }
    }

    pub fn val_type(self) -> ValType {
        match self {
            WasmValue::I32(_) => ValType::I32,
            WasmValue::I64(_) => ValType::I64,
        }
    }
}

/// Process pointer width. `wasm64posix` is a supported target, so this is not
/// a constant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub enum PointerWidth {
    #[default]
    W32,
    W64,
}

impl PointerWidth {
    pub const fn bytes(self) -> u32 {
        match self {
            PointerWidth::W32 => 4,
            PointerWidth::W64 => 8,
        }
    }

    pub const fn val_type(self) -> ValType {
        match self {
            PointerWidth::W32 => ValType::I32,
            PointerWidth::W64 => ValType::I64,
        }
    }

    pub fn from_bytes(bytes: u32) -> DylinkResult<Self> {
        match bytes {
            4 => Ok(PointerWidth::W32),
            8 => Ok(PointerWidth::W64),
            _ => Err(DylinkError::MalformedModule("invalid process pointer width")),
        }
    }
}

/// Where a bound import's value comes from.
///
/// Every variant names a value the EXECUTOR already holds or can reach. The
/// planner never holds an engine object, which is what keeps it pure and makes
/// it testable with no wasm host at all.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BindingValue {
    /// The process's shared linear memory (`env.memory`).
    ProcessMemory,
    /// The process's indirect function table (`env.__indirect_function_table`).
    ProcessTable,
    /// The process's `__stack_pointer` global.
    ProcessStackPointer,
    /// A global the planner asked the executor to create.
    Global(GlobalId),
    /// A tag the planner asked the executor to create, or the process-owned one.
    Tag(TagId),
    /// A named export of an already-instantiated module (a side module, or the
    /// main image at [`InstanceId`] zero).
    Export { instance: InstanceId, name: String },
    /// A trampoline back into this module's own like-named export.
    ///
    /// `wasm-ld` can make an interposable C++ definition both an `env` import
    /// and a module export. The main image still wins when it supplies the
    /// symbol; otherwise this routes the genuine self-definition back to the
    /// module. Trampolines are NOT manufactured for arbitrary unresolved
    /// imports — those stay instantiation errors rather than becoming a delayed
    /// failure on a possibly-unexecuted path (`dylink.ts:1243-1247`).
    SelfImport { name: String },
    /// A value owned by the process fork-activation coordinator (`fork`,
    /// `__wpk_fork_*`, the private unwind tag, frame/reference/exception/GC
    /// imports). The planner binds it by name and never inspects it; the fork
    /// side keeps ownership of activations, frame flips and reference flips.
    ActivationEnv { name: String },
    /// A weak undefined symbol. ELF gives it the value zero and no error.
    ///
    /// This is the ONLY variant that stands for "nothing resolved it", and it
    /// is reachable only when `dylink.0` declared the import weak. A strong
    /// undefined symbol is [`DylinkError::UndefinedSymbol`], not a binding.
    WeakUndefined,
}

/// One bound import declaration, at its exact position in the import section.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportBinding {
    /// Ordinal in the import section. Equals this entry's index in the
    /// `Vec<ImportBinding>`; restated so an executor that reorders is caught.
    pub position: u32,
    pub module: String,
    pub name: String,
    pub kind: ExternKind,
    pub value: BindingValue,
    /// True when this declaration is the second-or-later occurrence of its
    /// `(module, name)` pair. A JS executor's counting `Proxy` must return this
    /// entry on the matching read; a positional executor can ignore the flag.
    pub duplicate_occurrence: bool,
}

/// Builder that enforces the one-entry-per-declaration invariant.
pub struct ImportPlan {
    bindings: Vec<ImportBinding>,
}

impl ImportPlan {
    pub fn with_capacity(capacity: usize) -> Self {
        ImportPlan { bindings: Vec::with_capacity(capacity) }
    }

    /// Bind the next import declaration. Declarations MUST be pushed in
    /// section order; the position check makes any other order an error.
    pub fn bind(&mut self, decl: &ImportDecl, value: BindingValue) -> DylinkResult<()> {
        let position = u32::try_from(self.bindings.len())
            .map_err(|_| DylinkError::MalformedModule("too many imports"))?;
        if decl.position != position {
            return Err(DylinkError::UnexpectedActSequence);
        }
        let duplicate_occurrence = self
            .bindings
            .iter()
            .any(|bound| bound.module == decl.module && bound.name == decl.name);
        self.bindings.push(ImportBinding {
            position,
            module: decl.module.clone(),
            name: decl.name.clone(),
            kind: decl.ty.kind(),
            value,
            duplicate_occurrence,
        });
        Ok(())
    }

    /// Finish the plan, proving it covers exactly the module's declarations.
    pub fn finish(self, declarations: &[ImportDecl]) -> DylinkResult<Vec<ImportBinding>> {
        if self.bindings.len() != declarations.len() {
            return Err(DylinkError::UnexpectedActSequence);
        }
        Ok(self.bindings)
    }

    pub fn len(&self) -> usize {
        self.bindings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bindings.is_empty()
    }

    /// Assert that a finished binding list matches a module's import section
    /// one-for-one, in order. Executors call this as a cheap self-check; the
    /// planner's own tests call it as the ordering gate.
    pub fn validate_against(
        bindings: &[ImportBinding],
        declarations: &[ImportDecl],
    ) -> DylinkResult<()> {
        if bindings.len() != declarations.len() {
            return Err(DylinkError::UnexpectedActSequence);
        }
        for (index, (binding, decl)) in bindings.iter().zip(declarations).enumerate() {
            let index = u32::try_from(index)
                .map_err(|_| DylinkError::MalformedModule("too many imports"))?;
            if binding.position != index
                || decl.position != index
                || binding.module != decl.module
                || binding.name != decl.name
                || binding.kind != decl.ty.kind()
            {
                return Err(DylinkError::UnexpectedActSequence);
            }
        }
        Ok(())
    }
}

/// One JS-API act, as data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkAct {
    /// `new WebAssembly.Module(bytes)` / `Module::new`.
    ///
    /// `source` is either the caller-owned image named by `library`, or an
    /// owned rewrite when a borrowed replay had to strip the start section.
    ///
    /// `library` is carried because a load resolves its `DT_NEEDED` closure,
    /// so the image being compiled is often NOT the one the `dlopen` named. The
    /// driver already holds every image it was given or fetched; naming the one
    /// this act means is what stops it from guessing.
    Compile { module: ModuleId, library: String, source: ModuleSource },
    /// `new WebAssembly.Global({ value, mutable }, init)` / `Global::new`.
    NewGlobal { global: GlobalId, ty: ValType, mutable: bool, init: WasmValue },
    /// `Global.value` get / `Global::get`. Answered with [`ActResult::Value`].
    ReadGlobal { global: GlobalId },
    /// `Global.value` set / `Global::set`.
    WriteGlobal { global: GlobalId, value: WasmValue },
    /// `Table.grow(delta)` / `Table::grow`. Answered with [`ActResult::Index`],
    /// the table length BEFORE the growth.
    GrowTable { delta: u64 },
    /// `Table.set(index, funcref)` / `Table::set`.
    WriteTable { index: u64, value: TableValue },
    /// `Memory.grow(delta_pages)` / `Memory::grow`.
    ///
    /// Reachable only for embedders that supply no memory allocator — the
    /// standalone-linker path. Every SDK-built guest that can call `dlopen`
    /// routes address-space growth through the kernel's `SYS_MMAP`, so this act
    /// does not occur in a process worker.
    GrowMemory { delta_pages: u64 },
    /// `new WebAssembly.Tag({ parameters })` / `Tag::new`.
    NewTag { tag: TagId, parameters: Vec<ValType> },
    /// Build the import object and instantiate.
    ///
    /// `bindings` is ordered one-per-declaration; see the module docs.
    Instantiate { module: ModuleId, instance: InstanceId, bindings: Vec<ImportBinding> },
    /// Ask the executor for a module's exports after instantiation.
    /// Answered with [`ActResult::Exports`].
    ReadExports { instance: InstanceId },
    /// Zero a byte range of linear memory (a fresh side module's data region).
    /// Not a JS-API *object* act, but it is executor work and it is ordered
    /// against the acts around it, so it belongs in the same queue.
    ZeroMemory { address: u64, length: u64 },
}

/// Where an act's module bytes come from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModuleSource {
    /// The caller-supplied image, unmodified.
    Original,
    /// A loader rewrite (borrowed replay with the `__wasm_init_memory` start
    /// section removed).
    Rewritten(Vec<u8>),
}

/// What goes into a table slot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TableValue {
    /// Clear the slot. Table length cannot shrink, so unload nulls its slots.
    Null,
    /// A named function export of an instantiated module.
    Export { instance: InstanceId, name: String },
}

/// The executor's answer to an act.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActResult {
    /// Acknowledged; nothing to report.
    Done,
    /// A scalar, for [`LinkAct::ReadGlobal`].
    Value(WasmValue),
    /// A table index, for [`LinkAct::GrowTable`] (the pre-growth length).
    Index(u64),
    /// A module's exports, for [`LinkAct::ReadExports`].
    Exports(Vec<InstanceExport>),
    /// File bytes, for [`crate::plan::HostRequest::ReadDependency`].
    ///
    /// `None` means "no such file", which is an ordinary miss the planner
    /// answers by trying the next search-path candidate. A real I/O failure is
    /// the driver's to raise: encoding it as an empty file would turn an
    /// unreadable `libfoo.so` into a malformed-module diagnostic naming the
    /// wrong layer.
    Bytes(Option<Vec<u8>>),
}

impl ActResult {
    pub fn expect_done(self) -> DylinkResult<()> {
        match self {
            ActResult::Done => Ok(()),
            _ => Err(DylinkError::ActResultMismatch { expected: "Done" }),
        }
    }

    pub fn expect_value(self) -> DylinkResult<WasmValue> {
        match self {
            ActResult::Value(value) => Ok(value),
            _ => Err(DylinkError::ActResultMismatch { expected: "Value" }),
        }
    }

    pub fn expect_index(self) -> DylinkResult<u64> {
        match self {
            ActResult::Index(index) => Ok(index),
            _ => Err(DylinkError::ActResultMismatch { expected: "Index" }),
        }
    }

    pub fn expect_exports(self) -> DylinkResult<Vec<InstanceExport>> {
        match self {
            ActResult::Exports(exports) => Ok(exports),
            _ => Err(DylinkError::ActResultMismatch { expected: "Exports" }),
        }
    }

    pub fn expect_bytes(self) -> DylinkResult<Option<Vec<u8>>> {
        match self {
            ActResult::Bytes(bytes) => Ok(bytes),
            _ => Err(DylinkError::ActResultMismatch { expected: "Bytes" }),
        }
    }
}

/// One export the executor observed on an instantiated module.
///
/// A global's `value` is read eagerly by the executor because the planner needs
/// it to relocate data addresses; `mutable` is reported because relocation
/// applies only to immutable address globals (`dylink.ts:2071-2098` distinguishes
/// them by attempting a self-assignment, which is the only reflection the JS API
/// offers — wasmtime reports mutability directly, so the planner asks for it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstanceExport {
    pub name: String,
    pub kind: ExternKind,
    /// Present for globals.
    pub value: Option<WasmValue>,
    /// Present for globals.
    pub mutable: Option<bool>,
}

impl InstanceExport {
    pub fn func(name: impl Into<String>) -> Self {
        InstanceExport { name: name.into(), kind: ExternKind::Func, value: None, mutable: None }
    }

    pub fn global(name: impl Into<String>, value: WasmValue, mutable: bool) -> Self {
        InstanceExport {
            name: name.into(),
            kind: ExternKind::Global,
            value: Some(value),
            mutable: Some(mutable),
        }
    }
}

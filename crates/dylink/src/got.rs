//! The global offset table: placement, kind agreement, and the D4 adjudication.
//!
//! Ports `getOrCreateGOTEntry` (`host/src/dylink.ts:1632-1766`) and
//! `refreshGlobalGotEntries` (`:997-1023`).
//!
//! A GOT cell is a mutable pointer-width global the side module IMPORTS:
//! `GOT.mem.<sym>` holds the linear-memory address of a data symbol,
//! `GOT.func.<sym>` holds the indirect-function-table index that a C function
//! pointer stores. Every one is a `new WebAssembly.Global`; `intl.so` alone
//! imports 2,469 of them.
//!
//! # D4 — what an UNRESOLVED GOT symbol resolves to
//!
//! `dylink.ts:1022` ends `refreshGlobalGotEntries` with an unconditional
//!
//! ```text
//! entry.value = wasmAddress(0, ptrWidth, `unresolved GOT.${kind}.${name}`);
//! ```
//!
//! and `:1667`'s `tableIndexFor` path falls back the same way (`index ?? 0`).
//! Every unresolved symbol — weak or strong, data or function — silently
//! becomes a NULL that the guest dereferences later. The value plan (§2j D4)
//! required this be decided on ELF semantics, not on which symbols PHP happens
//! to leave unresolved.
//!
//! ## The ELF rules, and why lazy binding does not license the zero
//!
//! 1. **`RTLD_LAZY` defers only PLT relocations** — `R_*_JUMP_SLOT` entries for
//!    *calls* routed through the procedure linkage table. Data relocations
//!    (`R_*_GLOB_DAT`, `R_*_RELATIVE`, copy relocations) are processed at load
//!    time under every mode. There is no lazy mode in which an undefined data
//!    symbol becomes NULL: `dlopen` fails and `dlerror()` reports
//!    `undefined symbol: <name>`.
//!
//! 2. **Lazy binding never produces NULL even for functions.** The PLT slot
//!    initially points at the runtime resolver, not at zero. If the symbol is
//!    genuinely undefined, the resolver raises `symbol lookup error: undefined
//!    symbol: <name>` at first call. Deferral changes *when* the failure is
//!    reported, never *whether* it is reported, and never converts it into a
//!    NULL dereference.
//!
//! 3. **A wasm `GOT.func` cell is not a PLT slot.** It holds the value of
//!    `&func` as stored in data — in ELF terms an address-take, which is a
//!    `GLOB_DAT` data relocation and is therefore resolved eagerly even under
//!    `RTLD_LAZY`. The wasm dynamic-linking ABI has no PLT and no resolver
//!    stub, so there is no mechanism by which a GOT cell could be lazily bound.
//!    Wasm dynamic linking is `RTLD_NOW` by construction.
//!
//! 4. **Exactly one ELF case makes zero correct: an undefined WEAK symbol.**
//!    `STB_WEAK` + `SHN_UNDEF` has value 0 by specification, raises no error,
//!    and C code is expected to test `if (&sym)`. `dylink.0` records precisely
//!    this, per import, as `WASM_DYLINK_FLAG_WEAK`.
//!
//! ## The adjudication
//!
//! - **Weak + unresolved → zero.** Correct, and it is the behaviour the
//!   existing code accidentally implements for every symbol.
//! - **Strong + unresolved → the load fails** with
//!   [`DylinkError::UndefinedSymbol`], which `dlerror()` renders as
//!   `undefined symbol: <name>`. This is the truthful failure the
//!   platform-values contract requires, and it is what every other ELF loader
//!   does.
//!
//! The evidence that the zero path has already bitten is in the source: the
//! comment at `dylink.ts:1605-1614` records `opcache.so` reading
//! `sapi_module.name` as NULL and `accel_find_sapi` failing at startup. That
//! bug was fixed by adding GOT.mem *seeding*; the fallback that produced the
//! NULL in the first place was left in place. Under the rule above, that class
//! of failure surfaces at `dlopen` with the symbol's name instead of as a
//! crash in unrelated guest code an unbounded time later.
//!
//! **The reason the current code cannot make this distinction** is that
//! `dylink.ts` parses `WASM_DYLINK_FLAG_WEAK` into `metadata.weakImports` and
//! then never reads it — verified across the whole repository, where the only
//! three occurrences are the field declaration, its initialization, and its one
//! `add`. Having discarded strong-vs-weak, the loader had no choice but to
//! apply weak semantics to everything. Recovering the flag (see
//! [`crate::metadata`]) is what makes the correct answer available.
//!
//! ## Pinning the old behaviour, per the K10 defect shape
//!
//! [`UnresolvedPolicy::LegacyZero`] reproduces the TypeScript exactly. The
//! differential harness runs both policies so the divergence is recorded per
//! symbol rather than asserted: the strict policy is the product behaviour and
//! the legacy policy exists to name, in the harness output, every symbol whose
//! treatment changed. It is not a fallback and no product path selects it.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

use crate::act::{GlobalId, PointerWidth, WasmValue};
use crate::error::{DylinkError, DylinkResult};
use crate::metadata::{DylinkMetadata, GotKind};
use crate::scope::{ResolvedSymbol, SymbolValue};

/// How to treat an unresolved GOT symbol. See the D4 adjudication above.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UnresolvedPolicy {
    /// ELF: a weak undefined symbol is zero; a strong one fails the load.
    #[default]
    ElfStrict,
    /// `host/src/dylink.ts`'s behaviour: every unresolved symbol is zero.
    /// Retained ONLY so the differential harness can name what changed.
    LegacyZero,
}

/// Where a GOT cell lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GotPlacement {
    /// The process-shared cell, visible to every object.
    ///
    /// Reachable only when the symbol resolved from the process-global scope,
    /// or when nothing has claimed the name yet.
    Shared,
    /// A cell owned by the importing instance.
    ///
    /// An `RTLD_LOCAL` dependency's symbol and a module's own interposable
    /// export must NOT acquire a process-global cell: the global table is
    /// first-definition-wins, so publishing a local provider there would let it
    /// interpose for objects that cannot see it.
    Local,
}

/// One planned GOT cell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GotCell {
    pub global: GlobalId,
    pub kind: GotKind,
    pub placement: GotPlacement,
    pub value: WasmValue,
}

/// What a GOT cell should initially hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GotInit {
    /// A resolved data address or table index.
    Resolved(WasmValue),
    /// ELF's undefined-weak value.
    WeakZero,
    /// The symbol is defined by the module currently being instantiated. Its
    /// address is unknown until its exports are read, so the cell starts at
    /// zero and is republished during export processing. This is NOT the
    /// unresolved case: the definition exists, it is just not observable yet.
    PendingSelfDefinition,
}

impl GotInit {
    pub fn value(self, width: PointerWidth) -> DylinkResult<WasmValue> {
        match self {
            GotInit::Resolved(value) => Ok(value),
            GotInit::WeakZero | GotInit::PendingSelfDefinition => {
                WasmValue::address(width, 0)
            }
        }
    }
}

/// The process-shared GOT plus this load's instance-local cells.
#[derive(Clone, Debug, Default)]
pub struct GotTable {
    shared: BTreeMap<String, GotCell>,
    /// Instance-local cells, keyed by `(kind, symbol)` because the same name
    /// can legitimately appear in both namespaces for different objects.
    local: BTreeMap<(GotKind, String), GotCell>,
    next_global: u32,
}

impl GotTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Allocate an executor-side global id. The planner never holds the object.
    pub fn allocate_global(&mut self) -> GlobalId {
        let id = GlobalId(self.next_global);
        self.next_global += 1;
        id
    }

    /// Reserve ids the executor already owns (the main image's, on adoption).
    pub fn reserve_globals(&mut self, count: u32) {
        self.next_global = self.next_global.max(count);
    }

    pub fn shared_cell(&self, symbol: &str) -> Option<&GotCell> {
        self.shared.get(symbol)
    }

    pub fn local_cell(&self, kind: GotKind, symbol: &str) -> Option<&GotCell> {
        self.local.get(&(kind, String::from(symbol)))
    }

    pub fn shared_cells(&self) -> impl Iterator<Item = (&str, &GotCell)> {
        self.shared.iter().map(|(name, cell)| (name.as_str(), cell))
    }

    pub fn shared_kind(&self, symbol: &str) -> Option<GotKind> {
        self.shared.get(symbol).map(|cell| cell.kind)
    }

    pub fn set_shared_value(&mut self, symbol: &str, value: WasmValue) {
        if let Some(cell) = self.shared.get_mut(symbol) {
            cell.value = value;
        }
    }

    pub fn set_local_value(&mut self, kind: GotKind, symbol: &str, value: WasmValue) {
        if let Some(cell) = self.local.get_mut(&(kind, String::from(symbol))) {
            cell.value = value;
        }
    }

    pub fn insert_shared(&mut self, symbol: &str, cell: GotCell) {
        self.shared.insert(String::from(symbol), cell);
    }

    pub fn insert_local(&mut self, kind: GotKind, symbol: &str, cell: GotCell) {
        self.local.insert((kind, String::from(symbol)), cell);
    }

    pub fn snapshot(&self) -> GotSnapshot {
        GotSnapshot {
            shared: self.shared.clone(),
            local: self.local.clone(),
            next_global: self.next_global,
        }
    }

    pub fn restore(&mut self, snapshot: GotSnapshot) {
        self.shared = snapshot.shared;
        self.local = snapshot.local;
        // Global ids are never reused: the executor may still hold a rolled-back
        // object, and reusing an id would alias two distinct engine globals.
        self.next_global = self.next_global.max(snapshot.next_global);
    }
}

#[derive(Clone, Debug)]
pub struct GotSnapshot {
    shared: BTreeMap<String, GotCell>,
    local: BTreeMap<(GotKind, String), GotCell>,
    next_global: u32,
}

/// The decision for one GOT import, before any act is emitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GotDecision {
    pub kind: GotKind,
    pub symbol: String,
    pub placement: GotPlacement,
    pub init: GotInit,
    /// The object that provided the symbol, if any. Recorded as a runtime
    /// provider edge so a fork child can reconstruct the lifetime dependency.
    pub provider: Option<String>,
    /// True when the symbol is defined by the module being loaded right now.
    pub self_definition: bool,
}

/// Inputs to one GOT decision that the planner already knows.
pub struct GotRequest<'a> {
    pub library: &'a str,
    pub metadata: &'a DylinkMetadata,
    pub kind: GotKind,
    pub symbol: &'a str,
    /// What the requester's scope resolved the symbol to, if anything.
    pub resolved: Option<&'a ResolvedSymbol>,
    /// The table index of `resolved`, when it is a function already installed.
    pub resolved_table_index: Option<u64>,
    /// True when the module being loaded exports this symbol with the right
    /// kind, so it defines it itself.
    pub self_export: bool,
    /// A replayed value recovered from the fork archive, which is authoritative
    /// when present: funcref identity in a child must match the parent exactly.
    pub replay_value: Option<WasmValue>,
    pub width: PointerWidth,
    pub policy: UnresolvedPolicy,
}

/// Decide one GOT cell's placement and initial value.
///
/// This function is the whole of D4 and of the local-vs-shared rule, and it is
/// pure: no engine object, no allocation of ids, no mutation. The planner calls
/// it, then emits the acts the decision implies.
pub fn decide_got_cell(request: GotRequest<'_>) -> DylinkResult<GotDecision> {
    let GotRequest {
        library,
        metadata,
        kind,
        symbol,
        resolved,
        resolved_table_index,
        self_export,
        replay_value,
        width,
        policy,
    } = request;

    // Kind agreement: a data symbol cannot satisfy a GOT.func import and vice
    // versa. This is a hard error in ELF too (`R_*_GLOB_DAT` against a symbol
    // of the wrong type is a link error), so it is not affected by D4.
    if let Some(resolved) = resolved {
        let matches = match (kind, &resolved.value) {
            (GotKind::Mem, SymbolValue::Data { .. }) => true,
            (GotKind::Func, SymbolValue::Func { .. }) => true,
            _ => false,
        };
        if !matches {
            return Err(DylinkError::SymbolKindMismatch {
                library: String::from(library),
                symbol: String::from(symbol),
                expected: match kind {
                    GotKind::Mem => "data object",
                    GotKind::Func => "function",
                },
            });
        }
    }

    let self_definition = resolved.is_none() && self_export;

    // Placement. A locally-resolved provider or the module's own interposable
    // export owns its cell; anything visible process-wide shares one.
    let placement = match resolved {
        Some(resolved) if !resolved.globally_visible => GotPlacement::Local,
        Some(_) => GotPlacement::Shared,
        None if self_definition => GotPlacement::Local,
        None => GotPlacement::Shared,
    };

    // A fork child must reproduce the parent's exact value; the archive wins
    // over anything re-derived here.
    if let Some(value) = replay_value {
        return Ok(GotDecision {
            kind,
            symbol: String::from(symbol),
            placement,
            init: GotInit::Resolved(value),
            provider: resolved.and_then(|resolved| resolved.owner.clone()),
            self_definition,
        });
    }

    let init = match (resolved, kind) {
        (Some(resolved), GotKind::Mem) => {
            let SymbolValue::Data { address, .. } = resolved.value else {
                unreachable!("kind agreement was checked above");
            };
            GotInit::Resolved(WasmValue::address(width, address)?)
        }
        (Some(_), GotKind::Func) => match resolved_table_index {
            Some(index) => GotInit::Resolved(WasmValue::address(width, index)?),
            // The provider is a real function that simply has no table slot
            // yet. The planner appends one; it never resolves to zero.
            None => GotInit::PendingSelfDefinition,
        },
        (None, _) if self_definition => GotInit::PendingSelfDefinition,
        (None, _) => match policy {
            UnresolvedPolicy::LegacyZero => GotInit::WeakZero,
            UnresolvedPolicy::ElfStrict => {
                if metadata.is_weak_symbol(kind, symbol) {
                    GotInit::WeakZero
                } else {
                    return Err(DylinkError::UndefinedSymbol {
                        library: String::from(library),
                        symbol: String::from(symbol),
                        kind: kind.as_str(),
                    });
                }
            }
        },
    };

    Ok(GotDecision {
        kind,
        symbol: String::from(symbol),
        placement,
        init,
        provider: resolved.and_then(|resolved| resolved.owner.clone()),
        self_definition,
    })
}

/// Reject a symbol that would change GOT namespace.
///
/// A name is either a data object or a function for the whole process; a module
/// that imports `GOT.mem.x` after another imported `GOT.func.x` is describing
/// two different symbols under one name, which no loader can satisfy.
pub fn require_stable_kind(
    table: &GotTable,
    library: &str,
    symbol: &str,
    kind: GotKind,
) -> DylinkResult<()> {
    if let Some(known) = table.shared_kind(symbol) {
        if known != kind {
            return Err(DylinkError::ConflictingSymbolKind {
                library: String::from(library),
                symbol: String::from(symbol),
            });
        }
    }
    Ok(())
}

/// Recompute every shared GOT cell against the current global scope.
///
/// Ports `refreshGlobalGotEntries` (`dylink.ts:997-1023`), which runs after an
/// `RTLD_LOCAL` → `RTLD_GLOBAL` promotion makes new definitions visible.
/// Returns the cells whose value changed, so the caller emits one
/// [`crate::act::LinkAct::WriteGlobal`] per actual change rather than 2,469
/// unconditional writes.
pub fn refresh_shared_cells(
    table: &GotTable,
    width: PointerWidth,
    policy: UnresolvedPolicy,
    lookup: impl Fn(&str) -> Option<ResolvedSymbol>,
    table_index: impl Fn(&SymbolValue) -> Option<u64>,
    is_weak: impl Fn(GotKind, &str) -> bool,
) -> DylinkResult<Vec<(String, WasmValue)>> {
    let mut updates = Vec::new();
    for (symbol, cell) in table.shared_cells() {
        let resolved = lookup(symbol);
        let next = match (&resolved, cell.kind) {
            (Some(ResolvedSymbol { value: SymbolValue::Data { address, .. }, .. }), GotKind::Mem) => {
                WasmValue::address(width, *address)?
            }
            (Some(ResolvedSymbol { value: value @ SymbolValue::Func { .. }, .. }), GotKind::Func) => {
                match table_index(value) {
                    Some(index) => WasmValue::address(width, index)?,
                    None => continue,
                }
            }
            _ => match policy {
                UnresolvedPolicy::LegacyZero => WasmValue::address(width, 0)?,
                UnresolvedPolicy::ElfStrict => {
                    if is_weak(cell.kind, symbol) {
                        WasmValue::address(width, 0)?
                    } else {
                        // A cell that was resolvable when it was created and is
                        // not now means the scope shrank under a live object.
                        // Leave the last good value rather than zeroing it: the
                        // guest holds pointers derived from it.
                        continue;
                    }
                }
            },
        };
        if next != cell.value {
            updates.push((String::from(symbol), next));
        }
    }
    Ok(updates)
}

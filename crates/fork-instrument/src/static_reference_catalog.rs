//! Fresh-instance identities for statically initialized GC references.
//!
//! A continuation recipe must not structurally clone a reference that is also
//! recreated by module instantiation. Doing so would produce two objects in
//! the child and make `ref.eq` observe a fork-only identity split.
//!
//! The exported catalog is deliberately a *harvest buffer*, not permanent
//! module-instance storage. Immediately after instantiation the host calls the
//! generated harvest function, records weak object-to-ordinal mappings, and
//! clears every table entry. Immutable globals are read directly. Allocating
//! element expressions are copied one at a time from their still-live segment,
//! and a table initializer is read from its first initialized slot. Therefore
//! the pass neither evaluates an allocating expression twice nor hoists it into
//! a new immutable global that would retain a stale GC root forever.

use std::collections::HashMap;

use walrus::{
    AbstractHeapType, ConstExpr, ConstOp, ElementId, ElementItems, FunctionBuilder, GlobalId, GlobalKind,
    HeapType, Module, RawCustomSection, RefType, TableId, ValType,
    ir::{BinaryOp, RefNull, TableCopy, TableFill, TableGet, TableInit, TableSet, TableSize},
};

pub const EXPORT: &str = "__wpk_fork_static_root_catalog";
pub const HARVEST_EXPORT: &str = "__wpk_fork_static_root_harvest";
pub const FILL_EXPORT: &str = wasm_posix_shared::abi::WPK_FORK_STATIC_ROOT_FILL_EXPORT;
/// The fork module's merged catalog, which the fill shim copies into. The
/// module exports it under the same name the guest exports its own catalog
/// by; imports and exports are separate namespaces, so the guest imports the
/// module's `env.__wpk_fork_static_root_catalog` and still exports its own.
pub const MERGED_IMPORT: &str = wasm_posix_shared::abi::WPK_FORK_STATIC_ROOT_CATALOG_EXPORT;
pub const FORMAT_SECTION: &str = "kandelo.wpk_fork.static_root_catalog";
pub const FORMAT_MAGIC: [u8; 4] = *b"KFSR";
pub const FORMAT_VERSION: u16 = 1;
pub const FORMAT_HEADER_SIZE: u16 = 12;

#[derive(Debug, Clone, Copy)]
enum RootSource {
    Global(GlobalId),
    TableFirst { table: TableId, table64: bool },
    ElementItem { element: ElementId, index: u32 },
}

/// What one item of an element segment is, in the coordinates a fork capture
/// records it by.
///
/// An `array.new_elem` array's elements ARE its segment's items, so a capture
/// can tell which run of the instruction made an array by comparing the
/// array's captured elements with each segment's items
/// (`fork_codec::gc_constructor`). That needs every item's capture-time
/// coordinate, which is static: an allocating item is a static root harvested
/// at instantiation, a `global.get` item is that global's root, and a null or
/// `ref.i31` constant is itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElementItemCoordinate {
    /// An item no capture coordinate describes (a function reference, or an
    /// item of a segment whose element type cannot take part in `ref.eq`).
    Unmapped,
    Null,
    /// The item is the static root with this activation-local ordinal.
    Root(u32),
    /// A constant `ref.i31` item, as a capture reads it back (`i31.get_s`).
    I31(i32),
}

#[derive(Debug, Default)]
pub struct StaticReferenceCatalogPlan {
    roots: Vec<RootSource>,
    element_items: HashMap<ElementId, Vec<ElementItemCoordinate>>,
}

impl StaticReferenceCatalogPlan {
    pub fn root_count(&self) -> usize {
        self.roots.len()
    }

    /// Every element segment's items as capture coordinates, for the segments
    /// whose element type can take part in `ref.eq`. A segment absent here has
    /// only `Unmapped` items.
    pub fn element_items(&self) -> &HashMap<ElementId, Vec<ElementItemCoordinate>> {
        &self.element_items
    }
}

#[derive(Default)]
struct RootOrdinals {
    roots: Vec<RootSource>,
    by_global: HashMap<GlobalId, u32>,
}

impl RootOrdinals {
    fn intern_source(&mut self, source: RootSource) -> u32 {
        let ordinal = u32::try_from(self.roots.len())
            .expect("static reference catalog exceeds the Wasm u32 index space");
        self.roots.push(source);
        ordinal
    }

    fn intern_global(&mut self, global: GlobalId) -> u32 {
        if let Some(ordinal) = self.by_global.get(&global) {
            return *ordinal;
        }
        let ordinal = self.intern_source(RootSource::Global(global));
        self.by_global.insert(global, ordinal);
        ordinal
    }

    fn alias(&mut self, alias: GlobalId, target: GlobalId) {
        let ordinal = self.intern_global(target);
        self.by_global.insert(alias, ordinal);
    }
}

/// Identify the template roots present in the source artifact.
///
/// This must run before module-state planning. That pass converts active
/// element segments to passive segments, but preserves their IDs and
/// expressions; the harvest helper injected afterward can therefore copy the
/// exact already-instantiated object from each segment before bootstrap drops
/// it.
pub fn plan(module: &mut Module) -> StaticReferenceCatalogPlan {
    let mut ordinals = RootOrdinals::default();

    // Include immutable imports as well as locals. A local global.get alias
    // folds onto its source coordinate, including a root supplied by another
    // activation.
    let globals: Vec<_> = module
        .globals
        .iter()
        .filter_map(|global| {
            let ValType::Ref(reference) = global.ty else {
                return None;
            };
            if global.mutable || !can_participate_in_ref_eq(module, reference) {
                return None;
            }
            let source = match &global.kind {
                GlobalKind::Local(ConstExpr::Global(target)) => Some(*target),
                GlobalKind::Local(ConstExpr::RefNull(_) | ConstExpr::RefFunc(_)) => return None,
                GlobalKind::Local(_) | GlobalKind::Import(_) => None,
            };
            Some((global.id(), source))
        })
        .collect();
    for (global, source) in globals {
        if let Some(target) = source {
            ordinals.alias(global, target);
        } else {
            ordinals.intern_global(global);
        }
    }

    // A table declaration evaluates its initializer once and fills every
    // initial slot with that one value. Reading slot zero after instantiation
    // obtains the exact root without reevaluating the expression. A zero-sized
    // table exposes no root and needs no identity coordinate.
    let tables: Vec<_> = module
        .tables
        .iter()
        .filter_map(|table| {
            if table.import.is_some()
                || table.initial == 0
                || !can_participate_in_ref_eq(module, table.element_ty)
            {
                return None;
            }
            table
                .init
                .as_ref()
                .cloned()
                .map(|initializer| (table.id(), table.table64, initializer))
        })
        .collect();
    for (table, table64, initializer) in tables {
        match initializer {
            ConstExpr::RefNull(_) | ConstExpr::RefFunc(_) => {}
            ConstExpr::Global(global) => {
                ordinals.intern_global(global);
            }
            _ => {
                ordinals.intern_source(RootSource::TableFirst { table, table64 });
            }
        }
    }

    // Element expressions are instantiated once into their segment. Copy only
    // allocating entries into the harvest table; global.get aliases reuse the
    // global coordinate and null/function entries have other owners.
    let elements: Vec<_> = module
        .elements
        .iter()
        .filter_map(|element| {
            let ElementItems::Expressions(reference, expressions) = &element.items else {
                return None;
            };
            if !can_participate_in_ref_eq(module, *reference) {
                return None;
            }
            Some((element.id(), expressions.clone()))
        })
        .collect();
    let mut element_items = HashMap::new();
    for (element, expressions) in elements {
        let mut items = Vec::with_capacity(expressions.len());
        for (index, initializer) in expressions.into_iter().enumerate() {
            let item = match initializer {
                ConstExpr::RefNull(_) => ElementItemCoordinate::Null,
                ConstExpr::RefFunc(_) => ElementItemCoordinate::Unmapped,
                ConstExpr::Global(global) => {
                    ElementItemCoordinate::Root(ordinals.intern_global(global))
                }
                other => {
                    let ordinal = ordinals.intern_source(RootSource::ElementItem {
                        element,
                        index: u32::try_from(index)
                            .expect("element segment exceeds the Wasm u32 index space"),
                    });
                    // An i31 is captured as its value, never as a root: the
                    // codec tests for i31 before it looks a value up.
                    match other {
                        ConstExpr::Extended(ops) => match ops.as_slice() {
                            [ConstOp::I32Const(value), ConstOp::RefI31] => {
                                ElementItemCoordinate::I31((value << 1) >> 1)
                            }
                            _ => ElementItemCoordinate::Root(ordinal),
                        },
                        _ => ElementItemCoordinate::Root(ordinal),
                    }
                }
            };
            items.push(item);
        }
        element_items.insert(element, items);
    }

    StaticReferenceCatalogPlan {
        roots: ordinals.roots,
        element_items,
    }
}

/// Inject an initially-null fixed harvest table and its one-shot population
/// helper after guest module-state planning has completed.
pub fn inject(module: &mut Module, plan: StaticReferenceCatalogPlan) {
    let count = u64::try_from(plan.roots.len())
        .expect("static reference catalog length exceeds the Wasm table index space");
    let table = module
        .tables
        .add_local(false, count, Some(count), RefType::ANYREF);
    module.tables.get_mut(table).name = Some(EXPORT.into());
    module.exports.add(EXPORT, table);

    let mut builder = FunctionBuilder::new(&mut module.types, &[], &[]);
    builder.name(HARVEST_EXPORT.into());
    {
        let mut body = builder.func_body();
        if count != 0 {
            // Make repeat invocation deterministic if registration failed
            // after a partial host read. Successful registration clears the
            // same table immediately and never calls harvest again.
            body.i32_const(0)
                .instr(RefNull {
                    ty: RefType::ANYREF,
                })
                .i32_const(count as u32 as i32)
                .instr(TableFill { table });
        }
        for (ordinal, source) in plan.roots.into_iter().enumerate() {
            let ordinal = u32::try_from(ordinal)
                .expect("static reference catalog exceeds the Wasm u32 index space");
            match source {
                RootSource::Global(global) => {
                    body.i32_const(ordinal as i32)
                        .global_get(global)
                        .instr(TableSet { table });
                }
                RootSource::TableFirst {
                    table: source,
                    table64,
                } => {
                    body.i32_const(ordinal as i32);
                    if table64 {
                        body.i64_const(0);
                    } else {
                        body.i32_const(0);
                    }
                    body.instr(TableGet { table: source })
                        .instr(TableSet { table });
                }
                RootSource::ElementItem { element, index } => {
                    body.i32_const(ordinal as i32)
                        .i32_const(index as i32)
                        .i32_const(1)
                        .instr(TableInit {
                            table,
                            elem: element,
                        });
                }
            }
        }
    }
    let harvest = builder.finish(Vec::new(), &mut module.funcs);
    module.exports.add(HARVEST_EXPORT, harvest);
    // Every guest imports the merged catalog (a required table import, see
    // `WPK_FORK_REQUIRED_TABLE_IMPORTS`); only a guest with roots has
    // anything to copy into it.
    let (merged, _) = module.add_import_table("env", MERGED_IMPORT, false, 0, None, RefType::ANYREF);
    if count != 0 {
        emit_fill_shim(module, table, merged, count as u32);
    }

    let mut descriptor = Vec::with_capacity(usize::from(FORMAT_HEADER_SIZE));
    descriptor.extend_from_slice(&FORMAT_MAGIC);
    descriptor.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    descriptor.extend_from_slice(&FORMAT_HEADER_SIZE.to_le_bytes());
    descriptor.extend_from_slice(
        &u32::try_from(count)
            .expect("static reference catalog length exceeds u32")
            .to_le_bytes(),
    );
    module.customs.add(RawCustomSection {
        name: FORMAT_SECTION.into(),
        data: descriptor,
    });
}

/// Emit `__wpk_fork_static_root_fill(base: i32) -> i32`: copy this
/// activation's harvested roots into the fork module's merged catalog at
/// `base`.
///
/// # Why the guest does the copy
///
/// A fork capture recognises a statically initialised reference by finding it
/// in the module's MERGED catalog (activation `a`'s roots at
/// `[base(a), base(a) + len_a)`), and a child's install rebuilds one by
/// reading it back from there. Both need the merged catalog to hold the live
/// roots at that moment, and each activation's roots sit in its own exported
/// table. The hosts used to copy them one `Table.get` / `Table.set` at a time
/// before every capture and every child install (`ForkMergedStaticRoots` on
/// Node and the browser, `fill_static_root_catalog` on host-native): per-slot
/// reference traffic through the host, written twice. A Wasm module can copy
/// between two tables it can name with one `table.copy`, and the guest can
/// name both -- its own catalog and, imported, the module's merged one -- so
/// the copy is the guest's, the decision WHEN to copy is the fork module's (it
/// drives this through its drive table), and no host handles a root. The same
/// shape as `__wpk_fork_place_resume_thunks`.
///
/// # The growth check
///
/// The module grows its merged catalog to cover every range it places, when
/// it places it (`fm_bind_activation`), so a short table means the module's
/// placement and this guest disagree. `table.copy` would trap on it; this
/// answers -1 instead so the module can refuse the fork with an errno that
/// names the disagreement rather than a trap that names nothing.
///
/// Only emitted for a guest with at least one root: a guest without any has
/// nothing to copy, and the module never drives an activation that placed no
/// roots.
fn emit_fill_shim(module: &mut Module, own: TableId, merged: TableId, count: u32) {
    let base = module.locals.add(ValType::I32);
    let mut builder = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[ValType::I32]);
    builder.name(FILL_EXPORT.into());
    {
        let mut body = builder.func_body();
        // Refuse unless `base <= size(merged) - count`, written so neither
        // side can wrap: `count <= size` first, then the difference.
        body.i32_const(count as i32)
            .instr(TableSize { table: merged })
            .binop(BinaryOp::I32GtU)
            .if_else(
                None,
                |then| {
                    then.i32_const(-1).return_();
                },
                |_| {},
            );
        body.local_get(base)
            .instr(TableSize { table: merged })
            .i32_const(count as i32)
            .binop(BinaryOp::I32Sub)
            .binop(BinaryOp::I32GtU)
            .if_else(
                None,
                |then| {
                    then.i32_const(-1).return_();
                },
                |_| {},
            );
        body.local_get(base)
            .i32_const(0)
            .i32_const(count as i32)
            .instr(TableCopy { src: own, dst: merged })
            .i32_const(count as i32);
    }
    let fill = builder.finish(vec![base], &mut module.funcs);
    module.exports.add(FILL_EXPORT, fill);
}

fn can_participate_in_ref_eq(module: &Module, reference: RefType) -> bool {
    match reference.heap_type {
        HeapType::Abstract(kind) => matches!(
            kind,
            AbstractHeapType::Any
                | AbstractHeapType::None
                | AbstractHeapType::Eq
                | AbstractHeapType::Struct
                | AbstractHeapType::Array
                | AbstractHeapType::I31
        ),
        HeapType::Concrete(ty) | HeapType::Exact(ty) => {
            let kind = module.types.get(ty).kind();
            kind.is_struct() || kind.is_array()
        }
        _ => false,
    }
}

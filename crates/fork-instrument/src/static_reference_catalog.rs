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
    AbstractHeapType, ConstExpr, ElementId, ElementItems, FunctionBuilder, GlobalId, GlobalKind,
    HeapType, Module, RawCustomSection, RefType, TableId, ValType,
    ir::{RefNull, TableFill, TableGet, TableInit, TableSet},
};

pub const EXPORT: &str = "__wpk_fork_static_root_catalog";
pub const HARVEST_EXPORT: &str = "__wpk_fork_static_root_harvest";
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

#[derive(Debug, Default)]
pub struct StaticReferenceCatalogPlan {
    roots: Vec<RootSource>,
}

impl StaticReferenceCatalogPlan {
    pub fn root_count(&self) -> usize {
        self.roots.len()
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
    for (element, expressions) in elements {
        for (index, initializer) in expressions.into_iter().enumerate() {
            match initializer {
                ConstExpr::RefNull(_) | ConstExpr::RefFunc(_) => {}
                ConstExpr::Global(global) => {
                    ordinals.intern_global(global);
                }
                _ => {
                    ordinals.intern_source(RootSource::ElementItem {
                        element,
                        index: u32::try_from(index)
                            .expect("element segment exceeds the Wasm u32 index space"),
                    });
                }
            }
        }
    }

    StaticReferenceCatalogPlan {
        roots: ordinals.roots,
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

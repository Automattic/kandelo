//! Compact module headers and disk-backed sink dependency/table relations.

use std::{cell::Cell, collections::HashMap};

use anyhow::{Context, Result, ensure};
use rusqlite::{OptionalExtension, params};
use wasmparser::{ExternalKind, Name, NameSectionReader, Operator, Parser, Payload};

use crate::{
    facts::{self, storage::FactsStore},
    streaming::Scan,
};

use super::{Invocation, Value};

#[derive(Debug, PartialEq, Eq)]
pub struct ResolvedTargets {
    pub functions: Vec<u32>,
    pub external: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct ProgramLimits {
    /// Header catalogs and one queried relation group, independently bounded.
    pub metadata_bytes: usize,
    pub operators: u64,
}

impl Default for ProgramLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 128 * 1024 * 1024,
            operators: 200_000_000,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FunctionInfo {
    pub signature: u32,
    pub imported: bool,
    pub escaping: bool,
    pub small: bool,
    pub noreturn: bool,
    pub nothrow: bool,
}

/// The exclusive store borrow prevents replacing planning tables while a
/// program is using them. All edges, table memberships and slots stay on disk.
/// This is metadata for the native sink planner, not a complete sink plan.
pub struct Program<'s, 'a> {
    scan: &'s Scan<'a>,
    pub(super) store: &'s FactsStore,
    pub(super) parameters_ready: Cell<bool>,
    pub functions: Vec<FunctionInfo>,
    signatures: Vec<Option<u32>>,
    pub global_constants: Vec<Option<i64>>,
    pub stack_pointer_global: Option<u32>,
    pub constant_slots: bool,
    pub dynamic_linking: bool,
    /// External code can return even when the load-time contract excludes
    /// returning through a fork child. Keep return effects separate.
    pub external_returns: bool,
    unknown_tables: Vec<bool>,
    unknown_reference_imports: bool,
    pub(super) limits: ProgramLimits,
}

const NORETURN: &[&str] = &[
    "abort",
    "exit",
    "_Exit",
    "_exit",
    "quick_exit",
    "pthread_exit",
    "__pthread_exit",
    "longjmp",
    "siglongjmp",
    "_longjmp",
    "__wasm_longjmp",
    "std::terminate()",
    "__clang_call_terminate",
    "__cxa_throw",
    "__cxa_rethrow",
    "__assert_fail",
];
const NOTHROW: &[&str] = &[
    "exit",
    "_Exit",
    "_exit",
    "quick_exit",
    "pthread_exit",
    "__pthread_exit",
    "std::terminate()",
    "__clang_call_terminate",
];

fn named_contract(name: Option<&str>, names: &[&str]) -> bool {
    name.is_some_and(|name| {
        names.iter().any(|prefix| {
            name == *prefix
                || name
                    .strip_prefix(prefix)
                    .is_some_and(|tail| tail.starts_with('('))
        })
    })
}

impl<'s, 'a> Program<'s, 'a> {
    pub fn build(
        scan: &'s Scan<'a>,
        store: &'s mut FactsStore,
        limits: ProgramLimits,
    ) -> Result<Self> {
        if let Some(bound) = store.source_fingerprint {
            ensure!(
                bound == scan.source_fingerprint(),
                "sink metadata store belongs to a different original module"
            );
        }
        ensure!(
            scan.operators <= limits.operators,
            "sink metadata exceeds operator budget"
        );
        let types = scan.types.as_ref();
        let ntypes = types.core_type_count_in_module() as usize;
        let nglobals = types.global_count() as usize;
        let charge = scan
            .functions
            .len()
            .checked_mul(32)
            .and_then(|n| n.checked_add(ntypes.checked_mul(96)?))
            .and_then(|n| n.checked_add(nglobals.checked_mul(32)?))
            .and_then(|n| n.checked_add(scan.table_initializers.len().checked_mul(8)?))
            .context("sink metadata size overflow")?;
        ensure!(
            charge <= limits.metadata_bytes,
            "sink metadata exceeds resident budget"
        );
        // WHY: this private phase has no readers until construction returns.
        // Batch its writes while the configured page cache still spills, so
        // each relation row does not force its own database-page writeback.
        let transaction = store.write_batch()?;
        store.db.execute_batch(include_str!("program.sql"))?;
        let mut keys = HashMap::new();
        let mut signatures = vec![None; ntypes];
        for index in 0..ntypes as u32 {
            let ty = types.get(types.core_type_at_in_module(index)).unwrap();
            let wasmparser::CompositeInnerType::Func(function) = &ty.composite_type.inner else {
                continue;
            };
            let key = *keys.entry(function).or_insert(index);
            signatures[index as usize] = Some(key);
            // Facts collapse reference types, whereas sink signature keys
            // preserve concrete canonical types. Keep both identities.
            let mut text = String::new();
            for (side, values) in [function.params(), function.results()]
                .into_iter()
                .enumerate()
            {
                if side == 1 {
                    text.push_str("->");
                }
                for (i, value) in values.iter().enumerate() {
                    if i != 0 {
                        text.push(',');
                    }
                    text.push_str(match value {
                        wasmparser::ValType::I32 => "i32",
                        wasmparser::ValType::I64 => "i64",
                        wasmparser::ValType::F32 => "f32",
                        wasmparser::ValType::F64 => "f64",
                        wasmparser::ValType::V128 => "v128",
                        _ => "ref",
                    });
                    ensure!(
                        text.len() <= limits.metadata_bytes.saturating_sub(charge),
                        "sink signature exceeds resident budget"
                    );
                }
            }
            ensure!(
                text.len() <= limits.metadata_bytes.saturating_sub(charge),
                "sink signature exceeds resident budget"
            );
            store.execute(
                "INSERT INTO sink_signature VALUES(?,?,?)",
                params![index, key, store.atom(&text)?],
            )?;
        }
        let mut functions = Vec::with_capacity(scan.functions.len());
        for (index, function) in scan.functions.iter().enumerate() {
            let imported = function.import.is_some();
            let signature =
                signatures[function.ty as usize].context("sink function has no signature")?;
            store.execute(
                "INSERT INTO sink_function(id,signature) VALUES(?,?)",
                params![index as u32, signature],
            )?;
            let mut ty = Some(types.core_type_at_in_module(function.ty));
            while let Some(id) = ty {
                let function_type = types.get(id).unwrap().composite_type.unwrap_func();
                store.execute(
                    "INSERT OR IGNORE INTO sink_compatible VALUES(?,?)",
                    params![index as u32, keys[function_type]],
                )?;
                ty = types.supertype_of(id);
            }
            functions.push(FunctionInfo {
                signature,
                imported,
                noreturn: !imported && named_contract(function.name.as_deref(), NORETURN),
                nothrow: !imported && named_contract(function.name.as_deref(), NOTHROW),
                ..Default::default()
            });
        }
        drop(keys);
        for table in 0..scan.table_initializers.len() as u32 {
            store.execute("INSERT INTO sink_table(id) VALUES(?)", [table])?;
        }
        let mut sizes = vec![0u16; functions.len()];
        let mut mutated = false;
        let mut written = vec![false; nglobals];
        facts::visit_retained_operators(
            scan,
            limits.metadata_bytes.saturating_sub(charge) / 4,
            |caller, operation| {
                if !matches!(
                    operation,
                    Operator::Nop
                        | Operator::End
                        | Operator::Else
                        | Operator::Catch { .. }
                        | Operator::CatchAll
                        | Operator::Delegate { .. }
                ) {
                    sizes[caller] = sizes[caller].saturating_add(1).min(601);
                }
                match *operation {
                    Operator::Call { function_index } | Operator::ReturnCall { function_index } => {
                        store.execute(
                            "INSERT OR IGNORE INTO sink_direct VALUES(?,?)",
                            params![function_index, caller as u32],
                        )?;
                    }
                    Operator::CallIndirect { type_index, .. }
                    | Operator::ReturnCallIndirect { type_index, .. }
                    | Operator::CallRef { type_index }
                    | Operator::ReturnCallRef { type_index } => {
                        store.execute(
                            "INSERT OR IGNORE INTO sink_indirect VALUES(?,?)",
                            params![signatures[type_index as usize].unwrap(), caller as u32],
                        )?;
                    }
                    Operator::TableSet { .. }
                    | Operator::TableFill { .. }
                    | Operator::TableGrow { .. }
                    | Operator::TableCopy { .. } => mutated = true,
                    Operator::TableInit { table, .. } => {
                        mutated = true;
                        store.execute("UPDATE sink_table SET initialized=1 WHERE id=?", [table])?;
                    }
                    Operator::RefFunc { function_index } => {
                        store.execute(
                            "INSERT OR IGNORE INTO sink_ref VALUES(?)",
                            [function_index],
                        )?;
                    }
                    Operator::GlobalSet { global_index } => written[global_index as usize] = true,
                    _ => {}
                }
                Ok(())
            },
        )?;
        for (_, kind, index) in &scan.exports {
            if *kind == ExternalKind::Global && types.global_at(*index).mutable {
                written[*index as usize] = true;
            }
        }
        for (i, f) in functions.iter_mut().enumerate() {
            f.small = !f.imported && sizes[i] <= 600;
        }
        drop(sizes);
        let mut global_constants = vec![None; nglobals];
        let mut next_global = 0usize;
        let mut stack_pointer_global = None;
        let mut stack_pointer_names = vec![false; nglobals];
        let mut constant_slots = !mutated;
        let mut unknown_tables = vec![false; scan.table_initializers.len()];
        for (table, initializer) in scan.table_initializers.iter().enumerate() {
            match initializer {
                crate::streaming::ValueProof::Function(function) => {
                    constant_slots = false;
                    store.execute("UPDATE sink_function SET escaping=1 WHERE id=?", [function])?;
                    store.execute("INSERT OR IGNORE INTO sink_member SELECT ?,signature,function FROM sink_compatible WHERE function=?",params![table as u32,function])?;
                }
                crate::streaming::ValueProof::Unknown => {
                    constant_slots = false;
                    unknown_tables[table] = true;
                }
                _ => {}
            }
        }
        let mut unknown_reference_imports = false;
        for payload in Parser::new(0).parse_all(scan.input()) {
            match payload? {
                Payload::ImportSection(imports) => {
                    for import in imports.into_imports() {
                        if let wasmparser::TypeRef::Global(global) = import?.ty {
                            next_global += 1;
                            unknown_reference_imports |=
                                matches!(global.content_type, wasmparser::ValType::Ref(_));
                        }
                    }
                }
                Payload::GlobalSection(globals) => {
                    for global in globals {
                        let global = global?;
                        mark_constant_references(store, &global.init_expr)?;
                        if !written[next_global] {
                            global_constants[next_global] = match literal(global.init_expr)? {
                                Some(Operator::I32Const { value }) => Some(value as i64),
                                Some(Operator::I64Const { value }) => Some(value),
                                _ => None,
                            };
                        }
                        next_global += 1;
                    }
                }
                Payload::CustomSection(section) if section.name() == "name" => {
                    let names = NameSectionReader::new(wasmparser::BinaryReader::new(
                        section.data(),
                        section.data_offset(),
                    ));
                    for map in names {
                        if let Ok(Name::Global(map)) = map {
                            for entry in map.into_iter().flatten() {
                                if (entry.index as usize) < nglobals {
                                    stack_pointer_names[entry.index as usize] =
                                        entry.name == "__stack_pointer";
                                }
                            }
                        }
                    }
                }
                Payload::TableSection(tables) => {
                    for table in tables {
                        if let wasmparser::TableInit::Expr(expression) = table?.init {
                            mark_constant_references(store, &expression)?;
                        }
                    }
                }
                Payload::ElementSection(elements) => {
                    for element in elements {
                        let element = element?;
                        let declared = matches!(element.kind, wasmparser::ElementKind::Declared);
                        let active = match element.kind {
                            wasmparser::ElementKind::Active {
                                table_index,
                                offset_expr,
                            } => {
                                let base = match literal(offset_expr)? {
                                    Some(Operator::I32Const { value }) => Some(value as i64),
                                    Some(Operator::I64Const { value }) => Some(value),
                                    _ => None,
                                };
                                if table_index.unwrap_or(0) != 0 || base.is_none() {
                                    constant_slots = false;
                                }
                                Some((table_index.unwrap_or(0), base))
                            }
                            _ => None,
                        };
                        match element.items {
                            wasmparser::ElementItems::Functions(items) => {
                                for (offset, function) in items.into_iter().enumerate() {
                                    add_element(store, active, declared, offset, function?)?;
                                }
                            }
                            wasmparser::ElementItems::Expressions(_, items) => {
                                for (offset, expression) in items.into_iter().enumerate() {
                                    let expression = expression?;
                                    mark_constant_references(store, &expression)?;
                                    match literal(expression)? {
                                        Some(Operator::RefFunc { function_index }) => add_element(
                                            store,
                                            active,
                                            declared,
                                            offset,
                                            function_index,
                                        )?,
                                        Some(Operator::RefNull { .. }) => {
                                            // A null slot cannot shift later function indices.
                                            constant_slots = false;
                                        }
                                        _ => {
                                            constant_slots = false;
                                            if let Some((table, _)) = active {
                                                unknown_tables[table as usize] = true;
                                            } else if !declared {
                                                unknown_tables.fill(true);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if let Some(index) = stack_pointer_names.iter().position(|is_sp| *is_sp) {
            stack_pointer_global = Some(index as u32);
        }
        if mutated {
            store.db.execute_batch("INSERT OR IGNORE INTO sink_member SELECT t.id,c.signature,r.target FROM sink_ref r JOIN sink_compatible c ON c.function=r.target CROSS JOIN sink_table t;")?;
        }
        store.db.execute_batch(
            "UPDATE sink_function SET escaping=1 WHERE id IN (SELECT target FROM sink_ref);",
        )?;
        for (_, kind, function) in &scan.exports {
            if *kind == ExternalKind::Func {
                store.execute("UPDATE sink_function SET escaping=1 WHERE id=?", [function])?;
            }
        }
        if let Some(function) = scan.start {
            store.execute("UPDATE sink_function SET escaping=1 WHERE id=?", [function])?;
        }
        let mut query = store
            .db
            .prepare("SELECT id,escaping FROM sink_function ORDER BY id")?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            functions[row.get::<_, usize>(0)?].escaping = row.get(1)?;
        }
        drop(rows);
        drop(query);
        transaction.commit()?;
        let dynamic_linking =
            scan.functions
                .iter()
                .filter_map(|f| f.import.as_ref())
                .any(|(module, name)| {
                    module == "env"
                        && matches!(
                            name.as_str(),
                            "__wasm_dlopen"
                                | "__wasm_dlopen_main"
                                | "__wasm_dlopen_prepare"
                                | "__wasm_dlopen_next"
                                | "__wasm_dlopen_commit"
                                | "__wasm_dlsym"
                                | "__wasm_dlclose"
                                | "__wasm_dlerror"
                        )
                });
        let exposed_table = scan
            .exports
            .iter()
            .any(|(_, kind, _)| *kind == ExternalKind::Table);
        constant_slots &= !dynamic_linking && !exposed_table;
        if exposed_table {
            // A loader can place any escaped local function in an exposed
            // table; its static element segment is not the complete set.
            store.db.execute_batch("INSERT OR IGNORE INTO sink_member SELECT t.id,c.signature,f.id FROM sink_function f JOIN sink_compatible c ON c.function=f.id CROSS JOIN sink_table t WHERE f.escaping;")?;
        }
        Ok(Self {
            scan,
            store,
            parameters_ready: Cell::new(false),
            functions,
            signatures,
            global_constants,
            stack_pointer_global,
            constant_slots,
            dynamic_linking,
            external_returns: dynamic_linking,
            unknown_tables,
            unknown_reference_imports,
            limits,
        })
    }

    pub fn signature(&self, source_type: u32) -> Result<u32> {
        self.signatures
            .get(source_type as usize)
            .copied()
            .flatten()
            .context("unknown sink function signature")
    }

    pub fn facts_signature(&self, source_type: u32) -> Result<String> {
        self.store.charge_work(1)?;
        let atom: i64 = self.store.db.query_row(
            "SELECT fact_name FROM sink_signature WHERE source=?",
            [source_type],
            |r| r.get(0),
        )?;
        self.store.name(atom)
    }

    /// Base resolution, before signal/parameter/registry/cleanup refinements.
    /// Literal table slots take precedence over compiler facts, as in the
    /// oracle. Only a single facts/table/reference group becomes resident.
    pub fn base_targets(
        &self,
        caller: u32,
        invocation: Invocation,
        selector: Value,
    ) -> Result<ResolvedTargets> {
        ensure!(
            (caller as usize) < self.functions.len(),
            "unknown sink caller"
        );
        let (functions, external) = match invocation {
            Invocation::Direct(function) => {
                ensure!(
                    (function as usize) < self.functions.len(),
                    "unknown sink direct callee"
                );
                (vec![function], false)
            }
            Invocation::Indirect { table, ty } => {
                ensure!(
                    (table as usize) < self.scan.table_initializers.len(),
                    "unknown sink table"
                );
                let signature = self.signature(ty)?;
                if let (0, true, Value::Constant(slot)) = (table, self.constant_slots, selector) {
                    let target = self
                        .constant_slot(slot)?
                        .filter(|f| self.accepts(*f, signature));
                    (target.into_iter().collect(), false)
                } else {
                    let facts = if self.store.calls_ready.get() {
                        self.store.targets_for(caller, &self.facts_signature(ty)?)?
                    } else {
                        None
                    };
                    let targets = if let Some(mut facts) = facts {
                        facts.retain(|target| self.accepts(*target, signature));
                        facts
                    } else {
                        self.table_targets(table, signature)?
                    };
                    (
                        targets,
                        self.dynamic_linking || self.unknown_tables[table as usize],
                    )
                }
            }
            Invocation::Reference { ty } => (
                self.reference_targets(self.signature(ty)?)?,
                self.dynamic_linking
                    || self.unknown_reference_imports
                    || self.unknown_tables.iter().any(|unknown| *unknown),
            ),
        };
        Ok(ResolvedTargets {
            functions,
            external,
        })
    }

    /// Structural signature equality plus the validated declared-supertype
    /// chain, matching the conservative native call graph's typed-ref policy.
    pub fn accepts(&self, function: u32, signature: u32) -> bool {
        let Some(function) = self.scan.functions.get(function as usize) else {
            return false;
        };
        let types = self.scan.types.as_ref();
        let Some(expected) = self.signatures.get(signature as usize).copied().flatten() else {
            return false;
        };
        let expected = types
            .get(types.core_type_at_in_module(expected))
            .unwrap()
            .composite_type
            .unwrap_func();
        let mut ty = Some(types.core_type_at_in_module(function.ty));
        while let Some(id) = ty {
            if types.get(id).unwrap().composite_type.unwrap_func() == expected {
                return true;
            }
            ty = types.supertype_of(id);
        }
        false
    }

    fn indices(&self, sql: &str, parameters: impl rusqlite::Params) -> Result<Vec<u32>> {
        self.store.charge_work(1)?;
        let mut output = Vec::new();
        let mut query = self.store.db.prepare_cached(sql)?;
        let mut rows = query.query(parameters)?;
        while let Some(row) = rows.next()? {
            ensure!(
                output.len() < self.limits.metadata_bytes / 8,
                "sink relation group exceeds resident budget"
            );
            output.push(row.get(0)?);
        }
        Ok(output)
    }

    pub fn table_targets(&self, table: u32, signature: u32) -> Result<Vec<u32>> {
        self.indices(
            "SELECT target FROM sink_member WHERE table_id=? AND signature=? ORDER BY target",
            params![table, signature],
        )
    }

    pub fn reference_targets(&self, signature: u32) -> Result<Vec<u32>> {
        self.indices(
            "SELECT c.function FROM sink_compatible c JOIN sink_function f ON f.id=c.function WHERE c.signature=? AND f.escaping ORDER BY c.function",
            [signature],
        )
    }

    pub fn direct_callers(&self, function: u32) -> Result<Vec<u32>> {
        self.indices(
            "SELECT caller FROM sink_direct WHERE callee=? ORDER BY caller",
            [function],
        )
    }

    /// Includes call_ref as well as table dispatch, so summary changes always
    /// revisit callers that can observe a changed escaping function.
    pub fn indirect_callers(&self, signature: u32) -> Result<Vec<u32>> {
        self.indices(
            "SELECT caller FROM sink_indirect WHERE signature=? ORDER BY caller",
            [signature],
        )
    }

    pub fn indirect_callers_of(&self, function: u32) -> Result<Vec<u32>> {
        self.indices("SELECT DISTINCT i.caller FROM sink_indirect i JOIN sink_compatible c ON c.signature=i.signature WHERE c.function=? ORDER BY i.caller",[function])
    }

    pub fn constant_slot(&self, slot: i64) -> Result<Option<u32>> {
        ensure!(
            self.constant_slots,
            "sink table slots are not statically known"
        );
        self.store.charge_work(1)?;
        Ok(self
            .store
            .db
            .query_row("SELECT target FROM sink_slot WHERE slot=?", [slot], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn original_scan(&self) -> &Scan<'a> {
        self.scan
    }

    /// The native fork-closure driver must seed its external vertex whenever
    /// this is true, not only when a dlopen function import is present.
    pub fn has_external_dispatch(&self) -> bool {
        self.dynamic_linking
            || self.unknown_reference_imports
            || self.unknown_tables.iter().any(|unknown| *unknown)
    }

    pub fn table_has_external_targets(&self, table: u32) -> Result<bool> {
        let unknown = self
            .unknown_tables
            .get(table as usize)
            .context("unknown sink table")?;
        Ok(self.dynamic_linking || *unknown)
    }
}

fn mark_constant_references(
    store: &FactsStore,
    expression: &wasmparser::ConstExpr<'_>,
) -> Result<()> {
    let mut reader = expression.get_operators_reader();
    while !reader.eof() {
        if let Operator::RefFunc { function_index } = reader.read()? {
            store.execute(
                "UPDATE sink_function SET escaping=1 WHERE id=?",
                [function_index],
            )?;
        }
    }
    Ok(())
}

fn literal(expression: wasmparser::ConstExpr<'_>) -> Result<Option<Operator<'_>>> {
    let mut reader = expression.get_operators_reader();
    let first = reader.read()?;
    Ok((matches!(reader.read()?, Operator::End) && reader.eof()).then_some(first))
}

fn add_element(
    store: &FactsStore,
    active: Option<(u32, Option<i64>)>,
    declared: bool,
    offset: usize,
    function: u32,
) -> Result<()> {
    store.execute("UPDATE sink_function SET escaping=1 WHERE id=?", [function])?;
    if let Some((table, base)) = active {
        store.execute(
            "INSERT OR IGNORE INTO sink_member SELECT ?,signature,function FROM sink_compatible WHERE function=?",
            params![table, function],
        )?;
        if table == 0
            && let Some(base) = base
        {
            store.execute(
                "INSERT OR REPLACE INTO sink_slot VALUES(?,?)",
                params![
                    base.checked_add(offset as i64)
                        .context("sink element slot overflow")?,
                    function
                ],
            )?;
        }
    } else if !declared {
        store.execute("INSERT OR IGNORE INTO sink_member SELECT t.id,c.signature,c.function FROM sink_compatible c CROSS JOIN sink_table t WHERE c.function=? AND t.initialized", [function])?;
    }
    Ok(())
}

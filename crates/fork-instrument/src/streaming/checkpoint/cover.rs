//! The run-time check. A token passes coverage from a covered caller to its
//! covered callee:
//!
//! - a covered function reads the token at entry into its `cover` local and
//!   clears it;
//! - before a call whose callee is covered, a covered caller writes its own
//!   `cover` into the token; an indirect call writes it only when the table
//!   slot holds a covered function;
//! - an uncovered frame writes nothing, so a covered callee below it reads 0;
//! - an uncovered `_start` or thread entry clears the token at entry, so the
//!   token the host wrote for it never reaches a covered callee further down.
//!
//! Every call to the `kernel.kernel_checkpoint_covered` import becomes the
//! calling frame's `cover`. The host writes 1 into the exported token before
//! it enters `_start` or a thread's entry, which covers the bottom frame.
//! The rewrite runs before activation planning, so `cover` is an ordinary
//! local there: a rewound frame restores it with its other locals.
use super::super::{
    EmitLimits, EmitReport, FrozenDeclarations, FrozenModuleDeclarations, FunctionTransform,
    ModuleDeclarationBuilder, ProgramPoint, Scan, emit_remapped,
};
use super::{COVER_EXPORT, COVERED_IMPORT, THREAD_ENTRIES, table_slots};
use anyhow::{Context, Result, bail, ensure};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use wasm_encoder::{
    ConstExpr, ExportKind, FuncType, Function, GlobalType, Instruction, ValType, reencode::Reencode,
};
use wasmparser::Operator;

struct Cover<'c> {
    scan: &'c Scan<'c>,
    covered: &'c BTreeSet<u32>,
    entries: BTreeSet<u32>,
    import: Option<u32>,
    token: u32,
    tests: BTreeMap<u32, (u32, Vec<u32>)>,
    declarations: FrozenDeclarations,
    module: FrozenModuleDeclarations,
}

impl Reencode for Cover<'_> {
    type Error = std::convert::Infallible;
}

impl FunctionTransform for Cover<'_> {
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.declarations)
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        Some(&self.module)
    }

    /// `(slot: i32) -> i32`: does `slot` hold a covered function?
    fn emit_helper(&mut self, helper: u32, limit: usize) -> Result<Function> {
        let Some((_, slots)) = self.tests.values().nth(helper as usize) else {
            bail!("unknown checkpoint coverage helper");
        };
        let mut output = Function::new([]);
        output.instruction(&Instruction::I32Const(0));
        for &slot in slots {
            output.instruction(&Instruction::LocalGet(0));
            output.instruction(&Instruction::I32Const(slot as i32));
            output.instruction(&Instruction::I32Eq);
            output.instruction(&Instruction::I32Or);
            ensure!(
                output.byte_len() <= limit,
                "checkpoint coverage helper exceeds output budget"
            );
        }
        output.instruction(&Instruction::End);
        Ok(output)
    }

    fn transform_body(
        &mut self,
        function: u32,
        body: wasmparser::FunctionBody<'_>,
        limit: usize,
    ) -> Result<Function> {
        let covered = self.covered.contains(&function);
        let mut locals = Vec::new();
        let types = self.scan.types.as_ref();
        let ty = types.core_type_at_in_module(self.scan.functions[function as usize].ty);
        let mut first = u32::try_from(
            types
                .get(ty)
                .unwrap()
                .composite_type
                .unwrap_func()
                .params()
                .len(),
        )?;
        for local in body.get_locals_reader()? {
            let (count, ty) = local?;
            first = first.checked_add(count).context("local count overflow")?;
            locals.push((count, self.val_type(ty)?));
        }
        let (cover, slot) = (first, first + 1);
        if covered {
            locals.push((2, ValType::I32));
        }
        let mut output = Function::new(locals);
        if covered {
            output.instruction(&Instruction::GlobalGet(self.token));
            output.instruction(&Instruction::LocalSet(cover));
        }
        if covered || self.entries.contains(&function) {
            output.instruction(&Instruction::I32Const(0));
            output.instruction(&Instruction::GlobalSet(self.token));
        }
        let mut reader = body.get_operators_reader()?;
        while !reader.eof() {
            let point = ProgramPoint {
                function,
                offset: reader.original_position(),
            };
            let op = reader.read()?;
            match op {
                Operator::Call { function_index } if Some(function_index) == self.import => {
                    output.instruction(&if covered {
                        Instruction::LocalGet(cover)
                    } else {
                        Instruction::I32Const(0)
                    });
                    continue;
                }
                Operator::Call { function_index } | Operator::ReturnCall { function_index }
                    if covered && self.covered.contains(&function_index) =>
                {
                    output.instruction(&Instruction::LocalGet(cover));
                    output.instruction(&Instruction::GlobalSet(self.token));
                }
                Operator::CallIndirect { table_index, .. }
                | Operator::ReturnCallIndirect { table_index, .. }
                    if covered && self.tests.contains_key(&table_index) =>
                {
                    output.instruction(&Instruction::LocalSet(slot));
                    output.instruction(&Instruction::LocalGet(slot));
                    output.instruction(&Instruction::Call(self.tests[&table_index].0));
                    output.instruction(&Instruction::LocalGet(cover));
                    output.instruction(&Instruction::I32And);
                    output.instruction(&Instruction::GlobalSet(self.token));
                    output.instruction(&Instruction::LocalGet(slot));
                }
                _ => {}
            }
            self.transform_operator(point, op, &mut output)?;
            ensure!(
                output.byte_len() <= limit,
                "encoded function exceeds streaming output budget"
            );
        }
        Ok(output)
    }
}

/// Write `scan` with the token, the per-frame `cover` locals, the call-site
/// writes and the `kernel_checkpoint_covered()` answers. Source function,
/// global and type indices are unchanged; the token and one slot test per
/// table follow them.
pub fn cover<W: Write>(
    scan: &Scan<'_>,
    covered: &BTreeSet<u32>,
    output: &mut W,
    limits: EmitLimits,
    budget: usize,
) -> Result<EmitReport> {
    let import =
        scan.functions
            .iter()
            .position(|function| {
                function.import.as_ref().is_some_and(|(module, name)| {
                    (module.as_str(), name.as_str()) == COVERED_IMPORT
                })
            })
            .map(u32::try_from)
            .transpose()?;
    let mut module = ModuleDeclarationBuilder::new(scan, None, budget)?;
    let token = module.global(
        GlobalType {
            val_type: ValType::I32,
            mutable: true,
            shared: false,
        },
        ConstExpr::i32_const(0),
    )?;
    module.export(COVER_EXPORT, ExportKind::Global, token)?;
    let mut slots: BTreeMap<u32, BTreeSet<u32>> = BTreeMap::new();
    for (table, slot, function) in table_slots(scan) {
        if covered.contains(&function) {
            slots.entry(table).or_default().insert(slot);
        }
    }
    let first = u32::try_from(scan.functions.len())?;
    let mut tests = BTreeMap::new();
    for (helper, (table, slots)) in slots.into_iter().enumerate() {
        ensure!(
            !scan.types.as_ref().table_at(table).table64,
            "checkpoint coverage models 32-bit tables only"
        );
        let index = first
            .checked_add(u32::try_from(helper)?)
            .context("checkpoint coverage helper index overflow")?;
        tests.insert(table, (index, slots.into_iter().collect()));
    }
    let ty = scan.types.as_ref().core_type_count_in_module();
    let declarations = FrozenDeclarations::new(
        if tests.is_empty() {
            vec![]
        } else {
            vec![FuncType::new([ValType::I32], [ValType::I32])]
        },
        vec![ty; tests.len()],
        budget,
    )?;
    let entries = scan
        .exports
        .iter()
        .filter(|(name, kind, _)| name == "_start" && *kind == wasmparser::ExternalKind::Func)
        .map(|(_, _, index)| *index)
        .chain(
            scan.functions
                .iter()
                .enumerate()
                .filter_map(|(index, function)| {
                    function
                        .name
                        .as_deref()
                        .is_some_and(|name| THREAD_ENTRIES.contains(&name))
                        .then_some(index as u32)
                }),
        )
        .collect();
    emit_remapped(
        scan,
        &mut Cover {
            scan,
            covered,
            entries,
            import,
            token,
            tests,
            declarations,
            module: module.freeze(),
        },
        output,
        limits,
    )
}

//! Conservative Wasm local-root spilling for runtimes such as CRuby.
//!
//! CRuby's conservative GC expects live `VALUE` roots to be visible in stack
//! memory. Optimized Wasm locals and operand-stack values are not memory bytes,
//! so a Ruby `VALUE` can be live across an allocating call while still being
//! invisible to Ruby's scanner. The `ruby` profile mirrors wasm32 `i32` locals
//! and selected operand-stack carryovers into a small frame reserved from
//! `__stack_pointer`.
//!
//! This is not a general root-map generator. The implementation is intentionally
//! narrow, package-build scoped, and fail-loud: unsupported profiles, memory64,
//! unknown operand-stack carryovers, and ref-typed carryovers are rejected or
//! left out of scope instead of producing a partial root set. See the crate
//! README for the Ruby 4 rationale, applicability to other runtimes, and known
//! gaps.

use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
};

use anyhow::{Context, Result, bail, ensure};
use walrus::{
    ExportItem, FunctionId, FunctionKind, GlobalId, LocalFunction, LocalId, MemoryId, Module,
    TagId, ValType,
    ir::{
        AtomicWidth, BinaryOp, Binop, Block, Br, BrTable, Call, CallIndirect, Const, GlobalGet,
        GlobalSet, IfElse, Instr, InstrLocId, InstrSeqId, InstrSeqType, LegacyCatch, LoadKind,
        LocalGet, LocalSet, LocalTee, Loop, MemArg, Rethrow, Return, StoreKind, Throw, ThrowRef,
        TryTable, TryTableCatch, UnaryOp, Value,
    },
};

#[derive(Debug, Clone)]
pub struct Options {
    pub profile: String,
    pub value_width: u32,
    pub spill_set: SpillSet,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            profile: "ruby".into(),
            value_width: 32,
            spill_set: SpillSet::AllI32,
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum SpillSet {
    AllI32,
    ParamsAndOperands,
    ParamsOnly,
}

impl FromStr for SpillSet {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "all-i32" => Ok(Self::AllI32),
            "params-and-operands" => Ok(Self::ParamsAndOperands),
            "params-only" => Ok(Self::ParamsOnly),
            _ => bail!(
                "unsupported spill set `{value}`; expected `all-i32`, `params-and-operands`, or `params-only`"
            ),
        }
    }
}

pub fn spill(input: &[u8], opts: &Options) -> Result<Vec<u8>> {
    ensure!(
        opts.profile == "ruby",
        "unsupported local-root spill profile `{}`; only `ruby` is supported",
        opts.profile
    );
    ensure!(
        opts.value_width == 32,
        "unsupported value width {}; only wasm32/32-bit VALUE spilling is supported",
        opts.value_width
    );

    let mut module =
        Module::from_buffer(input).context("failed to parse input wasm module for root spill")?;
    let stack_pointer = find_stack_pointer(&module)?;
    let memory = find_wasm32_memory(&module)?;

    let targets: Vec<FunctionId> = module
        .funcs
        .iter()
        .filter_map(|f| match f.kind {
            FunctionKind::Local(_) => Some(f.id()),
            FunctionKind::Import(_) | FunctionKind::Uninitialized(_) => None,
        })
        .collect();

    for func_id in targets {
        spill_function(&mut module, func_id, stack_pointer, memory, opts.spill_set)
            .with_context(|| format!("spilling {}", function_name(&module, func_id)))?;
    }

    Ok(module.emit_wasm())
}

fn spill_function(
    module: &mut Module,
    func_id: FunctionId,
    stack_pointer: GlobalId,
    memory: MemoryId,
    spill_set: SpillSet,
) -> Result<()> {
    let entry = {
        let local = local_func(module, func_id)?;
        let entry = local.entry_block();
        if !seq_contains_call(local, entry) {
            return Ok(());
        }
        entry
    };

    let mut plan = {
        let local = local_func(module, func_id)?;
        plan_spills(module, local, spill_set)
    };

    if spill_set != SpillSet::ParamsOnly {
        rewrite_operand_stack_roots_in_seq(module, func_id, entry, &mut plan)
            .with_context(|| "materializing operand-stack root carryovers")?;
    }
    if plan.slots.is_empty() {
        return Ok(());
    }

    let spill_base = module.locals.add(ValType::I32);

    rewrite_function_exits_in_seq(
        module,
        func_id,
        entry,
        entry,
        &[],
        stack_pointer,
        spill_base,
        plan.frame_size,
    );
    rewrite_local_writes_in_seq(module, func_id, entry, memory, spill_base, &plan.offsets);

    let mut prefix = Vec::new();
    emit_reserve(&mut prefix, stack_pointer, spill_base, plan.frame_size);
    for slot in &plan.slots {
        emit_seed_slot(&mut prefix, memory, spill_base, slot);
    }

    let mut suffix = Vec::new();
    emit_restore(&mut suffix, stack_pointer, spill_base, plan.frame_size);

    let local = local_func_mut(module, func_id)?;
    let entry_instrs = &mut local.block_mut(entry).instrs;
    let original = std::mem::take(entry_instrs);
    entry_instrs.extend(prefix);
    entry_instrs.extend(original);
    entry_instrs.extend(suffix);

    Ok(())
}

#[derive(Debug)]
struct SpillPlan {
    slots: Vec<SpillSlot>,
    offsets: HashMap<LocalId, u64>,
    frame_size: u32,
}

impl SpillPlan {
    fn add_slot(&mut self, local: LocalId, is_arg: bool) -> u64 {
        if let Some(&offset) = self.offsets.get(&local) {
            return offset;
        }
        let offset = (self.slots.len() as u64) * 4;
        self.slots.push(SpillSlot {
            local,
            offset,
            is_arg,
        });
        self.offsets.insert(local, offset);
        self.frame_size = align_up((self.slots.len() as u32) * 4, 16);
        offset
    }
}

#[derive(Debug)]
struct SpillSlot {
    local: LocalId,
    offset: u64,
    is_arg: bool,
}

fn plan_spills(module: &Module, local: &LocalFunction, spill_set: SpillSet) -> SpillPlan {
    let arg_set: HashSet<LocalId> = local.args.iter().copied().collect();
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();

    for arg in &local.args {
        if module.locals.get(*arg).ty() == ValType::I32 && seen.insert(*arg) {
            ordered.push((*arg, true));
        }
    }
    if spill_set == SpillSet::AllI32 {
        collect_i32_locals(module, local, local.entry_block(), &mut seen, &mut ordered);
    }

    let mut slots = Vec::new();
    let mut offsets = HashMap::new();
    for (idx, (local, is_arg)) in ordered.into_iter().enumerate() {
        let offset = (idx as u64) * 4;
        slots.push(SpillSlot {
            local,
            offset,
            is_arg: is_arg || arg_set.contains(&local),
        });
        offsets.insert(local, offset);
    }

    let frame_size = align_up((slots.len() as u32) * 4, 16);
    SpillPlan {
        slots,
        offsets,
        frame_size,
    }
}

fn collect_i32_locals(
    module: &Module,
    local: &LocalFunction,
    seq: InstrSeqId,
    seen: &mut HashSet<LocalId>,
    ordered: &mut Vec<(LocalId, bool)>,
) {
    for (instr, _) in &local.block(seq).instrs {
        match instr {
            Instr::LocalGet(LocalGet { local })
            | Instr::LocalSet(LocalSet { local })
            | Instr::LocalTee(LocalTee { local }) => {
                if module.locals.get(*local).ty() == ValType::I32 && seen.insert(*local) {
                    ordered.push((*local, false));
                }
            }
            _ => {}
        }
        for child in nested_seqs(instr) {
            collect_i32_locals(module, local, child, seen, ordered);
        }
    }
}

fn rewrite_operand_stack_roots_in_seq(
    module: &mut Module,
    func_id: FunctionId,
    seq: InstrSeqId,
    plan: &mut SpillPlan,
) -> Result<()> {
    let children = {
        let local = local_func(module, func_id)?;
        local
            .block(seq)
            .instrs
            .iter()
            .flat_map(|(instr, _)| nested_seqs(instr))
            .collect::<Vec<_>>()
    };
    for child in children {
        rewrite_operand_stack_roots_in_seq(module, func_id, child, plan)?;
    }

    let mut stack = {
        let local = local_func(module, func_id)?;
        seq_initial_stack(module, local, seq)
    };
    let original = {
        let local = local_func_mut(module, func_id)?;
        std::mem::take(&mut local.block_mut(seq).instrs)
    };

    let mut out = Vec::with_capacity(original.len());
    let mut reachable = true;
    for (instr, loc) in original {
        if !reachable {
            push(&mut out, instr, loc);
            continue;
        }

        match call_operand_count_and_results(module, &instr) {
            Some((operand_count, results)) => {
                materialize_stack_prefix_if_needed(
                    module,
                    plan,
                    &stack,
                    operand_count,
                    instr,
                    loc,
                    &mut out,
                    "call",
                )?;
                apply_call_effect(&mut stack, operand_count, &results)?;
            }
            None => {
                let effect = {
                    let local = local_func(module, func_id)?;
                    stack_effect(module, local, &instr)
                };
                let has_calling_child = {
                    let local = local_func(module, func_id)?;
                    nested_seqs(&instr)
                        .into_iter()
                        .any(|child| seq_contains_call(local, child))
                };
                let consumed = match effect {
                    StackEffect::Delta { pops, .. } => pops,
                    StackEffect::Terminator | StackEffect::Unknown => 0,
                };
                if has_calling_child && consumed <= stack.len() {
                    materialize_stack_prefix_if_needed(
                        module,
                        plan,
                        &stack,
                        consumed,
                        instr,
                        loc,
                        &mut out,
                        "structured region containing a call",
                    )?;
                } else {
                    push(&mut out, instr, loc);
                }

                match effect {
                    StackEffect::Delta { pops, pushes } => {
                        apply_stack_effect(module, func_id, &mut stack, pops, pushes, out.last())?;
                    }
                    StackEffect::Terminator => {
                        stack.clear();
                        reachable = false;
                    }
                    StackEffect::Unknown => {
                        bail!(
                            "unsupported instruction while analyzing operand-stack root carryovers"
                        );
                    }
                }
            }
        }
    }

    let local = local_func_mut(module, func_id)?;
    local.block_mut(seq).instrs = out;
    Ok(())
}

fn materialize_stack_prefix_if_needed(
    module: &mut Module,
    plan: &mut SpillPlan,
    stack: &[Option<ValType>],
    consumed: usize,
    instr: Instr,
    loc: InstrLocId,
    out: &mut Vec<(Instr, InstrLocId)>,
    context: &str,
) -> Result<()> {
    ensure!(
        stack.len() >= consumed,
        "operand-stack underflow while analyzing {context}"
    );
    let prefix_len = stack.len() - consumed;
    let prefix = &stack[..prefix_len];
    if prefix.is_empty() {
        push(out, instr, loc);
        return Ok(());
    }
    if prefix.iter().any(Option::is_none) {
        bail!("unsupported unknown operand-stack carryover before {context}");
    }
    if !prefix.iter().any(|ty| matches!(ty, Some(ValType::I32))) {
        push(out, instr, loc);
        return Ok(());
    }

    let prefix_types = concrete_stack_types(prefix, context)?;
    let operand_types = concrete_stack_types(&stack[prefix_len..], context)?;
    ensure!(
        prefix_types
            .iter()
            .chain(operand_types.iter())
            .all(|ty| is_scalar(*ty)),
        "unsupported ref-typed operand-stack carryover before {context}"
    );

    let operand_temps = operand_types
        .iter()
        .map(|ty| module.locals.add(*ty))
        .collect::<Vec<_>>();
    let prefix_temps = prefix_types
        .iter()
        .map(|ty| module.locals.add(*ty))
        .collect::<Vec<_>>();

    for (&temp, _) in operand_temps.iter().zip(operand_types.iter()).rev() {
        push(out, Instr::LocalSet(LocalSet { local: temp }), loc);
    }
    for (&temp, &ty) in prefix_temps.iter().zip(prefix_types.iter()).rev() {
        push(out, Instr::LocalSet(LocalSet { local: temp }), loc);
        if ty == ValType::I32 {
            plan.add_slot(temp, false);
        }
    }
    for &temp in &prefix_temps {
        push(out, Instr::LocalGet(LocalGet { local: temp }), loc);
    }
    for &temp in &operand_temps {
        push(out, Instr::LocalGet(LocalGet { local: temp }), loc);
    }
    push(out, instr, loc);
    Ok(())
}

fn concrete_stack_types(slots: &[Option<ValType>], context: &str) -> Result<Vec<ValType>> {
    slots
        .iter()
        .copied()
        .map(|slot| slot.with_context(|| format!("unknown operand-stack value before {context}")))
        .collect()
}

fn rewrite_local_writes_in_seq(
    module: &mut Module,
    func_id: FunctionId,
    seq: InstrSeqId,
    memory: MemoryId,
    spill_base: LocalId,
    offsets: &HashMap<LocalId, u64>,
) {
    let children = {
        let local = local_func(module, func_id).expect("local function");
        local
            .block(seq)
            .instrs
            .iter()
            .flat_map(|(instr, _)| nested_seqs(instr))
            .collect::<Vec<_>>()
    };
    for child in children {
        rewrite_local_writes_in_seq(module, func_id, child, memory, spill_base, offsets);
    }

    let local = local_func_mut(module, func_id).expect("local function");
    let original = std::mem::take(&mut local.block_mut(seq).instrs);
    let mut out = Vec::with_capacity(original.len());
    for (instr, loc) in original {
        match instr {
            Instr::LocalSet(LocalSet { local }) if offsets.contains_key(&local) => {
                push(&mut out, Instr::LocalSet(LocalSet { local }), loc);
                emit_store_local(&mut out, memory, spill_base, local, offsets[&local]);
            }
            Instr::LocalTee(LocalTee { local }) if offsets.contains_key(&local) => {
                push(&mut out, Instr::LocalTee(LocalTee { local }), loc);
                emit_store_local(&mut out, memory, spill_base, local, offsets[&local]);
            }
            other => push(&mut out, other, loc),
        }
    }
    local.block_mut(seq).instrs = out;
}

fn rewrite_function_exits_in_seq(
    module: &mut Module,
    func_id: FunctionId,
    seq: InstrSeqId,
    function_exit: InstrSeqId,
    active_catches: &[ActiveCatch],
    stack_pointer: GlobalId,
    spill_base: LocalId,
    frame_size: u32,
) {
    let children = {
        let local = local_func(module, func_id).expect("local function");
        local
            .block(seq)
            .instrs
            .iter()
            .flat_map(|(instr, _)| exit_rewrite_children(instr, active_catches))
            .collect::<Vec<_>>()
    };
    for (child, child_catches) in children {
        rewrite_function_exits_in_seq(
            module,
            func_id,
            child,
            function_exit,
            &child_catches,
            stack_pointer,
            spill_base,
            frame_size,
        );
    }

    let local = local_func_mut(module, func_id).expect("local function");
    let original = std::mem::take(&mut local.block_mut(seq).instrs);
    let mut out = Vec::with_capacity(original.len());
    for (instr, loc) in original {
        if restores_function_exit(&instr, function_exit, active_catches) {
            emit_restore(&mut out, stack_pointer, spill_base, frame_size);
        }
        push(&mut out, instr, loc);
    }
    local.block_mut(seq).instrs = out;
}

#[derive(Debug, Clone, Copy)]
enum ActiveCatch {
    Tag(TagId),
    Any,
}

fn exit_rewrite_children(
    instr: &Instr,
    active_catches: &[ActiveCatch],
) -> Vec<(InstrSeqId, Vec<ActiveCatch>)> {
    match instr {
        Instr::Block(Block { seq }) | Instr::Loop(Loop { seq }) => {
            vec![(*seq, active_catches.to_vec())]
        }
        Instr::IfElse(IfElse {
            consequent,
            alternative,
        }) => vec![
            (*consequent, active_catches.to_vec()),
            (*alternative, active_catches.to_vec()),
        ],
        Instr::TryTable(TryTable { seq, catches }) => {
            let mut try_catches = active_catches.to_vec();
            try_catches.extend(catches.iter().filter_map(active_catch_for_try_table));
            vec![(*seq, try_catches)]
        }
        Instr::Try(walrus::ir::Try { seq, catches }) => {
            let mut children = Vec::new();

            let mut try_catches = active_catches.to_vec();
            try_catches.extend(catches.iter().filter_map(active_catch_for_legacy_try));
            children.push((*seq, try_catches));

            for catch in catches {
                match catch {
                    LegacyCatch::Catch { handler, .. } | LegacyCatch::CatchAll { handler } => {
                        children.push((*handler, active_catches.to_vec()));
                    }
                    LegacyCatch::Delegate { .. } => {}
                }
            }

            children
        }
        _ => Vec::new(),
    }
}

fn active_catch_for_try_table(catch: &TryTableCatch) -> Option<ActiveCatch> {
    match catch {
        TryTableCatch::Catch { tag, .. } | TryTableCatch::CatchRef { tag, .. } => {
            Some(ActiveCatch::Tag(*tag))
        }
        TryTableCatch::CatchAll { .. } | TryTableCatch::CatchAllRef { .. } => {
            Some(ActiveCatch::Any)
        }
    }
}

fn active_catch_for_legacy_try(catch: &LegacyCatch) -> Option<ActiveCatch> {
    match catch {
        LegacyCatch::Catch { tag, .. } => Some(ActiveCatch::Tag(*tag)),
        LegacyCatch::CatchAll { .. } => Some(ActiveCatch::Any),
        LegacyCatch::Delegate { .. } => None,
    }
}

fn restores_function_exit(
    instr: &Instr,
    function_exit: InstrSeqId,
    active_catches: &[ActiveCatch],
) -> bool {
    match instr {
        Instr::Return(Return {}) => true,
        Instr::Br(Br { block }) => *block == function_exit,
        Instr::BrTable(BrTable { blocks, default }) => {
            *default == function_exit && blocks.iter().all(|block| *block == function_exit)
        }
        Instr::Throw(Throw { tag }) => !catches_tag(active_catches, *tag),
        Instr::ThrowRef(ThrowRef {}) | Instr::Rethrow(Rethrow { .. }) => active_catches.is_empty(),
        _ => false,
    }
}

fn catches_tag(active_catches: &[ActiveCatch], tag: TagId) -> bool {
    active_catches.iter().any(|catch| match catch {
        ActiveCatch::Tag(catch_tag) => *catch_tag == tag,
        ActiveCatch::Any => true,
    })
}

fn seq_initial_stack(
    module: &Module,
    local: &LocalFunction,
    seq: InstrSeqId,
) -> Vec<Option<ValType>> {
    match local.block(seq).ty {
        InstrSeqType::MultiValue(ty_id) => module
            .types
            .get(ty_id)
            .params()
            .iter()
            .map(|&ty| Some(ty))
            .collect(),
        InstrSeqType::Simple(_) => Vec::new(),
    }
}

fn call_operand_count_and_results(module: &Module, instr: &Instr) -> Option<(usize, Vec<ValType>)> {
    match instr {
        Instr::Call(Call { func }) => {
            let ty = module.funcs.get(*func).ty();
            let sig = module.types.get(ty);
            Some((sig.params().len(), sig.results().to_vec()))
        }
        Instr::CallIndirect(CallIndirect { ty, .. }) => {
            let sig = module.types.get(*ty);
            Some((sig.params().len() + 1, sig.results().to_vec()))
        }
        _ => None,
    }
}

fn apply_call_effect(
    stack: &mut Vec<Option<ValType>>,
    operand_count: usize,
    results: &[ValType],
) -> Result<()> {
    ensure!(
        stack.len() >= operand_count,
        "operand-stack underflow while applying call effect"
    );
    stack.truncate(stack.len() - operand_count);
    stack.extend(results.iter().copied().map(Some));
    Ok(())
}

fn apply_stack_effect(
    module: &Module,
    func_id: FunctionId,
    stack: &mut Vec<Option<ValType>>,
    pops: usize,
    pushes: usize,
    emitted: Option<&(Instr, InstrLocId)>,
) -> Result<()> {
    ensure!(
        stack.len() >= pops,
        "operand-stack underflow while applying instruction effect"
    );
    let pre_stack = stack.clone();
    stack.truncate(stack.len() - pops);
    if pushes == 0 {
        return Ok(());
    }

    let instr = emitted
        .map(|(instr, _)| instr)
        .context("missing emitted instruction for stack-effect update")?;
    let local = local_func(module, func_id)?;
    match instr {
        Instr::Call(Call { func }) => {
            let sig = module.types.get(module.funcs.get(*func).ty());
            stack.extend(sig.results().iter().copied().map(Some));
        }
        Instr::CallIndirect(CallIndirect { ty, .. }) => {
            let sig = module.types.get(*ty);
            stack.extend(sig.results().iter().map(|_| None));
        }
        Instr::CallRef(call) => {
            let sig = module.types.get(call.ty);
            stack.extend(sig.results().iter().map(|_| None));
        }
        Instr::Block(Block { seq })
        | Instr::Loop(Loop { seq })
        | Instr::TryTable(TryTable { seq, .. })
        | Instr::Try(walrus::ir::Try { seq, .. }) => {
            push_structured_results(stack, module, local, *seq, pushes);
        }
        Instr::IfElse(IfElse { consequent, .. }) => {
            push_structured_results(stack, module, local, *consequent, pushes);
        }
        _ => {
            debug_assert_eq!(pushes, 1, "multi-push non-call should not appear");
            stack.push(typed_single_push(module, instr, &pre_stack));
        }
    }
    Ok(())
}

fn seq_contains_call(local: &LocalFunction, seq: InstrSeqId) -> bool {
    for (instr, _) in &local.block(seq).instrs {
        if matches!(
            instr,
            Instr::Call(_)
                | Instr::CallIndirect(_)
                | Instr::CallRef(_)
                | Instr::ReturnCall(_)
                | Instr::ReturnCallIndirect(_)
                | Instr::ReturnCallRef(_)
        ) {
            return true;
        }
        if nested_seqs(instr)
            .into_iter()
            .any(|child| seq_contains_call(local, child))
        {
            return true;
        }
    }
    false
}

enum StackEffect {
    Delta { pops: usize, pushes: usize },
    Terminator,
    Unknown,
}

fn stack_effect(module: &Module, local: &LocalFunction, instr: &Instr) -> StackEffect {
    use StackEffect::{Delta, Terminator, Unknown};

    let block_params_results = |seq_id: InstrSeqId| -> (usize, usize) {
        match local.block(seq_id).ty {
            InstrSeqType::Simple(None) => (0, 0),
            InstrSeqType::Simple(Some(_)) => (0, 1),
            InstrSeqType::MultiValue(ty_id) => {
                let ty = module.types.get(ty_id);
                (ty.params().len(), ty.results().len())
            }
        }
    };

    match instr {
        Instr::Const(_)
        | Instr::LocalGet(_)
        | Instr::GlobalGet(_)
        | Instr::MemorySize(_)
        | Instr::TableSize(_)
        | Instr::RefNull(_)
        | Instr::RefFunc(_) => Delta { pops: 0, pushes: 1 },

        Instr::LocalSet(_) | Instr::GlobalSet(_) | Instr::Drop(_) => Delta { pops: 1, pushes: 0 },

        Instr::LocalTee(_)
        | Instr::Unop(_)
        | Instr::Load(_)
        | Instr::LoadSimd(_)
        | Instr::MemoryGrow(_)
        | Instr::TableGet(_)
        | Instr::RefIsNull(_)
        | Instr::RefAsNonNull(_)
        | Instr::RefI31(_)
        | Instr::I31GetS(_)
        | Instr::I31GetU(_)
        | Instr::RefTest(_)
        | Instr::RefCast(_)
        | Instr::AnyConvertExtern(_)
        | Instr::ExternConvertAny(_) => Delta { pops: 1, pushes: 1 },

        Instr::Store(_) | Instr::TableSet(_) => Delta { pops: 2, pushes: 0 },

        Instr::Binop(_)
        | Instr::RefEq(_)
        | Instr::TableGrow(_)
        | Instr::AtomicRmw(_)
        | Instr::AtomicNotify(_)
        | Instr::I8x16Swizzle { .. }
        | Instr::I8x16Shuffle { .. } => Delta { pops: 2, pushes: 1 },

        Instr::MemoryFill(_)
        | Instr::MemoryCopy(_)
        | Instr::MemoryInit(_)
        | Instr::TableFill(_)
        | Instr::TableInit(_)
        | Instr::TableCopy(_) => Delta { pops: 3, pushes: 0 },

        Instr::TernOp(_)
        | Instr::Select(_)
        | Instr::Cmpxchg(_)
        | Instr::AtomicWait(_)
        | Instr::V128Bitselect { .. } => Delta { pops: 3, pushes: 1 },

        Instr::DataDrop(_) | Instr::ElemDrop(_) | Instr::AtomicFence(_) => {
            Delta { pops: 0, pushes: 0 }
        }

        Instr::I64Add128 { .. }
        | Instr::I64Sub128 { .. }
        | Instr::I64MulWideS { .. }
        | Instr::I64MulWideU { .. } => Delta { pops: 4, pushes: 2 },

        Instr::BrIf(_) => Delta { pops: 1, pushes: 0 },
        Instr::BrOnNull(_)
        | Instr::BrOnNonNull(_)
        | Instr::BrOnCast(_)
        | Instr::BrOnCastFail(_) => Delta { pops: 1, pushes: 1 },

        Instr::Block(Block { seq }) => {
            let (pops, pushes) = block_params_results(*seq);
            Delta { pops, pushes }
        }
        Instr::Loop(Loop { seq }) => {
            let (pops, pushes) = block_params_results(*seq);
            Delta { pops, pushes }
        }
        Instr::IfElse(IfElse { consequent, .. }) => {
            let (pops, pushes) = block_params_results(*consequent);
            Delta {
                pops: pops + 1,
                pushes,
            }
        }
        Instr::TryTable(TryTable { seq, .. }) | Instr::Try(walrus::ir::Try { seq, .. }) => {
            let (pops, pushes) = block_params_results(*seq);
            Delta { pops, pushes }
        }

        Instr::Call(Call { func }) => {
            let sig = module.types.get(module.funcs.get(*func).ty());
            Delta {
                pops: sig.params().len(),
                pushes: sig.results().len(),
            }
        }
        Instr::CallIndirect(CallIndirect { ty, .. }) => {
            let sig = module.types.get(*ty);
            Delta {
                pops: sig.params().len() + 1,
                pushes: sig.results().len(),
            }
        }
        Instr::CallRef(call) => {
            let sig = module.types.get(call.ty);
            Delta {
                pops: sig.params().len() + 1,
                pushes: sig.results().len(),
            }
        }

        Instr::Return(_)
        | Instr::Unreachable(_)
        | Instr::Br(_)
        | Instr::BrTable(_)
        | Instr::ReturnCall(_)
        | Instr::ReturnCallIndirect(_)
        | Instr::ReturnCallRef(_)
        | Instr::Throw(_)
        | Instr::ThrowRef(_)
        | Instr::Rethrow(_) => Terminator,

        Instr::StructNew(_)
        | Instr::StructNewDefault(_)
        | Instr::StructGet(_)
        | Instr::StructGetS(_)
        | Instr::StructGetU(_)
        | Instr::StructSet(_)
        | Instr::ArrayNew(_)
        | Instr::ArrayNewDefault(_)
        | Instr::ArrayNewFixed(_)
        | Instr::ArrayNewData(_)
        | Instr::ArrayNewElem(_)
        | Instr::ArrayGet(_)
        | Instr::ArrayGetS(_)
        | Instr::ArrayGetU(_)
        | Instr::ArraySet(_)
        | Instr::ArrayLen(_)
        | Instr::ArrayFill(_)
        | Instr::ArrayCopy(_)
        | Instr::ArrayInitData(_)
        | Instr::ArrayInitElem(_) => Unknown,
    }
}

fn push_structured_results(
    stack: &mut Vec<Option<ValType>>,
    module: &Module,
    local: &LocalFunction,
    seq: InstrSeqId,
    fallback_pushes: usize,
) {
    match seq_scalar_result_types(module, local, seq) {
        Some(results) => stack.extend(results.into_iter().map(Some)),
        None => {
            for _ in 0..fallback_pushes {
                stack.push(None);
            }
        }
    }
}

fn seq_scalar_result_types(
    module: &Module,
    local: &LocalFunction,
    seq: InstrSeqId,
) -> Option<Vec<ValType>> {
    match local.block(seq).ty {
        InstrSeqType::Simple(None) => Some(Vec::new()),
        InstrSeqType::Simple(Some(ty)) if is_scalar(ty) => Some(vec![ty]),
        InstrSeqType::Simple(Some(_)) => None,
        InstrSeqType::MultiValue(ty_id) => {
            let results = module.types.get(ty_id).results();
            results
                .iter()
                .all(|&ty| is_scalar(ty))
                .then(|| results.to_vec())
        }
    }
}

fn typed_single_push(
    module: &Module,
    instr: &Instr,
    pre_stack: &[Option<ValType>],
) -> Option<ValType> {
    match instr {
        Instr::Const(Const { value }) => Some(value_ty(value)),
        Instr::LocalGet(LocalGet { local }) | Instr::LocalTee(LocalTee { local }) => {
            Some(module.locals.get(*local).ty())
        }
        Instr::GlobalGet(GlobalGet { global }) => Some(module.globals.get(*global).ty),
        Instr::Load(load) => Some(load_pushes(&load.kind)),
        Instr::LoadSimd(_) => Some(ValType::V128),
        Instr::Binop(Binop { op }) => Some(binop_pushes(op)),
        Instr::Unop(unop) => Some(unop_pushes(&unop.op)),
        Instr::Select(select) => select_pushes(select.ty, pre_stack),
        Instr::TernOp(_) | Instr::V128Bitselect { .. } => Some(ValType::V128),
        Instr::AtomicRmw(rmw) => Some(atomic_width_pushes(rmw.width)),
        Instr::Cmpxchg(cmpxchg) => Some(atomic_width_pushes(cmpxchg.width)),
        Instr::AtomicNotify(_) | Instr::AtomicWait(_) => Some(ValType::I32),
        Instr::MemorySize(_)
        | Instr::MemoryGrow(_)
        | Instr::TableSize(_)
        | Instr::TableGrow(_)
        | Instr::RefIsNull(_)
        | Instr::RefEq(_)
        | Instr::I31GetS(_)
        | Instr::I31GetU(_) => Some(ValType::I32),
        Instr::I8x16Swizzle { .. } | Instr::I8x16Shuffle { .. } => Some(ValType::V128),
        _ => None,
    }
}

fn select_pushes(explicit: Option<ValType>, pre_stack: &[Option<ValType>]) -> Option<ValType> {
    if let Some(ty) = explicit {
        return is_scalar(ty).then_some(ty);
    }
    if pre_stack.len() < 3 {
        return None;
    }
    let lhs = pre_stack[pre_stack.len() - 3];
    let rhs = pre_stack[pre_stack.len() - 2];
    match (lhs, rhs) {
        (Some(a), Some(b)) if a == b && is_scalar(a) => Some(a),
        (Some(a), None) if is_scalar(a) => Some(a),
        (None, Some(b)) if is_scalar(b) => Some(b),
        _ => None,
    }
}

fn load_pushes(kind: &LoadKind) -> ValType {
    match kind {
        LoadKind::I32 { .. } | LoadKind::I32_8 { .. } | LoadKind::I32_16 { .. } => ValType::I32,
        LoadKind::I64 { .. }
        | LoadKind::I64_8 { .. }
        | LoadKind::I64_16 { .. }
        | LoadKind::I64_32 { .. } => ValType::I64,
        LoadKind::F32 => ValType::F32,
        LoadKind::F64 => ValType::F64,
        LoadKind::V128 => ValType::V128,
    }
}

fn binop_pushes(op: &BinaryOp) -> ValType {
    match op {
        BinaryOp::I32Eq
        | BinaryOp::I32Ne
        | BinaryOp::I32LtS
        | BinaryOp::I32LtU
        | BinaryOp::I32GtS
        | BinaryOp::I32GtU
        | BinaryOp::I32LeS
        | BinaryOp::I32LeU
        | BinaryOp::I32GeS
        | BinaryOp::I32GeU
        | BinaryOp::I64Eq
        | BinaryOp::I64Ne
        | BinaryOp::I64LtS
        | BinaryOp::I64LtU
        | BinaryOp::I64GtS
        | BinaryOp::I64GtU
        | BinaryOp::I64LeS
        | BinaryOp::I64LeU
        | BinaryOp::I64GeS
        | BinaryOp::I64GeU
        | BinaryOp::F32Eq
        | BinaryOp::F32Ne
        | BinaryOp::F32Lt
        | BinaryOp::F32Gt
        | BinaryOp::F32Le
        | BinaryOp::F32Ge
        | BinaryOp::F64Eq
        | BinaryOp::F64Ne
        | BinaryOp::F64Lt
        | BinaryOp::F64Gt
        | BinaryOp::F64Le
        | BinaryOp::F64Ge => ValType::I32,

        BinaryOp::I32Add
        | BinaryOp::I32Sub
        | BinaryOp::I32Mul
        | BinaryOp::I32DivS
        | BinaryOp::I32DivU
        | BinaryOp::I32RemS
        | BinaryOp::I32RemU
        | BinaryOp::I32And
        | BinaryOp::I32Or
        | BinaryOp::I32Xor
        | BinaryOp::I32Shl
        | BinaryOp::I32ShrS
        | BinaryOp::I32ShrU
        | BinaryOp::I32Rotl
        | BinaryOp::I32Rotr => ValType::I32,

        BinaryOp::I64Add
        | BinaryOp::I64Sub
        | BinaryOp::I64Mul
        | BinaryOp::I64DivS
        | BinaryOp::I64DivU
        | BinaryOp::I64RemS
        | BinaryOp::I64RemU
        | BinaryOp::I64And
        | BinaryOp::I64Or
        | BinaryOp::I64Xor
        | BinaryOp::I64Shl
        | BinaryOp::I64ShrS
        | BinaryOp::I64ShrU
        | BinaryOp::I64Rotl
        | BinaryOp::I64Rotr => ValType::I64,

        BinaryOp::F32Add
        | BinaryOp::F32Sub
        | BinaryOp::F32Mul
        | BinaryOp::F32Div
        | BinaryOp::F32Min
        | BinaryOp::F32Max
        | BinaryOp::F32Copysign => ValType::F32,

        BinaryOp::F64Add
        | BinaryOp::F64Sub
        | BinaryOp::F64Mul
        | BinaryOp::F64Div
        | BinaryOp::F64Min
        | BinaryOp::F64Max
        | BinaryOp::F64Copysign => ValType::F64,

        _ => ValType::V128,
    }
}

fn unop_pushes(op: &UnaryOp) -> ValType {
    let name = format!("{op:?}");
    if name.starts_with("I32") || name == "I64Eqz" {
        ValType::I32
    } else if name.starts_with("I64") {
        ValType::I64
    } else if name.starts_with("F32") {
        ValType::F32
    } else if name.starts_with("F64") {
        ValType::F64
    } else if name.starts_with("I8x16ExtractLane")
        || name.starts_with("I16x8ExtractLane")
        || name.starts_with("I32x4ExtractLane")
        || name.contains("AnyTrue")
        || name.contains("AllTrue")
        || name.contains("Bitmask")
    {
        ValType::I32
    } else if name.starts_with("I64x2ExtractLane") {
        ValType::I64
    } else if name.starts_with("F32x4ExtractLane") {
        ValType::F32
    } else if name.starts_with("F64x2ExtractLane") {
        ValType::F64
    } else {
        ValType::V128
    }
}

fn atomic_width_pushes(width: AtomicWidth) -> ValType {
    match width {
        AtomicWidth::I64 | AtomicWidth::I64_8 | AtomicWidth::I64_16 | AtomicWidth::I64_32 => {
            ValType::I64
        }
        AtomicWidth::I32 | AtomicWidth::I32_8 | AtomicWidth::I32_16 => ValType::I32,
    }
}

fn is_scalar(ty: ValType) -> bool {
    !matches!(ty, ValType::Ref(_))
}

fn emit_reserve(
    out: &mut Vec<(Instr, InstrLocId)>,
    stack_pointer: GlobalId,
    spill_base: LocalId,
    frame_size: u32,
) {
    push(
        out,
        Instr::GlobalGet(GlobalGet {
            global: stack_pointer,
        }),
        loc(),
    );
    push(out, i32_const(frame_size as i32), loc());
    push(
        out,
        Instr::Binop(Binop {
            op: BinaryOp::I32Sub,
        }),
        loc(),
    );
    push(out, Instr::LocalTee(LocalTee { local: spill_base }), loc());
    push(
        out,
        Instr::GlobalSet(GlobalSet {
            global: stack_pointer,
        }),
        loc(),
    );
}

fn emit_restore(
    out: &mut Vec<(Instr, InstrLocId)>,
    stack_pointer: GlobalId,
    spill_base: LocalId,
    frame_size: u32,
) {
    push(out, Instr::LocalGet(LocalGet { local: spill_base }), loc());
    push(out, i32_const(frame_size as i32), loc());
    push(
        out,
        Instr::Binop(Binop {
            op: BinaryOp::I32Add,
        }),
        loc(),
    );
    push(
        out,
        Instr::GlobalSet(GlobalSet {
            global: stack_pointer,
        }),
        loc(),
    );
}

fn emit_seed_slot(
    out: &mut Vec<(Instr, InstrLocId)>,
    memory: MemoryId,
    base: LocalId,
    slot: &SpillSlot,
) {
    push(out, Instr::LocalGet(LocalGet { local: base }), loc());
    if slot.is_arg {
        push(out, Instr::LocalGet(LocalGet { local: slot.local }), loc());
    } else {
        push(out, i32_const(0), loc());
    }
    push(out, store_i32(memory, slot.offset), loc());
}

fn emit_store_local(
    out: &mut Vec<(Instr, InstrLocId)>,
    memory: MemoryId,
    base: LocalId,
    local: LocalId,
    offset: u64,
) {
    push(out, Instr::LocalGet(LocalGet { local: base }), loc());
    push(out, Instr::LocalGet(LocalGet { local }), loc());
    push(out, store_i32(memory, offset), loc());
}

fn find_stack_pointer(module: &Module) -> Result<GlobalId> {
    let from_export = module.exports.iter().find_map(|export| match export.item {
        ExportItem::Global(id) if export.name == "__stack_pointer" => Some(id),
        _ => None,
    });
    let id = from_export.or_else(|| {
        module
            .globals
            .iter()
            .find(|global| global.name.as_deref() == Some("__stack_pointer"))
            .map(|global| global.id())
    });
    let id = id.context("mutable i32 `__stack_pointer` global not found")?;
    let global = module.globals.get(id);
    ensure!(
        global.ty == ValType::I32 && global.mutable,
        "`__stack_pointer` must be a mutable i32 global"
    );
    Ok(id)
}

fn find_wasm32_memory(module: &Module) -> Result<MemoryId> {
    let mut memories = module.memories.iter();
    let memory = memories
        .next()
        .context("module has no linear memory for local-root spill slots")?;
    ensure!(
        !memory.memory64,
        "memory64 modules are not supported by Stage 1 local-root spill"
    );
    Ok(memory.id())
}

fn local_func(module: &Module, func_id: FunctionId) -> Result<&LocalFunction> {
    match &module.funcs.get(func_id).kind {
        FunctionKind::Local(local) => Ok(local),
        _ => bail!("function is not local"),
    }
}

fn local_func_mut(module: &mut Module, func_id: FunctionId) -> Result<&mut LocalFunction> {
    match &mut module.funcs.get_mut(func_id).kind {
        FunctionKind::Local(local) => Ok(local),
        _ => bail!("function is not local"),
    }
}

fn nested_seqs(instr: &Instr) -> Vec<InstrSeqId> {
    match instr {
        Instr::Block(Block { seq }) => vec![*seq],
        Instr::Loop(Loop { seq }) => vec![*seq],
        Instr::IfElse(IfElse {
            consequent,
            alternative,
        }) => vec![*consequent, *alternative],
        Instr::TryTable(TryTable { seq, .. }) => vec![*seq],
        _ => Vec::new(),
    }
}

fn function_name(module: &Module, id: FunctionId) -> String {
    module
        .funcs
        .get(id)
        .name
        .clone()
        .unwrap_or_else(|| format!("{id:?}"))
}

fn value_ty(value: &Value) -> ValType {
    match value {
        Value::I32(_) => ValType::I32,
        Value::I64(_) => ValType::I64,
        Value::F32(_) => ValType::F32,
        Value::F64(_) => ValType::F64,
        Value::V128(_) => ValType::V128,
    }
}

fn i32_const(value: i32) -> Instr {
    Instr::Const(Const {
        value: Value::I32(value),
    })
}

fn store_i32(memory: MemoryId, offset: u64) -> Instr {
    Instr::Store(walrus::ir::Store {
        memory,
        kind: StoreKind::I32 { atomic: false },
        arg: MemArg { align: 4, offset },
    })
}

fn align_up(value: u32, align: u32) -> u32 {
    debug_assert!(align.is_power_of_two());
    (value + align - 1) & !(align - 1)
}

fn push(out: &mut Vec<(Instr, InstrLocId)>, instr: Instr, loc: InstrLocId) {
    out.push((instr, loc));
}

fn loc() -> InstrLocId {
    InstrLocId::default()
}

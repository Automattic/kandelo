//! Legacy exception-handler normalization for fork-reachable functions.
//!
//! A legacy `catch` enters an implicit engine-owned exception context. That
//! context is exactly the state a continuation cannot recover in a fresh Wasm
//! instance. This pass converts legacy handlers to modern `try_table`
//! `catch_ref`/`catch_all_ref` clauses before continuation planning. The caught
//! exception is held in an ordinary activation local, so the reference recipe
//! analysis gives it the same linked-frame ownership as every other live
//! reference.
//!
//! Legacy `delegate` has no handler activation and therefore needs no
//! conversion. Keeping it native also preserves its relative-depth semantics
//! without inventing an exception round trip.

use anyhow::{Result, bail, ensure};
use std::collections::{BTreeMap, HashMap, HashSet};
use walrus::{
    AbstractHeapType, FunctionId, FunctionKind, HeapType, LocalFunction, LocalId, Module, RefType,
    ValType,
    ir::{
        Block, Br, Instr, InstrLocId, InstrSeqId, InstrSeqType, LegacyCatch, LocalGet, LocalSet,
        RefAsNonNull, RefNull, ThrowRef, Try, TryTable, TryTableCatch,
    },
};

#[derive(Clone)]
struct HandlerMeta {
    root: InstrSeqId,
    exception: LocalId,
    /// Outer-to-inner legacy handlers active while this handler executes.
    ancestors: Vec<InstrSeqId>,
}

#[derive(Clone)]
struct ExitShim {
    seq: InstrSeqId,
    target: InstrSeqId,
    clear: Vec<LocalId>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LabelKind {
    Loop,
    Other,
}

#[derive(Clone, Copy)]
struct TrySite {
    body: InstrSeqId,
    depth: u32,
}

#[derive(Clone)]
struct RethrowRewrite {
    seq: InstrSeqId,
    index: usize,
    loc: InstrLocId,
    exception: LocalId,
    clear: Vec<LocalId>,
}

const NULLABLE_EXNREF: RefType = RefType {
    nullable: true,
    heap_type: HeapType::Abstract(AbstractHeapType::Exn),
};

const NON_NULL_EXNREF: RefType = RefType {
    nullable: false,
    heap_type: HeapType::Abstract(AbstractHeapType::Exn),
};

/// Normalize legacy handlers only in functions that can own a fork
/// continuation. References and legacy EH outside the fork closure remain
/// byte-for-byte under Walrus's normal re-emission.
pub fn normalize_fork_path(module: &mut Module, fork_path: &HashSet<FunctionId>) -> Result<()> {
    let mut functions: Vec<_> = fork_path.iter().copied().collect();
    functions.sort();
    for function in functions {
        if !matches!(module.funcs.get(function).kind, FunctionKind::Local(_)) {
            continue;
        }
        normalize_function(module, function)?;
    }
    Ok(())
}

fn normalize_function(module: &mut Module, function: FunctionId) -> Result<()> {
    let (entry, handler_layout, label_kinds, try_sites) = {
        let local = local(module, function);
        let entry = local.entry_block();
        let mut handlers = Vec::new();
        let mut labels = HashMap::from([(entry, LabelKind::Other)]);
        let mut tries = Vec::new();
        collect_structure(local, entry, 0, &[], &mut handlers, &mut labels, &mut tries);
        (entry, handlers, labels, tries)
    };

    if handler_layout.is_empty() {
        return Ok(());
    }

    let mut handlers = HashMap::new();
    for (root, ancestors) in handler_layout {
        let exception = module.locals.add(ValType::Ref(NULLABLE_EXNREF));
        handlers.insert(
            root,
            HandlerMeta {
                root,
                exception,
                ancestors,
            },
        );
    }

    rewrite_rethrows(module, function, entry, &handlers)?;

    let full_subtrees: HashMap<InstrSeqId, HashSet<InstrSeqId>> = handlers
        .keys()
        .copied()
        .map(|root| {
            let mut subtree = HashSet::new();
            collect_subtree(local(module, function), root, &mut subtree);
            (root, subtree)
        })
        .collect();

    // Allocate every branch-cleanup label before lowering changes ancestry.
    // All branch opcodes, including br_table and br_on_*, can then be retargeted
    // without lowering them into slower instruction sequences.
    let mut handler_shims: HashMap<InstrSeqId, Vec<ExitShim>> = HashMap::new();
    let handler_roots: HashSet<_> = handlers.keys().copied().collect();
    let mut ordered_handlers: Vec<_> = handlers.values().cloned().collect();
    ordered_handlers.sort_by_key(|handler| handler.root);
    for handler in ordered_handlers {
        let direct_subtree =
            collect_direct_handler_subtree(local(module, function), handler.root, &handler_roots);
        let mut targets = BTreeMap::<InstrSeqId, Vec<LocalId>>::new();
        collect_exit_targets(
            local(module, function),
            handler.root,
            &direct_subtree,
            &handler,
            &handlers,
            &full_subtrees,
            &mut targets,
        );

        let mut shims = Vec::new();
        let (handler_params, _) =
            params_results(module, local(module, function).block(handler.root).ty);
        for (target, clear) in targets {
            let branch_values = branch_value_types(module, function, target, &label_kinds)?;
            // The normal catch-entry path carries the legacy tag payload
            // through every enclosing cleanup shim. A branch to a shim label
            // supplies only its result tuple, so these params do not alter the
            // retargeted branch signature.
            let ty = InstrSeqType::new(&mut module.types, &handler_params, &branch_values);
            let seq = local_mut(module, function)
                .builder_mut()
                .dangling_instr_seq(ty)
                .id();
            shims.push(ExitShim { seq, target, clear });
        }
        let replacements: HashMap<_, _> =
            shims.iter().map(|shim| (shim.target, shim.seq)).collect();
        retarget_handler_exits(
            local_mut(module, function),
            handler.root,
            &direct_subtree,
            &replacements,
        );
        handler_shims.insert(handler.root, shims);
    }

    let mut sites = try_sites;
    sites.sort_by_key(|site| std::cmp::Reverse(site.depth));
    for site in sites {
        lower_try(
            module,
            function,
            entry,
            site.body,
            &handlers,
            &handler_shims,
        )?;
    }

    Ok(())
}

fn collect_structure(
    local: &LocalFunction,
    seq: InstrSeqId,
    depth: u32,
    active_handlers: &[InstrSeqId],
    handlers: &mut Vec<(InstrSeqId, Vec<InstrSeqId>)>,
    labels: &mut HashMap<InstrSeqId, LabelKind>,
    tries: &mut Vec<TrySite>,
) {
    for (instr, _) in &local.block(seq).instrs {
        match instr {
            Instr::Block(block) => {
                labels.insert(block.seq, LabelKind::Other);
                collect_structure(
                    local,
                    block.seq,
                    depth + 1,
                    active_handlers,
                    handlers,
                    labels,
                    tries,
                );
            }
            Instr::Loop(loop_) => {
                labels.insert(loop_.seq, LabelKind::Loop);
                collect_structure(
                    local,
                    loop_.seq,
                    depth + 1,
                    active_handlers,
                    handlers,
                    labels,
                    tries,
                );
            }
            Instr::IfElse(if_) => {
                for child in [if_.consequent, if_.alternative] {
                    labels.insert(child, LabelKind::Other);
                    collect_structure(
                        local,
                        child,
                        depth + 1,
                        active_handlers,
                        handlers,
                        labels,
                        tries,
                    );
                }
            }
            Instr::TryTable(table) => {
                labels.insert(table.seq, LabelKind::Other);
                collect_structure(
                    local,
                    table.seq,
                    depth + 1,
                    active_handlers,
                    handlers,
                    labels,
                    tries,
                );
            }
            Instr::Try(try_) => {
                labels.insert(try_.seq, LabelKind::Other);
                collect_structure(
                    local,
                    try_.seq,
                    depth + 1,
                    active_handlers,
                    handlers,
                    labels,
                    tries,
                );
                if try_
                    .catches
                    .iter()
                    .any(|catch| !matches!(catch, LegacyCatch::Delegate { .. }))
                {
                    tries.push(TrySite {
                        body: try_.seq,
                        depth,
                    });
                }
                for catch in &try_.catches {
                    let handler = match catch {
                        LegacyCatch::Catch { handler, .. } | LegacyCatch::CatchAll { handler } => {
                            *handler
                        }
                        LegacyCatch::Delegate { .. } => continue,
                    };
                    labels.insert(handler, LabelKind::Other);
                    handlers.push((handler, active_handlers.to_vec()));
                    let mut nested = active_handlers.to_vec();
                    nested.push(handler);
                    collect_structure(local, handler, depth + 1, &nested, handlers, labels, tries);
                }
            }
            _ => {}
        }
    }
}

fn rewrite_rethrows(
    module: &mut Module,
    function: FunctionId,
    entry: InstrSeqId,
    handlers: &HashMap<InstrSeqId, HandlerMeta>,
) -> Result<()> {
    let rewrites = {
        let mut rewrites = Vec::new();
        collect_rethrows(
            local(module, function),
            entry,
            &mut vec![(entry, None)],
            handlers,
            &mut rewrites,
        )?;
        rewrites
    };

    let mut by_seq = BTreeMap::<InstrSeqId, Vec<RethrowRewrite>>::new();
    for rewrite in rewrites {
        by_seq.entry(rewrite.seq).or_default().push(rewrite);
    }
    for (seq, mut rewrites) in by_seq {
        rewrites.sort_by_key(|rewrite| std::cmp::Reverse(rewrite.index));
        let instrs = &mut local_mut(module, function).block_mut(seq).instrs;
        for rewrite in rewrites {
            let mut replacement = Vec::new();
            replacement.push((
                Instr::LocalGet(LocalGet {
                    local: rewrite.exception,
                }),
                rewrite.loc,
            ));
            replacement.push((Instr::RefAsNonNull(RefAsNonNull {}), rewrite.loc));
            for local in rewrite.clear {
                replacement.push((
                    Instr::RefNull(RefNull {
                        ty: NULLABLE_EXNREF,
                    }),
                    rewrite.loc,
                ));
                replacement.push((Instr::LocalSet(LocalSet { local }), rewrite.loc));
            }
            replacement.push((Instr::ThrowRef(ThrowRef {}), rewrite.loc));
            instrs.splice(rewrite.index..=rewrite.index, replacement);
        }
    }
    Ok(())
}

fn collect_rethrows(
    local: &LocalFunction,
    seq: InstrSeqId,
    stack: &mut Vec<(InstrSeqId, Option<LocalId>)>,
    handlers: &HashMap<InstrSeqId, HandlerMeta>,
    out: &mut Vec<RethrowRewrite>,
) -> Result<()> {
    for (index, (instr, loc)) in local.block(seq).instrs.iter().enumerate() {
        if let Instr::Rethrow(rethrow) = instr {
            let depth = rethrow.relative_depth as usize;
            ensure!(
                depth < stack.len(),
                "fork-instrument: legacy rethrow depth {} exceeds control depth {}",
                depth,
                stack.len(),
            );
            let target_index = stack.len() - 1 - depth;
            let Some(exception) = stack[target_index].1 else {
                bail!(
                    "fork-instrument: legacy rethrow depth {} does not target a catch handler",
                    depth,
                );
            };
            let mut clear = Vec::new();
            for (_, local) in stack[target_index..].iter().rev() {
                if let Some(local) = local
                    && !clear.contains(local)
                {
                    clear.push(*local);
                }
            }
            out.push(RethrowRewrite {
                seq,
                index,
                loc: *loc,
                exception,
                clear,
            });
        }

        match instr {
            Instr::Block(block) => {
                collect_rethrows_child(local, block.seq, None, stack, handlers, out)?
            }
            Instr::Loop(loop_) => {
                collect_rethrows_child(local, loop_.seq, None, stack, handlers, out)?
            }
            Instr::IfElse(if_) => {
                collect_rethrows_child(local, if_.consequent, None, stack, handlers, out)?;
                collect_rethrows_child(local, if_.alternative, None, stack, handlers, out)?;
            }
            Instr::TryTable(table) => {
                collect_rethrows_child(local, table.seq, None, stack, handlers, out)?
            }
            Instr::Try(try_) => {
                collect_rethrows_child(local, try_.seq, None, stack, handlers, out)?;
                for catch in &try_.catches {
                    let handler = match catch {
                        LegacyCatch::Catch { handler, .. } | LegacyCatch::CatchAll { handler } => {
                            *handler
                        }
                        LegacyCatch::Delegate { .. } => continue,
                    };
                    collect_rethrows_child(
                        local,
                        handler,
                        Some(handlers[&handler].exception),
                        stack,
                        handlers,
                        out,
                    )?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn collect_rethrows_child(
    local: &LocalFunction,
    child: InstrSeqId,
    handler: Option<LocalId>,
    stack: &mut Vec<(InstrSeqId, Option<LocalId>)>,
    handlers: &HashMap<InstrSeqId, HandlerMeta>,
    out: &mut Vec<RethrowRewrite>,
) -> Result<()> {
    stack.push((child, handler));
    collect_rethrows(local, child, stack, handlers, out)?;
    stack.pop();
    Ok(())
}

fn collect_subtree(local: &LocalFunction, seq: InstrSeqId, out: &mut HashSet<InstrSeqId>) {
    if !out.insert(seq) {
        return;
    }
    for (instr, _) in &local.block(seq).instrs {
        for child in children(instr) {
            collect_subtree(local, child, out);
        }
    }
}

fn collect_direct_handler_subtree(
    local: &LocalFunction,
    root: InstrSeqId,
    handler_roots: &HashSet<InstrSeqId>,
) -> HashSet<InstrSeqId> {
    fn visit(
        local: &LocalFunction,
        root: InstrSeqId,
        seq: InstrSeqId,
        handler_roots: &HashSet<InstrSeqId>,
        out: &mut HashSet<InstrSeqId>,
    ) {
        if seq != root && handler_roots.contains(&seq) {
            return;
        }
        if !out.insert(seq) {
            return;
        }
        for (instr, _) in &local.block(seq).instrs {
            for child in children(instr) {
                visit(local, root, child, handler_roots, out);
            }
        }
    }

    let mut out = HashSet::new();
    visit(local, root, root, handler_roots, &mut out);
    out
}

fn collect_exit_targets(
    local: &LocalFunction,
    seq: InstrSeqId,
    direct_subtree: &HashSet<InstrSeqId>,
    current: &HandlerMeta,
    handlers: &HashMap<InstrSeqId, HandlerMeta>,
    full_subtrees: &HashMap<InstrSeqId, HashSet<InstrSeqId>>,
    out: &mut BTreeMap<InstrSeqId, Vec<LocalId>>,
) {
    for (instr, _) in &local.block(seq).instrs {
        for target in branch_targets(instr) {
            if target != current.root && full_subtrees[&current.root].contains(&target) {
                continue;
            }
            let mut clear = Vec::new();
            for root in current
                .ancestors
                .iter()
                .copied()
                .chain(std::iter::once(current.root))
                .rev()
            {
                if target == root || !full_subtrees[&root].contains(&target) {
                    clear.push(handlers[&root].exception);
                }
            }
            out.entry(target).or_insert(clear);
        }
        for child in children(instr) {
            if direct_subtree.contains(&child) {
                collect_exit_targets(
                    local,
                    child,
                    direct_subtree,
                    current,
                    handlers,
                    full_subtrees,
                    out,
                );
            }
        }
    }
}

fn retarget_handler_exits(
    local: &mut LocalFunction,
    seq: InstrSeqId,
    direct_subtree: &HashSet<InstrSeqId>,
    replacements: &HashMap<InstrSeqId, InstrSeqId>,
) {
    let children_to_visit: Vec<_> = local
        .block(seq)
        .instrs
        .iter()
        .flat_map(|(instr, _)| children(instr))
        .filter(|child| direct_subtree.contains(child))
        .collect();
    for (instr, _) in &mut local.block_mut(seq).instrs {
        replace_branch_targets(instr, replacements);
    }
    for child in children_to_visit {
        retarget_handler_exits(local, child, direct_subtree, replacements);
    }
}

fn lower_try(
    module: &mut Module,
    function: FunctionId,
    entry: InstrSeqId,
    body: InstrSeqId,
    handlers: &HashMap<InstrSeqId, HandlerMeta>,
    handler_shims: &HashMap<InstrSeqId, Vec<ExitShim>>,
) -> Result<()> {
    let Some((parent, index, loc, try_)) = find_try(local(module, function), entry, body) else {
        return Ok(());
    };
    if try_
        .catches
        .iter()
        .all(|catch| matches!(catch, LegacyCatch::Delegate { .. }))
    {
        return Ok(());
    }
    ensure!(
        try_.catches
            .iter()
            .all(|catch| !matches!(catch, LegacyCatch::Delegate { .. })),
        "fork-instrument: malformed legacy try mixes delegate with catch handlers",
    );

    let body_ty = local(module, function).block(body).ty;
    let (try_params, _) = params_results(module, body_ty);
    let outer = local_mut(module, function)
        .builder_mut()
        .dangling_instr_seq(body_ty)
        .id();

    let mut caps = Vec::new();
    let mut modern_catches = Vec::new();
    let mut catch_handlers = Vec::new();
    for catch in &try_.catches {
        let (handler, tag) = match catch {
            LegacyCatch::Catch { tag, handler } => (*handler, Some(*tag)),
            LegacyCatch::CatchAll { handler } => (*handler, None),
            LegacyCatch::Delegate { .. } => unreachable!(),
        };
        let (handler_params, _) = params_results(module, local(module, function).block(handler).ty);
        let mut catch_values = handler_params;
        catch_values.push(ValType::Ref(NON_NULL_EXNREF));
        let cap_ty = InstrSeqType::new(&mut module.types, &try_params, &catch_values);
        let cap = local_mut(module, function)
            .builder_mut()
            .dangling_instr_seq(cap_ty)
            .id();
        let modern = match tag {
            Some(tag) => TryTableCatch::CatchRef { tag, label: cap },
            None => TryTableCatch::CatchAllRef { label: cap },
        };
        caps.push(cap);
        modern_catches.push(modern);
        catch_handlers.push(handler);
    }

    let innermost = *caps.last().expect("legacy try has at least one handler");
    {
        let instrs = &mut local_mut(module, function).block_mut(innermost).instrs;
        push(
            instrs,
            Instr::TryTable(TryTable {
                seq: body,
                catches: modern_catches,
            }),
        );
        push(instrs, Instr::Br(Br { block: outer }));
    }

    for index in (0..caps.len() - 1).rev() {
        let child = caps[index + 1];
        push(
            &mut local_mut(module, function).block_mut(caps[index]).instrs,
            Instr::Block(Block { seq: child }),
        );
        emit_handler_adapter(
            module,
            function,
            caps[index],
            catch_handlers[index + 1],
            outer,
            &handlers[&catch_handlers[index + 1]],
            &handler_shims[&catch_handlers[index + 1]],
        );
    }

    push(
        &mut local_mut(module, function).block_mut(outer).instrs,
        Instr::Block(Block { seq: caps[0] }),
    );
    emit_handler_adapter(
        module,
        function,
        outer,
        catch_handlers[0],
        outer,
        &handlers[&catch_handlers[0]],
        &handler_shims[&catch_handlers[0]],
    );

    local_mut(module, function).block_mut(parent).instrs[index] =
        (Instr::Block(Block { seq: outer }), loc);
    Ok(())
}

fn emit_handler_adapter(
    module: &mut Module,
    function: FunctionId,
    container: InstrSeqId,
    handler: InstrSeqId,
    normal_target: InstrSeqId,
    meta: &HandlerMeta,
    shims: &[ExitShim],
) {
    push(
        &mut local_mut(module, function).block_mut(container).instrs,
        Instr::LocalSet(LocalSet {
            local: meta.exception,
        }),
    );

    let execution = shims.last().map(|shim| shim.seq).unwrap_or(container);
    emit_handler_execution(
        module,
        function,
        execution,
        handler,
        meta.exception,
        normal_target,
    );

    if !shims.is_empty() {
        for index in (0..shims.len() - 1).rev() {
            let child = shims[index + 1].seq;
            let parent = shims[index].seq;
            let instrs = &mut local_mut(module, function).block_mut(parent).instrs;
            instrs.insert(
                0,
                (Instr::Block(Block { seq: child }), InstrLocId::default()),
            );
            emit_clear_and_branch(instrs, &shims[index + 1]);
        }
        let instrs = &mut local_mut(module, function).block_mut(container).instrs;
        push(instrs, Instr::Block(Block { seq: shims[0].seq }));
        emit_clear_and_branch(instrs, &shims[0]);
    }
}

fn emit_handler_execution(
    module: &mut Module,
    function: FunctionId,
    container: InstrSeqId,
    handler: InstrSeqId,
    exception: LocalId,
    normal_target: InstrSeqId,
) {
    let handler_ty = local(module, function).block(handler).ty;
    let (handler_params, _) = params_results(module, handler_ty);
    let cleanup_cap_ty = InstrSeqType::new(
        &mut module.types,
        &handler_params,
        &[ValType::Ref(NON_NULL_EXNREF)],
    );
    let cleanup_cap = local_mut(module, function)
        .builder_mut()
        .dangling_instr_seq(cleanup_cap_ty)
        .id();
    {
        let instrs = &mut local_mut(module, function).block_mut(cleanup_cap).instrs;
        push(
            instrs,
            Instr::TryTable(TryTable {
                seq: handler,
                catches: vec![TryTableCatch::CatchAllRef { label: cleanup_cap }],
            }),
        );
        emit_clear(instrs, exception);
        push(
            instrs,
            Instr::Br(Br {
                block: normal_target,
            }),
        );
    }

    let instrs = &mut local_mut(module, function).block_mut(container).instrs;
    push(instrs, Instr::Block(Block { seq: cleanup_cap }));
    emit_clear(instrs, exception);
    push(instrs, Instr::ThrowRef(ThrowRef {}));
}

fn emit_clear_and_branch(instrs: &mut Vec<(Instr, InstrLocId)>, shim: &ExitShim) {
    for local in &shim.clear {
        emit_clear(instrs, *local);
    }
    push(instrs, Instr::Br(Br { block: shim.target }));
}

fn emit_clear(instrs: &mut Vec<(Instr, InstrLocId)>, local: LocalId) {
    push(
        instrs,
        Instr::RefNull(RefNull {
            ty: NULLABLE_EXNREF,
        }),
    );
    push(instrs, Instr::LocalSet(LocalSet { local }));
}

fn branch_value_types(
    module: &Module,
    function: FunctionId,
    target: InstrSeqId,
    label_kinds: &HashMap<InstrSeqId, LabelKind>,
) -> Result<Vec<ValType>> {
    let ty = local(module, function).block(target).ty;
    let (params, results) = params_results(module, ty);
    let kind = label_kinds
        .get(&target)
        .copied()
        .ok_or_else(|| anyhow::anyhow!("fork-instrument: branch target has no label kind"))?;
    Ok(if kind == LabelKind::Loop {
        params
    } else {
        results
    })
}

fn params_results(module: &Module, ty: InstrSeqType) -> (Vec<ValType>, Vec<ValType>) {
    match ty {
        InstrSeqType::Simple(None) => (Vec::new(), Vec::new()),
        InstrSeqType::Simple(Some(result)) => (Vec::new(), vec![result]),
        InstrSeqType::MultiValue(ty) => (
            module.types.get(ty).params().to_vec(),
            module.types.get(ty).results().to_vec(),
        ),
    }
}

fn find_try(
    local: &LocalFunction,
    seq: InstrSeqId,
    body: InstrSeqId,
) -> Option<(InstrSeqId, usize, InstrLocId, Try)> {
    for (index, (instr, loc)) in local.block(seq).instrs.iter().enumerate() {
        if let Instr::Try(try_) = instr
            && try_.seq == body
        {
            return Some((seq, index, *loc, try_.clone()));
        }
        for child in children(instr) {
            if let Some(site) = find_try(local, child, body) {
                return Some(site);
            }
        }
    }
    None
}

fn children(instr: &Instr) -> Vec<InstrSeqId> {
    match instr {
        Instr::Block(block) => vec![block.seq],
        Instr::Loop(loop_) => vec![loop_.seq],
        Instr::IfElse(if_) => vec![if_.consequent, if_.alternative],
        Instr::TryTable(table) => vec![table.seq],
        Instr::Try(try_) => {
            let mut children = vec![try_.seq];
            for catch in &try_.catches {
                match catch {
                    LegacyCatch::Catch { handler, .. } | LegacyCatch::CatchAll { handler } => {
                        children.push(*handler)
                    }
                    LegacyCatch::Delegate { .. } => {}
                }
            }
            children
        }
        _ => Vec::new(),
    }
}

fn branch_targets(instr: &Instr) -> Vec<InstrSeqId> {
    match instr {
        Instr::Br(branch) => vec![branch.block],
        Instr::BrIf(branch) => vec![branch.block],
        Instr::BrTable(table) => table
            .blocks
            .iter()
            .copied()
            .chain(std::iter::once(table.default))
            .collect(),
        Instr::BrOnNull(branch) => vec![branch.block],
        Instr::BrOnNonNull(branch) => vec![branch.block],
        Instr::BrOnCast(branch) => vec![branch.block],
        Instr::BrOnCastFail(branch) => vec![branch.block],
        _ => Vec::new(),
    }
}

fn replace_branch_targets(instr: &mut Instr, replacements: &HashMap<InstrSeqId, InstrSeqId>) {
    let replace = |target: &mut InstrSeqId| {
        if let Some(replacement) = replacements.get(target) {
            *target = *replacement;
        }
    };
    match instr {
        Instr::Br(branch) => replace(&mut branch.block),
        Instr::BrIf(branch) => replace(&mut branch.block),
        Instr::BrTable(table) => {
            for target in &mut table.blocks {
                replace(target);
            }
            replace(&mut table.default);
        }
        Instr::BrOnNull(branch) => replace(&mut branch.block),
        Instr::BrOnNonNull(branch) => replace(&mut branch.block),
        Instr::BrOnCast(branch) => replace(&mut branch.block),
        Instr::BrOnCastFail(branch) => replace(&mut branch.block),
        _ => {}
    }
}

fn push(instrs: &mut Vec<(Instr, InstrLocId)>, instr: Instr) {
    instrs.push((instr, InstrLocId::default()));
}

fn local(module: &Module, function: FunctionId) -> &LocalFunction {
    match &module.funcs.get(function).kind {
        FunctionKind::Local(local) => local,
        _ => unreachable!("fork-path legacy EH normalization requires a local function"),
    }
}

fn local_mut(module: &mut Module, function: FunctionId) -> &mut LocalFunction {
    match &mut module.funcs.get_mut(function).kind {
        FunctionKind::Local(local) => local,
        _ => unreachable!("fork-path legacy EH normalization requires a local function"),
    }
}

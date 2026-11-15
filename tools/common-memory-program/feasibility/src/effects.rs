//! Conservative direct-call closure for the trusted, one-Worker/process
//! prototype. This is not general alias analysis or a whole-runtime proof.
//! A write-allowing policy is reported only as an opportunity estimate: an
//! unknown ordinary-store destination could be a syscall-channel field.
use anyhow::{Result, ensure};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use wasmparser::{self as p, Operator as O, Parser, Payload};
#[derive(Clone, Copy)]
pub enum CallPolicy {
    GuestMemoryReadOnly,
    /// Opportunity counts only: missing proof that stores exclude channels.
    PublishPatternOpportunity,
}
macro_rules! operator_tags {
    ($(@$proposal:ident $op:ident $({$($arg:ident:$ty:ty),*})? => $visit:ident ($($ann:tt)*))*) => {
        fn tags(op: &O<'_>) -> (&'static str, &'static str) {
            match op { $(O::$op $({$($arg: _),*})? => (stringify!($proposal), stringify!($op)),)* _ => ("unknown", "unknown") }
        }
    }
}
p::for_each_operator!(operator_tags);
fn reserved_vm_name(name: &str) -> bool {
    // Match the actual translator namespace, not musl's legitimate __vm_*
    // synchronization exports such as __vm_wait and __vm_lock.
    matches!(
        name,
        "__vm_root" | "__vm_scratch" | "__vm_initialize" | "__vm_host_span"
    )
}
fn reason(op: &O<'_>) -> Option<&'static str> {
    match op {
        O::Call { .. } | O::ReturnCall { .. } => return None,
        // Catch structure alone cannot initiate an unwind. Actual throws,
        // including generated rethrows of fork/longjmp state, stay barriers.
        O::TryTable { .. } | O::Try { .. } | O::Catch { .. } | O::CatchAll => return None,
        O::Throw { .. } | O::ThrowRef | O::Rethrow { .. } | O::Delegate { .. } => {
            return Some("exception-unwind");
        }
        O::CallIndirect { .. }
        | O::ReturnCallIndirect { .. }
        | O::CallRef { .. }
        | O::ReturnCallRef { .. } => return Some("indirect-call"),
        O::MemoryGrow { .. } => return Some("memory-growth"),
        _ => {}
    }
    let (proposal, name) = tags(op);
    if proposal == "threads" {
        return Some("atomic-or-wait-notify");
    }
    if name.starts_with("Table") || name == "ElemDrop" {
        return Some("table-operation");
    }
    if !matches!(
        proposal,
        "mvp"
            | "sign_extension"
            | "saturating_float_to_int"
            | "bulk_memory"
            | "simd"
            | "relaxed_simd"
    ) {
        return Some("unknown-operator-or-proposal");
    }
    if name.contains("Store")
        || matches!(
            op,
            O::MemoryCopy { .. } | O::MemoryFill { .. } | O::MemoryInit { .. }
        )
    {
        return Some("guest-memory-write");
    }
    None
}
#[derive(Clone)]
struct Function {
    ty: u32,
    import: Option<String>,
    exports: Vec<String>,
    calls: BTreeSet<u32>,
    reasons: BTreeSet<&'static str>,
    direct_sites: u32,
}
pub(crate) struct CallEffects {
    functions: Vec<Function>,
    types: Vec<p::FuncType>,
    unsafe_functions: Vec<bool>,
    witnesses: Vec<Option<u32>>,
    seed_operators: BTreeMap<String, u64>,
    operator_counts: BTreeMap<String, u64>,
    pub(crate) allow_guest_writes: bool,
}
fn closure(functions: &[Function], allow_guest_writes: bool) -> (Vec<bool>, Vec<Option<u32>>) {
    let mut unsafe_functions = vec![false; functions.len()];
    let mut witnesses = vec![None; functions.len()];
    let mut reverse = vec![vec![]; functions.len()];
    let mut queue = VecDeque::new();
    for (index, function) in functions.iter().enumerate() {
        for &callee in &function.calls {
            reverse[callee as usize].push(index);
        }
        if function.import.is_some()
            || function
                .reasons
                .iter()
                .any(|r| !allow_guest_writes || *r != "guest-memory-write")
        {
            unsafe_functions[index] = true;
            queue.push_back(index);
        }
    }
    while let Some(callee) = queue.pop_front() {
        for &caller in &reverse[callee] {
            if !unsafe_functions[caller] {
                unsafe_functions[caller] = true;
                witnesses[caller] = Some(callee as u32);
                queue.push_back(caller);
            }
        }
    }
    (unsafe_functions, witnesses)
}
impl CallEffects {
    pub(crate) fn parse(bytes: &[u8], allow_guest_writes: bool) -> Result<Self> {
        p::Validator::new_with_features(p::WasmFeatures::all()).validate_all(bytes)?;
        let (mut functions, mut types, mut memories, mut code) = (vec![], vec![], 0, 0);
        let (mut seed_operators, mut operator_counts) = (BTreeMap::new(), BTreeMap::new());
        for payload in Parser::new(0).parse_all(bytes) {
            match payload? {
                Payload::TypeSection(section) => {
                    for ty in section.into_iter_err_on_gc_types() {
                        types.push(ty?);
                    }
                }
                Payload::ImportSection(section) => {
                    for import in section.into_imports() {
                        let import = import?;
                        ensure!(
                            !reserved_vm_name(import.name),
                            "call-effect proof requires untranslated source, not reserved VM imports"
                        );
                        match import.ty {
                            p::TypeRef::Func(ty) => functions.push(Function {
                                ty,
                                import: Some(format!("{}.{}", import.module, import.name)),
                                exports: vec![],
                                calls: BTreeSet::new(),
                                reasons: BTreeSet::new(),
                                direct_sites: 0,
                            }),
                            p::TypeRef::Memory(memory) => {
                                ensure!(!memory.memory64, "call effects require memory32");
                                memories += 1;
                            }
                            p::TypeRef::Global(_) | p::TypeRef::Table(_) | p::TypeRef::Tag(_) => {}
                            _ => anyhow::bail!("unsupported effect import form"),
                        }
                    }
                }
                Payload::MemorySection(_) => {
                    anyhow::bail!("call effects require imported process memory")
                }
                Payload::FunctionSection(section) => {
                    for ty in section {
                        functions.push(Function {
                            ty: ty?,
                            import: None,
                            exports: vec![],
                            calls: BTreeSet::new(),
                            reasons: BTreeSet::new(),
                            direct_sites: 0,
                        });
                    }
                }
                Payload::ExportSection(section) => {
                    for export in section {
                        let export = export?;
                        ensure!(
                            !reserved_vm_name(export.name),
                            "call-effect proof requires untranslated source, not reserved VM exports"
                        );
                        if export.kind == p::ExternalKind::Func {
                            functions[export.index as usize]
                                .exports
                                .push(export.name.into());
                        }
                    }
                }
                Payload::CodeSectionEntry(body) => {
                    while functions[code].import.is_some() {
                        code += 1;
                    }
                    let function = &mut functions[code];
                    code += 1;
                    let mut ops = body.get_operators_reader()?;
                    while !ops.eof() {
                        let op = ops.read()?;
                        let (proposal, name) = tags(&op);
                        *operator_counts
                            .entry(format!("{proposal}:{name}"))
                            .or_default() += 1;
                        if let O::Call { function_index } | O::ReturnCall { function_index } = op {
                            function.calls.insert(function_index);
                            function.direct_sites += 1;
                        }
                        if let Some(reason) = reason(&op) {
                            function.reasons.insert(reason);
                            *seed_operators
                                .entry(format!("{proposal}:{name}"))
                                .or_default() += 1;
                        }
                    }
                }
                Payload::CustomSection(section)
                    if section.name() == "kandelo.common-memory.prototype" =>
                {
                    anyhow::bail!(
                        "call-effect proof requires untranslated source, not an existing VM artifact"
                    )
                }
                _ => {}
            }
        }
        ensure!(memories == 1, "call effects require one process memory");
        ensure!(
            functions[code..].iter().all(|f| f.import.is_some()),
            "missing effect function body"
        );
        let (unsafe_functions, witnesses) = closure(&functions, allow_guest_writes);
        Ok(Self {
            functions,
            types,
            unsafe_functions,
            witnesses,
            seed_operators,
            operator_counts,
            allow_guest_writes,
        })
    }
    pub(crate) fn call_shape(&self, index: u32) -> Option<(usize, usize)> {
        if *self.unsafe_functions.get(index as usize)? {
            return None;
        }
        let function = self.functions.get(index as usize)?;
        let ty = &self.types[function.ty as usize];
        if !ty
            .params()
            .iter()
            .chain(ty.results())
            .all(|t| *t == p::ValType::I32)
        {
            return None;
        }
        Some((ty.params().len(), ty.results().len()))
    }
    pub(crate) fn report(&self) -> serde_json::Value {
        let mut seeds = BTreeMap::<String, usize>::new();
        for function in &self.functions {
            if function.import.is_some() {
                *seeds.entry("import".into()).or_default() += 1;
            }
            for reason in &function.reasons {
                *seeds.entry((*reason).into()).or_default() += 1;
            }
        }
        let functions: Vec<_> = self.functions.iter().enumerate().map(|(i, f)| serde_json::json!({"function":i,"import":f.import,"exports":f.exports,"directCallSites":f.direct_sites,"callees":f.calls,"localReasons":f.reasons,"excluded":self.unsafe_functions[i],"witnessCallee":self.witnesses[i],"i32CallEligible":self.call_shape(i as u32).is_some()})).collect();
        serde_json::json!({"policy":if self.allow_guest_writes {"publish-pattern-only-opportunity-NOT-alias-proof"} else {"guest-memory-read-only-direct-call-closure"},"allowGuestWrites":self.allow_guest_writes,"scope":"Imports, indirect/ref calls, all thread/atomic operations, growth, exception unwinding, table operations and unknown proposals seed exclusions propagated through direct/tail calls. Catch structure alone is allowed, but throws/rethrows remain excluded without handler reachability proof. Strict policy additionally excludes all guest memory writes because their destination may alias a syscall channel. Wasm-global changes are allowed; caller locals cannot be changed by a callee. This relies on the existing trusted single-Worker/process mapping-boundary model, not arbitrary concurrent remapping. Write-allowing results are opportunity estimates only; no channel-address exclusion proof.","functions":functions,"totalFunctions":self.functions.len(),"excludedFunctions":self.unsafe_functions.iter().filter(|v| **v).count(),"i32EligibleFunctions":(0..self.functions.len()).filter(|i| self.call_shape(*i as u32).is_some()).count(),"seedReasonCounts":seeds,"seedOperatorCounts":self.seed_operators,"operatorCounts":self.operator_counts})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn f(calls: &[u32], reasons: &[&'static str]) -> Function {
        Function {
            ty: 0,
            import: None,
            exports: vec![],
            calls: calls.iter().copied().collect(),
            reasons: reasons.iter().copied().collect(),
            direct_sites: calls.len() as u32,
        }
    }
    #[test]
    fn transitive_effects_and_unseeded_cycles() {
        let graph = vec![
            f(&[1], &[]),
            f(&[2], &[]),
            f(&[], &["atomic-or-wait-notify"]),
            f(&[4], &[]),
            f(&[3], &[]),
        ];
        assert_eq!(
            closure(&graph, false).0,
            vec![true, true, true, false, false]
        );
        assert_eq!(closure(&graph, false).1[0], Some(1));
        let mut graph = graph;
        graph[4].reasons.insert("memory-growth");
        assert!(closure(&graph, false).0.iter().all(|v| *v));
    }
    #[test]
    fn writes_are_not_a_mapping_proof() {
        let graph = vec![f(&[1], &[]), f(&[], &["guest-memory-write"])];
        assert_eq!(closure(&graph, false).0, vec![true, true]);
        assert_eq!(closure(&graph, true).0, vec![false, false]);
        assert_eq!(reason(&O::MemoryGrow { mem: 0 }), Some("memory-growth"));
        assert_eq!(
            reason(&O::MemoryAtomicNotify {
                memarg: p::MemArg {
                    align: 2,
                    max_align: 2,
                    offset: 0,
                    memory: 0
                }
            }),
            Some("atomic-or-wait-notify")
        );
        assert_eq!(reason(&O::I32Add), None);
        assert_eq!(reason(&O::CatchAll), None);
        assert_eq!(reason(&O::ThrowRef), Some("exception-unwind"));
    }
}

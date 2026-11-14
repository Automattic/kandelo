//! Read-only whole-module origin/loop screen. No code is rewritten.
//! Operand arity comes from wasmparser's validator, so a complex store value
//! cannot be mistaken for its address. Origin and lifetime remain separate:
//! frame facts and loop-shape hints are NOT authorization to elide translation.
use anyhow::{Result, ensure};
use std::collections::{BTreeMap, BTreeSet};
use wasmparser::{self as p, Operator as O, Parser, Payload};

const GUARD_BUDGET: u64 = 65536;
const MAX_TERMS: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Expr {
    terms: BTreeMap<u32, u32>,
    versions: BTreeMap<u32, u64>,
    constant: u32,
}
impl Expr {
    fn constant(value: u32) -> Self {
        Self {
            terms: BTreeMap::new(),
            versions: BTreeMap::new(),
            constant: value,
        }
    }
    fn local(index: u32, version: u64) -> Self {
        Self {
            terms: [(index, 1)].into(),
            versions: [(index, version)].into(),
            constant: 0,
        }
    }
    fn is_constant(&self) -> Option<u32> {
        self.terms.is_empty().then_some(self.constant)
    }
    fn add(&self, other: &Self, subtract: bool) -> Option<Self> {
        let mut result = self.clone();
        result.constant = if subtract {
            result.constant.wrapping_sub(other.constant)
        } else {
            result.constant.wrapping_add(other.constant)
        };
        for (&local, &coefficient) in &other.terms {
            if result
                .versions
                .get(&local)
                .is_some_and(|v| Some(v) != other.versions.get(&local))
            {
                // Two snapshots of one mutable local are different values.
                // Do not cancel their coefficients as though they were equal.
                return None;
            }
            let old = result.terms.get(&local).copied().unwrap_or(0);
            let value = if subtract {
                old.wrapping_sub(coefficient)
            } else {
                old.wrapping_add(coefficient)
            };
            if value == 0 {
                result.terms.remove(&local);
                result.versions.remove(&local);
            } else {
                result.terms.insert(local, value);
                result.versions.insert(local, other.versions[&local]);
            }
        }
        (result.terms.len() <= MAX_TERMS).then_some(result)
    }
    fn scale(&self, amount: u32) -> Self {
        let terms: BTreeMap<_, _> = self
            .terms
            .iter()
            .filter_map(|(&l, &v)| {
                let n = v.wrapping_mul(amount);
                (n != 0).then_some((l, n))
            })
            .collect();
        Self {
            versions: terms.keys().map(|&l| (l, self.versions[&l])).collect(),
            terms,
            constant: self.constant.wrapping_mul(amount),
        }
    }
    fn json(&self) -> serde_json::Value {
        serde_json::json!({"terms":self.terms,"localVersions":self.versions,"constantMod32":self.constant})
    }
    fn current(&self, versions: &BTreeMap<u32, u64>) -> bool {
        self.versions
            .iter()
            .all(|(l, v)| *v == versions.get(l).copied().unwrap_or(0))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FrameOrigin {
    local: u32,
    size: u32,
    offset: u32,
    constructor: usize,
    epoch: u64,
}
#[derive(Clone, Debug)]
struct Comparison {
    name: &'static str,
    left: Expr,
    right: Expr,
}
#[derive(Clone, Default, Debug)]
struct Value {
    expr: Option<Expr>,
    frame: Option<FrameOrigin>,
    comparison: Option<Comparison>,
}
#[derive(Clone, Copy)]
struct Memory {
    name: &'static str,
    offset: u64,
    width: u64,
    write: bool,
    atomic: bool,
}
macro_rules! mem_capture {
    ($name:expr,$proposal:expr,memarg=>$m:expr $(,$rest:ident=>$value:expr)*) => {
        Some(Memory {
            name: $name,
            offset: $m.offset,
            width: 1u64 << $m.max_align,
            write: $name.contains("Store") || $name.contains("Rmw"),
            atomic: $proposal == "threads",
        })
    };
    ($name:expr,$proposal:expr $(,$rest:ident=>$value:expr)*) => {
        None
    };
}
macro_rules! operators {
    ($(@$proposal:ident $op:ident $({$($arg:ident:$ty:ty),*})? => $visit:ident ($($ann:tt)*))*) => {
        fn tags(op:&O<'_>)->(&'static str,&'static str) {
            match op { $(O::$op $({$($arg:_),*})? => (stringify!($proposal),stringify!($op)),)* _=>("unknown","unknown") }
        }
        fn memory(op:&O<'_>)->Option<Memory> {
            match op { $(O::$op $({$($arg),*})? => { $($(let _=$arg;)*)? mem_capture!(stringify!($op),stringify!($proposal)$(,$($arg=>$arg),*)?) },)* _=>None }
        }
    }
}
p::for_each_operator!(operators);

fn effect(op: &O<'_>) -> Option<&'static str> {
    match op {
        O::Call { .. } | O::ReturnCall { .. } => return Some("direct-call"),
        O::CallIndirect { .. }
        | O::ReturnCallIndirect { .. }
        | O::CallRef { .. }
        | O::ReturnCallRef { .. } => return Some("indirect-call"),
        O::Throw { .. } | O::ThrowRef | O::Rethrow { .. } | O::Delegate { .. } => {
            return Some("exception-unwind");
        }
        O::TryTable { .. } | O::Try { .. } | O::Catch { .. } | O::CatchAll => return None,
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
    if name.contains("Store")
        || matches!(
            op,
            O::MemoryCopy { .. } | O::MemoryFill { .. } | O::MemoryInit { .. }
        )
    {
        return Some("guest-memory-write");
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
    None
}
struct Item<'a> {
    op: O<'a>,
    offset: usize,
    before: u32,
    after: u32,
    cb: u32,
    ca: u32,
    arity: Option<(u32, u32)>,
    unreachable: bool,
}
#[derive(Default)]
struct Loop {
    start: usize,
    end: usize,
    depth: u32,
    entry_empty: bool,
    writes: BTreeSet<u32>,
    effects: BTreeMap<&'static str, u64>,
    updates: BTreeMap<u32, (i64, usize)>,
    backedges: Vec<usize>,
}
struct Site {
    ordinal: usize,
    offset: usize,
    memory: Memory,
    expr: Option<Expr>,
    expression_current: bool,
    frame: Option<FrameOrigin>,
    old_frame: bool,
    producer_frame: bool,
    defined_frame: bool,
    window_frame: bool,
    unreachable: bool,
}

fn comparison(name: &'static str, a: &Value, b: &Value) -> Option<Comparison> {
    Some(Comparison {
        name,
        left: a.expr.clone()?,
        right: b.expr.clone()?,
    })
}
fn frame_fits(frame: FrameOrigin, m: Memory) -> bool {
    u64::from(frame.offset)
        .checked_add(m.offset)
        .and_then(|n| n.checked_add(m.width))
        .is_some_and(|end| end <= u64::from(frame.size))
}
fn reserved(name: &str) -> bool {
    matches!(
        name,
        "__vm_root" | "__vm_scratch" | "__vm_initialize" | "__vm_host_span"
    )
}

pub fn analyze(bytes: &[u8]) -> Result<serde_json::Value> {
    analyze_mode(bytes, false)
}

pub fn analyze_constants(bytes: &[u8]) -> Result<serde_json::Value> {
    analyze_mode(bytes, true)
}

fn analyze_mode(bytes: &[u8], constants: bool) -> Result<serde_json::Value> {
    p::Validator::new_with_features(p::WasmFeatures::all()).validate_all(bytes)?;
    let (mut stack_global, mut memories, mut imported_functions) = (None, 0, 0u32);
    let mut global_types = vec![];
    let mut names = BTreeMap::new();
    let mut data_ranges = Vec::<(u64, u64)>::new();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload? {
            Payload::ImportSection(s) => {
                for i in s.into_imports() {
                    let i = i?;
                    ensure!(!reserved(i.name), "untranslated source required");
                    match i.ty {
                        p::TypeRef::Memory(m) => {
                            ensure!(!m.memory64, "origins require memory32");
                            memories += 1;
                        }
                        p::TypeRef::Func(_) => imported_functions += 1,
                        p::TypeRef::Global(g) => global_types.push(g),
                        _ => {}
                    }
                }
            }
            Payload::GlobalSection(s) => {
                for g in s {
                    global_types.push(g?.ty);
                }
            }
            Payload::MemorySection(_) => anyhow::bail!("origins require imported process memory"),
            Payload::CustomSection(s) if s.name() == "kandelo.common-memory.prototype" => {
                anyhow::bail!("untranslated source required")
            }
            Payload::ExportSection(s) => {
                for e in s {
                    let e = e?;
                    ensure!(!reserved(e.name), "untranslated source required");
                    if e.name == "__stack_pointer" {
                        ensure!(
                            e.kind == p::ExternalKind::Global,
                            "stack export must be a global"
                        );
                        stack_global = Some(e.index);
                    }
                    if e.kind == p::ExternalKind::Func {
                        names.insert(e.index, e.name.to_owned());
                    }
                }
            }
            Payload::DataSection(s) if constants => {
                for d in s {
                    let d = d?;
                    if let p::DataKind::Active {
                        memory_index: 0,
                        offset_expr,
                    } = d.kind
                    {
                        let mut ops = offset_expr.get_operators_reader();
                        if let O::I32Const { value } = ops.read()? {
                            let start = u64::from(value as u32);
                            let end = start + d.data.len() as u64;
                            if matches!(ops.read()?, O::End)
                                && ops.eof()
                                && end <= (1u64 << 32)
                                && start < end
                            {
                                data_ranges.push((start, end));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    ensure!(memories == 1, "origins require one imported process memory");
    data_ranges.sort_unstable();
    let mut merged_ranges = Vec::<(u64, u64)>::new();
    for (start, end) in data_ranges {
        if let Some(last) = merged_ranges.last_mut()
            && start <= last.1
        {
            last.1 = last.1.max(end);
        } else {
            merged_ranges.push((start, end));
        }
    }
    // Constant producers do not need a C shadow stack. Keep the existing
    // frame-origin entry point strict, and validate a stack export if present.
    ensure!(
        constants || stack_global.is_some(),
        "canonical __stack_pointer export required"
    );
    if let Some(index) = stack_global {
        ensure!(
            global_types
                .get(index as usize)
                .is_some_and(|g| g.content_type == p::ValType::I32 && g.mutable),
            "canonical stack pointer must be mutable i32"
        );
    }
    let mut validator = p::Validator::new_with_features(p::WasmFeatures::all());
    let mut allocations = p::FuncValidatorAllocations::default();
    let (mut rows, mut candidate_sites, mut loop_rows) = (vec![], vec![], vec![]);
    let mut constant_sites = vec![];
    let mut totals = BTreeMap::<String, u64>::new();
    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload?;
        if let p::ValidPayload::Func(f, body) = validator.payload(&payload)? {
            let function = f.index;
            let mut fv = f.into_validator(allocations);
            let mut locals = body.get_binary_reader();
            fv.read_locals(&mut locals)?;
            let mut reader = body.get_operators_reader()?;
            let mut items = vec![];
            while !reader.eof() {
                let offset = reader.original_position();
                let op = reader.read()?;
                let before = fv.operand_stack_height();
                let cb = fv.control_stack_height();
                let unreachable = fv.get_control_frame(0).is_some_and(|f| f.unreachable);
                let arity = op.operator_arity(&fv);
                fv.op(offset, &op)?;
                items.push(Item {
                    op,
                    offset,
                    before,
                    after: fv.operand_stack_height(),
                    cb,
                    ca: fv.control_stack_height(),
                    arity,
                    unreachable,
                });
            }
            allocations = fv.into_allocations();
            let (mut constructors, mut frame_locals) = (
                BTreeMap::<usize, (u32, u32)>::new(),
                BTreeMap::<u32, u32>::new(),
            );
            for (i, w) in items.windows(5).enumerate() {
                if let [
                    O::GlobalGet { global_index: g },
                    O::I32Const { value: n },
                    O::I32Sub,
                    O::LocalTee { local_index: l },
                    O::GlobalSet { global_index: h },
                ] = [&w[0].op, &w[1].op, &w[2].op, &w[3].op, &w[4].op]
                {
                    if Some(*g) == stack_global && Some(*h) == stack_global && *n > 0 {
                        constructors.insert(i + 3, (*l, *n as u32));
                        frame_locals
                            .entry(*l)
                            .and_modify(|old| *old = (*old).min(*n as u32))
                            .or_insert(*n as u32);
                    }
                }
            }
            let (mut loops, mut open) = (Vec::<Loop>::new(), Vec::<usize>::new());
            for (i, item) in items.iter().enumerate() {
                if matches!(item.op, O::Loop { .. }) {
                    let id = loops.len();
                    loops.push(Loop {
                        start: i,
                        end: items.len(),
                        depth: item.ca,
                        entry_empty: item.before == 0 && item.after == 0,
                        ..Default::default()
                    });
                    open.push(id);
                }
                while open.last().is_some_and(|&id| loops[id].depth > item.ca) {
                    let id = open.pop().unwrap();
                    loops[id].end = i;
                }
            }
            ensure!(open.is_empty(), "unclosed validated loop");
            for info in &mut loops {
                let mut writes = BTreeMap::<u32, Vec<usize>>::new();
                for i in info.start + 1..info.end {
                    let item = &items[i];
                    if let Some(reason) = effect(&item.op) {
                        *info.effects.entry(reason).or_default() += 1;
                    }
                    if let O::LocalSet { local_index: l } | O::LocalTee { local_index: l } = item.op
                    {
                        info.writes.insert(l);
                        writes.entry(l).or_default().push(i);
                    }
                    if let O::BrIf { relative_depth: d } = item.op {
                        if item.cb.checked_sub(1 + d) == Some(info.depth - 1) {
                            info.backedges.push(i);
                        }
                    }
                }
                for (l, writes) in writes {
                    if writes.len() != 1 {
                        continue;
                    }
                    let i = writes[0];
                    if i < info.start + 4 {
                        continue;
                    }
                    if let (O::LocalGet { local_index: a }, O::I32Const { value: n }) =
                        (&items[i - 3].op, &items[i - 2].op)
                    {
                        if *a == l && *n != 0 {
                            let step = match items[i - 1].op {
                                O::I32Add => i64::from(*n),
                                O::I32Sub => -i64::from(*n),
                                _ => 0,
                            };
                            if step != 0 && step.abs() <= 65536 {
                                info.updates.insert(l, (step, i));
                            }
                        }
                    }
                }
            }
            let loop_starts: BTreeMap<usize, usize> = loops
                .iter()
                .enumerate()
                .map(|(id, l)| (l.start, id))
                .collect();
            let (mut values, mut local_frames) =
                (Vec::<Value>::new(), BTreeMap::<u32, FrameOrigin>::new());
            let mut local_versions = BTreeMap::<u32, u64>::new();
            let mut local_constants = BTreeMap::<u32, u32>::new();
            let (mut sites, mut conditions) = (vec![], BTreeMap::<usize, Comparison>::new());
            let mut epoch = 0u64;
            let mut function_counts = BTreeMap::<String, u64>::new();
            for (i, item) in items.iter().enumerate() {
                if values.len() != item.before as usize {
                    values = vec![Value::default(); item.before as usize];
                }
                let args = if let Some((n, _)) = item.arity {
                    if n as usize <= values.len() {
                        values.split_off(values.len() - n as usize)
                    } else {
                        vec![]
                    }
                } else {
                    vec![]
                };
                if let Some(m) = memory(&item.op) {
                    let address = args.first().cloned().unwrap_or_default();
                    let expr = address.expr.clone();
                    let producer_frame = expr.as_ref().is_some_and(|e| {
                        e.terms.len() == 1
                            && e.terms.iter().any(|(&l, &c)| {
                                c == 1
                                    && frame_locals.get(&l).is_some_and(|&size| {
                                        frame_fits(
                                            FrameOrigin {
                                                local: l,
                                                size,
                                                offset: e.constant,
                                                constructor: 0,
                                                epoch: 0,
                                            },
                                            m,
                                        )
                                    })
                            })
                    });
                    let defined_frame = address.frame.is_some_and(|f| frame_fits(f, m));
                    let window_frame =
                        defined_frame && address.frame.is_some_and(|f| f.epoch == epoch);
                    let old_index = if m.name.contains("Store") {
                        i.checked_sub(2)
                    } else {
                        i.checked_sub(1)
                    };
                    let old_frame = old_index
                        .and_then(|j| match items[j].op {
                            O::LocalGet { local_index: l } => frame_locals.get(&l),
                            _ => None,
                        })
                        .is_some_and(|&size| {
                            m.offset
                                .checked_add(m.width)
                                .is_some_and(|end| end <= u64::from(size))
                        });
                    sites.push(Site {
                        ordinal: i,
                        offset: item.offset,
                        memory: m,
                        expression_current: expr
                            .as_ref()
                            .is_some_and(|e| e.current(&local_versions)),
                        expr,
                        frame: address.frame,
                        old_frame,
                        producer_frame,
                        defined_frame,
                        window_frame,
                        unreachable: item.unreachable,
                    });
                }
                if let O::BrIf { .. } = item.op {
                    if let Some(c) = args.last().and_then(|v| v.comparison.clone()) {
                        conditions.insert(i, c);
                    } else if let Some(e) = args.last().and_then(|v| v.expr.clone()) {
                        conditions.insert(
                            i,
                            Comparison {
                                name: "nonzero",
                                left: e,
                                right: Expr::constant(0),
                            },
                        );
                    }
                }
                let mut output = Value::default();
                match item.op {
                    O::I32Const { value } => output.expr = Some(Expr::constant(value as u32)),
                    O::LocalGet { local_index: l } => {
                        output.expr = Some(if constants && local_constants.contains_key(&l) {
                            Expr::constant(local_constants[&l])
                        } else {
                            Expr::local(l, local_versions.get(&l).copied().unwrap_or(0))
                        });
                        output.frame = local_frames.get(&l).copied();
                    }
                    O::LocalSet { local_index: l } | O::LocalTee { local_index: l } => {
                        output = args.first().cloned().unwrap_or_default();
                        *local_versions.entry(l).or_default() += 1;
                        if constants {
                            if let Some(value) = output.expr.as_ref().and_then(Expr::is_constant) {
                                local_constants.insert(l, value);
                            } else {
                                local_constants.remove(&l);
                            }
                        }
                        if let Some(&(anchor, size)) = constructors.get(&i) {
                            output.frame = Some(FrameOrigin {
                                local: anchor,
                                size,
                                offset: 0,
                                constructor: i,
                                epoch,
                            });
                        }
                        if let Some(frame) = output.frame {
                            local_frames.insert(l, frame);
                        } else {
                            local_frames.remove(&l);
                        }
                        if output
                            .expr
                            .as_ref()
                            .is_none_or(|e| !e.current(&local_versions))
                        {
                            output.expr = Some(Expr::local(l, local_versions[&l]));
                        }
                    }
                    O::I32Add | O::I32Sub if args.len() == 2 => {
                        let sub = matches!(item.op, O::I32Sub);
                        output.expr = args[0]
                            .expr
                            .as_ref()
                            .zip(args[1].expr.as_ref())
                            .and_then(|(a, b)| a.add(b, sub));
                        let rhs = args[1].expr.as_ref().and_then(Expr::is_constant);
                        let lhs = args[0].expr.as_ref().and_then(Expr::is_constant);
                        if let Some((mut f, n)) = args[0].frame.zip(rhs) {
                            f.offset = if sub {
                                f.offset.wrapping_sub(n)
                            } else {
                                f.offset.wrapping_add(n)
                            };
                            output.frame = Some(f);
                        } else if !sub {
                            if let Some((mut f, n)) = args[1].frame.zip(lhs) {
                                f.offset = f.offset.wrapping_add(n);
                                output.frame = Some(f);
                            }
                        }
                    }
                    O::I32Mul | O::I32Shl if args.len() == 2 => {
                        let rhs = args[1].expr.as_ref().and_then(Expr::is_constant);
                        let lhs = args[0].expr.as_ref().and_then(Expr::is_constant);
                        if matches!(item.op, O::I32Shl) {
                            if let Some(n) = rhs {
                                let scale = 1u32.wrapping_shl(n & 31);
                                output.expr = args[0].expr.as_ref().map(|e| e.scale(scale));
                                if scale == 1 {
                                    output.frame = args[0].frame;
                                }
                            }
                        } else if let Some(n) = rhs {
                            output.expr = args[0].expr.as_ref().map(|e| e.scale(n));
                            if n == 1 {
                                output.frame = args[0].frame;
                            }
                        } else if let Some(n) = lhs {
                            output.expr = args[1].expr.as_ref().map(|e| e.scale(n));
                            if n == 1 {
                                output.frame = args[1].frame;
                            }
                        }
                    }
                    O::I32Eq
                    | O::I32Ne
                    | O::I32LtS
                    | O::I32LtU
                    | O::I32LeS
                    | O::I32LeU
                    | O::I32GtS
                    | O::I32GtU
                    | O::I32GeS
                    | O::I32GeU
                        if args.len() == 2 =>
                    {
                        output.comparison = comparison(tags(&item.op).1, &args[0], &args[1]);
                    }
                    O::I32Eqz if args.len() == 1 => {
                        output.comparison = comparison(
                            "I32Eqz",
                            &args[0],
                            &Value {
                                expr: Some(Expr::constant(0)),
                                ..Default::default()
                            },
                        );
                    }
                    _ => {}
                }
                let control_entry = matches!(
                    item.op,
                    O::Block { .. }
                        | O::Loop { .. }
                        | O::Try { .. }
                        | O::TryTable { .. }
                        | O::If { .. }
                );
                if control_entry {
                    let forwarded = if matches!(item.op, O::If { .. }) {
                        args.len().saturating_sub(1)
                    } else {
                        args.len()
                    };
                    if constants && matches!(item.op, O::Loop { .. }) {
                        // Backedges supply new loop parameters. The initial
                        // operands are not facts about subsequent iterations.
                        values.extend((0..forwarded).map(|_| Value::default()));
                    } else {
                        values.extend(args.into_iter().take(forwarded));
                    }
                    if let Some(&id) = loop_starts.get(&i) {
                        local_frames.retain(|l, _| !loops[id].writes.contains(l));
                        local_constants.retain(|l, _| !loops[id].writes.contains(l));
                    }
                } else if let Some((_, n)) = item.arity {
                    for _ in 0..n {
                        values.push(output.clone());
                    }
                }
                if values.len() != item.after as usize {
                    values = vec![Value::default(); item.after as usize];
                }
                if matches!(
                    item.op,
                    O::Else
                        | O::End
                        | O::Br { .. }
                        | O::BrIf { .. }
                        | O::BrTable { .. }
                        | O::Return
                        | O::ReturnCall { .. }
                        | O::ReturnCallIndirect { .. }
                        | O::ReturnCallRef { .. }
                        | O::Unreachable
                        | O::Catch { .. }
                        | O::CatchAll
                        | O::Throw { .. }
                        | O::ThrowRef
                        | O::Rethrow { .. }
                        | O::Delegate { .. }
                ) {
                    local_frames.clear();
                    local_constants.clear();
                    values = vec![Value::default(); item.after as usize];
                }
                if effect(&item.op).is_some() {
                    epoch += 1;
                }
            }
            let mut invariant_sites = BTreeSet::new();
            let mut stride_sites = BTreeSet::new();
            for (id, info) in loops.iter().enumerate() {
                let pure = info.effects.is_empty();
                let mut hints = vec![];
                let mut bounded_locals = BTreeSet::new();
                for &edge in &info.backedges {
                    if let Some(c) = conditions.get(&edge) {
                        for (&l, &(step, update)) in &info.updates {
                            let contains = |e: &Expr| e.terms.contains_key(&l);
                            let stable =
                                |e: &Expr| e.terms.keys().all(|l| !info.writes.contains(l));
                            if (contains(&c.left) && stable(&c.right))
                                || (contains(&c.right) && stable(&c.left))
                            {
                                bounded_locals.insert(l);
                                hints.push(serde_json::json!({"local":l,"step":step,"updateOrdinal":update,"backedgeOrdinal":edge,"comparison":c.name,"left":c.left.json(),"right":c.right.json()}));
                            }
                        }
                    }
                }
                let (mut invariant, mut strided) = (vec![], vec![]);
                for site in &sites {
                    if site.ordinal <= info.start || site.ordinal >= info.end || site.unreachable {
                        continue;
                    }
                    if let Some(e) = &site.expr {
                        // A constant address or a large constant displacement
                        // is still invariant. Future insertion must check the
                        // actual effective address, overflow and permissions;
                        // the constant is not a span length from address zero.
                        if pure
                            && info.entry_empty
                            && site.memory.width <= GUARD_BUDGET
                            && site.expression_current
                            && e.terms.keys().all(|l| !info.writes.contains(l))
                        {
                            invariant.push(site.ordinal);
                            invariant_sites.insert(site.ordinal);
                        }
                        let changing: Vec<_> =
                            e.terms.keys().filter(|l| info.writes.contains(l)).collect();
                        if pure
                            && info.entry_empty
                            && changing.len() == 1
                            && bounded_locals.contains(changing[0])
                        {
                            strided.push(site.ordinal);
                            stride_sites.insert(site.ordinal);
                        }
                    }
                }
                loop_rows.push(serde_json::json!({"function":function,"loop":id,"startOrdinal":info.start,"endOrdinal":info.end,"entryEmpty":info.entry_empty,"effects":info.effects,"writtenLocals":info.writes,"readOnlyEffectWindow":pure,"invariantAddressSites":invariant,"strideBoundSiteOpportunities":strided,"strideHints":hints}));
            }
            for site in &sites {
                if constants && let Some(base) = site.expr.as_ref().and_then(Expr::is_constant) {
                    // The i32 producer wraps; Wasm's unsigned memarg addition does
                    // not. Never turn a large offset into a small valid address.
                    let start = u64::from(base).checked_add(site.memory.offset);
                    let end = start.and_then(|a| a.checked_add(site.memory.width));
                    let valid = end.is_some_and(|e| e <= (1u64 << 32));
                    let single = valid && start.unwrap() / 65536 == (end.unwrap() - 1) / 65536;
                    let initial_data = valid
                        && merged_ranges
                            .iter()
                            .any(|&(a, b)| a <= start.unwrap() && end.unwrap() <= b);
                    constant_sites.push(serde_json::json!({
                        "function":function,"ordinal":site.ordinal,"byteOffset":site.offset,
                        "operator":site.memory.name,"baseMod32":base,"memargOffset":site.memory.offset,
                        "width":site.memory.width,"effectiveStart":start,"effectiveEndExclusive":end,
                        "validMemory32Range":valid,"singlePage":single,"initialDataRange":initial_data,
                        "write":site.memory.write,"atomic":site.memory.atomic,"unreachable":site.unreachable
                    }));
                }
                for (key, value) in [
                    ("memorySites", true),
                    ("legacyAdjacentFrameSites", site.old_frame),
                    ("producerAnchorFrameOpportunities", site.producer_frame),
                    ("definitionFrameOrigins", site.defined_frame),
                    ("frameOriginsWithoutInterveningEffects", site.window_frame),
                    (
                        "readonlyLoopInvariantSites",
                        invariant_sites.contains(&site.ordinal),
                    ),
                    (
                        "readonlyStrideBoundOpportunities",
                        stride_sites.contains(&site.ordinal),
                    ),
                    ("unreachableMemorySites", site.unreachable),
                    ("unclassifiedAddressSites", site.expr.is_none()),
                    (
                        "staleLocalExpressionSites",
                        site.expr.is_some() && !site.expression_current,
                    ),
                    ("atomicMemorySites", site.memory.atomic),
                    ("storeMemorySites", site.memory.write),
                ] {
                    if value {
                        *function_counts.entry(key.into()).or_default() += 1;
                    }
                }
                if site.producer_frame
                    || site.defined_frame
                    || invariant_sites.contains(&site.ordinal)
                    || stride_sites.contains(&site.ordinal)
                    || (site.expr.is_some() && !site.expression_current)
                {
                    candidate_sites.push(serde_json::json!({"function":function,"ordinal":site.ordinal,"byteOffset":site.offset,"operator":site.memory.name,"memargOffset":site.memory.offset,"width":site.memory.width,"expression":site.expr.as_ref().map(Expr::json),"expressionUsesCurrentLocalVersions":site.expression_current,"frameOrigin":site.frame.map(|f|serde_json::json!({"constructorLocal":f.local,"frameBytes":f.size,"offsetMod32":f.offset,"constructorOrdinal":f.constructor,"effectEpoch":f.epoch})),"anchorNameOpportunity":site.producer_frame,"definitionOrigin":site.defined_frame,"noInterveningEffectWindow":site.window_frame,"readonlyInvariantLoop":invariant_sites.contains(&site.ordinal),"readonlyStrideBoundOpportunity":stride_sites.contains(&site.ordinal),"unreachable":site.unreachable}));
                }
            }
            function_counts.insert("loops".into(), loops.len() as u64);
            function_counts.insert(
                "readOnlyLoops".into(),
                loops.iter().filter(|l| l.effects.is_empty()).count() as u64,
            );
            function_counts.insert("frameConstructors".into(), constructors.len() as u64);
            for (k, v) in &function_counts {
                *totals.entry(k.clone()).or_default() += v;
            }
            rows.push(serde_json::json!({"function":function,"name":names.get(&function),"counts":function_counts,"frameLocals":frame_locals}));
        }
    }
    let mut report = serde_json::json!({"schema":1,"scope":"Read-only whole-module operand-producer, frame-origin and loop-shape screen. Modular i32 expressions, exact stack prologues, conservative control joins and validator arities. Counts overlap. Origin facts are NOT mapping/channel-alias, lifetime, materialization or fork-entry/guard-domination proofs. Stride/bound hints are NOT induction, CFG, bounds, overflow or optimization certificates. No Wasm rewrite, measured dynamic site coverage, CPU fraction or speedup claimed.","stackGlobal":stack_global,"importedFunctions":imported_functions,"definedFunctions":rows.len(),"guardBudget":GUARD_BUDGET,"maxExpressionTerms":MAX_TERMS,"totals":totals,"functions":rows,"loops":loop_rows,"candidateSites":candidate_sites});
    if constants {
        report["constantSites"] = serde_json::json!(constant_sites);
        report["constantAnalysis"] = serde_json::json!({"version":2,"initialDataRanges":merged_ranges,
            "scope":"Opt-in memory32 constant producer screen with straight-line local constant propagation and conservative control joins. Initial data membership is byte-range containment in merged active literal-offset segments, not ownership, immutability, mapping, lifetime, channel/alias or fork-rebinding proof. Mutable/imported globals and loaded pointers remain unknown. Not generated-fork-state attribution, safe elision, CPU or latency."});
    }
    Ok(report)
}

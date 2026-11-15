use anyhow::{Context, Result, bail, ensure};
use std::{borrow::Cow, collections::BTreeMap, fs};
use wasm_encoder::{
    self as enc, Encode, Instruction as I, ValType as V,
    reencode::{self, Reencode},
};
use wasmparser::{self as p, Operator as O, Parser, Payload};

mod affine_cache;
mod constant_addresses;
mod object_regions;

type E = reencode::Error<anyhow::Error>;
type R<T> = std::result::Result<T, E>;
fn error(message: &str) -> E {
    E::UserError(anyhow::anyhow!("{message}"))
}
fn val(t: p::ValType) -> V {
    reencode::RoundtripReencoder
        .val_type(t)
        .expect("roundtrip source value type")
}

#[derive(Default)]
struct Shape {
    types: Vec<p::FuncType>,
    functions: Vec<u32>,
    imported_functions: u32,
    globals: u32,
    exports: BTreeMap<String, (p::ExternalKind, u32)>,
    initial: u64,
    maximum: u64,
    memories: u32,
    data: u32,
    active: Vec<(u32, u32, u32)>,
    start: Option<u32>,
}
fn scan(bytes: &[u8]) -> Result<Shape> {
    let mut s = Shape::default();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload? {
            Payload::TypeSection(ts) => {
                for t in ts.into_iter_err_on_gc_types() {
                    let t = t?;
                    s.types.push(t);
                }
            }
            Payload::ImportSection(is) => {
                for import in is.into_imports() {
                    let import = import?;
                    ensure!(
                        !import.module.starts_with("kandelo_vm"),
                        "already virtualized input"
                    );
                    match import.ty {
                        p::TypeRef::Func(t) => {
                            s.functions.push(t);
                            s.imported_functions += 1;
                        }
                        p::TypeRef::Global(_) => s.globals += 1,
                        p::TypeRef::Memory(m) => {
                            ensure!(
                                !m.memory64 && m.page_size_log2.is_none(),
                                "only memory32 with standard pages is admitted"
                            );
                            ensure!(
                                import.module == "env" && import.name == "memory",
                                "expected env.memory"
                            );
                            s.memories += 1;
                            s.initial = m.initial;
                            s.maximum = m.maximum.unwrap_or(65536);
                        }
                        _ => {}
                    }
                }
            }
            Payload::MemorySection(_) => {
                bail!("defined memories are not yet admitted; link with --import-memory")
            }
            Payload::FunctionSection(fs) => {
                for t in fs {
                    s.functions.push(t?);
                }
            }
            Payload::GlobalSection(gs) => s.globals += gs.count(),
            Payload::ExportSection(es) => {
                for e in es {
                    let e = e?;
                    ensure!(
                        ![
                            "__vm_root",
                            "__vm_scratch",
                            "__vm_initialize",
                            "__vm_host_span"
                        ]
                        .contains(&e.name),
                        "reserved VM export {}",
                        e.name
                    );
                    s.exports.insert(e.name.into(), (e.kind, e.index));
                }
            }
            Payload::StartSection { func, .. } => s.start = Some(func),
            Payload::DataSection(ds) => {
                for (index, d) in ds.into_iter().enumerate() {
                    let d = d?;
                    s.data += 1;
                    if let p::DataKind::Active {
                        memory_index,
                        offset_expr,
                    } = d.kind
                    {
                        ensure!(memory_index == 0, "multiple memories are not admitted");
                        let mut ops = offset_expr.get_operators_reader();
                        let O::I32Const { value } = ops.read()? else {
                            bail!("nonconstant active-data offset is not yet admitted")
                        };
                        ensure!(
                            matches!(ops.read()?, O::End) && ops.eof(),
                            "extended data initializer is not yet admitted"
                        );
                        s.active
                            .push((index as u32, value as u32, d.data.len().try_into()?));
                    }
                }
            }
            _ => {}
        }
    }
    ensure!(
        s.memories == 1,
        "expected exactly one imported process memory"
    );
    Ok(s)
}

// The supported SDK entry accepts an already linked, current-contract program.
// Research entry points remain available separately; they cannot admit an old
// executable by attaching a new ABI digest to it.
fn check_sdk_input(bytes: &[u8], digest: &str) -> Result<()> {
    ensure!(digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()),
        "expected a 32-byte ABI contract digest");
    let expected = (0..32).map(|i| u8::from_str_radix(&digest[i*2..i*2+2], 16))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    p::Validator::new_with_features(p::WasmFeatures::all()).validate_all(bytes)?;
    let mut contracts = 0;
    for payload in Parser::new(0).parse_all(bytes) {
        if let Payload::CustomSection(section) = payload? {
            match section.name() {
                "kandelo.abi.contract" => {
                    contracts += 1;
                    ensure!(section.data() == expected, "stale ABI contract; rebuild the input");
                }
                "kandelo.common-memory.prototype" => bail!("already virtualized input"),
                "dylink" | "dylink.0" | "linking" =>
                    bail!("SDK common-memory requires a linked executable, not a side module or object"),
                _ => {}
            }
        }
    }
    ensure!(contracts == 1, "expected exactly one current kandelo.abi.contract section; rebuild through the SDK");
    scan(bytes)?;
    Ok(())
}

struct Access {
    name: &'static str,
    memarg: p::MemArg,
    values: Vec<V>,
    write: bool,
    atomic: bool,
    rights: u32,
    result: Option<V>,
}
fn classify(name: &'static str, memarg: p::MemArg) -> Result<Access> {
    ensure!(memarg.memory == 0, "multiple memories are not admitted");
    let atomic = name.contains("Atomic");
    let write = name.contains("Store") || name.contains("Rmw");
    let value_type = if name.starts_with("I64") {
        V::I64
    } else if name.starts_with("F32") {
        V::F32
    } else if name.starts_with("F64") {
        V::F64
    } else if name.starts_with("V128") {
        V::V128
    } else {
        V::I32
    };
    let values = if name == "MemoryAtomicWait32" {
        vec![V::I32, V::I64]
    } else if name == "MemoryAtomicWait64" {
        vec![V::I64, V::I64]
    } else if name == "MemoryAtomicNotify" {
        vec![V::I32]
    } else if name.contains("Cmpxchg") {
        vec![value_type, value_type]
    } else if write || name.ends_with("Lane") {
        vec![value_type]
    } else {
        vec![]
    };
    ensure!(
        name.contains("Load") || write || name.starts_with("MemoryAtomic"),
        "unclassified memory operation {name}"
    );
    Ok(Access {
        name,
        memarg,
        values,
        write,
        atomic,
        result: if write && !name.contains("Rmw") {
            None
        } else if name.starts_with("MemoryAtomic") {
            Some(V::I32)
        } else {
            Some(value_type)
        },
        rights: if name.contains("Rmw") {
            3
        } else if write {
            2
        } else {
            1
        },
    })
}
macro_rules! capture {
    ($name:expr, memarg => $m:expr $(, $rest:ident => $value:expr)*) => {
        Some(classify($name, *$m))
    };
    ($name:expr $(, $rest:ident => $value:expr)*) => {
        None
    };
}
macro_rules! accesses {
    ($(@$proposal:ident $op:ident $({ $($arg:ident: $argty:ty),* })? => $visit:ident ($($ann:tt)*))*) => {
        fn access(op: &O<'_>) -> Option<Result<Access>> {
            match op { $(O::$op $({ $($arg),* })? => {
                $( $(let _ = $arg;)* )?
                capture!(stringify!($op) $(, $($arg => $arg),*)?)
            },)* _ => None }
        }
    }
}
p::for_each_operator!(accesses);

struct ZeroOffset;
impl Reencode for ZeroOffset {
    type Error = anyhow::Error;
    fn mem_arg(&mut self, mut m: p::MemArg) -> R<enc::MemArg> {
        m.offset = 0;
        reencode::utils::mem_arg(self, m)
    }
}
struct AccessWrapper {
    access: Access,
    instruction: Vec<u8>,
    dynamic_offset: bool,
    constant_address: Option<u32>,
}
#[derive(Clone)]
struct RegionPlan {
    start: usize,
    end: usize,
    base: u32,
    length: u32,
    rights: u32,
    sites: u64,
}
fn operation_key(op: O<'_>) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reencode::RoundtripReencoder
        .instruction(op)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .encode(&mut bytes);
    Ok(bytes)
}
#[derive(Clone, Copy, Default)]
struct WrapperPolicy {
    canonical_alignment: bool,
    generic_large: bool,
}
struct WrapperEncoding {
    canonical_alignment: bool,
    zero_offset: bool,
}
impl Reencode for WrapperEncoding {
    type Error = anyhow::Error;
    fn mem_arg(&mut self, mut m: p::MemArg) -> R<enc::MemArg> {
        if self.canonical_alignment {
            m.align = m.max_align;
        }
        if self.zero_offset {
            m.offset = 0;
        }
        reencode::utils::mem_arg(self, m)
    }
}
impl WrapperPolicy {
    fn dynamic(self, a: &Access) -> bool {
        self.generic_large && !a.atomic && a.memarg.offset > 16
    }
    fn key(self, op: O<'_>, a: &Access) -> Result<Vec<u8>> {
        if !self.canonical_alignment && !self.generic_large {
            return operation_key(op);
        }
        let dynamic = self.dynamic(a);
        let mut bytes = vec![u8::from(dynamic)];
        WrapperEncoding {
            canonical_alignment: self.canonical_alignment && !a.atomic,
            zero_offset: dynamic,
        }
        .instruction(op)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .encode(&mut bytes);
        Ok(bytes)
    }
}
fn collect_wrappers(
    source: &[u8],
    policy: WrapperPolicy,
) -> Result<(Vec<AccessWrapper>, BTreeMap<Vec<u8>, u32>)> {
    collect_constant_wrappers(source, policy, &constant_addresses::Plan::default())
}
fn collect_constant_wrappers(
    source: &[u8],
    policy: WrapperPolicy,
    constants: &constant_addresses::Plan,
) -> Result<(Vec<AccessWrapper>, BTreeMap<Vec<u8>, u32>)> {
    let mut wrappers = Vec::new();
    let mut indices = BTreeMap::new();
    let mut function = constants.imported_functions;
    for payload in Parser::new(0).parse_all(source) {
        if let Payload::CodeSectionEntry(body) = payload? {
            let mut ops = body.get_operators_reader()?;
            let mut ordinal = 0;
            while !ops.eof() {
                let op = ops.read()?;
                if let Some(a) = access(&op) {
                    let a = a?;
                    let constant_address = constants.bind(function, ordinal, &a)?;
                    let mut instruction = Vec::new();
                    WrapperEncoding {
                        canonical_alignment: policy.canonical_alignment && !a.atomic,
                        zero_offset: true,
                    }
                    .instruction(op.clone())
                    .map_err(|e| anyhow::anyhow!("{e}"))?
                    .encode(&mut instruction);
                    let key = if let Some(address) = constant_address {
                        constant_addresses::key(address, &instruction)
                    } else {
                        policy.key(op.clone(), &a)?
                    };
                    if indices.contains_key(&key) {
                        ordinal += 1;
                        continue;
                    }
                    indices.insert(key, wrappers.len() as u32);
                    wrappers.push(AccessWrapper {
                        dynamic_offset: policy.dynamic(&a),
                        access: a,
                        instruction,
                        constant_address,
                    });
                }
                ordinal += 1;
            }
            function += 1;
        }
    }
    Ok((wrappers, indices))
}

struct Helper<'a> {
    bytes: &'a [u8],
    shape: Shape,
    type_base: u32,
    function_base: u32,
}
impl Reencode for Helper<'_> {
    type Error = anyhow::Error;
    fn type_index(&mut self, t: u32) -> R<u32> {
        Ok(self.type_base + t)
    }
    fn function_index(&mut self, f: u32) -> R<u32> {
        Ok(self.function_base + f)
    }
    fn global_index(&mut self, _: u32) -> R<u32> {
        Err(error(
            "helper code must not use module globals or a C shadow stack",
        ))
    }
}
struct Rewrite<'a> {
    source: Shape,
    helper: Helper<'a>,
    body_index: usize,
    zero_offset: bool,
    types_done: bool,
    functions_done: bool,
    globals_done: bool,
    exports_done: bool,
    data_count_done: bool,
    counts: BTreeMap<String, u64>,
    outlined: bool,
    conditional_commit: bool,
    fused_scalar_offset: Option<u64>,
    fused_bounds_i32: bool,
    fuse_atomics: bool,
    fused_sites: u64,
    atomic_fused_sites: u64,
    guard_objects: bool,
    object_functions: Vec<serde_json::Value>,
    object_rejections: BTreeMap<String, u64>,
    region_plans: BTreeMap<usize, Vec<RegionPlan>>,
    wrappers: Vec<AccessWrapper>,
    wrapper_indices: BTreeMap<Vec<u8>, u32>,
    wrapper_policy: WrapperPolicy,
    generic_sites: u64,
    constant_plan: constant_addresses::Plan,
    constant_static_sites: usize,
    cooperative_stop: bool,
    stop_polls: usize,
}
impl Rewrite<'_> {
    fn stop_poll(&mut self, function: &mut enc::Function) {
        // A native Wasm trap cannot be caught by a guest exception handler.
        // The host publishes its private retirement marker before revocation,
        // so the Worker wrapper can unwind without another guest syscall.
        function.instruction(&I::GlobalGet(self.root()));
        function.instruction(&I::I32AtomicLoad(enc::MemArg {
            offset: 56, align: 2, memory_index: 0,
        }));
        function.instruction(&I::I32Eqz);
        function.instruction(&I::If(enc::BlockType::Empty));
        function.instruction(&I::Unreachable);
        function.instruction(&I::End);
        self.stop_polls += 1;
    }
    fn root(&self) -> u32 {
        self.source.globals
    }
    fn scratch(&self) -> u32 {
        self.root() + 1
    }
    fn data_init(&self, segment: u32) -> u32 {
        self.helper.function_base + self.helper.shape.functions.len() as u32 + segment
    }
    fn init(&self) -> u32 {
        self.data_init(self.source.data)
    }
    fn helper_function(&self, name: &str) -> u32 {
        self.helper.function_base + self.helper.shape.exports[name].1
    }
    fn affine_cache_enabled(&self) -> bool {
        self.helper.shape.exports.contains_key("vm_affine_bind")
    }
    fn affine_function(&self) -> u32 {
        self.init() + 1 + self.wrappers.len() as u32
    }
    fn add_types(&mut self, ts: &mut enc::TypeSection) {
        for t in &self.helper.shape.types {
            ts.ty().function(
                t.params().iter().copied().map(val),
                t.results().iter().copied().map(val),
            );
        }
        ts.ty().function([V::I32], []);
        ts.ty().function([V::I32, V::I32, V::I32], []);
        for w in &self.wrappers {
            ts.ty().function(
                std::iter::once(V::I32)
                    .chain(w.access.values.iter().copied())
                    .chain(w.dynamic_offset.then_some(V::I64))
                    .collect::<Vec<_>>(),
                w.access.result,
            );
        }
        if self.affine_cache_enabled() {
            ts.ty()
                .function([V::I32, V::I64, V::I32, V::I32, V::I32], [V::I32]);
        }
        self.types_done = true;
    }
    fn add_functions(&mut self, fs: &mut enc::FunctionSection) {
        for t in &self.helper.shape.functions {
            fs.function(self.helper.type_base + t);
        }
        for _ in 0..self.source.data {
            fs.function(self.helper.type_base + self.helper.shape.types.len() as u32 + 1);
        }
        fs.function(self.helper.type_base + self.helper.shape.types.len() as u32);
        for i in 0..self.wrappers.len() {
            fs.function(
                self.helper.type_base + self.helper.shape.types.len() as u32 + 2 + i as u32,
            );
        }
        if self.affine_cache_enabled() {
            fs.function(
                self.helper.type_base
                    + self.helper.shape.types.len() as u32
                    + 2
                    + self.wrappers.len() as u32,
            );
        }
        self.functions_done = true;
    }
    fn fuse_scalar(&self, a: &Access) -> bool {
        if a.atomic {
            self.fuse_atomics && a.memarg.offset <= 16
        } else {
            !a.name.starts_with("V128")
                && self
                    .fused_scalar_offset
                    .is_some_and(|max| a.memarg.offset <= max)
        }
    }
    fn address_call(&self, a: &Access, f: &mut enc::Function, save_base: Option<u32>) {
        self.address_call_offset(a, f, save_base, None);
    }
    fn address_call_offset(
        &self,
        a: &Access,
        f: &mut enc::Function,
        save_base: Option<u32>,
        offset_local: Option<u32>,
    ) {
        f.instruction(&I::LocalGet(0));
        if let Some(base) = save_base {
            f.instruction(&I::LocalTee(base));
        }
        match offset_local {
            Some(local) => {
                f.instruction(&I::LocalGet(local));
            }
            None => {
                f.instruction(&I::I64Const(a.memarg.offset as i64));
            }
        }
        f.instruction(&I::I32Const(1 << a.memarg.max_align));
        if a.atomic {
            f.instruction(&I::I32Const(a.rights as i32));
        }
        f.instruction(&I::GlobalGet(self.root()));
        if !a.atomic {
            f.instruction(&I::GlobalGet(self.scratch()));
        }
        f.instruction(&I::Call(self.helper_function(if a.atomic {
            "vm_atomic_address"
        } else if a.write {
            "vm_write_address"
        } else {
            "vm_read_address"
        })));
    }
    fn fused_address(&self, a: &Access, f: &mut enc::Function, base: u32) {
        let p = base + 2;
        let entry = base + 3;
        let endpoint = base + 4;
        let width = 1u32 << a.memarg.max_align;
        let load = |offset| enc::MemArg {
            offset,
            align: 2,
            memory_index: 0,
        };
        // Only wrappers with a memory32-sized constant offset reach here.
        // The default checks an unsigned 64-bit endpoint before narrowing.
        // The opt-in page-index form rejects addition wrap explicitly.
        f.instruction(&I::GlobalGet(self.root()));
        f.instruction(&I::I32Eqz);
        f.instruction(&I::If(enc::BlockType::Empty));
        f.instruction(&I::Unreachable);
        f.instruction(&I::End);
        if !self.fused_bounds_i32 {
            f.instruction(&I::LocalGet(0));
            f.instruction(&I::I64ExtendI32U);
            f.instruction(&I::I64Const((a.memarg.offset + u64::from(width)) as i64));
            f.instruction(&I::I64Add);
            f.instruction(&I::LocalSet(endpoint));
            f.instruction(&I::LocalGet(endpoint));
            f.instruction(&I::GlobalGet(self.root()));
            f.instruction(&I::I32Load(load(0)));
            f.instruction(&I::I64ExtendI32U);
            f.instruction(&I::I64Const(16));
            f.instruction(&I::I64Shl);
            f.instruction(&I::I64GtU);
            f.instruction(&I::If(enc::BlockType::Empty));
            f.instruction(&I::Unreachable);
            f.instruction(&I::End);
        }
        f.instruction(&I::LocalGet(0));
        if a.memarg.offset != 0 {
            f.instruction(&I::I32Const(a.memarg.offset as i32));
            f.instruction(&I::I32Add);
        }
        if self.fused_bounds_i32 && a.memarg.offset != 0 {
            f.instruction(&I::LocalSet(p));
            // Wrapping base+offset can never address a valid memory32 byte.
            f.instruction(&I::LocalGet(p));
            f.instruction(&I::LocalGet(0));
            f.instruction(&I::I32LtU);
            f.instruction(&I::If(enc::BlockType::Empty));
            f.instruction(&I::Unreachable);
            f.instruction(&I::End);
            f.instruction(&I::LocalGet(p));
        } else {
            f.instruction(&I::LocalTee(p));
        }
        if a.atomic {
            // An aligned power-of-two atomic width divides a 64KiB page.
            // Reject misalignment before using that fact to omit split staging.
            f.instruction(&I::I32Const((width - 1) as i32));
            f.instruction(&I::I32And);
            f.instruction(&I::If(enc::BlockType::Empty));
            f.instruction(&I::Unreachable);
            f.instruction(&I::End);
        } else {
            f.instruction(&I::I32Const(65535));
            f.instruction(&I::I32And);
            f.instruction(&I::I32Const((65536 - width) as i32));
            f.instruction(&I::I32LeU);
            f.instruction(&I::If(enc::BlockType::Result(V::I32)));
        }
        if self.fused_bounds_i32 {
            // The width fits within this page. Comparing the page index
            // represents an exact 4GiB limit without narrowing it to i32.
            // Split accesses below retain the original full endpoint check.
            f.instruction(&I::LocalGet(p));
            f.instruction(&I::I32Const(16));
            f.instruction(&I::I32ShrU);
            f.instruction(&I::GlobalGet(self.root()));
            f.instruction(&I::I32Load(load(0)));
            f.instruction(&I::I32GeU);
            f.instruction(&I::If(enc::BlockType::Empty));
            f.instruction(&I::Unreachable);
            f.instruction(&I::End);
        }
        f.instruction(&I::GlobalGet(self.root()));
        f.instruction(&I::LocalGet(p));
        f.instruction(&I::I32Const(16));
        f.instruction(&I::I32ShrU);
        f.instruction(&I::I32Const(2));
        f.instruction(&I::I32Shl);
        f.instruction(&I::I32Add);
        f.instruction(&I::I32Load(load(64)));
        f.instruction(&I::LocalTee(entry));
        f.instruction(&I::I32Const(a.rights as i32));
        f.instruction(&I::I32And);
        f.instruction(&I::I32Const(a.rights as i32));
        f.instruction(&I::I32Ne);
        f.instruction(&I::If(enc::BlockType::Empty));
        f.instruction(&I::Unreachable);
        f.instruction(&I::End);
        f.instruction(&I::LocalGet(entry));
        f.instruction(&I::I32Const(-65536));
        f.instruction(&I::I32And);
        f.instruction(&I::I32Eqz);
        f.instruction(&I::If(enc::BlockType::Empty));
        f.instruction(&I::Unreachable);
        f.instruction(&I::End);
        f.instruction(&I::LocalGet(entry));
        f.instruction(&I::I32Const(-65536));
        f.instruction(&I::I32And);
        f.instruction(&I::LocalGet(p));
        f.instruction(&I::I32Const(65535));
        f.instruction(&I::I32And);
        f.instruction(&I::I32Or);
        if !a.atomic {
            f.instruction(&I::Else);
            // Preserve full split-page permission preflight and scatter staging.
            self.address_call(a, f, None);
            f.instruction(&I::End);
        }
    }
    fn access_wrapper(&self, wrapper: &AccessWrapper) -> enc::Function {
        let a = &wrapper.access;
        if let Some(address) = wrapper.constant_address {
            return constant_addresses::wrapper(address, a, &wrapper.instruction, self.root());
        }
        let offset_local = wrapper.dynamic_offset.then_some(1 + a.values.len() as u32);
        let base = 1 + a.values.len() as u32 + u32::from(wrapper.dynamic_offset);
        let fused = self.fuse_scalar(a);
        let mut f = if fused && self.fused_bounds_i32 {
            enc::Function::new([(4, V::I32)])
        } else if fused {
            enc::Function::new([(4, V::I32), (1, V::I64)])
        } else {
            enc::Function::new([(2, V::I32)])
        };
        let affine = self.affine_cache_enabled() && !a.atomic && !a.name.starts_with("V128");
        if self.helper.shape.exports.contains_key("vm_affine_observe") {
            // Observe the original virtual address, before any physical
            // translation or fault. The diagnostic never replaces the access.
            f.instruction(&I::LocalGet(0));
            match offset_local {
                Some(local) => {
                    f.instruction(&I::LocalGet(local));
                }
                None => {
                    f.instruction(&I::I64Const(a.memarg.offset as i64));
                }
            }
            f.instruction(&I::I32Const(1 << a.memarg.max_align));
            f.instruction(&I::I32Const(a.rights as i32));
            f.instruction(&I::GlobalGet(self.root()));
            f.instruction(&I::Call(self.helper_function("vm_affine_observe")));
        }
        if affine {
            if a.write {
                f.instruction(&I::LocalGet(0));
                f.instruction(&I::LocalSet(base));
            }
            f.instruction(&I::LocalGet(0));
            match offset_local {
                Some(local) => {
                    f.instruction(&I::LocalGet(local));
                }
                None => {
                    f.instruction(&I::I64Const(a.memarg.offset as i64));
                }
            }
            f.instruction(&I::I32Const(1 << a.memarg.max_align));
            f.instruction(&I::I32Const(a.rights as i32));
            f.instruction(&I::GlobalGet(self.root()));
            f.instruction(&I::Call(self.affine_function()));
            f.instruction(&I::LocalTee(base + 1));
            f.instruction(&I::I32Eqz);
            f.instruction(&I::If(enc::BlockType::Result(V::I32)));
        }
        if fused {
            if a.write {
                f.instruction(&I::LocalGet(0));
                f.instruction(&I::LocalSet(base));
            }
            self.fused_address(a, &mut f, base);
        } else {
            self.address_call_offset(
                a,
                &mut f,
                (a.write && !a.atomic).then_some(base),
                offset_local,
            );
        }
        if affine {
            f.instruction(&I::Else);
            f.instruction(&I::LocalGet(base + 1));
            f.instruction(&I::End);
        }
        if a.write && !a.atomic {
            f.instruction(&I::LocalTee(base + 1));
        }
        for i in 0..a.values.len() {
            f.instruction(&I::LocalGet(1 + i as u32));
        }
        f.raw(wrapper.instruction.iter().copied());
        if a.write && !a.atomic {
            if self.conditional_commit {
                f.instruction(&I::LocalGet(base + 1));
                f.instruction(&I::GlobalGet(self.scratch()));
                f.instruction(&I::I32Eq);
                f.instruction(&I::If(enc::BlockType::Empty));
            }
            f.instruction(&I::LocalGet(base));
            match offset_local {
                Some(local) => {
                    f.instruction(&I::LocalGet(local));
                }
                None => {
                    f.instruction(&I::I64Const(a.memarg.offset as i64));
                }
            }
            f.instruction(&I::I32Const(1 << a.memarg.max_align));
            f.instruction(&I::GlobalGet(self.root()));
            f.instruction(&I::GlobalGet(self.scratch()));
            f.instruction(&I::LocalGet(base + 1));
            f.instruction(&I::Call(self.helper_function("vm_write_commit")));
            if self.conditional_commit {
                f.instruction(&I::End);
            }
        }
        f.instruction(&I::End);
        f
    }
    fn add_globals(&mut self, gs: &mut enc::GlobalSection) {
        for _ in 0..2 {
            gs.global(
                enc::GlobalType {
                    val_type: V::I32,
                    mutable: true,
                    shared: false,
                },
                &enc::ConstExpr::i32_const(0),
            );
        }
        if self.affine_cache_enabled() {
            for value in affine_cache::TYPES {
                let init = if value == V::I64 {
                    enc::ConstExpr::i64_const(0)
                } else {
                    enc::ConstExpr::i32_const(0)
                };
                gs.global(affine_cache::global_type(value), &init);
            }
        }
        self.globals_done = true;
    }
    fn add_exports(&mut self, es: &mut enc::ExportSection) {
        es.export("__vm_root", enc::ExportKind::Global, self.root());
        es.export("__vm_scratch", enc::ExportKind::Global, self.scratch());
        es.export("__vm_initialize", enc::ExportKind::Func, self.init());
        es.export(
            "__vm_host_span",
            enc::ExportKind::Func,
            self.helper_function("vm_span"),
        );
        self.exports_done = true;
    }
    fn initialize(&self) -> enc::Function {
        let mut f = enc::Function::new([(3, V::I32)]); // fresh=0, offset=1, chunk=2, unused=3
        f.instruction(&I::GlobalGet(self.root()));
        f.instruction(&I::LocalGet(0));
        f.instruction(&I::Call(self.helper_function("vm_initialize_gate")));
        f.instruction(&I::If(enc::BlockType::Empty));
        for &(segment, base, length) in &self.source.active {
            f.instruction(&I::I32Const(base as i32));
            f.instruction(&I::I32Const(length as i32));
            f.instruction(&I::I32Const(2));
            f.instruction(&I::GlobalGet(self.root()));
            f.instruction(&I::Call(self.helper_function("vm_span")));
            f.instruction(&I::Drop);
            f.instruction(&I::I32Const(0));
            f.instruction(&I::LocalSet(1));
            f.instruction(&I::Block(enc::BlockType::Empty));
            f.instruction(&I::Loop(enc::BlockType::Empty));
            f.instruction(&I::LocalGet(1));
            f.instruction(&I::I32Const(length as i32));
            f.instruction(&I::I32GeU);
            f.instruction(&I::BrIf(1));
            f.instruction(&I::I32Const(65536));
            f.instruction(&I::I32Const(base as i32));
            f.instruction(&I::LocalGet(1));
            f.instruction(&I::I32Add);
            f.instruction(&I::I32Const(65535));
            f.instruction(&I::I32And);
            f.instruction(&I::I32Sub);
            f.instruction(&I::LocalSet(2));
            f.instruction(&I::LocalGet(2));
            f.instruction(&I::I32Const(length as i32));
            f.instruction(&I::LocalGet(1));
            f.instruction(&I::I32Sub);
            f.instruction(&I::I32GtU);
            f.instruction(&I::If(enc::BlockType::Empty));
            f.instruction(&I::I32Const(length as i32));
            f.instruction(&I::LocalGet(1));
            f.instruction(&I::I32Sub);
            f.instruction(&I::LocalSet(2));
            f.instruction(&I::End);
            f.instruction(&I::I32Const(base as i32));
            f.instruction(&I::LocalGet(1));
            f.instruction(&I::I32Add);
            f.instruction(&I::LocalGet(2));
            f.instruction(&I::I32Const(2));
            f.instruction(&I::GlobalGet(self.root()));
            f.instruction(&I::Call(self.helper_function("vm_span")));
            f.instruction(&I::LocalGet(1));
            f.instruction(&I::LocalGet(2));
            f.instruction(&I::MemoryInit {
                mem: 0,
                data_index: segment,
            });
            f.instruction(&I::LocalGet(1));
            f.instruction(&I::LocalGet(2));
            f.instruction(&I::I32Add);
            f.instruction(&I::LocalSet(1));
            f.instruction(&I::Br(0));
            f.instruction(&I::End);
            f.instruction(&I::End);
        }
        if let Some(start) = self.source.start {
            f.instruction(&I::Call(start));
        }
        f.instruction(&I::End);
        for &(segment, _, _) in &self.source.active {
            f.instruction(&I::DataDrop(segment));
        }
        f.instruction(&I::End);
        f
    }
    fn data_initializer(&self, segment: u32) -> enc::Function {
        let mut f = enc::Function::new([(1, V::I32)]);
        f.instruction(&I::LocalGet(0));
        f.instruction(&I::LocalGet(2));
        f.instruction(&I::GlobalGet(self.root()));
        f.instruction(&I::GlobalGet(self.scratch()));
        f.instruction(&I::Call(self.helper_function("vm_init_address")));
        f.instruction(&I::LocalTee(3));
        f.instruction(&I::LocalGet(1));
        f.instruction(&I::LocalGet(2));
        // Native memory.init retains exact data-segment bounds/drop semantics.
        f.instruction(&I::MemoryInit {
            mem: 0,
            data_index: segment,
        });
        f.instruction(&I::LocalGet(0));
        f.instruction(&I::I64Const(0));
        f.instruction(&I::LocalGet(2));
        f.instruction(&I::GlobalGet(self.root()));
        f.instruction(&I::GlobalGet(self.scratch()));
        f.instruction(&I::LocalGet(3));
        f.instruction(&I::Call(self.helper_function("vm_write_commit")));
        f.instruction(&I::End);
        f
    }
}
impl Reencode for Rewrite<'_> {
    type Error = anyhow::Error;
    fn mem_arg(&mut self, mut m: p::MemArg) -> R<enc::MemArg> {
        if self.zero_offset {
            m.offset = 0;
        }
        reencode::utils::mem_arg(self, m)
    }
    fn memory_type(&mut self, _: p::MemoryType) -> R<enc::MemoryType> {
        Ok(enc::MemoryType {
            minimum: 1,
            maximum: Some(65536),
            memory64: false,
            shared: true,
            page_size_log2: None,
        })
    }
    fn parse_type_section(
        &mut self,
        ts: &mut enc::TypeSection,
        reader: p::TypeSectionReader<'_>,
    ) -> R<()> {
        reencode::utils::parse_type_section(self, ts, reader)?;
        self.add_types(ts);
        Ok(())
    }
    fn parse_function_section(
        &mut self,
        fs: &mut enc::FunctionSection,
        reader: p::FunctionSectionReader<'_>,
    ) -> R<()> {
        reencode::utils::parse_function_section(self, fs, reader)?;
        self.add_functions(fs);
        Ok(())
    }
    fn parse_global_section(
        &mut self,
        gs: &mut enc::GlobalSection,
        reader: p::GlobalSectionReader<'_>,
    ) -> R<()> {
        reencode::utils::parse_global_section(self, gs, reader)?;
        self.add_globals(gs);
        Ok(())
    }
    fn parse_export_section(
        &mut self,
        es: &mut enc::ExportSection,
        reader: p::ExportSectionReader<'_>,
    ) -> R<()> {
        reencode::utils::parse_export_section(self, es, reader)?;
        self.add_exports(es);
        Ok(())
    }
    fn parse_data(&mut self, ds: &mut enc::DataSection, d: p::Data<'_>) -> R<()> {
        ds.passive(d.data.iter().copied());
        Ok(())
    }
    fn data_count(&mut self, _: u32) -> R<u32> {
        self.data_count_done = true;
        Ok(self.source.data)
    }
    fn intersperse_section_hook(
        &mut self,
        module: &mut enc::Module,
        _: Option<enc::SectionId>,
        before: Option<enc::SectionId>,
    ) -> R<()> {
        // Binary section IDs are not their order: tags precede globals and
        // data-count precedes code. Use the specification's section order.
        let next = before
            .map(|s| match s {
                enc::SectionId::Tag => 6,
                enc::SectionId::Global => 7,
                enc::SectionId::Export => 8,
                enc::SectionId::Start => 9,
                enc::SectionId::Element => 10,
                enc::SectionId::DataCount => 11,
                enc::SectionId::Code => 12,
                enc::SectionId::Data => 13,
                other => other as u8,
            })
            .unwrap_or(255);
        if !self.types_done && next > 1 {
            let mut ts = enc::TypeSection::new();
            self.add_types(&mut ts);
            module.section(&ts);
        }
        if !self.functions_done && next > 3 {
            let mut fs = enc::FunctionSection::new();
            self.add_functions(&mut fs);
            module.section(&fs);
        }
        if !self.globals_done && next > 7 {
            let mut gs = enc::GlobalSection::new();
            self.add_globals(&mut gs);
            module.section(&gs);
        }
        if !self.exports_done && next > 8 {
            let mut es = enc::ExportSection::new();
            self.add_exports(&mut es);
            module.section(&es);
        }
        if !self.data_count_done && (before == Some(enc::SectionId::Code) || before.is_none()) {
            module.section(&enc::DataCountSection {
                count: self.source.data,
            });
            self.data_count_done = true;
        }
        Ok(())
    }
    fn parse_code_section(
        &mut self,
        cs: &mut enc::CodeSection,
        reader: p::CodeSectionReader<'_>,
    ) -> R<()> {
        reencode::utils::parse_code_section(self, cs, reader)?;
        for payload in Parser::new(0).parse_all(self.helper.bytes) {
            if let Payload::CodeSectionEntry(body) = payload? {
                self.helper.parse_function_body(cs, body)?;
            }
        }
        for segment in 0..self.source.data {
            cs.function(&self.data_initializer(segment));
        }
        cs.function(&self.initialize());
        for wrapper in &self.wrappers {
            cs.function(&self.access_wrapper(wrapper));
        }
        if self.affine_cache_enabled() {
            cs.function(&affine_cache::function(
                self.root(),
                self.helper_function("vm_affine_bind"),
            ));
        }
        Ok(())
    }
    fn parse_function_body(
        &mut self,
        cs: &mut enc::CodeSection,
        body: p::FunctionBody<'_>,
    ) -> R<()> {
        let function = self.source.imported_functions as usize + self.body_index;
        let params = self.source.types[self.source.functions[function] as usize]
            .params()
            .len() as u32;
        self.body_index += 1;
        let object_plan = if self.guard_objects {
            match object_regions::analyze(
                &body,
                &self.source.types[self.source.functions[function] as usize],
            )
            .map_err(E::UserError)?
            {
                object_regions::Decision::Selected(plan) => {
                    self.object_functions.push(serde_json::json!({
                        "function":function,"baseLocal":plan.base,"spanBytes":plan.length,
                        "rights":plan.rights,"sites":plan.sites
                    }));
                    Some(plan)
                }
                object_regions::Decision::Rejected(reason) => {
                    *self.object_rejections.entry(reason.into()).or_default() += 1;
                    None
                }
            }
        } else {
            None
        };
        let regions = self
            .region_plans
            .get(&function)
            .cloned()
            .unwrap_or_default();
        let mut locals: Vec<_> = body
            .get_locals_reader()?
            .into_iter()
            .collect::<std::result::Result<_, _>>()?;
        let base = params + locals.iter().map(|(n, _)| *n).sum::<u32>();
        let types = [V::I32, V::I64, V::F32, V::F64, V::V128];
        let mut encoded: Vec<_> = locals.drain(..).map(|(n, t)| (n, val(t))).collect();
        if object_plan.is_some() || !regions.is_empty() {
            encoded.push((2, V::I32));
        }
        if !self.outlined {
            encoded.push((2, V::I32));
            for t in types {
                encoded.push((2, t));
            }
        }
        let temp = |t: V, slot: u32| {
            base + 2 + 2 * types.iter().position(|x| *x == t).unwrap() as u32 + slot
        };
        let mut f = enc::Function::new(encoded);
        if self.cooperative_stop { self.stop_poll(&mut f); }
        if let Some(plan) = &object_plan {
            f.instruction(&I::LocalGet(plan.base));
            f.instruction(&I::I32Const(plan.length as i32));
            f.instruction(&I::I32Const(plan.rights as i32));
            f.instruction(&I::GlobalGet(self.root()));
            f.instruction(&I::Call(self.helper_function("vm_try_span")));
            f.instruction(&I::LocalTee(base));
            let results = self.source.types[self.source.functions[function] as usize].results();
            f.instruction(&I::If(if results.is_empty() {
                enc::BlockType::Empty
            } else {
                enc::BlockType::Result(V::I32)
            }));
            let mut fast = body.get_operators_reader()?;
            while !fast.eof() {
                let op = fast.read()?;
                if matches!(op, O::End) && fast.eof() {
                    break;
                }
                if let Some(a) = access(&op) {
                    let a = a.map_err(E::UserError)?;
                    if a.write {
                        f.instruction(&I::LocalSet(base + 1));
                    }
                    // Discard only the proved address operand. Pointer values
                    // stored or compared by the original code stay canonical.
                    f.instruction(&I::Drop);
                    f.instruction(&I::LocalGet(base));
                    if a.write {
                        f.instruction(&I::LocalGet(base + 1));
                    }
                }
                f.instruction(&self.instruction(op)?);
            }
            f.instruction(&I::Else);
        }
        let mut ops = body.get_operators_reader()?;
        let mut ordinal = 0usize;
        let mut region_index = 0usize;
        let mut region_end = None;
        while !ops.eof() {
            if region_end == Some(ordinal) {
                f.instruction(&I::End);
                region_end = None;
            }
            if let Some(plan) = regions
                .get(region_index)
                .filter(|plan| plan.start == ordinal)
            {
                if region_end.is_some() {
                    return Err(error("overlapping region proof"));
                }
                // The proof starts/ends with an empty operand stack and has
                // no call/control edge. These physical temporaries are dead
                // before any possible fork, callback or mapping effect.
                f.instruction(&I::LocalGet(plan.base));
                f.instruction(&I::I32Const(plan.length as i32));
                f.instruction(&I::I32Const(plan.rights as i32));
                f.instruction(&I::GlobalGet(self.root()));
                f.instruction(&I::Call(self.helper_function("vm_try_span")));
                f.instruction(&I::LocalTee(base));
                f.instruction(&I::If(enc::BlockType::Empty));
                let mut fast = ops.clone();
                for _ in plan.start..plan.end {
                    let op = fast.read()?;
                    if let Some(a) = access(&op) {
                        let a = a.map_err(E::UserError)?;
                        if a.write {
                            f.instruction(&I::LocalSet(base + 1));
                        }
                        f.instruction(&I::Drop);
                        f.instruction(&I::LocalGet(base));
                        if a.write {
                            f.instruction(&I::LocalGet(base + 1));
                        }
                    }
                    // Keep source offsets and all non-address values. The
                    // successful guard proves the complete contiguous span.
                    f.instruction(&self.instruction(op)?);
                }
                f.instruction(&I::Else);
                region_end = Some(plan.end);
                region_index += 1;
            }
            let op = ops.read()?;
            ordinal += 1;
            if self.cooperative_stop && matches!(op, O::Loop { .. }) {
                f.instruction(&self.instruction(op)?);
                self.stop_poll(&mut f);
                continue;
            }
            if object_plan.is_some() && matches!(op, O::End) && ops.eof() {
                f.instruction(&I::End); // Close fast/slow selection before the original function end.
            }
            if let Some(a) = access(&op) {
                let a = a.map_err(E::UserError)?;
                *self.counts.entry(a.name.into()).or_default() += 1;
                if self.outlined {
                    if let Some(address) = self
                        .constant_plan
                        .bind(function, ordinal - 1, &a)
                        .map_err(E::UserError)?
                    {
                        let mut instruction = Vec::new();
                        WrapperEncoding {
                            canonical_alignment: false,
                            zero_offset: true,
                        }
                        .instruction(op)
                        .map_err(|e| error(&format!("{e}")))?
                        .encode(&mut instruction);
                        let key = constant_addresses::key(address, &instruction);
                        f.instruction(&I::Call(self.init() + 1 + self.wrapper_indices[&key]));
                        self.constant_static_sites += 1;
                        continue;
                    }
                    if self.fuse_scalar(&a) {
                        if a.atomic {
                            self.atomic_fused_sites += 1;
                        } else {
                            self.fused_sites += 1;
                        }
                    }
                    let key = self.wrapper_policy.key(op, &a).map_err(E::UserError)?;
                    if self.wrapper_policy.dynamic(&a) {
                        f.instruction(&I::I64Const(a.memarg.offset as i64));
                        self.generic_sites += 1;
                    }
                    f.instruction(&I::Call(self.init() + 1 + self.wrapper_indices[&key]));
                    continue;
                }
                for (i, t) in a.values.iter().enumerate().rev() {
                    f.instruction(&I::LocalSet(temp(*t, i as u32)));
                }
                if a.write && !a.atomic {
                    f.instruction(&I::LocalTee(base));
                }
                f.instruction(&I::I64Const(a.memarg.offset as i64));
                f.instruction(&I::I32Const(1 << a.memarg.max_align));
                if a.atomic {
                    f.instruction(&I::I32Const(a.rights as i32));
                }
                f.instruction(&I::GlobalGet(self.root()));
                if !a.atomic {
                    f.instruction(&I::GlobalGet(self.scratch()));
                }
                f.instruction(&I::Call(self.helper_function(if a.atomic {
                    "vm_atomic_address"
                } else if a.write {
                    "vm_write_address"
                } else {
                    "vm_read_address"
                })));
                if a.write && !a.atomic {
                    f.instruction(&I::LocalTee(base + 1));
                }
                for (i, t) in a.values.iter().enumerate() {
                    f.instruction(&I::LocalGet(temp(*t, i as u32)));
                }
                self.zero_offset = true;
                f.instruction(&self.instruction(op)?);
                self.zero_offset = false;
                if a.write && !a.atomic {
                    f.instruction(&I::LocalGet(base));
                    f.instruction(&I::I64Const(a.memarg.offset as i64));
                    f.instruction(&I::I32Const(1 << a.memarg.max_align));
                    f.instruction(&I::GlobalGet(self.root()));
                    f.instruction(&I::GlobalGet(self.scratch()));
                    f.instruction(&I::LocalGet(base + 1));
                    f.instruction(&I::Call(self.helper_function("vm_write_commit")));
                }
                continue;
            }
            match op {
                O::MemoryCopy {
                    dst_mem: 0,
                    src_mem: 0,
                } => {
                    f.instruction(&I::GlobalGet(self.root()));
                    f.instruction(&I::GlobalGet(self.scratch()));
                    f.instruction(&I::Call(self.helper_function("vm_copy")));
                    *self.counts.entry("MemoryCopy".into()).or_default() += 1;
                }
                O::MemoryFill { mem: 0 } => {
                    f.instruction(&I::GlobalGet(self.root()));
                    f.instruction(&I::Call(self.helper_function("vm_fill")));
                    *self.counts.entry("MemoryFill".into()).or_default() += 1;
                }
                O::MemorySize { mem: 0 } | O::MemoryGrow { mem: 0 } => {
                    let grow = matches!(op, O::MemoryGrow { .. });
                    f.instruction(&I::GlobalGet(self.root()));
                    f.instruction(&I::Call(self.helper_function(if grow {
                        "vm_grow"
                    } else {
                        "vm_size"
                    })));
                    *self
                        .counts
                        .entry(if grow { "MemoryGrow" } else { "MemorySize" }.into())
                        .or_default() += 1;
                }
                O::MemoryInit { mem: 0, data_index } => {
                    f.instruction(&I::Call(self.data_init(data_index)));
                    *self.counts.entry("MemoryInit".into()).or_default() += 1;
                }
                O::MemoryDiscard { .. } => return Err(error("memory.discard is not yet admitted")),
                _ => {
                    f.instruction(&self.instruction(op)?);
                }
            }
        }
        if region_end.is_some() || region_index != regions.len() {
            return Err(error("region proof does not match function operators"));
        }
        cs.function(&f);
        Ok(())
    }
}

fn instrument(
    source: &[u8],
    helpers: &[u8],
    outlined: bool,
    conditional_commit: bool,
    fused_scalar_offset: Option<u64>,
    fused_bounds_i32: bool,
    guard_objects: bool,
    fuse_atomics: bool,
    guard_regions: Option<u32>,
    observe_affine: bool,
    cache_affine: bool,
    wrapper_policy: WrapperPolicy,
    constant_addresses: bool,
    cooperative_stop: bool,
) -> Result<(Vec<u8>, serde_json::Value)> {
    p::Validator::new_with_features(p::WasmFeatures::all()).validate_all(source)?;
    p::Validator::new_with_features(p::WasmFeatures::all()).validate_all(helpers)?;
    let shape = scan(source)?;
    let helper_shape = scan(helpers)?;
    ensure!(!cooperative_stop || (!guard_objects && guard_regions.is_none() && !observe_affine),
        "cooperative stop does not support cloned fast paths or diagnostic root headers");
    ensure!(
        !constant_addresses
            || (outlined
                && !guard_objects
                && guard_regions.is_none()
                && !observe_affine
                && !cache_affine
                && !wrapper_policy.canonical_alignment
                && !wrapper_policy.generic_large
                && helper_shape.globals == 0
                && !helper_shape.exports.contains_key("vm_cache_slots")),
        "constant addresses require ordinary outlined helpers without regions, affine or wrapper-key policies"
    );
    ensure!(
        cache_affine == helper_shape.exports.contains_key("vm_affine_bind"),
        "affine cache option and private binder must be supplied together"
    );
    ensure!(
        !cache_affine
            || (outlined
                && !observe_affine
                && !guard_objects
                && guard_regions.is_none()
                && !fuse_atomics
                && !helper_shape.exports.contains_key("vm_cache_slots")
                && helper_shape.globals == 0),
        "affine cache requires scalar outlined accesses and exclusive root-header ownership"
    );
    ensure!(
        helper_shape.imported_functions == 0 && helper_shape.data == 0,
        "helpers must have no external function calls or static data"
    );
    ensure!(
        (guard_objects || guard_regions.is_some())
            == helper_shape.exports.contains_key("vm_try_span"),
        "object guard option and private vm_try_span helper must be supplied together"
    );
    ensure!(
        fused_scalar_offset.is_none() || !helper_shape.exports.contains_key("vm_cache_slots"),
        "fused scalars do not yet support mapping-cache helpers"
    );
    ensure!(
        observe_affine == helper_shape.exports.contains_key("vm_affine_observe"),
        "affine observation option and private helper must be supplied together"
    );
    ensure!(
        !observe_affine
            || (outlined
                && !conditional_commit
                && fused_scalar_offset.is_none()
                && !guard_objects
                && !fuse_atomics
                && guard_regions.is_none()
                && !helper_shape.exports.contains_key("vm_cache_slots")
                && helper_shape.globals == 0),
        "affine observation requires plain outlined accesses and a global-free private helper"
    );
    ensure!(
        !(wrapper_policy.canonical_alignment || wrapper_policy.generic_large) || outlined,
        "wrapper key policies require outlined accesses"
    );
    ensure!(
        !wrapper_policy.generic_large
            || (!guard_objects
                && guard_regions.is_none()
                && !observe_affine
                && !cache_affine
                && !fuse_atomics
                && fused_scalar_offset.is_none_or(|max| max <= 16)
                && !helper_shape.exports.contains_key("vm_cache_slots")),
        "generic large offsets currently support ordinary helpers and at most small scalar fusion, without guards/affine/atomic fusion"
    );
    let initial = shape.initial;
    let maximum = shape.maximum;
    let mut region_plans = BTreeMap::<usize, Vec<RegionPlan>>::new();
    if let Some(minimum) = guard_regions {
        let proof = common_memory_feasibility::analyze_regions(source)?;
        for r in proof["regions"].as_array().unwrap() {
            let sites = r["sites"].as_u64().unwrap();
            if sites < u64::from(minimum) {
                continue;
            }
            region_plans
                .entry(r["function"].as_u64().unwrap() as usize)
                .or_default()
                .push(RegionPlan {
                    start: r["startOrdinal"].as_u64().unwrap() as usize,
                    end: r["endOrdinal"].as_u64().unwrap() as usize,
                    base: r["baseLocal"].as_u64().unwrap() as u32,
                    length: r["spanBytes"].as_u64().unwrap() as u32,
                    rights: r["rights"].as_u64().unwrap() as u32,
                    sites,
                });
        }
    }
    let constant_plan = if constant_addresses {
        constant_addresses::Plan::analyze(source)?
    } else {
        constant_addresses::Plan::default()
    };
    ensure!(
        !constant_addresses
            || constant_plan.imported_functions == shape.imported_functions as usize,
        "constant analysis import inventory differs"
    );
    let (wrappers, wrapper_indices) = if outlined && constant_addresses {
        collect_constant_wrappers(source, wrapper_policy, &constant_plan)?
    } else if outlined {
        collect_wrappers(source, wrapper_policy)?
    } else {
        (Vec::new(), BTreeMap::new())
    };
    // Remove automatic startup so the host can bind the root before initialization.
    let mut stripped = enc::Module::new();
    for payload in Parser::new(0).parse_all(source) {
        let payload = payload?;
        if matches!(payload, Payload::StartSection { .. }) {
            continue;
        }
        if let Payload::CustomSection(ref s) = payload {
            if s.name().starts_with(".debug_")
                || s.name().starts_with("kandelo.calltypes")
                || s.name() == "kandelo.debug.lines"
            {
                continue;
            }
        }
        if let Some((id, range)) = payload.as_section() {
            stripped.section(&enc::RawSection {
                id,
                data: &source[range],
            });
        }
    }
    let helper = Helper {
        bytes: helpers,
        shape: helper_shape,
        type_base: shape.types.len() as u32,
        function_base: shape.functions.len() as u32,
    };
    let mut rewrite = Rewrite {
        source: shape,
        helper,
        body_index: 0,
        zero_offset: false,
        types_done: false,
        functions_done: false,
        globals_done: false,
        exports_done: false,
        data_count_done: false,
        counts: BTreeMap::new(),
        outlined,
        conditional_commit,
        fused_scalar_offset,
        fused_bounds_i32,
        fuse_atomics,
        fused_sites: 0,
        atomic_fused_sites: 0,
        guard_objects,
        object_functions: Vec::new(),
        object_rejections: BTreeMap::new(),
        region_plans,
        wrappers,
        wrapper_indices,
        wrapper_policy,
        generic_sites: 0,
        constant_plan,
        constant_static_sites: 0,
        cooperative_stop,
        stop_polls: 0,
    };
    let mut module = enc::Module::new();
    rewrite
        .parse_core_module(&mut module, Parser::new(0), &stripped.finish())
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    ensure!(
        rewrite.constant_static_sites == rewrite.constant_plan.sites.len(),
        "not every selected constant source site was rewritten"
    );
    let mut report = serde_json::json!({ "format": 1, "initialPages": initial, "maximumPages": maximum,
        "rootGlobal": rewrite.root(), "scratchGlobal": rewrite.scratch(), "sourceFunctions": rewrite.source.functions.len(),
        "rewritten": rewrite.counts, "initialization": "explicit __vm_initialize(1) for fresh image, (0) for copied fork image",
        "accessProfile": if outlined { "outlined" } else { "expanded" }, "accessWrappers": rewrite.wrappers.len(),
        "scope": "trusted one-Worker-per-process experimental memory32 modules; not production ABI admission" });
    if cooperative_stop {
        report["format"] = serde_json::json!(2);
        report["cooperativeStop"] = serde_json::json!(1);
        report["stopPolls"] = serde_json::json!(rewrite.stop_polls);
    }
    if conditional_commit {
        report["conditionalStoreCommit"] = serde_json::json!(true);
    }
    if cache_affine {
        report["affineCache"] = serde_json::json!({"version":1,"kind":"instance-globals-epoch-pages-v1","scalarOnly":true,"extraGlobals":affine_cache::TYPES.len(),"tryFunction":rewrite.affine_function(),"rootHeaderWords":[6,7,8,9,10,11],"scope":"RW private prefix and largest shared contiguous window; root/epoch/logical-page-count checks; original fallback; no live physical temporary across a fork-capable call. One Worker/root with published mapping invalidation, not concurrent remaps or mixed header-cache strategies."});
    }
    if observe_affine {
        report["accessDiagnostics"] = serde_json::json!({"version":1,"magic":0x4b564d31u32,"slots":65792,"functionBase":256,"kind":"affine-window-observer-v2"});
        report["affineDiagnostics"] = serde_json::json!({"version":2,"countSlots":{"144":"wrappedAttempts","151":"invalidVirtualRange","152":"epochDisabled","153":"geometryRefreshes","154":"livePteMismatch","156":"invalidPteOrPermission","157":"splitPageAttempts"},"maskHistogram":{"base":160,"bins":16,"bits":{"privatePrefix":1,"largestPrivate":2,"largestShared":4,"privatePlaneAddressMatch":8}},"gaugeSlots":{"224":"prefixFirstPage","225":"prefixPages","226":"prefixPhysicalBase","227":"prefixRights","228":"privateFirstPage","229":"privatePages","230":"privatePhysicalBase","231":"privateRights","232":"sharedFirstPage","233":"sharedPages","234":"sharedPhysicalBase","235":"sharedRights","236":"mappedPages","237":"privateMappedPages","238":"sharedMappedPages","239":"mappingRuns","240":"epoch","241":"virtualPages"},"scope":"Diagnostic wrapped scalar/SIMD/atomic attempted addresses only; bulk operations excluded. Live PTE checks remain. Largest contiguous windows selected by pages, not hotness. Gauges are last observed geometry, not cumulative counts. Private-plane counts are address-wise live-entry matches, not a whole-plane certificate. One Worker per root; metadata cache refreshes on epoch/page-count changes. No translation elision, lifetime certificate or timing claim."});
    }
    if guard_objects {
        report["guardedObjects"] = serde_json::json!({
            "scope":"whole call-free straight-line i32 functions; unchanged single local base; guard miss preserves original sequence",
            "maximumSpanBytes":object_regions::MAX_SPAN,
            "selectedFunctions":rewrite.object_functions.len(),
            "staticSites":rewrite.object_functions.iter().map(|p|p["sites"].as_u64().unwrap()).sum::<u64>(),
            "functions":rewrite.object_functions,"rejections":rewrite.object_rejections
        });
    }
    if let Some(minimum) = guard_regions {
        report["guardedRegions"] = serde_json::json!({
            "scope":"empty-stack straight-line i32 regions; unchanged local base; no calls/control/unknown effects; nonfaulting guard with original-order fallback",
            "minimumSites":minimum,
            "selectedFunctions":rewrite.region_plans.len(),
            "selectedRegions":rewrite.region_plans.values().map(Vec::len).sum::<usize>(),
            "staticSites":rewrite.region_plans.values().flatten().map(|p|p.sites).sum::<u64>()
        });
    }
    if let Some(max) = fused_scalar_offset {
        report["fusedScalars"] = serde_json::json!({"maximumOffset":max,
            "wrappers":rewrite.wrappers.iter().filter(|w|w.constant_address.is_none() && !w.access.atomic && rewrite.fuse_scalar(&w.access)).count(),
            "staticSites":rewrite.fused_sites,"atomics":false,"simd":false});
        if fused_bounds_i32 {
            report["fusedScalars"]["bounds"] = serde_json::json!("guarded-memory32-page-index");
        }
    }
    if fuse_atomics {
        report["fusedAtomics"] = serde_json::json!({"maximumOffset":16,
            "wrappers":rewrite.wrappers.iter().filter(|w|w.constant_address.is_none() && w.access.atomic && rewrite.fuse_scalar(&w.access)).count(),
            "staticSites":rewrite.atomic_fused_sites,"alignment":"checked before page-local resolution"});
    }
    if rewrite.helper.shape.exports.contains_key("vm_cache_slots") {
        report["mappingCache"] = serde_json::json!("epoch-root-header-v1");
    }
    if wrapper_policy.canonical_alignment || wrapper_policy.generic_large {
        report["wrapperKeyPolicy"] = serde_json::json!({"version":1,
            "canonicalNonAtomicAlignment":wrapper_policy.canonical_alignment,
            "genericNonAtomicOffsetAbove":if wrapper_policy.generic_large {Some(16)}else{None},
            "genericWrappers":rewrite.wrappers.iter().filter(|w|w.dynamic_offset).count(),
            "genericStaticSites":rewrite.generic_sites,
            "scope":"Optional code-shape experiment only. Generic offsets are original unsigned64-bit values, passed after address/value operands into unchanged checked helpers; small accesses remain specialized, atomics and opcode/lane identity stay exact. No bounds/permissions/split/alignment check elision."});
    }
    if constant_addresses {
        report["constantAddresses"] = serde_json::json!({"version":1,"producerVersion":2,
            "recognizedSites":rewrite.constant_plan.recognized,"rejected":rewrite.constant_plan.rejected,
            "staticSites":rewrite.constant_static_sites,
            "wrappers":rewrite.wrappers.iter().filter(|w|w.constant_address.is_some()).count(),
            "scope":"Validated source function/operator binding; modular i32 producers then unsigned memarg addition; proved single-page range/alignment only. Per-access current root/logical bound/live PTE/rights and original payload operation remain. No physical/payload cache, cross-call lifetime certificate, data-ownership assumption or production ABI change."});
    }
    module.section(&enc::CustomSection {
        name: Cow::Borrowed("kandelo.common-memory.prototype"),
        data: Cow::Owned(serde_json::to_vec(&report)?),
    });
    let output = module.finish();
    p::Validator::new_with_features(p::WasmFeatures::all())
        .validate_all(&output)
        .context("validating translated output")?;
    if guard_regions.is_some() {
        // Detailed plans belong in the external report, not every runtime
        // module's admission metadata or its download/compilation footprint.
        report["regionPlans"] = serde_json::json!(rewrite.region_plans.iter().flat_map(|(function,plans)|plans.iter().map(move |p|serde_json::json!({"function":function,"startOrdinal":p.start,"endOrdinal":p.end,"baseLocal":p.base,"spanBytes":p.length,"rights":p.rights,"sites":p.sites}))).collect::<Vec<_>>());
    }
    if constant_addresses {
        report["constantPlans"] = serde_json::json!(rewrite.constant_plan.detail());
    }
    Ok((output, report))
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() == 4 && args[1] == "--check-sdk-input" {
        check_sdk_input(&fs::read(&args[2])?, args[3].to_str().context("invalid ABI digest")?)?;
        return Ok(());
    }
    if args.len() == 3 && args[1] == "--inspect-function-exports" {
        let bytes = fs::read(&args[2])?;
        p::Validator::new_with_features(p::WasmFeatures::all()).validate_all(&bytes)?;
        let shape = scan(&bytes)?;
        let exports: BTreeMap<_, _> = shape
            .exports
            .into_iter()
            .filter_map(|(name, (kind, index))| {
                (kind == p::ExternalKind::Func).then_some((name, index))
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&exports)?);
        return Ok(());
    }
    ensure!(
        args.len() >= 4,
        "usage: common-memory-program-instrument INPUT HELPERS OUTPUT [--outline-accesses] [--conditional-commit] [--fuse-scalars=zero|small|all] [--fused-bounds=i32] [--guard-object-functions] [--fuse-atomics] [--guard-regions=2|4|8|16] [--observe-affine] [--canonicalize-nonatomic-alignment] [--generic-large-offsets] [--constant-addresses]"
    );
    let flags = &args[4..];
    ensure!(
        flags.iter().all(|f| matches!(
            f.to_str(),
            Some(
                "--outline-accesses"
                    | "--conditional-commit"
                    | "--fuse-scalars=zero"
                    | "--fuse-scalars=small"
                    | "--fuse-scalars=all"
                    | "--fused-bounds=i32"
                    | "--guard-object-functions"
                    | "--fuse-atomics"
                    | "--guard-regions=2"
                    | "--guard-regions=4"
                    | "--guard-regions=8"
                    | "--guard-regions=16"
                    | "--observe-affine"
                    | "--cache-affine-windows"
                    | "--canonicalize-nonatomic-alignment"
                    | "--generic-large-offsets"
                    | "--constant-addresses"
                    | "--cooperative-stop-v1"
            )
        )),
        "unknown instrumentation option"
    );
    let outlined = flags.iter().any(|f| f == "--outline-accesses");
    let conditional_commit = flags.iter().any(|f| f == "--conditional-commit");
    let fused_bounds_i32 = flags.iter().any(|f| f == "--fused-bounds=i32");
    let guard_objects = flags.iter().any(|f| f == "--guard-object-functions");
    let fuse_atomics = flags.iter().any(|f| f == "--fuse-atomics");
    let observe_affine = flags.iter().any(|f| f == "--observe-affine");
    let cache_affine = flags.iter().any(|f| f == "--cache-affine-windows");
    let constant_addresses = flags.iter().any(|f| f == "--constant-addresses");
    let cooperative_stop = flags.iter().any(|f| f == "--cooperative-stop-v1");
    let wrapper_policy = WrapperPolicy {
        canonical_alignment: flags
            .iter()
            .any(|f| f == "--canonicalize-nonatomic-alignment"),
        generic_large: flags.iter().any(|f| f == "--generic-large-offsets"),
    };
    let guard_regions = flags.iter().find_map(|f| {
        f.to_str()
            .and_then(|s| s.strip_prefix("--guard-regions="))
            .map(|s| s.parse::<u32>().unwrap())
    });
    let fused_scalar_offset = flags.iter().find_map(|f| match f.to_str() {
        Some("--fuse-scalars=zero") => Some(0),
        Some("--fuse-scalars=small") => Some(16),
        Some("--fuse-scalars=all") => Some(u64::from(u32::MAX)),
        _ => None,
    });
    ensure!(
        flags.len()
            == usize::from(outlined)
                + usize::from(conditional_commit)
                + usize::from(fused_scalar_offset.is_some())
                + usize::from(fused_bounds_i32)
                + usize::from(guard_objects)
                + usize::from(fuse_atomics)
                + usize::from(guard_regions.is_some())
                + usize::from(observe_affine)
                + usize::from(cache_affine)
                + usize::from(wrapper_policy.canonical_alignment)
                + usize::from(wrapper_policy.generic_large)
                + usize::from(constant_addresses)
                + usize::from(cooperative_stop),
        "duplicate instrumentation option"
    );
    ensure!(
        !conditional_commit || outlined,
        "conditional commit requires outlined accesses"
    );
    ensure!(
        fused_scalar_offset.is_none() || outlined,
        "fused scalars require outlined accesses"
    );
    ensure!(
        !fused_bounds_i32 || fused_scalar_offset.is_some(),
        "i32 bounds require fused scalars"
    );
    ensure!(
        !guard_objects || outlined,
        "object guards require outlined accesses"
    );
    ensure!(
        !fuse_atomics || outlined,
        "atomic fusion requires outlined accesses"
    );
    ensure!(
        guard_regions.is_none() || outlined,
        "regional guards require outlined accesses"
    );
    ensure!(
        guard_regions.is_none() || !guard_objects,
        "regional and whole-function guards are separate experiments"
    );
    let (bytes, report) = instrument(
        &fs::read(&args[1])?,
        &fs::read(&args[2])?,
        outlined,
        conditional_commit,
        fused_scalar_offset,
        fused_bounds_i32,
        guard_objects,
        fuse_atomics,
        guard_regions,
        observe_affine,
        cache_affine,
        wrapper_policy,
        constant_addresses,
        cooperative_stop,
    )?;
    fs::write(&args[3], bytes)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[cfg(test)]
mod wrapper_policy_tests {
    use super::*;
    fn sdk_program(digest: Option<&[u8]>, other: Option<&str>) -> Vec<u8> {
        let mut module = wat::parse_str("(module (import \"env\" \"memory\" (memory 2 65536 shared)))").unwrap();
        for (name, data) in digest.map(|d| ("kandelo.abi.contract", d)).into_iter()
            .chain(other.map(|name| (name, &[][..]))) {
            let section = enc::CustomSection { name: Cow::Borrowed(name), data: Cow::Borrowed(data) };
            module.push(0);
            section.encode(&mut module);
        }
        module
    }
    #[test]
    fn sdk_admission_requires_exact_contract_and_executable() {
        let digest = "42".repeat(32);
        assert!(check_sdk_input(&sdk_program(Some(&[0x42; 32]), None), &digest).is_ok());
        for bytes in [sdk_program(None, None), sdk_program(Some(&[0x43; 32]), None),
            sdk_program(Some(&[0x42; 32]), Some("dylink.0")),
            sdk_program(Some(&[0x42; 32]), Some("kandelo.common-memory.prototype"))] {
            assert!(check_sdk_input(&bytes, &digest).is_err());
        }
        assert!(check_sdk_input(&sdk_program(Some(&[0x42; 32]), None), "bad").is_err());
    }
    fn mem(offset: u64, align: u8) -> p::MemArg {
        p::MemArg {
            offset,
            align,
            max_align: 2,
            memory: 0,
        }
    }
    fn key(op: O<'_>, policy: WrapperPolicy) -> Vec<u8> {
        let a = access(&op).unwrap().unwrap();
        policy.key(op, &a).unwrap()
    }
    #[test]
    fn generic_and_specialized_signatures_do_not_collide() {
        let p = WrapperPolicy {
            generic_large: true,
            ..Default::default()
        };
        let a = O::I32Load { memarg: mem(0, 2) };
        let b = O::I32Load { memarg: mem(32, 2) };
        let c = O::I32Load {
            memarg: mem(u64::MAX, 2),
        };
        assert_ne!(key(a, p), key(b.clone(), p));
        assert_eq!(key(b, p), key(c, p));
    }
    #[test]
    fn hints_normalize_but_atomic_keys_stay_exact() {
        let p = WrapperPolicy {
            canonical_alignment: true,
            generic_large: true,
        };
        assert_eq!(
            key(O::I32Load { memarg: mem(32, 0) }, p),
            key(O::I32Load { memarg: mem(64, 2) }, p)
        );
        assert_ne!(
            key(O::I32AtomicLoad { memarg: mem(32, 2) }, p),
            key(O::I32AtomicLoad { memarg: mem(64, 2) }, p)
        );
    }
    #[test]
    fn generic_simd_lanes_and_value_signatures_stay_separate() {
        let p = WrapperPolicy {
            canonical_alignment: true,
            generic_large: true,
        };
        assert_ne!(
            key(
                O::V128Load32Lane {
                    memarg: mem(32, 0),
                    lane: 0
                },
                p
            ),
            key(
                O::V128Load32Lane {
                    memarg: mem(64, 0),
                    lane: 1
                },
                p
            )
        );
        assert_ne!(
            key(O::I32Load { memarg: mem(32, 2) }, p),
            key(O::I32Store { memarg: mem(64, 2) }, p)
        );
    }
    #[test]
    fn original_instruction_inventory_joins_mixed_keys() {
        let b=wat::parse_str(r#"(module(import "env" "memory"(memory 2 10 shared))
          (func(param i32) local.get 0 i32.load drop local.get 0 i32.load offset=32 align=1 drop
           local.get 0 i32.load offset=64 align=4 drop local.get 0 i32.const 7 i32.store offset=32))"#).unwrap();
        let (original, _) = collect_wrappers(&b, WrapperPolicy::default()).unwrap();
        assert_eq!(original.len(), 4);
        let (wrappers, _) = collect_wrappers(
            &b,
            WrapperPolicy {
                canonical_alignment: true,
                generic_large: true,
            },
        )
        .unwrap();
        assert_eq!(wrappers.len(), 3);
        assert_eq!(wrappers.iter().filter(|w| w.dynamic_offset).count(), 2);
    }

    #[test]
    fn constant_wrappers_share_effective_addresses_without_aliasing_fallbacks() {
        let source = wat::parse_str(
            r#"(module(import "env" "memory"(memory 2 65536 shared))
            (func(param i32) i32.const 64 i32.load drop
                i32.const 48 i32.load offset=16 drop
                local.get 0 i32.load drop i32.const 65534 i32.load drop
                i32.const 3 i32.const 1 i32.atomic.rmw.add drop))"#,
        )
        .unwrap();
        let plan = constant_addresses::Plan::analyze(&source).unwrap();
        assert_eq!(plan.sites.len(), 2);
        let (wrappers, _) =
            collect_constant_wrappers(&source, WrapperPolicy::default(), &plan).unwrap();
        assert_eq!(wrappers.len(), 3);
        assert_eq!(
            wrappers
                .iter()
                .filter(|w| w.constant_address == Some(64))
                .count(),
            1
        );
        assert_eq!(
            wrappers
                .iter()
                .filter(|w| w.constant_address.is_none())
                .count(),
            2
        );
    }
}

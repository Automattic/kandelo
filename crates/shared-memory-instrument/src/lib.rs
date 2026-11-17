//! Opt-in memory32 address translation for trusted process groups.
use anyhow::{Context, Result, bail, ensure};
use std::{borrow::Cow, collections::BTreeMap};
use wasm_encoder::{
    self as enc, Encode, Instruction as I, ValType as V,
    reencode::{self, Reencode},
};
use wasmparser::{self as p, Operator as O, Parser, Payload};

use sha2::{Digest, Sha256};

use wasm_posix_program_abi::program_extensions::memory_group_v3 as layout;
pub const ARTIFACT_SECTION: &str = layout::SECTION;
pub const EXTENSION_MODULE: &str = layout::MODULE;
pub const EXTENSION_IMPORT: &str = layout::IMPORT;

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
                            "__vm_replica",
                            "__vm_checkpoint",
                            "__vm_worker_wait32",
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
pub fn check_sdk_input(bytes: &[u8], digest: &str) -> Result<()> {
    ensure!(
        digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()),
        "expected a 32-byte ABI contract digest"
    );
    let expected = (0..32)
        .map(|i| u8::from_str_radix(&digest[i * 2..i * 2 + 2], 16))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    p::Validator::new_with_features(p::WasmFeatures::all()).validate_all(bytes)?;
    ensure!(
        wasm_artifact::read_abi_version(bytes) == Some(wasm_posix_program_abi::ABI_VERSION as i32),
        "input must declare the current program ABI"
    );
    let mut contracts = 0;
    for payload in Parser::new(0).parse_all(bytes) {
        if let Payload::CustomSection(section) = payload? {
            match section.name() {
                "kandelo.abi.contract" => {
                    contracts += 1;
                    ensure!(
                        section.data() == expected,
                        "stale ABI contract; rebuild the input"
                    );
                }
                "kandelo.common-memory.prototype" | ARTIFACT_SECTION => {
                    bail!("already virtualized input")
                }
                "dylink" | "dylink.0" | "linking" => bail!(
                    "grouped translation requires a linked executable, not a side module or object"
                ),
                _ => {}
            }
        }
    }
    ensure!(
        contracts == 1,
        "expected exactly one current kandelo.abi.contract section; rebuild through the SDK"
    );
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
}
fn operation_key(op: O<'_>) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reencode::RoundtripReencoder
        .instruction(op)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .encode(&mut bytes);
    Ok(bytes)
}
fn collect_wrappers(source: &[u8]) -> Result<(Vec<AccessWrapper>, BTreeMap<Vec<u8>, u32>)> {
    let mut wrappers = Vec::new();
    let mut indices = BTreeMap::new();
    for payload in Parser::new(0).parse_all(source) {
        if let Payload::CodeSectionEntry(body) = payload? {
            let mut ops = body.get_operators_reader()?;
            while !ops.eof() {
                let op = ops.read()?;
                if let Some(access) = access(&op) {
                    let access = access?;
                    let key = operation_key(op.clone())?;
                    if indices.contains_key(&key) {
                        continue;
                    }
                    let mut instruction = Vec::new();
                    ZeroOffset
                        .instruction(op)
                        .map_err(|e| anyhow::anyhow!("{e}"))?
                        .encode(&mut instruction);
                    indices.insert(key, wrappers.len() as u32);
                    wrappers.push(AccessWrapper {
                        access,
                        instruction,
                    });
                }
            }
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
    types_done: bool,
    functions_done: bool,
    globals_done: bool,
    exports_done: bool,
    data_count_done: bool,
    counts: BTreeMap<String, u64>,
    wrappers: Vec<AccessWrapper>,
    wrapper_indices: BTreeMap<Vec<u8>, u32>,
    stop_polls: usize,
}
impl Rewrite<'_> {
    fn stop_poll(&mut self, function: &mut enc::Function) {
        // Only source-function entries and source loop headers call this.
        // Appended address/queue helpers finish before a source safe point;
        // physical address temporaries never survive this call.
        function.instruction(&I::GlobalGet(self.root()));
        function.instruction(&I::GlobalGet(self.replica()));
        function.instruction(&I::Call(self.helper_function("vm_checkpoint")));
        self.stop_polls += 1;
    }
    fn root(&self) -> u32 {
        self.source.globals
    }
    fn scratch(&self) -> u32 {
        self.root() + 1
    }
    fn replica(&self) -> u32 {
        self.root() + 2
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
                    .collect::<Vec<_>>(),
                w.access.result,
            );
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
        self.functions_done = true;
    }
    fn access_wrapper(&self, wrapper: &AccessWrapper) -> enc::Function {
        let a = &wrapper.access;
        let mut f = enc::Function::new([(2, V::I32)]);
        let base = 1 + a.values.len() as u32;
        f.instruction(&I::LocalGet(0));
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
        for i in 0..a.values.len() {
            f.instruction(&I::LocalGet(1 + i as u32));
        }
        match a.name {
            "MemoryAtomicWait32" | "MemoryAtomicWait64" => {
                f.instruction(&I::GlobalGet(self.root()));
                f.instruction(&I::GlobalGet(self.replica()));
                f.instruction(&I::Call(self.helper_function(
                    if a.name == "MemoryAtomicWait32" {
                        "vm_wait32"
                    } else {
                        "vm_wait64"
                    },
                )));
            }
            "MemoryAtomicNotify" => {
                f.instruction(&I::Call(self.helper_function("vm_notify")));
            }
            _ => {
                f.raw(wrapper.instruction.iter().copied());
            }
        }
        if a.write && !a.atomic {
            f.instruction(&I::LocalGet(base));
            f.instruction(&I::I64Const(a.memarg.offset as i64));
            f.instruction(&I::I32Const(1 << a.memarg.max_align));
            f.instruction(&I::GlobalGet(self.root()));
            f.instruction(&I::GlobalGet(self.scratch()));
            f.instruction(&I::LocalGet(base + 1));
            f.instruction(&I::Call(self.helper_function("vm_write_commit")));
        }
        f.instruction(&I::End);
        f
    }
    fn add_globals(&mut self, gs: &mut enc::GlobalSection) {
        for _ in 0..3 {
            gs.global(
                enc::GlobalType {
                    val_type: V::I32,
                    mutable: true,
                    shared: false,
                },
                &enc::ConstExpr::i32_const(0),
            );
        }
        self.globals_done = true;
    }
    fn add_exports(&mut self, es: &mut enc::ExportSection) {
        es.export("__vm_root", enc::ExportKind::Global, self.root());
        es.export("__vm_scratch", enc::ExportKind::Global, self.scratch());
        es.export("__vm_replica", enc::ExportKind::Global, self.replica());
        es.export("__vm_checkpoint", enc::ExportKind::Func, self.helper_function("vm_checkpoint"));
        es.export("__vm_worker_wait32", enc::ExportKind::Func, self.helper_function("vm_worker_wait32"));
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
        f.instruction(&I::GlobalGet(self.replica()));
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
        Ok(())
    }
    fn parse_function_body(
        &mut self,
        cs: &mut enc::CodeSection,
        body: p::FunctionBody<'_>,
    ) -> R<()> {
        let locals = body
            .get_locals_reader()?
            .into_iter()
            .map(|r| r.map(|(n, t)| (n, val(t))))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut f = enc::Function::new(locals);
        self.stop_poll(&mut f);
        let mut ops = body.get_operators_reader()?;
        while !ops.eof() {
            let op = ops.read()?;
            if matches!(op, O::Loop { .. }) {
                f.instruction(&self.instruction(op)?);
                self.stop_poll(&mut f);
                continue;
            }
            if let Some(a) = access(&op) {
                let a = a.map_err(E::UserError)?;
                *self.counts.entry(a.name.into()).or_default() += 1;
                let key = operation_key(op).map_err(E::UserError)?;
                f.instruction(&I::Call(self.init() + 1 + self.wrapper_indices[&key]));
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
        cs.function(&f);
        Ok(())
    }
}
fn check_compiled_helper_layout(bytes: &[u8], shape: &Shape) -> Result<()> {
    let bodies = Parser::new(0)
        .parse_all(bytes)
        .filter_map(|payload| match payload {
            Ok(Payload::CodeSectionEntry(body)) => Some(Ok(body)),
            Err(error) => Some(Err(error)),
            _ => None,
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    // Helpers have no imported functions. Validate bodies without executing
    // arbitrary code or constructing a shared memory in the build process.
    for (name, expected) in layout::WIRE {
        let export = format!("vm_layout_{name}");
        let Some(&(p::ExternalKind::Func, index)) = shape.exports.get(&export) else {
            bail!("compiled helper layout is missing marker {name}; rebuild helpers");
        };
        let function_type = &shape.types[shape.functions[index as usize] as usize];
        ensure!(
            function_type.params().is_empty() && function_type.results() == [p::ValType::I32],
            "compiled helper layout marker {name} has an invalid signature; rebuild helpers"
        );
        let body = &bodies[index as usize];
        ensure!(
            body.get_locals_reader()?.get_count() == 0,
            "compiled helper layout marker {name} has locals; rebuild helpers"
        );
        let mut operators = body.get_operators_reader()?;
        ensure!(
            matches!(operators.read()?, O::I32Const { value } if value as u32 == *expected)
                && matches!(operators.read()?, O::End)
                && operators.eof(),
            "compiled helper layout marker {name} differs from the translator declaration; rebuild helpers"
        );
    }
    Ok(())
}

/// Translate one already stamped, fork-prepared SDK executable. Ordinary
/// hosts refuse the required versioned import before attempting to execute it.
pub fn translate(
    source: &[u8],
    helpers: &[u8],
    digest: &str,
) -> Result<(Vec<u8>, serde_json::Value)> {
    check_sdk_input(source, digest)?;
    p::Validator::new_with_features(p::WasmFeatures::all()).validate_all(helpers)?;
    let shape = scan(source)?;
    let helper_shape = scan(helpers)?;
    ensure!(
        helper_shape.imported_functions == 0
            && helper_shape.data == 0
            && helper_shape.globals == 0
            && helper_shape.start.is_none(),
        "helpers must be freestanding and have no static data, globals or startup"
    );
    ensure!(
        helper_shape
            .exports
            .keys()
            .all(|name| name == "memory" || REQUIRED_HELPERS.contains(&name.as_str())
                || layout::WIRE.iter().any(|(key, _)| name == &format!("vm_layout_{key}"))),
        "unexpected helper export"
    );
    for name in REQUIRED_HELPERS {
        ensure!(
            helper_shape
                .exports
                .get(*name)
                .is_some_and(|(kind, _)| *kind == p::ExternalKind::Func),
            "missing helper {name}"
        );
    }
    check_compiled_helper_layout(helpers, &helper_shape)?;
    let initial = shape.initial;
    let maximum = shape.maximum;
    let (wrappers, wrapper_indices) = collect_wrappers(source)?;
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
                || s.name() == "kandelo.build.key"
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
        type_base: shape.types.len() as u32,
        function_base: shape.functions.len() as u32,
        shape: helper_shape,
    };
    let mut rewrite = Rewrite {
        source: shape,
        helper,
        types_done: false,
        functions_done: false,
        globals_done: false,
        exports_done: false,
        data_count_done: false,
        counts: BTreeMap::new(),
        wrappers,
        wrapper_indices,
        stop_polls: 0,
    };
    let mut module = enc::Module::new();
    rewrite
        .parse_core_module(&mut module, Parser::new(0), &stripped.finish())
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let report = serde_json::json!({"version":layout::VERSION,"layout":layout::LAYOUT,"threadAttach":2,"cooperativeStop":3,"executionBarrier":1,"orderedWaitQueue":2,
        "initialPages":initial,"maximumPages":maximum,"accessProfile":"outlined","accessWrappers":rewrite.wrappers.len(),
        "rewritten":rewrite.counts,"stopPolls":rewrite.stop_polls,
        "sourceSha256":format!("{:x}",Sha256::digest(source)),"helpersSha256":format!("{:x}",Sha256::digest(helpers))});
    module.section(&enc::CustomSection {
        name: Cow::Borrowed(ARTIFACT_SECTION),
        data: Cow::Owned(serde_json::to_vec(&report)?),
    });
    let output = require_extension(&module.finish())?;
    p::Validator::new_with_features(p::WasmFeatures::all())
        .validate_all(&output)
        .context("validating grouped output")?;
    Ok((output, report))
}
const REQUIRED_HELPERS: &[&str] = &[
    "vm_checkpoint",
    "vm_span",
    "vm_read_address",
    "vm_write_address",
    "vm_write_commit",
    "vm_init_address",
    "vm_atomic_address",
    "vm_copy",
    "vm_fill",
    "vm_size",
    "vm_initialize_gate",
    "vm_grow",
    "vm_wait32",
    "vm_wait64",
    "vm_worker_wait32",
    "vm_notify",
];

// Give the existing memory import a required, versioned namespace. No index
// changes: fork custom sections keep their function/global/table identities.
struct RequiredExtension;
impl Reencode for RequiredExtension {
    type Error = anyhow::Error;
    fn parse_import_section(
        &mut self,
        section: &mut enc::ImportSection,
        reader: p::ImportSectionReader<'_>,
    ) -> R<()> {
        for import in reader.into_imports() {
            let import = import?;
            let memory = matches!(import.ty, p::TypeRef::Memory(_));
            section.import(
                if memory {
                    EXTENSION_MODULE
                } else {
                    import.module
                },
                if memory {
                    EXTENSION_IMPORT
                } else {
                    import.name
                },
                self.entity_type(import.ty)?,
            );
        }
        Ok(())
    }
}
fn require_extension(source: &[u8]) -> Result<Vec<u8>> {
    let mut module = enc::Module::new();
    RequiredExtension
        .parse_core_module(&mut module, Parser::new(0), source)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(module.finish())
}

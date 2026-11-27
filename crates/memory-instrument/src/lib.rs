//! Software page-table translation for wasm32 linear memory.
//!
//! Wasm has no MMU: a pointer value is the linear-memory offset. This rewrite
//! routes every load, store, atomic and bulk-memory instruction through a
//! per-process page table so a runtime can place one process's virtual pages
//! anywhere in a larger physical memory and share pages copy-on-write.
//!
//! Each 64 KiB virtual page has one 4-byte entry in a read table, holding
//! `physical - virtual`, and one in a write table, holding the same delta plus
//! a copy-on-write flag in its low bits. A zero entry is the identity mapping,
//! so zero-filled tables need no initialization. The exported
//! `__memory_table_base` global holds the physical address of the tables and
//! starts between the linker's `__heap_base` and the bumped `__heap_base` the
//! host sees. The exported `__memory_group_base` global holds the physical
//! address of the page allocator that processes sharing one memory use. The
//! exported `__memory_stop_base` global holds the physical address of the
//! stop word of one thread: a thread that finds a locked page parks while
//! the word is set, so a runtime can stop every store of a process. See the
//! crate README for the design and known gaps.

use std::{convert::Infallible, mem::discriminant, str::FromStr};

use anyhow::{Context, Result, anyhow, bail, ensure};
use sha2::{Digest, Sha256};
use wasm_encoder::{
    BlockType, BranchHint, BranchHints, CodeSection, ConstExpr, CustomSection, ExportKind,
    ExportSection, Function, FunctionSection, GlobalSection, InstructionSink,
    MemArg as EncodedMemArg, Module, Section, SectionId, TypeSection, ValType,
    reencode::{self, Reencode},
};
use wasmparser::{
    CompositeInnerType, ExternalKind, MemArg, Operator, Parser, Payload, TypeRef, Validator,
    WasmFeatures,
};

const PAGE_BYTES: u32 = 1 << 16;
const TABLE_BYTES: u32 = 4 << 16;
const MAXIMUM_PAGES: u64 = 1 << 16;
const COW_BIT: i32 = 1;
const BUSY_BIT: i32 = 2;
const GROUP_SHARERS: u32 = PAGE_BYTES;
const GROUP_FREE: u64 = 8;
const FREE_PAGE: i32 = 1 << 16;
const TABLE_BASE_EXPORT: &str = "__memory_table_base";
const GROUP_BASE_EXPORT: &str = "__memory_group_base";
const STOP_BASE_EXPORT: &str = "__memory_stop_base";
const STOP_ACKNOWLEDGED: u32 = 4;
const OFFSET_MASK: i32 = (PAGE_BYTES - 1) as i32;
const INLINE_LOOP_ACCESSES: u32 = 16;
const BRANCH_HINT_SECTION: &str = "metadata.code.branch_hint";
const PLAIN_FORM_SECTION: &str = "kandelo.memory.plain_form";
const AT_EXEC_SECTION: &str = "kandelo.memory.rewrite_at_exec";
const AT_EXEC_OPTIONS: Options = Options {
    crossing: Crossing::Aligned,
    role: Role::Program,
};

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum Crossing {
    Strict,
    Aligned,
}

impl FromStr for Crossing {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "strict" => Ok(Self::Strict),
            "aligned" => Ok(Self::Aligned),
            other => bail!("unknown crossing mode `{other}`: expected `strict` or `aligned`"),
        }
    }
}

/// What the input module is to the process that runs it.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum Role {
    /// The main program: it reserves the tables after `__heap_base`.
    Program,
    /// A module loaded with `dlopen`: it uses the tables of its process.
    /// Its table base starts at zero and the loader must set its three
    /// globals before any code of the module runs.
    SideModule,
}

#[derive(Debug, Clone)]
pub struct Options {
    pub crossing: Crossing,
    pub role: Role,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            crossing: Crossing::Strict,
            role: Role::Program,
        }
    }
}

pub fn instrument(input: &[u8], options: &Options) -> Result<Vec<u8>> {
    Validator::new_with_features(features())
        .validate_all(input)
        .context(
            "input uses a feature outside the supported set (no SIMD, memory64 or multi-memory)",
        )?;
    let layout = Layout::read(input, options.role)?;
    let (table_base, heap_base) = match layout.heap_base {
        Some(HeapBase { value, .. }) => {
            let table_base = value.div_ceil(PAGE_BYTES) * PAGE_BYTES;
            let heap_base = table_base
                .checked_add(2 * TABLE_BYTES)
                .context("page tables do not fit below 4 GiB")?;
            (table_base, heap_base)
        }
        None => (0, 0),
    };
    let minimum_pages = u64::from(heap_base.div_ceil(PAGE_BYTES));
    if let (false, Some(maximum)) = (layout.memory_imported, layout.memory_maximum) {
        ensure!(
            maximum >= minimum_pages,
            "memory maximum of {maximum} pages cannot hold the page table"
        );
    }

    let mut rewriter = Rewriter {
        layout: &layout,
        crossing: options.crossing,
        table_base,
        heap_base,
        minimum_pages,
        next_global: 0,
        next_function: 0,
        branch_hints: BranchHints::new(),
        code_position: 0,
    };
    let mut module = Module::new();
    rewriter
        .parse_core_module(&mut module, Parser::new(0), input)
        .map_err(|error| anyhow!("rewriting module: {error}"))?;
    let mut output = module.finish();
    let mut branch_hints = Vec::new();
    rewriter.branch_hints.append_to(&mut branch_hints);
    output.splice(rewriter.code_position..rewriter.code_position, branch_hints);
    if options.role == Role::Program {
        CustomSection {
            name: PLAIN_FORM_SECTION.into(),
            data: Sha256::digest(input).as_slice().into(),
        }
        .append_to(&mut output);
    }

    Validator::new_with_features(features())
        .validate_all(&output)
        .context("rewritten module failed validation")?;
    Ok(output)
}

/// Marks a program that the host rewrites when a process starts it. The
/// code of the program does not change. A marked program stays as it is.
pub fn mark_for_exec(input: &[u8]) -> Result<Vec<u8>> {
    instrument(input, &AT_EXEC_OPTIONS)?;
    let mut output = input.to_vec();
    let marked = Parser::new(0).parse_all(input).any(|payload| {
        matches!(payload, Ok(Payload::CustomSection(section)) if section.name() == AT_EXEC_SECTION)
    });
    if marked {
        return Ok(output);
    }
    CustomSection {
        name: AT_EXEC_SECTION.into(),
        data: [].as_slice().into(),
    }
    .append_to(&mut output);
    Ok(output)
}

/// Rewrites a program that `mark_for_exec` marked.
pub fn instrument_at_exec(input: &[u8]) -> Result<Vec<u8>> {
    instrument(input, &AT_EXEC_OPTIONS)
}

fn features() -> WasmFeatures {
    let mut features =
        WasmFeatures::default() | WasmFeatures::THREADS | WasmFeatures::LEGACY_EXCEPTIONS;
    features.remove(
        WasmFeatures::SIMD
            | WasmFeatures::RELAXED_SIMD
            | WasmFeatures::MEMORY64
            | WasmFeatures::MULTI_MEMORY,
    );
    features
}

#[derive(Default)]
struct Layout<'a> {
    thunks: Vec<Thunk<'a>>,
    func_params: Vec<Option<u32>>,
    defined_types: Vec<u32>,
    imported_funcs: u32,
    imported_globals: u32,
    defined_globals: u32,
    heap_base: Option<HeapBase>,
    memory_maximum: Option<u64>,
    memory_imported: bool,
    data_segments: u32,
}

#[derive(Clone, Copy)]
struct HeapBase {
    global: u32,
    value: u32,
}

impl<'a> Layout<'a> {
    fn read(input: &'a [u8], role: Role) -> Result<Self> {
        let mut layout = Self::default();
        let mut global_inits = Vec::new();
        let mut heap_base_export = None;
        let mut memories = Vec::new();

        for payload in Parser::new(0).parse_all(input) {
            match payload? {
                Payload::TypeSection(reader) => {
                    for group in reader {
                        for sub_type in group?.into_types() {
                            layout
                                .func_params
                                .push(match &sub_type.composite_type.inner {
                                    CompositeInnerType::Func(func) => {
                                        Some(func.params().len() as u32)
                                    }
                                    _ => None,
                                });
                        }
                    }
                }
                Payload::ImportSection(reader) => {
                    for import in reader.into_imports() {
                        match import?.ty {
                            TypeRef::Func(_) => layout.imported_funcs += 1,
                            TypeRef::Global(_) => layout.imported_globals += 1,
                            TypeRef::Memory(memory) => {
                                layout.memory_imported = true;
                                memories.push(memory);
                            }
                            _ => {}
                        }
                    }
                }
                Payload::FunctionSection(reader) => {
                    for type_index in reader {
                        layout.defined_types.push(type_index?);
                    }
                }
                Payload::MemorySection(reader) => {
                    for memory in reader {
                        memories.push(memory?);
                    }
                }
                Payload::GlobalSection(reader) => {
                    for global in reader {
                        global_inits.push(constant_i32(&global?)?);
                    }
                }
                Payload::ExportSection(reader) => {
                    for export in reader {
                        let export = export?;
                        if export.name == "__heap_base" && export.kind == ExternalKind::Global {
                            heap_base_export = Some(export.index);
                        }
                    }
                }
                Payload::DataCountSection { count, .. } => layout.data_segments = count,
                Payload::CodeSectionEntry(body) => {
                    let mut loops = Loops::new(&body)?;
                    let mut reader = body.get_operators_reader()?;
                    while !reader.eof() {
                        let operator = reader.read()?;
                        loops.step(&operator);
                        if loops.inline() {
                            continue;
                        }
                        let Some(thunk) = Thunk::new(&operator) else {
                            continue;
                        };
                        if !layout.thunks.iter().any(|known| known.same(&thunk)) {
                            layout.thunks.push(thunk);
                        }
                    }
                }
                _ => {}
            }
        }

        layout.defined_globals = global_inits.len() as u32;
        let [memory] = memories[..] else {
            bail!("expected exactly one memory, found {}", memories.len());
        };
        layout.memory_maximum = memory.maximum;
        ensure!(
            !layout.defined_types.is_empty(),
            "module defines no functions"
        );

        if role == Role::SideModule {
            return Ok(layout);
        }
        let global = heap_base_export.context("module does not export __heap_base")?;
        let defined = global
            .checked_sub(layout.imported_globals)
            .context("__heap_base must be a defined global")?;
        let value = global_inits[defined as usize]
            .context("__heap_base must be an immutable i32 with an i32.const initializer")?;
        layout.heap_base = Some(HeapBase { global, value });
        Ok(layout)
    }

    fn params(&self, defined_function: usize) -> u32 {
        let type_index = self.defined_types[defined_function] as usize;
        self.func_params[type_index].unwrap_or(0)
    }

    fn type_index(&self, ty: HelperType) -> u32 {
        self.func_params.len() as u32 + ty as u32
    }

    fn thunk_type(&self, thunk: u32) -> u32 {
        self.type_index(HelperType::Stop) + 1 + thunk
    }

    fn helper(&self, helper: Helper) -> u32 {
        self.imported_funcs + self.defined_types.len() as u32 + helper.offset(self.data_segments)
    }

    fn thunk(&self, operator: &Operator<'_>) -> u32 {
        let thunk = Thunk::new(operator).expect("a load or a store");
        self.thunks
            .iter()
            .position(|known| known.same(&thunk))
            .expect("the layout holds every thunk") as u32
    }

    fn table_global(&self) -> u32 {
        self.imported_globals + self.defined_globals
    }

    fn group_global(&self) -> u32 {
        self.table_global() + 1
    }

    fn stop_global(&self) -> u32 {
        self.table_global() + 2
    }
}

fn constant_i32(global: &wasmparser::Global<'_>) -> Result<Option<u32>> {
    if global.ty.mutable || global.ty.content_type != wasmparser::ValType::I32 {
        return Ok(None);
    }
    let mut reader = global.init_expr.get_operators_reader();
    let Operator::I32Const { value } = reader.read()? else {
        return Ok(None);
    };
    let Operator::End = reader.read()? else {
        return Ok(None);
    };
    Ok(Some(value as u32))
}

#[derive(Clone, Copy)]
enum HelperType {
    Translate,
    LoadBytes,
    StoreBytes,
    Bulk,
    Stop,
}

#[derive(Clone, Copy)]
enum Helper {
    TranslateRead,
    TranslateWrite,
    CowFault,
    LoadBytes,
    StoreBytes,
    Copy,
    Fill,
    Stop,
    Init(u32),
    Thunk(u32),
}

impl Helper {
    fn offset(self, data_segments: u32) -> u32 {
        match self {
            Self::TranslateRead => 0,
            Self::TranslateWrite => 1,
            Self::CowFault => 2,
            Self::LoadBytes => 3,
            Self::StoreBytes => 4,
            Self::Copy => 5,
            Self::Fill => 6,
            Self::Stop => 7,
            Self::Init(segment) => 8 + segment,
            Self::Thunk(thunk) => 8 + data_segments + thunk,
        }
    }
}

#[derive(Clone, Copy)]
enum Scalar {
    I32,
    I64,
    F32,
    F64,
}

impl Scalar {
    fn operands(self) -> &'static [Scalar] {
        match self {
            Self::I32 => &[Self::I32],
            Self::I64 => &[Self::I64],
            Self::F32 => &[Self::F32],
            Self::F64 => &[Self::F64],
        }
    }

    fn val_type(self) -> ValType {
        match self {
            Self::I32 => ValType::I32,
            Self::I64 => ValType::I64,
            Self::F32 => ValType::F32,
            Self::F64 => ValType::F64,
        }
    }

    fn widen_to_i64(self, sink: &mut InstructionSink<'_>) {
        match self {
            Self::I32 => {
                sink.i64_extend_i32_u();
            }
            Self::I64 => {}
            Self::F32 => {
                sink.i32_reinterpret_f32().i64_extend_i32_u();
            }
            Self::F64 => {
                sink.i64_reinterpret_f64();
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Widen {
    I32 { signed: bool },
    I64 { signed: bool },
    F32,
    F64,
}

impl Widen {
    fn val_type(self) -> ValType {
        match self {
            Self::I32 { .. } => ValType::I32,
            Self::I64 { .. } => ValType::I64,
            Self::F32 => ValType::F32,
            Self::F64 => ValType::F64,
        }
    }

    fn narrow_from_i64(self, sink: &mut InstructionSink<'_>, size: u32) {
        match (self, size) {
            (Self::I32 { signed: true }, 2) => {
                sink.i32_wrap_i64().i32_extend16_s();
            }
            (Self::I32 { .. }, _) => {
                sink.i32_wrap_i64();
            }
            (Self::I64 { signed: true }, 2) => {
                sink.i64_extend16_s();
            }
            (Self::I64 { signed: true }, 4) => {
                sink.i64_extend32_s();
            }
            (Self::I64 { .. }, _) => {}
            (Self::F32, _) => {
                sink.i32_wrap_i64().f32_reinterpret_i32();
            }
            (Self::F64, _) => {
                sink.f64_reinterpret_i64();
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Access {
    Load(MemArg, Widen),
    Store(MemArg, Scalar),
    Atomic {
        memarg: MemArg,
        operands: &'static [Scalar],
        write: bool,
    },
    Copy,
    Fill,
    Init(u32),
}

fn access(operator: &Operator<'_>) -> Option<Access> {
    use Operator as O;
    use Scalar::{I32, I64};

    let atomic = |memarg: &MemArg, operands, write| {
        Some(Access::Atomic {
            memarg: *memarg,
            operands,
            write,
        })
    };
    match operator {
        O::I32Load { memarg } | O::I32Load8U { memarg } | O::I32Load16U { memarg } => {
            Some(Access::Load(*memarg, Widen::I32 { signed: false }))
        }
        O::I32Load8S { memarg } | O::I32Load16S { memarg } => {
            Some(Access::Load(*memarg, Widen::I32 { signed: true }))
        }
        O::I64Load { memarg }
        | O::I64Load8U { memarg }
        | O::I64Load16U { memarg }
        | O::I64Load32U { memarg } => Some(Access::Load(*memarg, Widen::I64 { signed: false })),
        O::I64Load8S { memarg } | O::I64Load16S { memarg } | O::I64Load32S { memarg } => {
            Some(Access::Load(*memarg, Widen::I64 { signed: true }))
        }
        O::F32Load { memarg } => Some(Access::Load(*memarg, Widen::F32)),
        O::F64Load { memarg } => Some(Access::Load(*memarg, Widen::F64)),
        O::I32Store { memarg } | O::I32Store8 { memarg } | O::I32Store16 { memarg } => {
            Some(Access::Store(*memarg, Scalar::I32))
        }
        O::I64Store { memarg }
        | O::I64Store8 { memarg }
        | O::I64Store16 { memarg }
        | O::I64Store32 { memarg } => Some(Access::Store(*memarg, Scalar::I64)),
        O::F32Store { memarg } => Some(Access::Store(*memarg, Scalar::F32)),
        O::F64Store { memarg } => Some(Access::Store(*memarg, Scalar::F64)),
        O::I32AtomicLoad { memarg }
        | O::I64AtomicLoad { memarg }
        | O::I32AtomicLoad8U { memarg }
        | O::I32AtomicLoad16U { memarg }
        | O::I64AtomicLoad8U { memarg }
        | O::I64AtomicLoad16U { memarg }
        | O::I64AtomicLoad32U { memarg } => atomic(memarg, &[], false),
        O::I32AtomicStore { memarg }
        | O::I32AtomicStore8 { memarg }
        | O::I32AtomicStore16 { memarg }
        | O::I32AtomicRmwAdd { memarg }
        | O::I32AtomicRmw8AddU { memarg }
        | O::I32AtomicRmw16AddU { memarg }
        | O::I32AtomicRmwSub { memarg }
        | O::I32AtomicRmw8SubU { memarg }
        | O::I32AtomicRmw16SubU { memarg }
        | O::I32AtomicRmwAnd { memarg }
        | O::I32AtomicRmw8AndU { memarg }
        | O::I32AtomicRmw16AndU { memarg }
        | O::I32AtomicRmwOr { memarg }
        | O::I32AtomicRmw8OrU { memarg }
        | O::I32AtomicRmw16OrU { memarg }
        | O::I32AtomicRmwXor { memarg }
        | O::I32AtomicRmw8XorU { memarg }
        | O::I32AtomicRmw16XorU { memarg }
        | O::I32AtomicRmwXchg { memarg }
        | O::I32AtomicRmw8XchgU { memarg }
        | O::I32AtomicRmw16XchgU { memarg } => atomic(memarg, &[I32], true),
        O::I64AtomicStore { memarg }
        | O::I64AtomicStore8 { memarg }
        | O::I64AtomicStore16 { memarg }
        | O::I64AtomicStore32 { memarg }
        | O::I64AtomicRmwAdd { memarg }
        | O::I64AtomicRmw8AddU { memarg }
        | O::I64AtomicRmw16AddU { memarg }
        | O::I64AtomicRmw32AddU { memarg }
        | O::I64AtomicRmwSub { memarg }
        | O::I64AtomicRmw8SubU { memarg }
        | O::I64AtomicRmw16SubU { memarg }
        | O::I64AtomicRmw32SubU { memarg }
        | O::I64AtomicRmwAnd { memarg }
        | O::I64AtomicRmw8AndU { memarg }
        | O::I64AtomicRmw16AndU { memarg }
        | O::I64AtomicRmw32AndU { memarg }
        | O::I64AtomicRmwOr { memarg }
        | O::I64AtomicRmw8OrU { memarg }
        | O::I64AtomicRmw16OrU { memarg }
        | O::I64AtomicRmw32OrU { memarg }
        | O::I64AtomicRmwXor { memarg }
        | O::I64AtomicRmw8XorU { memarg }
        | O::I64AtomicRmw16XorU { memarg }
        | O::I64AtomicRmw32XorU { memarg }
        | O::I64AtomicRmwXchg { memarg }
        | O::I64AtomicRmw8XchgU { memarg }
        | O::I64AtomicRmw16XchgU { memarg }
        | O::I64AtomicRmw32XchgU { memarg } => atomic(memarg, &[I64], true),
        O::I32AtomicRmwCmpxchg { memarg }
        | O::I32AtomicRmw8CmpxchgU { memarg }
        | O::I32AtomicRmw16CmpxchgU { memarg } => atomic(memarg, &[I32, I32], true),
        O::I64AtomicRmwCmpxchg { memarg }
        | O::I64AtomicRmw8CmpxchgU { memarg }
        | O::I64AtomicRmw16CmpxchgU { memarg }
        | O::I64AtomicRmw32CmpxchgU { memarg } => atomic(memarg, &[I64, I64], true),
        O::MemoryAtomicNotify { memarg } => atomic(memarg, &[I32], false),
        O::MemoryAtomicWait32 { memarg } => atomic(memarg, &[I32, I64], false),
        O::MemoryAtomicWait64 { memarg } => atomic(memarg, &[I64, I64], false),
        O::MemoryCopy { .. } => Some(Access::Copy),
        O::MemoryFill { .. } => Some(Access::Fill),
        O::MemoryInit { data_index, .. } => Some(Access::Init(*data_index)),
        _ => None,
    }
}

#[derive(Clone, Copy)]
enum Slow {
    Load(Widen),
    Store(Scalar),
}

/// The loops that enclose the current instruction of one function.
///
/// An engine runs a loop of a long activation in the code of its baseline
/// compiler, where a call per access is slow. So an access gets the
/// translation inline when its innermost loop holds few accesses. A large
/// loop keeps the calls: the optimizing compiler needs much more memory for
/// a large function, and it inlines the helpers itself.
struct Loops {
    accesses: Vec<u32>,
    blocks: Vec<bool>,
    open: Vec<usize>,
    entered: usize,
}

impl Loops {
    fn new(body: &wasmparser::FunctionBody<'_>) -> Result<Self, wasmparser::BinaryReaderError> {
        let mut accesses = Vec::new();
        let mut blocks = Vec::new();
        let mut total = 0;
        let mut reader = body.get_operators_reader()?;
        while !reader.eof() {
            let operator = reader.read()?;
            match operator {
                Operator::Loop { .. } => {
                    blocks.push(Some(accesses.len()));
                    accesses.push(total);
                }
                Operator::Block { .. }
                | Operator::If { .. }
                | Operator::Try { .. }
                | Operator::TryTable { .. } => blocks.push(None),
                Operator::End | Operator::Delegate { .. } => {
                    if let Some(Some(ended)) = blocks.pop() {
                        accesses[ended] = total - accesses[ended];
                    }
                }
                _ => {}
            }
            total += u32::from(matches!(
                access(&operator),
                Some(Access::Load(..) | Access::Store(..))
            ));
        }
        Ok(Self {
            accesses,
            blocks: Vec::new(),
            open: Vec::new(),
            entered: 0,
        })
    }

    fn step(&mut self, operator: &Operator<'_>) {
        match operator {
            Operator::Loop { .. } => {
                self.blocks.push(true);
                self.open.push(self.entered);
                self.entered += 1;
            }
            Operator::Block { .. }
            | Operator::If { .. }
            | Operator::Try { .. }
            | Operator::TryTable { .. } => self.blocks.push(false),
            Operator::End | Operator::Delegate { .. } => {
                if self.blocks.pop() == Some(true) {
                    self.open.pop();
                }
            }
            _ => {}
        }
    }

    fn inline(&self) -> bool {
        self.open
            .last()
            .is_some_and(|innermost| self.accesses[*innermost] <= INLINE_LOOP_ACCESSES)
    }
}

/// A helper that holds one kind of load or store, so that an access costs
/// its caller one call.
struct Thunk<'a> {
    operator: Operator<'a>,
    memarg: MemArg,
    slow: Slow,
    offset: bool,
}

impl<'a> Thunk<'a> {
    fn new(operator: &Operator<'a>) -> Option<Self> {
        let (memarg, slow) = match access(operator)? {
            Access::Load(memarg, widen) => (memarg, Slow::Load(widen)),
            Access::Store(memarg, value) => (memarg, Slow::Store(value)),
            _ => return None,
        };
        Some(Self {
            operator: operator.clone(),
            memarg,
            slow,
            offset: matches!(slow, Slow::Store(_)) && memarg.offset != 0,
        })
    }

    fn same(&self, other: &Self) -> bool {
        discriminant(&self.operator) == discriminant(&other.operator)
            && self.memarg.align == other.memarg.align
            && self.offset == other.offset
    }

    fn signature(&self) -> (Vec<ValType>, Vec<ValType>) {
        match self.slow {
            Slow::Load(widen) => (vec![ValType::I32], vec![widen.val_type()]),
            Slow::Store(value) => {
                let mut params = vec![ValType::I32, value.val_type()];
                params.extend(self.offset.then_some(ValType::I32));
                (params, Vec::new())
            }
        }
    }
}

struct Scratch {
    addr: u32,
    entry: u32,
    i32: [u32; 2],
    table: u32,
    i64: [u32; 2],
    f32: u32,
    f64: u32,
}

impl Scratch {
    const LOCALS: [(u32, ValType); 4] = [
        (5, ValType::I32),
        (2, ValType::I64),
        (1, ValType::F32),
        (1, ValType::F64),
    ];

    fn new(base: u32) -> Self {
        Self {
            addr: base,
            entry: base + 1,
            i32: [base + 2, base + 3],
            table: base + 4,
            i64: [base + 5, base + 6],
            f32: base + 7,
            f64: base + 8,
        }
    }

    fn slots(&self, operands: &[Scalar]) -> Vec<u32> {
        let (mut i32s, mut i64s) = (self.i32.iter(), self.i64.iter());
        operands
            .iter()
            .map(|operand| match operand {
                Scalar::I32 => *i32s.next().expect("two i32 scratch locals"),
                Scalar::I64 => *i64s.next().expect("two i64 scratch locals"),
                Scalar::F32 => self.f32,
                Scalar::F64 => self.f64,
            })
            .collect()
    }
}

/// A function body and the `if` instructions in it that rarely run.
struct Body {
    function: Function,
    unlikely: Vec<BranchHint>,
}

impl Body {
    fn unlikely_if(&mut self, ty: BlockType) {
        self.unlikely.push(BranchHint {
            branch_func_offset: self.function.byte_len() as u32,
            branch_hint_value: 0,
        });
        self.function.instructions().if_(ty);
    }
}

impl From<Function> for Body {
    fn from(function: Function) -> Self {
        Self {
            function,
            unlikely: Vec::new(),
        }
    }
}

/// Where one translation finds its address and its table, and where it
/// keeps its table entry.
#[derive(Clone, Copy)]
struct Place {
    addr: u32,
    entry: u32,
    /// The local that holds the table base, or the global when `None`.
    table: Option<u32>,
}

struct Rewriter<'a> {
    layout: &'a Layout<'a>,
    crossing: Crossing,
    table_base: u32,
    heap_base: u32,
    minimum_pages: u64,
    next_global: u32,
    next_function: usize,
    branch_hints: BranchHints,
    code_position: usize,
}

type ReencodeResult<T> = Result<T, reencode::Error<Infallible>>;

/// The position of a section in the binary format, which differs from the
/// order of the section ids.
fn position(section: SectionId) -> usize {
    const ORDER: [SectionId; 13] = [
        SectionId::Type,
        SectionId::Import,
        SectionId::Function,
        SectionId::Table,
        SectionId::Memory,
        SectionId::Tag,
        SectionId::Global,
        SectionId::Export,
        SectionId::Start,
        SectionId::Element,
        SectionId::DataCount,
        SectionId::Code,
        SectionId::Data,
    ];
    ORDER
        .iter()
        .position(|candidate| *candidate == section)
        .expect("a non-custom section")
}

/// Whether the module has no `section`, seen from the gap between the
/// sections `after` and `before`.
fn absent(section: SectionId, after: Option<SectionId>, before: Option<SectionId>) -> bool {
    after.is_none_or(|after| position(after) < position(section))
        && before.is_none_or(|before| position(section) < position(before))
}

impl Rewriter<'_> {
    fn table_globals(&self, globals: &mut GlobalSection) {
        let mutable_i32 = wasm_encoder::GlobalType {
            val_type: ValType::I32,
            mutable: true,
            shared: false,
        };
        globals.global(mutable_i32, &ConstExpr::i32_const(self.table_base as i32));
        globals.global(mutable_i32, &ConstExpr::i32_const(0));
        globals.global(mutable_i32, &ConstExpr::i32_const(self.table_base as i32));
    }

    fn table_exports(&self, exports: &mut ExportSection) {
        exports.export(
            TABLE_BASE_EXPORT,
            ExportKind::Global,
            self.layout.table_global(),
        );
        exports.export(
            GROUP_BASE_EXPORT,
            ExportKind::Global,
            self.layout.group_global(),
        );
        exports.export(
            STOP_BASE_EXPORT,
            ExportKind::Global,
            self.layout.stop_global(),
        );
    }

    fn crosses(&self, memarg: &MemArg) -> bool {
        let size = 1u32 << memarg.max_align;
        size > 1
            && match self.crossing {
                Crossing::Strict => true,
                Crossing::Aligned => memarg.align < memarg.max_align,
            }
    }

    fn emit_table_entry(&self, sink: &mut InstructionSink<'_>, table: Option<u32>, write: bool) {
        self.emit_table_entry_address(sink, table);
        sink.i32_load(table_memarg(write));
    }

    fn emit_table_entry_address(&self, sink: &mut InstructionSink<'_>, table: Option<u32>) {
        sink.i32_const(16).i32_shr_u().i32_const(2).i32_shl();
        match table {
            Some(local) => sink.local_get(local),
            None => sink.global_get(self.layout.table_global()),
        };
        sink.i32_add();
    }

    fn hint(&mut self, function: u32, body: &Body) {
        if !body.unlikely.is_empty() {
            self.branch_hints
                .function_hints(function, body.unlikely.iter().copied());
        }
    }

    fn emit_access(
        &mut self,
        body: &mut Body,
        operator: Operator<'_>,
        access: Access,
        inline: bool,
        scratch: &Scratch,
    ) -> ReencodeResult<()> {
        let mut sink = body.function.instructions();
        let (memarg, operands, write, slow) = match access {
            Access::Copy => {
                sink.call(self.layout.helper(Helper::Copy));
                return Ok(());
            }
            Access::Fill => {
                sink.call(self.layout.helper(Helper::Fill));
                return Ok(());
            }
            Access::Init(segment) => {
                sink.call(self.layout.helper(Helper::Init(segment)));
                return Ok(());
            }
            Access::Load(memarg, _) if !inline => {
                emit_add_offset(&mut sink, &memarg);
                sink.call(
                    self.layout
                        .helper(Helper::Thunk(self.layout.thunk(&operator))),
                );
                return Ok(());
            }
            Access::Store(memarg, _) if !inline => {
                if memarg.offset != 0 {
                    sink.i32_const(memarg.offset as u32 as i32);
                }
                sink.call(
                    self.layout
                        .helper(Helper::Thunk(self.layout.thunk(&operator))),
                );
                return Ok(());
            }
            Access::Load(memarg, widen) => (memarg, &[][..], false, Some(Slow::Load(widen))),
            Access::Store(memarg, value) => {
                (memarg, value.operands(), true, Some(Slow::Store(value)))
            }
            Access::Atomic {
                memarg,
                operands,
                write,
            } => (memarg, operands, write, None),
        };
        let original = self.instruction(operator)?;
        let slots = scratch.slots(operands);

        for slot in slots.iter().rev() {
            sink.local_set(*slot);
        }
        emit_add_offset(&mut sink, &memarg);
        sink.local_set(scratch.addr);
        let slow = slow.filter(|_| self.crosses(&memarg));
        let place = Place {
            addr: scratch.addr,
            entry: scratch.entry,
            table: Some(scratch.table),
        };
        self.emit_checked(body, &memarg, slow, write, place, &slots, &original);
        Ok(())
    }

    /// Emit the access `original` to the address in the local `place.addr`,
    /// with its operands in `slots`. `slow` sends an access that crosses a
    /// page boundary to the byte-wise helper.
    #[allow(clippy::too_many_arguments)]
    fn emit_checked(
        &self,
        body: &mut Body,
        memarg: &MemArg,
        slow: Option<Slow>,
        write: bool,
        place: Place,
        slots: &[u32],
        original: &wasm_encoder::Instruction<'_>,
    ) {
        let size = 1u32 << memarg.max_align;
        if let Some(slow) = slow {
            body.function
                .instructions()
                .local_get(place.addr)
                .i32_const(OFFSET_MASK)
                .i32_and()
                .i32_const((PAGE_BYTES - size) as i32)
                .i32_gt_u();
            match slow {
                Slow::Load(widen) => {
                    body.unlikely_if(BlockType::Result(widen.val_type()));
                    let mut sink = body.function.instructions();
                    sink.local_get(place.addr)
                        .i32_const(size as i32)
                        .call(self.layout.helper(Helper::LoadBytes));
                    widen.narrow_from_i64(&mut sink, size);
                }
                Slow::Store(value) => {
                    body.unlikely_if(BlockType::Empty);
                    let mut sink = body.function.instructions();
                    sink.local_get(place.addr)
                        .i32_const(size as i32)
                        .local_get(slots[0]);
                    value.widen_to_i64(&mut sink);
                    sink.call(self.layout.helper(Helper::StoreBytes));
                }
            }
            body.function.instructions().else_();
        }
        self.emit_fast(body, write, place, slots);
        body.function.instruction(original);
        if slow.is_some() {
            body.function.instructions().end();
        }
    }

    fn emit_fast(&self, body: &mut Body, write: bool, place: Place, slots: &[u32]) {
        let mut sink = body.function.instructions();
        sink.local_get(place.addr).local_get(place.addr);
        self.emit_table_entry(&mut sink, place.table, write);
        if write {
            sink.local_tee(place.entry).i32_const(COW_BIT).i32_and();
            body.unlikely_if(BlockType::Empty);
            body.function
                .instructions()
                .local_get(place.addr)
                .call(self.layout.helper(Helper::CowFault))
                .local_set(place.entry)
                .end()
                .local_get(place.entry);
        }
        let mut sink = body.function.instructions();
        sink.i32_add();
        for slot in slots {
            sink.local_get(*slot);
        }
    }

    fn thunk(&mut self, thunk: &Thunk<'_>) -> ReencodeResult<Body> {
        let original = self.instruction(thunk.operator.clone())?;
        let write = matches!(thunk.slow, Slow::Store(_));
        let place = Place {
            addr: 0,
            entry: 2 + u32::from(thunk.offset),
            table: None,
        };
        let slots: &[u32] = if write { &[1] } else { &[] };

        let mut body = Body::from(Function::new(write.then_some((1, ValType::I32))));
        if thunk.offset {
            body.function
                .instructions()
                .local_get(0)
                .local_get(2)
                .i32_add()
                .local_set(0);
        }
        let slow = Some(thunk.slow).filter(|_| self.crosses(&thunk.memarg));
        self.emit_checked(
            &mut body,
            &thunk.memarg,
            slow,
            write,
            place,
            slots,
            &original,
        );
        body.function.instructions().end();
        Ok(body)
    }

    fn helper_bodies(&self) -> Vec<Body> {
        let mut bodies = vec![
            self.translate_read().into(),
            self.translate_write(),
            self.cow_fault().into(),
            self.load_bytes().into(),
            self.store_bytes().into(),
            self.copy().into(),
            self.chunked(|sink, _| {
                sink.memory_fill(0);
            })
            .into(),
            self.stop().into(),
        ];
        bodies.extend((0..self.layout.data_segments).map(|segment| {
            self.chunked(move |sink, cursor| {
                sink.memory_init(0, segment);
                sink.local_get(cursor)
                    .local_get(3)
                    .i32_add()
                    .local_set(cursor);
            })
            .into()
        }));
        bodies
    }

    fn translate_read(&self) -> Function {
        let mut function = Function::new([]);
        let mut sink = function.instructions();
        sink.local_get(0).local_get(0);
        self.emit_table_entry(&mut sink, None, false);
        sink.i32_add().end();
        function
    }

    fn translate_write(&self) -> Body {
        let mut body = Body::from(Function::new([(1, ValType::I32)]));
        let place = Place {
            addr: 0,
            entry: 1,
            table: None,
        };
        self.emit_fast(&mut body, true, place, &[]);
        body.function.instructions().end();
        body
    }

    fn cow_fault(&self) -> Function {
        let (addr, slot, delta, physical, fresh, sharers, entry, head) = (0, 1, 2, 3, 4, 5, 6, 7);
        let group = self.layout.group_global();
        let mut function = Function::new([(6, ValType::I32), (1, ValType::I64)]);
        let mut sink = function.instructions();

        sink.local_get(addr);
        self.emit_table_entry_address(&mut sink, None);
        sink.local_set(slot);
        sink.loop_(BlockType::Empty)
            .local_get(slot)
            .i32_atomic_load(table_memarg(true))
            .local_tee(entry)
            .i32_const(COW_BIT)
            .i32_and()
            .i32_eqz()
            .if_(BlockType::Empty)
            .local_get(entry)
            .return_()
            .end();
        sink.local_get(entry)
            .i32_const(BUSY_BIT)
            .i32_and()
            .if_(BlockType::Empty)
            .call(self.layout.helper(Helper::Stop))
            .br(1)
            .end();
        sink.local_get(slot)
            .local_get(entry)
            .local_get(entry)
            .i32_const(BUSY_BIT)
            .i32_or()
            .i32_atomic_rmw_cmpxchg(table_memarg(true))
            .local_get(entry)
            .i32_ne()
            .br_if(0)
            .end();
        sink.local_get(entry)
            .i32_const(!(COW_BIT | BUSY_BIT))
            .i32_and()
            .local_set(delta);
        sink.local_get(addr)
            .i32_const(16)
            .i32_shr_u()
            .local_get(delta)
            .i32_const(16)
            .i32_shr_s()
            .i32_add()
            .i32_const(OFFSET_MASK)
            .i32_and()
            .local_set(physical);
        sink.local_get(physical)
            .i32_const(2)
            .i32_shl()
            .global_get(group)
            .i32_add()
            .local_tee(sharers)
            .i32_atomic_load(word_memarg(GROUP_SHARERS))
            .i32_eqz()
            .if_(BlockType::Empty)
            .local_get(slot)
            .local_get(delta)
            .i32_atomic_store(table_memarg(true))
            .local_get(delta)
            .return_()
            .end();

        sink.block(BlockType::Empty).loop_(BlockType::Empty);
        sink.global_get(group)
            .i64_atomic_load(free_memarg())
            .local_tee(head)
            .i32_wrap_i64()
            .local_tee(fresh)
            .i32_eqz()
            .if_(BlockType::Empty);
        sink.global_get(group)
            .i32_const(1)
            .i32_atomic_rmw_add(word_memarg(0))
            .local_set(fresh);
        sink.block(BlockType::Empty).loop_(BlockType::Empty);
        sink.local_get(fresh).memory_size(0).i32_lt_u().br_if(1);
        sink.local_get(fresh)
            .i32_const(1)
            .i32_add()
            .memory_size(0)
            .i32_sub()
            .memory_grow(0)
            .i32_const(-1)
            .i32_eq()
            .if_(BlockType::Empty)
            .unreachable()
            .end();
        sink.br(0).end().end();
        sink.br(2).end();
        sink.local_get(fresh)
            .i32_const(OFFSET_MASK)
            .i32_and()
            .local_set(fresh);
        sink.global_get(group).local_get(head).local_get(head);
        emit_changed_head(&mut sink);
        sink.local_get(fresh)
            .i32_const(2)
            .i32_shl()
            .global_get(group)
            .i32_add()
            .i32_atomic_load(word_memarg(GROUP_SHARERS))
            .i64_extend_i32_u()
            .i64_or()
            .i64_atomic_rmw_cmpxchg(free_memarg())
            .local_get(head)
            .i64_ne()
            .br_if(0);
        sink.local_get(fresh)
            .i32_const(2)
            .i32_shl()
            .global_get(group)
            .i32_add()
            .i32_const(0)
            .i32_atomic_store(word_memarg(GROUP_SHARERS));
        sink.end().end();

        sink.local_get(fresh)
            .i32_const(16)
            .i32_shl()
            .local_get(physical)
            .i32_const(16)
            .i32_shl()
            .i32_const(PAGE_BYTES as i32)
            .memory_copy(0, 0);
        sink.local_get(fresh)
            .local_get(addr)
            .i32_const(16)
            .i32_shr_u()
            .i32_sub()
            .i32_const(16)
            .i32_shl()
            .local_set(delta);
        sink.local_get(slot)
            .local_get(delta)
            .i32_atomic_store(table_memarg(false));
        sink.local_get(slot)
            .local_get(delta)
            .i32_atomic_store(table_memarg(true));
        sink.local_get(sharers)
            .i32_const(1)
            .i32_atomic_rmw_sub(word_memarg(GROUP_SHARERS))
            .i32_eqz()
            .if_(BlockType::Empty)
            .loop_(BlockType::Empty);
        sink.local_get(sharers)
            .global_get(group)
            .i64_atomic_load(free_memarg())
            .local_tee(head)
            .i32_wrap_i64()
            .i32_atomic_store(word_memarg(GROUP_SHARERS));
        sink.global_get(group).local_get(head).local_get(head);
        emit_changed_head(&mut sink);
        sink.local_get(physical)
            .i32_const(FREE_PAGE)
            .i32_or()
            .i64_extend_i32_u()
            .i64_or()
            .i64_atomic_rmw_cmpxchg(free_memarg())
            .local_get(head)
            .i64_ne()
            .br_if(0)
            .end()
            .end();
        sink.local_get(delta).end();
        function
    }

    fn stop(&self) -> Function {
        let request = 0;
        let stop = self.layout.stop_global();
        let mut function = Function::new([(1, ValType::I32)]);
        function
            .instructions()
            .loop_(BlockType::Empty)
            .global_get(stop)
            .i32_atomic_load(word_memarg(0))
            .local_tee(request)
            .i32_eqz()
            .if_(BlockType::Empty)
            .return_()
            .end()
            .global_get(stop)
            .local_get(request)
            .i32_atomic_store(word_memarg(STOP_ACKNOWLEDGED))
            .global_get(stop)
            .i32_const(1)
            .memory_atomic_notify(word_memarg(STOP_ACKNOWLEDGED))
            .drop()
            .global_get(stop)
            .local_get(request)
            .i64_const(-1)
            .memory_atomic_wait32(word_memarg(0))
            .drop()
            .br(0)
            .end()
            .end();
        function
    }

    fn load_bytes(&self) -> Function {
        let mut function = Function::new([(1, ValType::I32), (1, ValType::I64)]);
        function
            .instructions()
            .block(BlockType::Empty)
            .loop_(BlockType::Empty)
            .local_get(2)
            .local_get(1)
            .i32_ge_u()
            .br_if(1)
            .local_get(3)
            .local_get(0)
            .local_get(2)
            .i32_add()
            .call(self.layout.helper(Helper::TranslateRead))
            .i64_load8_u(byte_memarg())
            .local_get(2)
            .i32_const(3)
            .i32_shl()
            .i64_extend_i32_u()
            .i64_shl()
            .i64_or()
            .local_set(3)
            .local_get(2)
            .i32_const(1)
            .i32_add()
            .local_set(2)
            .br(0)
            .end()
            .end()
            .local_get(3)
            .end();
        function
    }

    fn store_bytes(&self) -> Function {
        let mut function = Function::new([(1, ValType::I32)]);
        function
            .instructions()
            .block(BlockType::Empty)
            .loop_(BlockType::Empty)
            .local_get(3)
            .local_get(1)
            .i32_ge_u()
            .br_if(1)
            .local_get(0)
            .local_get(3)
            .i32_add()
            .call(self.layout.helper(Helper::TranslateWrite))
            .local_get(2)
            .local_get(3)
            .i32_const(3)
            .i32_shl()
            .i64_extend_i32_u()
            .i64_shr_u()
            .i64_store8(byte_memarg())
            .local_get(3)
            .i32_const(1)
            .i32_add()
            .local_set(3)
            .br(0)
            .end()
            .end()
            .end();
        function
    }

    fn copy(&self) -> Function {
        let (dst, src, len, chunk, other) = (0, 1, 2, 3, 4);
        let translate_write = self.layout.helper(Helper::TranslateWrite);
        let translate_read = self.layout.helper(Helper::TranslateRead);
        let mut function = Function::new([(2, ValType::I32)]);
        let mut sink = function.instructions();

        sink.local_get(dst)
            .local_get(src)
            .i32_le_u()
            .if_(BlockType::Empty);
        sink.block(BlockType::Empty).loop_(BlockType::Empty);
        sink.local_get(len).i32_eqz().br_if(1);
        emit_room_ahead(&mut sink, dst);
        sink.local_set(chunk);
        emit_room_ahead(&mut sink, src);
        sink.local_set(other);
        emit_min(&mut sink, chunk, other);
        emit_min(&mut sink, chunk, len);
        sink.local_get(dst).call(translate_write);
        sink.local_get(src).call(translate_read);
        sink.local_get(chunk).memory_copy(0, 0);
        emit_advance(&mut sink, dst, chunk);
        emit_advance(&mut sink, src, chunk);
        emit_retreat(&mut sink, len, chunk);
        sink.br(0).end().end();

        sink.else_();
        emit_advance(&mut sink, dst, len);
        emit_advance(&mut sink, src, len);
        sink.block(BlockType::Empty).loop_(BlockType::Empty);
        sink.local_get(len).i32_eqz().br_if(1);
        emit_room_behind(&mut sink, dst);
        sink.local_set(chunk);
        emit_room_behind(&mut sink, src);
        sink.local_set(other);
        emit_min(&mut sink, chunk, other);
        emit_min(&mut sink, chunk, len);
        emit_retreat(&mut sink, dst, chunk);
        emit_retreat(&mut sink, src, chunk);
        emit_retreat(&mut sink, len, chunk);
        sink.local_get(dst).call(translate_write);
        sink.local_get(src).call(translate_read);
        sink.local_get(chunk).memory_copy(0, 0);
        sink.br(0).end().end();
        sink.end().end();
        function
    }

    fn chunked(&self, operation: impl Fn(&mut InstructionSink<'_>, u32)) -> Function {
        let (dst, value, len, chunk) = (0, 1, 2, 3);
        let mut function = Function::new([(1, ValType::I32)]);
        let mut sink = function.instructions();
        sink.block(BlockType::Empty).loop_(BlockType::Empty);
        sink.local_get(len).i32_eqz().br_if(1);
        emit_room_ahead(&mut sink, dst);
        sink.local_set(chunk);
        emit_min(&mut sink, chunk, len);
        sink.local_get(dst)
            .call(self.layout.helper(Helper::TranslateWrite))
            .local_get(value)
            .local_get(chunk);
        operation(&mut sink, value);
        emit_advance(&mut sink, dst, chunk);
        emit_retreat(&mut sink, len, chunk);
        sink.br(0).end().end().end();
        function
    }
}

fn table_memarg(write: bool) -> EncodedMemArg {
    EncodedMemArg {
        offset: u64::from(if write { TABLE_BYTES } else { 0 }),
        align: 2,
        memory_index: 0,
    }
}

fn word_memarg(offset: u32) -> EncodedMemArg {
    EncodedMemArg {
        offset: u64::from(offset),
        align: 2,
        memory_index: 0,
    }
}

fn free_memarg() -> EncodedMemArg {
    EncodedMemArg {
        offset: GROUP_FREE,
        align: 3,
        memory_index: 0,
    }
}

/// Turn the free-list head on the stack into a head with no page and the
/// next change count.
fn emit_changed_head(sink: &mut InstructionSink<'_>) {
    sink.i64_const(32)
        .i64_shr_u()
        .i64_const(1)
        .i64_add()
        .i64_const(32)
        .i64_shl();
}

fn byte_memarg() -> EncodedMemArg {
    EncodedMemArg {
        offset: 0,
        align: 0,
        memory_index: 0,
    }
}

fn emit_add_offset(sink: &mut InstructionSink<'_>, memarg: &MemArg) {
    if memarg.offset != 0 {
        sink.i32_const(memarg.offset as u32 as i32).i32_add();
    }
}

fn emit_room_ahead(sink: &mut InstructionSink<'_>, address: u32) {
    sink.i32_const(PAGE_BYTES as i32)
        .local_get(address)
        .i32_const(OFFSET_MASK)
        .i32_and()
        .i32_sub();
}

fn emit_room_behind(sink: &mut InstructionSink<'_>, end: u32) {
    sink.local_get(end)
        .i32_const(1)
        .i32_sub()
        .i32_const(OFFSET_MASK)
        .i32_and()
        .i32_const(1)
        .i32_add();
}

fn emit_min(sink: &mut InstructionSink<'_>, target: u32, other: u32) {
    sink.local_get(target)
        .local_get(other)
        .local_get(target)
        .local_get(other)
        .i32_lt_u()
        .select()
        .local_set(target);
}

fn emit_advance(sink: &mut InstructionSink<'_>, target: u32, amount: u32) {
    sink.local_get(target)
        .local_get(amount)
        .i32_add()
        .local_set(target);
}

fn emit_retreat(sink: &mut InstructionSink<'_>, target: u32, amount: u32) {
    sink.local_get(target)
        .local_get(amount)
        .i32_sub()
        .local_set(target);
}

impl Reencode for Rewriter<'_> {
    type Error = Infallible;

    fn mem_arg(&mut self, arg: MemArg) -> ReencodeResult<EncodedMemArg> {
        Ok(EncodedMemArg {
            offset: 0,
            align: arg.align.into(),
            memory_index: arg.memory,
        })
    }

    fn memory_type(
        &mut self,
        memory_ty: wasmparser::MemoryType,
    ) -> ReencodeResult<wasm_encoder::MemoryType> {
        let mut memory = reencode::utils::memory_type(self, memory_ty);
        memory.minimum = memory.minimum.max(self.minimum_pages);
        if self.layout.memory_imported {
            memory.maximum = Some(MAXIMUM_PAGES);
        }
        Ok(memory)
    }

    fn parse_global(
        &mut self,
        globals: &mut GlobalSection,
        global: wasmparser::Global<'_>,
    ) -> ReencodeResult<()> {
        let index = self.layout.imported_globals + self.next_global;
        self.next_global += 1;
        if self.layout.heap_base.map(|heap_base| heap_base.global) != Some(index) {
            return reencode::utils::parse_global(self, globals, global);
        }
        globals.global(
            self.global_type(global.ty)?,
            &ConstExpr::i32_const(self.heap_base as i32),
        );
        Ok(())
    }

    fn parse_global_section(
        &mut self,
        globals: &mut GlobalSection,
        section: wasmparser::GlobalSectionReader<'_>,
    ) -> ReencodeResult<()> {
        reencode::utils::parse_global_section(self, globals, section)?;
        self.table_globals(globals);
        Ok(())
    }

    fn parse_export_section(
        &mut self,
        exports: &mut ExportSection,
        section: wasmparser::ExportSectionReader<'_>,
    ) -> ReencodeResult<()> {
        reencode::utils::parse_export_section(self, exports, section)?;
        self.table_exports(exports);
        Ok(())
    }

    fn intersperse_section_hook(
        &mut self,
        module: &mut Module,
        after: Option<SectionId>,
        before: Option<SectionId>,
    ) -> ReencodeResult<()> {
        if absent(SectionId::Global, after, before) {
            let mut globals = GlobalSection::new();
            self.table_globals(&mut globals);
            module.section(&globals);
        }
        if absent(SectionId::Export, after, before) {
            let mut exports = ExportSection::new();
            self.table_exports(&mut exports);
            module.section(&exports);
        }
        if before == Some(SectionId::Code) {
            self.code_position = module.as_slice().len();
        }
        Ok(())
    }

    fn parse_custom_section(
        &mut self,
        module: &mut Module,
        section: wasmparser::CustomSectionReader<'_>,
    ) -> ReencodeResult<()> {
        if matches!(section.name(), BRANCH_HINT_SECTION | AT_EXEC_SECTION) {
            return Ok(());
        }
        reencode::utils::parse_custom_section(self, module, section)
    }

    fn parse_type_section(
        &mut self,
        types: &mut TypeSection,
        section: wasmparser::TypeSectionReader<'_>,
    ) -> ReencodeResult<()> {
        reencode::utils::parse_type_section(self, types, section)?;
        types.ty().function([ValType::I32], [ValType::I32]);
        types
            .ty()
            .function([ValType::I32, ValType::I32], [ValType::I64]);
        types
            .ty()
            .function([ValType::I32, ValType::I32, ValType::I64], []);
        types
            .ty()
            .function([ValType::I32, ValType::I32, ValType::I32], []);
        types.ty().function([], []);
        for thunk in &self.layout.thunks {
            let (params, results) = thunk.signature();
            types.ty().function(params, results);
        }
        Ok(())
    }

    fn parse_function_section(
        &mut self,
        functions: &mut FunctionSection,
        section: wasmparser::FunctionSectionReader<'_>,
    ) -> ReencodeResult<()> {
        reencode::utils::parse_function_section(self, functions, section)?;
        let types = [
            HelperType::Translate,
            HelperType::Translate,
            HelperType::Translate,
            HelperType::LoadBytes,
            HelperType::StoreBytes,
            HelperType::Bulk,
            HelperType::Bulk,
            HelperType::Stop,
        ];
        for ty in types {
            functions.function(self.layout.type_index(ty));
        }
        for _ in 0..self.layout.data_segments {
            functions.function(self.layout.type_index(HelperType::Bulk));
        }
        for thunk in 0..self.layout.thunks.len() as u32 {
            functions.function(self.layout.thunk_type(thunk));
        }
        Ok(())
    }

    fn parse_code_section(
        &mut self,
        code: &mut CodeSection,
        section: wasmparser::CodeSectionReader<'_>,
    ) -> ReencodeResult<()> {
        reencode::utils::parse_code_section(self, code, section)?;
        let layout = self.layout;
        let mut bodies = self.helper_bodies();
        for thunk in &layout.thunks {
            bodies.push(self.thunk(thunk)?);
        }
        for (helper, body) in (layout.helper(Helper::TranslateRead)..).zip(&bodies) {
            self.hint(helper, body);
            code.function(&body.function);
        }
        Ok(())
    }

    fn parse_function_body(
        &mut self,
        code: &mut CodeSection,
        body: wasmparser::FunctionBody<'_>,
    ) -> ReencodeResult<()> {
        let params = self.layout.params(self.next_function);
        let index = self.layout.imported_funcs + self.next_function as u32;
        self.next_function += 1;

        let mut locals = Vec::new();
        let mut declared = 0;
        for pair in body.get_locals_reader()? {
            let (count, ty) = pair?;
            declared += count;
            locals.push((count, self.val_type(ty)?));
        }
        let mut loops = Loops::new(&body)?;
        let mut scan = body.get_operators_reader()?;
        let mut scratched = false;
        while !scan.eof() && !scratched {
            let operator = scan.read()?;
            loops.step(&operator);
            scratched = match access(&operator) {
                Some(Access::Atomic { .. }) => true,
                Some(Access::Load(..) | Access::Store(..)) => loops.inline(),
                _ => false,
            };
        }
        if scratched {
            locals.extend(Scratch::LOCALS);
        }
        let scratch = Scratch::new(params + declared);

        let mut loops = Loops::new(&body)?;
        let mut rewritten = Body::from(Function::new(locals));
        if scratched {
            rewritten
                .function
                .instructions()
                .global_get(self.layout.table_global())
                .local_set(scratch.table);
        }
        let mut reader = body.get_operators_reader()?;
        while !reader.eof() {
            let operator = reader.read()?;
            loops.step(&operator);
            match access(&operator) {
                Some(access) => {
                    self.emit_access(&mut rewritten, operator, access, loops.inline(), &scratch)?
                }
                None => {
                    rewritten.function.instruction(&self.instruction(operator)?);
                }
            }
        }
        self.hint(index, &rewritten);
        code.function(&rewritten.function);
        Ok(())
    }
}

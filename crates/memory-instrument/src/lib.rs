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

use std::{convert::Infallible, str::FromStr};

use anyhow::{Context, Result, anyhow, bail, ensure};
use wasm_encoder::{
    BlockType, CodeSection, ConstExpr, ExportKind, ExportSection, Function, FunctionSection,
    GlobalSection, InstructionSink, MemArg as EncodedMemArg, Module, SectionId, TypeSection,
    ValType,
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
const TABLE_BASE_EXPORT: &str = "__memory_table_base";
const GROUP_BASE_EXPORT: &str = "__memory_group_base";
const STOP_BASE_EXPORT: &str = "__memory_stop_base";
const STOP_ACKNOWLEDGED: u32 = 4;
const OFFSET_MASK: i32 = (PAGE_BYTES - 1) as i32;

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
    };
    let mut module = Module::new();
    rewriter
        .parse_core_module(&mut module, Parser::new(0), input)
        .map_err(|error| anyhow!("rewriting module: {error}"))?;
    let output = module.finish();

    Validator::new_with_features(features())
        .validate_all(&output)
        .context("rewritten module failed validation")?;
    Ok(output)
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
struct Layout {
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

impl Layout {
    fn read(input: &[u8], role: Role) -> Result<Self> {
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

    fn helper(&self, helper: Helper) -> u32 {
        self.imported_funcs + self.defined_types.len() as u32 + helper.offset()
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
}

impl Helper {
    fn offset(self) -> u32 {
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

struct Scratch {
    addr: u32,
    entry: u32,
    i32: [u32; 2],
    i64: [u32; 2],
    f32: u32,
    f64: u32,
}

impl Scratch {
    const LOCALS: [(u32, ValType); 4] = [
        (4, ValType::I32),
        (2, ValType::I64),
        (1, ValType::F32),
        (1, ValType::F64),
    ];

    fn new(base: u32) -> Self {
        Self {
            addr: base,
            entry: base + 1,
            i32: [base + 2, base + 3],
            i64: [base + 4, base + 5],
            f32: base + 6,
            f64: base + 7,
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

struct Rewriter<'a> {
    layout: &'a Layout,
    crossing: Crossing,
    table_base: u32,
    heap_base: u32,
    minimum_pages: u64,
    next_global: u32,
    next_function: usize,
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

    fn emit_table_entry(&self, sink: &mut InstructionSink<'_>, write: bool) {
        self.emit_table_entry_address(sink);
        sink.i32_load(table_memarg(write));
    }

    fn emit_table_entry_address(&self, sink: &mut InstructionSink<'_>) {
        sink.i32_const(14)
            .i32_shr_u()
            .i32_const(-4)
            .i32_and()
            .global_get(self.layout.table_global())
            .i32_add();
    }

    fn emit_access(
        &mut self,
        function: &mut Function,
        operator: Operator<'_>,
        access: Access,
        scratch: &Scratch,
    ) -> ReencodeResult<()> {
        let (memarg, operands, write, slow) = match access {
            Access::Copy => return self.emit_call(function, Helper::Copy),
            Access::Fill => return self.emit_call(function, Helper::Fill),
            Access::Init(segment) => return self.emit_call(function, Helper::Init(segment)),
            Access::Load(memarg, widen) => (
                memarg,
                &[][..],
                false,
                self.crosses(&memarg).then_some(Slow::Load(widen)),
            ),
            Access::Store(memarg, value) => (
                memarg,
                value.operands(),
                true,
                self.crosses(&memarg).then_some(Slow::Store(value)),
            ),
            Access::Atomic {
                memarg,
                operands,
                write,
            } => (memarg, operands, write, None),
        };
        let original = self.instruction(operator)?;
        let slots = scratch.slots(operands);

        let mut sink = function.instructions();
        for slot in slots.iter().rev() {
            sink.local_set(*slot);
        }
        sink.local_set(scratch.addr);

        let Some(slow) = slow else {
            self.emit_fast(&mut sink, &memarg, write, &slots, scratch);
            drop(sink);
            function.instruction(&original);
            return Ok(());
        };

        let size = 1u32 << memarg.max_align;
        emit_effective_address(&mut sink, &memarg, scratch);
        sink.i32_const(OFFSET_MASK)
            .i32_and()
            .i32_const((PAGE_BYTES - size) as i32)
            .i32_gt_u();
        match slow {
            Slow::Load(widen) => sink.if_(BlockType::Result(widen.val_type())),
            Slow::Store(_) => sink.if_(BlockType::Empty),
        };
        emit_effective_address(&mut sink, &memarg, scratch);
        sink.i32_const(size as i32);
        match slow {
            Slow::Load(widen) => {
                sink.call(self.layout.helper(Helper::LoadBytes));
                widen.narrow_from_i64(&mut sink, size);
            }
            Slow::Store(value) => {
                sink.local_get(slots[0]);
                value.widen_to_i64(&mut sink);
                sink.call(self.layout.helper(Helper::StoreBytes));
            }
        }
        sink.else_();
        self.emit_fast(&mut sink, &memarg, write, &slots, scratch);
        drop(sink);
        function.instruction(&original);
        function.instructions().end();
        Ok(())
    }

    fn emit_fast(
        &self,
        sink: &mut InstructionSink<'_>,
        memarg: &MemArg,
        write: bool,
        slots: &[u32],
        scratch: &Scratch,
    ) {
        sink.local_get(scratch.addr);
        emit_effective_address(sink, memarg, scratch);
        self.emit_table_entry(sink, write);
        if write {
            sink.local_tee(scratch.entry)
                .i32_const(COW_BIT)
                .i32_and()
                .if_(BlockType::Empty);
            emit_effective_address(sink, memarg, scratch);
            sink.call(self.layout.helper(Helper::CowFault))
                .local_set(scratch.entry)
                .end()
                .local_get(scratch.entry);
        }
        sink.i32_add();
        for slot in slots {
            sink.local_get(*slot);
        }
    }

    fn emit_call(&self, function: &mut Function, helper: Helper) -> ReencodeResult<()> {
        function.instructions().call(self.layout.helper(helper));
        Ok(())
    }

    fn helper_bodies(&self) -> Vec<Function> {
        let mut bodies = vec![
            self.translate_read(),
            self.translate_write(),
            self.cow_fault(),
            self.load_bytes(),
            self.store_bytes(),
            self.copy(),
            self.chunked(|sink, _| {
                sink.memory_fill(0);
            }),
            self.stop(),
        ];
        bodies.extend((0..self.layout.data_segments).map(|segment| {
            self.chunked(move |sink, cursor| {
                sink.memory_init(0, segment);
                sink.local_get(cursor)
                    .local_get(3)
                    .i32_add()
                    .local_set(cursor);
            })
        }));
        bodies
    }

    fn translate_read(&self) -> Function {
        let mut function = Function::new([]);
        let mut sink = function.instructions();
        sink.local_get(0).local_get(0);
        self.emit_table_entry(&mut sink, false);
        sink.i32_add().end();
        function
    }

    fn translate_write(&self) -> Function {
        let mut function = Function::new([(1, ValType::I32)]);
        let mut sink = function.instructions();
        sink.local_get(0);
        self.emit_table_entry(&mut sink, true);
        sink.local_tee(1)
            .i32_const(COW_BIT)
            .i32_and()
            .if_(BlockType::Empty)
            .local_get(0)
            .call(self.layout.helper(Helper::CowFault))
            .local_set(1)
            .end()
            .local_get(0)
            .local_get(1)
            .i32_add()
            .end();
        function
    }

    fn cow_fault(&self) -> Function {
        let (addr, slot, delta, physical, fresh, sharers, entry) = (0, 1, 2, 3, 4, 5, 6);
        let group = self.layout.group_global();
        let mut function = Function::new([(6, ValType::I32)]);
        let mut sink = function.instructions();

        sink.local_get(addr);
        self.emit_table_entry_address(&mut sink);
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
            .drop();
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

fn byte_memarg() -> EncodedMemArg {
    EncodedMemArg {
        offset: 0,
        align: 0,
        memory_index: 0,
    }
}

fn emit_effective_address(sink: &mut InstructionSink<'_>, memarg: &MemArg, scratch: &Scratch) {
    sink.local_get(scratch.addr);
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
        Ok(())
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
        Ok(())
    }

    fn parse_code_section(
        &mut self,
        code: &mut CodeSection,
        section: wasmparser::CodeSectionReader<'_>,
    ) -> ReencodeResult<()> {
        reencode::utils::parse_code_section(self, code, section)?;
        for body in self.helper_bodies() {
            code.function(&body);
        }
        Ok(())
    }

    fn parse_function_body(
        &mut self,
        code: &mut CodeSection,
        body: wasmparser::FunctionBody<'_>,
    ) -> ReencodeResult<()> {
        let params = self.layout.params(self.next_function);
        self.next_function += 1;

        let mut locals = Vec::new();
        let mut declared = 0;
        for pair in body.get_locals_reader()? {
            let (count, ty) = pair?;
            declared += count;
            locals.push((count, self.val_type(ty)?));
        }
        let mut scan = body.get_operators_reader()?;
        let mut touches_memory = false;
        while !scan.eof() && !touches_memory {
            touches_memory = access(&scan.read()?).is_some();
        }
        if touches_memory {
            locals.extend(Scratch::LOCALS);
        }
        let scratch = Scratch::new(params + declared);

        let mut function = Function::new(locals);
        let mut reader = body.get_operators_reader()?;
        while !reader.eof() {
            let operator = reader.read()?;
            match access(&operator) {
                Some(access) => self.emit_access(&mut function, operator, access, &scratch)?,
                None => {
                    function.instruction(&self.instruction(operator)?);
                }
            }
        }
        code.function(&function);
        Ok(())
    }
}

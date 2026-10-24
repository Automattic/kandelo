//! Native linked-runtime planning and serial control-body generation.
//!
//! This adds the ABI's state controls and scalar snapshot prefix. It does not
//! rewrite activations, capture reference/module state or mark a fork artifact.

use anyhow::{Context, Result, ensure};
use wasm_encoder::{
    ConstExpr, EntityType, ExportKind, FuncType, Function, GlobalType, Instruction, MemArg,
    RefType, TableType, TagKind, TagType, ValType,
    reencode::{Error, Reencode},
};
use wasmparser::{Parser, Payload, TypeRef};

use super::{
    FrozenDeclarations, FrozenImports, FrozenModuleDeclarations, FunctionTransform,
    ImportIndexError, ModuleDeclarationBuilder, PlannedImport, Scan,
};
use crate::runtime::{
    ABORT_SELECTOR_SIZE, STATE_ABORT_UNWINDING, STATE_NORMAL, STATE_REWINDING, STATE_UNWINDING,
    names,
};

#[derive(Clone, Copy, Debug)]
pub struct CodecPair {
    pub encode: u32,
    pub decode: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct NativeReferenceCodecs {
    pub funcref: CodecPair,
    pub externref: CodecPair,
    pub exnref: CodecPair,
    pub anyref: CodecPair,
}

/// Overrides already name final output helpers. Their declaration and typed
/// implementation belong to module-state/recipe planning, not runtime emit.
#[derive(Clone, Copy, Debug, Default)]
pub struct NativeCodecOverrides {
    pub funcref: Option<CodecPair>,
    pub externref: Option<CodecPair>,
    pub exnref: Option<CodecPair>,
    pub anyref: Option<CodecPair>,
    pub cleanup: Option<u32>,
}

/// Other passes may declare their import types/imports before this runtime.
/// Types start after original source types and already use output identities.
#[derive(Debug, Default)]
pub struct RuntimeInputs {
    pub types: Vec<FuncType>,
    pub imports: Vec<PlannedImport>,
    pub codecs: NativeCodecOverrides,
}

#[derive(Clone, Copy, Debug)]
pub struct NativeRuntimeIndices {
    pub state_global: u32,
    pub buf_global: u32,
    pub call_index_global: u32,
    pub frame_global: u32,
    pub frame_reserve: u32,
    pub frame_commit: u32,
    pub frame_next: u32,
    pub frame_peek: u32,
    pub resume_peek: u32,
    pub resume_table: u32,
    pub unwind_tag: u32,
    pub reference_vector_begin: u32,
    pub reference_vector_append: u32,
    pub reference_vector_finish: u32,
    pub reference_vector_get: u32,
    pub unwind_begin: u32,
    pub unwind_end: u32,
    pub rewind_begin: u32,
    pub rewind_end: u32,
    pub abort_begin: u32,
    pub abort_end: u32,
    pub state: u32,
    pub codecs: NativeReferenceCodecs,
}

#[derive(Clone, Copy, Debug)]
pub struct SavedScalar {
    pub global: u32,
    pub ty: ValType,
    pub offset: u32,
}

pub struct NativeRuntime {
    imports: FrozenImports,
    functions: FrozenDeclarations,
    module: FrozenModuleDeclarations,
    indices: NativeRuntimeIndices,
    saved: Vec<SavedScalar>,
    pointer: ValType,
    memory: Option<u32>,
    frames_start: u32,
    fixed_prefix: u32,
    cleanup: Option<u32>,
}

fn add_type(
    types: &mut Vec<FuncType>,
    base: u32,
    params: &[ValType],
    results: &[ValType],
    budget: usize,
) -> Result<u32> {
    if let Some(i) = types
        .iter()
        .position(|ty| ty.params() == params && ty.results() == results)
    {
        return base
            .checked_add(u32::try_from(i)?)
            .context("runtime type index overflow");
    }
    ensure!(
        types.len() < budget / 128,
        "runtime types exceed metadata budget"
    );
    let index = base
        .checked_add(u32::try_from(types.len())?)
        .context("runtime type index overflow")?;
    types.push(FuncType::new(
        params.iter().copied(),
        results.iter().copied(),
    ));
    Ok(index)
}
fn add_import(
    imports: &mut Vec<PlannedImport>,
    module: &str,
    name: &str,
    ty: EntityType,
    budget: usize,
) -> Result<u32> {
    ensure!(
        imports.len() < budget / 128,
        "runtime imports exceed metadata budget"
    );
    let ordinal = u32::try_from(imports.len())?;
    imports.push(PlannedImport {
        module: module.into(),
        name: name.into(),
        ty,
    });
    Ok(ordinal)
}

impl NativeRuntime {
    pub fn plan(scan: &Scan<'_>, mut inputs: RuntimeInputs, budget: usize) -> Result<Self> {
        let types = scan.types.as_ref();
        let pointer = if types.memory_count() != 0 && types.memory_at(0).memory64 {
            ValType::I64
        } else {
            ValType::I32
        };
        let width = if pointer == ValType::I64 { 8 } else { 4 };
        ensure!(
            types.global_count() as usize <= budget / 128,
            "runtime scalar catalog exceeds metadata budget"
        );
        let base = types.core_type_count_in_module();
        // Validate caller-owned type/import metadata before adding or copying it.
        FrozenDeclarations::validate_parts(&inputs.types, &[], budget)?;
        let pp = add_type(&mut inputs.types, base, &[pointer], &[pointer], budget)?;
        let pv = add_type(&mut inputs.types, base, &[pointer], &[], budget)?;
        let ii = add_type(
            &mut inputs.types,
            base,
            &[ValType::I32],
            &[ValType::I32],
            budget,
        )?;
        let iiv = add_type(
            &mut inputs.types,
            base,
            &[ValType::I32, ValType::I32],
            &[],
            budget,
        )?;
        let iii = add_type(
            &mut inputs.types,
            base,
            &[ValType::I32, ValType::I32],
            &[ValType::I32],
            budget,
        )?;
        let vv = add_type(&mut inputs.types, base, &[], &[], budget)?;
        let vi = add_type(&mut inputs.types, base, &[], &[ValType::I32], budget)?;
        let module = wasm_posix_shared::abi::WPK_FORK_FRAME_IMPORT_MODULE;
        let mut function = |name, ty| {
            add_import(
                &mut inputs.imports,
                module,
                name,
                EntityType::Function(ty),
                budget,
            )
        };
        let reserve = function(names::IMPORT_FRAME_RESERVE, pp)?;
        let commit = function(names::IMPORT_FRAME_COMMIT, pv)?;
        let next = function(names::IMPORT_FRAME_NEXT, pp)?;
        let peek = function(names::IMPORT_FRAME_PEEK, pp)?;
        let resume_peek = function(names::IMPORT_RESUME_PEEK, ii)?;
        let vector_begin = function(names::IMPORT_REFERENCE_VECTOR_BEGIN, ii)?;
        let vector_append = function(names::IMPORT_REFERENCE_VECTOR_APPEND, iiv)?;
        let vector_finish = function(names::IMPORT_REFERENCE_VECTOR_FINISH, ii)?;
        let vector_get = function(names::IMPORT_REFERENCE_VECTOR_GET, iii)?;
        let table = add_import(
            &mut inputs.imports,
            module,
            names::IMPORT_RESUME_TABLE,
            EntityType::Table(TableType {
                element_type: RefType::FUNCREF,
                minimum: 1,
                maximum: None,
                table64: false,
                shared: false,
            }),
            budget,
        )?;
        let tag = add_import(
            &mut inputs.imports,
            names::IMPORT_UNWIND_TAG_MODULE,
            names::IMPORT_UNWIND_TAG,
            EntityType::Tag(TagType {
                kind: TagKind::Exception,
                func_type_idx: vv,
            }),
            budget,
        )?;
        let mut codecs = [None; 4];
        for (i, reference, encode, decode, override_pair) in [
            (
                0,
                RefType::FUNCREF,
                names::IMPORT_REF_ENCODE_FUNCREF,
                names::IMPORT_REF_DECODE_FUNCREF,
                inputs.codecs.funcref,
            ),
            (
                1,
                RefType::EXTERNREF,
                names::IMPORT_REF_ENCODE_EXTERNREF,
                names::IMPORT_REF_DECODE_EXTERNREF,
                inputs.codecs.externref,
            ),
            (
                2,
                RefType::EXNREF,
                names::IMPORT_REF_ENCODE_EXNREF,
                names::IMPORT_REF_DECODE_EXNREF,
                inputs.codecs.exnref,
            ),
            (
                3,
                RefType::ANYREF,
                names::IMPORT_REF_ENCODE_ANYREF,
                names::IMPORT_REF_DECODE_ANYREF,
                inputs.codecs.anyref,
            ),
        ] {
            if let Some(pair) = override_pair {
                codecs[i] = Some((true, pair));
                continue;
            }
            let encode_ty = add_type(
                &mut inputs.types,
                base,
                &[ValType::Ref(reference)],
                &[ValType::I32],
                budget,
            )?;
            let decode_ty = add_type(
                &mut inputs.types,
                base,
                &[ValType::I32],
                &[ValType::Ref(reference)],
                budget,
            )?;
            let encode = add_import(
                &mut inputs.imports,
                names::IMPORT_REFERENCE_CODEC_MODULE,
                encode,
                EntityType::Function(encode_ty),
                budget,
            )?;
            let decode = add_import(
                &mut inputs.imports,
                names::IMPORT_REFERENCE_CODEC_MODULE,
                decode,
                EntityType::Function(decode_ty),
                budget,
            )?;
            codecs[i] = Some((false, CodecPair { encode, decode }));
        }
        let mut imports = FrozenImports::new(scan, inputs.imports, budget)?;
        let index = |ordinal| {
            imports
                .index(ordinal)
                .expect("frozen runtime import ordinal")
        };
        let pair = |i: usize| {
            let (already_final, p) = codecs[i].unwrap();
            if already_final {
                p
            } else {
                CodecPair {
                    encode: index(p.encode),
                    decode: index(p.decode),
                }
            }
        };
        let reference_codecs = NativeReferenceCodecs {
            funcref: pair(0),
            externref: pair(1),
            exnref: pair(2),
            anyref: pair(3),
        };
        let helper = imports.helper_function_base();
        ensure!(
            helper.checked_add(7).is_some(),
            "runtime helper function index overflow"
        );
        let functions =
            FrozenDeclarations::new(inputs.types, vec![pv, vv, pv, vv, pv, vv, vi], budget)?;
        let mut declarations = ModuleDeclarationBuilder::new(scan, Some(&imports), budget)?;
        let mut global = |ty, zero| {
            declarations.global(
                GlobalType {
                    val_type: ty,
                    mutable: true,
                    shared: false,
                },
                zero,
            )
        };
        let state_global = global(ValType::I32, ConstExpr::i32_const(STATE_NORMAL))?;
        let zero = || {
            if pointer == ValType::I64 {
                ConstExpr::i64_const(0)
            } else {
                ConstExpr::i32_const(0)
            }
        };
        let buf_global = global(pointer, zero())?;
        let call_index_global = global(ValType::I32, ConstExpr::i32_const(0))?;
        let frame_global = global(pointer, zero())?;
        for (i, name) in [
            names::EXPORT_UNWIND_BEGIN,
            names::EXPORT_UNWIND_END,
            names::EXPORT_REWIND_BEGIN,
            names::EXPORT_REWIND_END,
            names::EXPORT_ABORT_BEGIN,
            names::EXPORT_ABORT_END,
            names::EXPORT_STATE,
        ]
        .into_iter()
        .enumerate()
        {
            declarations.export(name, ExportKind::Func, helper + i as u32)?;
        }
        let indices = NativeRuntimeIndices {
            state_global,
            buf_global,
            call_index_global,
            frame_global,
            frame_reserve: index(reserve),
            frame_commit: index(commit),
            frame_next: index(next),
            frame_peek: index(peek),
            resume_peek: index(resume_peek),
            resume_table: index(table),
            unwind_tag: index(tag),
            reference_vector_begin: index(vector_begin),
            reference_vector_append: index(vector_append),
            reference_vector_finish: index(vector_finish),
            reference_vector_get: index(vector_get),
            unwind_begin: helper,
            unwind_end: helper + 1,
            rewind_begin: helper + 2,
            rewind_end: helper + 3,
            abort_begin: helper + 4,
            abort_end: helper + 5,
            state: helper + 6,
            codecs: reference_codecs,
        };
        let mut excluded = std::collections::BTreeSet::new();
        let mut source_global = 0;
        for payload in Parser::new(0).parse_all(scan.input()) {
            if let Payload::ImportSection(section) = payload? {
                for import in section.into_imports() {
                    let import = import?;
                    if matches!(import.ty, TypeRef::Global(_)) {
                        if import.module == "env" && import.name == "__channel_base" {
                            excluded.insert(source_global);
                        }
                        source_global += 1;
                    }
                }
            }
        }
        let map = &mut imports;
        let mut saved = Vec::with_capacity(types.global_count() as usize);
        let mut frames_start = 2 * width;
        for source_global in 0..types.global_count() {
            let ty = types.global_at(source_global);
            if !ty.mutable
                || matches!(ty.content_type, wasmparser::ValType::Ref(_))
                || excluded.contains(&source_global)
            {
                continue;
            }
            let ty = map.val_type(ty.content_type)?;
            let bytes = scalar_size(ty);
            saved.push(SavedScalar {
                global: map.global_index(source_global)?,
                ty,
                offset: frames_start,
            });
            frames_start = frames_start
                .checked_add(bytes)
                .context("runtime scalar prefix overflow")?;
        }
        let fixed_prefix = frames_start
            .checked_add(ABORT_SELECTOR_SIZE)
            .context("runtime prefix overflow")?;
        let memory = if types.memory_count() == 0 {
            None
        } else {
            Some(map.memory_index(0)?)
        };
        Ok(Self {
            imports,
            functions,
            module: declarations.freeze(),
            indices,
            saved,
            pointer,
            memory,
            frames_start,
            fixed_prefix,
            cleanup: inputs.codecs.cleanup,
        })
    }
    pub fn indices(&self) -> NativeRuntimeIndices {
        self.indices
    }
    pub fn imports_plan(&self) -> &FrozenImports {
        &self.imports
    }
    pub fn function_declarations(&self) -> &FrozenDeclarations {
        &self.functions
    }
    pub fn local_declarations(&self) -> &FrozenModuleDeclarations {
        &self.module
    }
    pub fn saved_globals(&self) -> &[SavedScalar] {
        &self.saved
    }
    pub fn pointer_type(&self) -> ValType {
        self.pointer
    }
    pub fn frames_start_offset(&self) -> u32 {
        self.frames_start
    }
    pub fn fixed_prefix_size(&self) -> u32 {
        self.fixed_prefix
    }
    pub fn emit_control(&self, helper: u32, limit: usize) -> Result<Function> {
        ensure!(helper < 7, "unknown runtime control helper");
        let mut f = Function::new([]);
        let r = self.indices;
        if matches!(helper, 1 | 3 | 5) {
            if let Some(cleanup) = self.cleanup {
                f.instruction(&Instruction::Call(cleanup));
            }
            f.instruction(&ptr_const(self.pointer, 0));
            f.instruction(&Instruction::GlobalSet(r.buf_global));
            f.instruction(&Instruction::I32Const(STATE_NORMAL));
            f.instruction(&Instruction::GlobalSet(r.state_global));
        } else if helper == 6 {
            f.instruction(&Instruction::GlobalGet(r.state_global));
        } else {
            f.instruction(&Instruction::I32Const(match helper {
                0 => STATE_UNWINDING,
                2 => STATE_REWINDING,
                4 => STATE_ABORT_UNWINDING,
                _ => unreachable!(),
            }));
            f.instruction(&Instruction::GlobalSet(r.state_global));
            f.instruction(&Instruction::LocalGet(0));
            f.instruction(&Instruction::GlobalSet(r.buf_global));
            if let Some(memory) = self.memory {
                if helper == 0 {
                    f.instruction(&Instruction::LocalGet(0));
                    f.instruction(&Instruction::LocalGet(0));
                    f.instruction(&ptr_const(self.pointer, i64::from(self.frames_start)));
                    f.instruction(&if self.pointer == ValType::I64 {
                        Instruction::I64Add
                    } else {
                        Instruction::I32Add
                    });
                    f.instruction(&store(
                        self.pointer,
                        MemArg {
                            offset: 0,
                            align: if self.pointer == ValType::I64 { 3 } else { 2 },
                            memory_index: memory,
                        },
                    ));
                }
                for saved in &self.saved {
                    f.instruction(&Instruction::GlobalGet(r.buf_global));
                    let arg = MemArg {
                        offset: u64::from(saved.offset),
                        align: scalar_size(saved.ty).trailing_zeros(),
                        memory_index: memory,
                    };
                    if helper == 0 {
                        f.instruction(&Instruction::GlobalGet(saved.global));
                        f.instruction(&store(saved.ty, arg));
                    } else {
                        f.instruction(&load(saved.ty, arg));
                        f.instruction(&Instruction::GlobalSet(saved.global));
                    }
                    ensure!(
                        f.byte_len() <= limit,
                        "runtime helper exceeds output budget"
                    );
                }
            }
        }
        f.instruction(&Instruction::End);
        ensure!(
            f.byte_len() <= limit,
            "runtime helper exceeds output budget"
        );
        Ok(f)
    }
}

fn scalar_size(ty: ValType) -> u32 {
    match ty {
        ValType::I32 | ValType::F32 => 4,
        ValType::I64 | ValType::F64 => 8,
        ValType::V128 => 16,
        _ => unreachable!("scalar runtime type"),
    }
}
pub(super) fn ptr_const(ty: ValType, value: i64) -> Instruction<'static> {
    if ty == ValType::I64 {
        Instruction::I64Const(value)
    } else {
        Instruction::I32Const(value as i32)
    }
}
pub(super) fn store(ty: ValType, arg: MemArg) -> Instruction<'static> {
    match ty {
        ValType::I32 => Instruction::I32Store(arg),
        ValType::I64 => Instruction::I64Store(arg),
        ValType::F32 => Instruction::F32Store(arg),
        ValType::F64 => Instruction::F64Store(arg),
        ValType::V128 => Instruction::V128Store(arg),
        _ => unreachable!(),
    }
}
pub(super) fn load(ty: ValType, arg: MemArg) -> Instruction<'static> {
    match ty {
        ValType::I32 => Instruction::I32Load(arg),
        ValType::I64 => Instruction::I64Load(arg),
        ValType::F32 => Instruction::F32Load(arg),
        ValType::F64 => Instruction::F64Load(arg),
        ValType::V128 => Instruction::V128Load(arg),
        _ => unreachable!(),
    }
}

impl Reencode for NativeRuntime {
    type Error = ImportIndexError;
    fn function_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.imports.function_index(i)
    }
    fn table_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.imports.table_index(i)
    }
    fn memory_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.imports.memory_index(i)
    }
    fn global_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.imports.global_index(i)
    }
    fn tag_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.imports.tag_index(i)
    }
}
impl FunctionTransform for NativeRuntime {
    fn imports(&self) -> Option<&FrozenImports> {
        Some(&self.imports)
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.functions)
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        Some(&self.module)
    }
    fn emit_helper(&mut self, helper: u32, limit: usize) -> Result<Function> {
        self.emit_control(helper, limit)
    }
}

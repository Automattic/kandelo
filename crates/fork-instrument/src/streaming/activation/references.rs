//! Typed recipe-vector frame I/O over frozen host/GC/exception codec identities.
use crate::streaming::frame::FRAME_REFERENCE_OFFSET;
use crate::streaming::runtime::{load, store};
use crate::streaming::{
    FrameEnvironment, FrameLayout, FrameReferencePlan, NativeReferenceCodecs, NativeRuntimeIndices,
    Scan,
};
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeMap, ops::Range};
use wasm_encoder::{
    AbstractHeapType, BlockType, Function, HeapType, Instruction, MemArg, RefType, ValType,
    reencode::Reencode,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum NativeReferenceClass {
    Func,
    Extern,
    Exn,
    Any,
}
impl NativeReferenceClass {
    pub fn broad_type(self) -> RefType {
        match self {
            Self::Func => RefType::FUNCREF,
            Self::Extern => RefType::EXTERNREF,
            Self::Exn => RefType::EXNREF,
            Self::Any => RefType::ANYREF,
        }
    }
    pub fn encoder(self, codecs: NativeReferenceCodecs) -> u32 {
        match self {
            Self::Func => codecs.funcref.encode,
            Self::Extern => codecs.externref.encode,
            Self::Exn => codecs.exnref.encode,
            Self::Any => codecs.anyref.encode,
        }
    }
    pub fn decoder(self, codecs: NativeReferenceCodecs) -> u32 {
        match self {
            Self::Func => codecs.funcref.decode,
            Self::Extern => codecs.externref.decode,
            Self::Exn => codecs.exnref.decode,
            Self::Any => codecs.anyref.decode,
        }
    }
    pub fn emit_narrow(self, expected: RefType, output: &mut Function) {
        if expected.heap_type != self.broad_type().heap_type {
            output.instruction(&if expected.nullable {
                Instruction::RefCastNullable(expected.heap_type)
            } else {
                Instruction::RefCastNonNull(expected.heap_type)
            });
        } else if !expected.nullable {
            output.instruction(&Instruction::RefAsNonNull);
        }
    }
}
/// Build once per frozen source type mapping. Provider-only generated types
/// do not occur in original activation values and need no source entries.
pub struct FrozenReferenceKinds {
    concrete: BTreeMap<u32, NativeReferenceClass>,
}
impl FrozenReferenceKinds {
    pub fn new<T: Reencode>(scan: &Scan<'_>, map: &mut T, budget: usize) -> Result<Self>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        let types = scan.types.as_ref();
        let count = types.core_type_count_in_module();
        ensure!(
            count as usize <= budget / 128,
            "reference type catalog exceeds metadata budget"
        );
        let mut concrete = BTreeMap::new();
        for source in 0..count {
            let ty = types.get(types.core_type_at_in_module(source)).unwrap();
            let class = match ty.composite_type.inner {
                wasmparser::CompositeInnerType::Func(_) => NativeReferenceClass::Func,
                wasmparser::CompositeInnerType::Array(_)
                | wasmparser::CompositeInnerType::Struct(_) => NativeReferenceClass::Any,
                _ => anyhow::bail!("reference type hierarchy requires an explicit codec class"),
            };
            let index = map.type_index(source)?;
            if let Some(old) = concrete.insert(index, class) {
                ensure!(old == class, "mapped reference type classes disagree");
            }
        }
        Ok(Self { concrete })
    }
    pub fn class(&self, ty: RefType) -> Result<NativeReferenceClass> {
        Ok(match ty.heap_type {
            HeapType::Concrete(i) | HeapType::Exact(i) => *self
                .concrete
                .get(&i)
                .context("reference type has no frozen source class")?,
            HeapType::Abstract {
                ty: AbstractHeapType::Func | AbstractHeapType::NoFunc,
                ..
            } => NativeReferenceClass::Func,
            HeapType::Abstract {
                ty: AbstractHeapType::Extern | AbstractHeapType::NoExtern,
                ..
            } => NativeReferenceClass::Extern,
            HeapType::Abstract {
                ty: AbstractHeapType::Exn | AbstractHeapType::NoExn,
                ..
            } => NativeReferenceClass::Exn,
            HeapType::Abstract {
                ty:
                    AbstractHeapType::Any
                    | AbstractHeapType::None
                    | AbstractHeapType::Eq
                    | AbstractHeapType::Struct
                    | AbstractHeapType::Array
                    | AbstractHeapType::I31,
                ..
            } => NativeReferenceClass::Any,
            _ => anyhow::bail!("reference heap hierarchy requires an explicit recipe provider"),
        })
    }
}
/// Adjacent landings with the same saved references and known-null locals
/// share one guard. Keep an index into the plan instead of copying slot lists.
struct LandingRun {
    calls: Range<u32>,
    representative: usize,
}
pub struct NativeReferenceIo {
    classes: Vec<NativeReferenceClass>,
    runs: Vec<LandingRun>,
}
impl NativeReferenceIo {
    pub fn plan(
        plan: &FrameReferencePlan,
        kinds: &FrozenReferenceKinds,
        budget: usize,
    ) -> Result<Self> {
        ensure!(
            plan.slots_by_call.len() == plan.null_locals_by_call.len(),
            "reference frame landing count mismatch"
        );
        let estimate = plan
            .slots
            .len()
            .checked_mul(32)
            .and_then(|n| n.checked_add(plan.slots_by_call.len().checked_mul(64)?))
            .context("reference I/O metadata overflow")?;
        ensure!(estimate <= budget, "reference I/O exceeds metadata budget");
        let classes = plan
            .slots
            .iter()
            .map(|slot| kinds.class(slot.ty))
            .collect::<Result<Vec<_>>>()?;
        let mut runs: Vec<LandingRun> = Vec::new();
        for index in 0..plan.slots_by_call.len() {
            if let Some(last) = runs.last_mut() {
                if plan.slots_by_call[last.representative] == plan.slots_by_call[index]
                    && plan.null_locals_by_call[last.representative]
                        == plan.null_locals_by_call[index]
                {
                    last.calls.end = u32::try_from(index + 1)?;
                    continue;
                }
            }
            runs.push(LandingRun {
                calls: u32::try_from(index)?..u32::try_from(index + 1)?,
                representative: index,
            });
        }
        Ok(Self { classes, runs })
    }
    pub fn emit_restore(
        &self,
        plan: &FrameReferencePlan,
        layout: &FrameLayout,
        environment: FrameEnvironment,
        runtime: NativeRuntimeIndices,
        output: &mut Function,
        limit: usize,
    ) -> Result<()> {
        ensure!(
            self.classes.len() == plan.slots.len(),
            "reference I/O slot count changed"
        );
        for run in &self.runs {
            let slots = &plan.slots_by_call[run.representative];
            let nulls = &plan.null_locals_by_call[run.representative];
            if slots.is_empty() && nulls.is_empty() {
                continue;
            }
            emit_landing_guard(run, runtime, output);
            for (position, &index) in slots.iter().enumerate() {
                let slot = plan.slots[index];
                let class = self.classes[index];
                emit_frame_address(environment, runtime, output);
                output.instruction(&load(ValType::I32, reference_field(environment)));
                output.instruction(&Instruction::I32Const(i32::try_from(position)?));
                output.instruction(&Instruction::Call(runtime.reference_vector_get));
                output.instruction(&Instruction::Call(class.decoder(runtime.codecs)));
                class.emit_narrow(slot.ty, output);
                layout.emit_set(slot.local, output, limit)?;
            }
            for &(local, ty) in nulls {
                output.instruction(&Instruction::RefNull(ty.heap_type));
                layout.emit_set(local, output, limit)?;
            }
            output.instruction(&Instruction::End);
            check_output_limit(output, limit)?;
        }
        Ok(())
    }
    pub fn emit_save(
        &self,
        plan: &FrameReferencePlan,
        layout: &FrameLayout,
        environment: FrameEnvironment,
        runtime: NativeRuntimeIndices,
        output: &mut Function,
        limit: usize,
    ) -> Result<()> {
        ensure!(
            self.classes.len() == plan.slots.len(),
            "reference I/O slot count changed"
        );
        for run in &self.runs {
            let slots = &plan.slots_by_call[run.representative];
            if slots.is_empty() {
                continue;
            }
            emit_landing_guard(run, runtime, output);
            // The header temporarily owns a builder handle. Replace it with the
            // durable vector ordinal before the caller commits this frame.
            emit_frame_address(environment, runtime, output);
            output.instruction(&Instruction::I32Const(i32::try_from(slots.len())?));
            output.instruction(&Instruction::Call(runtime.reference_vector_begin));
            output.instruction(&store(ValType::I32, reference_field(environment)));
            for &index in slots {
                emit_frame_address(environment, runtime, output);
                output.instruction(&load(ValType::I32, reference_field(environment)));
                let slot = plan.slots[index];
                layout.emit_get(slot.local, output, limit)?;
                output.instruction(&Instruction::Call(
                    self.classes[index].encoder(runtime.codecs),
                ));
                output.instruction(&Instruction::Call(runtime.reference_vector_append));
                check_output_limit(output, limit)?;
            }
            emit_frame_address(environment, runtime, output);
            emit_frame_address(environment, runtime, output);
            output.instruction(&load(ValType::I32, reference_field(environment)));
            output.instruction(&Instruction::Call(runtime.reference_vector_finish));
            output.instruction(&store(ValType::I32, reference_field(environment)));
            output.instruction(&Instruction::End);
            check_output_limit(output, limit)?;
        }
        Ok(())
    }
}
fn reference_field(environment: FrameEnvironment) -> MemArg {
    MemArg {
        offset: FRAME_REFERENCE_OFFSET,
        align: 2,
        memory_index: environment.memory.unwrap(),
    }
}
fn emit_frame_address(
    environment: FrameEnvironment,
    runtime: NativeRuntimeIndices,
    output: &mut Function,
) {
    output.instruction(&Instruction::GlobalGet(runtime.buf_global));
    output.instruction(&load(
        environment.pointer,
        MemArg {
            offset: 0,
            align: if environment.pointer == ValType::I64 {
                3
            } else {
                2
            },
            memory_index: environment.memory.unwrap(),
        },
    ));
}
fn emit_landing_guard(run: &LandingRun, runtime: NativeRuntimeIndices, output: &mut Function) {
    output.instruction(&Instruction::GlobalGet(runtime.call_index_global));
    if run.calls.start != 0 {
        output.instruction(&Instruction::I32Const(run.calls.start as i32));
        output.instruction(&Instruction::I32Sub);
    }
    output.instruction(&Instruction::I32Const(run.calls.len() as i32));
    output.instruction(&Instruction::I32LtU);
    output.instruction(&Instruction::If(BlockType::Empty));
}
fn check_output_limit(output: &Function, limit: usize) -> Result<()> {
    ensure!(
        output.byte_len() <= limit,
        "reference frame I/O exceeds output budget"
    );
    Ok(())
}

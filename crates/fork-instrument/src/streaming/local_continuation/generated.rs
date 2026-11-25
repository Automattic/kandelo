//! Wasm operations that the SDK's C provider cannot express: EH delimiting,
//! shadow stack switching, typed resume dispatch, and reference ownership.

use super::*;
use std::borrow::Cow;
use wasm_encoder::{
    BlockType, Catch as Handler, FuncType, GlobalType, RefType, TableType, ValType,
};

const REFERENCE_TYPES: [RefType; 4] = [
    RefType::FUNCREF,
    RefType::EXTERNREF,
    RefType::EXNREF,
    RefType::ANYREF,
];

pub(super) fn codec_bindings() -> NativeCodecOverrides {
    let pair = |class: u32| {
        Some(CodecPair {
            encode: CONTROLS + class * 2,
            decode: CONTROLS + class * 2 + 1,
        })
    };
    NativeCodecOverrides {
        funcref: pair(0),
        externref: pair(1),
        exnref: pair(2),
        anyref: pair(3),
        cleanup: None,
    }
}

struct ReferenceTable {
    table: u32,
    next: u32,
    ty: RefType,
}

pub(super) struct Generated {
    pub declarations: FrozenDeclarations,
    runtime: NativeRuntimeIndices,
    references: Vec<ReferenceTable>,
    stack_pointer: u32,
    function_table: u32,
    entry_type: u32,
    resume_type: u32,
    dispatch: u32,
    dispatch_finish: u32,
    track_reference: u32,
    clear_reference: u32,
}

impl Generated {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn plan(
        scan: &Scan<'_>,
        runtime: &NativeRuntime,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        first_type: u32,
        dispatch: u32,
        dispatch_finish: u32,
        track_reference: u32,
        clear_reference: u32,
        budget: usize,
    ) -> Result<Self> {
        let saved = runtime.saved_globals();
        ensure!(
            saved.len() == 1 && saved[0].ty == ValType::I32,
            "SDK local continuations require a wasm32 shadow stack"
        );
        let stack_pointer = saved[0].global;
        let function_table = scan
            .exports
            .iter()
            .find(|(name, kind, _)| {
                name == "__indirect_function_table" && *kind == ExternalKind::Table
            })
            .map(|(_, _, index)| *index)
            .context("SDK local continuations require the LLD function table")?;
        let ty = scan.types.as_ref().table_at(function_table);
        ensure!(
            !ty.table64 && ty.element_type == wasmparser::RefType::FUNCREF,
            "SDK local continuations require an i32 function table"
        );
        let mut types = Vec::new();
        let mut functions = Vec::new();
        let mut add_type = |params: &[ValType], results: &[ValType]| -> Result<u32> {
            let index = first_type
                .checked_add(u32::try_from(types.len())?)
                .context("local continuation type index overflow")?;
            types.push(FuncType::new(
                params.iter().copied(),
                results.iter().copied(),
            ));
            Ok(index)
        };
        let entry_type = add_type(&[ValType::I32], &[])?;
        let resume_type = add_type(&[], &[])?;
        let mut references = Vec::new();
        for ty in REFERENCE_TYPES {
            let reference = ValType::Ref(ty);
            functions.push(add_type(&[reference], &[ValType::I32])?);
            functions.push(add_type(&[ValType::I32], &[reference])?);
            let table = module.table(
                TableType {
                    element_type: ty,
                    minimum: 1, // zero is the null reference
                    maximum: None,
                    table64: false,
                    shared: false,
                },
                None,
            )?;
            let next = module.global(
                GlobalType {
                    val_type: ValType::I32,
                    mutable: true,
                    shared: false,
                },
                ConstExpr::i32_const(1),
            )?;
            references.push(ReferenceTable { table, next, ty });
        }
        Ok(Self {
            declarations: FrozenDeclarations::new(types, functions, budget)?,
            runtime: runtime.indices(),
            references,
            stack_pointer,
            function_table,
            entry_type,
            resume_type,
            dispatch,
            dispatch_finish,
            track_reference,
            clear_reference,
        })
    }

    pub(super) fn replace(&self, index: u32, limit: usize) -> Result<Option<Function>> {
        let body = if index == self.dispatch {
            self.dispatch()
        } else if index == self.clear_reference {
            self.clear()
        } else {
            return Ok(None);
        };
        ensure!(
            body.byte_len() <= limit,
            "SDK local continuation shim exceeds output budget"
        );
        Ok(Some(body))
    }

    fn dispatch(&self) -> Function {
        use Instruction::*;
        let r = self.runtime;
        let mut body = Function::new_with_locals_types([ValType::I32]);
        let parent_stack = 5;
        let mut emit = |op| {
            body.instruction(&op);
        };
        emit(GlobalGet(self.stack_pointer));
        emit(LocalSet(parent_stack));
        emit(Block(BlockType::Result(ValType::EXNREF)));
        emit(Block(BlockType::Empty));
        emit(TryTable(
            BlockType::Empty,
            Cow::Owned(vec![
                Handler::One {
                    tag: r.unwind_tag,
                    label: 0,
                },
                Handler::AllRef { label: 1 },
            ]),
        ));
        emit(LocalGet(4));
        emit(If(BlockType::Empty));
        emit(LocalGet(0));
        emit(Call(r.rewind_begin));
        emit(I32Const(0));
        emit(Call(r.resume_peek));
        emit(CallIndirect {
            type_index: self.resume_type,
            table_index: r.resume_table,
        });
        emit(Else);
        emit(LocalGet(1));
        emit(GlobalSet(self.stack_pointer));
        emit(LocalGet(3));
        emit(LocalGet(2));
        emit(CallIndirect {
            type_index: self.entry_type,
            table_index: self.function_table,
        });
        emit(End);
        emit(End);
        emit(LocalGet(parent_stack));
        emit(GlobalSet(self.stack_pointer));
        emit(I32Const(0));
        emit(Call(self.dispatch_finish));
        emit(I32Const(0));
        emit(Return);
        emit(End);
        emit(Call(r.unwind_end));
        emit(LocalGet(parent_stack));
        emit(GlobalSet(self.stack_pointer));
        emit(I32Const(1));
        emit(Call(self.dispatch_finish));
        emit(I32Const(1));
        emit(Return);
        emit(End);
        // An ordinary exception may escape the user's callback. Releasing
        // TLS ownership on the restored caller stack precedes rethrow.
        emit(LocalGet(parent_stack));
        emit(GlobalSet(self.stack_pointer));
        emit(I32Const(0));
        emit(Call(self.dispatch_finish));
        emit(ThrowRef);
        emit(End);
        body
    }

    fn clear(&self) -> Function {
        use Instruction::*;
        let mut body = Function::new([]);
        let mut emit = |op| {
            body.instruction(&op);
        };
        for (class, r) in self.references.iter().enumerate() {
            emit(LocalGet(0));
            emit(I32Const(class as i32));
            emit(I32Eq);
            emit(If(BlockType::Empty));
            emit(LocalGet(1));
            emit(RefNull(r.ty.heap_type));
            emit(TableSet(r.table));
            emit(LocalGet(1));
            emit(GlobalGet(r.next));
            emit(I32LtU);
            emit(If(BlockType::Empty));
            emit(LocalGet(1));
            emit(GlobalSet(r.next));
            emit(End);
            emit(Return);
            emit(End);
        }
        emit(Unreachable);
        emit(End);
        body
    }

    pub(super) fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        use Instruction::*;
        let class = ordinal / 2;
        let r = &self.references[class as usize];
        let result = if ordinal % 2 == 0 {
            let mut body = Function::new_with_locals_types([ValType::I32]);
            let mut emit = |op| {
                body.instruction(&op);
            };
            emit(LocalGet(0));
            emit(RefIsNull);
            emit(If(BlockType::Empty));
            emit(I32Const(0));
            emit(Return);
            emit(End);
            // The first free position at or above the hint is private
            // to this instance. Cleared slots lower the hint for reuse.
            emit(GlobalGet(r.next));
            emit(LocalSet(1));
            emit(Block(BlockType::Empty));
            emit(Loop(BlockType::Empty));
            emit(LocalGet(1));
            emit(TableSize(r.table));
            emit(I32Eq);
            emit(If(BlockType::Empty));
            emit(RefNull(r.ty.heap_type));
            emit(I32Const(1));
            emit(TableGrow(r.table));
            emit(I32Const(-1));
            emit(I32Eq);
            emit(If(BlockType::Empty));
            emit(Unreachable);
            emit(End);
            emit(Br(2));
            emit(End);
            emit(LocalGet(1));
            emit(TableGet(r.table));
            emit(RefIsNull);
            emit(BrIf(1));
            emit(LocalGet(1));
            emit(I32Const(1));
            emit(I32Add);
            emit(LocalSet(1));
            emit(Br(0));
            emit(End);
            emit(End);
            emit(I32Const(class as i32));
            emit(LocalGet(1));
            emit(Call(self.track_reference));
            emit(LocalGet(1));
            emit(LocalGet(0));
            emit(TableSet(r.table));
            emit(LocalGet(1));
            emit(I32Const(1));
            emit(I32Add);
            emit(GlobalSet(r.next));
            emit(LocalGet(1));
            emit(End);
            body
        } else {
            let mut body = Function::new([]);
            body.instruction(&LocalGet(0));
            body.instruction(&TableGet(r.table));
            body.instruction(&End);
            body
        };
        ensure!(
            result.byte_len() <= limit,
            "SDK local continuation codec exceeds output budget"
        );
        Ok(result)
    }
}

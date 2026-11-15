//! Instance-local mapping descriptors. Guest pointer values stay virtual.
use wasm_encoder::{Function, GlobalType, Instruction as I, MemArg, ValType as V};

pub const TYPES: [V; 9] = [
    V::I32,
    V::I32,
    V::I32,
    V::I32,
    V::I64,
    V::I64,
    V::I64,
    V::I32,
    V::I32,
];
pub fn global_type(value: V) -> GlobalType {
    GlobalType {
        val_type: value,
        mutable: true,
        shared: false,
    }
}
fn load(f: &mut Function, offset: u64) {
    f.instruction(&I::LocalGet(4));
    f.instruction(&I::I32Load(MemArg {
        offset,
        align: 2,
        memory_index: 0,
    }));
}
fn zero_return(f: &mut Function) {
    f.instruction(&I::I32Const(0));
    f.instruction(&I::Return);
}
fn bind(f: &mut Function, base: u32, binder: u32) {
    f.instruction(&I::LocalGet(4));
    f.instruction(&I::Call(binder));
    f.instruction(&I::I32Eqz);
    f.instruction(&I::If(wasm_encoder::BlockType::Empty));
    zero_return(f);
    f.instruction(&I::End);
    for (offset, slot) in [(24, 3), (40, 7), (44, 8), (16, 1), (0, 2)] {
        load(f, offset);
        f.instruction(&I::GlobalSet(base + slot));
    }
    for (offset, slot) in [(28, 4), (32, 5), (36, 6)] {
        load(f, offset);
        f.instruction(&I::I64ExtendI32U);
        f.instruction(&I::I64Const(16));
        f.instruction(&I::I64Shl);
        f.instruction(&I::GlobalSet(base + slot));
    }
    f.instruction(&I::LocalGet(4));
    f.instruction(&I::GlobalSet(base));
}
pub fn function(root_global: u32, binder: u32) -> Function {
    // Parameters: original base, constant offset, width, rights, bound root.
    // Locals: current epoch, effective address and exclusive end.
    let g = root_global + 2;
    let mut f = Function::new([(1, V::I32), (2, V::I64)]);
    f.instruction(&I::LocalGet(1));
    f.instruction(&I::I64Const(u32::MAX as i64));
    f.instruction(&I::I64GtU);
    f.instruction(&I::LocalGet(4));
    f.instruction(&I::I32Eqz);
    f.instruction(&I::I32Or);
    f.instruction(&I::If(wasm_encoder::BlockType::Empty));
    zero_return(&mut f);
    f.instruction(&I::End);
    f.instruction(&I::LocalGet(4));
    f.instruction(&I::GlobalGet(g));
    f.instruction(&I::I32Eq);
    f.instruction(&I::If(wasm_encoder::BlockType::Empty));
    // A previously bound metadata address remains allocated and memory cannot
    // shrink. Still compare logical size, including defensive shrink controls.
    load(&mut f, 16);
    f.instruction(&I::LocalTee(5));
    f.instruction(&I::I32Eqz);
    f.instruction(&I::If(wasm_encoder::BlockType::Empty));
    zero_return(&mut f);
    f.instruction(&I::End);
    f.instruction(&I::LocalGet(5));
    f.instruction(&I::GlobalGet(g + 1));
    f.instruction(&I::I32Ne);
    load(&mut f, 0);
    f.instruction(&I::GlobalGet(g + 2));
    f.instruction(&I::I32Ne);
    f.instruction(&I::I32Or);
    f.instruction(&I::If(wasm_encoder::BlockType::Empty));
    bind(&mut f, g, binder);
    f.instruction(&I::End);
    f.instruction(&I::Else);
    bind(&mut f, g, binder);
    f.instruction(&I::End);
    f.instruction(&I::LocalGet(0));
    f.instruction(&I::I64ExtendI32U);
    f.instruction(&I::LocalGet(1));
    f.instruction(&I::I64Add);
    f.instruction(&I::LocalTee(6));
    f.instruction(&I::LocalGet(2));
    f.instruction(&I::I64ExtendI32U);
    f.instruction(&I::I64Add);
    f.instruction(&I::LocalSet(7));
    f.instruction(&I::LocalGet(7));
    f.instruction(&I::GlobalGet(g + 4));
    f.instruction(&I::I64LeU);
    f.instruction(&I::If(wasm_encoder::BlockType::Empty));
    f.instruction(&I::GlobalGet(g + 3));
    f.instruction(&I::LocalGet(6));
    f.instruction(&I::I32WrapI64);
    f.instruction(&I::I32Add);
    f.instruction(&I::Return);
    f.instruction(&I::End);
    f.instruction(&I::LocalGet(6));
    f.instruction(&I::GlobalGet(g + 5));
    f.instruction(&I::I64GeU);
    f.instruction(&I::LocalGet(7));
    f.instruction(&I::GlobalGet(g + 6));
    f.instruction(&I::I64LeU);
    f.instruction(&I::I32And);
    f.instruction(&I::GlobalGet(g + 8));
    f.instruction(&I::LocalGet(3));
    f.instruction(&I::I32And);
    f.instruction(&I::LocalGet(3));
    f.instruction(&I::I32Eq);
    f.instruction(&I::I32And);
    f.instruction(&I::If(wasm_encoder::BlockType::Empty));
    f.instruction(&I::LocalGet(6));
    f.instruction(&I::GlobalGet(g + 5));
    f.instruction(&I::I64Sub);
    f.instruction(&I::I32WrapI64);
    f.instruction(&I::GlobalGet(g + 7));
    f.instruction(&I::I32Add);
    f.instruction(&I::Return);
    f.instruction(&I::End);
    f.instruction(&I::I32Const(0));
    f.instruction(&I::End);
    f
}

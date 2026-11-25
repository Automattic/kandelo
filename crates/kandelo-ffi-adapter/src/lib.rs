//! Target code generation, not a Node signature parser or dynamic loader.
//! All emitted side modules require the original instrumentation/admission path.
use wasm_encoder::*;

mod capi;
pub use capi::kandelo_ffi_emit_adapter;

/// The actual pinned libffi scalar type codes. Node's original parser owns
/// aliases and conversion; this backend only lowers its native scalar types.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scalar {
    Void,
    U8,
    S8,
    U16,
    S16,
    U32,
    S32,
    U64,
    S64,
    F32,
    F64,
    Pointer,
}
impl Scalar {
    pub fn from_ffi(code: u32) -> Option<Self> {
        Some(match code {
            0 => Self::Void,
            1 | 10 => Self::S32,
            2 => Self::F32,
            3 => Self::F64,
            5 => Self::U8,
            6 => Self::S8,
            7 => Self::U16,
            8 => Self::S16,
            9 => Self::U32,
            11 => Self::U64,
            12 => Self::S64,
            14 => Self::Pointer,
            _ => return None,
        })
    }
    pub fn wasm(self) -> Option<ValType> {
        Some(match self {
            Self::Void => return None,
            Self::F32 => ValType::F32,
            Self::F64 => ValType::F64,
            Self::U64 | Self::S64 => ValType::I64,
            _ => ValType::I32,
        })
    }
    fn load(self, f: &mut Function) {
        let mem = MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        };
        f.instruction(&match self {
            Self::U8 => Instruction::I32Load8U(mem),
            Self::S8 => Instruction::I32Load8S(mem),
            Self::U16 => Instruction::I32Load16U(mem),
            Self::S16 => Instruction::I32Load16S(mem),
            Self::U32 | Self::S32 | Self::Pointer => Instruction::I32Load(mem),
            Self::U64 | Self::S64 => Instruction::I64Load(mem),
            Self::F32 => Instruction::F32Load(mem),
            Self::F64 => Instruction::F64Load(mem),
            Self::Void => unreachable!("void has no argument storage"),
        });
    }
    fn store(self, f: &mut Function, widen: bool) {
        let mem = MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        };
        f.instruction(&match self {
            Self::U8 | Self::S8 if !widen => Instruction::I32Store8(mem),
            Self::U16 | Self::S16 if !widen => Instruction::I32Store16(mem),
            Self::U64 | Self::S64 => Instruction::I64Store(mem),
            Self::F32 => Instruction::F32Store(mem),
            Self::F64 => Instruction::F64Store(mem),
            Self::Void => unreachable!("void has no result storage"),
            _ => Instruction::I32Store(mem),
        });
    }
    fn extend(self, f: &mut Function) {
        match self {
            Self::S8 => {
                f.instruction(&Instruction::I32Extend8S);
            }
            Self::S16 => {
                f.instruction(&Instruction::I32Extend16S);
            }
            Self::U8 | Self::U16 => {
                f.instruction(&Instruction::I32Const(if self == Self::U8 {
                    255
                } else {
                    65535
                }));
                f.instruction(&Instruction::I32And);
            }
            _ => {}
        }
    }
}

#[derive(Debug)]
pub struct EmitError(pub &'static str);

/// Complete scalar shape, owned by the caller/cache rather than a borrowed cif.
pub struct Signature {
    pub result: Scalar,
    pub arguments: Vec<Scalar>,
}
impl Signature {
    fn validate(&self) -> Result<u32, EmitError> {
        if self.arguments.contains(&Scalar::Void) {
            return Err(EmitError("void argument"));
        }
        u32::try_from(self.arguments.len()).map_err(|_| EmitError("argument count overflow"))
    }
}

fn global(mutable: bool) -> EntityType {
    EntityType::Global(GlobalType {
        val_type: ValType::I32,
        mutable,
        shared: false,
    })
}
fn imports(callback: bool) -> ImportSection {
    let mut imports = ImportSection::new();
    imports.import(
        "env",
        "memory",
        EntityType::Memory(MemoryType {
            minimum: 0,
            maximum: Some(65536),
            memory64: false,
            shared: true,
            page_size_log2: None,
        }),
    );
    imports.import(
        "env",
        "__indirect_function_table",
        EntityType::Table(TableType {
            element_type: RefType::FUNCREF,
            minimum: 0,
            maximum: None,
            table64: false,
            shared: false,
        }),
    );
    imports.import("env", "__stack_pointer", global(true));
    imports.import("env", "__table_base", global(false));
    if callback {
        imports.import(
            "env",
            "kandelo_ffi_dispatch_closure",
            EntityType::Function(1),
        );
    }
    imports
}
fn start() -> Module {
    let mut m = Module::new();
    // Standard dylink memory-info subsection, zero data bytes and one table
    // slot. Instrumentation supplies its own real ABI/activation descriptors.
    m.section(&CustomSection {
        name: "dylink.0".into(),
        data: (&[1, 4, 0, 0, 1, 0][..]).into(),
    });
    m
}
fn address(f: &mut Function, base: u32, offset: u32) {
    f.instruction(&Instruction::LocalGet(base));
    if offset != 0 {
        f.instruction(&Instruction::I32Const(offset as i32));
        f.instruction(&Instruction::I32Add);
    }
}
fn enter(f: &mut Function, old: u32, new: u32, frame: u32) {
    f.instruction(&Instruction::GlobalGet(0));
    f.instruction(&Instruction::LocalTee(old));
    f.instruction(&Instruction::I32Const(frame as i32));
    f.instruction(&Instruction::I32Sub);
    f.instruction(&Instruction::LocalTee(new));
    f.instruction(&Instruction::GlobalSet(0));
}
fn leave(f: &mut Function, old: u32) {
    f.instruction(&Instruction::LocalGet(old));
    f.instruction(&Instruction::GlobalSet(0));
}
fn aligned(value: u32, alignment: u32) -> Result<u32, EmitError> {
    value
        .checked_add(alignment - 1)
        .map(|n| n & !(alignment - 1))
        .ok_or(EmitError("frame size overflow"))
}
fn finish(
    mut m: Module,
    type_index: u32,
    index: u32,
    name: &str,
    f: Function,
    limit: usize,
) -> Result<Vec<u8>, EmitError> {
    let mut functions = FunctionSection::new();
    functions.function(type_index);
    m.section(&functions);
    let mut exports = ExportSection::new();
    exports.export(name, ExportKind::Func, index);
    m.section(&exports);
    let mut elements = ElementSection::new();
    elements.active(
        None,
        &ConstExpr::global_get(1),
        Elements::Functions((&[index][..]).into()),
    );
    m.section(&elements);
    let mut code = CodeSection::new();
    code.function(&f);
    m.section(&code);
    let bytes = m.finish();
    if bytes.len() > limit {
        return Err(EmitError("adapter output budget exceeded"));
    }
    Ok(bytes)
}

/// Fixed bridge `void(target, result, argument_pointer_array)`. No permanent
/// target pointer/cif is embedded, so one module can serve a complete shape.
pub fn call(signature: &Signature, limit: usize) -> Result<Vec<u8>, EmitError> {
    signature.validate()?;
    let mut m = start();
    let mut types = TypeSection::new();
    types.ty().function(
        signature
            .arguments
            .iter()
            .map(|t| t.wasm().expect("validated non-void argument")),
        signature.result.wasm(),
    );
    types.ty().function([ValType::I32; 3], []);
    m.section(&types);
    m.section(&imports(false));
    let mut locals = vec![(3, ValType::I32)]; // oldsp, newsp, result pointer
    if let Some(result) = signature.result.wasm() {
        locals.push((1, result));
    }
    let mut f = Function::new(locals);
    enter(&mut f, 3, 4, 16);
    f.instruction(&Instruction::LocalGet(1));
    f.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    f.instruction(&Instruction::LocalGet(1));
    f.instruction(&Instruction::Else);
    f.instruction(&Instruction::LocalGet(4));
    f.instruction(&Instruction::End);
    f.instruction(&Instruction::LocalSet(5));
    for (i, arg) in signature.arguments.iter().enumerate() {
        let offset = u32::try_from(i)
            .ok()
            .and_then(|n| n.checked_mul(4))
            .ok_or(EmitError("argument pointer overflow"))?;
        address(&mut f, 2, offset);
        f.instruction(&Instruction::I32Load(MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        }));
        arg.load(&mut f);
    }
    f.instruction(&Instruction::LocalGet(0));
    f.instruction(&Instruction::CallIndirect {
        type_index: 0,
        table_index: 0,
    });
    if signature.result != Scalar::Void {
        signature.result.extend(&mut f);
        f.instruction(&Instruction::LocalSet(6));
        f.instruction(&Instruction::LocalGet(5));
        f.instruction(&Instruction::LocalGet(6));
        signature.result.store(&mut f, true);
    }
    leave(&mut f, 3);
    f.instruction(&Instruction::End);
    finish(m, 1, 0, "kandelo_ffi_call", f, limit)
}

/// One typed callback per native closure identity. Dispatch remains a direct
/// guest C call on the entering thread, using Node's original callback policy.
pub fn callback(signature: &Signature, closure: u32, limit: usize) -> Result<Vec<u8>, EmitError> {
    let count = signature.validate()?;
    if closure == 0 {
        return Err(EmitError("null callback context"));
    }
    let values = aligned(
        count
            .checked_mul(4)
            .and_then(|n| n.checked_add(8))
            .ok_or(EmitError("callback frame overflow"))?,
        8,
    )?;
    let frame = aligned(
        count
            .checked_mul(8)
            .and_then(|n| n.checked_add(values))
            .ok_or(EmitError("callback frame overflow"))?,
        16,
    )?;
    // Keep offsets representable as positive pointer displacements.
    if frame > i32::MAX as u32 {
        return Err(EmitError("callback frame exceeds address budget"));
    }
    let mut m = start();
    let mut types = TypeSection::new();
    types.ty().function(
        signature
            .arguments
            .iter()
            .map(|t| t.wasm().expect("validated non-void argument")),
        signature.result.wasm(),
    );
    types.ty().function([ValType::I32; 3], []);
    m.section(&types);
    m.section(&imports(true));
    let mut f = Function::new([(2, ValType::I32)]);
    let old = count;
    let new = count + 1;
    enter(&mut f, old, new, frame);
    address(&mut f, new, 0);
    f.instruction(&Instruction::I64Const(0));
    f.instruction(&Instruction::I64Store(MemArg {
        offset: 0,
        align: 0,
        memory_index: 0,
    }));
    for (i, arg) in signature.arguments.iter().enumerate() {
        let i = i as u32;
        address(&mut f, new, 8 + 4 * i);
        address(&mut f, new, values + 8 * i);
        f.instruction(&Instruction::I32Store(MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        }));
        address(&mut f, new, values + 8 * i);
        f.instruction(&Instruction::LocalGet(i));
        arg.store(&mut f, false);
    }
    f.instruction(&Instruction::I32Const(closure as i32));
    address(&mut f, new, 0);
    address(&mut f, new, 8);
    f.instruction(&Instruction::Call(0));
    // Leave the scalar on the operand stack while restoring the shadow stack;
    // no borrowed temporary pointer escapes into the foreign caller.
    if signature.result != Scalar::Void {
        address(&mut f, new, 0);
        signature.result.load(&mut f);
    }
    leave(&mut f, old);
    f.instruction(&Instruction::End);
    finish(m, 0, 1, "kandelo_ffi_callback", f, limit)
}

/// Reserve a real loader-owned table coordinate before the callback signature
/// is known. Later installation uses ordinary instrumented Wasm table writes.
pub fn reservation(limit: usize) -> Result<Vec<u8>, EmitError> {
    let mut m = start();
    let mut types = TypeSection::new();
    types.ty().function([], [ValType::I32]);
    types.ty().function([ValType::I32], []);
    m.section(&types);
    m.section(&imports(false));
    let mut functions = FunctionSection::new();
    functions.function(0).function(1);
    m.section(&functions);
    let mut exports = ExportSection::new();
    exports.export("kandelo_ffi_slot", ExportKind::Func, 0);
    exports.export("kandelo_ffi_install", ExportKind::Func, 1);
    m.section(&exports);
    let mut address = Function::new([]);
    address.instruction(&Instruction::GlobalGet(1));
    address.instruction(&Instruction::End);
    let mut install = Function::new([]);
    install.instruction(&Instruction::GlobalGet(1));
    install.instruction(&Instruction::LocalGet(0));
    install.instruction(&Instruction::TableGet(0));
    install.instruction(&Instruction::TableSet(0));
    install.instruction(&Instruction::End);
    let mut code = CodeSection::new();
    code.function(&address).function(&install);
    m.section(&code);
    let bytes = m.finish();
    if bytes.len() > limit {
        return Err(EmitError("adapter output budget exceeded"));
    }
    Ok(bytes)
}

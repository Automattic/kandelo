//! The `PlanStep` / `ActResult` wire format.
//!
//! # Why a wire format exists at all
//!
//! [`crate::plan::LinkPlan`] is a Rust state machine that emits
//! [`crate::plan::PlanStep`] and consumes [`crate::act::ActResult`]. On a
//! native host (`crates/host-native`) that is the whole story: the executor
//! links this crate as an ordinary Rust library and matches on the enum.
//!
//! On the two JavaScript hosts it is not. The planner has to be *wasm* to run
//! at all, and the executor has to be *JavaScript* because six of the eight
//! acts construct JS-API objects (`new WebAssembly.Module`, `new
//! WebAssembly.Global`, `new WebAssembly.Tag`, `new WebAssembly.Instance`, and
//! the `Global.value` accessors) which wasm fundamentally cannot perform. So
//! exactly one boundary in the design is crossed by bytes rather than by a
//! `match`, and this module is that boundary.
//!
//! # Why the boundary is bytes and not a host import per act
//!
//! The alternative — giving the planner module one imported function per act —
//! would put eight new host-supplied functions into a wasm module's import
//! list, which is host surface growth (value plan V4). A single byte buffer the
//! JS side reads costs **zero** imports: the planner module imports nothing at
//! all. That is why `dl_step` writes into module-owned memory and the driver
//! reads it back, rather than the planner calling out.
//!
//! # Format
//!
//! Little-endian, self-describing, and deliberately dull. Every composite is
//! `u8` tag followed by fields; `u32` for lengths and ids; `u64` for addresses
//! and table indices; strings are `u32` byte length followed by UTF-8.
//!
//! Two properties matter and are tested:
//!
//! 1. **Round-trip fidelity.** `decode_act_result(encode_act_result(x)) == x`
//!    for every variant, so the JS driver and the native executor cannot drift
//!    apart in what they believe a result means.
//! 2. **Truncation is an error, never a silent zero.** Every read is
//!    bounds-checked against the remaining slice and returns
//!    [`DylinkError::MalformedModule`] rather than reading past the end. This
//!    is the same discipline [`crate::wasm`] applies to module bytes, and for
//!    the same reason: the TypeScript readers this crate replaces index past
//!    the end of a `Uint8Array` and produce `undefined`.
//!
//! The ordered-binding invariant survives the encoding intact:
//! [`crate::act::LinkAct::Instantiate`]'s bindings are written in vector order
//! with [`crate::act::ImportBinding::position`] restated per entry, so a driver
//! that reorders them is caught by the same check a native executor would hit.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

use crate::act::{
    ActResult, BindingValue, GlobalId, ImportBinding, InstanceExport, InstanceId, LinkAct, ModuleId,
    ModuleSource, PointerWidth, TableValue, TagId, WasmValue,
};
use crate::error::{DylinkError, DylinkResult};
use crate::got::UnresolvedPolicy;
use crate::handles::CloseOutcome;
use crate::plan::{
    HostRequest, InitializationStage, LinkerConfig, LoadRequest, PlanStep, ReplayInputs, StagedCall,
};
use crate::scope::{DataBinding, ResolvedSymbol, SymbolValue};
use crate::wasm::{ExternKind, ValType};

fn malformed(reason: &'static str) -> DylinkError {
    DylinkError::MalformedModule(reason)
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/// A little-endian byte sink. Infallible: growth is the allocator's problem,
/// and every length written is derived from a value already in memory.
#[derive(Default)]
pub struct Writer {
    bytes: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Writer { bytes: Vec::new() }
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn bool(&mut self, value: bool) {
        self.u8(u8::from(value));
    }

    /// Lengths are `u32` on the wire. A `usize` that does not fit is a bug in
    /// the planner, not malformed input, so it is reported rather than
    /// truncated.
    fn len_prefix(&mut self, len: usize) -> DylinkResult<()> {
        let len = u32::try_from(len).map_err(|_| malformed("wire length exceeds u32"))?;
        self.u32(len);
        Ok(())
    }

    fn str(&mut self, value: &str) -> DylinkResult<()> {
        self.len_prefix(value.len())?;
        self.bytes.extend_from_slice(value.as_bytes());
        Ok(())
    }

    fn blob(&mut self, value: &[u8]) -> DylinkResult<()> {
        self.len_prefix(value.len())?;
        self.bytes.extend_from_slice(value);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/// A bounds-checked little-endian byte source.
pub struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, offset: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.bytes.len() - self.offset
    }

    /// Every decoder ends with this. A trailing byte means the two sides
    /// disagree about the format, which is exactly the drift this format
    /// exists to make loud.
    pub fn finish(self) -> DylinkResult<()> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(malformed("trailing bytes after wire record"))
        }
    }

    fn take(&mut self, count: usize) -> DylinkResult<&'a [u8]> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or_else(|| malformed("wire read overflows"))?;
        if end > self.bytes.len() {
            return Err(malformed("wire read past end of record"));
        }
        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(slice)
    }

    fn u8(&mut self) -> DylinkResult<u8> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> DylinkResult<u32> {
        let slice = self.take(4)?;
        Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
    }

    fn u64(&mut self) -> DylinkResult<u64> {
        let slice = self.take(8)?;
        Ok(u64::from_le_bytes([
            slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
        ]))
    }

    fn bool(&mut self) -> DylinkResult<bool> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(malformed("wire bool is not 0 or 1")),
        }
    }

    fn str(&mut self) -> DylinkResult<String> {
        let len = self.u32()? as usize;
        let slice = self.take(len)?;
        core::str::from_utf8(slice)
            .map(String::from)
            .map_err(|_| malformed("wire string is not UTF-8"))
    }

    fn blob(&mut self) -> DylinkResult<Vec<u8>> {
        let len = self.u32()? as usize;
        Ok(self.take(len)?.to_vec())
    }

    /// Read a vector length and reject one that cannot possibly be backed by
    /// the remaining bytes, so a corrupt length cannot ask for a huge
    /// allocation before the read fails.
    fn vec_len(&mut self, min_entry_bytes: usize) -> DylinkResult<usize> {
        let len = self.u32()? as usize;
        if min_entry_bytes > 0 {
            let needed = len
                .checked_mul(min_entry_bytes)
                .ok_or_else(|| malformed("wire vector length overflows"))?;
            if needed > self.remaining() {
                return Err(malformed("wire vector length exceeds record"));
            }
        }
        Ok(len)
    }
}

// ---------------------------------------------------------------------------
// Leaf codecs
// ---------------------------------------------------------------------------

const VALTYPE_I32: u8 = 0;
const VALTYPE_I64: u8 = 1;
const VALTYPE_F32: u8 = 2;
const VALTYPE_F64: u8 = 3;
const VALTYPE_OPAQUE: u8 = 4;

fn put_val_type(w: &mut Writer, ty: ValType) {
    match ty {
        ValType::I32 => w.u8(VALTYPE_I32),
        ValType::I64 => w.u8(VALTYPE_I64),
        ValType::F32 => w.u8(VALTYPE_F32),
        ValType::F64 => w.u8(VALTYPE_F64),
        ValType::Opaque(byte) => {
            w.u8(VALTYPE_OPAQUE);
            w.u8(byte);
        }
    }
}

fn get_val_type(r: &mut Reader<'_>) -> DylinkResult<ValType> {
    Ok(match r.u8()? {
        VALTYPE_I32 => ValType::I32,
        VALTYPE_I64 => ValType::I64,
        VALTYPE_F32 => ValType::F32,
        VALTYPE_F64 => ValType::F64,
        VALTYPE_OPAQUE => ValType::Opaque(r.u8()?),
        _ => return Err(malformed("unknown wire value type")),
    })
}

fn put_extern_kind(w: &mut Writer, kind: ExternKind) {
    w.u8(match kind {
        ExternKind::Func => 0,
        ExternKind::Table => 1,
        ExternKind::Memory => 2,
        ExternKind::Global => 3,
        ExternKind::Tag => 4,
    });
}

fn get_extern_kind(r: &mut Reader<'_>) -> DylinkResult<ExternKind> {
    Ok(match r.u8()? {
        0 => ExternKind::Func,
        1 => ExternKind::Table,
        2 => ExternKind::Memory,
        3 => ExternKind::Global,
        4 => ExternKind::Tag,
        _ => return Err(malformed("unknown wire extern kind")),
    })
}

/// A `WasmValue` keeps its width on the wire. Narrowing to a JS `number` is
/// the driver's decision, not the format's: a `W64` process carries addresses
/// a double cannot hold exactly, so the driver reads `I64` as a `BigInt`.
fn put_wasm_value(w: &mut Writer, value: WasmValue) {
    match value {
        WasmValue::I32(v) => {
            w.u8(0);
            w.u32(v);
        }
        WasmValue::I64(v) => {
            w.u8(1);
            w.u64(v);
        }
    }
}

fn get_wasm_value(r: &mut Reader<'_>) -> DylinkResult<WasmValue> {
    Ok(match r.u8()? {
        0 => WasmValue::I32(r.u32()?),
        1 => WasmValue::I64(r.u64()?),
        _ => return Err(malformed("unknown wire wasm value")),
    })
}

fn put_binding_value(w: &mut Writer, value: &BindingValue) -> DylinkResult<()> {
    match value {
        BindingValue::ProcessMemory => w.u8(0),
        BindingValue::ProcessTable => w.u8(1),
        BindingValue::ProcessStackPointer => w.u8(2),
        BindingValue::Global(id) => {
            w.u8(3);
            w.u32(id.index());
        }
        BindingValue::Tag(id) => {
            w.u8(4);
            w.u32(id.index());
        }
        BindingValue::Export { instance, name } => {
            w.u8(5);
            w.u32(instance.index());
            w.str(name)?;
        }
        BindingValue::SelfImport { name } => {
            w.u8(6);
            w.str(name)?;
        }
        BindingValue::ActivationEnv { name } => {
            w.u8(7);
            w.str(name)?;
        }
        BindingValue::WeakUndefined => w.u8(8),
    }
    Ok(())
}

fn get_binding_value(r: &mut Reader<'_>) -> DylinkResult<BindingValue> {
    Ok(match r.u8()? {
        0 => BindingValue::ProcessMemory,
        1 => BindingValue::ProcessTable,
        2 => BindingValue::ProcessStackPointer,
        3 => BindingValue::Global(GlobalId(r.u32()?)),
        4 => BindingValue::Tag(TagId(r.u32()?)),
        5 => BindingValue::Export {
            instance: InstanceId(r.u32()?),
            name: r.str()?,
        },
        6 => BindingValue::SelfImport { name: r.str()? },
        7 => BindingValue::ActivationEnv { name: r.str()? },
        8 => BindingValue::WeakUndefined,
        _ => return Err(malformed("unknown wire binding value")),
    })
}

/// The smallest an `ImportBinding` can be on the wire: position, two empty
/// strings, a kind byte, a value tag and the duplicate flag.
const MIN_IMPORT_BINDING_BYTES: usize = 4 + 4 + 4 + 1 + 1 + 1;

fn put_import_binding(w: &mut Writer, binding: &ImportBinding) -> DylinkResult<()> {
    w.u32(binding.position);
    w.str(&binding.module)?;
    w.str(&binding.name)?;
    put_extern_kind(w, binding.kind);
    put_binding_value(w, &binding.value)?;
    w.bool(binding.duplicate_occurrence);
    Ok(())
}

fn get_import_binding(r: &mut Reader<'_>) -> DylinkResult<ImportBinding> {
    Ok(ImportBinding {
        position: r.u32()?,
        module: r.str()?,
        name: r.str()?,
        kind: get_extern_kind(r)?,
        value: get_binding_value(r)?,
        duplicate_occurrence: r.bool()?,
    })
}

const MIN_INSTANCE_EXPORT_BYTES: usize = 4 + 1 + 1 + 1;

fn put_instance_export(w: &mut Writer, export: &InstanceExport) -> DylinkResult<()> {
    w.str(&export.name)?;
    put_extern_kind(w, export.kind);
    match export.value {
        Some(value) => {
            w.bool(true);
            put_wasm_value(w, value);
        }
        None => w.bool(false),
    }
    match export.mutable {
        Some(mutable) => {
            w.bool(true);
            w.bool(mutable);
        }
        None => w.bool(false),
    }
    Ok(())
}

fn get_instance_export(r: &mut Reader<'_>) -> DylinkResult<InstanceExport> {
    let name = r.str()?;
    let kind = get_extern_kind(r)?;
    let value = if r.bool()? {
        Some(get_wasm_value(r)?)
    } else {
        None
    };
    let mutable = if r.bool()? { Some(r.bool()?) } else { None };
    Ok(InstanceExport {
        name,
        kind,
        value,
        mutable,
    })
}

fn put_table_value(w: &mut Writer, value: &TableValue) -> DylinkResult<()> {
    match value {
        TableValue::Null => w.u8(0),
        TableValue::Export { instance, name } => {
            w.u8(1);
            w.u32(instance.index());
            w.str(name)?;
        }
    }
    Ok(())
}

fn get_table_value(r: &mut Reader<'_>) -> DylinkResult<TableValue> {
    Ok(match r.u8()? {
        0 => TableValue::Null,
        1 => TableValue::Export {
            instance: InstanceId(r.u32()?),
            name: r.str()?,
        },
        _ => return Err(malformed("unknown wire table value")),
    })
}

fn put_stage(w: &mut Writer, stage: InitializationStage) {
    w.u8(match stage {
        InitializationStage::Bootstrap => 0,
        InitializationStage::Relocations => 1,
        InitializationStage::Constructors => 2,
    });
}

fn get_stage(r: &mut Reader<'_>) -> DylinkResult<InitializationStage> {
    Ok(match r.u8()? {
        0 => InitializationStage::Bootstrap,
        1 => InitializationStage::Relocations,
        2 => InitializationStage::Constructors,
        _ => return Err(malformed("unknown wire initialization stage")),
    })
}

// ---------------------------------------------------------------------------
// LinkAct
// ---------------------------------------------------------------------------

/// `Compile`'s bytes are the one place the format is asymmetric on purpose.
///
/// `ModuleSource::Original` carries no bytes: the driver already holds the
/// caller's image (it is the buffer it copied out of guest memory before
/// calling in), so shipping a second copy across the boundary would double the
/// cost of every `dlopen` for nothing. Only `Rewritten` — the borrowed-replay
/// start-section strip, which the planner produced — is transferred.
fn put_module_source(w: &mut Writer, source: &ModuleSource) -> DylinkResult<()> {
    match source {
        ModuleSource::Original => w.u8(0),
        ModuleSource::Rewritten(bytes) => {
            w.u8(1);
            w.blob(bytes)?;
        }
    }
    Ok(())
}

fn get_module_source(r: &mut Reader<'_>) -> DylinkResult<ModuleSource> {
    Ok(match r.u8()? {
        0 => ModuleSource::Original,
        1 => ModuleSource::Rewritten(r.blob()?),
        _ => return Err(malformed("unknown wire module source")),
    })
}

fn put_link_act(w: &mut Writer, act: &LinkAct) -> DylinkResult<()> {
    match act {
        LinkAct::Compile { module, library, source } => {
            w.u8(0);
            w.u32(module.index());
            w.str(library)?;
            put_module_source(w, source)?;
        }
        LinkAct::NewGlobal {
            global,
            ty,
            mutable,
            init,
        } => {
            w.u8(1);
            w.u32(global.index());
            put_val_type(w, *ty);
            w.bool(*mutable);
            put_wasm_value(w, *init);
        }
        LinkAct::ReadGlobal { global } => {
            w.u8(2);
            w.u32(global.index());
        }
        LinkAct::WriteGlobal { global, value } => {
            w.u8(3);
            w.u32(global.index());
            put_wasm_value(w, *value);
        }
        LinkAct::GrowTable { delta } => {
            w.u8(4);
            w.u64(*delta);
        }
        LinkAct::WriteTable { index, value } => {
            w.u8(5);
            w.u64(*index);
            put_table_value(w, value)?;
        }
        LinkAct::GrowMemory { delta_pages } => {
            w.u8(6);
            w.u64(*delta_pages);
        }
        LinkAct::NewTag { tag, parameters } => {
            w.u8(7);
            w.u32(tag.index());
            w.len_prefix(parameters.len())?;
            for ty in parameters {
                put_val_type(w, *ty);
            }
        }
        LinkAct::Instantiate {
            module,
            instance,
            bindings,
        } => {
            w.u8(8);
            w.u32(module.index());
            w.u32(instance.index());
            w.len_prefix(bindings.len())?;
            for binding in bindings {
                put_import_binding(w, binding)?;
            }
        }
        LinkAct::ReadExports { instance } => {
            w.u8(9);
            w.u32(instance.index());
        }
        LinkAct::ZeroMemory { address, length } => {
            w.u8(10);
            w.u64(*address);
            w.u64(*length);
        }
    }
    Ok(())
}

fn get_link_act(r: &mut Reader<'_>) -> DylinkResult<LinkAct> {
    Ok(match r.u8()? {
        0 => LinkAct::Compile {
            module: ModuleId(r.u32()?),
            library: r.str()?,
            source: get_module_source(r)?,
        },
        1 => LinkAct::NewGlobal {
            global: GlobalId(r.u32()?),
            ty: get_val_type(r)?,
            mutable: r.bool()?,
            init: get_wasm_value(r)?,
        },
        2 => LinkAct::ReadGlobal {
            global: GlobalId(r.u32()?),
        },
        3 => LinkAct::WriteGlobal {
            global: GlobalId(r.u32()?),
            value: get_wasm_value(r)?,
        },
        4 => LinkAct::GrowTable { delta: r.u64()? },
        5 => LinkAct::WriteTable {
            index: r.u64()?,
            value: get_table_value(r)?,
        },
        6 => LinkAct::GrowMemory {
            delta_pages: r.u64()?,
        },
        7 => {
            let tag = TagId(r.u32()?);
            let count = r.vec_len(1)?;
            let mut parameters = Vec::with_capacity(count);
            for _ in 0..count {
                parameters.push(get_val_type(r)?);
            }
            LinkAct::NewTag { tag, parameters }
        }
        8 => {
            let module = ModuleId(r.u32()?);
            let instance = InstanceId(r.u32()?);
            let count = r.vec_len(MIN_IMPORT_BINDING_BYTES)?;
            let mut bindings = Vec::with_capacity(count);
            for _ in 0..count {
                bindings.push(get_import_binding(r)?);
            }
            LinkAct::Instantiate {
                module,
                instance,
                bindings,
            }
        }
        9 => LinkAct::ReadExports {
            instance: InstanceId(r.u32()?),
        },
        10 => LinkAct::ZeroMemory {
            address: r.u64()?,
            length: r.u64()?,
        },
        _ => return Err(malformed("unknown wire link act")),
    })
}

// ---------------------------------------------------------------------------
// HostRequest
// ---------------------------------------------------------------------------

/// `DylinkAllocation` is `fork-codec`'s record, reused rather than redeclared
/// (the same decision `ReplayInputs::from_archive` made). Its four fields are
/// written flat.
fn put_allocation(w: &mut Writer, allocation: &fork_codec::dylink_archive::DylinkAllocation) {
    w.u64(allocation.address);
    w.u64(allocation.size);
    w.u64(allocation.mapping_address);
    w.u64(allocation.mapping_size);
}

fn get_allocation(
    r: &mut Reader<'_>,
) -> DylinkResult<fork_codec::dylink_archive::DylinkAllocation> {
    Ok(fork_codec::dylink_archive::DylinkAllocation {
        address: r.u64()?,
        size: r.u64()?,
        mapping_address: r.u64()?,
        mapping_size: r.u64()?,
    })
}

fn put_host_request(w: &mut Writer, request: &HostRequest) -> DylinkResult<()> {
    match request {
        HostRequest::AllocateMemory {
            library,
            size,
            align,
        } => {
            w.u8(0);
            w.str(library)?;
            w.u64(*size);
            w.u64(*align);
        }
        HostRequest::AdoptMapping {
            library,
            allocation,
        } => {
            w.u8(1);
            w.str(library)?;
            put_allocation(w, allocation);
        }
        HostRequest::ReleaseMapping {
            library,
            allocation,
        } => {
            w.u8(2);
            w.str(library)?;
            put_allocation(w, allocation);
        }
        HostRequest::PrepareActivation {
            library,
            replay_activation_id,
        } => {
            w.u8(3);
            w.str(library)?;
            match replay_activation_id {
                Some(id) => {
                    w.bool(true);
                    w.u32(*id);
                }
                None => w.bool(false),
            }
        }
        HostRequest::RegisterActivation {
            library,
            activation,
            instance,
        } => {
            w.u8(4);
            w.str(library)?;
            w.u32(*activation);
            w.u32(instance.index());
        }
        HostRequest::UnregisterActivation {
            library,
            activation,
        } => {
            w.u8(5);
            w.str(library)?;
            w.u32(*activation);
        }
        HostRequest::JournalTableMutation { first_index, length } => {
            w.u8(6);
            w.u64(*first_index);
            w.u64(*length);
        }
        HostRequest::ReadDependency { library, path } => {
            w.u8(7);
            w.str(library)?;
            w.str(path)?;
        }
        HostRequest::ReadArchive { address, length } => {
            w.u8(8);
            w.u64(*address);
            w.u64(*length);
        }
        HostRequest::AllocateArchive { size } => {
            w.u8(9);
            w.u64(*size);
        }
        HostRequest::WriteArchive { address, bytes } => {
            w.u8(10);
            w.u64(*address);
            w.blob(bytes)?;
        }
        HostRequest::PublishGeneration { address, generation } => {
            w.u8(11);
            w.u64(*address);
            w.u64(*generation);
        }
        HostRequest::ReleaseArchive { address, size } => {
            w.u8(12);
            w.u64(*address);
            w.u64(*size);
        }
        HostRequest::SavedGotFunc { library, symbol } => {
            w.u8(13);
            w.str(library)?;
            w.str(symbol)?;
        }
    }
    Ok(())
}

fn get_host_request(r: &mut Reader<'_>) -> DylinkResult<HostRequest> {
    Ok(match r.u8()? {
        0 => HostRequest::AllocateMemory {
            library: r.str()?,
            size: r.u64()?,
            align: r.u64()?,
        },
        1 => HostRequest::AdoptMapping {
            library: r.str()?,
            allocation: get_allocation(r)?,
        },
        2 => HostRequest::ReleaseMapping {
            library: r.str()?,
            allocation: get_allocation(r)?,
        },
        3 => {
            let library = r.str()?;
            let replay_activation_id = if r.bool()? { Some(r.u32()?) } else { None };
            HostRequest::PrepareActivation {
                library,
                replay_activation_id,
            }
        }
        4 => HostRequest::RegisterActivation {
            library: r.str()?,
            activation: r.u32()?,
            instance: InstanceId(r.u32()?),
        },
        5 => HostRequest::UnregisterActivation {
            library: r.str()?,
            activation: r.u32()?,
        },
        6 => HostRequest::JournalTableMutation {
            first_index: r.u64()?,
            length: r.u64()?,
        },
        7 => HostRequest::ReadDependency {
            library: r.str()?,
            path: r.str()?,
        },
        8 => HostRequest::ReadArchive {
            address: r.u64()?,
            length: r.u64()?,
        },
        9 => HostRequest::AllocateArchive { size: r.u64()? },
        10 => HostRequest::WriteArchive {
            address: r.u64()?,
            bytes: r.blob()?,
        },
        11 => HostRequest::PublishGeneration {
            address: r.u64()?,
            generation: r.u64()?,
        },
        12 => HostRequest::ReleaseArchive {
            address: r.u64()?,
            size: r.u64()?,
        },
        13 => HostRequest::SavedGotFunc {
            library: r.str()?,
            symbol: r.str()?,
        },
        _ => return Err(malformed("unknown wire host request")),
    })
}

// ---------------------------------------------------------------------------
// PlanStep
// ---------------------------------------------------------------------------

/// `StagedCall::export` is a `&'static str` chosen by the stage, so it is not
/// transferred — the decoder recovers it from the stage, and a mismatch
/// between the two would be a planner bug the encoder catches here.
fn put_staged_call(w: &mut Writer, call: &StagedCall) -> DylinkResult<()> {
    if call.export != call.stage.export_name() {
        return Err(malformed("staged call export does not match its stage"));
    }
    w.str(&call.library)?;
    put_stage(w, call.stage);
    w.u32(call.instance.index());
    Ok(())
}

fn get_staged_call(r: &mut Reader<'_>) -> DylinkResult<StagedCall> {
    let library = r.str()?;
    let stage = get_stage(r)?;
    let instance = InstanceId(r.u32()?);
    Ok(StagedCall {
        library,
        stage,
        instance,
        export: stage.export_name(),
    })
}

/// Encode one [`PlanStep`] for the driver.
pub fn encode_plan_step(step: &PlanStep) -> DylinkResult<Vec<u8>> {
    let mut w = Writer::new();
    match step {
        PlanStep::Act(act) => {
            w.u8(0);
            put_link_act(&mut w, act)?;
        }
        PlanStep::Host(request) => {
            w.u8(1);
            put_host_request(&mut w, request)?;
        }
        PlanStep::Call(call) => {
            w.u8(2);
            put_staged_call(&mut w, call)?;
        }
        PlanStep::Finished => w.u8(3),
    }
    Ok(w.into_bytes())
}

/// Decode one [`PlanStep`]. Used by the native executor's round-trip tests and
/// by any driver written in Rust; the JavaScript driver has its own reader over
/// the same format.
pub fn decode_plan_step(bytes: &[u8]) -> DylinkResult<PlanStep> {
    let mut r = Reader::new(bytes);
    let step = match r.u8()? {
        0 => PlanStep::Act(get_link_act(&mut r)?),
        1 => PlanStep::Host(get_host_request(&mut r)?),
        2 => PlanStep::Call(get_staged_call(&mut r)?),
        3 => PlanStep::Finished,
        _ => return Err(malformed("unknown wire plan step")),
    };
    r.finish()?;
    Ok(step)
}

// ---------------------------------------------------------------------------
// ActResult
// ---------------------------------------------------------------------------

/// Encode one [`ActResult`]. The driver writes this shape; this encoder exists
/// so the round-trip is testable from Rust alone.
pub fn encode_act_result(result: &ActResult) -> DylinkResult<Vec<u8>> {
    let mut w = Writer::new();
    match result {
        ActResult::Done => w.u8(0),
        ActResult::Value(value) => {
            w.u8(1);
            put_wasm_value(&mut w, *value);
        }
        ActResult::Index(index) => {
            w.u8(2);
            w.u64(*index);
        }
        ActResult::Exports(exports) => {
            w.u8(3);
            w.len_prefix(exports.len())?;
            for export in exports {
                put_instance_export(&mut w, export)?;
            }
        }
        ActResult::Bytes(bytes) => {
            w.u8(4);
            match bytes {
                Some(bytes) => {
                    w.bool(true);
                    w.blob(bytes)?;
                }
                None => w.bool(false),
            }
        }
    }
    Ok(w.into_bytes())
}

/// Decode the driver's answer to a step.
pub fn decode_act_result(bytes: &[u8]) -> DylinkResult<ActResult> {
    let mut r = Reader::new(bytes);
    let result = match r.u8()? {
        0 => ActResult::Done,
        1 => ActResult::Value(get_wasm_value(&mut r)?),
        2 => ActResult::Index(r.u64()?),
        3 => {
            let count = r.vec_len(MIN_INSTANCE_EXPORT_BYTES)?;
            let mut exports = Vec::with_capacity(count);
            for _ in 0..count {
                exports.push(get_instance_export(&mut r)?);
            }
            ActResult::Exports(exports)
        }
        4 => ActResult::Bytes(if r.bool()? { Some(r.blob()?) } else { None }),
        _ => return Err(malformed("unknown wire act result")),
    };
    r.finish()?;
    Ok(result)
}

// ---------------------------------------------------------------------------
// Session records
// ---------------------------------------------------------------------------
//
// `PlanStep` and `ActResult` above are the per-act boundary. These are the
// records that OPEN and CLOSE a session: the process configuration, the main
// image the global scope is rooted on, one `dlopen` request, and the answers
// `dlsym` / `dlclose` return. A native executor never needs them -- it holds a
// `Linker` and calls the methods -- so they exist for exactly the same reason
// the two above do: on a JavaScript host the planner is wasm, and every value
// crossing into it has to be bytes.
//
// The alternative would have been a scalar argument list per entry point. That
// fails on the first `Option`-shaped field and on `ReplayInputs`, which carries
// four variable-length collections, so it would have become a byte format
// anyway -- just an undocumented one.

const MIN_STRING_BYTES: usize = 4;
const MIN_NAMED_SYMBOL_BYTES: usize = MIN_STRING_BYTES + 1;
const MIN_ELEMENT_SLOT_BYTES: usize = 8 + 4 + MIN_STRING_BYTES;
const MIN_ALLOCATION_BYTES: usize = 8 * 4;
const MIN_SAVED_GOT_ENTRY_BYTES: usize = MIN_STRING_BYTES + 1;

fn put_option_u32(w: &mut Writer, value: Option<u32>) {
    match value {
        Some(value) => {
            w.u8(1);
            w.u32(value);
        }
        None => w.u8(0),
    }
}

fn get_option_u32(r: &mut Reader<'_>) -> DylinkResult<Option<u32>> {
    match r.u8()? {
        0 => Ok(None),
        1 => Ok(Some(r.u32()?)),
        _ => Err(malformed("unknown wire optional u32 tag")),
    }
}

fn put_option_u64(w: &mut Writer, value: Option<u64>) {
    match value {
        Some(value) => {
            w.u8(1);
            w.u64(value);
        }
        None => w.u8(0),
    }
}

fn get_option_u64(r: &mut Reader<'_>) -> DylinkResult<Option<u64>> {
    match r.u8()? {
        0 => Ok(None),
        1 => Ok(Some(r.u64()?)),
        _ => Err(malformed("unknown wire optional u64 tag")),
    }
}

fn put_option_str(w: &mut Writer, value: Option<&str>) -> DylinkResult<()> {
    match value {
        Some(value) => {
            w.u8(1);
            w.str(value)?;
        }
        None => w.u8(0),
    }
    Ok(())
}

fn get_option_str(r: &mut Reader<'_>) -> DylinkResult<Option<String>> {
    match r.u8()? {
        0 => Ok(None),
        1 => Ok(Some(r.str()?)),
        _ => Err(malformed("unknown wire optional string tag")),
    }
}

fn put_pointer_width(w: &mut Writer, width: PointerWidth) {
    w.u8(match width {
        PointerWidth::W32 => 0,
        PointerWidth::W64 => 1,
    });
}

fn get_pointer_width(r: &mut Reader<'_>) -> DylinkResult<PointerWidth> {
    match r.u8()? {
        0 => Ok(PointerWidth::W32),
        1 => Ok(PointerWidth::W64),
        _ => Err(malformed("unknown wire pointer width")),
    }
}

fn put_unresolved_policy(w: &mut Writer, policy: UnresolvedPolicy) {
    w.u8(match policy {
        UnresolvedPolicy::ElfStrict => 0,
        UnresolvedPolicy::LegacyZero => 1,
    });
}

fn get_unresolved_policy(r: &mut Reader<'_>) -> DylinkResult<UnresolvedPolicy> {
    match r.u8()? {
        0 => Ok(UnresolvedPolicy::ElfStrict),
        1 => Ok(UnresolvedPolicy::LegacyZero),
        _ => Err(malformed("unknown wire unresolved policy")),
    }
}

// ---------------------------------------------------------------------------
// Table patches
// ---------------------------------------------------------------------------
//
// Funcref table patches are the activation coordinator's, not the linker's, but
// they ride in the same archive record chain and under the same generation
// fence. They cross this boundary because the coordinator is on the driver side
// and the record layout is on this one.

const MIN_TABLE_PATCH_BYTES: usize = 4 + 4 + 8 + 8 + 4;
const MIN_TABLE_PATCH_RUN_BYTES: usize = 8 + 1;

/// Encode the patch list an archive publication must carry.
pub fn encode_table_patches(
    patches: &[fork_codec::dylink_archive::DylinkTablePatch],
) -> DylinkResult<Vec<u8>> {
    let mut w = Writer::new();
    w.len_prefix(patches.len())?;
    for patch in patches {
        // The generation is assigned by the publication, not by the caller, so
        // it is deliberately not carried: a caller-chosen fence value could
        // claim to be newer than the archive it lands in.
        w.u32(patch.activation_id);
        w.u32(patch.owner_id);
        w.u64(patch.start);
        w.u64(patch.table_length);
        w.len_prefix(patch.runs.len())?;
        for run in &patch.runs {
            w.u64(run.length);
            match run.function {
                Some(function) => {
                    w.bool(true);
                    w.u32(function.activation_id);
                    w.u32(function.ordinal);
                }
                None => w.bool(false),
            }
        }
    }
    Ok(w.into_bytes())
}

/// Decode a patch list.
pub fn decode_table_patches(
    bytes: &[u8],
) -> DylinkResult<Vec<fork_codec::dylink_archive::DylinkTablePatch>> {
    use fork_codec::dylink_archive::{DylinkTableFunction, DylinkTablePatch, DylinkTablePatchRun};
    let mut r = Reader::new(bytes);
    let count = r.vec_len(MIN_TABLE_PATCH_BYTES)?;
    let mut patches = Vec::with_capacity(count);
    for _ in 0..count {
        let activation_id = r.u32()?;
        let owner_id = r.u32()?;
        let start = r.u64()?;
        let table_length = r.u64()?;
        let run_count = r.vec_len(MIN_TABLE_PATCH_RUN_BYTES)?;
        let mut runs = Vec::with_capacity(run_count);
        for _ in 0..run_count {
            let length = r.u64()?;
            let function = if r.bool()? {
                Some(DylinkTableFunction {
                    activation_id: r.u32()?,
                    ordinal: r.u32()?,
                })
            } else {
                None
            };
            runs.push(DylinkTablePatchRun { length, function });
        }
        patches.push(DylinkTablePatch {
            generation: 0,
            activation_id,
            owner_id,
            start,
            table_length,
            runs,
        });
    }
    r.finish()?;
    Ok(patches)
}

// ---------------------------------------------------------------------------
// LinkerConfig
// ---------------------------------------------------------------------------

/// Encode the process-wide linker configuration.
pub fn encode_linker_config(config: &LinkerConfig) -> DylinkResult<Vec<u8>> {
    let mut w = Writer::new();
    put_pointer_width(&mut w, config.pointer_width);
    w.bool(config.has_allocator);
    w.bool(config.fork_activation_available);
    w.str(&config.fork_activation_unavailable_reason)?;
    put_unresolved_policy(&mut w, config.unresolved_policy);
    w.u64(config.memory_bytes);
    w.bool(config.shared_memory);
    put_option_u64(&mut w, config.heap_pointer);
    w.len_prefix(config.library_search_paths.len())?;
    for path in &config.library_search_paths {
        w.str(path)?;
    }
    Ok(w.into_bytes())
}

/// Decode the process-wide linker configuration.
pub fn decode_linker_config(bytes: &[u8]) -> DylinkResult<LinkerConfig> {
    let mut r = Reader::new(bytes);
    let config = LinkerConfig {
        pointer_width: get_pointer_width(&mut r)?,
        has_allocator: r.bool()?,
        fork_activation_available: r.bool()?,
        fork_activation_unavailable_reason: r.str()?,
        unresolved_policy: get_unresolved_policy(&mut r)?,
        memory_bytes: r.u64()?,
        shared_memory: r.bool()?,
        heap_pointer: get_option_u64(&mut r)?,
        library_search_paths: {
            let count = r.vec_len(MIN_STRING_BYTES)?;
            let mut paths = Vec::with_capacity(count);
            for _ in 0..count {
                paths.push(r.str()?);
            }
            paths
        },
    };
    r.finish()?;
    Ok(config)
}

// ---------------------------------------------------------------------------
// SymbolValue / ResolvedSymbol
// ---------------------------------------------------------------------------

fn put_symbol_value(w: &mut Writer, value: &SymbolValue) -> DylinkResult<()> {
    match value {
        SymbolValue::Data { address, binding } => {
            w.u8(0);
            w.u64(*address);
            match binding {
                DataBinding::Export { instance, name } => {
                    w.u8(0);
                    w.u32(instance.index());
                    w.str(name)?;
                }
                DataBinding::Global(global) => {
                    w.u8(1);
                    w.u32(global.index());
                }
            }
        }
        SymbolValue::Func { instance, export } => {
            w.u8(1);
            w.u32(instance.index());
            w.str(export)?;
        }
    }
    Ok(())
}

fn get_symbol_value(r: &mut Reader<'_>) -> DylinkResult<SymbolValue> {
    Ok(match r.u8()? {
        0 => {
            let address = r.u64()?;
            let binding = match r.u8()? {
                0 => DataBinding::Export {
                    instance: InstanceId(r.u32()?),
                    name: r.str()?,
                },
                1 => DataBinding::Global(GlobalId(r.u32()?)),
                _ => return Err(malformed("unknown wire data binding")),
            };
            SymbolValue::Data { address, binding }
        }
        1 => SymbolValue::Func {
            instance: InstanceId(r.u32()?),
            export: r.str()?,
        },
        _ => return Err(malformed("unknown wire symbol value")),
    })
}

/// Encode a `dlsym` answer. `None` is a miss, which POSIX reports through
/// `dlerror` -- it is not a transport failure, so it has its own tag rather
/// than an error return.
pub fn encode_resolved_symbol(symbol: Option<&ResolvedSymbol>) -> DylinkResult<Vec<u8>> {
    let mut w = Writer::new();
    match symbol {
        None => w.u8(0),
        Some(symbol) => {
            w.u8(1);
            put_symbol_value(&mut w, &symbol.value)?;
            put_option_str(&mut w, symbol.owner.as_deref())?;
            w.bool(symbol.globally_visible);
        }
    }
    Ok(w.into_bytes())
}

/// Decode a `dlsym` answer.
pub fn decode_resolved_symbol(bytes: &[u8]) -> DylinkResult<Option<ResolvedSymbol>> {
    let mut r = Reader::new(bytes);
    let symbol = match r.u8()? {
        0 => None,
        1 => {
            let value = get_symbol_value(&mut r)?;
            let owner = get_option_str(&mut r)?;
            Some(ResolvedSymbol {
                value,
                owner,
                globally_visible: r.bool()?,
            })
        }
        _ => return Err(malformed("unknown wire resolved symbol")),
    };
    r.finish()?;
    Ok(symbol)
}

// ---------------------------------------------------------------------------
// Main image
// ---------------------------------------------------------------------------

/// What [`crate::scope::LinkerScope::publish_main_image`] needs, as one record.
///
/// The main image is the root of the global scope, so this crosses the boundary
/// once per process, before any `dlopen` can resolve a symbol against it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MainImage {
    pub table_length: u64,
    /// Export name -> what it denotes.
    pub exports: Vec<(String, SymbolValue)>,
    /// `(table slot, defining instance, export name)`: the element-segment map.
    pub element_slots: Vec<(u64, InstanceId, String)>,
}

/// Encode the main image's exports and element-segment table layout.
pub fn encode_main_image(image: &MainImage) -> DylinkResult<Vec<u8>> {
    let mut w = Writer::new();
    w.u64(image.table_length);
    w.len_prefix(image.exports.len())?;
    for (name, value) in &image.exports {
        w.str(name)?;
        put_symbol_value(&mut w, value)?;
    }
    w.len_prefix(image.element_slots.len())?;
    for (slot, instance, export) in &image.element_slots {
        w.u64(*slot);
        w.u32(instance.index());
        w.str(export)?;
    }
    Ok(w.into_bytes())
}

/// Decode the main image record.
pub fn decode_main_image(bytes: &[u8]) -> DylinkResult<MainImage> {
    let mut r = Reader::new(bytes);
    let table_length = r.u64()?;
    let export_count = r.vec_len(MIN_NAMED_SYMBOL_BYTES)?;
    let mut exports = Vec::with_capacity(export_count);
    for _ in 0..export_count {
        let name = r.str()?;
        exports.push((name, get_symbol_value(&mut r)?));
    }
    let slot_count = r.vec_len(MIN_ELEMENT_SLOT_BYTES)?;
    let mut element_slots = Vec::with_capacity(slot_count);
    for _ in 0..slot_count {
        let slot = r.u64()?;
        let instance = InstanceId(r.u32()?);
        element_slots.push((slot, instance, r.str()?));
    }
    r.finish()?;
    Ok(MainImage {
        table_length,
        exports,
        element_slots,
    })
}

// ---------------------------------------------------------------------------
// LoadRequest / ReplayInputs
// ---------------------------------------------------------------------------

/// Encode one `dlopen` request, replay inputs included.
pub fn encode_load_request(request: &LoadRequest) -> DylinkResult<Vec<u8>> {
    let mut w = Writer::new();
    w.str(&request.name)?;
    w.blob(&request.module_bytes)?;
    w.bool(request.global_visibility);
    w.bool(request.borrowed_memory);
    match &request.replay {
        None => w.u8(0),
        Some(replay) => {
            w.u8(1);
            put_replay_inputs(&mut w, replay)?;
        }
    }
    Ok(w.into_bytes())
}

/// Decode one `dlopen` request.
pub fn decode_load_request(bytes: &[u8]) -> DylinkResult<LoadRequest> {
    let mut r = Reader::new(bytes);
    let name = r.str()?;
    let module_bytes = r.blob()?;
    let global_visibility = r.bool()?;
    let borrowed_memory = r.bool()?;
    let replay = match r.u8()? {
        0 => None,
        1 => Some(get_replay_inputs(&mut r)?),
        _ => return Err(malformed("unknown wire replay tag")),
    };
    r.finish()?;
    Ok(LoadRequest {
        name,
        module_bytes,
        global_visibility,
        replay,
        borrowed_memory,
    })
}

fn put_replay_inputs(w: &mut Writer, replay: &ReplayInputs) -> DylinkResult<()> {
    w.u64(replay.memory_base);
    w.u64(replay.table_base);
    put_option_u32(w, replay.activation_id);
    put_option_u64(w, replay.tls_base);
    w.bool(replay.global_visibility);
    w.bool(replay.committed_global_root);
    w.len_prefix(replay.provider_dependencies.len())?;
    for dependency in &replay.provider_dependencies {
        w.str(dependency)?;
    }
    w.len_prefix(replay.allocations.len())?;
    for allocation in &replay.allocations {
        put_allocation(w, allocation);
    }
    match replay.initialization_stage {
        None => w.u8(0),
        Some(stage) => {
            w.u8(1);
            put_stage(w, stage);
        }
    }
    w.len_prefix(replay.saved_got_func.len())?;
    for (name, value) in &replay.saved_got_func {
        w.str(name)?;
        put_wasm_value(w, *value);
    }
    Ok(())
}

fn get_replay_inputs(r: &mut Reader<'_>) -> DylinkResult<ReplayInputs> {
    let memory_base = r.u64()?;
    let table_base = r.u64()?;
    let activation_id = get_option_u32(r)?;
    let tls_base = get_option_u64(r)?;
    let global_visibility = r.bool()?;
    let committed_global_root = r.bool()?;
    let dependency_count = r.vec_len(MIN_STRING_BYTES)?;
    let mut provider_dependencies = Vec::with_capacity(dependency_count);
    for _ in 0..dependency_count {
        provider_dependencies.push(r.str()?);
    }
    let allocation_count = r.vec_len(MIN_ALLOCATION_BYTES)?;
    let mut allocations = Vec::with_capacity(allocation_count);
    for _ in 0..allocation_count {
        allocations.push(get_allocation(r)?);
    }
    let initialization_stage = match r.u8()? {
        0 => None,
        1 => Some(get_stage(r)?),
        _ => return Err(malformed("unknown wire initialization stage tag")),
    };
    let saved_count = r.vec_len(MIN_SAVED_GOT_ENTRY_BYTES)?;
    let mut saved_got_func = BTreeMap::new();
    for _ in 0..saved_count {
        let name = r.str()?;
        saved_got_func.insert(name, get_wasm_value(r)?);
    }
    Ok(ReplayInputs {
        memory_base,
        table_base,
        activation_id,
        tls_base,
        global_visibility,
        committed_global_root,
        provider_dependencies,
        allocations,
        initialization_stage,
        saved_got_func,
    })
}

// ---------------------------------------------------------------------------
// dlclose
// ---------------------------------------------------------------------------

/// Encode what `dlclose` did.
pub fn encode_close_outcome(outcome: &CloseOutcome) -> DylinkResult<Vec<u8>> {
    let mut w = Writer::new();
    match outcome {
        CloseOutcome::MainImage => w.u8(0),
        CloseOutcome::StillReferenced { library, remaining } => {
            w.u8(1);
            w.str(library)?;
            w.u32(*remaining);
        }
        CloseOutcome::Released { library } => {
            w.u8(2);
            w.str(library)?;
        }
    }
    Ok(w.into_bytes())
}

/// Decode what `dlclose` did.
pub fn decode_close_outcome(bytes: &[u8]) -> DylinkResult<CloseOutcome> {
    let mut r = Reader::new(bytes);
    let outcome = match r.u8()? {
        0 => CloseOutcome::MainImage,
        1 => CloseOutcome::StillReferenced {
            library: r.str()?,
            remaining: r.u32()?,
        },
        2 => CloseOutcome::Released { library: r.str()? },
        _ => return Err(malformed("unknown wire close outcome")),
    };
    r.finish()?;
    Ok(outcome)
}

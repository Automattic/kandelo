//! Exchange-memory ownership and the shared scalar/reference wire layout.
use super::*;

impl Body<'_> {
    pub(super) fn arg(&self, offset: u64) -> MemArg {
        MemArg {
            offset,
            align: 0,
            memory_index: self.codec.memory,
        }
    }
    pub(super) fn load(&mut self, storage: StorageType, offset: u64) -> Result<()> {
        self.emit([
            Instruction::LocalGet(STAGING),
            self.scalar_load(storage, offset)?,
        ])
    }
    pub(super) fn scalar_load(
        &self,
        storage: StorageType,
        offset: u64,
    ) -> Result<Instruction<'static>> {
        let arg = self.arg(offset);
        Ok(match storage {
            StorageType::I8 => Instruction::I32Load8U(arg),
            StorageType::I16 => Instruction::I32Load16U(arg),
            StorageType::Val(ValType::I32) => Instruction::I32Load(arg),
            StorageType::Val(ValType::I64) => Instruction::I64Load(arg),
            StorageType::Val(ValType::F32) => Instruction::F32Load(arg),
            StorageType::Val(ValType::F64) => Instruction::F64Load(arg),
            StorageType::Val(ValType::V128) => Instruction::V128Load(arg),
            StorageType::Val(ValType::Ref(_)) => anyhow::bail!("GC reference has no scalar load"),
        })
    }
    pub(super) fn scalar_store(
        &self,
        storage: StorageType,
        offset: u64,
    ) -> Result<Instruction<'static>> {
        let arg = self.arg(offset);
        Ok(match storage {
            StorageType::I8 => Instruction::I32Store8(arg),
            StorageType::I16 => Instruction::I32Store16(arg),
            StorageType::Val(ValType::I32) => Instruction::I32Store(arg),
            StorageType::Val(ValType::I64) => Instruction::I64Store(arg),
            StorageType::Val(ValType::F32) => Instruction::F32Store(arg),
            StorageType::Val(ValType::F64) => Instruction::F64Store(arg),
            StorageType::Val(ValType::V128) => Instruction::V128Store(arg),
            StorageType::Val(ValType::Ref(_)) => anyhow::bail!("GC reference has no scalar store"),
        })
    }
    pub(super) fn reserve(&mut self) -> Result<()> {
        // Even a reference-only struct has a nonzero, independently owned
        // exchange range while its recursive edges are encoded or decoded.
        self.emit([
            Instruction::LocalGet(SCALAR_LEN),
            Instruction::I32Const(1),
            Instruction::LocalGet(SCALAR_LEN),
            Instruction::Select,
            Instruction::LocalSet(RESERVATION),
            Instruction::LocalGet(RESERVATION),
        ])?;
        self.pointer()?;
        self.emit([
            Instruction::Call(self.codec.host.reserve),
            Instruction::LocalSet(STAGING),
        ])
    }
    pub(super) fn release(&mut self) -> Result<()> {
        self.emit([
            Instruction::LocalGet(STAGING),
            Instruction::LocalGet(RESERVATION),
        ])?;
        self.pointer()?;
        self.emit([Instruction::Call(self.codec.host.release)])
    }
    pub(super) fn load_payload(&mut self, layout: Option<&NativeGcLayout>) -> Result<()> {
        let (id, ty, kind) = layout.map_or((0, u32::MAX, 0), |layout| {
            (
                layout.id,
                layout.type_ordinal,
                if layout.kind == NativeGcKind::Struct {
                    1
                } else {
                    2
                },
            )
        });
        self.emit([
            Instruction::LocalGet(ARG),
            Instruction::GlobalGet(self.codec.host.activation),
            Instruction::I32Const(id as i32),
            Instruction::Call(self.codec.host.payload_len),
            Instruction::LocalSet(SCALAR_LEN),
        ])?;
        self.reserve()?;
        self.emit([
            Instruction::LocalGet(ARG),
            Instruction::GlobalGet(self.codec.host.activation),
            Instruction::I32Const(ty as i32),
            Instruction::I32Const(id as i32),
            Instruction::I32Const(kind),
            Instruction::LocalGet(STAGING),
            Instruction::LocalGet(SCALAR_LEN),
            Instruction::Call(self.codec.host.load),
            Instruction::LocalSet(VECTOR),
        ])
    }
    pub(super) fn snapshot_scalar(
        &mut self,
        layout: &NativeGcLayout,
        field: &NativeGcField,
    ) -> Result<()> {
        let offset = layout
            .provenance_scalar_len
            .checked_add(
                field
                    .scalar_offset
                    .context("GC scalar field has no offset")?,
            )
            .context("GC scalar snapshot offset overflow")?;
        self.load(field.field.element_type, u64::from(offset))
    }
    pub(super) fn snapshot_reference(
        &mut self,
        layout: &NativeGcLayout,
        field: &NativeGcField,
        index: u32,
    ) -> Result<()> {
        let index = layout
            .provenance_reference_count
            .checked_add(index)
            .context("GC reference snapshot offset overflow")?;
        self.vector_reference(field, index)
    }
    pub(super) fn array_address(&mut self, layout: &NativeGcLayout, replay: bool) -> Result<()> {
        let prefix = if replay {
            layout.provenance_scalar_len
        } else {
            0
        };
        self.emit([
            Instruction::LocalGet(STAGING),
            ptr_const(self.codec.pointer, i64::from(prefix) + 4),
            self.add(),
            Instruction::LocalGet(INDEX),
            Instruction::I32Const(layout.scalar_len_or_stride as i32),
            Instruction::I32Mul,
        ])?;
        self.pointer()?;
        self.emit([self.add()])
    }
    pub(super) fn replay_provenance(&mut self, layout: &NativeGcLayout) -> Result<()> {
        let host = self.codec.host.provenance;
        self.emit([
            Instruction::LocalGet(ARG),
            Instruction::I32Const(1),
            Instruction::I32Add,
            Instruction::GlobalGet(host.activation),
            Instruction::I32Const(layout.base_layout_id as i32),
            Instruction::I32Const(layout.id as i32),
        ])?;
        match layout.provenance_scalar_len {
            0 => self.emit([Instruction::I64Const(0), Instruction::I64Const(0)])?,
            size @ (1 | 2 | 4) => {
                let storage = match size {
                    1 => StorageType::I8,
                    2 => StorageType::I16,
                    _ => StorageType::Val(ValType::I32),
                };
                self.load(storage, 0)?;
                self.emit([Instruction::I64ExtendI32U, Instruction::I64Const(0)])?;
            }
            8 => {
                self.load(StorageType::Val(ValType::I64), 0)?;
                self.emit([Instruction::I64Const(0)])?;
            }
            16 => {
                self.load(StorageType::Val(ValType::I64), 0)?;
                self.load(StorageType::Val(ValType::I64), 8)?;
            }
            _ => anyhow::bail!("invalid GC provenance scalar length"),
        }
        self.emit([
            Instruction::I32Const(layout.provenance_reference_count as i32),
            Instruction::Call(host.begin),
            Instruction::LocalSet(TOKEN),
        ])?;
        for index in 0..layout.provenance_reference_count {
            self.emit([
                Instruction::LocalGet(TOKEN),
                Instruction::I32Const(index as i32),
                Instruction::LocalGet(VECTOR),
                Instruction::I32Const(index as i32),
                Instruction::Call(self.codec.vectors[3]),
                Instruction::I32Const(1),
                Instruction::I32Add,
                Instruction::Call(host.reference),
            ])?;
        }
        self.emit([Instruction::LocalGet(TOKEN), Instruction::Call(host.end)])
    }
}

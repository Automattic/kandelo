//! Original GC layouts and constructor provenance, without a module-wide
//! instruction arena. This catalog records allocation dependencies and seed
//! ownership; discovering it alone installs no reference provider.
use super::{FrozenReferenceKinds, IrLimits, NativeReferenceClass, Scan, SourceTypes};
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use wasm_encoder::{Encode, FieldType, StorageType, ValType, reencode::Reencode};

mod codec;
mod constructors;
mod descriptor;
mod layouts;
mod provenance;
mod types;
pub use codec::*;
pub use provenance::*;

#[derive(Clone, Copy, Debug)]
pub struct GcPlanLimits {
    pub metadata_bytes: usize,
    pub work: usize,
    pub ir: IrLimits,
}
impl Default for GcPlanLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            work: 100 * 1024 * 1024,
            ir: Default::default(),
        }
    }
}
struct Budget {
    metadata: usize,
    work: usize,
}
impl Budget {
    fn new(limits: GcPlanLimits) -> Self {
        Self {
            metadata: limits.metadata_bytes,
            work: limits.work,
        }
    }
    fn charge(&mut self, bytes: usize) -> Result<()> {
        self.metadata = self
            .metadata
            .checked_sub(bytes)
            .context("GC planning exceeds metadata budget")?;
        Ok(())
    }
    fn step(&mut self, units: usize) -> Result<()> {
        self.work = self
            .work
            .checked_sub(units)
            .context("GC planning exceeds work budget")?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeGcKind {
    Struct,
    Array,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum NativeGcConstructor {
    Struct,
    ArrayGeneric,
    ArrayNew,
    ArrayDefault,
    ArrayFixed { len: u32 },
    ArrayData { segment_ordinal: u32 },
    ArrayElement { segment_ordinal: u32 },
}
impl NativeGcConstructor {
    fn auxiliary(self) -> u32 {
        match self {
            Self::ArrayFixed { len } => len,
            Self::ArrayData { segment_ordinal } | Self::ArrayElement { segment_ordinal } => {
                segment_ordinal
            }
            _ => 0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct NativeGcField {
    pub field: FieldType,
    pub class: Option<NativeReferenceClass>,
    pub scalar_offset: Option<u32>,
    pub reference_ordinal: Option<u32>,
    pub allocation_dependency: bool,
}
#[derive(Clone, Debug)]
pub struct NativeGcLayout {
    pub id: u32,
    /// First original binary declaration with this canonical Wasm GC identity.
    pub source_type: u32,
    /// Frozen output type index, used by generated typed instructions.
    pub type_index: u32,
    pub type_ordinal: u32,
    pub base_layout_id: u32,
    pub kind: NativeGcKind,
    pub constructor: NativeGcConstructor,
    pub scalar_len_or_stride: u32,
    pub fields: Vec<NativeGcField>,
    pub super_type_ordinal: Option<u32>,
    pub subtype_depth: u32,
    pub defaultable_shell: bool,
    pub requires_provenance: bool,
    pub provenance_scalar_len: u32,
    pub provenance_reference_count: u32,
}
pub struct NativeGcPlan {
    layouts: Vec<NativeGcLayout>,
    dispatch: Vec<u32>,
    identities: Vec<u32>,
    bases: BTreeMap<u32, usize>,
    constructors: BTreeMap<(u32, NativeGcConstructor), usize>,
    metadata_budget: usize,
    source: [u8; 32],
    identity: [u8; 32],
}
impl NativeGcPlan {
    pub fn discover<T: Reencode>(
        scan: &Scan<'_>,
        source_types: &SourceTypes,
        map: &mut T,
        limits: GcPlanLimits,
    ) -> Result<Self>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        let mut budget = Budget::new(limits);
        let original = types::OriginalGcTypes::read(scan, source_types, limits, &mut budget)?;
        let source: [u8; 32] = Sha256::digest(scan.input()).into();
        let mut plan = Self {
            layouts: Vec::new(),
            dispatch: Vec::new(),
            identities: original.identities,
            bases: BTreeMap::new(),
            constructors: BTreeMap::new(),
            metadata_budget: limits.metadata_bytes,
            source,
            identity: source,
        };
        budget.charge(
            plan.identities
                .len()
                .checked_mul(8)
                .context("GC type identity size overflow")?,
        )?;
        if original.types.is_empty() {
            return Ok(plan);
        }
        let kinds = FrozenReferenceKinds::new(scan, map, limits.metadata_bytes)?;
        let mut parents = Vec::new();
        for declaration in original.types {
            let layout = layouts::base_layout(
                declaration.source,
                declaration.definition,
                plan.next_id()?,
                source_types,
                map,
                &kinds,
                &mut budget,
            )?;
            parents.push(declaration.parent);
            plan.bases.insert(layout.source_type, plan.layouts.len());
            plan.layouts.push(layout);
        }
        plan.resolve_inheritance(&parents, &mut budget)?;
        plan.discover_constructors(scan, limits.ir, &mut budget)?;
        plan.dispatch = plan
            .layouts
            .iter()
            .filter(|layout| layout.id == layout.base_layout_id)
            .map(|layout| layout.id)
            .collect();
        plan.dispatch.sort_by_key(|&id| {
            let layout = &plan.layouts[(id - 1) as usize];
            (std::cmp::Reverse(layout.subtype_depth), layout.type_ordinal)
        });
        let mut identity = Sha256::new();
        identity.update(plan.source);
        identity.update(plan.descriptor()?);
        let mut storage = Vec::new();
        for layout in &plan.layouts {
            identity.update(layout.type_index.to_le_bytes());
            for field in &layout.fields {
                storage.clear();
                field.field.element_type.encode(&mut storage);
                identity.update(&storage);
            }
        }
        plan.identity = identity.finalize().into();
        Ok(plan)
    }
    fn next_id(&self) -> Result<u32> {
        u32::try_from(self.layouts.len())
            .ok()
            .and_then(|len| len.checked_add(1))
            .filter(|id| *id <= 0x7fff_ffff)
            .context("GC layout catalog exceeds u31")
    }
    pub fn layouts(&self) -> &[NativeGcLayout] {
        &self.layouts
    }
    pub(super) fn validate_source(&self, scan: &Scan<'_>) -> Result<()> {
        ensure!(
            self.source == <[u8; 32]>::from(Sha256::digest(scan.input())),
            "GC plan belongs to another source module"
        );
        Ok(())
    }
    pub fn dispatch_layouts(&self) -> &[u32] {
        &self.dispatch
    }
    /// Lookups use original source indices, including aliases. Constructors
    /// are recognized while one original function body is being emitted.
    pub fn base_layout(&self, source_type: u32) -> Option<&NativeGcLayout> {
        let identity = self.identities.get(source_type as usize)?;
        self.bases.get(identity).map(|&index| &self.layouts[index])
    }
    pub fn constructor_layout(
        &self,
        source_type: u32,
        constructor: NativeGcConstructor,
    ) -> Option<&NativeGcLayout> {
        let base = self.base_layout(source_type)?;
        if constructor == NativeGcConstructor::Struct
            && base.kind == NativeGcKind::Struct
            && base.requires_provenance
        {
            return Some(base);
        }
        self.constructors
            .get(&(base.id, constructor))
            .map(|&index| &self.layouts[index])
    }
}

fn storage_size(storage: StorageType) -> u32 {
    match storage {
        StorageType::I8 => 1,
        StorageType::I16 => 2,
        StorageType::Val(ValType::I32 | ValType::F32 | ValType::Ref(_)) => 4,
        StorageType::Val(ValType::I64 | ValType::F64) => 8,
        StorageType::Val(ValType::V128) => 16,
    }
}

//! Per-function activation layout, virtual spills and compact reference recipes.
//! Plans are discarded with each body; helper shapes can be interned separately.

mod catches;
mod codecs;
mod references;
mod storage;
pub use catches::*;
pub use codecs::*;
pub use references::*;
pub use storage::*;

use super::{FunctionIr, Scan, SourceTypes};
use anyhow::{Context, Result, ensure};
use std::collections::{BTreeMap, BTreeSet};
use wasm_encoder::{Function, ValType, reencode::Reencode};
use wasmparser::{ExternalKind, Name, NameSectionReader, Operator, Parser, Payload};

pub const FRAME_HEADER_SIZE: u32 = 16;
pub const FRAME_FUNCTION_OFFSET: u64 = 0;
pub const FRAME_CALL_OFFSET: u64 = 4;
pub const FRAME_CATCH_OFFSET: u64 = 8;
pub const FRAME_REFERENCE_OFFSET: u64 = 12;
pub const SCRATCH_SPILL_THRESHOLD: u32 = 256;

#[derive(Clone, Copy, Debug)]
pub struct FrameLimits {
    pub metadata_bytes: usize,
    pub locals: usize,
    pub reference_memberships: usize,
}
impl Default for FrameLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            locals: 1_000_000,
            reference_memberships: 1_000_000,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct FrameEnvironment {
    pub pointer: ValType,
    pub memory: Option<u32>,
    pub stack_pointer: Option<u32>,
}
impl FrameEnvironment {
    /// Discover once per original module, before loading functions. A named
    /// export takes precedence even when its type prevents scratch storage.
    pub fn discover<T: Reencode>(scan: &Scan<'_>, map: &mut T, budget: usize) -> Result<Self>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        let types = scan.types.as_ref();
        let wide = types.memory_count() != 0 && types.memory_at(0).memory64;
        let pointer = if wide { ValType::I64 } else { ValType::I32 };
        let memory = if types.memory_count() == 0 {
            None
        } else {
            Some(map.memory_index(0)?)
        };
        let export = scan.exports.iter().find_map(|(name, kind, index)| {
            (name == "__stack_pointer" && *kind == ExternalKind::Global).then_some(*index)
        });
        let source = if let Some(index) = export {
            Some(index)
        } else {
            let mut names = BTreeSet::new();
            for payload in Parser::new(0).parse_all(scan.input()) {
                if let Payload::CustomSection(section) = payload? {
                    if section.name() == "name" {
                        for name in NameSectionReader::new(wasmparser::BinaryReader::new(
                            section.data(),
                            section.data_offset(),
                        )) {
                            if let Name::Global(map) = name? {
                                for entry in map {
                                    let entry = entry?;
                                    if entry.name == "__stack_pointer" {
                                        ensure!(
                                            names.len() < budget / 64,
                                            "stack-pointer names exceed metadata budget"
                                        );
                                        names.insert(entry.index);
                                    } else {
                                        names.remove(&entry.index);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            names.first().copied()
        };
        let stack_pointer = source
            .filter(|&i| {
                i < types.global_count() && {
                    let ty = types.global_at(i);
                    ty.mutable
                        && ty.content_type
                            == if wide {
                                wasmparser::ValType::I64
                            } else {
                                wasmparser::ValType::I32
                            }
                }
            })
            .map(|i| map.global_index(i))
            .transpose()?;
        Ok(Self {
            pointer,
            memory,
            stack_pointer,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LocalKey(pub u32);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    User,
    Saved,
    Temporary,
}
#[derive(Clone, Copy, Debug)]
pub struct FrameLocal {
    pub key: LocalKey,
    pub ty: ValType,
    pub source: Option<u32>,
    role: Role,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScalarField {
    pub local: LocalKey,
    pub ty: ValType,
    pub offset: u32,
}
#[derive(Debug)]
pub struct CatchScalarArm {
    pub selector: u32,
    pub fields: Vec<ScalarField>,
}
#[derive(Debug)]
struct PendingCatch {
    selector: u32,
    locals: Vec<LocalKey>,
    recipe: bool,
}

pub struct FrameBuilder {
    values: Vec<FrameLocal>,
    by_key: BTreeMap<LocalKey, usize>,
    parameters: usize,
    next_key: u32,
    environment: FrameEnvironment,
    limits: FrameLimits,
    estimated: usize,
    catch: Vec<PendingCatch>,
    catch_selectors: BTreeSet<u32>,
}

impl FrameBuilder {
    pub fn new<T: Reencode>(
        scan: &Scan<'_>,
        body: &FunctionIr<'_>,
        source_types: &SourceTypes,
        map: &mut T,
        environment: FrameEnvironment,
        limits: FrameLimits,
    ) -> Result<Self>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        let source = scan
            .functions
            .get(body.function as usize)
            .context("unknown frame function")?;
        ensure!(
            source.ty == body.type_index
                && source
                    .body
                    .as_ref()
                    .is_some_and(|b| b.range == body.source.range()
                        && std::ptr::eq(
                            scan.input()[b.range.clone()].as_ptr(),
                            body.source.as_bytes().as_ptr()
                        )),
            "frame planning requires the original source function"
        );
        ensure!(
            matches!(environment.pointer, ValType::I32 | ValType::I64),
            "invalid frame pointer type"
        );
        let types = scan.types.as_ref();
        let signature = types
            .get(types.core_type_at_in_module(body.type_index))
            .unwrap()
            .composite_type
            .unwrap_func();
        let parameters = signature.params().len();
        let mut builder = Self {
            values: Vec::new(),
            by_key: BTreeMap::new(),
            parameters,
            next_key: u32::try_from(body.locals.len())?,
            environment,
            limits,
            estimated: 0,
            catch: Vec::new(),
            catch_selectors: BTreeSet::new(),
        };
        for index in 0..parameters as u32 {
            builder.user(
                index,
                source_types.value_type(map, body.locals[index as usize])?,
            )?;
        }
        // Parameter-first, then first lexical use matches collect_user_locals.
        // Semantic reachability differs after return_call* and at joins.
        for instruction in body.instructions.iter().filter(|i| i.retained) {
            if let Operator::LocalGet { local_index }
            | Operator::LocalSet { local_index }
            | Operator::LocalTee { local_index } = instruction.operation
            {
                if !builder.by_key.contains_key(&LocalKey(local_index)) {
                    builder.user(
                        local_index,
                        source_types.value_type(map, body.locals[local_index as usize])?,
                    )?;
                }
            }
        }
        Ok(builder)
    }
    fn charge(&mut self, bytes: usize) -> Result<()> {
        let next = self
            .estimated
            .checked_add(bytes)
            .context("frame metadata size overflow")?;
        ensure!(
            next <= self.limits.metadata_bytes,
            "frame metadata exceeds budget"
        );
        self.estimated = next;
        Ok(())
    }
    fn insert(&mut self, value: FrameLocal) -> Result<LocalKey> {
        ensure!(
            self.values.len() < self.limits.locals,
            "frame local count exceeds budget"
        );
        // Covers catalogs, key/index maps, fields, declaration vectors and
        // overlapping scratch during final layout; separate from input IR.
        self.charge(512)?;
        let key = value.key;
        self.by_key.insert(key, self.values.len());
        self.values.push(value);
        Ok(key)
    }
    fn user(&mut self, index: u32, ty: ValType) -> Result<LocalKey> {
        self.insert(FrameLocal {
            key: LocalKey(index),
            ty,
            source: Some(index),
            role: Role::User,
        })
    }
    fn allocate(&mut self, ty: ValType, role: Role) -> Result<LocalKey> {
        let key = LocalKey(self.next_key);
        let next = self
            .next_key
            .checked_add(1)
            .context("frame local key overflow")?;
        self.insert(FrameLocal {
            key,
            ty,
            source: None,
            role,
        })?;
        self.next_key = next;
        Ok(key)
    }
    pub fn saved(&mut self, ty: ValType) -> Result<LocalKey> {
        self.allocate(ty, Role::Saved)
    }
    pub fn temporary(&mut self, ty: ValType) -> Result<LocalKey> {
        self.allocate(ty, Role::Temporary)
    }
    pub fn source_local(&self, index: u32) -> Option<LocalKey> {
        self.by_key
            .get(&LocalKey(index))
            .is_some_and(|&i| self.values[i].source == Some(index))
            .then_some(LocalKey(index))
    }
    pub fn local(&self, key: LocalKey) -> Result<&FrameLocal> {
        self.by_key
            .get(&key)
            .map(|&i| &self.values[i])
            .context("unknown frame local key")
    }
    pub fn catch_arm(
        &mut self,
        selector: u32,
        locals: Vec<LocalKey>,
        uses_exception_recipe: bool,
    ) -> Result<()> {
        ensure!(
            selector != 0 && !self.catch_selectors.contains(&selector),
            "invalid or duplicate catch selector"
        );
        for &key in &locals {
            let value = self.local(key)?;
            ensure!(
                value.role == Role::Temporary,
                "catch payload must use separate temporary locals"
            );
            ensure!(
                uses_exception_recipe || !matches!(value.ty, ValType::Ref(_)),
                "reference catch payload requires a recipe"
            );
        }
        self.charge(
            locals
                .len()
                .checked_mul(64)
                .and_then(|n| n.checked_add(256))
                .context("catch frame metadata overflow")?,
        )?;
        self.catch_selectors.insert(selector);
        self.catch.push(PendingCatch {
            selector,
            locals,
            recipe: uses_exception_recipe,
        });
        Ok(())
    }
    pub fn finish(mut self) -> Result<FrameLayout> {
        let mut scalars: Vec<_> = self
            .values
            .iter()
            .filter(|v| v.role != Role::Temporary && !matches!(v.ty, ValType::Ref(_)))
            .map(|v| (v.key, v.ty))
            .collect();
        let user_count = scalars
            .iter()
            .take_while(|(k, _)| self.local(*k).unwrap().role == Role::User)
            .count();
        let spill_bytes = scalars[user_count..]
            .iter()
            .try_fold(0u32, |n, (_, ty)| n.checked_add(scalar_size(*ty)))
            .context("frame spill size overflow")?;
        let scratch = spill_bytes >= SCRATCH_SPILL_THRESHOLD
            && self.environment.memory.is_some()
            && self.environment.stack_pointer.is_some();
        let sorted = if scratch {
            &mut scalars[..user_count]
        } else {
            &mut scalars[..]
        };
        sorted.sort_by_key(|(_, ty)| scalar_rank(*ty));
        let mut offset = FRAME_HEADER_SIZE;
        let mut fields = Vec::with_capacity(scalars.len());
        for (local, ty) in scalars {
            fields.push(ScalarField { local, ty, offset });
            offset = offset
                .checked_add(scalar_size(ty))
                .context("activation frame size overflow")?;
        }
        let scratch = if scratch {
            let node_spill_start = fields[user_count].offset;
            let base = self.temporary(self.environment.pointer)?;
            let size = spill_bytes
                .checked_add(15)
                .context("scratch alignment overflow")?
                & !15;
            let mut offsets = BTreeMap::new();
            let mut temporaries = BTreeMap::new();
            for field in &fields[user_count..] {
                offsets.insert(field.local, (field.ty, field.offset - node_spill_start));
                if !temporaries.contains_key(&field.ty) {
                    temporaries.insert(field.ty, self.temporary(field.ty)?);
                }
            }
            Some(ScratchStorage {
                stack_pointer: self.environment.stack_pointer.unwrap(),
                base,
                size,
                node_spill_start,
                spill_bytes,
                offsets,
                temporaries,
            })
        } else {
            None
        };
        let mut catch = Vec::with_capacity(self.catch.len());
        let mut catch_bytes = 0;
        for arm in &self.catch {
            let mut end = offset;
            let mut fields = Vec::new();
            if !arm.recipe {
                for &key in &arm.locals {
                    let ty = self.local(key)?.ty;
                    fields.push(ScalarField {
                        local: key,
                        ty,
                        offset: end,
                    });
                    end = end
                        .checked_add(scalar_size(ty))
                        .context("catch frame size overflow")?;
                }
            }
            catch_bytes = catch_bytes.max(end - offset);
            catch.push(CatchScalarArm {
                selector: arm.selector,
                fields,
            });
        }
        let size = offset
            .checked_add(catch_bytes)
            .context("activation frame size overflow")?;
        let mut physical = BTreeMap::new();
        let mut declarations = Vec::new();
        let mut index = 0u32;
        for value in &self.values {
            if scratch
                .as_ref()
                .is_some_and(|s| s.offsets.contains_key(&value.key))
            {
                continue;
            }
            let parameter = (index as usize) < self.parameters;
            physical.insert(value.key, index);
            if !parameter {
                declarations.push(storage_type(value.ty));
            }
            index = index
                .checked_add(1)
                .context("physical local count overflow")?;
        }
        Ok(FrameLayout {
            values: self.values,
            by_key: self.by_key,
            physical,
            declarations,
            fields,
            catch,
            size,
            scratch,
            environment: self.environment,
            limits: self.limits,
        })
    }
}

pub struct FrameLayout {
    values: Vec<FrameLocal>,
    by_key: BTreeMap<LocalKey, usize>,
    physical: BTreeMap<LocalKey, u32>,
    declarations: Vec<ValType>,
    pub fields: Vec<ScalarField>,
    pub catch: Vec<CatchScalarArm>,
    pub size: u32,
    pub scratch: Option<ScratchStorage>,
    environment: FrameEnvironment,
    limits: FrameLimits,
}
impl FrameLayout {
    pub fn locals(&self) -> &[FrameLocal] {
        &self.values
    }
    pub fn local(&self, key: LocalKey) -> Result<&FrameLocal> {
        self.by_key
            .get(&key)
            .map(|&i| &self.values[i])
            .context("unknown frame local key")
    }
    pub fn local_index(&self, key: LocalKey) -> Result<u32> {
        self.physical
            .get(&key)
            .copied()
            .context("frame local is virtual or unknown")
    }
    pub fn source_local_index(&self, index: u32) -> Result<u32> {
        ensure!(
            self.local(LocalKey(index))?.source == Some(index),
            "unknown original source local"
        );
        self.local_index(LocalKey(index))
    }
    pub fn local_declarations(&self) -> &[ValType] {
        &self.declarations
    }
    pub fn new_function(&self) -> Function {
        Function::new_with_locals_types(self.declarations.iter().copied())
    }
}
pub(super) fn scalar_size(ty: ValType) -> u32 {
    match ty {
        ValType::I32 | ValType::F32 => 4,
        ValType::I64 | ValType::F64 => 8,
        ValType::V128 => 16,
        _ => unreachable!("scalar frame field"),
    }
}
fn scalar_rank(ty: ValType) -> u8 {
    match ty {
        ValType::V128 => 0,
        ValType::I64 => 1,
        ValType::F64 => 2,
        ValType::I32 => 3,
        ValType::F32 => 4,
        _ => unreachable!(),
    }
}
fn storage_type(ty: ValType) -> ValType {
    match ty {
        ValType::Ref(mut ty) => {
            ty.nullable = true;
            ValType::Ref(ty)
        }
        _ => ty,
    }
}

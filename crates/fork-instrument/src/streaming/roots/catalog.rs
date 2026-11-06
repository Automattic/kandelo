//! Original global ownership and the unchanged imported-global wire format.
use super::super::FrozenReferenceKinds;
use super::*;
use wasm_encoder::ExportKind;
use wasmparser::{Parser, Payload, TypeRef};

pub(super) struct Global {
    pub index: u32,
    pub owner: u32,
    pub ty: ValType,
    pub class: Option<NativeReferenceClass>,
    pub restore: bool,
}
impl Global {
    pub fn code(&self) -> Result<u8> {
        code(self.ty, self.class)
    }
    pub fn value_size(&self) -> u32 {
        if self.class.is_some() {
            4
        } else {
            super::super::frame::scalar_size(self.ty)
        }
    }
}
pub(super) fn globals(
    scan: &Scan<'_>,
    types: &SourceTypes,
    map: &mut NativeRuntime,
    module: &mut ModuleDeclarationBuilder<'_, '_>,
    limits: RootStateLimits,
) -> Result<(Vec<Global>, Vec<u8>)> {
    let source = scan.types.as_ref();
    let count = source.global_count() as usize;
    ensure!(
        count <= limits.metadata_bytes / 256,
        "global roots exceed metadata budget"
    );
    ensure!(count <= limits.work, "global roots exceed work budget");
    let kinds = FrozenReferenceKinds::new(scan, map, limits.metadata_bytes)?;
    let mut imported = BTreeMap::new();
    let mut imported_index = 0u32;
    let mut remaining = limits.metadata_bytes;
    for payload in Parser::new(0).parse_all(scan.input()) {
        if let Payload::ImportSection(section) = payload? {
            for import in section.into_imports() {
                let import = import?;
                if let TypeRef::Global(_) = import.ty {
                    let bytes = import
                        .module
                        .len()
                        .checked_add(import.name.len())
                        .and_then(|n| n.checked_add(256))
                        .context("global import metadata overflow")?;
                    remaining = remaining
                        .checked_sub(bytes)
                        .context("global import names exceed metadata budget")?;
                    imported.insert(imported_index, (import.module, import.name));
                    imported_index += 1;
                }
            }
        }
    }
    let mut globals = Vec::new();
    let mut descriptor = Vec::new();
    descriptor.extend_from_slice(&abi::WPK_FORK_IMPORTED_GLOBALS_MAGIC);
    descriptor.extend_from_slice(&abi::WPK_FORK_IMPORTED_GLOBALS_VERSION.to_le_bytes());
    descriptor.extend_from_slice(&abi::WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE.to_le_bytes());
    descriptor.extend_from_slice(&0u32.to_le_bytes());
    descriptor.extend_from_slice(&0u32.to_le_bytes());
    let mut import_count = 0u32;
    for index in 0..source.global_count() {
        let owner = index
            .checked_add(1)
            .context("global owner ordinal overflow")?;
        let output = map.global_index(index)?;
        module.export(
            &format!("{}{owner}", abi::WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX),
            ExportKind::Global,
            output,
        )?;
        let ty = source.global_at(index);
        let import = imported.get(&index).copied();
        if import == Some(("env", "__channel_base")) || (!ty.mutable && import.is_none()) {
            continue;
        }
        let value = types.value_type(map, ty.content_type)?;
        let class = if let ValType::Ref(reference) = value {
            Some(kinds.class(reference)?)
        } else {
            None
        };
        let global = Global {
            index: output,
            owner,
            ty: value,
            class,
            restore: ty.mutable,
        };
        if let Some((module, name)) = import {
            append_import(
                &mut descriptor,
                &global,
                module,
                name,
                ty.mutable,
                ty.shared,
                limits.metadata_bytes,
            )?;
            import_count = import_count
                .checked_add(1)
                .context("global import count overflow")?;
        }
        globals.push(global);
    }
    descriptor[8..12].copy_from_slice(&import_count.to_le_bytes());
    Ok((globals, descriptor))
}
fn append_import(
    bytes: &mut Vec<u8>,
    global: &Global,
    module: &str,
    name: &str,
    mutable: bool,
    shared: bool,
    limit: usize,
) -> Result<()> {
    let length = usize::from(abi::WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE)
        .checked_add(module.len())
        .and_then(|n| n.checked_add(name.len()))
        .context("global import descriptor size overflow")?;
    ensure!(
        bytes.len().checked_add(length).is_some_and(|n| n <= limit),
        "global import descriptor exceeds metadata budget"
    );
    bytes.extend_from_slice(&u32::try_from(length)?.to_le_bytes());
    bytes.extend_from_slice(&global.owner.to_le_bytes());
    bytes.push(global.code()?);
    bytes.push(
        if mutable {
            abi::WPK_FORK_IMPORTED_GLOBAL_FLAG_MUTABLE
        } else {
            0
        } | if shared {
            abi::WPK_FORK_IMPORTED_GLOBAL_FLAG_SHARED
        } else {
            0
        },
    );
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&u32::try_from(module.len())?.to_le_bytes());
    bytes.extend_from_slice(&u32::try_from(name.len())?.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(module.as_bytes());
    bytes.extend_from_slice(name.as_bytes());
    Ok(())
}
fn code(ty: ValType, class: Option<NativeReferenceClass>) -> Result<u8> {
    Ok(match (ty, class) {
        (ValType::I32, None) => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
        (ValType::I64, None) => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
        (ValType::F32, None) => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32,
        (ValType::F64, None) => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64,
        (ValType::V128, None) => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128,
        (ValType::Ref(_), Some(NativeReferenceClass::Func)) => {
            abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
        }
        (ValType::Ref(_), Some(NativeReferenceClass::Extern)) => {
            abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF
        }
        (ValType::Ref(_), Some(NativeReferenceClass::Exn)) => {
            abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
        }
        (ValType::Ref(_), Some(NativeReferenceClass::Any)) => {
            abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF
        }
        _ => anyhow::bail!("global value type and reference class disagree"),
    })
}

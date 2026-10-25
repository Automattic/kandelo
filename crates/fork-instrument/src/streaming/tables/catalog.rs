//! Only original source tables own catalog ordinals and saved sparse overlays.
use super::*;
use sha2::{Digest, Sha256};
use wasm_encoder::{ExportKind, reencode::Reencode};
use wasmparser::{Operator, Parser, Payload, TypeRef};

pub(super) fn discover(
    scan: &Scan<'_>,
    runtime: &mut NativeRuntime,
    module: &mut ModuleDeclarationBuilder<'_, '_>,
    limits: TableStateLimits,
) -> Result<(Vec<Table>, Vec<u8>)> {
    let count = scan.types.as_ref().table_count();
    ensure!(
        count as usize <= limits.metadata_bytes / 512,
        "table catalog exceeds metadata budget"
    );
    let mut work = limits.work;
    let mut remaining = limits.metadata_bytes;
    let mut imports = BTreeMap::new();
    let mut mutated = BTreeSet::new();
    let mut indirect = BTreeSet::new();
    let mut dynamic_linker = false;
    let mut ordinal = 0u32;
    for payload in Parser::new(0).parse_all(scan.input()) {
        match payload? {
            Payload::ImportSection(section) => {
                for import in section.into_imports() {
                    let import = import?;
                    work = work
                        .checked_sub(1)
                        .context("table catalog exceeds work budget")?;
                    if matches!(import.ty, TypeRef::Table(_)) {
                        let bytes = import
                            .module
                            .len()
                            .checked_add(import.name.len())
                            .and_then(|n| n.checked_add(256))
                            .context("table import names overflow")?;
                        remaining = remaining
                            .checked_sub(bytes)
                            .context("table import names exceed metadata budget")?;
                        imports.insert(ordinal, (import.module, import.name));
                        ordinal += 1;
                    }
                    dynamic_linker |= matches!(import.ty, TypeRef::Func(_) | TypeRef::FuncExact(_))
                        && crate::call_graph::is_dynamic_linker_function_import(
                            import.module,
                            import.name,
                        );
                }
            }
            Payload::ExportSection(section) => {
                for export in section {
                    let export = export?;
                    if export.kind == wasmparser::ExternalKind::Table
                        && export.name == "__indirect_function_table"
                    {
                        indirect.insert(export.index);
                    }
                }
            }
            Payload::CodeSectionEntry(body) => {
                let mut reader = body.get_operators_reader()?;
                while !reader.eof() {
                    work = work
                        .checked_sub(1)
                        .context("table catalog exceeds work budget")?;
                    let table = match reader.read()? {
                        Operator::TableSet { table }
                        | Operator::TableFill { table }
                        | Operator::TableGrow { table }
                        | Operator::TableInit { table, .. } => Some(table),
                        Operator::TableCopy { dst_table, .. } => Some(dst_table),
                        _ => None,
                    };
                    if let Some(table) = table {
                        mutated.insert(table);
                    }
                }
            }
            _ => {}
        }
    }
    let kinds = FrozenReferenceKinds::new(scan, runtime, limits.metadata_bytes)?;
    let types = SourceTypes::new(scan);
    let source: [u8; 32] = scan.source_fingerprint();
    let mut tables = Vec::new();
    let mut descriptor = Vec::new();
    descriptor.extend_from_slice(&abi::WPK_FORK_IMPORTED_TABLES_MAGIC);
    descriptor.extend_from_slice(&abi::WPK_FORK_IMPORTED_TABLES_VERSION.to_le_bytes());
    descriptor.extend_from_slice(&abi::WPK_FORK_IMPORTED_TABLES_HEADER_SIZE.to_le_bytes());
    descriptor.extend_from_slice(&[0; 8]);
    let mut imported_count = 0u32;
    for source_index in 0..count {
        work = work
            .checked_sub(1)
            .context("table catalog exceeds work budget")?;
        let owner = source_index
            .checked_add(1)
            .context("table owner overflow")?;
        let index = runtime.table_index(source_index)?;
        module.export(
            &format!("{}{owner}", abi::WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX),
            ExportKind::Table,
            index,
        )?;
        let import = imports.get(&source_index).copied();
        if import
            == Some((
                abi::WPK_FORK_MODULE_STATE_IMPORT_MODULE,
                abi::WPK_FORK_RESUME_IMPORT_TABLE,
            ))
        {
            continue;
        }
        let original = scan.types.as_ref().table_at(source_index);
        let ValType::Ref(ty) =
            types.value_type(runtime, wasmparser::ValType::Ref(original.element_type))?
        else {
            unreachable!()
        };
        let class = kinds.class(ty)?;
        if let Some((module, name)) = import {
            append_import(
                &mut descriptor,
                owner,
                class,
                original.table64,
                module,
                name,
                limits.metadata_bytes,
            )?;
            imported_count += 1;
        }
        if import.is_none()
            && !mutated.contains(&source_index)
            && !(dynamic_linker && indirect.contains(&source_index))
        {
            continue;
        }
        // A fingerprint is an opaque, guest-checked binding to this exact
        // artifact's baseline. It is not a cross-backend serialization of IR.
        let mut hash = Sha256::new();
        hash.update(b"kandelo-native-table-baseline-v1\0");
        hash.update(source);
        hash.update(owner.to_le_bytes());
        let last_page = module.global(
            GlobalType {
                val_type: ValType::I64,
                mutable: true,
                shared: false,
            },
            ConstExpr::i64_const(-1),
        )?;
        tables.push(Table {
            source: source_index,
            index,
            owner,
            wide: original.table64,
            ty,
            class,
            baseline_len: original.initial,
            fingerprint: hash.finalize().into(),
            last_page,
        });
    }
    descriptor[8..12].copy_from_slice(&imported_count.to_le_bytes());
    Ok((tables, descriptor))
}
#[allow(clippy::too_many_arguments)]
fn append_import(
    bytes: &mut Vec<u8>,
    owner: u32,
    class: NativeReferenceClass,
    wide: bool,
    module: &str,
    name: &str,
    limit: usize,
) -> Result<()> {
    let length = usize::from(abi::WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE)
        .checked_add(module.len())
        .and_then(|n| n.checked_add(name.len()))
        .context("table descriptor size overflow")?;
    ensure!(
        bytes.len().checked_add(length).is_some_and(|n| n <= limit),
        "table descriptor exceeds metadata budget"
    );
    bytes.extend_from_slice(&u32::try_from(length)?.to_le_bytes());
    bytes.extend_from_slice(&owner.to_le_bytes());
    bytes.push(match class {
        NativeReferenceClass::Func => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
        NativeReferenceClass::Extern => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
        NativeReferenceClass::Any => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
        NativeReferenceClass::Exn => abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
    });
    bytes.push(if wide {
        abi::WPK_FORK_IMPORTED_TABLE_FLAG_TABLE64
    } else {
        0
    });
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&u32::try_from(module.len())?.to_le_bytes());
    bytes.extend_from_slice(&u32::try_from(name.len())?.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(module.as_bytes());
    bytes.extend_from_slice(name.as_bytes());
    Ok(())
}

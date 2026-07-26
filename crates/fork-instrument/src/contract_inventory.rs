//! Structural inventory for the fork-artifact publication guards.
//!
//! This deliberately inspects only the sections that define the artifact
//! contract. In particular, code bodies are not decoded: large package
//! executables should not need a text disassembly just to verify their imports,
//! exports, memories, and metadata.

use anyhow::{Context, Result, bail};
use std::fmt::{self, Write};
use wasm_posix_shared::abi::{
    WPK_FORK_CAPABILITIES_SECTION, WPK_FORK_EXPORT_ABORT_BEGIN, WPK_FORK_EXPORT_ABORT_END,
    WPK_FORK_EXPORT_REWIND_BEGIN, WPK_FORK_EXPORT_REWIND_END, WPK_FORK_EXPORT_STATE,
    WPK_FORK_EXPORT_UNWIND_BEGIN, WPK_FORK_EXPORT_UNWIND_END, WPK_FORK_FRAME_IMPORT_COMMIT,
    WPK_FORK_FRAME_IMPORT_MODULE, WPK_FORK_FRAME_IMPORT_NEXT, WPK_FORK_FRAME_IMPORT_RESERVE,
    WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
};
use wasmparser::{
    CompositeInnerType, Encoding, ExternalKind, FuncType, Parser, Payload, TypeRef, ValType,
};

/// The exact tab-separated inventory consumed by `wasm-artifact-guards.sh`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ForkContractInventory {
    pub relocatable: usize,
    pub imports_kernel_fork: usize,
    pub frame_reserve: usize,
    pub frame_commit: usize,
    pub frame_next: usize,
    pub linked_descriptor: usize,
    pub fork_capability: usize,
    pub abort_begin: usize,
    pub abort_end: usize,
    pub rewind_begin: usize,
    pub rewind_end: usize,
    pub state: usize,
    pub unwind_begin: usize,
    pub unwind_end: usize,
    pub memory_count: usize,
    pub memory64_count: usize,
    pub signature_mismatch: usize,
    pub legacy_dlopen: usize,
    pub native_start: usize,
}

impl fmt::Display for ForkContractInventory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            self.relocatable,
            self.imports_kernel_fork,
            self.frame_reserve,
            self.frame_commit,
            self.frame_next,
            self.linked_descriptor,
            self.fork_capability,
            self.abort_begin,
            self.abort_end,
            self.rewind_begin,
            self.rewind_end,
            self.state,
            self.unwind_begin,
            self.unwind_end,
            self.memory_count,
            self.memory64_count,
            self.signature_mismatch,
            self.legacy_dlopen,
            self.native_start,
        )
    }
}

#[derive(Debug, Clone, Copy)]
enum ExpectedSignature {
    PointerToPointer,
    PointerToNil,
    NilToNil,
    NilToI32,
}

/// Inspect the binary structure used to decide whether a module carries one
/// complete fork-instrumentation contract.
pub fn fork_contract_inventory(bytes: &[u8]) -> Result<ForkContractInventory> {
    let mut inventory = ForkContractInventory::default();
    let mut types: Vec<Option<FuncType>> = Vec::new();
    let mut function_type_indices: Vec<u32> = Vec::new();
    let mut checked_functions: Vec<(u32, ExpectedSignature)> = Vec::new();

    for payload in Parser::new(0).parse_all(bytes) {
        match payload.context("parsing wasm structure for fork-contract inventory")? {
            Payload::Version { encoding, .. } => {
                if encoding != Encoding::Module {
                    bail!("fork-contract inventory requires a core wasm module");
                }
            }
            Payload::TypeSection(groups) => {
                for group in groups {
                    let group = group.context("parsing wasm type section")?;
                    types.extend(group.into_types().map(
                        |subtype| match subtype.composite_type.inner {
                            CompositeInnerType::Func(function) => Some(function),
                            CompositeInnerType::Array(_)
                            | CompositeInnerType::Struct(_)
                            | CompositeInnerType::Cont(_) => None,
                        },
                    ));
                }
            }
            Payload::ImportSection(imports) => {
                for import in imports.into_imports() {
                    let import = import.context("parsing wasm import section")?;
                    match import.ty {
                        TypeRef::Func(type_index) | TypeRef::FuncExact(type_index) => {
                            let function_index = function_type_indices.len() as u32;
                            function_type_indices.push(type_index);
                            if import.module == "kernel" && import.name == "kernel_fork" {
                                inventory.imports_kernel_fork = 1;
                            }
                            if import.module == "env" && import.name == "__wasm_dlopen" {
                                inventory.legacy_dlopen += 1;
                            }
                            if import.module == WPK_FORK_FRAME_IMPORT_MODULE {
                                let expected = match import.name {
                                    WPK_FORK_FRAME_IMPORT_RESERVE => {
                                        inventory.frame_reserve += 1;
                                        Some(ExpectedSignature::PointerToPointer)
                                    }
                                    WPK_FORK_FRAME_IMPORT_COMMIT => {
                                        inventory.frame_commit += 1;
                                        Some(ExpectedSignature::PointerToNil)
                                    }
                                    WPK_FORK_FRAME_IMPORT_NEXT => {
                                        inventory.frame_next += 1;
                                        Some(ExpectedSignature::PointerToPointer)
                                    }
                                    _ => None,
                                };
                                if let Some(expected) = expected {
                                    checked_functions.push((function_index, expected));
                                }
                            }
                        }
                        TypeRef::Memory(memory) => {
                            inventory.memory_count += 1;
                            inventory.memory64_count += usize::from(memory.memory64);
                        }
                        TypeRef::Table(_) | TypeRef::Global(_) | TypeRef::Tag(_) => {}
                    }
                }
            }
            Payload::FunctionSection(functions) => {
                for type_index in functions {
                    function_type_indices
                        .push(type_index.context("parsing wasm function section")?);
                }
            }
            Payload::MemorySection(memories) => {
                for memory in memories {
                    let memory = memory.context("parsing wasm memory section")?;
                    inventory.memory_count += 1;
                    inventory.memory64_count += usize::from(memory.memory64);
                }
            }
            Payload::StartSection { .. } => {
                inventory.native_start += 1;
            }
            Payload::ExportSection(exports) => {
                for export in exports {
                    let export = export.context("parsing wasm export section")?;
                    if export.kind != ExternalKind::Func {
                        continue;
                    }
                    let expected = match export.name {
                        WPK_FORK_EXPORT_ABORT_BEGIN => {
                            inventory.abort_begin += 1;
                            Some(ExpectedSignature::PointerToNil)
                        }
                        WPK_FORK_EXPORT_ABORT_END => {
                            inventory.abort_end += 1;
                            Some(ExpectedSignature::NilToNil)
                        }
                        WPK_FORK_EXPORT_REWIND_BEGIN => {
                            inventory.rewind_begin += 1;
                            Some(ExpectedSignature::PointerToNil)
                        }
                        WPK_FORK_EXPORT_REWIND_END => {
                            inventory.rewind_end += 1;
                            Some(ExpectedSignature::NilToNil)
                        }
                        WPK_FORK_EXPORT_STATE => {
                            inventory.state += 1;
                            Some(ExpectedSignature::NilToI32)
                        }
                        WPK_FORK_EXPORT_UNWIND_BEGIN => {
                            inventory.unwind_begin += 1;
                            Some(ExpectedSignature::PointerToNil)
                        }
                        WPK_FORK_EXPORT_UNWIND_END => {
                            inventory.unwind_end += 1;
                            Some(ExpectedSignature::NilToNil)
                        }
                        _ => None,
                    };
                    if let Some(expected) = expected {
                        checked_functions.push((export.index, expected));
                    }
                }
            }
            Payload::CustomSection(section) => match section.name() {
                "linking" => inventory.relocatable = 1,
                name if name.starts_with("reloc.") => inventory.relocatable = 1,
                WPK_FORK_LINKED_FRAME_FORMAT_SECTION => inventory.linked_descriptor += 1,
                WPK_FORK_CAPABILITIES_SECTION => inventory.fork_capability += 1,
                _ => {}
            },
            _ => {}
        }
    }

    let pointer = if inventory.memory_count == 1 && inventory.memory64_count == 1 {
        ValType::I64
    } else {
        ValType::I32
    };
    for (function_index, expected) in checked_functions {
        let signature = function_type_indices
            .get(function_index as usize)
            .and_then(|type_index| types.get(*type_index as usize))
            .and_then(Option::as_ref);
        if !signature.is_some_and(|signature| signature_matches(signature, expected, pointer)) {
            inventory.signature_mismatch += 1;
        }
    }

    Ok(inventory)
}

/// Return the raw custom-section payload used by `wasm-objdump -s -j`,
/// including the encoded section name before its data.
pub fn fork_capability_section_hex(bytes: &[u8]) -> Result<String> {
    unique_custom_section_hex(bytes, WPK_FORK_CAPABILITIES_SECTION)
}

/// Return the raw custom-section payload used by `wasm-objdump -s -j`,
/// including the encoded section name before its data.
pub fn linked_frame_descriptor_section_hex(bytes: &[u8]) -> Result<String> {
    unique_custom_section_hex(bytes, WPK_FORK_LINKED_FRAME_FORMAT_SECTION)
}

fn unique_custom_section_hex(bytes: &[u8], expected_name: &str) -> Result<String> {
    let mut found = None;
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.context("parsing wasm structure for custom-section inventory")? {
            Payload::Version { encoding, .. } => {
                if encoding != Encoding::Module {
                    bail!("custom-section inventory requires a core wasm module");
                }
            }
            Payload::CustomSection(section) if section.name() == expected_name => {
                if found.is_some() {
                    bail!("found duplicate `{expected_name}` custom sections");
                }
                found = Some(section.range());
            }
            _ => {}
        }
    }

    let range = found.with_context(|| format!("missing `{expected_name}` custom section"))?;
    let section = bytes
        .get(range)
        .context("custom-section range falls outside the wasm binary")?;
    let mut hex = String::with_capacity(section.len() * 2);
    for byte in section {
        write!(&mut hex, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(hex)
}

fn signature_matches(signature: &FuncType, expected: ExpectedSignature, pointer: ValType) -> bool {
    let (params, results): (&[ValType], &[ValType]) = match expected {
        ExpectedSignature::PointerToPointer => (
            std::slice::from_ref(&pointer),
            std::slice::from_ref(&pointer),
        ),
        ExpectedSignature::PointerToNil => (std::slice::from_ref(&pointer), &[]),
        ExpectedSignature::NilToNil => (&[], &[]),
        ExpectedSignature::NilToI32 => (&[], std::slice::from_ref(&ValType::I32)),
    };
    signature.params() == params && signature.results() == results
}

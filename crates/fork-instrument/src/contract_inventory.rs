//! Structural inventory for the fork-artifact publication guards.
//!
//! The fork-contract inventory inspects only sections. Artifact identity also
//! verifies the exact constant ABI thunk, but decodes only that function and
//! its optional delegate: large package executables should not need a full text
//! disassembly or full-module instruction decode for publication checks.

use anyhow::{Context, Result, bail};
use std::fmt::{self, Write};
use wasm_posix_shared::abi::{
    ABI_KERNEL_EXPORT, WPK_FORK_CAPABILITIES_SECTION, WPK_FORK_EXPORT_ABORT_BEGIN,
    WPK_FORK_EXPORT_ABORT_END, WPK_FORK_EXPORT_REWIND_BEGIN, WPK_FORK_EXPORT_REWIND_END,
    WPK_FORK_EXPORT_STATE, WPK_FORK_EXPORT_UNWIND_BEGIN, WPK_FORK_EXPORT_UNWIND_END,
    WPK_FORK_FRAME_IMPORT_COMMIT, WPK_FORK_FRAME_IMPORT_MODULE, WPK_FORK_FRAME_IMPORT_NEXT,
    WPK_FORK_FRAME_IMPORT_RESERVE, WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
};
use wasmparser::{
    CompositeInnerType, Encoding, ExternalKind, FuncType, FunctionBody, Operator, Parser, Payload,
    TypeRef, ValType,
};

/// One import from Kandelo's libc/host-reserved `env.__wasm_posix_*`
/// namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReservedEnvImport {
    pub kind: &'static str,
    pub identity: String,
}

/// The exact tab-separated inventory consumed by `wasm-artifact-guards.sh`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ForkContractInventory {
    pub relocatable: usize,
    pub imports_fork_entry: usize,
    pub imports_kernel_fork: usize,
    pub imports_side_fork: usize,
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
            self.imports_fork_entry,
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

/// Strict status of the optional `__abi_version` artifact export.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactAbiVersion {
    Missing,
    Invalid,
    Present(u32),
}

/// Structural identity needed by executable and side-module publication guards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArtifactIdentity {
    pub relocatable: usize,
    pub memory_count: usize,
    pub memory64_count: usize,
    pub abi_version: ArtifactAbiVersion,
    pub imports_kernel_fork: usize,
    pub imports_side_fork: usize,
    pub has_fork_exports: usize,
    pub dylink_section_count: usize,
    pub dylink_is_first_section: usize,
    pub env_memory_count: usize,
    pub unsupported_side_import_count: usize,
}

impl fmt::Display for ArtifactIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (status, version) = match self.abi_version {
            ArtifactAbiVersion::Missing => ("missing", "-".to_string()),
            ArtifactAbiVersion::Invalid => ("invalid", "-".to_string()),
            ArtifactAbiVersion::Present(version) => ("present", version.to_string()),
        };
        write!(
            f,
            "{}\t{}\t{}\t{status}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            self.relocatable,
            self.memory_count,
            self.memory64_count,
            version,
            self.imports_kernel_fork,
            self.imports_side_fork,
            self.has_fork_exports,
            self.dylink_section_count,
            self.dylink_is_first_section,
            self.env_memory_count,
            self.unsupported_side_import_count,
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
                            if (import.module == "kernel" && import.name == "kernel_fork")
                                || (import.module == "env" && import.name == "fork")
                            {
                                // WHY: this inventory feeds the common
                                // executable/side-module publication guard.
                                // Both imports seed the same linked-frame
                                // contract, despite belonging to different
                                // loader roles.
                                inventory.imports_fork_entry = 1;
                            }
                            if import.module == "kernel" && import.name == "kernel_fork" {
                                inventory.imports_kernel_fork += 1;
                            }
                            if import.module == "env" && import.name == "fork" {
                                inventory.imports_side_fork += 1;
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

/// Inspect the object kind, memory width, and strict constant ABI export in
/// one wasmparser-backed CLI request.
///
/// WHY: ABI 43's generated reference/exception helpers use proposal features
/// that older WABT releases cannot disassemble. Publication must not confuse a
/// text-decoder limitation with an unsafe artifact, and it must not weaken the
/// exact constant-return ABI contract to work around that limitation.
pub fn artifact_identity(bytes: &[u8]) -> Result<ArtifactIdentity> {
    let contract = fork_contract_inventory(bytes)?;
    let loader = artifact_loader_identity(bytes)?;
    let has_fork_exports = usize::from(
        contract.abort_begin
            + contract.abort_end
            + contract.rewind_begin
            + contract.rewind_end
            + contract.state
            + contract.unwind_begin
            + contract.unwind_end
            != 0,
    );
    Ok(ArtifactIdentity {
        relocatable: contract.relocatable,
        memory_count: contract.memory_count,
        memory64_count: contract.memory64_count,
        abi_version: artifact_abi_version(bytes)?,
        imports_kernel_fork: contract.imports_kernel_fork,
        imports_side_fork: contract.imports_side_fork,
        has_fork_exports,
        dylink_section_count: loader.dylink_section_count,
        dylink_is_first_section: loader.dylink_is_first_section,
        env_memory_count: loader.env_memory_count,
        unsupported_side_import_count: loader.unsupported_side_import_count,
    })
}

/// Inventory imports from Kandelo's reserved libc/host namespace without
/// decoding function bodies.
///
/// WHY: compiler-generated ABI 43 reference types are newer than the WABT
/// decoder available on package builders. Publication still has to reject a
/// private libc helper that escaped as an import, so the same wasmparser
/// boundary used for artifact identity owns this structural check as well.
pub fn reserved_env_imports(bytes: &[u8]) -> Result<Vec<ReservedEnvImport>> {
    let mut reserved = Vec::new();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.context("parsing wasm structure for reserved import inventory")? {
            Payload::Version { encoding, .. } => {
                if encoding != Encoding::Module {
                    bail!("reserved import inventory requires a core wasm module");
                }
            }
            Payload::ImportSection(imports) => {
                for import in imports.into_imports() {
                    let import = import.context("parsing reserved import section")?;
                    if import.module != "env" || !import.name.starts_with("__wasm_posix_") {
                        continue;
                    }
                    if import.name.bytes().any(|byte| matches!(byte, b'\t' | b'\n' | b'\r')) {
                        bail!("reserved import name contains a control separator");
                    }
                    let kind = match import.ty {
                        TypeRef::Func(_) | TypeRef::FuncExact(_) => "func",
                        TypeRef::Table(_) => "table",
                        TypeRef::Memory(_) => "memory",
                        TypeRef::Global(_) => "global",
                        TypeRef::Tag(_) => "tag",
                    };
                    reserved.push(ReservedEnvImport {
                        kind,
                        identity: format!("{}.{}", import.module, import.name),
                    });
                }
            }
            _ => {}
        }
    }
    Ok(reserved)
}

#[derive(Debug, Default, Clone, Copy)]
struct ArtifactLoaderIdentity {
    dylink_section_count: usize,
    dylink_is_first_section: usize,
    env_memory_count: usize,
    unsupported_side_import_count: usize,
}

fn artifact_loader_identity(bytes: &[u8]) -> Result<ArtifactLoaderIdentity> {
    let mut identity = ArtifactLoaderIdentity::default();
    let mut section_count = 0usize;

    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload.context("parsing wasm structure for artifact loader identity")?;
        if payload.as_section().is_some() {
            section_count += 1;
        }
        match payload {
            Payload::Version { encoding, .. } => {
                if encoding != Encoding::Module {
                    bail!("artifact loader identity requires a core wasm module");
                }
            }
            Payload::ImportSection(imports) => {
                for import in imports.into_imports() {
                    let import = import.context("parsing artifact loader import section")?;
                    if matches!(import.ty, TypeRef::Memory(_))
                        && import.module == "env"
                        && import.name == "memory"
                    {
                        identity.env_memory_count += 1;
                    }
                    if !matches!(import.module, "env" | "GOT.mem" | "GOT.func") {
                        identity.unsupported_side_import_count += 1;
                    }
                }
            }
            Payload::CustomSection(section) if section.name() == "dylink.0" => {
                identity.dylink_section_count += 1;
                if section_count == 1 {
                    identity.dylink_is_first_section = 1;
                }
            }
            _ => {}
        }
    }

    Ok(identity)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AbiOperator {
    I32Const(i32),
    Call(u32),
    Return,
    End,
}

#[derive(Debug, Clone, Copy)]
struct AbiBody {
    operators: [Option<AbiOperator>; 3],
    operator_count: usize,
    exact: bool,
}

impl AbiBody {
    fn pure_constant(self) -> Option<u32> {
        let value = match (self.exact, self.operator_count, self.operators) {
            (
                true,
                2,
                [Some(AbiOperator::I32Const(value)), Some(AbiOperator::End), None],
            )
            | (
                true,
                3,
                [
                    Some(AbiOperator::I32Const(value)),
                    Some(AbiOperator::Return),
                    Some(AbiOperator::End),
                ],
            ) => value,
            _ => return None,
        };
        u32::try_from(value).ok()
    }
}

fn parse_abi_body(body: FunctionBody<'_>) -> Result<AbiBody> {
    for local in body
        .get_locals_reader()
        .context("reading ABI candidate locals")?
    {
        local.context("reading ABI candidate local")?;
    }

    let mut operators = [None; 3];
    let mut operator_count = 0usize;
    let mut exact = true;
    let mut reader = body
        .get_operators_reader()
        .context("reading ABI candidate operators")?;
    while !reader.eof() {
        let operator = match reader
            .read()
            .context("decoding ABI candidate operator")?
        {
            Operator::I32Const { value } => Some(AbiOperator::I32Const(value)),
            Operator::Call { function_index } => Some(AbiOperator::Call(function_index)),
            Operator::Return => Some(AbiOperator::Return),
            Operator::End => Some(AbiOperator::End),
            _ => None,
        };
        if operator_count < operators.len() {
            operators[operator_count] = operator;
        } else {
            exact = false;
        }
        exact &= operator.is_some();
        operator_count += 1;
    }
    Ok(AbiBody {
        operators,
        operator_count,
        exact,
    })
}

fn function_signature<'a>(
    types: &'a [Option<FuncType>],
    function_type_indices: &[u32],
    function_index: u32,
) -> Option<&'a FuncType> {
    function_type_indices
        .get(function_index as usize)
        .and_then(|type_index| types.get(*type_index as usize))
        .and_then(Option::as_ref)
}

fn signature_is(signature: Option<&FuncType>, params: &[ValType], results: &[ValType]) -> bool {
    signature.is_some_and(|signature| {
        signature.params() == params && signature.results() == results
    })
}

fn body_for(
    bytes: &[u8],
    imported_function_count: usize,
    function_index: u32,
) -> Result<Option<AbiBody>> {
    let Some(local_index) = (function_index as usize).checked_sub(imported_function_count) else {
        return Ok(None);
    };
    let mut current_local_index = 0usize;
    for payload in Parser::new(0).parse_all(bytes) {
        if let Payload::CodeSectionEntry(body) =
            payload.context("parsing wasm structure for ABI candidate")?
        {
            if current_local_index == local_index {
                return parse_abi_body(body).map(Some);
            }
            current_local_index += 1;
        }
    }
    Ok(None)
}

fn artifact_abi_version(bytes: &[u8]) -> Result<ArtifactAbiVersion> {
    let mut types: Vec<Option<FuncType>> = Vec::new();
    let mut function_type_indices = Vec::new();
    let mut imported_function_count = 0usize;
    let mut code_body_count = None;
    let mut abi_export_count = 0usize;
    let mut abi_function = None;

    for payload in Parser::new(0).parse_all(bytes) {
        match payload.context("parsing wasm structure for artifact identity")? {
            Payload::Version { encoding, .. } => {
                if encoding != Encoding::Module {
                    bail!("artifact identity requires a core wasm module");
                }
            }
            Payload::TypeSection(groups) => {
                for group in groups {
                    let group = group.context("parsing artifact type section")?;
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
                    let import = import.context("parsing artifact import section")?;
                    if let TypeRef::Func(type_index) | TypeRef::FuncExact(type_index) = import.ty {
                        function_type_indices.push(type_index);
                        imported_function_count += 1;
                    }
                }
            }
            Payload::FunctionSection(functions) => {
                for type_index in functions {
                    function_type_indices
                        .push(type_index.context("parsing artifact function section")?);
                }
            }
            Payload::ExportSection(exports) => {
                for export in exports {
                    let export = export.context("parsing artifact export section")?;
                    if export.name != ABI_KERNEL_EXPORT {
                        continue;
                    }
                    abi_export_count += 1;
                    if export.kind == ExternalKind::Func {
                        abi_function = Some(export.index);
                    }
                }
            }
            Payload::CodeSectionStart { count, .. } => {
                if code_body_count.replace(count as usize).is_some() {
                    return Ok(ArtifactAbiVersion::Invalid);
                }
            }
            _ => {}
        }
    }

    if abi_export_count == 0 {
        return Ok(ArtifactAbiVersion::Missing);
    }
    if abi_export_count != 1 {
        return Ok(ArtifactAbiVersion::Invalid);
    }
    let Some(target) = abi_function else {
        return Ok(ArtifactAbiVersion::Invalid);
    };
    if code_body_count.unwrap_or(0) + imported_function_count != function_type_indices.len()
        || !signature_is(
            function_signature(&types, &function_type_indices, target),
            &[],
            &[ValType::I32],
        )
    {
        return Ok(ArtifactAbiVersion::Invalid);
    }

    // WHY: publication checks run over very large package executables. The
    // export and signatures are known before the code section, so decode only
    // the ABI thunk rather than every unrelated compiler-generated body.
    let Some(target_body) = body_for(bytes, imported_function_count, target)? else {
        return Ok(ArtifactAbiVersion::Invalid);
    };
    if let Some(version) = target_body.pure_constant() {
        return Ok(ArtifactAbiVersion::Present(version));
    }

    match (
        target_body.exact,
        target_body.operator_count,
        target_body.operators,
    ) {
        (
            true,
            3,
            [
                Some(AbiOperator::Call(leading)),
                Some(AbiOperator::I32Const(version)),
                Some(AbiOperator::End),
            ],
        ) if signature_is(
            function_signature(&types, &function_type_indices, leading),
            &[],
            &[],
        ) => Ok(u32::try_from(version)
            .map(ArtifactAbiVersion::Present)
            .unwrap_or(ArtifactAbiVersion::Invalid)),
        (
            true,
            3,
            [
                Some(AbiOperator::Call(leading)),
                Some(AbiOperator::Call(delegate)),
                Some(AbiOperator::End),
            ],
        ) if signature_is(
            function_signature(&types, &function_type_indices, leading),
            &[],
            &[],
        ) && signature_is(
            function_signature(&types, &function_type_indices, delegate),
            &[],
            &[ValType::I32],
        ) => Ok(body_for(bytes, imported_function_count, delegate)?
            .and_then(AbiBody::pure_constant)
            .map(ArtifactAbiVersion::Present)
            .unwrap_or(ArtifactAbiVersion::Invalid)),
        _ => Ok(ArtifactAbiVersion::Invalid),
    }
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

//! The fork-artifact contract: what a fork-instrumented program must look like
//! for this ABI epoch's capture/replay machinery to be able to drive it.
//!
//! # The shape of the contract
//!
//! Fork instrumentation is a whole-module transform. It adds exports, adds
//! imports, rewrites the start section into an explicit bootstrap, and emits
//! eight descriptor custom sections that tell the runtime how to save and
//! restore state the wasm binary cannot describe by itself. Every one of those
//! pieces refers to the others: a descriptor record names an import *ordinal*,
//! a catalog export names a *table index*, and a required import's signature is
//! `i32` or `i64` depending on the module's own memory.
//!
//! That is why the contract is checked as one statement over a single set of
//! facts rather than as a list of independent questions. A partially
//! instrumented artifact — one produced by an interrupted transform, or by
//! copying metadata between binaries — typically satisfies most of the
//! individual questions and fails the joins. The joins are the point.
//!
//! # Division of labour
//!
//! Every descriptor's *byte format* is decoded by the module in `fork-codec`
//! that owns it, so this file contains no second decoder for any of them. What
//! lives here is the half a descriptor decoder structurally cannot do: relate
//! its records back to the module's imports, exports, tables and memories.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use fork_codec::{
    decode_exception_codec, decode_imported_globals, decode_imported_tables,
    decode_static_root_catalog, LinkedFrameFormat, ModuleStateFormat,
};
use wasm_posix_shared::abi;
use wasmparser::ExternalKind;

use crate::facts::{describe_required_signature, ArtifactFacts, ValueType};

/// Validate the complete fork-artifact contract, returning one string per
/// failure. An empty vector means the artifact satisfies the contract.
///
/// The `epoch` is the ABI version being validated against. It is threaded in
/// rather than read from a constant so a failure message names the epoch whose
/// contract the artifact was actually measured against; a hardcoded number
/// keeps naming the old epoch after a bump, telling whoever reads the failure
/// that a stale artifact belongs to a version nobody is running.
pub fn describe_fork_contract_failures(facts: &ArtifactFacts, epoch: u32) -> Vec<String> {
    let mut failures = Vec::new();
    let pointer_width = facts.pointer_width();

    check_start_section(facts, epoch, &mut failures);
    check_reentrant_dlopen(facts, epoch, &mut failures);
    check_capabilities(facts, &mut failures);
    check_exception_codec(facts, &mut failures);
    check_imported_globals(facts, &mut failures);
    check_imported_tables(facts, &mut failures);
    check_activation_import(facts, &mut failures);
    check_required_table_imports(facts, epoch, &mut failures);
    check_static_root_catalog(facts, &mut failures);
    check_required_exports(facts, epoch, pointer_width, &mut failures);
    check_process_fork_import(facts, epoch, &mut failures);

    let declared_pointer_width = check_linked_frames(facts, &mut failures);
    check_module_state(facts, declared_pointer_width, &mut failures);
    check_memory_agreement(facts, declared_pointer_width, &mut failures);
    check_frame_imports_and_unwind(facts, epoch, pointer_width, &mut failures);

    failures
}

/// A retained native `start` section means initialization is still owned by the
/// engine rather than by `wpk_fork_module_bootstrap`.
///
/// WHY it matters: staged `dlopen` may instantiate this module while a loader
/// import is active. Deferring the source start function to an explicit
/// bootstrap is what stops guest wasm from reentering that import.
fn check_start_section(facts: &ArtifactFacts, epoch: u32, failures: &mut Vec<String>) {
    if facts.native_start_count != 0 {
        failures.push(format!(
            "ABI {epoch} fork artifact retains {} native Wasm start section{}; \
             rebuild and reinstrument it so initialization is owned by {}",
            facts.native_start_count,
            if facts.native_start_count == 1 { "" } else { "s" },
            abi::WPK_FORK_EXPORT_MODULE_BOOTSTRAP,
        ));
    }
}

/// `env.__wasm_dlopen` can synchronously enter side-module wasm before
/// returning. Instrumentation lowers every valid occurrence to the staged
/// prepare/next/commit protocol, so a surviving import proves the transform did
/// not complete — or that its metadata was copied from a module that did.
fn check_reentrant_dlopen(facts: &ArtifactFacts, epoch: u32, failures: &mut Vec<String>) {
    if facts.function_imports.contains_key("env.__wasm_dlopen") {
        failures.push(format!(
            "ABI {epoch} fork artifact retains reentrant env.__wasm_dlopen; \
             rebuild and reinstrument it with the staged loader lowering"
        ));
    }
}

fn check_capabilities(facts: &ArtifactFacts, failures: &mut Vec<String>) {
    let section = abi::WPK_FORK_CAPABILITIES_SECTION;
    let sections = &facts.fork_capabilities;
    if sections.is_empty() {
        failures.push(format!("missing required {section} capability"));
        return;
    }
    if sections.len() != 1 {
        failures.push(format!(
            "has {} {section} sections, expected exactly one",
            sections.len()
        ));
        return;
    }
    let capability = &sections[0];
    if capability.len() != 2 {
        failures.push(format!(
            "{section} has {} bytes, expected 2",
            capability.len()
        ));
        return;
    }
    if capability[0] != abi::WPK_FORK_CAPABILITIES_VERSION {
        failures.push(format!(
            "{section} version {} is unsupported",
            capability[0]
        ));
        return;
    }
    let flags = capability[1];
    if flags & !abi::WPK_FORK_CAP_KNOWN_MASK != 0 {
        failures.push(format!("{section} has unknown flags 0x{flags:x}"));
        return;
    }
    if flags & abi::WPK_FORK_CAP_REQUIRED_FLAGS != abi::WPK_FORK_CAP_REQUIRED_FLAGS {
        failures.push(format!(
            "{section} flags 0x{flags:x} omit required activation-state safety flags 0x{:x}",
            abi::WPK_FORK_CAP_REQUIRED_FLAGS
        ));
    }
}

/// Require exactly one descriptor of a family, returning its payload.
fn exactly_one<'a>(
    descriptors: &'a [Vec<u8>],
    section: &str,
    failures: &mut Vec<String>,
) -> Option<&'a [u8]> {
    match descriptors.len() {
        0 => {
            failures.push(format!("missing required {section} descriptor"));
            None
        }
        1 => Some(&descriptors[0]),
        n => {
            failures.push(format!(
                "has {n} {section} descriptors, expected exactly one"
            ));
            None
        }
    }
}

/// Returns the pointer width the linked-frame descriptor declares, which the
/// module-state descriptor and the module's memories must agree with.
fn check_linked_frames(facts: &ArtifactFacts, failures: &mut Vec<String>) -> Option<u8> {
    let section = abi::WPK_FORK_LINKED_FRAME_FORMAT_SECTION;
    let descriptor = exactly_one(&facts.linked_frame_descriptors, section, failures)?;
    match LinkedFrameFormat::parse_descriptor(descriptor) {
        Ok(format) => Some(format.pointer_width),
        Err(errno) => {
            failures.push(format!(
                "{section} descriptor is malformed (errno {})",
                errno as i32
            ));
            None
        }
    }
}

fn check_module_state(
    facts: &ArtifactFacts,
    expected_pointer_width: Option<u8>,
    failures: &mut Vec<String>,
) {
    let section = abi::WPK_FORK_MODULE_STATE_FORMAT_SECTION;
    let Some(descriptor) = exactly_one(&facts.module_state_descriptors, section, failures) else {
        return;
    };
    match ModuleStateFormat::parse_descriptor(descriptor) {
        Ok(format) => {
            if let Some(expected) = expected_pointer_width {
                if format.pointer_width != expected {
                    failures.push(format!(
                        "{section} declares pointer width {} but {} declares {expected}",
                        format.pointer_width,
                        abi::WPK_FORK_LINKED_FRAME_FORMAT_SECTION
                    ));
                }
            }
        }
        Err(errno) => failures.push(format!(
            "{section} descriptor is malformed (errno {})",
            errno as i32
        )),
    }
}

/// The descriptors declare a pointer width; the module's memories decide it.
/// A disagreement means the instrumentation was produced for a different data
/// model than the binary it is attached to, which traps on the first frame.
fn check_memory_agreement(
    facts: &ArtifactFacts,
    declared_pointer_width: Option<u8>,
    failures: &mut Vec<String>,
) {
    if facts.has_mixed_memory_widths() {
        failures.push(String::from(
            "fork artifact declares memories of differing pointer widths",
        ));
        return;
    }
    let Some(declared) = declared_pointer_width else {
        return;
    };
    if facts.memory_pointer_widths.is_empty() {
        return;
    }
    let actual = facts.pointer_width();
    if actual != declared {
        failures.push(format!(
            "fork artifact descriptors declare pointer width {declared} but its memory is wasm{}",
            if actual == 8 { "64" } else { "32" }
        ));
    }
}

fn check_exception_codec(facts: &ArtifactFacts, failures: &mut Vec<String>) {
    let section = abi::WPK_FORK_EXCEPTION_CODEC_SECTION;
    let Some(descriptor) = exactly_one(&facts.exception_codec_descriptors, section, failures) else {
        return;
    };
    if let Err(errno) = decode_exception_codec(descriptor) {
        failures.push(format!(
            "{section} descriptor is malformed (errno {})",
            errno as i32
        ));
    }
}

/// Which imported globals the instrumentation is expected to carry a recipe
/// for.
///
/// The exclusions are control addresses each host worker reconstructs from the
/// ABI-defined process channel layout. They are not guest module state, so
/// serializing them as recipes would make a child restore a parent's control
/// region.
fn imported_global_needs_recipe(module: &str, name: &str) -> bool {
    !(module == abi::WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE
        && (name == abi::WPK_FORK_EXCEPTION_IMPORT_ACTIVATION
            || name == "__channel_base"
            || name == "__wpk_fork_module_state_table_generation_addr"))
}

fn imported_table_needs_recipe(module: &str, name: &str) -> bool {
    !abi::WPK_FORK_REQUIRED_TABLE_IMPORTS
        .iter()
        .any(|r| r.module == module && r.name == name)
}

/// A reserved catalog-export suffix must be a canonical decimal owner id: no
/// leading zero, no sign, no padding, and inside `u32`.
///
/// WHY canonical: the suffix is the join key between a descriptor record and an
/// export. If `_01` and `_1` both parsed, two records could claim one export.
fn parse_owner_suffix(suffix: &str) -> Option<u32> {
    if suffix.is_empty() || suffix.starts_with('0') {
        return None;
    }
    if !suffix.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    suffix.parse::<u32>().ok()
}

fn check_imported_globals(facts: &ArtifactFacts, failures: &mut Vec<String>) {
    let section = abi::WPK_FORK_IMPORTED_GLOBALS_SECTION;
    let Some(descriptor) = exactly_one(&facts.imported_globals_descriptors, section, failures)
    else {
        return;
    };
    let decoded = match decode_imported_globals(descriptor) {
        Ok(decoded) => decoded,
        Err(errno) => {
            failures.push(format!(
                "{section} descriptor is malformed (errno {})",
                errno as i32
            ));
            return;
        }
    };

    let imports: Vec<_> = facts.global_imports.values().flatten().collect();
    let mut matched: Vec<u32> = Vec::new();

    for record in &decoded.globals {
        let catalog_name = format!(
            "{}{}",
            abi::WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
            record.owner_id
        );
        let catalog = facts.exports.get(&catalog_name);
        let Some(entry) = catalog
            .filter(|entries| entries.len() == 1)
            .map(|entries| entries[0])
            .filter(|entry| entry.kind == ExternalKind::Global)
        else {
            failures.push(format!(
                "{section} owner {} lacks exactly one global catalog export {catalog_name}",
                record.owner_id
            ));
            continue;
        };
        let Some(imported) = imports
            .iter()
            .find(|g| g.index == entry.index)
            .filter(|g| imported_global_needs_recipe(&g.module, &g.name))
        else {
            failures.push(format!(
                "{section} owner {} does not identify a reconstructible imported global",
                record.owner_id
            ));
            continue;
        };
        let recipe_type_code = imported.value_type.module_state_global_type_code();
        if imported.module != record.module
            || imported.name != record.name
            || imported.import_ordinal != record.import_ordinal
            || recipe_type_code != Some(record.type_code)
            || imported.mutable != record.mutable
            || imported.shared != record.shared
        {
            failures.push(format!(
                "{section} owner {} does not match its imported global declaration",
                record.owner_id
            ));
            continue;
        }
        if matched.contains(&imported.index) {
            failures.push(format!(
                "{section} repeats imported global index {}",
                imported.index
            ));
            continue;
        }
        matched.push(imported.index);
    }

    for imported in &imports {
        if imported_global_needs_recipe(&imported.module, &imported.name)
            && !matched.contains(&imported.index)
        {
            failures.push(format!(
                "{section} omits imported global {}.{} at index {}",
                imported.module, imported.name, imported.index
            ));
        }
    }

    check_reserved_catalog_exports(
        facts,
        abi::WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
        ExternalKind::Global,
        "global",
        failures,
    );
}

fn check_imported_tables(facts: &ArtifactFacts, failures: &mut Vec<String>) {
    let section = abi::WPK_FORK_IMPORTED_TABLES_SECTION;
    let Some(descriptor) = exactly_one(&facts.imported_tables_descriptors, section, failures)
    else {
        return;
    };
    let decoded = match decode_imported_tables(descriptor) {
        Ok(decoded) => decoded,
        Err(errno) => {
            failures.push(format!(
                "{section} descriptor is malformed (errno {})",
                errno as i32
            ));
            return;
        }
    };

    let imports: Vec<_> = facts.table_imports.values().flatten().collect();
    let mut matched: Vec<u32> = Vec::new();

    for record in &decoded.tables {
        let catalog_name = format!(
            "{}{}",
            abi::WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
            record.owner_id
        );
        let Some(entry) = facts
            .exports
            .get(&catalog_name)
            .filter(|entries| entries.len() == 1)
            .map(|entries| entries[0])
            .filter(|entry| entry.kind == ExternalKind::Table)
        else {
            failures.push(format!(
                "{section} owner {} lacks exactly one table catalog export {catalog_name}",
                record.owner_id
            ));
            continue;
        };
        let Some(imported) = imports
            .iter()
            .find(|t| t.index == entry.index)
            .filter(|t| imported_table_needs_recipe(&t.module, &t.name))
        else {
            failures.push(format!(
                "{section} owner {} does not identify a reconstructible imported table",
                record.owner_id
            ));
            continue;
        };
        let recipe_type_code = imported.table.element.module_state_global_type_code();
        if imported.module != record.module
            || imported.name != record.name
            || imported.import_ordinal != record.import_ordinal
            || recipe_type_code != Some(record.type_code)
            || imported.table.table64 != record.table64
        {
            failures.push(format!(
                "{section} owner {} does not match its imported table declaration",
                record.owner_id
            ));
            continue;
        }
        if matched.contains(&imported.index) {
            failures.push(format!(
                "{section} repeats imported table index {}",
                imported.index
            ));
            continue;
        }
        matched.push(imported.index);
    }

    for imported in &imports {
        if imported_table_needs_recipe(&imported.module, &imported.name)
            && !matched.contains(&imported.index)
        {
            failures.push(format!(
                "{section} omits imported table {}.{} at index {}",
                imported.module, imported.name, imported.index
            ));
        }
    }

    check_reserved_catalog_exports(
        facts,
        abi::WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
        ExternalKind::Table,
        "table",
        failures,
    );
}

/// Every export in a reserved catalog namespace must be well-formed, whether or
/// not a descriptor record claims it.
///
/// WHY sweep the namespace rather than only the claimed names: an unclaimed but
/// well-named export is exactly what a copied or partial transform leaves
/// behind, and it would otherwise be silently ignored.
fn check_reserved_catalog_exports(
    facts: &ArtifactFacts,
    prefix: &str,
    kind: ExternalKind,
    label: &str,
    failures: &mut Vec<String>,
) {
    for (name, entries) in &facts.exports {
        let Some(suffix) = name.strip_prefix(prefix) else {
            continue;
        };
        if parse_owner_suffix(suffix).is_none()
            || entries.len() != 1
            || entries[0].kind != kind
        {
            failures.push(format!(
                "malformed reserved fork {label} catalog export {name}"
            ));
        }
    }
}

fn check_activation_import(facts: &ArtifactFacts, failures: &mut Vec<String>) {
    let identity = format!(
        "{}.{}",
        abi::WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
        abi::WPK_FORK_EXCEPTION_IMPORT_ACTIVATION
    );
    let Some(imports) = facts.global_imports.get(&identity) else {
        failures.push(format!(
            "missing required immutable exception-codec activation import {identity}"
        ));
        return;
    };
    if imports.len() != 1 {
        failures.push(format!(
            "duplicate exception-codec activation import {identity}"
        ));
        return;
    }
    if imports[0].value_type != ValueType::I32 || imports[0].mutable {
        failures.push(format!(
            "exception-codec activation import {identity} must be immutable i32"
        ));
    }
}

fn check_required_table_imports(facts: &ArtifactFacts, epoch: u32, failures: &mut Vec<String>) {
    for requirement in abi::WPK_FORK_REQUIRED_TABLE_IMPORTS {
        let identity = format!("{}.{}", requirement.module, requirement.name);
        let Some(imports) = facts.table_imports.get(&identity) else {
            failures.push(format!(
                "missing required ABI {epoch} fork-runtime table import {identity}"
            ));
            continue;
        };
        if imports.len() != 1 {
            failures.push(format!(
                "duplicate ABI {epoch} fork-runtime table import {identity}"
            ));
            continue;
        }
        let actual = &imports[0].table;
        // These private tables are part of the runtime's own plumbing and are
        // width-independent by construction, so the element type is compared
        // against the wasm32 resolution regardless of the artifact's memory.
        if !actual.element.satisfies(requirement.element, 4)
            || actual.table64 != requirement.table64
            || actual.minimum != requirement.minimum
            || actual.maximum != requirement.maximum
        {
            failures.push(format!(
                "ABI {epoch} fork-runtime table import {identity} has the wrong type or limits"
            ));
        }
    }
}

fn check_static_root_catalog(facts: &ArtifactFacts, failures: &mut Vec<String>) {
    let section = abi::WPK_FORK_STATIC_ROOT_CATALOG_SECTION;
    let Some(descriptor) = exactly_one(&facts.static_root_descriptors, section, failures) else {
        return;
    };
    let catalog = match decode_static_root_catalog(descriptor) {
        Ok(catalog) => catalog,
        Err(errno) => {
            failures.push(format!(
                "{section} descriptor is malformed (errno {})",
                errno as i32
            ));
            return;
        }
    };

    let export_name = abi::WPK_FORK_STATIC_ROOT_CATALOG_EXPORT;
    let Some(entry) = facts
        .exports
        .get(export_name)
        .filter(|entries| entries.len() == 1)
        .map(|entries| entries[0])
        .filter(|entry| entry.kind == ExternalKind::Table)
    else {
        failures.push(format!("missing exactly one table export {export_name}"));
        return;
    };

    // The harvest table must be module-local: an imported table is owned by
    // whoever supplied it, so a child could not reconstruct its contents.
    if entry.index < facts.imported_table_count {
        failures.push(format!(
            "{export_name} must export a module-local table"
        ));
        return;
    }
    let Some(table) = facts.tables.get(entry.index as usize) else {
        failures.push(format!(
            "{export_name} must export a module-local table"
        ));
        return;
    };
    let count = u64::from(catalog.count);
    if table.element != ValueType::AnyRef
        || table.table64
        || table.minimum != count
        || table.maximum != Some(count)
    {
        failures.push(format!(
            "{export_name} must be a fixed table32 anyref catalog of length {count}"
        ));
    }
}

fn check_required_exports(
    facts: &ArtifactFacts,
    epoch: u32,
    pointer_width: u8,
    failures: &mut Vec<String>,
) {
    let mut missing: Vec<&str> = Vec::new();
    for requirement in abi::WPK_FORK_REQUIRED_EXPORTS {
        let Some(signatures) = facts.function_exports.get(requirement.name) else {
            missing.push(requirement.name);
            continue;
        };
        if signatures.len() != 1 {
            failures.push(format!(
                "duplicate ABI {epoch} wasm-fork-instrument export {}",
                requirement.name
            ));
            continue;
        }
        if !signatures[0].matches(requirement.params, requirement.results, pointer_width) {
            failures.push(format!(
                "ABI {epoch} wasm-fork-instrument export {} has the wrong signature; expected {}, found {}",
                requirement.name,
                describe_required_signature(
                    requirement.params,
                    requirement.results,
                    pointer_width
                ),
                signatures[0].describe(),
            ));
        }
    }
    if !missing.is_empty() {
        failures.push(format!(
            "incomplete wasm-fork-instrument exports; missing {}",
            missing.join(", ")
        ));
    }
}

fn check_process_fork_import(facts: &ArtifactFacts, epoch: u32, failures: &mut Vec<String>) {
    if !facts.imports_kernel_fork {
        return;
    }
    let requirement = abi::WPK_FORK_PROCESS_IMPORT;
    let identity = format!("{}.{}", requirement.module, requirement.name);
    let Some(signatures) = facts.function_imports.get(&identity) else {
        return;
    };
    if signatures.len() != 1 {
        failures.push(format!(
            "duplicate ABI {epoch} process-fork import {identity}"
        ));
        return;
    }
    // The process-fork import is `(i32) -> i32` on both data models: its
    // argument is a mode flag and its result a pid, neither of which is a
    // pointer. It is therefore resolved at wasm32 regardless of the artifact.
    if !signatures[0].matches(requirement.params, requirement.results, 4) {
        failures.push(format!(
            "ABI {epoch} process-fork import {identity} has the wrong signature; expected {}",
            describe_required_signature(requirement.params, requirement.results, 4)
        ));
    }
}

/// The frame imports and the unwind transport are required together, and only
/// when the artifact participates in fork at all.
fn check_frame_imports_and_unwind(
    facts: &ArtifactFacts,
    epoch: u32,
    pointer_width: u8,
    failures: &mut Vec<String>,
) {
    let present_frame_imports = abi::WPK_FORK_REQUIRED_IMPORTS.iter().any(|requirement| {
        facts
            .function_imports
            .contains_key(&format!("{}.{}", requirement.module, requirement.name))
    });
    let unwind_tag_identity = format!(
        "{}.{}",
        abi::WPK_FORK_UNWIND_TAG_IMPORT_MODULE,
        abi::WPK_FORK_UNWIND_TAG_IMPORT_NAME
    );
    let requires_frame_imports = facts.imports_kernel_fork || present_frame_imports;
    let requires_unwind_transport = requires_frame_imports
        || facts.tag_imports.contains_key(&unwind_tag_identity)
        || !facts.unwind_transport_descriptors.is_empty();

    if requires_unwind_transport {
        check_unwind_transport(facts, &unwind_tag_identity, failures);
    }
    if !requires_frame_imports {
        return;
    }

    let mut missing: Vec<String> = Vec::new();
    for requirement in abi::WPK_FORK_REQUIRED_IMPORTS {
        let identity = format!("{}.{}", requirement.module, requirement.name);
        let Some(signatures) = facts.function_imports.get(&identity) else {
            missing.push(identity);
            continue;
        };
        if signatures.len() != 1 {
            failures.push(format!(
                "duplicate ABI {epoch} wasm-fork-instrument import {identity}"
            ));
            continue;
        }
        if !signatures[0].matches(requirement.params, requirement.results, pointer_width) {
            failures.push(format!(
                "ABI {epoch} wasm-fork-instrument import {identity} has the wrong signature; expected {}, found {}",
                describe_required_signature(
                    requirement.params,
                    requirement.results,
                    pointer_width
                ),
                signatures[0].describe(),
            ));
        }
    }
    if !missing.is_empty() {
        failures.push(format!(
            "incomplete wasm-fork-instrument imports; missing {}",
            missing.join(", ")
        ));
    }
}

fn check_unwind_transport(
    facts: &ArtifactFacts,
    unwind_tag_identity: &str,
    failures: &mut Vec<String>,
) {
    match facts.tag_imports.get(unwind_tag_identity) {
        None => failures.push(format!(
            "missing required private fork-unwind tag import {unwind_tag_identity}"
        )),
        Some(tags) if tags.len() != 1 => failures.push(format!(
            "duplicate private fork-unwind tag import {unwind_tag_identity}"
        )),
        Some(tags) if !tags[0].params.is_empty() || !tags[0].results.is_empty() => {
            failures.push(format!(
                "private fork-unwind tag {unwind_tag_identity} must have an empty payload"
            ))
        }
        Some(_) => {}
    }

    let section = abi::WPK_FORK_UNWIND_TRANSPORT_SECTION;
    let Some(descriptor) = exactly_one(&facts.unwind_transport_descriptors, section, failures)
    else {
        return;
    };
    if descriptor.len() != 2
        || descriptor[0] != abi::WPK_FORK_UNWIND_TRANSPORT_VERSION
        || descriptor[1] != abi::WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY
    {
        failures.push(format!(
            "{section} must be [{}, {}]",
            abi::WPK_FORK_UNWIND_TRANSPORT_VERSION,
            abi::WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY
        ));
    }
}

/// The identity of a reserved catalog export namespace, exported for tests that
/// pin the canonical-suffix rule.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_suffixes_must_be_canonical_decimal() {
        assert_eq!(parse_owner_suffix("1"), Some(1));
        assert_eq!(parse_owner_suffix("4294967295"), Some(u32::MAX));
        // A leading zero would let two records claim one export.
        assert_eq!(parse_owner_suffix("01"), None);
        assert_eq!(parse_owner_suffix("0"), None);
        assert_eq!(parse_owner_suffix(""), None);
        assert_eq!(parse_owner_suffix("+1"), None);
        assert_eq!(parse_owner_suffix("-1"), None);
        assert_eq!(parse_owner_suffix("1 "), None);
        assert_eq!(parse_owner_suffix("1e3"), None);
        // Out of range for a u32 owner id.
        assert_eq!(parse_owner_suffix("4294967296"), None);
    }

    #[test]
    fn control_globals_are_excluded_from_recipes() {
        let module = abi::WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE;
        assert!(!imported_global_needs_recipe(
            module,
            abi::WPK_FORK_EXCEPTION_IMPORT_ACTIVATION
        ));
        assert!(!imported_global_needs_recipe(module, "__channel_base"));
        assert!(!imported_global_needs_recipe(
            module,
            "__wpk_fork_module_state_table_generation_addr"
        ));
        assert!(imported_global_needs_recipe(module, "__tls_base"));
        assert!(imported_global_needs_recipe("other", "__channel_base"));
    }

    #[test]
    fn required_table_imports_are_excluded_from_recipes() {
        for requirement in abi::WPK_FORK_REQUIRED_TABLE_IMPORTS {
            assert!(!imported_table_needs_recipe(
                requirement.module,
                requirement.name
            ));
        }
        assert!(imported_table_needs_recipe("env", "some_app_table"));
    }

    #[test]
    fn an_empty_module_fails_the_whole_contract() {
        let facts = ArtifactFacts::default();
        let failures = describe_fork_contract_failures(&facts, 44);
        // Every required piece is absent, so the report must name each family
        // rather than stopping at the first.
        assert!(failures.iter().any(|f| f.contains("capability")));
        assert!(failures
            .iter()
            .any(|f| f.contains(abi::WPK_FORK_LINKED_FRAME_FORMAT_SECTION)));
        assert!(failures
            .iter()
            .any(|f| f.contains(abi::WPK_FORK_MODULE_STATE_FORMAT_SECTION)));
        assert!(failures
            .iter()
            .any(|f| f.contains("incomplete wasm-fork-instrument exports")));
        assert!(failures.iter().any(|f| f.contains("activation import")));
    }

    #[test]
    fn failure_messages_name_the_epoch_they_were_measured_against() {
        let facts = ArtifactFacts::default();
        let at_44 = describe_fork_contract_failures(&facts, 44);
        let at_99 = describe_fork_contract_failures(&facts, 99);
        assert!(at_44.iter().any(|f| f.contains("ABI 44")));
        assert!(at_99.iter().any(|f| f.contains("ABI 99")));
        assert!(!at_99.iter().any(|f| f.contains("ABI 44")));
    }
}

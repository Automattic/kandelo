//! Admission for interfaces explicitly required by versioned Wasm imports.
use crate::facts::{ArtifactFacts, DescriptorKind};
use alloc::{format, string::String, vec::Vec};
use wasm_posix_program_abi::program_extensions::{RESERVED_MODULE_PREFIX, stack_v1 as stack};

pub const IMPLEMENTED: &[&str] = &[stack::MODULE];

pub fn describe_failures(facts: &ArtifactFacts, supported: &[&str]) -> Vec<String> {
    let mut failures = Vec::new();
    for import in &facts.import_descriptors {
        if !import.module.starts_with(RESERVED_MODULE_PREFIX) && import.name != stack::IMPORT {
            continue;
        }
        let identity = format!("{}.{}", import.module, import.name);
        if import.module != stack::MODULE || !supported.contains(&import.module.as_str()) {
            failures.push(format!("unsupported required program extension {identity}"));
            continue;
        }
        if import.name != stack::IMPORT || import.kind != DescriptorKind::Function {
            failures.push(format!(
                "unsupported import in program extension {identity}"
            ));
            continue;
        }
        let width = facts.memory_pointer_widths.first().copied().unwrap_or(0);
        if facts.memory_pointer_widths.len() != 1 || ![4, 8].contains(&width) {
            failures.push(format!("{identity} requires one process memory"));
            continue;
        }
        let expected = [if width == 8 { 0x7e } else { 0x7f }, 0x7f, 0x7f];
        let matching: Vec<_> = facts
            .function_import_entries
            .iter()
            .filter(|entry| entry.module == import.module && entry.name == import.name)
            .collect();
        if matching.is_empty()
            || matching.iter().any(|entry| {
                entry.params.len() != expected.len()
                    || entry.params.iter().zip(expected).any(|(actual, expected)| {
                        actual.code != expected || actual.heap_type.is_some() || actual.shared
                    })
                    || entry.results.len() != 1
                    || entry.results[0].code != 0x7f
            })
        {
            failures.push(format!("{identity} has an incompatible function signature"));
        }
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read_artifact_facts;
    #[test]
    fn extensions_are_explicit_and_do_not_change_base_admission() {
        let plain = read_artifact_facts(&wat::parse_str("(module)").unwrap()).unwrap();
        assert!(describe_failures(&plain, &[]).is_empty());
        for wide in [false, true] {
            let (pointer, memory) = if wide { ("i64", "i64") } else { ("i32", "") };
            let bytes = wat::parse_str(format!(r#"(module (import "{}" "{}" (func (param {pointer} i32 i32) (result i32))) (memory {memory} 1))"#, stack::MODULE, stack::IMPORT)).unwrap();
            let facts = read_artifact_facts(&bytes).unwrap();
            assert!(describe_failures(&facts, IMPLEMENTED).is_empty());
            assert!(!describe_failures(&facts, &[]).is_empty());
        }
    }
    #[test]
    fn unknown_versions_names_kinds_and_signatures_are_refused() {
        for (module, name, kind) in [
            (
                "kandelo.stack.v2",
                stack::IMPORT,
                "func (param i32 i32 i32) (result i32)",
            ),
            (
                "env",
                stack::IMPORT,
                "func (param i32 i32 i32) (result i32)",
            ),
            (stack::MODULE, "unknown", "func"),
            (stack::MODULE, stack::IMPORT, "global i32"),
            (
                stack::MODULE,
                stack::IMPORT,
                "func (param i64 i32 i32) (result i32)",
            ),
            (
                stack::MODULE,
                stack::IMPORT,
                "func (param i32 i32) (result i32)",
            ),
        ] {
            let bytes = wat::parse_str(format!(
                r#"(module (import "{module}" "{name}" ({kind})) (memory 1))"#
            ))
            .unwrap();
            assert!(
                !describe_failures(&read_artifact_facts(&bytes).unwrap(), IMPLEMENTED).is_empty(),
                "{module}.{name}"
            );
        }
    }
}

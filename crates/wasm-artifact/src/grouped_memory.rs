//! Existing trusted-group executable declaration, read only for an explicitly
//! selected grouped backend. Ordinary artifact policy still refuses its import.
use crate::{
    ArtifactFacts, ArtifactPolicy,
    policy::{ArtifactPolicyReport, describe_facts_policy_failures_with_extensions},
};
use alloc::{borrow::Cow, format, string::String, vec::Vec};
use serde::Deserialize;
use wasm_posix_program_abi::program_extensions::{klog_v1, memory_group_v3 as G, memory_group_growth_v1 as growth, stack_v1};
use wasmparser::{Parser, Payload, TypeRef};

const LIMIT: usize = 4096;
const SUPPORTED: &[&str] = &[stack_v1::MODULE, klog_v1::MODULE, G::MODULE, growth::MODULE];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupedMemoryLayout {
    pub initial_pages: u32,
    pub maximum_pages: u32,
    pub source_sha256: [u8; 32],
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Declaration<'a> {
    version: u32,
    layout: u32,
    thread_attach: u32,
    cooperative_stop: u32,
    execution_barrier: u32,
    ordered_wait_queue: u32,
    kernel_growth: u32,
    initial_pages: u32,
    maximum_pages: u32,
    #[serde(borrow)]
    access_profile: Cow<'a, str>,
    #[serde(borrow)]
    source_sha256: Cow<'a, str>,
    #[serde(borrow)]
    helpers_sha256: Cow<'a, str>,
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
/// No resource is admitted here. A kernel-owned group/target transaction must
/// still choose limits, reserve a receipt and bind its exact prepared bytes.
pub fn read_layout(bytes: &[u8]) -> Result<GroupedMemoryLayout, String> {
    let mut declaration = None;
    let mut imported = 0;
    let mut growth_imported = 0;
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.map_err(|error| format!("invalid grouped artifact: {error}"))? {
            Payload::CustomSection(section) if section.name() == G::SECTION => {
                if declaration.is_some() || section.data().len() > LIMIT {
                    return Err("duplicate or oversized grouped artifact declaration".into());
                }
                declaration = Some(
                    serde_json::from_slice::<Declaration<'_>>(section.data())
                        .map_err(|_| String::from("invalid grouped artifact declaration"))?,
                );
            }
            Payload::ImportSection(section) => {
                for entry in section.into_imports() {
                    let entry = entry.map_err(|_| String::from("invalid grouped import"))?;
                    if entry.module == growth::MODULE && entry.name == growth::IMPORT
                        && matches!(entry.ty, TypeRef::Func(_)) { growth_imported += 1; }
                    if let TypeRef::Memory(memory) = entry.ty {
                        imported += 1;
                        if entry.module != G::MODULE
                            || entry.name != G::IMPORT
                            || memory.memory64
                            || !memory.shared
                            || memory.page_size_log2.is_some()
                            || memory.initial != 1
                            || memory.maximum != Some(65536)
                        {
                            return Err("incompatible grouped physical memory import".into());
                        }
                    }
                }
            }
            Payload::DataSection(section) => {
                for segment in section {
                    if !matches!(
                        segment
                            .map_err(|_| String::from("invalid grouped data segment"))?
                            .kind,
                        wasmparser::DataKind::Passive
                    ) {
                        return Err(
                            "grouped executable must defer active data initialization".into()
                        );
                    }
                }
            }
            Payload::MemorySection(_) => {
                return Err("grouped executable must import its physical memory".into());
            }
            Payload::StartSection { .. } => {
                return Err("grouped executable must defer native start".into());
            }
            _ => (),
        }
    }
    let d = declaration.ok_or_else(|| String::from("missing grouped artifact declaration"))?;
    if imported != 1 || growth_imported != 1 || d.kernel_growth != growth::VERSION
        || d.version != G::VERSION
        || d.layout != G::LAYOUT
        || d.thread_attach != 2
        || d.cooperative_stop != 3
        || d.execution_barrier != 1
        || d.ordered_wait_queue != 2
        || d.access_profile != "outlined"
        || d.initial_pages > d.maximum_pages
        || d.maximum_pages == 0
        || d.maximum_pages > 65536
        || !digest(&d.source_sha256)
        || !digest(&d.helpers_sha256)
    {
        return Err("incompatible grouped artifact layout or virtual limits".into());
    }
    let mut source_sha256 = [0u8; 32];
    for (index, byte) in source_sha256.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&d.source_sha256[index * 2..index * 2 + 2], 16)
            .map_err(|_| String::from("invalid grouped source digest"))?;
    }
    Ok(GroupedMemoryLayout {
        source_sha256,
        initial_pages: d.initial_pages,
        maximum_pages: d.maximum_pages,
    })
}

/// Explicit backend admission combines the ordinary ABI/export checks with
/// the grouped declaration; it never filters refusal strings after the fact.
pub fn describe_failures(
    bytes: &[u8],
    facts: &ArtifactFacts,
    policy: &ArtifactPolicy<'_>,
) -> ArtifactPolicyReport {
    let mut report =
        describe_facts_policy_failures_with_extensions(bytes, facts, policy, SUPPORTED);
    if let Err(error) = read_layout(bytes) {
        report.failures.push(error);
    }
    report.failures.extend(binding_failures(bytes, facts));
    report
}

fn binding_failures(bytes: &[u8], facts: &ArtifactFacts) -> Vec<String> {
    use crate::ValueType::{I32, I64};
    let mut failures = Vec::new();
    for (name, params, results) in [
        ("__vm_checkpoint", &[I32, I32][..], &[][..]),
        (
            "__vm_worker_wait32",
            &[I32, I32, I64, I32, I32][..],
            &[I32][..],
        ),
        ("__vm_initialize", &[I32][..], &[][..]),
        ("__vm_host_span", &[I32, I32, I32, I32][..], &[I32][..]),
    ] {
        if !facts.function_exports.get(name).is_some_and(|entries| {
            entries.len() == 1 && entries[0].params == params && entries[0].results == results
        }) {
            failures.push(format!("incompatible grouped binding function {name}"));
        }
    }
    let mut wanted = Vec::new();
    for name in ["__vm_root", "__vm_scratch", "__vm_replica"] {
        match facts.exports.get(name).map(Vec::as_slice) {
            Some([entry]) if entry.kind == wasmparser::ExternalKind::Global => {
                wanted.push((entry.index, name))
            }
            _ => failures.push(format!(
                "missing or ambiguous grouped binding global {name}"
            )),
        }
    }
    let mut index = 0;
    let mut inspect = |ty: wasmparser::GlobalType| {
        for &(expected, name) in &wanted {
            if expected == index
                && (ty.content_type != wasmparser::ValType::I32 || !ty.mutable || ty.shared)
            {
                failures.push(format!("incompatible grouped binding global {name}"));
            }
        }
        index += 1;
    };
    for payload in Parser::new(0).parse_all(bytes) {
        match payload {
            Ok(Payload::ImportSection(section)) => {
                for entry in section.into_imports().flatten() {
                    if let TypeRef::Global(ty) = entry.ty {
                        inspect(ty);
                    }
                }
            }
            Ok(Payload::GlobalSection(section)) => {
                for global in section.into_iter().flatten() {
                    inspect(global.ty);
                }
            }
            _ => (),
        }
    }
    for &(expected, name) in &wanted {
        if expected >= index {
            failures.push(format!("missing grouped binding global {name}"));
        }
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    fn unsigned(mut value: usize, out: &mut Vec<u8>) {
        loop {
            let byte = (value & 127) as u8;
            value >>= 7;
            out.push(byte | if value > 0 { 128 } else { 0 });
            if value == 0 {
                break;
            }
        }
    }
    fn metadata(patch: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let mut value = serde_json::json!({"version":3,"layout":3,"threadAttach":2,"cooperativeStop":3,
            "executionBarrier":1,"orderedWaitQueue":2,"kernelGrowth":1,"initialPages":149,"maximumPages":65536,"accessProfile":"outlined",
            "sourceSha256":"0".repeat(64),"helpersSha256":"a".repeat(64)});
        patch(&mut value);
        serde_json::to_vec(&value).unwrap()
    }
    fn append(bytes: &mut Vec<u8>, data: &[u8]) {
        let mut section = Vec::new();
        unsigned(G::SECTION.len(), &mut section);
        section.extend_from_slice(G::SECTION.as_bytes());
        section.extend_from_slice(data);
        bytes.push(0);
        unsigned(section.len(), bytes);
        bytes.extend(section);
    }
    const BINDINGS: &str = r#"
        (global(export "__vm_root")(mut i32)(i32.const 0))
        (global(export "__vm_scratch")(mut i32)(i32.const 0))
        (global(export "__vm_replica")(mut i32)(i32.const 0))
        (func(export "__vm_checkpoint")(param i32 i32))
        (func(export "__vm_worker_wait32")(param i32 i32 i64 i32 i32)(result i32)i32.const 0)
        (func(export "__vm_initialize")(param i32))
        (func(export "__vm_host_span")(param i32 i32 i32 i32)(result i32)i32.const 0)
    "#;
    fn module(shape: &str, data: &[u8]) -> Vec<u8> {
        let mut bytes = wat::parse_str(format!(r#"(module
            (import "kandelo.memory-group-growth.v1" "__kandelo_memory_group_grow_v1" (func(param i32)(result i32)))
            {shape} {BINDINGS})"#)).unwrap();
        append(&mut bytes, data);
        bytes
    }
    const IMPORT: &str = r#"(import "kandelo.memory-group.v3" "memory" (memory 1 65536 shared))"#;
    #[test]
    fn kernel_growth_requires_its_exact_namespace_kind_count_and_signature() {
        for growth in [
            "",
            r#"(import "env" "__kandelo_memory_group_grow_v1" (func(param i32)(result i32)))"#,
            r#"(import "kandelo.memory-group-growth.v2" "__kandelo_memory_group_grow_v1" (func(param i32)(result i32)))"#,
            r#"(import "kandelo.memory-group-growth.v1" "wrong" (func(param i32)(result i32)))"#,
            r#"(import "kandelo.memory-group-growth.v1" "__kandelo_memory_group_grow_v1" (global i32))"#,
            r#"(import "kandelo.memory-group-growth.v1" "__kandelo_memory_group_grow_v1" (func(param i64)(result i32)))"#,
            r#"(import "kandelo.memory-group-growth.v1" "__kandelo_memory_group_grow_v1" (func(param i32)))"#,
            r#"(import "kandelo.memory-group-growth.v1" "__kandelo_memory_group_grow_v1" (func(param i32)(result i32)))
               (import "kandelo.memory-group-growth.v1" "__kandelo_memory_group_grow_v1" (func(param i32)(result i32)))"#,
        ] {
            let mut bytes = wat::parse_str(format!("(module {IMPORT} {growth} {BINDINGS})")).unwrap();
            append(&mut bytes, &metadata(|_| {}));
            let facts = crate::read_artifact_facts(&bytes).unwrap();
            assert!(!describe_failures(&bytes, &facts, &ArtifactPolicy::default()).is_acceptable(), "{growth}");
        }
    }

    #[test]
    fn grouped_support_is_explicit_and_preserves_ordinary_refusal() {
        let bytes = module(IMPORT, &metadata(|_| {}));
        let facts = crate::read_artifact_facts(&bytes).unwrap();
        assert!(
            !crate::describe_artifact_policy_failures(&bytes, &ArtifactPolicy::default())
                .is_acceptable()
        );
        assert!(describe_failures(&bytes, &facts, &ArtifactPolicy::default()).is_acceptable());
        assert_eq!(
            read_layout(&bytes),
            Ok(GroupedMemoryLayout {
                initial_pages: 149,
                maximum_pages: 65536,
                source_sha256: [0; 32],
            })
        );
        let ordinary = wat::parse_str("(module (memory 1))").unwrap();
        assert!(
            crate::describe_artifact_policy_failures(&ordinary, &ArtifactPolicy::default())
                .is_acceptable()
        );
        assert!(read_layout(&ordinary).is_err());
    }
    #[test]
    fn rejects_layout_limits_versions_profiles_and_unknown_protocols() {
        for field in [
            "version",
            "layout",
            "threadAttach",
            "cooperativeStop",
            "executionBarrier",
            "orderedWaitQueue",
            "kernelGrowth",
            "maximumPages",
        ] {
            let data = metadata(|v| v[field] = serde_json::json!(0));
            assert!(read_layout(&module(IMPORT, &data)).is_err(), "{field}");
        }
        for (field, value) in [
            ("maximumPages", serde_json::json!(65537)),
            ("initialPages", serde_json::json!(65537)),
            ("initialPages", serde_json::json!(-1)),
            ("accessProfile", serde_json::json!("unverified")),
            ("helpersSha256", serde_json::json!("A".repeat(64))),
            ("sourceSha256", serde_json::json!("short")),
        ] {
            assert!(
                read_layout(&module(IMPORT, &metadata(|v| v[field] = value))).is_err(),
                "{field}"
            );
        }
    }
    #[test]
    fn accepts_json_string_escapes_without_changing_the_declared_profile() {
        let data = String::from_utf8(metadata(|_| {}))
            .unwrap()
            .replace("outlined", r"outl\u0069ned");
        assert!(read_layout(&module(IMPORT, data.as_bytes())).is_ok());
    }
    #[test]
    fn rejects_duplicate_oversized_and_malformed_declarations() {
        let data = metadata(|_| {});
        let mut bytes = module(IMPORT, &data);
        append(&mut bytes, &data);
        assert!(read_layout(&bytes).is_err());
        for data in [vec![b' '; LIMIT + 1], b"{broken}".to_vec(), b"[]".to_vec()] {
            assert!(read_layout(&module(IMPORT, &data)).is_err());
        }
        let duplicated = String::from_utf8(data)
            .unwrap()
            .replacen("{", "{\"version\":3,", 1);
        assert!(read_layout(&module(IMPORT, duplicated.as_bytes())).is_err());
    }
    #[test]
    fn refuses_active_data_and_wrong_binding_types_before_launch() {
        assert!(
            read_layout(&module(
                &format!(r#"{IMPORT} (data(i32.const 0) "x")"#),
                &metadata(|_| {})
            ))
            .is_err()
        );
        for bindings in [
            BINDINGS.replace("(mut i32)(i32.const 0)", "i32(i32.const 0)"),
            BINDINGS.replace("(param i32 i32 i64 i32 i32)", "(param i32)"),
        ] {
            let mut bytes = wat::parse_str(format!("(module {IMPORT} {bindings})")).unwrap();
            append(&mut bytes, &metadata(|_| {}));
            let facts = crate::read_artifact_facts(&bytes).unwrap();
            assert!(!describe_failures(&bytes, &facts, &ArtifactPolicy::default()).is_acceptable());
        }
    }
    #[test]
    fn refuses_unshared_memory64_defined_multiple_and_eager_start() {
        for shape in [
            r#"(import "kandelo.memory-group.v3" "memory" (memory 1 65536))"#,
            r#"(import "kandelo.memory-group.v3" "memory" (memory i64 1 65536 shared))"#,
            r#"(import "env" "memory" (memory 1 65536 shared))"#,
            r#"(memory 1 65536 shared)"#,
            r#"(import "kandelo.memory-group.v3" "memory" (memory 1 65536 shared)) (memory 1)"#,
            r#"(import "kandelo.memory-group.v3" "memory" (memory 1 65536 shared)) (func $s) (start $s)"#,
        ] {
            assert!(
                read_layout(&module(shape, &metadata(|_| {}))).is_err(),
                "{shape}"
            );
        }
    }
}

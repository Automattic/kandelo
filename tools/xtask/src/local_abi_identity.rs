//! The ABI-contract digest a program carries (`kandelo.abi.contract`).
//!
//! WHY only part of the snapshot: the host refuses to run a program whose
//! digest differs from the running kernel's, so the digest decides when every
//! program, package and test fixture must be rebuilt. It binds `ABI_VERSION`
//! plus the snapshot sections `xtask dump-abi` marks as the program surface
//! (`abi_surfaces.program`): what a running program was compiled and linked
//! against. Kernel-host sections (kernel exports and imports, host-adapter
//! metadata, the export filter, the kernel-host wire formats) are left out:
//! the kernel and host ship together and check each other, and no program can
//! observe them, so changing them must not invalidate programs.

use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::dump_abi::SURFACES_KEY;

pub(crate) fn local_abi_contract_digest(
    repo_root: &Path,
    expected_abi_version: u32,
) -> Result<[u8; 32], String> {
    let path = repo_root.join("abi/snapshot.json");
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("read ABI snapshot {}: {error}", path.display()))?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse ABI snapshot {}: {error}", path.display()))?;
    program_contract_digest(&value, expected_abi_version)
        .map_err(|error| format!("ABI snapshot {}: {error}", path.display()))
}

/// The program digest of an already-parsed snapshot.
pub(crate) fn program_contract_digest(
    snapshot: &Value,
    expected_abi_version: u32,
) -> Result<[u8; 32], String> {
    let object = snapshot.as_object().ok_or("must have a JSON object root")?;
    let embedded_version = object
        .get("abi_version")
        .and_then(Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
        .ok_or("must contain an unsigned u32 abi_version")?;
    if embedded_version != expected_abi_version {
        return Err(format!(
            "has abi_version {embedded_version}, expected {expected_abi_version}"
        ));
    }

    let program = program_sections(object)?;
    let mut surface = serde_json::Map::new();
    for name in program {
        surface.insert(name.to_owned(), object[name].clone());
    }
    let mut canonical = Vec::new();
    write_canonical_json(&Value::Object(surface), &mut canonical)?;
    let mut hasher = Sha256::new();
    hasher.update(b"kandelo-program-abi-contract-v2\0");
    hasher.update(expected_abi_version.to_le_bytes());
    hasher.update((canonical.len() as u64).to_le_bytes());
    hasher.update(&canonical);
    Ok(hasher.finalize().into())
}

/// The program-surface section names, after proving `abi_surfaces` assigns
/// every section exactly one surface. A snapshot section missing from both
/// lists would otherwise silently drop out of the program digest.
fn program_sections(object: &serde_json::Map<String, Value>) -> Result<Vec<&str>, String> {
    let names = |surface: &str| -> Result<Vec<&str>, String> {
        match object.get(SURFACES_KEY).map(|surfaces| &surfaces[surface]) {
            None => Ok(Vec::new()),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| {
                    item.as_str()
                        .ok_or_else(|| format!("{SURFACES_KEY}.{surface} must list section names"))
                })
                .collect(),
            Some(_) => Err(format!("{SURFACES_KEY}.{surface} must be an array")),
        }
    };
    let program = names("program")?;
    let kernel_host = names("kernel_host")?;
    let mut seen = std::collections::BTreeSet::new();
    for name in program.iter().chain(&kernel_host) {
        if !seen.insert(*name) {
            return Err(format!(
                "section {name:?} is listed under more than one ABI surface"
            ));
        }
        if !object.contains_key(*name) {
            return Err(format!("{SURFACES_KEY} lists missing section {name:?}"));
        }
    }
    for key in object.keys() {
        if key != "abi_version" && key != SURFACES_KEY && !seen.contains(key.as_str()) {
            return Err(format!(
                "section {key:?} has no ABI surface in {SURFACES_KEY}; \
                 regenerate the snapshot with xtask dump-abi"
            ));
        }
    }
    Ok(program)
}

fn write_canonical_json(value: &serde_json::Value, output: &mut Vec<u8>) -> Result<(), String> {
    match value {
        serde_json::Value::Null => output.extend_from_slice(b"null"),
        serde_json::Value::Bool(value) => {
            output.extend_from_slice(if *value { b"true" } else { b"false" })
        }
        serde_json::Value::Number(value) => output.extend_from_slice(value.to_string().as_bytes()),
        serde_json::Value::String(value) => output.extend_from_slice(
            serde_json::to_string(value)
                .map_err(|error| format!("serialize ABI snapshot string: {error}"))?
                .as_bytes(),
        ),
        serde_json::Value::Array(values) => {
            output.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_canonical_json(value, output)?;
            }
            output.push(b']');
        }
        serde_json::Value::Object(values) => {
            output.push(b'{');
            let mut entries: Vec<_> = values.iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                output.extend_from_slice(
                    serde_json::to_string(key)
                        .map_err(|error| format!("serialize ABI snapshot object key: {error}"))?
                        .as_bytes(),
                );
                output.push(b':');
                write_canonical_json(value, output)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{local_abi_contract_digest, program_contract_digest};
    use serde_json::{Value, json};
    use std::path::PathBuf;

    fn snapshot_root(label: &str, contents: &str) -> PathBuf {
        let root = std::env::temp_dir()
            .join("kandelo-local-abi-identity")
            .join(format!("{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("abi")).unwrap();
        std::fs::write(root.join("abi/snapshot.json"), contents).unwrap();
        root
    }

    fn digest(snapshot: &Value) -> [u8; 32] {
        let version = snapshot["abi_version"].as_u64().unwrap() as u32;
        program_contract_digest(snapshot, version).unwrap()
    }

    const SURFACES: &str =
        r#""abi_surfaces":{"program":["layout"],"kernel_host":["kernel_exports"]}"#;

    #[test]
    fn local_abi_identity_ignores_formatting_and_object_key_order() {
        let first = snapshot_root(
            "canonical-first",
            &format!(
                r#"{{"abi_version":4,"layout":{{"b":2,"a":1,"items":[3,2,1]}},"kernel_exports":[],{SURFACES}}}"#
            ),
        );
        let second = snapshot_root(
            "canonical-second",
            &format!(
                "{{\n  {SURFACES},\n  \"kernel_exports\": [],\n  \"layout\": {{\"items\": [3, 2, 1], \"a\": 1, \"b\": 2}},\n  \"abi_version\": 4\n}}\n"
            ),
        );
        assert_eq!(
            local_abi_contract_digest(&first, 4).unwrap(),
            local_abi_contract_digest(&second, 4).unwrap()
        );
    }

    #[test]
    fn program_digest_moves_with_program_sections_and_epoch_only() {
        let baseline = json!({
            "abi_version": 4,
            "layout": {"bytes": 32},
            "kernel_exports": ["kernel_a"],
            "abi_surfaces": {"program": ["layout"], "kernel_host": ["kernel_exports"]},
        });
        let mut program_changed = baseline.clone();
        program_changed["layout"]["bytes"] = json!(64);
        let mut kernel_host_changed = baseline.clone();
        kernel_host_changed["kernel_exports"] = json!(["kernel_a", "kernel_b"]);
        let mut next_epoch = baseline.clone();
        next_epoch["abi_version"] = json!(5);

        assert_ne!(digest(&baseline), digest(&program_changed));
        assert_eq!(digest(&baseline), digest(&kernel_host_changed));
        assert_ne!(digest(&baseline), digest(&next_epoch));
    }

    #[test]
    fn program_digest_requires_every_section_to_have_one_surface() {
        let unclassified = json!({"abi_version": 4, "layout": {}});
        assert!(
            program_contract_digest(&unclassified, 4)
                .unwrap_err()
                .contains("has no ABI surface")
        );
        let twice = json!({
            "abi_version": 4,
            "layout": {},
            "abi_surfaces": {"program": ["layout"], "kernel_host": ["layout"]},
        });
        assert!(
            program_contract_digest(&twice, 4)
                .unwrap_err()
                .contains("more than one ABI surface")
        );
        let missing = json!({
            "abi_version": 4,
            "abi_surfaces": {"program": ["layout"], "kernel_host": []},
        });
        assert!(
            program_contract_digest(&missing, 4)
                .unwrap_err()
                .contains("missing section")
        );
        // A snapshot with no sections at all needs no surfaces.
        assert!(program_contract_digest(&json!({"abi_version": 4}), 4).is_ok());
    }

    /// The committed snapshot, through the real section structure: a change
    /// only the kernel and host can see leaves every program valid; a change
    /// a program was compiled against invalidates it.
    #[test]
    fn committed_snapshot_separates_kernel_host_changes_from_program_changes() {
        let path = crate::repo_root().join("abi/snapshot.json");
        let snapshot: Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let baseline = digest(&snapshot);

        // A new optional kernel export the host may call.
        let mut optional_export = snapshot.clone();
        optional_export["kernel_exports"]
            .as_array_mut()
            .unwrap()
            .push(json!({"kind": "func", "name": "kernel_probe_only", "signature": "() -> (i64)"}));
        optional_export["host_adapter"]["optional_kernel_exports"]
            .as_array_mut()
            .unwrap()
            .push(json!("kernel_probe_only"));
        assert_eq!(baseline, digest(&optional_export), "optional kernel export");

        // A new host function the kernel imports.
        let mut host_import = snapshot.clone();
        let imports = &mut host_import["kernel_imports"];
        let entry = imports.as_array().unwrap()[0].clone();
        let mut added = entry;
        added["name"] = json!("host_probe_only");
        imports.as_array_mut().unwrap().push(added);
        assert_eq!(baseline, digest(&host_import), "new kernel host import");

        // An incompatible kernel-host change: an existing export's signature
        // changes under a kernel-host version bump. ABI_VERSION stays.
        let mut kernel_host_break = snapshot.clone();
        let export = kernel_host_break["kernel_exports"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|export| export["name"] == "kernel_wait_next_timeout_ns")
            .unwrap();
        export["signature"] = json!("(i32) -> (i64)");
        let version = kernel_host_break["host_adapter"]["version"].as_u64().unwrap();
        kernel_host_break["host_adapter"]["version"] = json!(version + 1);
        kernel_host_break["host_adapter"]["manifest"]["required_host_adapter_version"] =
            json!(version + 1);
        assert_eq!(
            baseline,
            digest(&kernel_host_break),
            "incompatible kernel-host change under a kernel-host version bump"
        );

        // A renumbered syscall.
        let mut syscall = snapshot.clone();
        let first = &mut syscall["syscalls"].as_array_mut().unwrap()[0];
        let number = first["number"].as_u64().unwrap();
        first["number"] = json!(number + 1000);
        assert_ne!(baseline, digest(&syscall), "syscall number");

        // A field moved in a struct programs marshal.
        let mut layout = snapshot.clone();
        let field = &mut layout["marshalled_structs"]["WasmStat"]["fields"]
            .as_array_mut()
            .unwrap()[0];
        let offset = field["offset"].as_u64().unwrap();
        field["offset"] = json!(offset + 4);
        assert_ne!(baseline, digest(&layout), "marshalled struct field offset");
    }

    #[test]
    fn local_abi_identity_moves_with_snapshot_not_sibling_files() {
        // The digest binds ONLY abi/snapshot.json + ABI_VERSION. Editing an
        // unrelated sibling file (e.g. a kernel .rs source) must not change it;
        // editing the snapshot's program surface must.
        let snapshot = |bytes: u32| {
            format!(
                r#"{{"abi_version":4,"layout":{{"bytes":{bytes}}},"kernel_exports":[],{SURFACES}}}"#
            )
        };
        let root = snapshot_root("boundary", &snapshot(32));
        let baseline = local_abi_contract_digest(&root, 4).unwrap();
        std::fs::create_dir_all(root.join("crates/kernel/src")).unwrap();
        std::fs::write(
            root.join("crates/kernel/src/lib.rs"),
            "// a kernel source edit unrelated to the ABI snapshot\n",
        )
        .unwrap();
        assert_eq!(
            baseline,
            local_abi_contract_digest(&root, 4).unwrap(),
            "editing a non-snapshot sibling file must not move the contract digest"
        );
        std::fs::write(root.join("abi/snapshot.json"), snapshot(64)).unwrap();
        assert_ne!(
            baseline,
            local_abi_contract_digest(&root, 4).unwrap(),
            "editing the snapshot's program surface must move the contract digest"
        );
    }

    #[test]
    fn local_abi_identity_rejects_non_object_and_version_mismatch() {
        let array = snapshot_root("non-object", r#"[4]"#);
        assert!(
            local_abi_contract_digest(&array, 4)
                .unwrap_err()
                .contains("JSON object")
        );

        let mismatch = snapshot_root("version-mismatch", r#"{"abi_version":4}"#);
        let error = local_abi_contract_digest(&mismatch, 5).unwrap_err();
        assert!(error.contains("expected 5"), "got: {error}");
    }
}

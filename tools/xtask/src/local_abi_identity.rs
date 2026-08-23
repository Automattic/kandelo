use std::path::Path;

use sha2::{Digest, Sha256};

pub(crate) fn local_abi_contract_digest(
    repo_root: &Path,
    expected_abi_version: u32,
) -> Result<[u8; 32], String> {
    let path = repo_root.join("abi/snapshot.json");
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("read ABI snapshot {}: {error}", path.display()))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse ABI snapshot {}: {error}", path.display()))?;
    let object = value.as_object().ok_or_else(|| {
        format!(
            "ABI snapshot {} must have a JSON object root",
            path.display()
        )
    })?;
    let embedded_version = object
        .get("abi_version")
        .and_then(serde_json::Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
        .ok_or_else(|| {
            format!(
                "ABI snapshot {} must contain an unsigned u32 abi_version",
                path.display()
            )
        })?;
    if embedded_version != expected_abi_version {
        return Err(format!(
            "ABI snapshot {} has abi_version {embedded_version}, expected {expected_abi_version}",
            path.display()
        ));
    }

    let mut canonical = Vec::new();
    write_canonical_json(&value, &mut canonical)?;
    let mut hasher = Sha256::new();
    hasher.update(b"kandelo-local-abi-contract-v1\0");
    hasher.update(expected_abi_version.to_le_bytes());
    hasher.update((canonical.len() as u64).to_le_bytes());
    hasher.update(&canonical);
    Ok(hasher.finalize().into())
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
    use super::local_abi_contract_digest;
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

    #[test]
    fn local_abi_identity_ignores_formatting_and_object_key_order() {
        let first = snapshot_root(
            "canonical-first",
            r#"{"abi_version":4,"nested":{"b":2,"a":1},"items":[3,2,1]}"#,
        );
        let second = snapshot_root(
            "canonical-second",
            "{\n  \"items\": [3, 2, 1],\n  \"nested\": {\"a\": 1, \"b\": 2},\n  \"abi_version\": 4\n}\n",
        );
        assert_eq!(
            local_abi_contract_digest(&first, 4).unwrap(),
            local_abi_contract_digest(&second, 4).unwrap()
        );
    }

    #[test]
    fn local_abi_identity_changes_with_structure_and_semantic_epoch() {
        let baseline = snapshot_root(
            "structure-baseline",
            r#"{"abi_version":4,"layout":{"bytes":32}}"#,
        );
        let changed = snapshot_root(
            "structure-changed",
            r#"{"abi_version":4,"layout":{"bytes":64}}"#,
        );
        let next_epoch = snapshot_root(
            "epoch-changed",
            r#"{"abi_version":5,"layout":{"bytes":32}}"#,
        );
        let baseline_digest = local_abi_contract_digest(&baseline, 4).unwrap();
        assert_ne!(
            baseline_digest,
            local_abi_contract_digest(&changed, 4).unwrap()
        );
        assert_ne!(
            baseline_digest,
            local_abi_contract_digest(&next_epoch, 5).unwrap()
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

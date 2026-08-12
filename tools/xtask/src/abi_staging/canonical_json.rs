// These foundation helpers become live command dependencies in the following
// product-manifest tasks; keep the first independently reviewable commit quiet.
#![allow(dead_code)]

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

pub fn canonical_json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let value = serde_json::to_value(value)
        .map_err(|error| format!("cannot serialize canonical JSON value: {error}"))?;
    let normalized = normalize_json(value)?;
    let mut bytes = serde_json::to_vec(&normalized)
        .map_err(|error| format!("cannot encode canonical JSON value: {error}"))?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn canonical_sha256<T: Serialize>(value: &T) -> Result<String, String> {
    let bytes = canonical_json_bytes(value)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn normalize_json(value: Value) -> Result<Value, String> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(value),
        Value::Number(number) => {
            if number.is_i64() || number.is_u64() {
                Ok(Value::Number(number))
            } else {
                Err("canonical JSON permits integer numbers only".to_string())
            }
        }
        Value::Array(values) => values
            .into_iter()
            .map(normalize_json)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(values) => {
            let mut entries = values.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            let mut normalized = Map::new();
            for (key, value) in entries {
                normalized.insert(key, normalize_json(value)?);
            }
            Ok(Value::Object(normalized))
        }
    }
}

pub fn validate_sha256(value: &str) -> Result<(), String> {
    validate_lower_hex(value, 64, "SHA-256")
}

pub fn validate_git_sha(value: &str) -> Result<(), String> {
    validate_lower_hex(value, 40, "Git SHA")
}

fn validate_lower_hex(value: &str, expected_bytes: usize, field: &str) -> Result<(), String> {
    if value.len() != expected_bytes
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{field} must be exactly {expected_bytes} lowercase hexadecimal characters"
        ));
    }
    Ok(())
}

pub fn validate_stable_id(value: &str, field: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 {
        return Err(format!("{field} must contain 1 through 128 ASCII bytes"));
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return Err(format!("{field} must start with a lowercase letter or digit"));
    }
    if !bytes.iter().all(|byte| {
        byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || matches!(byte, b'.' | b'_' | b'-')
    }) {
        return Err(format!(
            "{field} may contain only lowercase ASCII letters, digits, '.', '_', and '-'"
        ));
    }
    Ok(())
}

pub fn validate_repo_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.len() > 4_096 {
        return Err("repository path must contain 1 through 4096 UTF-8 bytes".to_string());
    }
    if value.contains(['\\', '\0']) || value.starts_with('/') {
        return Err(format!("repository path is not normalized: {value:?}"));
    }
    if value
        .split('/')
        .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(format!("repository path is not normalized: {value:?}"));
    }

    let relative = Path::new(value);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("repository path is not normalized: {value:?}"));
    }

    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(format!("repository path is not normalized: {value:?}"));
        };
        current.push(component);
        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|error| format!("repository path {value:?} is unavailable: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("repository path {value:?} contains a symbolic link"));
        }
    }
    Ok(root.join(relative))
}

pub fn validate_absolute_posix_path(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 4_096 || !value.starts_with('/') {
        return Err("absolute POSIX path must begin with '/' and fit within 4096 bytes".to_string());
    }
    if value.contains(['\\', '\0']) {
        return Err(format!("absolute POSIX path is not normalized: {value:?}"));
    }
    if value != "/"
        && value[1..]
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(format!("absolute POSIX path is not normalized: {value:?}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_json_bytes, canonical_sha256, validate_absolute_posix_path,
        validate_git_sha, validate_repo_path, validate_sha256, validate_stable_id,
    };
    use serde_json::json;
    use std::fs;

    #[test]
    fn canonicalization_sorts_recursive_keys_and_retains_array_order() {
        let value = json!({
            "z": 0,
            "nested": {"z": [3, 2, 1], "a": "é"},
            "a": 1,
        });

        assert_eq!(
            canonical_json_bytes(&value).unwrap(),
            "{\"a\":1,\"nested\":{\"a\":\"é\",\"z\":[3,2,1]},\"z\":0}\n".as_bytes()
        );
    }

    #[test]
    fn canonicalization_uses_one_trailing_line_feed_and_stable_sha256() {
        let value = json!({"b": 2, "a": 1});

        assert_eq!(canonical_json_bytes(&value).unwrap(), b"{\"a\":1,\"b\":2}\n");
        assert_eq!(
            canonical_sha256(&value).unwrap(),
            "e8d38819d39f705646bfb643368eca78f7db476c16471dbc33b941b27326410d"
        );
    }

    #[test]
    fn canonicalization_rejects_floating_point_numbers_at_any_depth() {
        let error = canonical_json_bytes(&json!({"nested": [1, 1.5]})).unwrap_err();

        assert!(error.contains("integer"), "unexpected error: {error}");
    }

    #[test]
    fn digest_validators_require_full_lowercase_hex() {
        let sha256 = "a".repeat(64);
        let git_sha = "b".repeat(40);

        assert!(validate_sha256(&sha256).is_ok());
        assert!(validate_git_sha(&git_sha).is_ok());
        for invalid in ["a".repeat(63), "A".repeat(64), "g".repeat(64)] {
            assert!(validate_sha256(&invalid).is_err(), "accepted {invalid}");
        }
        for invalid in ["b".repeat(39), "B".repeat(40), "z".repeat(40)] {
            assert!(validate_git_sha(&invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn stable_ids_are_bounded_lowercase_ascii_identifiers() {
        assert!(validate_stable_id("browser-main_shell.v1", "product").is_ok());

        for invalid in [
            "Browser-main-shell".to_string(),
            "-browser-main-shell".to_string(),
            "browser/main-shell".to_string(),
            "a".repeat(129),
            String::new(),
        ] {
            assert!(
                validate_stable_id(&invalid, "product").is_err(),
                "accepted {invalid:?}"
            );
        }
    }

    #[test]
    fn absolute_posix_paths_must_be_normalized() {
        assert!(validate_absolute_posix_path("/").is_ok());
        assert!(validate_absolute_posix_path("/tmp/work").is_ok());

        for invalid in [
            "tmp/work",
            "/tmp/../work",
            "/tmp/./work",
            "/tmp//work",
            "/tmp\\work",
            "/tmp\0work",
        ] {
            assert!(
                validate_absolute_posix_path(invalid).is_err(),
                "accepted {invalid:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn repository_paths_reject_escape_and_symlink_components() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("inputs")).unwrap();
        fs::write(root.path().join("inputs/file.txt"), b"input").unwrap();
        symlink("inputs/file.txt", root.path().join("link.txt")).unwrap();

        assert_eq!(
            validate_repo_path(root.path(), "inputs/file.txt").unwrap(),
            root.path().join("inputs/file.txt")
        );
        for invalid in [
            "../outside",
            "/absolute",
            "inputs/../inputs/file.txt",
            "inputs\\file.txt",
            "link.txt",
            "missing.txt",
        ] {
            assert!(
                validate_repo_path(root.path(), invalid).is_err(),
                "accepted {invalid:?}"
            );
        }
    }
}

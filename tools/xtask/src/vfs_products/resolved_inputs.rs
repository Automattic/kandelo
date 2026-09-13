//! The resolved-input document's envelope, validated with the rules this
//! repository already has.
//!
//! Ported from `images/vfs/scripts/vfs-product-builder-contract.ts`, and the
//! port is smaller than it looks: nearly every scalar rule the TypeScript
//! spells out by hand already exists next door in [`super::canonical_json`].
//! The job was never to write these rules — it was to stop a second copy
//! deciding.
//!
//! # And the second copy was the weaker one
//!
//! `assertNormalizedRelativePath` SPLITS on a backslash, treating `a\b` as two
//! components, and never looks for a NUL. [`validate_repo_path`] refuses both.
//! On POSIX `a\b` is one legal filename, so the two do not merely differ in
//! strictness — they disagree about what the path is. A document naming `a\0b`
//! passes the TypeScript and means `a` in the first C API that receives it.
//!
//! That gap is not patched in the TypeScript. It closes because the TypeScript
//! stops being the thing that decides.
//!
//! # Why `deny_unknown_fields` rather than a key-set check
//!
//! The TypeScript has an `exactRecord` helper that lists a record's permitted
//! keys and refuses any others — an unknown key is a document from a producer
//! this one does not understand, and accepting it silently means ignoring a
//! field that producer thought mattered. Serde says the same thing in an
//! attribute, and says it where the shape is declared rather than beside it.

use serde::Deserialize;

use super::canonical_json::{
    validate_git_sha, validate_repo_path, validate_sha256, validate_stable_id,
};
use std::path::Path;

/// Inputs one document may carry. Matches the TypeScript's `MAX_INPUTS`.
const MAX_INPUTS: usize = 4_096;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolvedInputsEnvelopeV1 {
    pub schema: u32,
    pub kind: String,
    pub product: ProductIdentityV1,
    pub target_abi: TargetAbiV1,
    pub build_environment: BuildEnvironmentV1,
    pub reference_class: String,
    pub source: ExactSourceV1,
    /// Kept opaque BEYOND its id. The per-input descriptor rules are the
    /// remainder of this port; validating the envelope first closes the
    /// document-level gaps without pretending to cover what it does not.
    pub inputs: Vec<ResolvedInputHeadV1>,
}

#[derive(Debug, Deserialize)]
pub struct ResolvedInputHeadV1 {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProductIdentityV1 {
    pub architecture: String,
    pub id: String,
    pub manifest_path: String,
    pub manifest_sha256: String,
    pub output: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetAbiV1 {
    pub version: u32,
    pub snapshot_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildEnvironmentV1 {
    pub policy_sha256: String,
    pub dev_shell_lock_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExactSourceV1 {
    pub repository: String,
    pub commit: String,
    pub tree: String,
}

/// Validate a resolved-input document's envelope.
///
/// `allow_local_fixture` mirrors the miniature builder's permission: a
/// `local-fixture` reference is a build that points at something outside the
/// exact-source world, and only one builder may ask for it.
pub fn validate_envelope(
    repository_root: &Path,
    document: &ResolvedInputsEnvelopeV1,
    allow_local_fixture: bool,
) -> Result<(), String> {
    if document.schema != 1 || document.kind != "kandelo-resolved-vfs-product-inputs" {
        return Err("resolved input document has unsupported identity".to_string());
    }

    match document.product.architecture.as_str() {
        "wasm32" | "wasm64" => {}
        other => return Err(format!("product architecture is not supported: {other:?}")),
    }
    validate_stable_id(&document.product.id, "product id")?;
    // THE RULE THE TYPESCRIPT GOT WRONG. Refuses a backslash rather than
    // splitting on it, and refuses a NUL rather than letting it truncate the
    // path later.
    validate_repo_path(repository_root, &document.product.manifest_path)?;
    validate_sha256(&document.product.manifest_sha256)?;
    validate_output_name(&document.product.output)?;

    // The TypeScript checks only that this is a non-negative integer, which
    // `u32` already guarantees — so deserialising it was the whole check and
    // the field went unread. Zero is not an ABI any build can target: versions
    // start at one and this repository is at forty-four. A document claiming
    // zero is malformed whatever the weaker rule allowed, and it is better to
    // say so here than to let it reach the comparison against each input's own
    // ABI, which is the remainder of this port.
    if document.target_abi.version == 0 {
        return Err("target ABI version 0 is not a version any build can target".to_string());
    }
    validate_sha256(&document.target_abi.snapshot_sha256)?;
    validate_sha256(&document.build_environment.policy_sha256)?;
    validate_sha256(&document.build_environment.dev_shell_lock_sha256)?;

    validate_repository_identity(&document.source.repository)?;
    validate_git_sha(&document.source.commit)?;
    validate_git_sha(&document.source.tree)?;

    match document.reference_class.as_str() {
        "candidate" | "canonical" => {}
        "local-fixture" if allow_local_fixture => {}
        "local-fixture" => {
            return Err(
                "local-fixture references are accepted only by the miniature builder".to_string(),
            )
        }
        other => return Err(format!("reference class is not supported: {other:?}")),
    }

    if document.inputs.len() > MAX_INPUTS {
        return Err(format!(
            "resolved inputs must be an array with at most {MAX_INPUTS} entries"
        ));
    }
    // Sorted AND unique in one comparison. Sorting alone would allow a repeated
    // id; uniqueness alone would allow an order that two producers could write
    // differently for the same set, which is what makes a document's digest
    // depend on who wrote it rather than on what it says.
    for pair in document.inputs.windows(2) {
        if pair[0].id >= pair[1].id {
            return Err("resolved inputs must be sorted by unique stable input id".to_string());
        }
    }
    for input in &document.inputs {
        validate_stable_id(&input.id, "resolved input id")?;
    }
    Ok(())
}

/// Read a resolved-input document and validate its envelope.
///
/// The entry point the builder calls instead of deciding for itself. It reports
/// the first rule that refused and which field refused it, because "this
/// document is invalid" is not a sentence anyone can act on.
pub fn validate_document(
    repository_root: &Path,
    path: &Path,
    allow_local_fixture: bool,
) -> Result<(), String> {
    let bytes = std::fs::read(path)
        .map_err(|e| format!("resolved inputs: read {}: {e}", path.display()))?;
    let document: ResolvedInputsEnvelopeV1 = serde_json::from_slice(&bytes)
        .map_err(|e| format!("resolved inputs: {}: {e}", path.display()))?;
    validate_envelope(repository_root, &document, allow_local_fixture)
        .map_err(|e| format!("resolved inputs: {}: {e}", path.display()))
}

/// The product's output filename: a name, never a path.
fn validate_output_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 255
        || value.contains(['/', '\\', '\0'])
        || matches!(value, "." | "..")
        || !(value.ends_with(".vfs") || value.ends_with(".vfs.zst"))
    {
        return Err(format!("product output is not an ABI-neutral VFS filename: {value:?}"));
    }
    Ok(())
}

/// `owner/name`, and nothing else.
fn validate_repository_identity(value: &str) -> Result<(), String> {
    let mut parts = value.split('/');
    let ok = matches!((parts.next(), parts.next(), parts.next()), (Some(o), Some(n), None)
        if !o.is_empty()
            && !n.is_empty()
            && o.bytes().all(is_identity_byte)
            && n.bytes().all(is_identity_byte));
    if !ok {
        return Err("source repository must be an exact owner/name identity".to_string());
    }
    Ok(())
}

fn is_identity_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(overrides: &str) -> serde_json::Value {
        let mut base: serde_json::Value = serde_json::json!({
            "schema": 1,
            "kind": "kandelo-resolved-vfs-product-inputs",
            "product": {
                "architecture": "wasm32",
                "id": "shell",
                "manifest_path": "images/vfs/products/shell.json",
                "manifest_sha256": "a".repeat(64),
                "output": "shell.vfs",
            },
            "target_abi": { "version": 44, "snapshot_sha256": "b".repeat(64) },
            "build_environment": {
                "policy_sha256": "c".repeat(64),
                "dev_shell_lock_sha256": "d".repeat(64),
            },
            "reference_class": "canonical",
            "source": {
                "repository": "kandelo-dev/kandelo",
                "commit": "e".repeat(40),
                "tree": "f".repeat(40),
            },
            "inputs": [],
        });
        if !overrides.is_empty() {
            let patch: serde_json::Value = serde_json::from_str(overrides).expect("patch");
            merge(&mut base, &patch);
        }
        base
    }

    fn merge(target: &mut serde_json::Value, patch: &serde_json::Value) {
        match (target, patch) {
            (serde_json::Value::Object(t), serde_json::Value::Object(p)) => {
                for (key, value) in p {
                    merge(t.entry(key.clone()).or_insert(serde_json::Value::Null), value);
                }
            }
            (t, p) => *t = p.clone(),
        }
    }

    /// A repository root holding the manifest the document names.
    ///
    /// `validate_repo_path` checks that the path RESOLVES, not only that its
    /// shape is safe — which is stronger than the TypeScript rule it replaces,
    /// and worth the fixture: a document naming a manifest that is not there
    /// is a document that cannot be built from, and finding that out at
    /// validation beats finding it out halfway through a build.
    struct Repo(std::path::PathBuf);

    impl Repo {
        fn new() -> Self {
            let dir = std::env::temp_dir()
                .join(format!("xtask-resolved-{}-{:?}", std::process::id(), std::thread::current().id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("images/vfs/products")).expect("fixture root");
            std::fs::write(dir.join("images/vfs/products/shell.json"), b"{}").expect("manifest");
            Self(dir)
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn check(value: &serde_json::Value) -> Result<(), String> {
        let repo = Repo::new();
        let parsed: ResolvedInputsEnvelopeV1 =
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        validate_envelope(&repo.0, &parsed, false)
    }

    #[test]
    fn a_well_formed_envelope_is_accepted() {
        check(&document("")).expect("accepted");
    }

    #[test]
    fn a_manifest_path_with_a_backslash_is_refused() {
        // THE DIVERGENCE THIS PORT EXISTS TO END. The TypeScript splits on the
        // backslash, so `a\b` becomes two components and passes. On POSIX that
        // is ONE legal filename, so accepting it means the two implementations
        // disagree about what the path is rather than how strict to be.
        let error = check(&document(r#"{"product":{"manifest_path":"images\\shell.json"}}"#))
            .expect_err("refused");
        assert!(error.contains("not normalized"), "{error}");
    }

    #[test]
    fn a_manifest_path_with_a_NUL_is_refused() {
        // The TypeScript never looks for one. A path carrying a NUL validates
        // there and means everything before the NUL in the first C API that
        // receives it — so the document says one thing and the filesystem does
        // another.
        let error = check(&document("{\"product\":{\"manifest_path\":\"images/sh\\u0000ell.json\"}}"))
            .expect_err("refused");
        assert!(error.contains("not normalized"), "{error}");
    }

    #[test]
    fn a_traversing_or_absolute_manifest_path_is_refused() {
        for path in ["../outside.json", "/etc/passwd", "images/./shell.json", ""] {
            let patch = format!(r#"{{"product":{{"manifest_path":{path:?}}}}}"#);
            assert!(check(&document(&patch)).is_err(), "{path:?} must be refused");
        }
    }

    #[test]
    fn an_unknown_field_is_refused_rather_than_ignored() {
        // An unknown key is a document from a producer this one does not
        // understand. Ignoring it means ignoring a field that producer thought
        // mattered, which is how two builds agree on a document and disagree
        // about what it asked for.
        let mut value = document("");
        value["product"]["surprise"] = serde_json::json!("value");
        assert!(check(&value).is_err());
    }

    #[test]
    fn inputs_must_be_sorted_and_unique_by_id() {
        // One comparison for both. Sorting alone would allow a repeated id;
        // uniqueness alone would allow two producers to write the same set in
        // different orders, which makes a document's digest depend on who
        // wrote it rather than on what it says.
        let sorted = document(r#"{"inputs":[{"id":"alpha"},{"id":"beta"}]}"#);
        check(&sorted).expect("sorted and unique");

        for bad in [
            r#"{"inputs":[{"id":"beta"},{"id":"alpha"}]}"#,
            r#"{"inputs":[{"id":"alpha"},{"id":"alpha"}]}"#,
        ] {
            assert!(check(&document(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_local_fixture_reference_needs_the_miniature_builder() {
        let value = document(r#"{"reference_class":"local-fixture"}"#);
        let repo = Repo::new();
        let parsed: ResolvedInputsEnvelopeV1 =
            serde_json::from_value(value).expect("parses");
        assert!(validate_envelope(&repo.0, &parsed, false).is_err());
        validate_envelope(&repo.0, &parsed, true).expect("the miniature builder may");
    }

    #[test]
    fn an_output_that_is_a_path_or_the_wrong_kind_of_file_is_refused() {
        for output in ["../shell.vfs", "dir/shell.vfs", "shell.tar", "", "."] {
            let patch = format!(r#"{{"product":{{"output":{output:?}}}}}"#);
            assert!(check(&document(&patch)).is_err(), "{output:?} must be refused");
        }
        check(&document(r#"{"product":{"output":"shell.vfs.zst"}}"#)).expect("compressed is fine");
    }

    #[test]
    fn an_abi_version_of_zero_is_refused() {
        assert!(check(&document(r#"{"target_abi":{"version":0}}"#)).is_err());
        check(&document(r#"{"target_abi":{"version":44}}"#)).expect("a real ABI");
    }

    #[test]
    fn a_source_repository_must_be_exactly_owner_and_name() {
        for repository in ["kandelo", "a/b/c", "/b", "a/", "a b/c", ""] {
            let patch = format!(r#"{{"source":{{"repository":{repository:?}}}}}"#);
            assert!(check(&document(&patch)).is_err(), "{repository:?} must be refused");
        }
    }
}

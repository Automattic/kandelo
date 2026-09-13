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
    validate_git_sha, validate_repo_path_shape, validate_sha256, validate_stable_id,
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
    /// Each judged by [`validate_input`], except for the reference, descriptor
    /// and path fields, which are the remainder of this port.
    pub inputs: Vec<ResolvedInputV1>,
}

/// One resolved input, as far as this port has reached.
///
/// `descriptor`, `path` and `reference` are accepted but NOT yet judged here —
/// they carry URL and OCI-reference parsing and local-file resolution, which is
/// the remainder of this port. They are declared so `deny_unknown_fields` still
/// refuses a field nobody recognises, which is the check that must not wait.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolvedInputV1 {
    pub id: String,
    pub kind: String,
    pub role: String,
    pub architecture: String,
    pub declared_materialization: String,
    pub effective_materialization: String,
    pub sha256: String,
    // DECLARED BUT NOT YET JUDGED, and the declaration is doing real work even
    // so: `deny_unknown_fields` refuses a field nobody recognises, and it can
    // only do that for fields it knows about. Omitting these would turn every
    // document carrying them into a parse error.
    //
    // `bytes` is read by the reference check — a reference names a digest AND a
    // length, and a length nothing compares against is a length that can lie.
    // `bytes` is read by the scheme-specific reference rules — a Pages URL
    // carries the length as well as the digest, and a length nothing compares
    // against is a length that can lie. Those rules are what remain of this
    // port.
    #[allow(dead_code)]
    pub bytes: u64,
    #[serde(default)]
    pub descriptor: Option<InputDescriptorV1>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub reference: Option<String>,
}

/// A package output's descriptor: the metadata file that describes it.
///
/// Declared with `deny_unknown_fields` for the same reason as everything else
/// here — a key nobody recognises is a document from a producer this one does
/// not understand.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputDescriptorV1 {
    pub sha256: String,
    #[allow(dead_code)]
    pub bytes: u64,
    pub path: String,
    pub reference: String,
}

const INPUT_KINDS: [&str; 5] = [
    "product-image",
    "package-output",
    "source-archive",
    "toolchain-output",
    "repository-path",
];

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
    //
    // SHAPE ONLY, deliberately. The existence-checking variant would also
    // require the manifest to be present, and "is this document well formed" is
    // a different question from "are the things it names here" — conflating
    // them means a document cannot be validated without the whole repository
    // around it, which is exactly what a producer-side or CI schema check
    // wants to do. Whoever READS the manifest checks it resolves, at the point
    // of reading.
    validate_repo_path_shape(&document.product.manifest_path)?;
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
    for (index, input) in document.inputs.iter().enumerate() {
        validate_input(input, &document.product.architecture, &format!("resolved input {index}"))?;
    }
    Ok(())
}

/// Read a resolved-input document and validate its envelope.
///
/// The entry point the builder calls instead of deciding for itself. It reports
/// the first rule that refused and which field refused it, because "this
/// document is invalid" is not a sentence anyone can act on.
pub fn validate_document(path: &Path, allow_local_fixture: bool) -> Result<(), String> {
    let bytes = std::fs::read(path)
        .map_err(|e| format!("resolved inputs: read {}: {e}", path.display()))?;
    let document: ResolvedInputsEnvelopeV1 = serde_json::from_slice(&bytes)
        .map_err(|e| format!("resolved inputs: {}: {e}", path.display()))?;
    validate_envelope(&document, allow_local_fixture)
        .map_err(|e| format!("resolved inputs: {}: {e}", path.display()))
}

/// Judge one resolved input.
///
/// # The role and materialization matrix
///
/// Three fields describe how an input arrives, and only three combinations mean
/// anything:
///
/// * a RUNTIME input declared `embedded` must arrive `embedded`;
/// * a RUNTIME input declared `lazy` may arrive `lazy-reference` OR `embedded`
///   — a lazy input that was materialised anyway is still a correct build;
/// * a BUILD input is `build-only` on both sides, because it never reaches the
///   image at all.
///
/// Every other pairing is a document describing something that cannot happen:
/// a build-only input that is embedded would put a toolchain in the product, and
/// an embedded declaration arriving as a lazy reference would produce an image
/// missing bytes it promised. Checking the fields SEPARATELY, as a schema does,
/// accepts every one of those.
fn validate_input(
    input: &ResolvedInputV1,
    product_architecture: &str,
    label: &str,
) -> Result<(), String> {
    validate_stable_id(&input.id, label)?;
    if !INPUT_KINDS.contains(&input.kind.as_str()) {
        return Err(format!("{label} kind is not supported: {:?}", input.kind));
    }
    if !matches!(input.role.as_str(), "runtime" | "build") {
        return Err(format!("{label} role is not supported: {:?}", input.role));
    }
    if !matches!(input.architecture.as_str(), "wasm32" | "wasm64") {
        return Err(format!(
            "{label} architecture is not supported: {:?}",
            input.architecture
        ));
    }
    // An input built for another architecture is not a smaller problem than a
    // missing one: it would link, and then not run.
    if input.architecture != product_architecture {
        return Err(format!("{label} architecture does not match product architecture"));
    }

    let combination = (
        input.role.as_str(),
        input.declared_materialization.as_str(),
        input.effective_materialization.as_str(),
    );
    let valid = matches!(
        combination,
        ("runtime", "embedded", "embedded")
            | ("runtime", "lazy", "lazy-reference")
            | ("runtime", "lazy", "embedded")
            | ("build", "build-only", "build-only")
    );
    if !valid {
        return Err(format!("{label} has inconsistent role and materialization"));
    }

    validate_sha256(&input.sha256)?;
    if let Some(reference) = &input.reference {
        validate_reference_binds_digest(reference, &input.sha256, label)?;
    }
    if let Some(path) = &input.path {
        // Shape only. Whether the file is THERE is the builder's question,
        // asked where the file is read.
        validate_repo_path_shape(path)
            .map_err(|e| format!("{label} path: {e}"))?;
    }

    // A DESCRIPTOR BELONGS TO A PACKAGE OUTPUT AND NOTHING ELSE. Accepting one
    // elsewhere would mean carrying package metadata for something that is not
    // a package — metadata nothing validates against the thing it describes,
    // because there is no package to describe.
    match (&input.descriptor, input.kind.as_str()) {
        (Some(_), "package-output") => {}
        (Some(_), other) => {
            return Err(format!("{label} descriptor is only valid for package outputs, not {other}"))
        }
        (None, _) => return Ok(()),
    }
    let descriptor = input.descriptor.as_ref().expect("matched Some above");
    validate_sha256(&descriptor.sha256)
        .map_err(|e| format!("{label} descriptor: {e}"))?;
    validate_repo_path_shape(&descriptor.path)
        .map_err(|e| format!("{label} descriptor path: {e}"))?;
    // The descriptor's reference binds the DESCRIPTOR's digest, not the
    // input's. They are different files: one is a package, the other is the
    // metadata describing it, and a reference that bound the wrong one would
    // fetch the wrong bytes and verify them happily.
    validate_reference_binds_digest(
        &descriptor.reference,
        &descriptor.sha256,
        &format!("{label} descriptor"),
    )?;
    Ok(())
}

/// A reference must name the bytes it refers to, and name them immutably.
///
/// This is the rule applied to EVERY reference before any scheme-specific one:
/// whatever the transport, the reference has to carry the digest of the thing
/// it points at, either as `sha256:<digest>` or `sha256=<digest>`. A reference
/// that does not is a reference to "whatever is at this address today", and the
/// whole point of an exact-source build is that the answer cannot change
/// between the resolve and the build.
///
/// Whitespace is refused rather than trimmed. A reference is handed to a
/// fetcher, and a space in a URL is either a typo or an attempt to make two
/// readers disagree about where it points.
///
/// The scheme-specific rules — the Pages URL shapes, the OCI form, the
/// local-fixture form, each binding the input id, the byte count and the ABI
/// version as well — are the remainder of this port.
fn validate_reference_binds_digest(
    reference: &str,
    digest: &str,
    label: &str,
) -> Result<(), String> {
    if reference.len() > 4_096 {
        return Err(format!("{label} reference exceeds 4096 bytes"));
    }
    if reference.chars().any(char::is_whitespace) {
        return Err(format!("{label} reference contains whitespace"));
    }
    if !reference.contains(&format!("sha256:{digest}"))
        && !reference.contains(&format!("sha256={digest}"))
    {
        return Err(format!(
            "{label} reference is not immutable or does not bind its SHA-256"
        ));
    }
    Ok(())
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


    /// A minimal valid input. Named fields rather than a literal so a test
    /// that changes ONE of them says which one it is changing.
    fn input(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "kind": "package-output",
            "role": "runtime",
            "architecture": "wasm32",
            "declared_materialization": "embedded",
            "effective_materialization": "embedded",
            "sha256": "a".repeat(64),
            "bytes": 12,
        })
    }

    fn check(value: &serde_json::Value) -> Result<(), String> {
        let parsed: ResolvedInputsEnvelopeV1 =
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        validate_envelope(&parsed, false)
    }

    #[test]
    fn a_well_formed_envelope_is_accepted() {
        check(&document("")).expect("accepted");
    }

    #[test]
    fn a_document_must_say_what_it_is_before_anything_else_is_read() {
        // The identity check refuses a document this builder does not
        // understand. Without it, a future schema would be validated against
        // THIS schema's rules and either refused for the wrong reason or — far
        // worse — accepted because the fields happened to overlap.
        assert!(check(&document(r#"{"schema":2}"#)).is_err(), "a future schema");
        assert!(
            check(&document(r#"{"kind":"kandelo-something-else"}"#)).is_err(),
            "a document of another kind",
        );
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
        let mut sorted = document("");
        sorted["inputs"] = serde_json::json!([input("alpha"), input("beta")]);
        check(&sorted).expect("sorted and unique");

        let mut unsorted = document("");
        unsorted["inputs"] = serde_json::json!([input("beta"), input("alpha")]);
        assert!(check(&unsorted).is_err(), "out of order");

        let mut duplicated = document("");
        duplicated["inputs"] = serde_json::json!([input("alpha"), input("alpha")]);
        assert!(check(&duplicated).is_err(), "repeated id");
    }

    #[test]
    fn an_input_list_beyond_its_bound_is_refused() {
        // Cheap to build and therefore cheap to test — which is the argument
        // for testing it rather than trusting the constant. A bound only ever
        // exercised by not being hit is a bound nobody has checked.
        let ids: Vec<serde_json::Value> = (0..=MAX_INPUTS)
            .map(|index| input(&format!("input-{index:06}")))
            .collect();
        let mut value = document("");
        value["inputs"] = serde_json::Value::Array(ids);
        assert!(check(&value).is_err(), "{} inputs must be refused", MAX_INPUTS + 1);

        // And exactly at the bound it is accepted, so the refusal is the
        // boundary rather than a smaller number nobody wrote down.
        let ids: Vec<serde_json::Value> = (0..MAX_INPUTS)
            .map(|index| input(&format!("input-{index:06}")))
            .collect();
        let mut value = document("");
        value["inputs"] = serde_json::Value::Array(ids);
        check(&value).expect("exactly at the bound");
    }

    fn with_input(patch: serde_json::Value) -> serde_json::Value {
        let mut base = input("only");
        merge(&mut base, &patch);
        let mut value = document("");
        value["inputs"] = serde_json::json!([base]);
        value
    }

    #[test]
    fn only_three_role_and_materialization_combinations_mean_anything() {
        // Checking these fields SEPARATELY, as a schema does, accepts every
        // nonsensical pairing: a build-only input that is embedded would put a
        // toolchain inside the product, and an embedded declaration arriving as
        // a lazy reference would produce an image missing bytes it promised.
        for (role, declared, effective) in [
            ("runtime", "embedded", "embedded"),
            ("runtime", "lazy", "lazy-reference"),
            // A lazy input that was materialised anyway is still a correct
            // build, which is why this pairing is permitted and its mirror is
            // not.
            ("runtime", "lazy", "embedded"),
            ("build", "build-only", "build-only"),
        ] {
            let value = with_input(serde_json::json!({
                "role": role,
                "declared_materialization": declared,
                "effective_materialization": effective,
            }));
            check(&value).unwrap_or_else(|e| panic!("{role}/{declared}/{effective}: {e}"));
        }

        for (role, declared, effective) in [
            ("runtime", "embedded", "lazy-reference"),
            // A LAZY declaration is permitted two arrivals, not any arrival.
            // Without this case the whole `lazy` row could be widened to a
            // wildcard and every test would still pass — a runtime input that
            // arrives `build-only` is not in the image at all, which is the
            // opposite of what declaring it lazy asked for.
            ("runtime", "lazy", "build-only"),
            ("runtime", "build-only", "build-only"),
            ("build", "embedded", "embedded"),
            ("build", "build-only", "embedded"),
            ("build", "lazy", "lazy-reference"),
        ] {
            let value = with_input(serde_json::json!({
                "role": role,
                "declared_materialization": declared,
                "effective_materialization": effective,
            }));
            assert!(check(&value).is_err(), "{role}/{declared}/{effective} must be refused");
        }
    }

    fn descriptor(digest: &str) -> serde_json::Value {
        serde_json::json!({
            "sha256": digest,
            "bytes": 40,
            "path": "files/metadata.json",
            "reference": format!("oci://example.invalid/meta@sha256:{digest}"),
        })
    }

    #[test]
    fn a_descriptor_belongs_to_a_package_output_and_nothing_else() {
        let digest = "c".repeat(64);

        let value = with_input(serde_json::json!({
            "kind": "package-output",
            "descriptor": descriptor(&digest),
        }));
        check(&value).expect("a package output may carry one");

        // Anywhere else it is metadata describing nothing, which nothing can
        // validate against the thing it claims to describe.
        for kind in ["product-image", "source-archive", "toolchain-output", "repository-path"] {
            let value = with_input(serde_json::json!({
                "kind": kind,
                "descriptor": descriptor(&digest),
            }));
            assert!(check(&value).is_err(), "{kind} must not carry a descriptor");
        }
    }

    #[test]
    fn a_descriptors_reference_binds_the_DESCRIPTORS_digest_not_the_inputs() {
        // They are different files: one is a package, the other is the
        // metadata describing it. A reference binding the input's digest would
        // fetch the package when asked for the metadata, and verify it happily.
        let descriptor_digest = "c".repeat(64);
        let input_digest = "a".repeat(64);

        let mut wrong = descriptor(&descriptor_digest);
        wrong["reference"] =
            serde_json::json!(format!("oci://example.invalid/meta@sha256:{input_digest}"));
        let value = with_input(serde_json::json!({
            "kind": "package-output",
            "descriptor": wrong,
        }));
        assert!(check(&value).is_err(), "bound the wrong file's digest");
    }

    #[test]
    fn a_descriptor_path_and_an_input_path_are_both_shape_checked() {
        for patch in [
            serde_json::json!({ "path": "files/../../escape" }),
            serde_json::json!({ "path": "files\\escape" }),
            serde_json::json!({
                "kind": "package-output",
                "descriptor": {
                    "sha256": "c".repeat(64),
                    "bytes": 40,
                    "path": "../escape",
                    "reference": format!("oci://x/y@sha256:{}", "c".repeat(64)),
                },
            }),
        ] {
            assert!(check(&with_input(patch.clone())).is_err(), "{patch}");
        }
    }

    #[test]
    fn a_descriptor_field_nobody_recognises_is_refused() {
        let mut extra = descriptor(&"c".repeat(64));
        extra["surprise"] = serde_json::json!("value");
        let value = with_input(serde_json::json!({
            "kind": "package-output",
            "descriptor": extra,
        }));
        assert!(check(&value).is_err());
    }

    #[test]
    fn a_reference_must_bind_the_digest_of_what_it_points_at() {
        let digest = "a".repeat(64);

        // Both spellings, because both are in use: a path segment and a query
        // parameter bind the same way.
        for good in [
            format!("oci://example.invalid/thing@sha256:{digest}"),
            format!("https://example.invalid/thing.vfs?sha256={digest}&bytes=12"),
        ] {
            let value = with_input(serde_json::json!({ "reference": good }));
            check(&value).unwrap_or_else(|e| panic!("{good}: {e}"));
        }

        // A reference to "whatever is at this address today" is the thing an
        // exact-source build exists to make impossible.
        let value = with_input(serde_json::json!({
            "reference": "https://example.invalid/latest.vfs",
        }));
        assert!(check(&value).is_err(), "no digest at all");

        // A digest that is not THIS input's digest binds someone else's bytes.
        let value = with_input(serde_json::json!({
            "reference": format!("oci://example.invalid/thing@sha256:{}", "b".repeat(64)),
        }));
        assert!(check(&value).is_err(), "another input's digest");

        // Whitespace is refused rather than trimmed: in a URL it is either a
        // typo or an attempt to make two readers disagree about the target.
        let value = with_input(serde_json::json!({
            "reference": format!("oci://example.invalid/thing @sha256:{digest}"),
        }));
        assert!(check(&value).is_err(), "embedded whitespace");

        let value = with_input(serde_json::json!({
            "reference": format!("{}#sha256:{digest}", "x".repeat(4_097)),
        }));
        assert!(check(&value).is_err(), "beyond the length bound");
    }

    #[test]
    fn an_inputs_digest_must_be_a_digest() {
        // Every other test hands over a well-formed sha256, so the check that
        // rejects a malformed one was defended by nothing. An input's digest is
        // the only thing tying the bytes that arrive to the bytes that were
        // promised.
        for bad in ["", "a".repeat(63).as_str(), "a".repeat(65).as_str(), "A".repeat(64).as_str(), "z".repeat(64).as_str()] {
            let value = with_input(serde_json::json!({ "sha256": bad }));
            assert!(check(&value).is_err(), "{bad:?} is not a sha256");
        }
    }

    #[test]
    fn an_input_built_for_another_architecture_is_refused() {
        // Not a smaller problem than a missing input: it would link, and then
        // not run.
        let value = with_input(serde_json::json!({ "architecture": "wasm64" }));
        assert!(check(&value).is_err());
    }

    #[test]
    fn an_input_field_nobody_recognises_is_refused() {
        let value = with_input(serde_json::json!({ "surprise": "value" }));
        assert!(check(&value).is_err());
    }

    #[test]
    fn an_input_of_an_unknown_kind_is_refused() {
        let value = with_input(serde_json::json!({ "kind": "something-else" }));
        assert!(check(&value).is_err());
        for kind in INPUT_KINDS {
            let value = with_input(serde_json::json!({ "kind": kind }));
            check(&value).unwrap_or_else(|e| panic!("{kind}: {e}"));
        }
    }

    #[test]
    fn a_local_fixture_reference_needs_the_miniature_builder() {
        let value = document(r#"{"reference_class":"local-fixture"}"#);
        let parsed: ResolvedInputsEnvelopeV1 =
            serde_json::from_value(value).expect("parses");
        assert!(validate_envelope(&parsed, false).is_err());
        validate_envelope(&parsed, true).expect("the miniature builder may");
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

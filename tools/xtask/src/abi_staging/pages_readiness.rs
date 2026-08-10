use crate::abi_staging::canonical_json::{
    canonical_json_bytes, validate_git_sha, validate_sha256, validate_stable_id,
};
use crate::abi_staging::guard_registry::GuardCodeV1;
use crate::abi_staging::records::{
    PagesEvidenceReceiptLinkV1, PagesFileIdentityV1, PagesReadinessRecordV1, PagesReadyProductV1,
    PagesRegistryIdentityV1, PagesSiteManifestV1, PagesSiteProductV1,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path};

const READINESS_KIND: &str = "kandelo-pages-readiness";
const SITE_KIND: &str = "kandelo-pages-site-manifest";
const ACTIVATION_KIND: &str = "kandelo-pages-activation";
const MAX_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_PRODUCTS: usize = 4_096;
const MAX_FILES: usize = 65_536;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PagesActivationModeV1 {
    Legacy,
    Observe,
    Active,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PagesActivationDocumentV1 {
    schema: u64,
    kind: String,
    mode: String,
}

pub fn parse_pages_activation(bytes: &[u8]) -> Result<PagesActivationModeV1, String> {
    if bytes.len() > 64 * 1024 {
        return Err("Pages activation document exceeds 64 KiB".to_string());
    }
    let document: PagesActivationDocumentV1 = toml::from_str(
        std::str::from_utf8(bytes)
            .map_err(|error| format!("Pages activation is not UTF-8: {error}"))?,
    )
    .map_err(|error| format!("Pages activation is invalid TOML: {error}"))?;
    if document.schema != 1 || document.kind != ACTIVATION_KIND {
        return Err("Pages activation has unsupported identity".to_string());
    }
    match document.mode.as_str() {
        "legacy" => Ok(PagesActivationModeV1::Legacy),
        "observe" => Ok(PagesActivationModeV1::Observe),
        "active" => Ok(PagesActivationModeV1::Active),
        mode => Err(format!("Pages activation mode {mode:?} is unsupported")),
    }
}

pub fn validate_pages_readiness_bytes(bytes: &[u8]) -> Result<PagesReadinessRecordV1, String> {
    let record: PagesReadinessRecordV1 = parse_canonical(bytes, "Pages readiness record")?;
    reject_candidate_namespace(&record, "Pages readiness record")?;
    validate_readiness(&record)?;
    Ok(record)
}

pub fn validate_pages_site_manifest_bytes(bytes: &[u8]) -> Result<PagesSiteManifestV1, String> {
    let manifest: PagesSiteManifestV1 = parse_canonical(bytes, "Pages site manifest")?;
    reject_candidate_namespace(&manifest, "Pages site manifest")?;
    validate_site_manifest(&manifest)?;
    Ok(manifest)
}

fn parse_canonical<T>(bytes: &[u8], label: &str) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Serialize,
{
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(format!("{label} exceeds 16 MiB"));
    }
    let value: T = serde_json::from_slice(bytes)
        .map_err(|error| format!("{label} is invalid JSON: {error}"))?;
    if canonical_json_bytes(&value)? != bytes {
        return Err(format!("{label} is not canonical JSON"));
    }
    Ok(value)
}

fn validate_readiness(record: &PagesReadinessRecordV1) -> Result<(), String> {
    if record.schema != 1 || record.kind != READINESS_KIND {
        return Err("Pages readiness record has unsupported identity".to_string());
    }
    validate_source(
        &record.source.repository,
        &record.source.commit,
        &record.source.tree,
    )?;
    validate_target(
        record.target_abi.version,
        &record.target_abi.snapshot_sha256,
    )?;
    validate_registry(&record.pages_registry)?;
    validate_sha256(&record.site_metadata_sha256)?;
    if record.products.len() > MAX_PRODUCTS || record.blockers.len() > MAX_PRODUCTS {
        return Err("Pages readiness record exceeds its bounded product set".to_string());
    }

    let registry = record
        .pages_registry
        .products
        .iter()
        .map(|product| (product.id.as_str(), product.load))
        .collect::<BTreeMap<_, _>>();
    let mut previous_product: Option<&str> = None;
    for product in &record.products {
        validate_ready_product(product, record.target_abi.version)?;
        if previous_product.is_some_and(|previous| previous >= product.id.as_str()) {
            return Err("Pages readiness products must be sorted and duplicate-free".to_string());
        }
        previous_product = Some(&product.id);
        match registry.get(product.id.as_str()) {
            Some(load) if *load == product.load => {}
            Some(_) => {
                return Err(format!(
                    "Pages product {} has the wrong load mode",
                    product.id
                ));
            }
            None => {
                return Err(format!(
                    "Pages product {} is not in the Pages registry",
                    product.id
                ));
            }
        }
    }
    for blocker in &record.blockers {
        validate_stable_id(&blocker.kind, "Pages blocker kind")?;
        if blocker.guard_code != GuardCodeV1::PagesProductIncomplete {
            return Err("Pages blocker must use pages_product_incomplete".to_string());
        }
        if blocker.detail.is_empty() || blocker.detail.len() > 4_096 {
            return Err("Pages blocker detail must be bounded and nonempty".to_string());
        }
        if let Some(product_id) = &blocker.product_id {
            validate_stable_id(product_id, "Pages blocker product id")?;
            if !registry.contains_key(product_id.as_str()) {
                return Err("Pages blocker names a product outside the registry".to_string());
            }
        }
    }

    if record.ready {
        if !record.blockers.is_empty() {
            return Err("ready Pages record cannot contain blockers".to_string());
        }
        let actual = record
            .products
            .iter()
            .map(|product| product.id.as_str())
            .collect::<Vec<_>>();
        let expected = record
            .pages_registry
            .products
            .iter()
            .map(|product| product.id.as_str())
            .collect::<Vec<_>>();
        if actual != expected {
            return Err(
                "ready Pages record must contain the complete Pages product set".to_string(),
            );
        }
    } else if record.blockers.is_empty() {
        return Err("held readiness requires at least one real blocker".to_string());
    }
    Ok(())
}

fn validate_site_manifest(manifest: &PagesSiteManifestV1) -> Result<(), String> {
    if manifest.schema != 1 || manifest.kind != SITE_KIND {
        return Err("Pages site manifest has unsupported identity".to_string());
    }
    validate_source(
        &manifest.source.repository,
        &manifest.source.commit,
        &manifest.source.tree,
    )?;
    validate_target(
        manifest.target_abi.version,
        &manifest.target_abi.snapshot_sha256,
    )?;
    validate_registry(&manifest.pages_registry)?;
    validate_sha256(&manifest.site_metadata_sha256)?;
    validate_sha256(&manifest.readiness_record_sha256)?;
    if manifest.products.len() > MAX_PRODUCTS || manifest.files.len() > MAX_FILES {
        return Err("Pages site manifest exceeds its bounded inventory".to_string());
    }
    let expected_products = manifest
        .pages_registry
        .products
        .iter()
        .map(|product| (product.id.as_str(), product.load))
        .collect::<BTreeMap<_, _>>();
    let mut previous_product: Option<&str> = None;
    for product in &manifest.products {
        validate_site_product(product, manifest.target_abi.version)?;
        if previous_product.is_some_and(|previous| previous >= product.id.as_str()) {
            return Err("Pages site products must be sorted and duplicate-free".to_string());
        }
        previous_product = Some(&product.id);
        match expected_products.get(product.id.as_str()) {
            Some(load) if *load == product.load => {}
            _ => {
                return Err(
                    "Pages site does not contain the complete Pages product set".to_string()
                );
            }
        }
    }
    if manifest.products.len() != expected_products.len() {
        return Err("Pages site does not contain the complete Pages product set".to_string());
    }

    let files = validate_file_inventory(&manifest.files)?;
    for build in [
        &manifest.builds.api,
        &manifest.builds.browser,
        &manifest.builds.documentation,
    ] {
        validate_file_identity(build)?;
        require_inventory_identity(&files, build, "Pages build")?;
    }
    for product in &manifest.products {
        let identity = PagesFileIdentityV1 {
            path: product.path.clone(),
            sha256: product.vfs_sha256.clone(),
            bytes: product.vfs_bytes,
        };
        require_inventory_identity(&files, &identity, "Pages product")?;
    }
    Ok(())
}

fn validate_registry(registry: &PagesRegistryIdentityV1) -> Result<(), String> {
    validate_relative_path(&registry.path, "Pages registry path")?;
    validate_sha256(&registry.sha256)?;
    if registry.products.is_empty() || registry.products.len() > MAX_PRODUCTS {
        return Err(
            "Pages registry identity must contain a bounded nonempty product set".to_string(),
        );
    }
    let mut previous: Option<&str> = None;
    for product in &registry.products {
        validate_stable_id(&product.id, "Pages registry product id")?;
        if previous.is_some_and(|old| old >= product.id.as_str()) {
            return Err("Pages registry products must be sorted and duplicate-free".to_string());
        }
        previous = Some(&product.id);
    }
    Ok(())
}

fn validate_ready_product(product: &PagesReadyProductV1, target_abi: u64) -> Result<(), String> {
    validate_product_fields(
        &product.id,
        &product.manifest_sha256,
        &product.admissions,
        &product.resolved_inputs_sha256,
        &product.vfs_sha256,
        product.vfs_bytes,
        &product.builder_report_sha256,
        &product.runtime_evidence_sha256,
        &product.node_receipts,
        &product.browser_receipts,
        target_abi,
    )
}

fn validate_site_product(product: &PagesSiteProductV1, target_abi: u64) -> Result<(), String> {
    validate_product_fields(
        &product.id,
        &product.manifest_sha256,
        &product.admissions,
        &product.resolved_inputs_sha256,
        &product.vfs_sha256,
        product.vfs_bytes,
        &product.builder_report_sha256,
        &product.runtime_evidence_sha256,
        &product.node_receipts,
        &product.browser_receipts,
        target_abi,
    )?;
    validate_relative_path(&product.path, "Pages product path")?;
    if !product
        .path
        .contains(&format!("sha256-{}", product.vfs_sha256))
    {
        return Err("Pages product path is not content-addressed by its VFS digest".to_string());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_product_fields(
    id: &str,
    manifest_sha256: &str,
    admissions: &[crate::abi_staging::records::PagesRecordLinkV1],
    resolved_inputs_sha256: &str,
    vfs_sha256: &str,
    vfs_bytes: u64,
    builder_report_sha256: &str,
    runtime_evidence_sha256: &str,
    node_receipts: &[PagesEvidenceReceiptLinkV1],
    browser_receipts: &[PagesEvidenceReceiptLinkV1],
    target_abi: u64,
) -> Result<(), String> {
    validate_stable_id(id, "Pages product id")?;
    for digest in [
        manifest_sha256,
        resolved_inputs_sha256,
        vfs_sha256,
        builder_report_sha256,
        runtime_evidence_sha256,
    ] {
        validate_sha256(digest)?;
    }
    if vfs_bytes == 0 {
        return Err("Pages VFS bytes must be positive".to_string());
    }
    for admission in admissions {
        validate_sha256(&admission.record_sha256)?;
        validate_admission_reference(
            &admission.immutable_reference,
            &admission.record_sha256,
            target_abi,
        )?;
    }
    validate_receipts(node_receipts, "Node")?;
    validate_receipts(browser_receipts, "browser")
}

fn validate_receipts(receipts: &[PagesEvidenceReceiptLinkV1], host: &str) -> Result<(), String> {
    if receipts.is_empty() || receipts.len() > MAX_PRODUCTS {
        return Err(format!(
            "Pages product must carry bounded nonempty {host} receipts"
        ));
    }
    let mut previous: Option<&str> = None;
    for receipt in receipts {
        validate_stable_id(&receipt.id, "Pages evidence receipt id")?;
        validate_sha256(&receipt.sha256)?;
        if previous.is_some_and(|old| old >= receipt.id.as_str()) {
            return Err(format!("{host} receipts must be sorted and duplicate-free"));
        }
        previous = Some(&receipt.id);
    }
    Ok(())
}

fn validate_file_inventory(
    files: &[PagesFileIdentityV1],
) -> Result<BTreeMap<&str, &PagesFileIdentityV1>, String> {
    if files.is_empty() {
        return Err("Pages site file inventory must be nonempty".to_string());
    }
    let mut result = BTreeMap::new();
    let mut previous: Option<&str> = None;
    for file in files {
        validate_file_identity(file)?;
        if previous.is_some_and(|old| old >= file.path.as_str()) {
            return Err("Pages site files must be sorted and duplicate-free".to_string());
        }
        previous = Some(&file.path);
        result.insert(file.path.as_str(), file);
    }
    Ok(result)
}

fn validate_file_identity(file: &PagesFileIdentityV1) -> Result<(), String> {
    validate_relative_path(&file.path, "Pages site file path")?;
    validate_sha256(&file.sha256)
}

fn require_inventory_identity(
    files: &BTreeMap<&str, &PagesFileIdentityV1>,
    expected: &PagesFileIdentityV1,
    label: &str,
) -> Result<(), String> {
    match files.get(expected.path.as_str()) {
        Some(actual) if *actual == expected => Ok(()),
        _ => Err(format!(
            "{label} identity is missing from the exact file inventory"
        )),
    }
}

fn validate_source(repository: &str, commit: &str, tree: &str) -> Result<(), String> {
    if repository.is_empty()
        || repository.len() > 512
        || repository.matches('/').count() != 1
        || repository.chars().any(char::is_whitespace)
    {
        return Err("Pages source repository must be one bounded owner/name pair".to_string());
    }
    validate_git_sha(commit)?;
    validate_git_sha(tree)
}

fn validate_target(version: u64, snapshot_sha256: &str) -> Result<(), String> {
    if version == 0 || version > u64::from(u32::MAX) {
        return Err("Pages target ABI must be a positive unsigned 32-bit integer".to_string());
    }
    validate_sha256(snapshot_sha256)
}

fn validate_relative_path(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 4_096
        || value.starts_with('/')
        || value.contains(['\\', '\0'])
    {
        return Err(format!("{label} is not a bounded normalized relative path"));
    }
    let path = Path::new(value);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
        || value
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(format!("{label} is not a bounded normalized relative path"));
    }
    Ok(())
}

fn validate_admission_reference(
    reference: &str,
    _record_sha256: &str,
    target_abi: u64,
) -> Result<(), String> {
    let prefix = format!("ghcr.io/kandelo-dev/homebrew-tap-core-abi-{target_abi}/");
    if reference.len() > 4_096 || !reference.starts_with(&prefix) {
        return Err(
            "Pages admission reference must name one canonical ABI manifest".to_string(),
        );
    }
    let rest = &reference[prefix.len()..];
    let marker = "/admissions@sha256:";
    let Some((formula, manifest_sha256)) = rest.split_once(marker) else {
        return Err("Pages admission reference must name one canonical ABI manifest".to_string());
    };
    if rest.matches(marker).count() != 1 {
        return Err("Pages admission reference must name one canonical ABI manifest".to_string());
    }
    validate_stable_id(formula, "Pages admission reference Formula")?;
    validate_sha256(manifest_sha256)
}

fn reject_candidate_namespace<T: Serialize>(value: &T, label: &str) -> Result<(), String> {
    fn contains_candidate(value: &Value) -> bool {
        match value {
            Value::String(value) => value.contains("-candidates/"),
            Value::Array(values) => values.iter().any(contains_candidate),
            Value::Object(values) => values.values().any(contains_candidate),
            _ => false,
        }
    }
    let value =
        serde_json::to_value(value).map_err(|error| format!("cannot inspect {label}: {error}"))?;
    if contains_candidate(&value) {
        return Err(format!("{label} contains the candidate namespace"));
    }
    Ok(())
}

pub fn run_cli(action: &str, args: &[String]) -> Result<(), String> {
    if args.len() != 1 {
        return Err(format!("{action} requires exactly one path"));
    }
    let bytes =
        fs::read(&args[0]).map_err(|error| format!("cannot read {:?}: {error}", args[0]))?;
    match action {
        "validate-readiness" => {
            validate_pages_readiness_bytes(&bytes)?;
            Ok(())
        }
        "validate-site" => {
            validate_pages_site_manifest_bytes(&bytes)?;
            Ok(())
        }
        "activation-mode" => {
            let mode = parse_pages_activation(&bytes)?;
            println!(
                "{}",
                match mode {
                    PagesActivationModeV1::Legacy => "legacy",
                    PagesActivationModeV1::Observe => "observe",
                    PagesActivationModeV1::Active => "active",
                }
            );
            Ok(())
        }
        _ => Err(
            "Pages readiness requires validate-readiness, validate-site, or activation-mode"
                .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi_staging::canonical_json::canonical_json_bytes;
    use serde_json::{json, Value};

    const ABI: u64 = 18;

    #[test]
    fn accepts_one_complete_content_addressed_pages_revision() {
        let record = ready_record();
        let bytes = canonical_json_bytes(&record).unwrap();
        let parsed = validate_pages_readiness_bytes(&bytes).unwrap();
        assert!(parsed.ready);
        assert_eq!(parsed.products.len(), 2);

        let manifest = site_manifest(&record);
        let manifest_bytes = canonical_json_bytes(&manifest).unwrap();
        let parsed_manifest = validate_pages_site_manifest_bytes(&manifest_bytes).unwrap();
        assert_eq!(parsed_manifest.products.len(), 2);
    }

    #[test]
    fn rejects_ready_records_missing_a_pages_product() {
        let mut record = ready_record();
        record["products"].as_array_mut().unwrap().pop();
        let error =
            validate_pages_readiness_bytes(&canonical_json_bytes(&record).unwrap()).unwrap_err();
        assert!(error.contains("complete Pages product set"));
    }

    #[test]
    fn rejects_candidate_namespaces_in_records_and_sites() {
        let mut record = ready_record();
        record["products"][0]["admissions"][0]["immutable_reference"] = json!(format!(
            "ghcr.io/kandelo-dev/homebrew-tap-core-abi-{ABI}-candidates/base/admissions@sha256:{}",
            digest('a')
        ));
        assert!(
            validate_pages_readiness_bytes(&canonical_json_bytes(&record).unwrap())
                .unwrap_err()
                .contains("candidate namespace")
        );

        let mut manifest = site_manifest(&ready_record());
        manifest["products"][0]["path"] = json!("products/-candidates/base.vfs.zst");
        assert!(
            validate_pages_site_manifest_bytes(&canonical_json_bytes(&manifest).unwrap())
                .unwrap_err()
                .contains("candidate namespace")
        );
    }

    #[test]
    fn accepts_distinct_admission_manifest_and_record_digests() {
        let mut record = ready_record();
        record["products"][0]["admissions"][0]["immutable_reference"] = json!(format!(
            "ghcr.io/kandelo-dev/homebrew-tap-core-abi-{ABI}/base/admissions@sha256:{}",
            digest('f')
        ));
        validate_pages_readiness_bytes(&canonical_json_bytes(&record).unwrap()).unwrap();

        record["products"][0]["admissions"][0]["immutable_reference"] = json!(format!(
            "ghcr.io/kandelo-dev/homebrew-tap-core-abi-{ABI}/base/admissions@sha256:{}?query=1",
            digest('f')
        ));
        assert!(validate_pages_readiness_bytes(&canonical_json_bytes(&record).unwrap())
            .unwrap_err().contains("SHA-256"));
    }

    #[test]
    fn requires_held_records_to_name_a_real_blocker() {
        let mut record = ready_record();
        record["ready"] = json!(false);
        record["products"] = json!([]);
        record["blockers"] = json!([]);
        assert!(
            validate_pages_readiness_bytes(&canonical_json_bytes(&record).unwrap())
                .unwrap_err()
                .contains("held readiness requires")
        );

        record["blockers"] = json!([{
            "detail": "base has no exact admission",
            "guard_code": "pages_product_incomplete",
            "kind": "missing-admission",
            "product_id": "base",
        }]);
        assert!(
            !validate_pages_readiness_bytes(&canonical_json_bytes(&record).unwrap())
                .unwrap()
                .ready
        );
    }

    #[test]
    fn parses_only_the_three_reviewed_activation_modes() {
        let legacy = b"schema = 1\nkind = \"kandelo-pages-activation\"\nmode = \"legacy\"\n";
        assert_eq!(
            parse_pages_activation(legacy).unwrap(),
            PagesActivationModeV1::Legacy
        );
        for mode in ["observe", "active"] {
            let body =
                format!("schema = 1\nkind = \"kandelo-pages-activation\"\nmode = \"{mode}\"\n");
            parse_pages_activation(body.as_bytes()).unwrap();
        }
        assert!(parse_pages_activation(
            b"schema = 1\nkind = \"kandelo-pages-activation\"\nmode = \"latest\"\n"
        )
        .unwrap_err()
        .contains("unsupported"));
    }

    fn ready_record() -> Value {
        json!({
            "blockers": [],
            "kind": "kandelo-pages-readiness",
            "pages_registry": {
                "path": "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml",
                "products": [
                    {"id": "base", "load": "eager"},
                    {"id": "shell", "load": "lazy"},
                ],
                "sha256": digest('4'),
            },
            "products": [product("base", "eager", '5'), product("shell", "lazy", '6')],
            "ready": true,
            "schema": 1,
            "site_metadata_sha256": digest('7'),
            "source": {
                "commit": "1".repeat(40),
                "repository": "Automattic/kandelo",
                "tree": "2".repeat(40),
            },
            "target_abi": {"snapshot_sha256": digest('3'), "version": ABI},
        })
    }

    fn product(id: &str, load: &str, marker: char) -> Value {
        json!({
            "admissions": [{
                "immutable_reference": format!(
                    "ghcr.io/kandelo-dev/homebrew-tap-core-abi-{ABI}/{id}/admissions@sha256:{}",
                    digest(marker)
                ),
                "record_sha256": digest(marker),
            }],
            "browser_receipts": [{"id": format!("{id}-browser"), "sha256": digest('b')}],
            "builder_report_sha256": digest('8'),
            "id": id,
            "load": load,
            "manifest_sha256": digest('9'),
            "node_receipts": [{"id": format!("{id}-node"), "sha256": digest('a')}],
            "resolved_inputs_sha256": digest('c'),
            "runtime_evidence_sha256": digest('d'),
            "vfs_bytes": 12,
            "vfs_sha256": digest('e'),
        })
    }

    fn site_manifest(record: &Value) -> Value {
        let products = record["products"]
            .as_array()
            .unwrap()
            .iter()
            .map(|product| {
                let mut value = product.clone();
                value.as_object_mut().unwrap().insert(
                    "path".to_string(),
                    json!(format!(
                        "products/{}/sha256-{}/{}-{}.vfs.zst",
                        product["id"].as_str().unwrap(),
                        product["vfs_sha256"].as_str().unwrap(),
                        product["id"].as_str().unwrap(),
                        ABI,
                    )),
                );
                value
            })
            .collect::<Vec<_>>();
        let mut files = vec![
            json!({"bytes": 3, "path": "api/index.html", "sha256": digest('f')}),
            json!({"bytes": 4, "path": "browser/index.html", "sha256": digest('0')}),
            json!({"bytes": 5, "path": "guide/index.html", "sha256": digest('1')}),
        ];
        files.extend(products.iter().map(|product| {
            json!({
                "bytes": product["vfs_bytes"].clone(),
                "path": product["path"].clone(),
                "sha256": product["vfs_sha256"].clone(),
            })
        }));
        files.sort_by(|left, right| {
            left["path"]
                .as_str()
                .unwrap()
                .cmp(right["path"].as_str().unwrap())
        });
        json!({
            "builds": {
                "api": {"bytes": 3, "path": "api/index.html", "sha256": digest('f')},
                "browser": {"bytes": 4, "path": "browser/index.html", "sha256": digest('0')},
                "documentation": {"bytes": 5, "path": "guide/index.html", "sha256": digest('1')},
            },
            "files": files,
            "kind": "kandelo-pages-site-manifest",
            "pages_registry": record["pages_registry"].clone(),
            "products": products,
            "readiness_record_sha256": canonical_sha(&record),
            "schema": 1,
            "site_metadata_sha256": record["site_metadata_sha256"].clone(),
            "source": record["source"].clone(),
            "target_abi": record["target_abi"].clone(),
        })
    }

    fn canonical_sha(value: &Value) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(canonical_json_bytes(value).unwrap()))
    }

    fn digest(marker: char) -> String {
        marker.to_string().repeat(64)
    }
}

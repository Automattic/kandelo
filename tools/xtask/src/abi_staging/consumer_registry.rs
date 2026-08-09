use crate::abi_staging::canonical_json::{canonical_json_bytes, validate_stable_id};
use crate::abi_staging::product_manifest::{
    atomic_write_regular, read_bounded_regular_file, VfsProductCatalogV1,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const REGISTRY_SCHEMA: u64 = 1;
const PAGES_REGISTRY_KIND: &str = "kandelo-pages-vfs-products";
const TEST_REGISTRY_KIND: &str = "kandelo-test-vfs-products";
const MAX_REGISTRY_BYTES: usize = 1024 * 1024;
const MAX_PRODUCTS: usize = 256;
const MAX_EVIDENCE_PER_HOST: usize = 32;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PagesLoadV1 {
    Eager,
    Lazy,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PagesProductRegistryV1 {
    pub schema: u64,
    pub kind: String,
    #[serde(default)]
    pub products: Vec<PagesProductV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PagesProductV1 {
    pub id: String,
    pub load: PagesLoadV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicabilityV1 {
    NotApplicable,
    Informational,
    Required,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeClass {
    Abi,
    Kernel,
    Host,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TestProductRegistryV1 {
    pub schema: u64,
    pub kind: String,
    #[serde(default)]
    pub registrations: Vec<TestProductRegistrationV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TestProductRegistrationV1 {
    pub product: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<Vec<String>>,
    pub applicability: TestApplicabilityV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TestApplicabilityV1 {
    pub abi: ApplicabilityV1,
    pub kernel: ApplicabilityV1,
    pub host: ApplicabilityV1,
}

impl TestApplicabilityV1 {
    pub fn for_change_class(&self, change_class: ChangeClass) -> ApplicabilityV1 {
        match change_class {
            ChangeClass::Abi => self.abi,
            ChangeClass::Kernel => self.kernel,
            ChangeClass::Host => self.host,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegistryWriteMode {
    Generate,
    Check,
}

pub fn parse_pages_registry(
    source_path: &Path,
    bytes: &[u8],
) -> Result<PagesProductRegistryV1, String> {
    let mut registry: PagesProductRegistryV1 = parse_toml(source_path, bytes, "Pages registry")?;
    if registry.schema != REGISTRY_SCHEMA {
        return Err(format!(
            "Pages registry {} has unsupported schema {}",
            source_path.display(),
            registry.schema
        ));
    }
    if registry.kind != PAGES_REGISTRY_KIND {
        return Err(format!(
            "Pages registry {} has unsupported kind {:?}",
            source_path.display(),
            registry.kind
        ));
    }
    if registry.products.len() > MAX_PRODUCTS {
        return Err(format!(
            "Pages registry {} exceeds {MAX_PRODUCTS} products",
            source_path.display()
        ));
    }
    let mut ids = BTreeSet::new();
    for product in &registry.products {
        validate_stable_id(&product.id, "Pages product id")?;
        if !ids.insert(product.id.as_str()) {
            return Err(format!("duplicate Pages product {:?}", product.id));
        }
    }
    registry.products.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(registry)
}

pub fn parse_test_registry(
    source_path: &Path,
    bytes: &[u8],
) -> Result<TestProductRegistryV1, String> {
    let mut registry: TestProductRegistryV1 = parse_toml(source_path, bytes, "test registry")?;
    if registry.schema != REGISTRY_SCHEMA {
        return Err(format!(
            "test registry {} has unsupported schema {}",
            source_path.display(),
            registry.schema
        ));
    }
    if registry.kind != TEST_REGISTRY_KIND {
        return Err(format!(
            "test registry {} has unsupported kind {:?}",
            source_path.display(),
            registry.kind
        ));
    }
    if registry.registrations.len() > MAX_PRODUCTS {
        return Err(format!(
            "test registry {} exceeds {MAX_PRODUCTS} registrations",
            source_path.display()
        ));
    }
    let mut products = BTreeSet::new();
    for registration in &mut registry.registrations {
        validate_stable_id(&registration.product, "test product id")?;
        if !products.insert(registration.product.as_str()) {
            return Err(format!(
                "duplicate test registration for product {:?}",
                registration.product
            ));
        }
        validate_evidence_list(&registration.product, "node", registration.node.as_mut())?;
        validate_evidence_list(
            &registration.product,
            "browser",
            registration.browser.as_mut(),
        )?;
        if registration.node.is_none() && registration.browser.is_none() {
            return Err(format!(
                "test registration {:?} must declare node or browser evidence",
                registration.product
            ));
        }
    }
    registry
        .registrations
        .sort_by(|left, right| left.product.cmp(&right.product));
    Ok(registry)
}

pub fn validate_consumer_registries(
    catalog: &VfsProductCatalogV1,
    pages: &PagesProductRegistryV1,
    tests: &TestProductRegistryV1,
) -> Result<(), String> {
    if pages.products.is_empty() {
        return Err("Pages registry must select at least one product".to_string());
    }
    let products = catalog
        .products
        .iter()
        .map(|entry| (entry.manifest.id.as_str(), &entry.manifest))
        .collect::<BTreeMap<_, _>>();
    for page in &pages.products {
        let manifest = products.get(page.id.as_str()).ok_or_else(|| {
            format!("Pages registry references unknown product {:?}", page.id)
        })?;
        if manifest.boot.is_none() {
            return Err(format!(
                "Pages product {:?} must declare a boot contract",
                page.id
            ));
        }
        if manifest.evidence.node.is_none() && manifest.evidence.browser.is_none() {
            return Err(format!(
                "Pages product {:?} must declare product evidence",
                page.id
            ));
        }
    }
    for registration in &tests.registrations {
        let manifest = products.get(registration.product.as_str()).ok_or_else(|| {
            format!(
                "test registry references unknown product {:?}",
                registration.product
            )
        })?;
        if [
            registration.applicability.abi,
            registration.applicability.kernel,
            registration.applicability.host,
        ]
        .contains(&ApplicabilityV1::Required)
            && (manifest.boot.is_none()
                || (manifest.evidence.node.is_none() && manifest.evidence.browser.is_none()))
        {
            return Err(format!(
                "required-test product {:?} must declare boot intent and basic evidence",
                registration.product
            ));
        }
    }
    Ok(())
}

pub fn write_or_check_consumer_registries(
    mode: RegistryWriteMode,
    pages_source: &Path,
    pages_output: &Path,
    tests_source: &Path,
    tests_output: &Path,
) -> Result<(), String> {
    let pages_bytes = read_bounded_regular_file(pages_source, MAX_REGISTRY_BYTES)?;
    let tests_bytes = read_bounded_regular_file(tests_source, MAX_REGISTRY_BYTES)?;
    let pages = parse_pages_registry(pages_source, &pages_bytes)?;
    let tests = parse_test_registry(tests_source, &tests_bytes)?;
    let expected_pages = canonical_json_bytes(&pages)?;
    let expected_tests = canonical_json_bytes(&tests)?;

    match mode {
        RegistryWriteMode::Generate => {
            atomic_write_regular(pages_output, &expected_pages)?;
            atomic_write_regular(tests_output, &expected_tests)
        }
        RegistryWriteMode::Check => {
            check_generated_registry(pages_output, &expected_pages)?;
            check_generated_registry(tests_output, &expected_tests)
        }
    }
}

pub fn run_cli(action: &str, args: &[String]) -> Result<(), String> {
    let (pages_output_flag, tests_output_flag, mode, include_catalog) = match action {
        "generate" => (
            "--pages-out",
            "--tests-out",
            RegistryWriteMode::Generate,
            false,
        ),
        "check" => (
            "--pages-generated",
            "--tests-generated",
            RegistryWriteMode::Check,
            true,
        ),
        _ => return Err(format!("unknown registries subcommand {action:?}")),
    };
    let mut expected = vec!["--pages", pages_output_flag, "--tests", tests_output_flag];
    if include_catalog {
        expected.push("--catalog");
    }
    let flags = parse_path_flags(args, &expected)?;
    if include_catalog {
        let catalog = crate::abi_staging::selection::read_canonical_catalog(&flags["--catalog"])?;
        let pages = parse_pages_registry(
            &flags["--pages"],
            &read_bounded_regular_file(&flags["--pages"], MAX_REGISTRY_BYTES)?,
        )?;
        let tests = parse_test_registry(
            &flags["--tests"],
            &read_bounded_regular_file(&flags["--tests"], MAX_REGISTRY_BYTES)?,
        )?;
        validate_consumer_registries(&catalog, &pages, &tests)?;
    }
    write_or_check_consumer_registries(
        mode,
        &flags["--pages"],
        &flags[pages_output_flag],
        &flags["--tests"],
        &flags[tests_output_flag],
    )
}

fn parse_toml<T: for<'de> Deserialize<'de>>(
    source_path: &Path,
    bytes: &[u8],
    label: &str,
) -> Result<T, String> {
    if bytes.is_empty() || bytes.len() > MAX_REGISTRY_BYTES {
        return Err(format!(
            "{label} {} must contain 1 through {MAX_REGISTRY_BYTES} bytes",
            source_path.display()
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|error| format!("{label} {} is not UTF-8: {error}", source_path.display()))?;
    toml::from_str(text)
        .map_err(|error| format!("{label} {} is invalid: {error}", source_path.display()))
}

fn validate_evidence_list(
    product: &str,
    host: &str,
    evidence: Option<&mut Vec<String>>,
) -> Result<(), String> {
    let Some(evidence) = evidence else {
        return Ok(());
    };
    if evidence.is_empty() {
        return Err(format!(
            "test registration {product:?} {host} evidence must not be empty"
        ));
    }
    if evidence.len() > MAX_EVIDENCE_PER_HOST {
        return Err(format!(
            "test registration {product:?} exceeds {MAX_EVIDENCE_PER_HOST} {host} evidence ids"
        ));
    }
    let mut seen = BTreeSet::new();
    for id in evidence.iter() {
        validate_stable_id(id, "evidence id")?;
        if !seen.insert(id.as_str()) {
            return Err(format!(
                "test registration {product:?} repeats {host} evidence {id:?}"
            ));
        }
    }
    evidence.sort();
    Ok(())
}

fn check_generated_registry(path: &Path, expected: &[u8]) -> Result<(), String> {
    let actual = read_bounded_regular_file(path, 16 * 1024 * 1024)?;
    if actual != expected {
        return Err(format!(
            "generated consumer registry {} is stale; run `xtask abi-staging registries generate`",
            path.display()
        ));
    }
    Ok(())
}

fn parse_path_flags(
    args: &[String],
    expected: &[&str],
) -> Result<BTreeMap<String, PathBuf>, String> {
    if args.len() != expected.len() * 2 {
        return Err(format!("expected flags: {}", expected.join(" ")));
    }
    let mut values = BTreeMap::new();
    for pair in args.chunks_exact(2) {
        if !expected.contains(&pair[0].as_str()) {
            return Err(format!("unknown or unexpected flag {:?}", pair[0]));
        }
        if values
            .insert(pair[0].clone(), PathBuf::from(&pair[1]))
            .is_some()
        {
            return Err(format!("duplicate flag {:?}", pair[0]));
        }
    }
    for flag in expected {
        if !values.contains_key(*flag) {
            return Err(format!("missing required flag {flag}"));
        }
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_pages_registry, parse_test_registry, validate_consumer_registries,
        write_or_check_consumer_registries, RegistryWriteMode,
    };
    use crate::abi_staging::canonical_json::canonical_json_bytes;
    use crate::abi_staging::product_manifest::load_product_catalog;
    use std::fs;
    use std::path::PathBuf;

    const PAGES_FIXTURE: &str =
        include_str!("../../tests/fixtures/abi-staging/canonical/pages.toml");
    const PAGES_JSON_FIXTURE: &[u8] =
        include_bytes!("../../tests/fixtures/abi-staging/canonical/pages.json");
    const TESTS_FIXTURE: &str =
        include_str!("../../tests/fixtures/abi-staging/canonical/tests.toml");
    const TESTS_JSON_FIXTURE: &[u8] =
        include_bytes!("../../tests/fixtures/abi-staging/canonical/tests.json");

    fn fixture_path(relative: &str) -> PathBuf {
        crate::repo_root().join(relative)
    }

    fn create_fixture_catalog() -> (tempfile::TempDir, crate::abi_staging::product_manifest::VfsProductCatalogV1) {
        let repository = tempfile::tempdir().unwrap();
        fs::create_dir(repository.path().join("products")).unwrap();
        fs::write(repository.path().join("builder.sh"), b"#!/bin/sh\n").unwrap();
        fs::write(
            repository.path().join("products/fixture-shell.toml"),
            br#"schema = 1
id = "fixture-shell"
architecture = "wasm32"
output = "fixture-shell.vfs.zst"
builder = "builder.sh"

[[mounts]]
path = "/"
source = "built-image"
readonly = false

[boot]
argv = ["sh"]
cwd = "/"
uid = 0
gid = 0

[boot.env]
PATH = "/bin"

[evidence.node]
test = "fixture-shell-startup"
"#,
        )
        .unwrap();
        let catalog = load_product_catalog(repository.path(), &repository.path().join("products"))
            .unwrap();
        (repository, catalog)
    }

    #[test]
    fn registry_fixtures_round_trip_to_exact_canonical_json() {
        let pages = parse_pages_registry(
            &fixture_path("tools/xtask/tests/fixtures/abi-staging/canonical/pages.toml"),
            PAGES_FIXTURE.as_bytes(),
        )
        .unwrap();
        let tests = parse_test_registry(
            &fixture_path("tools/xtask/tests/fixtures/abi-staging/canonical/tests.toml"),
            TESTS_FIXTURE.as_bytes(),
        )
        .unwrap();

        assert_eq!(canonical_json_bytes(&pages).unwrap(), PAGES_JSON_FIXTURE);
        assert_eq!(canonical_json_bytes(&tests).unwrap(), TESTS_JSON_FIXTURE);
    }

    #[test]
    fn registries_reject_duplicates_empty_evidence_and_unknown_fields() {
        let duplicate_pages = PAGES_FIXTURE.replace(
            "[[products]]",
            "[[products]]\nid = \"fixture-shell\"\nload = \"lazy\"\n\n[[products]]",
        );
        assert!(parse_pages_registry(PathBuf::from("pages.toml").as_path(), duplicate_pages.as_bytes())
            .unwrap_err()
            .contains("duplicate Pages product"));

        let empty_evidence = TESTS_FIXTURE.replace(
            "node = [\"fixture-shell-startup\"]",
            "node = []",
        );
        assert!(parse_test_registry(PathBuf::from("tests.toml").as_path(), empty_evidence.as_bytes())
            .unwrap_err()
            .contains("must not be empty"));

        for invalid in [
            PAGES_FIXTURE.replace("schema = 1", "schema = 1\nformula = \"bash\""),
            PAGES_FIXTURE.replace("load = \"eager\"", "load = \"eager\"\nurl = \"x\""),
        ] {
            assert!(parse_pages_registry(PathBuf::from("pages.toml").as_path(), invalid.as_bytes())
                .unwrap_err()
                .contains("unknown field"));
        }
        assert!(parse_test_registry(
            PathBuf::from("tests.toml").as_path(),
            TESTS_FIXTURE
                .replace("schema = 1", "schema = 1\ncommand = \"run\"")
                .as_bytes(),
        )
        .unwrap_err()
        .contains("unknown field"));
        assert!(parse_test_registry(
            PathBuf::from("tests.toml").as_path(),
            TESTS_FIXTURE
                .replace("abi = \"required\"", "abi = \"sometimes\"")
                .as_bytes(),
        )
        .unwrap_err()
        .contains("unknown variant"));
    }

    #[test]
    fn registry_cross_validation_rejects_unknown_and_missing_catalog_products() {
        let (_repository, catalog) = create_fixture_catalog();
        let pages = parse_pages_registry(PathBuf::from("pages.toml").as_path(), PAGES_FIXTURE.as_bytes())
            .unwrap();
        let tests = parse_test_registry(PathBuf::from("tests.toml").as_path(), TESTS_FIXTURE.as_bytes())
            .unwrap();
        validate_consumer_registries(&catalog, &pages, &tests).unwrap();

        let unknown_pages = parse_pages_registry(
            PathBuf::from("pages.toml").as_path(),
            PAGES_FIXTURE.replace("fixture-shell", "missing-product").as_bytes(),
        )
        .unwrap();
        assert!(validate_consumer_registries(&catalog, &unknown_pages, &tests)
            .unwrap_err()
            .contains("unknown product"));

        let empty_pages = parse_pages_registry(
            PathBuf::from("pages.toml").as_path(),
            b"schema = 1\nkind = \"kandelo-pages-vfs-products\"\n",
        )
        .unwrap();
        assert!(validate_consumer_registries(&catalog, &empty_pages, &tests)
            .unwrap_err()
            .contains("must select at least one product"));
    }

    #[test]
    fn registry_generation_is_atomic_and_freshness_checked() {
        let repository = tempfile::tempdir().unwrap();
        let pages_source = repository.path().join("pages.toml");
        let tests_source = repository.path().join("tests.toml");
        let pages_output = repository.path().join("pages.json");
        let tests_output = repository.path().join("tests.json");
        fs::write(&pages_source, PAGES_FIXTURE).unwrap();
        fs::write(&tests_source, TESTS_FIXTURE).unwrap();

        write_or_check_consumer_registries(
            RegistryWriteMode::Generate,
            &pages_source,
            &pages_output,
            &tests_source,
            &tests_output,
        )
        .unwrap();
        write_or_check_consumer_registries(
            RegistryWriteMode::Check,
            &pages_source,
            &pages_output,
            &tests_source,
            &tests_output,
        )
        .unwrap();

        let complete_pages = fs::read(&pages_output).unwrap();
        fs::write(&pages_source, b"invalid").unwrap();
        assert!(write_or_check_consumer_registries(
            RegistryWriteMode::Generate,
            &pages_source,
            &pages_output,
            &tests_source,
            &tests_output,
        )
        .is_err());
        assert_eq!(fs::read(&pages_output).unwrap(), complete_pages);
    }
}

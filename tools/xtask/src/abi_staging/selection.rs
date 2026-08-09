use crate::abi_staging::canonical_json::{
    canonical_json_bytes, canonical_sha256, validate_sha256,
};
use crate::abi_staging::consumer_registry::{
    parse_pages_registry, parse_test_registry, validate_consumer_registries, ApplicabilityV1,
    ChangeClass, PagesLoadV1, PagesProductRegistryV1, TestProductRegistryV1,
};
use crate::abi_staging::product_manifest::{
    atomic_write_regular, read_bounded_regular_file, MaterializationV1, ProductInputV1,
    VfsArchitectureV1, VfsProductCatalogEntryV1, VfsProductCatalogV1,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const PAGES_REGISTRY_PATH: &str =
    "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml";
const TEST_REGISTRY_PATH: &str = "tests/vfs-products.toml";
const MAX_CATALOG_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SelectedVfsProductV1 {
    pub product_id: String,
    pub manifest_path: String,
    pub manifest_sha256: String,
    pub applicability: ApplicabilityV1,
    pub node_evidence: Vec<String>,
    pub browser_evidence: Vec<String>,
    pub product_inputs: Vec<ProductInputV1>,
    pub consumer_reasons: Vec<ConsumerReasonV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(tag = "consumer", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ConsumerReasonV1 {
    Pages {
        registry_path: String,
        registry_sha256: String,
        selected_product: String,
        load: PagesLoadV1,
    },
    Test {
        registry_path: String,
        registry_sha256: String,
        selected_product: String,
        applicability: ApplicabilityV1,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        node: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        browser: Vec<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FormulaRequirementV1 {
    pub tap: String,
    pub formula: String,
    pub architecture: VfsArchitectureV1,
    pub uses: Vec<FormulaUseV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FormulaUseV1 {
    pub product_id: String,
    pub materialization: MaterializationV1,
}

#[derive(Default)]
struct SelectionAccumulator {
    applicability: Option<ApplicabilityV1>,
    node_evidence: BTreeSet<String>,
    browser_evidence: BTreeSet<String>,
    consumer_reasons: BTreeSet<ConsumerReasonV1>,
}

pub fn select_vfs_products(
    catalog: &VfsProductCatalogV1,
    pages: &PagesProductRegistryV1,
    tests: &TestProductRegistryV1,
    change_class: ChangeClass,
) -> Result<Vec<SelectedVfsProductV1>, String> {
    validate_consumer_registries(catalog, pages, tests)?;
    let products = product_map(catalog)?;
    let pages_sha256 = canonical_sha256(pages)?;
    let tests_sha256 = canonical_sha256(tests)?;
    let mut selected = BTreeMap::<String, SelectionAccumulator>::new();

    for page in &pages.products {
        let reason = ConsumerReasonV1::Pages {
            registry_path: PAGES_REGISTRY_PATH.to_string(),
            registry_sha256: pages_sha256.clone(),
            selected_product: page.id.clone(),
            load: page.load,
        };
        include_product_closure(
            &page.id,
            ApplicabilityV1::Required,
            &reason,
            &products,
            &mut selected,
            &mut BTreeSet::new(),
        )?;
    }

    for registration in &tests.registrations {
        let applicability = registration.applicability.for_change_class(change_class);
        if applicability == ApplicabilityV1::NotApplicable {
            continue;
        }
        let node = registration.node.clone().unwrap_or_default();
        let browser = registration.browser.clone().unwrap_or_default();
        let reason = ConsumerReasonV1::Test {
            registry_path: TEST_REGISTRY_PATH.to_string(),
            registry_sha256: tests_sha256.clone(),
            selected_product: registration.product.clone(),
            applicability,
            node: node.clone(),
            browser: browser.clone(),
        };
        include_product_closure(
            &registration.product,
            applicability,
            &reason,
            &products,
            &mut selected,
            &mut BTreeSet::new(),
        )?;
        let accumulator = selected
            .get_mut(&registration.product)
            .expect("selected test product must exist");
        accumulator.node_evidence.extend(node);
        accumulator.browser_evidence.extend(browser);
    }

    let order = topological_selected_order(&products, &selected)?;
    let mut result = Vec::with_capacity(order.len());
    for id in order {
        let entry = products[id.as_str()];
        let accumulator = selected
            .remove(&id)
            .expect("topological selection must have an accumulator");
        result.push(SelectedVfsProductV1 {
            product_id: id,
            manifest_path: entry.path.clone(),
            manifest_sha256: entry.sha256.clone(),
            applicability: accumulator
                .applicability
                .expect("selected product must have applicability"),
            node_evidence: accumulator.node_evidence.into_iter().collect(),
            browser_evidence: accumulator.browser_evidence.into_iter().collect(),
            product_inputs: entry.manifest.composition.product.clone(),
            consumer_reasons: accumulator.consumer_reasons.into_iter().collect(),
        });
    }
    Ok(result)
}

pub fn derive_formula_requirements(
    catalog: &VfsProductCatalogV1,
    selection: &[SelectedVfsProductV1],
) -> Result<Vec<FormulaRequirementV1>, String> {
    let products = product_map(catalog)?;
    let selected_ids = selection
        .iter()
        .map(|product| product.product_id.as_str())
        .collect::<BTreeSet<_>>();
    if selected_ids.len() != selection.len() {
        return Err("selected products contain a duplicate product id".to_string());
    }

    let mut requirements = BTreeMap::<
        (String, String, VfsArchitectureV1),
        BTreeSet<FormulaUseV1>,
    >::new();
    for product in selection {
        let entry = products.get(product.product_id.as_str()).ok_or_else(|| {
            format!(
                "selection references unknown product {:?}",
                product.product_id
            )
        })?;
        if entry.path != product.manifest_path || entry.sha256 != product.manifest_sha256 {
            return Err(format!(
                "selection binding for product {:?} does not match the catalog",
                product.product_id
            ));
        }
        for dependency in &entry.manifest.composition.product {
            if !selected_ids.contains(dependency.id.as_str()) {
                return Err(format!(
                    "selection omits composed product {:?} required by {:?}",
                    dependency.id, product.product_id
                ));
            }
        }
        for group in &entry.manifest.software.homebrew {
            for formula in &group.formulae {
                requirements
                    .entry((
                        group.tap.clone(),
                        formula.clone(),
                        entry.manifest.architecture,
                    ))
                    .or_default()
                    .insert(FormulaUseV1 {
                        product_id: product.product_id.clone(),
                        materialization: group.materialization,
                    });
            }
        }
    }

    Ok(requirements
        .into_iter()
        .map(|((tap, formula, architecture), uses)| FormulaRequirementV1 {
            tap,
            formula,
            architecture,
            uses: uses.into_iter().collect(),
        })
        .collect())
}

pub fn run_cli(args: &[String]) -> Result<(), String> {
    let flags = parse_flags(args)?;
    let catalog = read_canonical_catalog(&flags["--catalog"])?;
    let pages_path = &flags["--pages"];
    let tests_path = &flags["--tests"];
    let pages = parse_pages_registry(
        pages_path,
        &read_bounded_regular_file(pages_path, 1024 * 1024)?,
    )?;
    let tests = parse_test_registry(
        tests_path,
        &read_bounded_regular_file(tests_path, 1024 * 1024)?,
    )?;
    let change_class = match flags["--change-class"].to_string_lossy().as_ref() {
        "abi" => ChangeClass::Abi,
        "kernel" => ChangeClass::Kernel,
        "host" => ChangeClass::Host,
        value => return Err(format!("unsupported change class {value:?}")),
    };
    let selection = select_vfs_products(&catalog, &pages, &tests, change_class)?;
    let requirements = derive_formula_requirements(&catalog, &selection)?;
    atomic_write_regular(
        &flags["--products-out"],
        &canonical_json_bytes(&selection)?,
    )?;
    atomic_write_regular(
        &flags["--formulae-out"],
        &canonical_json_bytes(&requirements)?,
    )
}

fn include_product_closure(
    id: &str,
    applicability: ApplicabilityV1,
    reason: &ConsumerReasonV1,
    products: &BTreeMap<&str, &VfsProductCatalogEntryV1>,
    selected: &mut BTreeMap<String, SelectionAccumulator>,
    visiting: &mut BTreeSet<String>,
) -> Result<(), String> {
    let entry = products
        .get(id)
        .ok_or_else(|| format!("selection references unknown product {id:?}"))?;
    if !visiting.insert(id.to_string()) {
        return Err(format!("product composition cycle includes {id:?}"));
    }
    let accumulator = selected.entry(id.to_string()).or_default();
    accumulator.applicability = Some(strongest_applicability(
        accumulator.applicability,
        applicability,
    ));
    accumulator.consumer_reasons.insert(reason.clone());
    if let Some(evidence) = &entry.manifest.evidence.node {
        accumulator.node_evidence.insert(evidence.test.clone());
    }
    if let Some(evidence) = &entry.manifest.evidence.browser {
        accumulator.browser_evidence.insert(evidence.test.clone());
    }

    for dependency in &entry.manifest.composition.product {
        include_product_closure(
            &dependency.id,
            applicability,
            reason,
            products,
            selected,
            visiting,
        )?;
    }
    visiting.remove(id);
    Ok(())
}

fn strongest_applicability(
    current: Option<ApplicabilityV1>,
    candidate: ApplicabilityV1,
) -> ApplicabilityV1 {
    current.map_or(candidate, |current| current.max(candidate))
}

fn topological_selected_order(
    products: &BTreeMap<&str, &VfsProductCatalogEntryV1>,
    selected: &BTreeMap<String, SelectionAccumulator>,
) -> Result<Vec<String>, String> {
    fn visit(
        id: &str,
        products: &BTreeMap<&str, &VfsProductCatalogEntryV1>,
        selected: &BTreeMap<String, SelectionAccumulator>,
        state: &mut BTreeMap<String, u8>,
        order: &mut Vec<String>,
    ) -> Result<(), String> {
        match state.get(id).copied() {
            Some(1) => return Err(format!("product composition cycle includes {id:?}")),
            Some(2) => return Ok(()),
            _ => {}
        }
        state.insert(id.to_string(), 1);
        let entry = products
            .get(id)
            .ok_or_else(|| format!("selection references unknown product {id:?}"))?;
        let mut dependencies = entry
            .manifest
            .composition
            .product
            .iter()
            .map(|dependency| dependency.id.as_str())
            .filter(|dependency| selected.contains_key(*dependency))
            .collect::<Vec<_>>();
        dependencies.sort();
        for dependency in dependencies {
            visit(dependency, products, selected, state, order)?;
        }
        state.insert(id.to_string(), 2);
        order.push(id.to_string());
        Ok(())
    }

    let mut state = BTreeMap::new();
    let mut order = Vec::new();
    for id in selected.keys() {
        visit(id, products, selected, &mut state, &mut order)?;
    }
    Ok(order)
}

fn product_map<'a>(
    catalog: &'a VfsProductCatalogV1,
) -> Result<BTreeMap<&'a str, &'a VfsProductCatalogEntryV1>, String> {
    let mut products = BTreeMap::new();
    for entry in &catalog.products {
        validate_sha256(&entry.sha256)?;
        if entry.sha256 != canonical_sha256(&entry.manifest)? {
            return Err(format!(
                "catalog digest for product {:?} does not match its manifest",
                entry.manifest.id
            ));
        }
        if products
            .insert(entry.manifest.id.as_str(), entry)
            .is_some()
        {
            return Err(format!(
                "catalog contains duplicate product id {:?}",
                entry.manifest.id
            ));
        }
    }
    Ok(products)
}

pub(crate) fn read_canonical_catalog(path: &Path) -> Result<VfsProductCatalogV1, String> {
    let bytes = read_bounded_regular_file(path, MAX_CATALOG_BYTES)?;
    let catalog: VfsProductCatalogV1 = serde_json::from_slice(&bytes)
        .map_err(|error| format!("catalog {} is invalid JSON: {error}", path.display()))?;
    if catalog.schema != 1 || catalog.kind != "kandelo-vfs-product-catalog" {
        return Err(format!("catalog {} has unsupported identity", path.display()));
    }
    if canonical_json_bytes(&catalog)? != bytes {
        return Err(format!("catalog {} is not canonical JSON", path.display()));
    }
    product_map(&catalog)?;
    Ok(catalog)
}

fn parse_flags(args: &[String]) -> Result<BTreeMap<String, PathBuf>, String> {
    const EXPECTED: [&str; 6] = [
        "--catalog",
        "--pages",
        "--tests",
        "--change-class",
        "--products-out",
        "--formulae-out",
    ];
    // The repository root is intentionally not accepted: requirements are a
    // pure function of the generated catalog and consumer registries.
    if args.len() != EXPECTED.len() * 2 {
        return Err(format!("expected flags: {}", EXPECTED.join(" ")));
    }
    let mut flags = BTreeMap::new();
    for pair in args.chunks_exact(2) {
        if !EXPECTED.contains(&pair[0].as_str()) {
            return Err(format!("unknown or unexpected flag {:?}", pair[0]));
        }
        if flags
            .insert(pair[0].clone(), PathBuf::from(&pair[1]))
            .is_some()
        {
            return Err(format!("duplicate flag {:?}", pair[0]));
        }
    }
    for flag in EXPECTED {
        if !flags.contains_key(flag) {
            return Err(format!("missing required flag {flag}"));
        }
    }
    Ok(flags)
}

#[cfg(test)]
mod tests {
    use super::{derive_formula_requirements, select_vfs_products};
    use crate::abi_staging::consumer_registry::{
        parse_pages_registry, parse_test_registry, ApplicabilityV1, ChangeClass,
    };
    use crate::abi_staging::product_manifest::{
        load_product_catalog, MaterializationV1, VfsArchitectureV1,
    };
    use std::fs;
    use std::path::Path;

    fn manifest(
        id: &str,
        output: &str,
        product_inputs: &str,
        homebrew: &str,
        evidence: &str,
    ) -> String {
        format!(
            r#"schema = 1
id = "{id}"
architecture = "wasm32"
output = "{output}"
builder = "builder.sh"

{product_inputs}
{homebrew}
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

{evidence}
"#
        )
    }

    fn write_graph(repository: &Path) {
        fs::create_dir(repository.join("products")).unwrap();
        fs::write(repository.join("builder.sh"), b"#!/bin/sh\n").unwrap();
        fs::write(
            repository.join("products/base.toml"),
            manifest(
                "base",
                "base.vfs",
                "",
                r#"[[software.homebrew]]
tap = "kandelo-dev/homebrew-tap-core"
formulae = ["shared"]
materialization = "embedded"
"#,
                "[evidence.node]\ntest = \"base-node\"",
            ),
        )
        .unwrap();
        fs::write(
            repository.join("products/tools.toml"),
            manifest(
                "tools",
                "tools.vfs.zst",
                "",
                r#"[[software.homebrew]]
tap = "kandelo-dev/homebrew-tap-core"
formulae = ["helper"]
materialization = "lazy"
"#,
                "[evidence.browser]\ntest = \"tools-browser\"",
            ),
        )
        .unwrap();
        fs::write(
            repository.join("products/app.toml"),
            manifest(
                "app",
                "app.vfs.zst",
                r#"[[composition.product]]
id = "base"
materialization = "embedded"

[[composition.product]]
id = "tools"
materialization = "lazy"
"#,
                r#"[[software.homebrew]]
tap = "kandelo-dev/homebrew-tap-core"
formulae = ["shared", "bash"]
materialization = "lazy"
"#,
                "[evidence.node]\ntest = \"app-node\"\n\n[evidence.browser]\ntest = \"app-browser\"",
            ),
        )
        .unwrap();
        fs::write(
            repository.join("products/test-only.toml"),
            manifest(
                "test-only",
                "test-only.vfs",
                "",
                "",
                "[evidence.node]\ntest = \"test-only-node\"",
            ),
        )
        .unwrap();
    }

    fn pages_registry() -> String {
        r#"schema = 1
kind = "kandelo-pages-vfs-products"

[[products]]
id = "app"
load = "eager"
"#
        .to_string()
    }

    fn test_registry() -> String {
        r#"schema = 1
kind = "kandelo-test-vfs-products"

[[registrations]]
product = "app"
node = ["app-node"]
browser = ["app-browser", "app-extra-browser"]

[registrations.applicability]
abi = "informational"
kernel = "informational"
host = "not-applicable"

[[registrations]]
product = "test-only"
node = ["test-only-node"]

[registrations.applicability]
abi = "required"
kernel = "informational"
host = "not-applicable"
"#
        .to_string()
    }

    #[test]
    fn selection_preserves_consumers_topology_and_both_lazy_boundaries() {
        let repository = tempfile::tempdir().unwrap();
        write_graph(repository.path());
        let catalog = load_product_catalog(repository.path(), &repository.path().join("products"))
            .unwrap();
        let pages = parse_pages_registry(Path::new("pages.toml"), pages_registry().as_bytes()).unwrap();
        let tests = parse_test_registry(Path::new("tests.toml"), test_registry().as_bytes()).unwrap();

        for change_class in [ChangeClass::Abi, ChangeClass::Kernel, ChangeClass::Host] {
            let selected = select_vfs_products(&catalog, &pages, &tests, change_class).unwrap();
            let app = selected.iter().find(|product| product.product_id == "app").unwrap();
            assert_eq!(app.applicability, ApplicabilityV1::Required);
        }

        let selected = select_vfs_products(&catalog, &pages, &tests, ChangeClass::Kernel).unwrap();
        assert_eq!(
            selected
                .iter()
                .map(|product| product.product_id.as_str())
                .collect::<Vec<_>>(),
            vec!["base", "tools", "app", "test-only"]
        );
        let app = selected.iter().find(|product| product.product_id == "app").unwrap();
        assert!(app.product_inputs.iter().any(|input| {
            input.id == "tools" && input.materialization == MaterializationV1::Lazy
        }));
        assert!(app.browser_evidence.contains(&"app-extra-browser".to_string()));
        let test_only = selected
            .iter()
            .find(|product| product.product_id == "test-only")
            .unwrap();
        assert_eq!(test_only.applicability, ApplicabilityV1::Informational);

        let host = select_vfs_products(&catalog, &pages, &tests, ChangeClass::Host).unwrap();
        assert!(host.iter().all(|product| product.product_id != "test-only"));
    }

    #[test]
    fn formula_requirements_come_only_from_selected_product_roots() {
        let repository = tempfile::tempdir().unwrap();
        write_graph(repository.path());
        let catalog = load_product_catalog(repository.path(), &repository.path().join("products"))
            .unwrap();
        let pages = parse_pages_registry(Path::new("pages.toml"), pages_registry().as_bytes()).unwrap();
        let tests = parse_test_registry(Path::new("tests.toml"), test_registry().as_bytes()).unwrap();
        let selected = select_vfs_products(&catalog, &pages, &tests, ChangeClass::Kernel).unwrap();

        let requirements = derive_formula_requirements(&catalog, &selected).unwrap();
        assert_eq!(
            requirements
                .iter()
                .map(|requirement| requirement.formula.as_str())
                .collect::<Vec<_>>(),
            vec!["bash", "helper", "shared"]
        );
        let shared = requirements
            .iter()
            .find(|requirement| requirement.formula == "shared")
            .unwrap();
        assert_eq!(shared.architecture, VfsArchitectureV1::Wasm32);
        assert_eq!(
            shared
                .uses
                .iter()
                .map(|usage| (usage.product_id.as_str(), usage.materialization))
                .collect::<Vec<_>>(),
            vec![
                ("app", MaterializationV1::Lazy),
                ("base", MaterializationV1::Embedded),
            ]
        );

        let unrelated_brewfile = "brew \"not-selected\"";
        let unrelated_package_manifest = "depends_on = [\"not-selected\"]";
        let unrelated_builder = "FORMULAE=(not-selected)";
        assert!(!unrelated_brewfile.is_empty());
        assert!(!unrelated_package_manifest.is_empty());
        assert!(!unrelated_builder.is_empty());
        assert_eq!(derive_formula_requirements(&catalog, &selected).unwrap(), requirements);
    }
}

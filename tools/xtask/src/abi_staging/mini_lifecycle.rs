use crate::abi_staging::builder_contract::{
    compare_builder_report, validate_builder_report, validate_resolved_inputs_for_miniature,
    ConsumedInputPlacementV1, DeclaredInputMaterializationV1, ExactSourceV1,
    ResolvedVfsInputDescriptorV1, ResolvedVfsInputKindV1, ResolvedVfsInputV1,
    ResolvedVfsProductInputsV1, TargetAbiV1, VfsBuildEnvironmentV1, VfsBuilderReportV1,
    VfsProductIdentityV1, VfsReferenceClassV1,
};
use crate::abi_staging::canonical_json::{
    canonical_json_bytes, canonical_sha256, validate_git_sha, validate_sha256,
    validate_stable_id,
};
use crate::abi_staging::consumer_registry::{
    parse_pages_registry, parse_test_registry, ChangeClass, PagesProductRegistryV1,
    TestProductRegistryV1,
};
use crate::abi_staging::guard_registry::GuardCodeV1;
use crate::abi_staging::local_transport::{
    LocalContentAddressedTransport, LocalNamespaceV1, PublishedLocalObjectV1,
};
use crate::abi_staging::product_manifest::{
    load_product_catalog, read_bounded_regular_file, SoftwareRoleV1, VfsArchitectureV1,
    VfsProductCatalogEntryV1, VfsProductCatalogV1,
};
use crate::abi_staging::records::*;
use crate::abi_staging::selection::{
    derive_formula_requirements, select_vfs_products, FormulaRequirementV1,
    SelectedVfsProductV1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const TRANSITION_KIND: &str = "kandelo-abi-staging-mini-transition";
const TAP_KIND: &str = "kandelo-abi-staging-mini-tap";
const SUMMARY_KIND: &str = "kandelo-abi-staging-mini-summary";
const PAGES_KIND: &str = "kandelo-abi-staging-mini-pages-readiness";
const MAX_FIXTURE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct MiniTransitionV1 {
    schema: u64,
    kind: String,
    repository: String,
    pull_request: u64,
    head: String,
    tree: String,
    synthetic_merge_commit: String,
    source_abi: u64,
    source_snapshot_sha256: String,
    target_abi: u64,
    target_snapshot_sha256: String,
    policy_version: u64,
    policy_sha256: String,
    guard_registry_version: u64,
    guard_registry_sha256: String,
    source_history_branch: String,
    source_history_protected: bool,
    source_history_verified: bool,
    fixture_clock: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct MiniTapV1 {
    schema: u64,
    kind: String,
    source: ExactGitSourceV1,
    formulae: Vec<MiniTapFormulaV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct MiniTapFormulaV1 {
    name: String,
    version: String,
    revision: u64,
    bottle_rebuild: u64,
    architecture: VfsArchitectureV1,
    dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    disposition: MiniFormulaDispositionV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum MiniFormulaDispositionV1 {
    Build,
    Reuse,
    Background,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct MiniTapPlanV1 {
    required_subjects: Vec<String>,
    background_subjects: Vec<String>,
}

struct MiniFixtureV1 {
    transition: MiniTransitionV1,
    tap: MiniTapV1,
    catalog: VfsProductCatalogV1,
    pages: PagesProductRegistryV1,
    tests: TestProductRegistryV1,
    selection: Vec<SelectedVfsProductV1>,
    tap_plan: MiniTapPlanV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MiniPagesResultV1 {
    DeployedComplete,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MiniNamedDigestV1 {
    pub id: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MiniRetryScheduleV1 {
    pub retry_number: u8,
    pub delay_ms: u64,
    pub next_eligible_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MiniLifecycleSummaryV1 {
    pub schema: u64,
    pub kind: String,
    pub source_abi: u64,
    pub target_abi: u64,
    pub request_sha256: String,
    pub required_subjects: Vec<String>,
    pub background_subjects: Vec<String>,
    pub candidate_layers: Vec<MiniNamedDigestV1>,
    pub canonical_layers: Vec<MiniNamedDigestV1>,
    pub candidate_vfs_sha256: String,
    pub canonical_vfs_sha256: String,
    pub source_history_sha256: String,
    pub pages_result: MiniPagesResultV1,
    pub retry_schedule: Vec<MiniRetryScheduleV1>,
    pub negative_guards: Vec<GuardCodeV1>,
    pub record_sha256s: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MiniAttemptFailureKindV1 {
    Application,
    #[cfg_attr(not(test), allow(dead_code))]
    Infrastructure,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct MiniBottleLayerV1<'a> {
    schema: u64,
    kind: &'static str,
    formula: &'a str,
    version: &'a str,
    revision: u64,
    bottle_rebuild: u64,
    architecture: VfsArchitectureV1,
    target_abi: u64,
    source_sha256: String,
    direct_dependencies: &'a [String],
}

#[derive(Clone)]
struct MiniFormulaStateV1 {
    formula: MiniTapFormulaV1,
    candidate: PublishedLocalObjectV1,
    candidate_record_sha256: String,
    verification_receipt_sha256: String,
    producer: CandidateProducerV1,
}

struct MiniVfsBuildResultV1 {
    image: PublishedLocalObjectV1,
    report_object: PublishedLocalObjectV1,
    inputs_sha256: String,
    inputs: ResolvedVfsProductInputsV1,
    report: VfsBuilderReportV1,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct MiniSourceHistoryV1<'a> {
    schema: u64,
    kind: &'static str,
    branch: &'a str,
    source_abi: u64,
    snapshot_sha256: &'a str,
    source_tree_sha256: &'a str,
    protected: bool,
    verified: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum MiniPagesDispositionV1 {
    HeldLastComplete,
    DeployedComplete,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct MiniPagesReadinessRecordV1<'a> {
    schema: u64,
    kind: &'static str,
    request_sha256: &'a str,
    required_products: &'a [String],
    available_products: &'a [MiniNamedDigestV1],
    missing_products: &'a [String],
    disposition: MiniPagesDispositionV1,
    prior_site_sha256: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    complete_site_sha256: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct MiniPagesSiteV1<'a> {
    schema: u64,
    kind: &'static str,
    request_sha256: &'a str,
    products: &'a [MiniNamedDigestV1],
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct MiniProductReadinessV1<'a> {
    schema: u64,
    kind: &'static str,
    request_sha256: &'a str,
    product_evidence_sha256: &'a str,
    required_products: Vec<&'a str>,
    ready_products: Vec<&'a str>,
    pending_background_formulae: &'a [String],
}

struct RecordLedgerV1 {
    directory: PathBuf,
    next: usize,
    digests: Vec<String>,
}

impl RecordLedgerV1 {
    fn create(directory: &Path) -> Result<Self, String> {
        fs::create_dir(directory).map_err(|error| {
            format!("cannot create miniature record directory {}: {error}", directory.display())
        })?;
        Ok(Self {
            directory: directory.to_path_buf(),
            next: 1,
            digests: Vec::new(),
        })
    }

    fn write_record(
        &mut self,
        label: &str,
        record: &AbiStagingRecordV1,
    ) -> Result<String, String> {
        validate_record(record)?;
        self.write_value(label, record)
    }

    fn write_value<T: Serialize>(&mut self, label: &str, value: &T) -> Result<String, String> {
        validate_stable_id(label, "mini record label")?;
        let bytes = canonical_json_bytes(value)?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let filename = format!("{:02}-{label}-sha256-{digest}.json", self.next);
        write_new_file(&self.directory.join(filename), &bytes)?;
        self.next += 1;
        self.digests.push(digest.clone());
        Ok(digest)
    }
}

pub fn run_mini_lifecycle(
    fixture_dir: &Path,
    new_work_dir: &Path,
) -> Result<MiniLifecycleSummaryV1, String> {
    let fixture_dir = absolute_repository_path(fixture_dir)?;
    let new_work_dir = absolute_repository_path(new_work_dir)?;
    if new_work_dir.starts_with(&fixture_dir) {
        return Err("miniature work directory cannot be inside its fixture".to_string());
    }
    let fixture_dir = fixture_dir.as_path();
    let new_work_dir = new_work_dir.as_path();
    let fixture = load_fixture(fixture_dir)?;
    create_new_work_directory(new_work_dir)?;
    let initial_source_tree = fixture_source_tree_sha256(fixture_dir)?;
    let transport = LocalContentAddressedTransport::create(&new_work_dir.join("transport"))?;
    let mut records = RecordLedgerV1::create(&new_work_dir.join("records"))?;

    check_exact_build_source(&fixture.transition.head, &fixture.transition.head)
        .map_err(guard_failure)?;
    let request = build_request(&fixture, fixture_dir)?;
    let request_bytes = canonical_json_bytes(&request)?;
    let request_sha256 = format!("{:x}", Sha256::digest(&request_bytes));
    let request_filename = candidate_request_asset_name(&fixture.transition.head, &request_sha256)?;
    let request_directory = new_work_dir.join("requests");
    fs::create_dir(&request_directory).map_err(|error| {
        format!("cannot create miniature request directory: {error}")
    })?;
    write_new_file(&request_directory.join(&request_filename), &request_bytes)?;
    parse_candidate_request_asset(&request_filename, &request_bytes)?;
    if !request_is_current(
        &request,
        &fixture.transition.head,
        &request.requirements.digest,
        fixture.transition.policy_version,
        &fixture.transition.policy_sha256,
        fixture.transition.guard_registry_version,
        &fixture.transition.guard_registry_sha256,
    ) {
        return Err("fresh miniature request is not current".to_string());
    }

    let retry_schedule = simulate_retry_schedule(
        &request_sha256,
        "formula:base:wasm32",
        &fixture.transition.fixture_clock,
    )?;
    records.write_value("retry-schedule", &retry_schedule)?;

    let formula_states = build_candidate_formulae(
        fixture_dir,
        &fixture,
        &request_sha256,
        &transport,
        &mut records,
    )?;
    let candidate_vfs = build_mini_vfs(
        new_work_dir,
        &fixture,
        &formula_states,
        LocalNamespaceV1::Candidate,
        &transport,
    )?;
    let product_evidence_sha256 = write_product_evidence(
        &fixture,
        &request,
        &request_sha256,
        &formula_states,
        &candidate_vfs,
        &transport,
        &mut records,
    )?;
    records.write_value(
        "product-readiness",
        &MiniProductReadinessV1 {
            schema: 1,
            kind: "kandelo-abi-staging-mini-product-readiness",
            request_sha256: &request_sha256,
            product_evidence_sha256: &product_evidence_sha256,
            required_products: vec!["mini-shell"],
            ready_products: vec!["mini-shell"],
            pending_background_formulae: &fixture.tap_plan.background_subjects,
        },
    )?;

    let history = MiniSourceHistoryV1 {
        schema: 1,
        kind: "kandelo-abi-staging-mini-source-history",
        branch: &fixture.transition.source_history_branch,
        source_abi: fixture.transition.source_abi,
        snapshot_sha256: &fixture.transition.source_snapshot_sha256,
        source_tree_sha256: &initial_source_tree,
        protected: fixture.transition.source_history_protected,
        verified: fixture.transition.source_history_verified,
    };
    check_source_history(history.protected, history.verified).map_err(guard_failure)?;
    let history_bytes = canonical_json_bytes(&history)?;
    let history_object = transport.publish(LocalNamespaceV1::Source, &history_bytes)?;
    let source_history_sha256 = records.write_value("source-history", &history)?;
    if source_history_sha256 != history_object.sha256 {
        return Err("source history transport and record identities differ".to_string());
    }
    if fixture_source_tree_sha256(fixture_dir)? != initial_source_tree {
        return Err("source ABI fixture tree changed during successor staging".to_string());
    }

    check_exact_build_source(&fixture.transition.head, &fixture.transition.head)
        .map_err(guard_failure)?;
    let canonical_layers = promote_formula_layers(
        &fixture,
        &request_sha256,
        &source_history_sha256,
        &formula_states,
        &transport,
        &mut records,
    )?;
    let canonical_vfs = build_mini_vfs(
        new_work_dir,
        &fixture,
        &canonical_layers,
        LocalNamespaceV1::Canonical,
        &transport,
    )?;
    if candidate_vfs.image.sha256 == canonical_vfs.image.sha256 {
        return Err("candidate and canonical VFS references did not recompose the image".to_string());
    }
    for candidate in &formula_states {
        let canonical = canonical_layers
            .iter()
            .find(|state| state.formula.name == candidate.formula.name)
            .ok_or_else(|| "promoted Formula state is incomplete".to_string())?;
        if candidate.candidate.sha256 != canonical.candidate.sha256 {
            return Err("canonical promotion rebuilt a bottle layer".to_string());
        }
    }

    let pages_result = simulate_atomic_pages(
        new_work_dir,
        &fixture,
        &request_sha256,
        &canonical_vfs,
        &mut records,
    )?;
    let negative_guards = exercise_negative_boundaries(
        &fixture,
        &request,
        &request_sha256,
        &candidate_vfs,
    )?;
    if fixture_source_tree_sha256(fixture_dir)? != initial_source_tree {
        return Err("source ABI fixture tree changed after final VFS composition".to_string());
    }

    let mut candidate_layer_digests = formula_states
        .iter()
        .map(|state| MiniNamedDigestV1 {
            id: state.formula.name.clone(),
            sha256: state.candidate.sha256.clone(),
        })
        .collect::<Vec<_>>();
    candidate_layer_digests.sort_by(|left, right| left.id.cmp(&right.id));
    let mut canonical_layer_digests = canonical_layers
        .iter()
        .map(|state| MiniNamedDigestV1 {
            id: state.formula.name.clone(),
            sha256: state.candidate.sha256.clone(),
        })
        .collect::<Vec<_>>();
    canonical_layer_digests.sort_by(|left, right| left.id.cmp(&right.id));
    let summary = MiniLifecycleSummaryV1 {
        schema: 1,
        kind: SUMMARY_KIND.to_string(),
        source_abi: fixture.transition.source_abi,
        target_abi: fixture.transition.target_abi,
        request_sha256,
        required_subjects: fixture.tap_plan.required_subjects,
        background_subjects: fixture.tap_plan.background_subjects,
        candidate_layers: candidate_layer_digests,
        canonical_layers: canonical_layer_digests,
        candidate_vfs_sha256: candidate_vfs.image.sha256,
        canonical_vfs_sha256: canonical_vfs.image.sha256,
        source_history_sha256,
        pages_result,
        retry_schedule,
        negative_guards,
        record_sha256s: records.digests,
    };
    write_new_file(
        &new_work_dir.join("summary.json"),
        &canonical_json_bytes(&summary)?,
    )?;
    Ok(summary)
}

fn build_request(
    fixture: &MiniFixtureV1,
    fixture_dir: &Path,
) -> Result<AbiStagingRequestV1, String> {
    let mut products = fixture
        .selection
        .iter()
        .map(|product| RequestProductBindingV1 {
            id: product.product_id.clone(),
            path: product.manifest_path.clone(),
            manifest_sha256: product.manifest_sha256.clone(),
        })
        .collect::<Vec<_>>();
    products.sort_by(|left, right| left.id.cmp(&right.id));
    let pages_path = repository_relative(&fixture_dir.join("pages.toml"))?;
    let tests_path = repository_relative(&fixture_dir.join("tests.toml"))?;
    let registries = vec![
        RequestRegistryBindingV1 {
            kind: RequestRegistryKindV1::Pages,
            path: pages_path,
            sha256: canonical_sha256(&fixture.pages)?,
        },
        RequestRegistryBindingV1 {
            kind: RequestRegistryKindV1::Tests,
            path: tests_path,
            sha256: canonical_sha256(&fixture.tests)?,
        },
    ];
    let mut evidence = fixture
        .selection
        .iter()
        .filter(|product| {
            !product.node_evidence.is_empty() || !product.browser_evidence.is_empty()
        })
        .map(|product| RequestEvidenceBindingV1 {
            product_id: product.product_id.clone(),
            applicability: product.applicability,
            node: product.node_evidence.clone(),
            browser: product.browser_evidence.clone(),
        })
        .collect::<Vec<_>>();
    evidence.sort_by(|left, right| left.product_id.cmp(&right.product_id));
    let mut requirements = RequestRequirementsV1 {
        digest: "0".repeat(64),
        change_classes: vec![ChangeClass::Abi],
        products,
        registries,
        evidence,
    };
    requirements.digest = request_requirements_digest(&requirements)?;
    let request = AbiStagingRequestV1 {
        schema: 1,
        kind: "kandelo-abi-staging-request".to_string(),
        pull_request: PullRequestRequestIdentityV1 {
            repository: fixture.transition.repository.clone(),
            number: fixture.transition.pull_request,
        },
        build_source: exact_pr_source(&fixture.transition),
        target_abi: TargetAbiV1 {
            version: fixture.transition.target_abi,
            snapshot_sha256: fixture.transition.target_snapshot_sha256.clone(),
        },
        requirements,
        issuance: RequestIssuanceV1 {
            issuer_repository: fixture.transition.repository.clone(),
            issuer_workflow_ref: ".github/workflows/abi-staging-request.yml@protected"
                .to_string(),
            policy_version: fixture.transition.policy_version,
            policy_sha256: fixture.transition.policy_sha256.clone(),
            guard_registry_version: fixture.transition.guard_registry_version,
            guard_registry_sha256: fixture.transition.guard_registry_sha256.clone(),
            authorization: RequestAuthorizationV1::SameRepository {
                head: fixture.transition.head.clone(),
            },
        },
        informational_context: RequestInformationalContextV1 {
            base_commit: None,
            base_tree: None,
            previous_abi: Some(fixture.transition.source_abi),
            ref_hint: Some(format!(
                "refs/pull/{}/head",
                fixture.transition.pull_request
            )),
        },
    };
    validate_request(&request)?;
    Ok(request)
}

fn build_candidate_formulae(
    fixture_dir: &Path,
    fixture: &MiniFixtureV1,
    request_sha256: &str,
    transport: &LocalContentAddressedTransport,
    records: &mut RecordLedgerV1,
) -> Result<Vec<MiniFormulaStateV1>, String> {
    let by_name = fixture
        .tap
        .formulae
        .iter()
        .map(|formula| (formula.name.as_str(), formula))
        .collect::<BTreeMap<_, _>>();
    let mut states = Vec::<MiniFormulaStateV1>::new();
    for (index, name) in fixture.tap_plan.required_subjects.iter().enumerate() {
        let formula = by_name
            .get(name.as_str())
            .ok_or_else(|| format!("planned Formula {name:?} disappeared"))?;
        let source_path = resolve_fixture_path(
            fixture_dir,
            formula
                .source
                .as_deref()
                .ok_or_else(|| format!("required Formula {name:?} has no source"))?,
            "required Formula source",
        )?;
        let source_bytes = read_bounded_regular_file(&source_path, MAX_FIXTURE_BYTES)?;
        let source = transport.publish(LocalNamespaceV1::Source, &source_bytes)?;
        let layer_bytes = canonical_json_bytes(&MiniBottleLayerV1 {
            schema: 1,
            kind: "kandelo-abi-staging-mini-bottle-layer",
            formula: &formula.name,
            version: &formula.version,
            revision: formula.revision,
            bottle_rebuild: formula.bottle_rebuild,
            architecture: formula.architecture,
            target_abi: fixture.transition.target_abi,
            source_sha256: source.sha256.clone(),
            direct_dependencies: &formula.dependencies,
        })?;
        if formula.disposition == MiniFormulaDispositionV1::Reuse {
            // Seed an exact pre-existing candidate, then reconcile the same
            // bytes through the ordinary publication path.
            transport.publish(LocalNamespaceV1::Candidate, &layer_bytes)?;
        }
        let candidate = transport.publish(LocalNamespaceV1::Candidate, &layer_bytes)?;
        if transport
            .anonymous_reader()?
            .read(&candidate.immutable_reference)?
            != layer_bytes
        {
            return Err("anonymous candidate readback changed exact bytes".to_string());
        }
        let candidate_artifact = artifact_from_local(&candidate);
        let producer = CandidateProducerV1 {
            request_sha256: request_sha256.to_string(),
            head: fixture.transition.head.clone(),
            run_id: 1_000 + index as u64,
        };

        if formula.disposition == MiniFormulaDispositionV1::Build {
            let attempt = AbiStagingRecordV1::Attempt(AttemptRecordV1 {
                schema: 1,
                common: successful_common(
                    request_sha256,
                    exact_formula_subject(fixture, formula),
                    fixture,
                    1_000 + index as u64,
                    ArtifactClassV1::Candidate,
                    Some(candidate_artifact.clone()),
                    PromotionStateV1::Eligible,
                ),
                attempt: AttemptPayloadV1 {
                    formula: formula_subject(fixture, formula),
                    source_capsule: artifact_from_local(&source),
                    build: RunnerBuildFactsV1 {
                        runner_image: "repository-dev-shell".to_string(),
                        command_sha256: sha256_bytes(b"mini-build-from-exact-source"),
                        result_sha256: candidate.sha256.clone(),
                        diagnostics: Vec::new(),
                    },
                    retry_ordinal: 0,
                    candidate: Some(candidate_artifact.clone()),
                },
            });
            records.write_record(&format!("attempt-{}", formula.name), &attempt)?;
        }

        let mut direct_dependencies = Vec::new();
        for dependency in &formula.dependencies {
            let state = states
                .iter()
                .find(|state| state.formula.name == *dependency)
                .ok_or_else(|| {
                    format!("Formula {:?} dependency {dependency:?} was not built first", formula.name)
                })?;
            direct_dependencies.push(NamedArtifactIdentityV1 {
                id: dependency.clone(),
                artifact: artifact_from_local(&state.candidate),
            });
        }
        direct_dependencies.sort_by(|left, right| left.id.cmp(&right.id));
        let candidate_record = AbiStagingRecordV1::Candidate(CandidateRecordV1 {
            schema: 1,
            common: successful_common(
                request_sha256,
                ExactSubjectV1 {
                    kind: SubjectKindV1::Candidate,
                    identity: format!(
                        "{}/{}@sha256:{}",
                        fixture.tap.source.repository, formula.name, candidate.sha256
                    ),
                    architecture: None,
                },
                fixture,
                1_100 + index as u64,
                ArtifactClassV1::Candidate,
                Some(candidate_artifact.clone()),
                PromotionStateV1::Eligible,
            ),
            candidate: CandidatePayloadV1 {
                formula: candidate_formula(fixture, formula),
                bottle_layer: candidate_artifact.clone(),
                normalized_components: vec![
                    NamedArtifactIdentityV1 {
                        id: "bottle-contract".to_string(),
                        artifact: ArtifactIdentityV1 {
                            sha256: fixture.transition.policy_sha256.clone(),
                            bytes: fixture.transition.policy_sha256.len() as u64,
                            immutable_reference: Some(format!(
                                "fixture:bottle-contract@sha256:{}",
                                fixture.transition.policy_sha256
                            )),
                        },
                    },
                    NamedArtifactIdentityV1 {
                        id: "bottle-metadata".to_string(),
                        artifact: candidate_artifact.clone(),
                    },
                    NamedArtifactIdentityV1 {
                        id: "source-custody".to_string(),
                        artifact: artifact_from_local(&source),
                    },
                ],
                direct_dependency_layers: direct_dependencies,
                source_custody_sha256: source.sha256.clone(),
                producer: producer.clone(),
                nonendorsed: true,
            },
        });
        let candidate_record_sha256 =
            records.write_record(&format!("candidate-{}", formula.name), &candidate_record)?;

        let verification = AbiStagingRecordV1::Verification(VerificationReceiptV1 {
            schema: 1,
            common: successful_common(
                request_sha256,
                ExactSubjectV1 {
                    kind: SubjectKindV1::Candidate,
                    identity: format!("candidate-record:{candidate_record_sha256}"),
                    architecture: None,
                },
                fixture,
                1_200 + index as u64,
                ArtifactClassV1::Candidate,
                Some(candidate_artifact.clone()),
                PromotionStateV1::Eligible,
            ),
            verification: VerificationPayloadV1 {
                candidate_record_sha256: candidate_record_sha256.clone(),
                candidate_layer: candidate_artifact,
                test_definition_sha256: sha256_bytes(
                    format!("mini-formula-verification:{}", formula.name).as_bytes(),
                ),
                host: VerificationHostV1::Build,
                kernel: None,
                host_runtime: None,
                vfs: None,
                attempt_ordinal: 1,
                diagnostics: Vec::new(),
            },
        });
        let verification_receipt_sha256 = records.write_record(
            &format!("verification-{}", formula.name),
            &verification,
        )?;
        states.push(MiniFormulaStateV1 {
            formula: (*formula).clone(),
            candidate,
            candidate_record_sha256,
            verification_receipt_sha256,
            producer,
        });
    }
    Ok(states)
}

fn exact_pr_source(transition: &MiniTransitionV1) -> ExactGitSourceV1 {
    ExactGitSourceV1 {
        repository: transition.repository.clone(),
        commit: transition.head.clone(),
        tree: transition.tree.clone(),
    }
}

fn formula_subject(fixture: &MiniFixtureV1, formula: &MiniTapFormulaV1) -> FormulaBuildSubjectV1 {
    FormulaBuildSubjectV1 {
        tap: fixture.tap.source.repository.clone(),
        formula: formula.name.clone(),
        architecture: formula.architecture,
        target_abi: fixture.transition.target_abi,
        bottle_contract_sha256: fixture.transition.policy_sha256.clone(),
    }
}

fn candidate_formula(
    fixture: &MiniFixtureV1,
    formula: &MiniTapFormulaV1,
) -> CandidateFormulaV1 {
    CandidateFormulaV1 {
        tap: fixture.tap.source.repository.clone(),
        formula: formula.name.clone(),
        version: formula.version.clone(),
        revision: formula.revision,
        bottle_rebuild: formula.bottle_rebuild,
        architecture: formula.architecture,
        target_abi: fixture.transition.target_abi,
        bottle_contract_sha256: fixture.transition.policy_sha256.clone(),
    }
}

fn exact_formula_subject(
    fixture: &MiniFixtureV1,
    formula: &MiniTapFormulaV1,
) -> ExactSubjectV1 {
    ExactSubjectV1 {
        kind: SubjectKindV1::Formula,
        identity: format!(
            "{}/{}@abi/{}",
            fixture.tap.source.repository, formula.name, fixture.transition.target_abi
        ),
        architecture: Some(formula.architecture),
    }
}

fn successful_common(
    request_sha256: &str,
    subject: ExactSubjectV1,
    fixture: &MiniFixtureV1,
    run_id: u64,
    artifact_class: ArtifactClassV1,
    artifact: Option<ArtifactIdentityV1>,
    promotion_state: PromotionStateV1,
) -> RecordCommonV1 {
    RecordCommonV1 {
        request_sha256: request_sha256.to_string(),
        subject,
        source: exact_pr_source(&fixture.transition),
        run: RecordRunProvenanceV1 {
            repository: fixture.transition.repository.clone(),
            workflow_ref: "local-fixture:abi-staging-mini".to_string(),
            run_id,
            run_attempt: 1,
            job: "mini-lifecycle".to_string(),
        },
        guard_codes: Vec::new(),
        work_state: WorkStateV1::Complete,
        outcome: Some(TerminalOutcomeV1::Success),
        artifact_class,
        artifact,
        promotion_state,
        admission_sha256: None,
        retry_state: RetryStateV1 {
            attempts: 0,
            eligible: false,
            exhausted: false,
            next_action: RetryNextActionV1::None,
            next_eligible_at: None,
        },
        blockers: Vec::new(),
    }
}

fn artifact_from_local(object: &PublishedLocalObjectV1) -> ArtifactIdentityV1 {
    ArtifactIdentityV1 {
        sha256: object.sha256.clone(),
        bytes: object.bytes,
        immutable_reference: Some(object.immutable_reference.clone()),
    }
}

fn build_mini_vfs(
    work_dir: &Path,
    fixture: &MiniFixtureV1,
    formulae: &[MiniFormulaStateV1],
    namespace: LocalNamespaceV1,
    transport: &LocalContentAddressedTransport,
) -> Result<MiniVfsBuildResultV1, String> {
    let namespace_name = match namespace {
        LocalNamespaceV1::Candidate => "candidate",
        LocalNamespaceV1::Canonical => "canonical",
        LocalNamespaceV1::Source => {
            return Err("a VFS cannot use the source transport namespace".to_string())
        }
    };
    let build_root = work_dir.join(format!("vfs-{namespace_name}"));
    fs::create_dir(&build_root).map_err(|error| {
        format!("cannot create miniature VFS build root {}: {error}", build_root.display())
    })?;
    let inputs_directory = build_root.join("inputs");
    fs::create_dir(&inputs_directory).map_err(|error| {
        format!("cannot create miniature VFS input directory: {error}")
    })?;
    let base = formulae
        .iter()
        .find(|state| state.formula.name == "base")
        .ok_or_else(|| "miniature VFS requires the product-derived base Formula".to_string())?;
    let tool = formulae
        .iter()
        .find(|state| state.formula.name == "tool")
        .ok_or_else(|| "miniature VFS requires the product-derived tool Formula".to_string())?;
    let anonymous = transport.anonymous_reader()?;
    let base_bytes = anonymous.read(&base.candidate.immutable_reference)?;
    let tool_bytes = anonymous.read(&tool.candidate.immutable_reference)?;
    if sha256_bytes(&tool_bytes) != tool.candidate.sha256
        || tool_bytes.len() as u64 != tool.candidate.bytes
    {
        return Err("miniature lazy reference did not open exact transport bytes".to_string());
    }
    write_new_file(&inputs_directory.join("base.bottle"), &base_bytes)?;
    let base_metadata = b"{\"formula\":\"base\"}\n";
    let tool_metadata = b"{\"formula\":\"tool\"}\n";
    write_new_file(&inputs_directory.join("base-metadata.json"), base_metadata)?;
    write_new_file(&inputs_directory.join("tool-metadata.json"), tool_metadata)?;
    let descriptor = |name: &str, bytes: &[u8]| ResolvedVfsInputDescriptorV1 {
        sha256: sha256_bytes(bytes),
        bytes: bytes.len() as u64,
        reference: format!(
            "local-fixture:sha256:{}?namespace={namespace_name}&bytes={}",
            sha256_bytes(bytes),
            bytes.len(),
        ),
        path: format!("inputs/{name}-metadata.json"),
    };
    let product = fixture
        .catalog
        .products
        .iter()
        .find(|entry| entry.manifest.id == "mini-shell")
        .ok_or_else(|| "miniature catalog is missing mini-shell".to_string())?;
    let identity = product_identity(product);
    let inputs = ResolvedVfsProductInputsV1 {
        schema: 1,
        kind: "kandelo-resolved-vfs-product-inputs".to_string(),
        product: identity,
        target_abi: TargetAbiV1 {
            version: fixture.transition.target_abi,
            snapshot_sha256: fixture.transition.target_snapshot_sha256.clone(),
        },
        build_environment: VfsBuildEnvironmentV1 {
            policy_sha256: fixture.transition.policy_sha256.clone(),
            dev_shell_lock_sha256: sha256_file(&crate::repo_root().join("flake.lock"))?,
        },
        reference_class: VfsReferenceClassV1::LocalFixture,
        source: ExactSourceV1 {
            repository: fixture.transition.repository.clone(),
            commit: fixture.transition.head.clone(),
            tree: fixture.transition.tree.clone(),
        },
        inputs: vec![
            ResolvedVfsInputV1 {
                id: "base-bottle".to_string(),
                kind: ResolvedVfsInputKindV1::HomebrewBottle,
                role: SoftwareRoleV1::Runtime,
                architecture: base.formula.architecture,
                declared_materialization: DeclaredInputMaterializationV1::Embedded,
                effective_materialization: ConsumedInputPlacementV1::Embedded,
                sha256: base.candidate.sha256.clone(),
                bytes: base.candidate.bytes,
                reference: Some(base.candidate.immutable_reference.clone()),
                path: Some("inputs/base.bottle".to_string()),
                descriptor: Some(descriptor("base", base_metadata)),
            },
            ResolvedVfsInputV1 {
                id: "tool-bottle".to_string(),
                kind: ResolvedVfsInputKindV1::HomebrewBottle,
                role: SoftwareRoleV1::Runtime,
                architecture: tool.formula.architecture,
                declared_materialization: DeclaredInputMaterializationV1::Lazy,
                effective_materialization: ConsumedInputPlacementV1::LazyReference,
                sha256: tool.candidate.sha256.clone(),
                bytes: tool.candidate.bytes,
                reference: Some(tool.candidate.immutable_reference.clone()),
                path: None,
                descriptor: Some(descriptor("tool", tool_metadata)),
            },
        ],
    };
    let input_bytes = canonical_json_bytes(&inputs)?;
    let inputs_path = build_root.join("resolved-inputs.json");
    write_new_file(&inputs_path, &input_bytes)?;
    let validated_inputs =
        validate_resolved_inputs_for_miniature(&input_bytes, &build_root)?;
    let report_path = build_root.join("builder-report.json");
    let output_path = build_root.join(&product.manifest.output);
    let manifest_path = crate::repo_root().join(&product.path);
    let builder = crate::repo_root().join("node_modules/.bin/tsx");
    let builder_home = build_root.join("home");
    let builder_tmp = build_root.join("tmp");
    fs::create_dir(&builder_home)
        .map_err(|error| format!("cannot create miniature builder HOME: {error}"))?;
    fs::create_dir(&builder_tmp)
        .map_err(|error| format!("cannot create miniature builder TMPDIR: {error}"))?;
    let declared_path = std::env::var("KANDELO_DEV_SHELL_TOOL_PATH").map_err(|_| {
        "miniature VFS builder must run through scripts/dev-shell.sh".to_string()
    })?;
    let output = Command::new(&builder)
        .env_clear()
        .env("PATH", declared_path)
        .env("HOME", &builder_home)
        .env("TMPDIR", &builder_tmp)
        .env("CI", "true")
        .env("SOURCE_DATE_EPOCH", "0")
        .current_dir(crate::repo_root())
        .arg(crate::repo_root().join("images/vfs/scripts/build-abi-staging-mini-vfs.ts"))
        .arg("--vfs-product-manifest")
        .arg(&manifest_path)
        .arg("--vfs-product-inputs")
        .arg(&inputs_path)
        .arg("--vfs-product-report")
        .arg(&report_path)
        .arg("--vfs-product-output")
        .arg(&output_path)
        .output()
        .map_err(|error| format!("cannot launch miniature VFS builder: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "miniature VFS builder failed with {}: {}{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let report_bytes = read_bounded_regular_file(&report_path, 4 * 1024 * 1024)?;
    let report = validate_builder_report(&report_bytes, &build_root)?;
    compare_builder_report(&validated_inputs, &report)?;
    let image_bytes = read_bounded_regular_file(&output_path, 64 * 1024 * 1024)?;
    let image = transport.publish(namespace, &image_bytes)?;
    if transport
        .anonymous_reader()?
        .read(&image.immutable_reference)?
        != image_bytes
    {
        return Err("anonymous miniature VFS readback changed bytes".to_string());
    }
    let report_object = transport.publish(namespace, &report_bytes)?;
    Ok(MiniVfsBuildResultV1 {
        image,
        report_object,
        inputs_sha256: format!("{:x}", Sha256::digest(&input_bytes)),
        inputs,
        report,
    })
}

fn write_product_evidence(
    fixture: &MiniFixtureV1,
    request: &AbiStagingRequestV1,
    request_sha256: &str,
    formulae: &[MiniFormulaStateV1],
    vfs: &MiniVfsBuildResultV1,
    transport: &LocalContentAddressedTransport,
    records: &mut RecordLedgerV1,
) -> Result<String, String> {
    let product = fixture
        .catalog
        .products
        .iter()
        .find(|entry| entry.manifest.id == "mini-shell")
        .ok_or_else(|| "mini-shell product disappeared before evidence".to_string())?;
    let kernel = transport.publish(LocalNamespaceV1::Candidate, b"mini kernel identity\n")?;
    let host = transport.publish(
        LocalNamespaceV1::Candidate,
        b"mini host runtime identity\n",
    )?;
    let mut layers = formulae
        .iter()
        .map(|state| NamedArtifactIdentityV1 {
            id: state.formula.name.clone(),
            artifact: artifact_from_local(&state.candidate),
        })
        .collect::<Vec<_>>();
    layers.sort_by(|left, right| left.id.cmp(&right.id));
    let selected = fixture
        .selection
        .iter()
        .find(|selected| selected.product_id == "mini-shell")
        .ok_or_else(|| "mini-shell selection disappeared before evidence".to_string())?;
    let mut evidence_definition_sha256s = selected
        .node_evidence
        .iter()
        .chain(&selected.browser_evidence)
        .map(|id| sha256_bytes(id.as_bytes()))
        .collect::<Vec<_>>();
    evidence_definition_sha256s.sort();
    evidence_definition_sha256s.dedup();
    let mut verification_receipt_sha256s = formulae
        .iter()
        .map(|state| state.verification_receipt_sha256.clone())
        .collect::<Vec<_>>();
    verification_receipt_sha256s.sort();
    let vfs_identity = artifact_from_local(&vfs.image);
    let builder_report_identity = artifact_from_local(&vfs.report_object);
    let kernel_identity = artifact_from_local(&kernel);
    let host_identity = artifact_from_local(&host);
    let candidate_manifest_sha256 = canonical_sha256(&serde_json::json!({
        "builder_report": builder_report_identity,
        "product": product_identity(product),
        "resolved_inputs_sha256": vfs.inputs_sha256,
        "vfs_image": vfs_identity,
    }))?;
    let candidate_reference = format!("local-fixture:sha256:{candidate_manifest_sha256}");
    let runtime_bundle_sha256 = canonical_sha256(&serde_json::json!({
        "host_runtime": host_identity,
        "kernel": kernel_identity,
    }))?;
    let mut receipt_outcomes = selected
        .node_evidence
        .iter()
        .map(|id| ("node", id))
        .chain(selected.browser_evidence.iter().map(|id| ("browser", id)))
        .map(|(host, id)| {
            serde_json::json!({
                "accepted_with_override": false,
                "applicability": "required",
                "definition_sha256": sha256_bytes(id.as_bytes()),
                "guard_codes": [],
                "host": host,
                "id": id,
                "outcome": "success",
            })
        })
        .collect::<Vec<_>>();
    receipt_outcomes.sort_by(|left, right| {
        left["host"]
            .as_str()
            .unwrap_or_default()
            .cmp(right["host"].as_str().unwrap_or_default())
            .then_with(|| {
                left["id"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(right["id"].as_str().unwrap_or_default())
            })
    });
    let runtime_evidence_sha256 = canonical_sha256(&serde_json::json!({
        "candidate_product": {
            "builder_report_sha256": vfs.report_object.sha256,
            "immutable_reference": candidate_reference,
            "manifest_digest": format!("sha256:{candidate_manifest_sha256}"),
            "product_id": product.manifest.id,
            "repository": "local-fixture/candidate-products/mini-shell",
            "vfs_layer_bytes": vfs.image.bytes,
            "vfs_layer_sha256": vfs.image.sha256,
        },
        "evidence_definition_sha256s": evidence_definition_sha256s,
        "kind": "kandelo-vfs-runtime-evidence-identity",
        "receipt_outcomes": receipt_outcomes,
        "resolved_inputs_sha256": vfs.inputs_sha256,
        "runtime_bundle_sha256": runtime_bundle_sha256,
        "schema": 1,
    }))?;
    let record = AbiStagingRecordV1::ProductEvidence(ProductEvidenceRecordV1 {
        schema: 1,
        common: successful_common(
            request_sha256,
            ExactSubjectV1 {
                kind: SubjectKindV1::Product,
                identity: "mini-shell".to_string(),
                architecture: None,
            },
            fixture,
            1_500,
            ArtifactClassV1::Candidate,
            Some(artifact_from_local(&vfs.image)),
            PromotionStateV1::Eligible,
        ),
        product_evidence: ProductEvidencePayloadV1 {
            product: product_identity(product),
            selecting_registries: request.requirements.registries.clone(),
            resolved_formula_layers: layers,
            resolved_inputs_sha256: vfs.inputs_sha256.clone(),
            runtime_evidence_sha256,
            vfs_image: vfs_identity,
            builder_report: builder_report_identity,
            kernel: kernel_identity,
            host_runtime: host_identity,
            evidence_definition_sha256s,
            verification_receipt_sha256s,
        },
    });
    records.write_record("product-evidence-mini-shell", &record)
}

fn promote_formula_layers(
    fixture: &MiniFixtureV1,
    request_sha256: &str,
    abi_history_record_sha256: &str,
    candidates: &[MiniFormulaStateV1],
    transport: &LocalContentAddressedTransport,
    records: &mut RecordLedgerV1,
) -> Result<Vec<MiniFormulaStateV1>, String> {
    let reader = transport.anonymous_reader()?;
    let mut promoted = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let bytes = reader.read(&candidate.candidate.immutable_reference)?;
        let canonical = transport.publish(LocalNamespaceV1::Canonical, &bytes)?;
        if canonical.sha256 != candidate.candidate.sha256
            || transport
                .anonymous_reader()?
                .read(&canonical.immutable_reference)?
                != bytes
        {
            return Err("canonical promotion changed or obscured bottle bytes".to_string());
        }
        let record = AbiStagingRecordV1::Admission(AdmissionRecordV1 {
            schema: 1,
            common: successful_common(
                request_sha256,
                ExactSubjectV1 {
                    kind: SubjectKindV1::Candidate,
                    identity: candidate.candidate_record_sha256.clone(),
                    architecture: None,
                },
                fixture,
                2_000 + index as u64,
                ArtifactClassV1::Canonical,
                Some(artifact_from_local(&canonical)),
                PromotionStateV1::Promoted,
            ),
            admission: AdmissionPayloadV1 {
                abi_history_record_sha256: abi_history_record_sha256.to_string(),
                candidate_binding_sha256: candidate.candidate_record_sha256.clone(),
                candidate_record_sha256: candidate.candidate_record_sha256.clone(),
                promoted_layer: artifact_from_local(&candidate.candidate),
                qualifying_receipt_sha256s: vec![
                    candidate.verification_receipt_sha256.clone(),
                ],
                merged_pull_request: MergedPullRequestV1 {
                    repository: fixture.transition.repository.clone(),
                    number: fixture.transition.pull_request,
                    head: fixture.transition.head.clone(),
                    merge_commit: fixture.transition.synthetic_merge_commit.clone(),
                },
                preactivation_tap_source: fixture.tap.source.clone(),
                tap_source: ExactGitSourceV1 {
                    repository: fixture.tap.source.repository.clone(),
                    commit: "6666666666666666666666666666666666666666".to_string(),
                    tree: "7777777777777777777777777777777777777777".to_string(),
                },
                canonical: artifact_from_local(&canonical),
                canonical_public_readback_sha256: canonical.sha256.clone(),
                formula_metadata_source: ExactGitSourceV1 {
                    repository: fixture.tap.source.repository.clone(),
                    commit: "dddddddddddddddddddddddddddddddddddddddd".to_string(),
                    tree: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_string(),
                },
                formula_metadata_update: FormulaMetadataUpdateV1 {
                    formula: candidate.formula.name.clone(),
                    architecture: candidate.formula.architecture,
                    expected_main_commit: "6666666666666666666666666666666666666666"
                        .to_string(),
                    expected_normalized_formula_sha256: fixture.transition.policy_sha256.clone(),
                    expected_generated_metadata_sha256: fixture
                        .transition
                        .target_snapshot_sha256
                        .clone(),
                    allowed_paths: vec![
                        format!("Formula/{}.rb", candidate.formula.name),
                        format!("Kandelo/formula/{}.json", candidate.formula.name),
                        "Kandelo/metadata.json".to_string(),
                        format!(
                            "Kandelo/link/{}-{}-rebuild{}-{}.json",
                            candidate.formula.name,
                            if candidate.formula.revision == 0 {
                                candidate.formula.version.clone()
                            } else {
                                format!(
                                    "{}_{}",
                                    candidate.formula.version, candidate.formula.revision
                                )
                            },
                            candidate.formula.bottle_rebuild,
                            match candidate.formula.architecture {
                                VfsArchitectureV1::Wasm32 => "wasm32",
                                VfsArchitectureV1::Wasm64 => "wasm64",
                            }
                        ),
                    ],
                    link_manifest_path: format!(
                        "Kandelo/link/{}-{}-rebuild{}-{}.json",
                        candidate.formula.name,
                        if candidate.formula.revision == 0 {
                            candidate.formula.version.clone()
                        } else {
                            format!(
                                "{}_{}",
                                candidate.formula.version, candidate.formula.revision
                            )
                        },
                        candidate.formula.bottle_rebuild,
                        match candidate.formula.architecture {
                            VfsArchitectureV1::Wasm32 => "wasm32",
                            VfsArchitectureV1::Wasm64 => "wasm64",
                        }
                    ),
                    link_manifest_sha256: fixture.transition.policy_sha256.clone(),
                    canonical_manifest_digest: canonical.sha256.clone(),
                    bottle_layer_sha256: candidate.candidate.sha256.clone(),
                    bottle_layer_bytes: candidate.candidate.bytes,
                    target_abi: fixture.transition.target_abi,
                },
                original_producer: candidate.producer.clone(),
            },
        });
        records.write_record(
            &format!("admission-{}", candidate.formula.name),
            &record,
        )?;
        let mut state = candidate.clone();
        state.candidate = canonical;
        promoted.push(state);
    }
    Ok(promoted)
}

fn simulate_atomic_pages(
    work_dir: &Path,
    fixture: &MiniFixtureV1,
    request_sha256: &str,
    canonical_vfs: &MiniVfsBuildResultV1,
    records: &mut RecordLedgerV1,
) -> Result<MiniPagesResultV1, String> {
    let pages_dir = work_dir.join("pages");
    fs::create_dir(&pages_dir)
        .map_err(|error| format!("cannot create miniature Pages directory: {error}"))?;
    let current_path = pages_dir.join("current-site.json");
    let prior_bytes = canonical_json_bytes(&serde_json::json!({
        "kind": "kandelo-abi-staging-mini-prior-site",
        "schema": 1,
    }))?;
    let prior_sha256 = sha256_bytes(&prior_bytes);
    write_new_file(&current_path, &prior_bytes)?;
    let mut required_products = fixture
        .pages
        .products
        .iter()
        .map(|product| product.id.clone())
        .collect::<Vec<_>>();
    required_products.sort();
    let missing = required_products.clone();
    let held_available = Vec::<MiniNamedDigestV1>::new();
    let held = MiniPagesReadinessRecordV1 {
        schema: 1,
        kind: PAGES_KIND,
        request_sha256,
        required_products: &required_products,
        available_products: &held_available,
        missing_products: &missing,
        disposition: MiniPagesDispositionV1::HeldLastComplete,
        prior_site_sha256: &prior_sha256,
        complete_site_sha256: None,
    };
    records.write_value("pages-held", &held)?;
    if fs::read(&current_path).map_err(|error| format!("cannot reread prior site: {error}"))?
        != prior_bytes
    {
        return Err("incomplete Pages inventory replaced the prior site".to_string());
    }

    if required_products != ["mini-shell"] {
        return Err("miniature Pages fixture must select exactly mini-shell".to_string());
    }
    let available = vec![MiniNamedDigestV1 {
        id: "mini-shell".to_string(),
        sha256: canonical_vfs.image.sha256.clone(),
    }];
    let site = MiniPagesSiteV1 {
        schema: 1,
        kind: "kandelo-abi-staging-mini-pages-site",
        request_sha256,
        products: &available,
    };
    let site_bytes = canonical_json_bytes(&site)?;
    let site_sha256 = sha256_bytes(&site_bytes);
    let next_path = pages_dir.join("next-complete-site.json");
    write_new_file(&next_path, &site_bytes)?;
    write_new_file(&pages_dir.join("retained-prior-site.json"), &prior_bytes)?;
    fs::rename(&next_path, &current_path).map_err(|error| {
        format!("cannot atomically replace miniature Pages site: {error}")
    })?;
    if fs::read(&current_path).map_err(|error| format!("cannot read current site: {error}"))?
        != site_bytes
    {
        return Err("atomic Pages replacement did not publish the complete site".to_string());
    }
    let no_missing = Vec::<String>::new();
    let ready = MiniPagesReadinessRecordV1 {
        schema: 1,
        kind: PAGES_KIND,
        request_sha256,
        required_products: &required_products,
        available_products: &available,
        missing_products: &no_missing,
        disposition: MiniPagesDispositionV1::DeployedComplete,
        prior_site_sha256: &prior_sha256,
        complete_site_sha256: Some(&site_sha256),
    };
    records.write_value("pages-ready", &ready)?;
    Ok(MiniPagesResultV1::DeployedComplete)
}

fn exercise_negative_boundaries(
    fixture: &MiniFixtureV1,
    request: &AbiStagingRequestV1,
    request_sha256: &str,
    candidate_vfs: &MiniVfsBuildResultV1,
) -> Result<Vec<GuardCodeV1>, String> {
    let mut incomplete_report = candidate_vfs.report.clone();
    incomplete_report.capture.complete = false;
    let comparison = compare_builder_report(&candidate_vfs.inputs, &incomplete_report)
        .expect_err("incomplete miniature capture must fail");
    if !comparison.contains("[build_input_capture_incomplete]") {
        return Err("incomplete capture did not use its registered guard".to_string());
    }
    let capture = check_complete_capture(false, &[]).unwrap_err();
    let wrong_override = check_override_subject(
        request_sha256,
        "formula:base:wasm32",
        request_sha256,
        "formula:tool:wasm32",
    )
    .unwrap_err();
    let application = classify_attempt_failure(
        MiniAttemptFailureKindV1::Application,
        GuardCodeV1::TransientInfrastructureFailure,
    )
    .unwrap_err();
    let current = request_is_current(
        request,
        &fixture.transition.head,
        &request.requirements.digest,
        fixture.transition.policy_version,
        &"e".repeat(64),
        fixture.transition.guard_registry_version,
        &fixture.transition.guard_registry_sha256,
    );
    let stale = check_current_policy(current).unwrap_err();
    let history = check_source_history(true, false).unwrap_err();
    let synthetic = check_exact_build_source(
        &fixture.transition.synthetic_merge_commit,
        &fixture.transition.head,
    )
    .unwrap_err();
    Ok(vec![
        capture,
        wrong_override,
        application,
        stale,
        history,
        synthetic,
    ])
}

fn simulate_retry_schedule(
    request_sha256: &str,
    subject: &str,
    fixture_clock: &str,
) -> Result<Vec<MiniRetryScheduleV1>, String> {
    let (prefix, base_milliseconds) = parse_fixture_clock(fixture_clock)?;
    let mut elapsed = 0_u64;
    let mut schedule = Vec::new();
    for retry_number in 1..=3 {
        let delay_ms =
            deterministic_retry_delay_ms(request_sha256, subject, retry_number, 1_000, 8_000)?;
        elapsed = elapsed
            .checked_add(delay_ms)
            .ok_or_else(|| "miniature retry clock overflow".to_string())?;
        let total = base_milliseconds
            .checked_add(elapsed)
            .ok_or_else(|| "miniature retry timestamp overflow".to_string())?;
        if total >= 60_000 {
            return Err("miniature retry fixture crosses its deterministic minute".to_string());
        }
        schedule.push(MiniRetryScheduleV1 {
            retry_number,
            delay_ms,
            next_eligible_at: format!("{prefix}{:02}.{:03}Z", total / 1_000, total % 1_000),
        });
    }
    Ok(schedule)
}

fn parse_fixture_clock(value: &str) -> Result<(String, u64), String> {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| !matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) && !byte.is_ascii_digit())
    {
        return Err("miniature fixture clock must be millisecond UTC RFC 3339".to_string());
    }
    let second = value[17..19]
        .parse::<u64>()
        .map_err(|_| "miniature fixture clock second is invalid".to_string())?;
    let millis = value[20..23]
        .parse::<u64>()
        .map_err(|_| "miniature fixture clock milliseconds are invalid".to_string())?;
    if second >= 60 {
        return Err("miniature fixture clock second is outside UTC policy".to_string());
    }
    Ok((value[..17].to_string(), second * 1_000 + millis))
}

fn product_identity(entry: &VfsProductCatalogEntryV1) -> VfsProductIdentityV1 {
    VfsProductIdentityV1 {
        id: entry.manifest.id.clone(),
        manifest_path: entry.path.clone(),
        manifest_sha256: entry.sha256.clone(),
        architecture: entry.manifest.architecture,
        output: entry.manifest.output.clone(),
    }
}

pub fn deterministic_retry_delay_ms(
    request_digest: &str,
    exact_subject: &str,
    retry_number: u8,
    base_ms: u64,
    cap_ms: u64,
) -> Result<u64, String> {
    validate_sha256(request_digest)?;
    if exact_subject.is_empty()
        || exact_subject.len() > 512
        || exact_subject.contains('\0')
        || exact_subject.chars().any(char::is_whitespace)
    {
        return Err("retry subject must be a bounded exact identity".to_string());
    }
    if !(1..=3).contains(&retry_number) {
        return Err("automatic retry number must be 1 through 3".to_string());
    }
    if base_ms == 0 || cap_ms == 0 || cap_ms == u64::MAX {
        return Err("retry base and cap must be positive bounded milliseconds".to_string());
    }
    let exponent = u32::from(retry_number - 1);
    let exponential = base_ms
        .checked_mul(1_u64 << exponent)
        .ok_or_else(|| "retry window arithmetic overflow".to_string())?;
    let window_ms = cap_ms.min(exponential);
    let mut hasher = Sha256::new();
    hasher.update(request_digest.as_bytes());
    hasher.update([0]);
    hasher.update(exact_subject.as_bytes());
    hasher.update([0]);
    hasher.update(retry_number.to_string().as_bytes());
    let digest = hasher.finalize();
    let first_eight: [u8; 8] = digest[..8]
        .try_into()
        .expect("SHA-256 always contains eight prefix bytes");
    Ok(u64::from_be_bytes(first_eight) % (window_ms + 1))
}

fn load_fixture(fixture_dir: &Path) -> Result<MiniFixtureV1, String> {
    assert_directory(fixture_dir, "miniature fixture")?;
    let transition_path = fixture_dir.join("transition.toml");
    let transition: MiniTransitionV1 = parse_toml(&transition_path, "mini transition")?;
    validate_transition(&transition)?;
    let tap_path = fixture_dir.join("tap.toml");
    let tap: MiniTapV1 = parse_toml(&tap_path, "mini tap")?;
    validate_tap(fixture_dir, &tap)?;

    let repository = crate::repo_root();
    let catalog = load_product_catalog(&repository, &fixture_dir.join("products"))?;
    let pages_path = fixture_dir.join("pages.toml");
    let pages = parse_pages_registry(
        &pages_path,
        &read_bounded_regular_file(&pages_path, MAX_FIXTURE_BYTES)?,
    )?;
    let tests_path = fixture_dir.join("tests.toml");
    let tests = parse_test_registry(
        &tests_path,
        &read_bounded_regular_file(&tests_path, MAX_FIXTURE_BYTES)?,
    )?;
    let selection = select_vfs_products(&catalog, &pages, &tests, ChangeClass::Abi)?;
    let formula_requirements = derive_formula_requirements(&catalog, &selection)?;
    let tap_plan = plan_tap(&tap, &formula_requirements)?;
    Ok(MiniFixtureV1 {
        transition,
        tap,
        catalog,
        pages,
        tests,
        selection,
        tap_plan,
    })
}

fn validate_transition(transition: &MiniTransitionV1) -> Result<(), String> {
    if transition.schema != 1 || transition.kind != TRANSITION_KIND {
        return Err("mini transition has unsupported identity".to_string());
    }
    validate_repository(&transition.repository)?;
    if transition.pull_request == 0 {
        return Err("mini transition pull request must be positive".to_string());
    }
    validate_git_sha(&transition.head)?;
    validate_git_sha(&transition.tree)?;
    validate_git_sha(&transition.synthetic_merge_commit)?;
    if transition.head == transition.synthetic_merge_commit {
        return Err("mini transition synthetic merge must differ from the exact head".to_string());
    }
    let successor = transition
        .source_abi
        .checked_add(1)
        .ok_or_else(|| "mini transition source ABI cannot advance".to_string())?;
    if transition.target_abi != successor {
        return Err("mini transition target ABI must equal source ABI plus one".to_string());
    }
    for digest in [
        &transition.source_snapshot_sha256,
        &transition.target_snapshot_sha256,
        &transition.policy_sha256,
        &transition.guard_registry_sha256,
    ] {
        validate_sha256(digest)?;
    }
    if transition.policy_version == 0 || transition.guard_registry_version == 0 {
        return Err("mini transition policy versions must be positive".to_string());
    }
    if transition.source_history_branch != format!("abi/{}", transition.source_abi) {
        return Err("mini transition source history branch does not match source ABI".to_string());
    }
    parse_fixture_clock(&transition.fixture_clock)?;
    Ok(())
}

fn validate_tap(fixture_dir: &Path, tap: &MiniTapV1) -> Result<(), String> {
    if tap.schema != 1 || tap.kind != TAP_KIND {
        return Err("mini tap has unsupported identity".to_string());
    }
    validate_repository(&tap.source.repository)?;
    validate_git_sha(&tap.source.commit)?;
    validate_git_sha(&tap.source.tree)?;
    if tap.formulae.is_empty() || tap.formulae.len() > 64 {
        return Err("mini tap must contain a bounded Formula inventory".to_string());
    }
    let mut previous: Option<&str> = None;
    let mut names = BTreeSet::new();
    for formula in &tap.formulae {
        validate_stable_id(&formula.name, "mini Formula")?;
        if previous.is_some_and(|old| old >= formula.name.as_str()) {
            return Err("mini tap Formulae must be sorted and duplicate-free".to_string());
        }
        previous = Some(&formula.name);
        names.insert(formula.name.as_str());
        validate_bounded_text(&formula.version, "mini Formula version", 128)?;
        validate_sorted_ids(&formula.dependencies, "mini Formula dependencies", true)?;
        match (formula.disposition, formula.source.as_deref()) {
            (MiniFormulaDispositionV1::Build | MiniFormulaDispositionV1::Reuse, Some(source)) => {
                let path = resolve_fixture_path(fixture_dir, source, "mini Formula source")?;
                let metadata = fs::symlink_metadata(&path).map_err(|error| {
                    format!("cannot inspect mini Formula source {}: {error}", path.display())
                })?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("mini Formula source must be a regular nonsymlink file".to_string());
                }
            }
            (MiniFormulaDispositionV1::Background, None) => {}
            _ => return Err("mini Formula source does not match its disposition".to_string()),
        }
    }
    for formula in &tap.formulae {
        for dependency in &formula.dependencies {
            if !names.contains(dependency.as_str()) {
                return Err(format!(
                    "mini Formula {:?} has unknown dependency {dependency:?}",
                    formula.name
                ));
            }
        }
    }
    let by_name = tap
        .formulae
        .iter()
        .map(|formula| (formula.name.as_str(), formula))
        .collect::<BTreeMap<_, _>>();
    let mut state = BTreeMap::new();
    for name in by_name.keys() {
        visit_formula(name, &by_name, &mut state, &mut Vec::new())?;
    }
    Ok(())
}

fn plan_tap(
    tap: &MiniTapV1,
    requirements: &[FormulaRequirementV1],
) -> Result<MiniTapPlanV1, String> {
    let by_name = tap
        .formulae
        .iter()
        .map(|formula| (formula.name.as_str(), formula))
        .collect::<BTreeMap<_, _>>();
    let mut roots = BTreeSet::new();
    for requirement in requirements {
        if requirement.tap != tap.source.repository {
            return Err("selected Formula root names an unexpected tap".to_string());
        }
        let formula = by_name.get(requirement.formula.as_str()).ok_or_else(|| {
            format!("selected Formula root {:?} is absent from mini tap", requirement.formula)
        })?;
        if formula.architecture != requirement.architecture {
            return Err(format!(
                "selected Formula root {:?} architecture differs from tap",
                requirement.formula
            ));
        }
        if formula.disposition == MiniFormulaDispositionV1::Background {
            return Err("a selected Formula root cannot be background work".to_string());
        }
        roots.insert(requirement.formula.as_str());
    }
    let mut required = Vec::new();
    let mut state = BTreeMap::new();
    for root in roots {
        visit_formula(root, &by_name, &mut state, &mut required)?;
    }
    let required_set = required.iter().map(String::as_str).collect::<BTreeSet<_>>();
    let mut background = Vec::new();
    for formula in &tap.formulae {
        if required_set.contains(formula.name.as_str()) {
            if formula.disposition == MiniFormulaDispositionV1::Background {
                return Err("required Formula closure contains background work".to_string());
            }
        } else if formula.disposition == MiniFormulaDispositionV1::Background {
            background.push(formula.name.clone());
        } else {
            return Err(format!(
                "non-background Formula {:?} is not derived from selected products",
                formula.name
            ));
        }
    }
    Ok(MiniTapPlanV1 {
        required_subjects: required,
        background_subjects: background,
    })
}

fn visit_formula(
    name: &str,
    formulae: &BTreeMap<&str, &MiniTapFormulaV1>,
    state: &mut BTreeMap<String, u8>,
    order: &mut Vec<String>,
) -> Result<(), String> {
    match state.get(name).copied() {
        Some(1) => return Err(format!("mini tap dependency cycle includes {name:?}")),
        Some(2) => return Ok(()),
        _ => {}
    }
    state.insert(name.to_string(), 1);
    let formula = formulae
        .get(name)
        .ok_or_else(|| format!("mini tap dependency {name:?} is unavailable"))?;
    for dependency in &formula.dependencies {
        visit_formula(dependency, formulae, state, order)?;
    }
    state.insert(name.to_string(), 2);
    order.push(name.to_string());
    Ok(())
}

fn check_complete_capture(complete: bool, unreported_reads: &[String]) -> Result<(), GuardCodeV1> {
    if complete && unreported_reads.is_empty() {
        Ok(())
    } else {
        Err(GuardCodeV1::BuildInputCaptureIncomplete)
    }
}

fn check_override_subject(
    expected_request: &str,
    expected_subject: &str,
    actual_request: &str,
    actual_subject: &str,
) -> Result<(), GuardCodeV1> {
    if expected_request == actual_request && expected_subject == actual_subject {
        Ok(())
    } else {
        Err(GuardCodeV1::RequestUnauthorized)
    }
}

fn classify_attempt_failure(
    kind: MiniAttemptFailureKindV1,
    claimed: GuardCodeV1,
) -> Result<(), GuardCodeV1> {
    let actual = match kind {
        MiniAttemptFailureKindV1::Application => GuardCodeV1::BuildFailed,
        MiniAttemptFailureKindV1::Infrastructure => {
            GuardCodeV1::TransientInfrastructureFailure
        }
    };
    if claimed == actual {
        Ok(())
    } else {
        Err(actual)
    }
}

fn check_current_policy(current: bool) -> Result<(), GuardCodeV1> {
    if current {
        Ok(())
    } else {
        Err(GuardCodeV1::PolicyVersionUnknown)
    }
}

fn check_source_history(protected: bool, verified: bool) -> Result<(), GuardCodeV1> {
    if protected && verified {
        Ok(())
    } else {
        Err(GuardCodeV1::NamespaceBootstrapFailed)
    }
}

fn check_exact_build_source(actual: &str, exact_head: &str) -> Result<(), GuardCodeV1> {
    if actual == exact_head {
        Ok(())
    } else {
        Err(GuardCodeV1::SourceIdentityMismatch)
    }
}

fn parse_toml<T: for<'de> Deserialize<'de>>(path: &Path, label: &str) -> Result<T, String> {
    let bytes = read_bounded_regular_file(path, MAX_FIXTURE_BYTES)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|error| format!("{label} {} is not UTF-8: {error}", path.display()))?;
    toml::from_str(text).map_err(|error| format!("{label} {} is invalid: {error}", path.display()))
}

fn resolve_fixture_path(root: &Path, value: &str, label: &str) -> Result<PathBuf, String> {
    if value.is_empty()
        || value.starts_with('/')
        || value.contains(['\\', '\0'])
        || value
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(format!("{label} is not a normalized fixture path"));
    }
    let mut path = root.to_path_buf();
    for component in Path::new(value).components() {
        let Component::Normal(component) = component else {
            return Err(format!("{label} is not a normalized fixture path"));
        };
        path.push(component);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("cannot inspect {label} {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("{label} contains a symbolic link"));
        }
    }
    Ok(path)
}

fn assert_directory(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect {label} {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{label} {} must be a nonsymlink directory", path.display()));
    }
    Ok(())
}

fn validate_repository(value: &str) -> Result<(), String> {
    if value.split('/').count() != 2
        || value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-'))
    {
        return Err("repository must be an exact owner/name identity".to_string());
    }
    Ok(())
}

fn validate_bounded_text(value: &str, label: &str, maximum: usize) -> Result<(), String> {
    if value.is_empty() || value.len() > maximum || value.contains('\0') {
        return Err(format!("{label} must contain 1 through {maximum} bytes"));
    }
    Ok(())
}

fn validate_sorted_ids(values: &[String], label: &str, allow_empty: bool) -> Result<(), String> {
    if !allow_empty && values.is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    let mut previous: Option<&str> = None;
    for value in values {
        validate_stable_id(value, label)?;
        if previous.is_some_and(|old| old >= value.as_str()) {
            return Err(format!("{label} must be sorted and duplicate-free"));
        }
        previous = Some(value);
    }
    Ok(())
}

fn create_new_work_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("miniature work directory must be an absolute normalized path".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "miniature work directory has no parent".to_string())?;
    assert_directory(parent, "miniature work parent")?;
    match fs::symlink_metadata(path) {
        Ok(_) => {
            return Err(format!(
                "miniature work directory {} must be new",
                path.display()
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "cannot inspect miniature work directory {}: {error}",
                path.display()
            ))
        }
    }
    fs::create_dir(path).map_err(|error| {
        format!("cannot create miniature work directory {}: {error}", path.display())
    })
}

fn absolute_repository_path(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("miniature path must not be empty".to_string());
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        crate::repo_root().join(path)
    };
    if absolute
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("miniature path must be lexically normalized".to_string());
    }
    Ok(absolute)
}

fn repository_relative(path: &Path) -> Result<String, String> {
    let absolute = absolute_repository_path(path)?;
    let relative = absolute.strip_prefix(crate::repo_root()).map_err(|_| {
        format!("miniature fixture path {} is outside the repository", absolute.display())
    })?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err("miniature repository path is not normalized".to_string());
        };
        parts.push(
            component
                .to_str()
                .ok_or_else(|| "miniature repository path is not UTF-8".to_string())?,
        );
    }
    if parts.is_empty() {
        return Err("miniature repository path must name a file".to_string());
    }
    Ok(parts.join("/"))
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("new file {} has no parent", path.display()))?;
    assert_directory(parent, "new file parent")?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("cannot create new file {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("cannot write new file {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("cannot sync new file {}: {error}", path.display()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = read_bounded_regular_file(path, 16 * 1024 * 1024)?;
    Ok(sha256_bytes(&bytes))
}

fn fixture_source_tree_sha256(fixture_dir: &Path) -> Result<String, String> {
    fn visit(root: &Path, directory: &Path, entries: &mut Vec<(String, Vec<u8>)>) -> Result<(), String> {
        assert_directory(directory, "miniature source tree directory")?;
        let mut children = fs::read_dir(directory)
            .map_err(|error| format!("cannot read source tree {}: {error}", directory.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("cannot enumerate source tree: {error}"))?;
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("cannot inspect source tree {}: {error}", path.display()))?;
            if metadata.file_type().is_symlink() {
                return Err("miniature source tree cannot contain symbolic links".to_string());
            }
            if metadata.is_dir() {
                visit(root, &path, entries)?;
            } else if metadata.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| "miniature source path escaped its root".to_string())?;
                let relative = relative
                    .to_str()
                    .ok_or_else(|| "miniature source path is not UTF-8".to_string())?
                    .replace(std::path::MAIN_SEPARATOR, "/");
                entries.push((
                    relative,
                    read_bounded_regular_file(&path, MAX_FIXTURE_BYTES)?,
                ));
            } else {
                return Err("miniature source tree contains an unsupported entry".to_string());
            }
        }
        Ok(())
    }

    let root = fixture_dir.join("sources");
    let mut entries = Vec::new();
    visit(&root, &root, &mut entries)?;
    if entries.is_empty() {
        return Err("miniature source tree is empty".to_string());
    }
    let mut hasher = Sha256::new();
    for (path, bytes) in entries {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(&bytes);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn guard_failure(code: GuardCodeV1) -> String {
    format!("[{}] miniature guard rejected the transition", code.as_str())
}

pub fn run_cli(action: &str, args: &[String]) -> Result<(), String> {
    if action != "run" {
        return Err(format!("unknown mini action {action:?}; expected run"));
    }
    if args.len() != 4 {
        return Err("mini run expects --fixture <dir> --work <new-dir>".to_string());
    }
    let mut fixture = None;
    let mut work = None;
    for pair in args.chunks_exact(2) {
        let target = match pair[0].as_str() {
            "--fixture" => &mut fixture,
            "--work" => &mut work,
            flag => return Err(format!("unknown mini run flag {flag:?}")),
        };
        if target.replace(PathBuf::from(&pair[1])).is_some() {
            return Err(format!("duplicate mini run flag {:?}", pair[0]));
        }
    }
    let summary = run_mini_lifecycle(
        &fixture.ok_or_else(|| "mini run is missing --fixture".to_string())?,
        &work.ok_or_else(|| "mini run is missing --work".to_string())?,
    )?;
    print!("{}", String::from_utf8_lossy(&canonical_json_bytes(&summary)?));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct RetryVectorsV1 {
        schema: u64,
        kind: String,
        vectors: Vec<RetryVectorV1>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct RetryVectorV1 {
        name: String,
        request_sha256: String,
        subject: String,
        retry_number: u8,
        base_ms: u64,
        cap_ms: u64,
        window_ms: Option<u64>,
        delay_ms: Option<u64>,
        error: Option<String>,
    }

    const REQUEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn fixture_path() -> PathBuf {
        crate::repo_root().join("tools/xtask/tests/fixtures/abi-staging/mini-transition")
    }

    #[test]
    fn fixture_models_a_generic_successor_and_derives_formulae_only_from_products() {
        let fixture = load_fixture(&fixture_path()).unwrap();
        assert_eq!(
            fixture.transition.target_abi,
            fixture.transition.source_abi + 1
        );
        assert_eq!(fixture.tap_plan.required_subjects, ["tool", "base"]);
        assert_eq!(fixture.tap_plan.background_subjects, ["background"]);
        let formula_requirements =
            derive_formula_requirements(&fixture.catalog, &fixture.selection).unwrap();
        assert_eq!(
            formula_requirements
                .iter()
                .map(|requirement| requirement.formula.as_str())
                .collect::<Vec<_>>(),
            ["base", "tool"]
        );
    }

    #[test]
    fn transition_rejects_anything_other_than_n_plus_one() {
        let mut transition: MiniTransitionV1 =
            parse_toml(&fixture_path().join("transition.toml"), "transition").unwrap();
        transition.target_abi += 1;
        assert!(validate_transition(&transition)
            .unwrap_err()
            .contains("source ABI plus one"));
    }

    #[test]
    fn deterministic_full_jitter_has_closed_bounded_windows() {
        let first = deterministic_retry_delay_ms(REQUEST, "formula:base:wasm32", 1, 1_000, 8_000)
            .unwrap();
        let second =
            deterministic_retry_delay_ms(REQUEST, "formula:base:wasm32", 2, 1_000, 8_000)
                .unwrap();
        let third = deterministic_retry_delay_ms(REQUEST, "formula:base:wasm32", 3, 1_000, 8_000)
            .unwrap();
        assert!(first <= 1_000);
        assert!(second <= 2_000);
        assert!(third <= 4_000);
        assert_eq!([first, second, third], [159, 1_196, 1_036]);
        assert!(deterministic_retry_delay_ms(REQUEST, "formula:base:wasm32", 4, 1_000, 8_000)
            .is_err());
    }

    #[test]
    fn deterministic_full_jitter_matches_shared_cross_language_vectors() {
        let path = crate::repo_root()
            .join("tools/xtask/tests/fixtures/abi-staging/retry-vectors.json");
        let bytes = fs::read(path).unwrap();
        let fixture: RetryVectorsV1 = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(fixture.schema, 1);
        assert_eq!(fixture.kind, "kandelo-abi-staging-retry-vectors");
        assert_eq!(canonical_json_bytes(&fixture).unwrap(), bytes);
        for vector in fixture.vectors {
            let result = deterministic_retry_delay_ms(
                &vector.request_sha256,
                &vector.subject,
                vector.retry_number,
                vector.base_ms,
                vector.cap_ms,
            );
            match (vector.delay_ms, vector.error) {
                (Some(delay), None) => {
                    assert_eq!(result.unwrap(), delay, "{}", vector.name);
                    let exponent = u32::from(vector.retry_number - 1);
                    let window = vector
                        .base_ms
                        .checked_mul(1_u64 << exponent)
                        .map(|value| vector.cap_ms.min(value))
                        .unwrap();
                    assert_eq!(Some(window), vector.window_ms, "{}", vector.name);
                }
                (None, Some(error)) => {
                    assert_eq!(result.unwrap_err(), error, "{}", vector.name);
                    assert_eq!(vector.window_ms, None, "{}", vector.name);
                }
                _ => panic!("retry vector {} has contradictory output", vector.name),
            }
        }
    }

    #[test]
    fn negative_boundaries_return_the_six_exact_guard_codes() {
        assert_eq!(
            check_complete_capture(false, &[]).unwrap_err(),
            GuardCodeV1::BuildInputCaptureIncomplete
        );
        assert_eq!(
            check_override_subject(REQUEST, "base", REQUEST, "tool").unwrap_err(),
            GuardCodeV1::RequestUnauthorized
        );
        assert_eq!(
            classify_attempt_failure(
                MiniAttemptFailureKindV1::Application,
                GuardCodeV1::TransientInfrastructureFailure,
            )
            .unwrap_err(),
            GuardCodeV1::BuildFailed
        );
        assert_eq!(
            check_current_policy(false).unwrap_err(),
            GuardCodeV1::PolicyVersionUnknown
        );
        assert_eq!(
            check_source_history(true, false).unwrap_err(),
            GuardCodeV1::NamespaceBootstrapFailed
        );
        assert_eq!(
            check_exact_build_source("b", "a").unwrap_err(),
            GuardCodeV1::SourceIdentityMismatch
        );
    }

    #[test]
    fn infrastructure_failure_is_the_only_automatic_retry_class() {
        assert!(classify_attempt_failure(
            MiniAttemptFailureKindV1::Infrastructure,
            GuardCodeV1::TransientInfrastructureFailure,
        )
        .is_ok());
        assert_eq!(
            classify_attempt_failure(
                MiniAttemptFailureKindV1::Application,
                GuardCodeV1::TransientInfrastructureFailure,
            )
            .unwrap_err(),
            GuardCodeV1::BuildFailed
        );
    }
}

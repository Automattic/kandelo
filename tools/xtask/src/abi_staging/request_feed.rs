use crate::abi_staging::canonical_json::{
    canonical_json_bytes, canonical_sha256, validate_git_sha, validate_sha256,
};
use crate::abi_staging::product_manifest::{atomic_write_regular, read_bounded_regular_file};
use crate::abi_staging::records::{
    candidate_request_asset_name, parse_candidate_request_asset, request_is_current,
    validate_request, AbiStagingRequestV1,
};
use crate::abi_staging::request_policy::{parse_request_policy, RequestPolicyV1};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const MAX_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_RELEASE_ASSETS: usize = 4_096;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestAssetV1 {
    pub name: String,
    pub browser_download_url: String,
    pub canonical_bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum CurrentRequestSelectionV1 {
    NotApplicable,
    Missing {
        expected_head: String,
    },
    Selected {
        request_digest: String,
        asset_name: String,
        asset_url: String,
        request: AbiStagingRequestV1,
    },
    Invalid {
        errors: Vec<String>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequestFeedActionV1 {
    CreatePrerelease,
    AppendAsset,
    AssetAlreadyIdentical,
    RejectNameCollision,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestFeedPlanV1 {
    pub repository: String,
    pub pull_request_number: u64,
    pub tag: String,
    pub asset_name: String,
    pub asset_sha256: String,
    pub asset_bytes: u64,
    pub public_download_url: String,
    pub action: RequestFeedActionV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExistingRequestReleaseV1 {
    pub tag: String,
    pub target_commitish: String,
    pub prerelease: bool,
    pub assets: Vec<RequestAssetV1>,
}

#[allow(clippy::too_many_arguments)]
pub fn select_current_request(
    assets: &[RequestAssetV1],
    exact_head: &str,
    requirements_sha256: &str,
    policy_version: u64,
    policy_sha256: &str,
    guard_registry_version: u64,
    guard_registry_sha256: &str,
) -> CurrentRequestSelectionV1 {
    let mut input_errors = Vec::new();
    if let Err(error) = validate_git_sha(exact_head) {
        input_errors.push(format!("exact head: {error}"));
    }
    for (field, value) in [
        ("requirements digest", requirements_sha256),
        ("policy digest", policy_sha256),
        ("guard-registry digest", guard_registry_sha256),
    ] {
        if let Err(error) = validate_sha256(value) {
            input_errors.push(format!("{field}: {error}"));
        }
    }
    if policy_version == 0 || guard_registry_version == 0 {
        input_errors.push("policy and guard-registry versions must be positive".to_string());
    }
    if assets.len() > MAX_RELEASE_ASSETS {
        input_errors.push(format!(
            "request asset inventory exceeds {MAX_RELEASE_ASSETS} entries"
        ));
    }
    if !input_errors.is_empty() {
        input_errors.sort();
        return CurrentRequestSelectionV1::Invalid {
            errors: input_errors,
        };
    }

    let filename_prefix = format!("candidate-request-{exact_head}-sha256-");
    let mut ordered = assets.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        (
            &left.name,
            &left.browser_download_url,
            &left.canonical_bytes,
        )
            .cmp(&(
                &right.name,
                &right.browser_download_url,
                &right.canonical_bytes,
            ))
    });
    let mut errors = Vec::new();
    let mut current = Vec::new();
    for asset in ordered {
        if !asset.name.starts_with(&filename_prefix) {
            continue;
        }
        if let Err(error) = validate_public_asset_url(&asset.browser_download_url) {
            errors.push(format!("asset {:?}: {error}", asset.name));
            continue;
        }
        let request = match parse_candidate_request_asset(&asset.name, &asset.canonical_bytes) {
            Ok(request) => request,
            Err(error) => {
                errors.push(format!("asset {:?}: {error}", asset.name));
                continue;
            }
        };
        if request_is_current(
            &request,
            exact_head,
            requirements_sha256,
            policy_version,
            policy_sha256,
            guard_registry_version,
            guard_registry_sha256,
        ) {
            match canonical_sha256(&request) {
                Ok(digest) => current.push((asset, request, digest)),
                Err(error) => errors.push(format!("asset {:?}: {error}", asset.name)),
            }
        }
    }
    if !errors.is_empty() {
        errors.sort();
        return CurrentRequestSelectionV1::Invalid { errors };
    }
    match current.len() {
        0 => CurrentRequestSelectionV1::Missing {
            expected_head: exact_head.to_string(),
        },
        1 => {
            let (asset, request, request_digest) = current.pop().unwrap();
            CurrentRequestSelectionV1::Selected {
                request_digest,
                asset_name: asset.name.clone(),
                asset_url: asset.browser_download_url.clone(),
                request,
            }
        }
        count => CurrentRequestSelectionV1::Invalid {
            errors: vec![format!(
                "found {count} canonical requests for the same complete current identity"
            )],
        },
    }
}

pub fn plan_request_feed_write(
    policy: &RequestPolicyV1,
    protected_target: &str,
    request_bytes: &[u8],
    existing_release: Option<&ExistingRequestReleaseV1>,
) -> Result<RequestFeedPlanV1, String> {
    let policy_toml = toml::to_string(policy)
        .map_err(|error| format!("cannot encode request policy: {error}"))?;
    parse_request_policy(Path::new("request-policy.toml"), policy_toml.as_bytes())?;
    validate_git_sha(protected_target)?;
    if request_bytes.is_empty()
        || u64::try_from(request_bytes.len()).unwrap_or(u64::MAX) > policy.request_asset_max_bytes
    {
        return Err("canonical request exceeds the protected request size policy".to_string());
    }
    let request: AbiStagingRequestV1 = serde_json::from_slice(request_bytes)
        .map_err(|error| format!("request is invalid JSON: {error}"))?;
    if canonical_json_bytes(&request)? != request_bytes {
        return Err("request feed input is not canonical JSON".to_string());
    }
    validate_request(&request)?;
    if request.pull_request.repository != policy.issuer_repository
        || request.issuance.issuer_repository != policy.issuer_repository
        || request.issuance.policy_version != policy.version
    {
        return Err("request does not match the protected issuer policy".to_string());
    }
    let asset_sha256 = canonical_sha256(&request)?;
    let asset_name = candidate_request_asset_name(&request.build_source.commit, &asset_sha256)?;
    let tag = format!(
        "{}{}",
        policy.request_release_tag_prefix, request.pull_request.number
    );
    let public_download_url = format!(
        "https://github.com/{}/releases/download/{tag}/{asset_name}",
        policy.issuer_repository
    );

    let action = match existing_release {
        None => RequestFeedActionV1::CreatePrerelease,
        Some(release) => {
            validate_existing_release(release, &tag, protected_target)?;
            let named = release
                .assets
                .iter()
                .filter(|asset| asset.name == asset_name)
                .collect::<Vec<_>>();
            match named.as_slice() {
                [] => RequestFeedActionV1::AppendAsset,
                [asset] if asset.canonical_bytes == request_bytes => {
                    RequestFeedActionV1::AssetAlreadyIdentical
                }
                _ => RequestFeedActionV1::RejectNameCollision,
            }
        }
    };
    Ok(RequestFeedPlanV1 {
        repository: policy.issuer_repository.clone(),
        pull_request_number: request.pull_request.number,
        tag,
        asset_name,
        asset_sha256,
        asset_bytes: request_bytes.len() as u64,
        public_download_url,
        action,
    })
}

pub fn run_cli(action: &str, args: &[String]) -> Result<(), String> {
    match action {
        "select-current" => {
            let flags = parse_flags(args)?;
            require_exact_flags(&flags, &["--input", "--out"])?;
            let input: SelectCurrentInputV1 = read_canonical_json(Path::new(&flags["--input"]))?;
            let selection = select_current_request(
                &input.assets,
                &input.exact_head,
                &input.requirements_sha256,
                input.policy_version,
                &input.policy_sha256,
                input.guard_registry_version,
                &input.guard_registry_sha256,
            );
            atomic_write_regular(
                Path::new(&flags["--out"]),
                &canonical_json_bytes(&selection)?,
            )
        }
        "plan-feed-write" => {
            let flags = parse_flags(args)?;
            let mut expected = vec!["--policy", "--protected-target", "--request", "--out"];
            if flags.contains_key("--existing-release") {
                expected.push("--existing-release");
            }
            require_exact_flags(&flags, &expected)?;
            let policy_path = Path::new(&flags["--policy"]);
            let policy = parse_request_policy(
                policy_path,
                &read_bounded_regular_file(policy_path, 1024 * 1024)?,
            )?;
            let request = read_bounded_regular_file(
                Path::new(&flags["--request"]),
                policy.request_asset_max_bytes as usize,
            )?;
            let existing = flags
                .get("--existing-release")
                .map(|path| read_canonical_json::<ExistingRequestReleaseV1>(Path::new(path)))
                .transpose()?;
            let plan = plan_request_feed_write(
                &policy,
                &flags["--protected-target"],
                &request,
                existing.as_ref(),
            )?;
            atomic_write_regular(Path::new(&flags["--out"]), &canonical_json_bytes(&plan)?)
        }
        _ => Err(format!("unknown request feed subcommand {action:?}")),
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SelectCurrentInputV1 {
    assets: Vec<RequestAssetV1>,
    exact_head: String,
    requirements_sha256: String,
    policy_version: u64,
    policy_sha256: String,
    guard_registry_version: u64,
    guard_registry_sha256: String,
}

fn validate_public_asset_url(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 8_192
        || !value.starts_with("https://")
        || value.contains(['#', '\0'])
        || value.chars().any(char::is_whitespace)
    {
        return Err("asset URL must be bounded credential-free HTTPS".to_string());
    }
    let authority = value["https://".len()..]
        .split('/')
        .next()
        .unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return Err("asset URL must be bounded credential-free HTTPS".to_string());
    }
    Ok(())
}

fn validate_existing_release(
    release: &ExistingRequestReleaseV1,
    expected_tag: &str,
    protected_target: &str,
) -> Result<(), String> {
    if release.tag != expected_tag {
        return Err("existing request Release has the wrong tag".to_string());
    }
    validate_git_sha(&release.target_commitish)?;
    if release.target_commitish != protected_target {
        return Err("existing request Release target must not move".to_string());
    }
    if !release.prerelease {
        return Err("existing request Release must remain a prerelease".to_string());
    }
    if release.assets.len() > MAX_RELEASE_ASSETS {
        return Err(format!(
            "existing request Release exceeds {MAX_RELEASE_ASSETS} assets"
        ));
    }
    for asset in &release.assets {
        if asset.name.is_empty() || asset.name.len() > 512 || asset.name.contains(['/', '\0']) {
            return Err("existing request asset has an invalid name".to_string());
        }
        validate_public_asset_url(&asset.browser_download_url)?;
    }
    Ok(())
}

fn read_canonical_json<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Serialize,
{
    let bytes = read_bounded_regular_file(path, MAX_DOCUMENT_BYTES)?;
    let value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{} is invalid JSON: {error}", path.display()))?;
    if canonical_json_bytes(&value)? != bytes {
        return Err(format!("{} is not canonical JSON", path.display()));
    }
    Ok(value)
}

fn parse_flags(args: &[String]) -> Result<BTreeMap<String, String>, String> {
    if args.len() % 2 != 0 {
        return Err("request feed flags require one value each".to_string());
    }
    let mut flags = BTreeMap::new();
    for pair in args.chunks_exact(2) {
        if !pair[0].starts_with("--") || flags.insert(pair[0].clone(), pair[1].clone()).is_some() {
            return Err(format!("invalid or duplicate flag {:?}", pair[0]));
        }
    }
    Ok(flags)
}

fn require_exact_flags(flags: &BTreeMap<String, String>, expected: &[&str]) -> Result<(), String> {
    let actual = flags.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(format!(
            "expected flags: {}",
            expected.into_iter().collect::<Vec<_>>().join(" ")
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi_staging::canonical_json::{canonical_json_bytes, canonical_sha256};
    use crate::abi_staging::records::{
        candidate_request_asset_name, parse_candidate_request_asset, request_requirements_digest,
    };
    use crate::abi_staging::request_policy::ForkAuthorizationV1;
    use std::fs;

    fn request() -> AbiStagingRequestV1 {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/abi-staging/request/current-request.json"
        );
        let bytes = fs::read(path).unwrap();
        let value: AbiStagingRequestV1 = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(canonical_json_bytes(&value).unwrap(), bytes);
        value
    }

    fn policy() -> RequestPolicyV1 {
        RequestPolicyV1 {
            schema: 1,
            kind: "kandelo-abi-staging-request-policy".to_string(),
            version: 1,
            issuer_repository: "Automattic/kandelo".to_string(),
            issuer_workflow: ".github/workflows/abi-staging-request-feed.yml".to_string(),
            automatic_same_repository: true,
            fork_authorization: ForkAuthorizationV1::Disabled,
            request_release_tag_prefix: "abi-staging-pr-".to_string(),
            request_asset_max_bytes: 4_194_304,
            max_products: 256,
            max_evidence_bindings: 512,
            addressed_taps: vec!["kandelo-dev/homebrew-tap-core".to_string()],
            implementation_paths: vec!["protected/request.rs".to_string()],
        }
    }

    fn asset(request: &AbiStagingRequestV1) -> RequestAssetV1 {
        let canonical_bytes = canonical_json_bytes(request).unwrap();
        let digest = canonical_sha256(request).unwrap();
        let name = candidate_request_asset_name(&request.build_source.commit, &digest).unwrap();
        RequestAssetV1 {
            browser_download_url: format!(
                "https://github.com/Automattic/kandelo/releases/download/abi-staging-pr-19/{name}"
            ),
            name,
            canonical_bytes,
        }
    }

    fn select(assets: &[RequestAssetV1]) -> CurrentRequestSelectionV1 {
        let request = request();
        select_current_request(
            assets,
            &request.build_source.commit,
            &request.requirements.digest,
            request.issuance.policy_version,
            &request.issuance.policy_sha256,
            request.issuance.guard_registry_version,
            &request.issuance.guard_registry_sha256,
        )
    }

    #[test]
    fn selection_uses_exact_current_identity_and_is_order_independent() {
        let current = request();
        let mut historical = current.clone();
        historical.build_source.commit = "0".repeat(40);
        historical.build_source.tree = "7".repeat(40);
        historical.issuance.authorization =
            crate::abi_staging::records::RequestAuthorizationV1::SameRepository {
                head: historical.build_source.commit.clone(),
            };
        let mut stale_policy = current.clone();
        stale_policy.issuance.policy_version += 1;
        stale_policy.issuance.policy_sha256 = "9".repeat(64);
        let mut assets = vec![asset(&historical), asset(&stale_policy), asset(&current)];
        let selected = select(&assets);
        assets.reverse();
        assert_eq!(selected, select(&assets));
        assert!(matches!(
            selected,
            CurrentRequestSelectionV1::Selected { .. }
        ));
    }

    #[test]
    fn invalid_matching_head_is_not_silently_skipped() {
        let current = request();
        let mut malformed = asset(&current);
        malformed.canonical_bytes = b"{}\n".to_vec();
        let selection = select(&[asset(&current), malformed]);
        assert!(matches!(
            selection,
            CurrentRequestSelectionV1::Invalid { .. }
        ));
    }

    #[test]
    fn duplicate_current_assets_are_invalid_and_missing_is_explicit() {
        let current = asset(&request());
        assert!(matches!(
            select(&[current.clone(), current]),
            CurrentRequestSelectionV1::Invalid { .. }
        ));
        assert!(matches!(
            select(&[]),
            CurrentRequestSelectionV1::Missing { .. }
        ));
    }

    #[test]
    fn stale_requirements_and_guard_policy_do_not_become_current() {
        let current = request();
        let mut stale_requirements = current.clone();
        stale_requirements
            .requirements
            .change_classes
            .push(crate::abi_staging::consumer_registry::ChangeClass::Kernel);
        stale_requirements.requirements.digest =
            request_requirements_digest(&stale_requirements.requirements).unwrap();
        let mut stale_guard = current.clone();
        stale_guard.issuance.guard_registry_version += 1;
        stale_guard.issuance.guard_registry_sha256 = "8".repeat(64);
        assert!(matches!(
            select(&[asset(&stale_requirements), asset(&stale_guard)]),
            CurrentRequestSelectionV1::Missing { .. }
        ));
    }

    #[test]
    fn all_cross_repository_fixtures_are_canonical_valid_requests() {
        let directory =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/abi-staging/request");
        for filename in [
            "current-request.json",
            "same-head-reissued-request.json",
            "historical-request.json",
        ] {
            let bytes = fs::read(directory.join(filename)).unwrap();
            let request: AbiStagingRequestV1 = serde_json::from_slice(&bytes).unwrap();
            let name = candidate_request_asset_name(
                &request.build_source.commit,
                &canonical_sha256(&request).unwrap(),
            )
            .unwrap();
            parse_candidate_request_asset(&name, &bytes).unwrap();
        }
    }

    #[test]
    fn filenames_cannot_encode_order_or_mutable_aliases() {
        let bytes = canonical_json_bytes(&request()).unwrap();
        for invalid in [
            "latest.json",
            "current.json",
            "candidate-request-1111111-sha256-deadbeef.json",
            "candidate-request-1111111111111111111111111111111111111111-sha256-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-20260809.json",
        ] {
            assert!(parse_candidate_request_asset(invalid, &bytes).is_err());
        }
    }

    #[test]
    fn feed_plan_is_append_only_and_rejects_name_collisions() {
        let request = request();
        let bytes = canonical_json_bytes(&request).unwrap();
        let absent = plan_request_feed_write(&policy(), &"3".repeat(40), &bytes, None).unwrap();
        assert_eq!(absent.action, RequestFeedActionV1::CreatePrerelease);

        let release = ExistingRequestReleaseV1 {
            tag: absent.tag.clone(),
            target_commitish: "3".repeat(40),
            prerelease: true,
            assets: vec![],
        };
        assert_eq!(
            plan_request_feed_write(&policy(), &"3".repeat(40), &bytes, Some(&release))
                .unwrap()
                .action,
            RequestFeedActionV1::AppendAsset
        );

        let mut identical = release.clone();
        identical.assets.push(asset(&request));
        assert_eq!(
            plan_request_feed_write(&policy(), &"3".repeat(40), &bytes, Some(&identical))
                .unwrap()
                .action,
            RequestFeedActionV1::AssetAlreadyIdentical
        );
        identical.assets[0].canonical_bytes = b"collision\n".to_vec();
        assert_eq!(
            plan_request_feed_write(&policy(), &"3".repeat(40), &bytes, Some(&identical))
                .unwrap()
                .action,
            RequestFeedActionV1::RejectNameCollision
        );
    }
}

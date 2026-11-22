//! Shared-memory compatibility is a derived output of its ordinary producer.
//! No consumer application, program list, or desktop package participates.
use super::*;
use std::io::{Cursor, Read, Write};

const MAX_PROGRAM_BYTES: u64 = 512 * 1024 * 1024;

fn enabled(target: &DepsManifest) -> bool {
    target
        .program_outputs
        .iter()
        .any(|output| output.shared_memory_from.is_some())
}

pub(super) fn input_digests(target: &DepsManifest) -> Result<Vec<BuildInputDigest>, String> {
    if !enabled(target) {
        return Ok(Vec::new());
    }
    static INPUTS: RootDigestCache = OnceLock::new();
    root_scoped_build_input_digests(&INPUTS, &crate::repo_root(), |root| {
        let mut paths =
            crate::cargo_closure::cargo_closure_paths(root, "shared-memory-instrument")?;
        paths.extend(fork_instrument_tool_input_paths(root)?);
        paths.extend(
            [
                "sdk/bin/wasm32posix-shared-memory",
                "scripts/build-shared-memory-helpers.sh",
                "tools/xtask/src/shared_memory_outputs.rs",
            ]
            .into_iter()
            .map(str::to_owned),
        );
        paths.sort();
        paths.dedup();
        global_package_build_input_digests_for(
            root,
            &paths.iter().map(String::as_str).collect::<Vec<_>>(),
        )
    })
}

/// Recipes produce ordinary outputs. The normal resolver finalizes declared
/// derivatives in the same owned stage before validation and publication.
pub(super) fn finalize(
    target: &DepsManifest,
    root: &Path,
    arch: TargetArch,
    allow_missing_sources: bool,
) -> Result<(), String> {
    if !enabled(target) {
        return Ok(());
    }
    if target.build.toolchain != PackageToolchain::Sdk {
        return Err("shared-memory outputs require the SDK toolchain".into());
    }
    if arch != TargetArch::Wasm32 {
        return Err("shared-memory outputs require wasm32".into());
    }
    for output in &target.program_outputs {
        let Some(source_name) = &output.shared_memory_from else {
            continue;
        };
        let source = target
            .program_outputs
            .iter()
            .find(|candidate| candidate.name == *source_name)
            .ok_or_else(|| format!("missing shared-memory source {source_name:?}"))?;
        if !path_entry_exists(&root.join(&source.wasm))? {
            if allow_missing_sources {
                continue;
            }
            return Err(format!(
                "{}: shared-memory source {} was not produced",
                target.spec(),
                source.wasm
            ));
        }
        if path_entry_exists(&root.join(&output.wasm))? {
            validate(target, output, root)?;
            continue;
        }
        let source_path = validate_declared_artifact(
            target,
            root,
            &source.wasm,
            "shared-memory source",
            "not produced",
            true,
        )?;
        let staging = root.join(format!(
            ".shared-memory-{}-{}",
            output.name,
            std::process::id()
        ));
        std::fs::create_dir(&staging)
            .map_err(|error| format!("create shared-memory stage: {error}"))?;
        let result = (|| {
            let program_path = staging.join("program.wasm");
            let status = std::process::Command::new(
                crate::repo_root().join("sdk/bin/wasm32posix-shared-memory"),
            )
            .arg(&source_path)
            .arg("-o")
            .arg(&program_path)
            .stdout(Stdio::null())
            .status()
            .map_err(|error| format!("run SDK shared-memory transform: {error}"))?;
            if !status.success() {
                return Err(format!(
                    "SDK shared-memory transform failed for {}:{} ({status})",
                    target.name, source.name
                ));
            }
            let bytes = std::fs::read(&program_path)
                .map_err(|error| format!("read transformed output: {error}"))?;
            let destination = root.join(&output.wasm);
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let staged_archive = staging.join("output.zip");
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged_archive)
                .map_err(|error| format!("create shared-memory archive: {error}"))?;
            let mut archive = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .last_modified_time(zip::DateTime::default())
                .unix_permissions(0o755);
            archive
                .start_file("program.wasm", options)
                .map_err(|error| error.to_string())?;
            archive
                .write_all(&bytes)
                .map_err(|error| error.to_string())?;
            archive.finish().map_err(|error| error.to_string())?;
            // Publish complete bytes once; another collector may derive the
            // same member concurrently, but cannot observe a partial ZIP.
            match std::fs::hard_link(&staged_archive, &destination) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let existing =
                        std::fs::read(&destination).map_err(|error| error.to_string())?;
                    let staged =
                        std::fs::read(&staged_archive).map_err(|error| error.to_string())?;
                    if existing != staged {
                        return Err("concurrent shared-memory output differs".into());
                    }
                }
                Err(error) => return Err(format!("publish shared-memory archive: {error}")),
            }
            validate(target, output, root)
        })();
        let cleanup = std::fs::remove_dir_all(&staging).map_err(|error| error.to_string());
        result?;
        cleanup?;
    }
    Ok(())
}

/// Apply on fresh outputs, cache admission, and complete receipt validation.
/// A ZIP filename alone never establishes shared-memory compatibility.
pub(super) fn validate(
    target: &DepsManifest,
    output: &crate::pkg_manifest::ProgramOutput,
    root: &Path,
) -> Result<(), String> {
    let Some(source_name) = &output.shared_memory_from else {
        return Ok(());
    };
    let source = target
        .program_outputs
        .iter()
        .find(|candidate| candidate.name == *source_name)
        .ok_or_else(|| format!("missing shared-memory source {source_name:?}"))?;
    let source_path = validate_declared_artifact(
        target,
        root,
        &source.wasm,
        "shared-memory source",
        "missing",
        true,
    )?;
    let archive_path = validate_declared_artifact(
        target,
        root,
        &output.wasm,
        "shared-memory archive",
        "missing",
        true,
    )?;
    let (source_bytes, _) =
        fork_instrument::artifact_io::MappedArtifact::read(&source_path, MAX_PROGRAM_BYTES)
            .map_err(|error| format!("read shared-memory source: {error}"))?;
    let (archive_bytes, _) =
        fork_instrument::artifact_io::MappedArtifact::read(&archive_path, MAX_PROGRAM_BYTES)
            .map_err(|error| format!("read shared-memory archive: {error}"))?;
    let mut archive = zip::ZipArchive::new(Cursor::new(archive_bytes.bytes()))
        .map_err(|error| error.to_string())?;
    if archive.len() != 1 {
        return Err("shared-memory archive must contain one program.wasm".into());
    }
    let mut entry = archive.by_index(0).map_err(|error| error.to_string())?;
    if entry.name() != "program.wasm"
        || !entry.is_file()
        || entry.is_symlink()
        || entry.size() > MAX_PROGRAM_BYTES
        || entry.unix_mode().is_none_or(|mode| mode & 0o7111 != 0o111)
    {
        return Err("invalid shared-memory archive member".into());
    }
    let mut program = Vec::new();
    entry
        .read_to_end(&mut program)
        .map_err(|error| error.to_string())?;
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&program)
        .map_err(|error| format!("invalid shared-memory executable: {error}"))?;
    let layout = wasm_artifact::grouped_memory::read_layout(&program)
        .map_err(|error| format!("invalid shared-memory output: {error}"))?;
    let source_digest: [u8; 32] = Sha256::digest(source_bytes.bytes()).into();
    if layout.source_sha256 != source_digest {
        return Err("shared-memory output source identity differs".into());
    }
    let mut extensions = wasm_artifact::program_extensions::IMPLEMENTED.to_vec();
    extensions.push(wasm_posix_shared::program_extensions::memory_group_v3::MODULE);
    let mut failures = wasm_artifact_policy_failures_with_extensions(
        &program,
        ForkInstrumentationPolicy::Auto,
        &[],
        &extensions,
    );
    let digest = crate::local_abi_identity::local_abi_contract_digest(
        &crate::repo_root(),
        wasm_posix_shared::ABI_VERSION,
    )?;
    let contract =
        wasm_artifact::facts::read_custom_section(&program, wasm_artifact::ABI_CONTRACT_SECTION);
    let contracts = wasmparser::Parser::new(0).parse_all(&program).filter(|part|
        matches!(part, Ok(wasmparser::Payload::CustomSection(section)) if section.name() == wasm_artifact::ABI_CONTRACT_SECTION)).count();
    if contracts != 1
        || contract != Some(digest.as_slice())
        || wasm_artifact::read_abi_version(&program) != Some(wasm_posix_shared::ABI_VERSION as i32)
    {
        failures.push("shared-memory output ABI contract differs".into());
    }
    if !failures.is_empty() {
        return Err(failures.join("; "));
    }
    Ok(())
}

/// Resolver-owned build handoff for normal image builders. Include reachable
/// producer outputs so a bundle consumer can retain lazy variants of its tools.
pub(super) fn dependency_inputs(
    target: &DepsManifest,
    registry: &Registry,
    cache: &Path,
    arch: TargetArch,
    abi: u32,
    policy: ResolvePolicy,
    work: &Path,
) -> Result<Option<PathBuf>, String> {
    fn collect(
        target: &DepsManifest,
        registry: &Registry,
        arch: TargetArch,
        visited: &mut BTreeSet<(String, TargetArch)>,
        outputs: &mut Vec<(DepsManifest, TargetArch)>,
    ) -> Result<(), String> {
        for dependency in &target.depends_on {
            let manifest = registry.load(&dependency.name)?;
            let arch = dependency_target_arch(target, &manifest, arch)?;
            if !visited.insert((manifest.name.clone(), arch)) {
                continue;
            }
            collect(&manifest, registry, arch, visited, outputs)?;
            if enabled(&manifest) {
                outputs.push((manifest, arch));
            }
        }
        Ok(())
    }
    let mut producers = Vec::new();
    collect(target, registry, arch, &mut BTreeSet::new(), &mut producers)?;
    let mut inputs = Vec::new();
    for (manifest, dep_arch) in producers {
        let key = manifest_cache_key_sha_for_policy(&manifest, registry, dep_arch, abi, policy)?;
        let root = canonical_path(cache, &manifest, dep_arch, abi, &hex_to_32(&key)?);
        validate_cache_entry(&manifest, &root, dep_arch, abi, &key)?;
        let members = canonical_program_members(&manifest, &root, dep_arch, &key)?;
        for output in &manifest.program_outputs {
            let Some(source_name) = &output.shared_memory_from else {
                continue;
            };
            let source = manifest
                .program_outputs
                .iter()
                .find(|candidate| candidate.name == *source_name)
                .unwrap();
            let original = members
                .iter()
                .find(|member| member.source_artifact == source.wasm)
                .ok_or("missing shared source receipt")?;
            let variant = members
                .iter()
                .find(|member| member.source_artifact == output.wasm)
                .ok_or("missing shared output receipt")?;
            inputs.push(serde_json::json!({"packageName":manifest.name,"sourceSha256":original.sha256,
                "archive":{"path":root.join(&output.wasm),"resolverPath":variant.mirror_path,"bytes":variant.size,"sha256":variant.sha256}}));
            if inputs.len() > 4096 {
                return Err("too many shared-memory dependency outputs".into());
            }
        }
    }
    if inputs.is_empty() {
        return Ok(None);
    }
    let bytes = serde_json::to_vec(
        &serde_json::json!({"schema":1,"kind":"kandelo-dependency-shared-memory-outputs",
        "consumerPackage":target.name,"outputs":inputs}),
    )
    .map_err(|error| error.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("shared-memory dependency output metadata exceeds 4 MiB".into());
    }
    let path = work.join("dependency-shared-memory-outputs.json");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o444))
            .map_err(|error| error.to_string())?;
    }
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_derived_archives_cannot_be_admitted() {
        let root = std::env::temp_dir().join(format!(
            "kandelo-derived-archive-validation-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("probe")).unwrap();
        let manifest_text = r#"kind = "program"
name = "probe"
version = "1.0.0"
depends_on = []
[source]
url = "https://example.test/probe.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[[outputs]]
name = "probe"
wasm = "probe.wasm"
[[outputs]]
name = "shared"
wasm = "shared.zip"
shared_memory_from = "probe"
fork_instrumentation = "disabled"
"#;
        std::fs::write(root.join("probe/package.toml"), manifest_text).unwrap();
        let registry = Registry {
            roots: vec![root.clone()],
        };
        let manifest = registry.load("probe").unwrap();
        let output_root = root.join("outputs");
        std::fs::create_dir(&output_root).unwrap();
        std::fs::write(output_root.join("probe.wasm"), b"ordinary source").unwrap();
        for (members, mode, contents) in [
            (vec!["wrong.wasm"], 0o755, b"not Wasm".as_slice()),
            (vec!["program.wasm", "extra"], 0o755, b"not Wasm".as_slice()),
            (vec!["program.wasm"], 0o644, b"not Wasm".as_slice()),
            (vec!["program.wasm"], 0o4755, b"not Wasm".as_slice()),
            (vec!["program.wasm"], 0o755, b"not Wasm".as_slice()),
            (vec!["program.wasm"], 0o755, b"\0asm\x01\0\0\0".as_slice()),
        ] {
            let path = output_root.join("shared.zip");
            let mut archive = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            for name in members {
                archive
                    .start_file(
                        name,
                        zip::write::SimpleFileOptions::default().unix_permissions(mode),
                    )
                    .unwrap();
                archive.write_all(contents).unwrap();
            }
            archive.finish().unwrap();
            assert!(validate(&manifest, &manifest.program_outputs[1], &output_root).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

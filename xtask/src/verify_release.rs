//! Completeness check for a staged release manifest.
//!
//! Walks the registry, enumerates every `(library|program manifest, arch)`
//! pair that the registry says SHOULD be in the release (kind = library or
//! kind = program with an on-disk build script, where `arch` is in the
//! manifest's `target_arches`), and verifies that the staged
//! `manifest.json` has an entry for each one.
//!
//! Wired into `scripts/publish-release.sh` so a partial release —
//! e.g. wasm32-only when a manifest opts into both arches — fails
//! loudly at publish time instead of silently shipping. The original
//! incident: PR #371 staged wasm32 only; mariadb / php opt into
//! wasm64 too; the release shipped without their wasm64 archives;
//! `./run.sh browser` fell back to building those from source.
//!
//! Failure mode: prints every missing pair, then exits non-zero with
//! a summary count. `--allow-partial` downgrades the failure to a
//! warning for the rare case where a partial release is intentional
//! (e.g. cutting a wasm32-only emergency fix).

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use crate::build_deps::Registry;
use crate::deps_manifest::ManifestKind;
use crate::repo_root;

pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut manifest_path: Option<PathBuf> = None;
    let mut registry_root: Option<PathBuf> = None;
    let mut allow_partial = false;

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--manifest" => {
                manifest_path = Some(it.next().ok_or("--manifest requires path")?.into())
            }
            "--registry" => {
                registry_root = Some(it.next().ok_or("--registry requires path")?.into())
            }
            "--allow-partial" => allow_partial = true,
            other => return Err(format!("unknown arg {other:?}")),
        }
    }

    let manifest_path = manifest_path.ok_or("--manifest <path> is required")?;
    let registry = if let Some(r) = registry_root {
        Registry { roots: vec![r] }
    } else {
        Registry::from_env(&repo_root())
    };

    let manifest_bytes = fs::read(&manifest_path)
        .map_err(|e| format!("read {}: {e}", manifest_path.display()))?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("parse {}: {e}", manifest_path.display()))?;

    // Collect (program, arch) pairs already present.
    let mut have: BTreeSet<(String, String)> = BTreeSet::new();
    let entries = manifest
        .get("entries")
        .and_then(|v| v.as_array())
        .ok_or("manifest.entries missing or not an array")?;
    for e in entries {
        let prog = e.get("program").and_then(|v| v.as_str());
        let arch = e.get("arch").and_then(|v| v.as_str());
        if let (Some(p), Some(a)) = (prog, arch) {
            have.insert((p.to_string(), a.to_string()));
        }
    }

    // Enumerate what SHOULD be there.
    let mut missing: Vec<(String, &'static str)> = Vec::new();
    for (_, m) in registry.walk_all()? {
        if !matches!(m.kind, ManifestKind::Library | ManifestKind::Program) {
            continue;
        }
        // Mirror stage_release's metadata-only filter: a kind=program
        // manifest without an on-disk build script doesn't produce a
        // shippable archive (those are composite VFS / bundle lookup
        // satisfiers and never appear in the release).
        if matches!(m.kind, ManifestKind::Program) {
            let script = m
                .build
                .script
                .clone()
                .unwrap_or_else(|| format!("build-{}.sh", m.name));
            if !m.dir.join(&script).is_file() {
                continue;
            }
        }
        for &arch in &m.target_arches {
            let arch_str = arch.as_str();
            if !have.contains(&(m.name.clone(), arch_str.to_string())) {
                missing.push((m.name.clone(), arch_str));
            }
        }
    }

    if missing.is_empty() {
        eprintln!(
            "verify-release-completeness: OK ({} manifest entries cover every \
             registry-declared (program, arch) pair)",
            entries.len()
        );
        return Ok(());
    }

    eprintln!("verify-release-completeness: missing {} entries:", missing.len());
    for (prog, arch) in &missing {
        eprintln!("  - {prog} ({arch})");
    }
    if allow_partial {
        eprintln!(
            "verify-release-completeness: --allow-partial set, downgrading to warning"
        );
        Ok(())
    } else {
        Err(format!(
            "{} (program, arch) pair(s) declared by the registry are missing \
             from {}. Re-run scripts/stage-release.sh with all required \
             --arch flags, or pass --allow-partial if this is intentional.",
            missing.len(),
            manifest_path.display(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-verify-release")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_lib_manifest(registry: &Path, name: &str, arches: &[&str]) {
        let dir = registry.join(name);
        fs::create_dir_all(&dir).unwrap();
        let arches_toml = arches
            .iter()
            .map(|a| format!("{:?}", a))
            .collect::<Vec<_>>()
            .join(", ");
        fs::write(
            dir.join("deps.toml"),
            format!(
                "kind = \"library\"\n\
                 name = \"{name}\"\n\
                 version = \"1.0.0\"\n\
                 revision = 1\n\
                 arches = [{arches_toml}]\n\
                 [source]\n\
                 url = \"https://example.test/{name}.tar.gz\"\n\
                 sha256 = \"{:0>64}\"\n\
                 [license]\n\
                 spdx = \"MIT\"\n\
                 [outputs]\n\
                 libs = [\"lib/lib{name}.a\"]\n",
                "",
            ),
        )
        .unwrap();
        // Build script (executable) so it counts as buildable.
        let script = dir.join(format!("build-{name}.sh"));
        fs::write(&script, "#!/bin/bash\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut p = fs::metadata(&script).unwrap().permissions();
            p.set_mode(0o755);
            fs::set_permissions(&script, p).unwrap();
        }
    }

    fn write_manifest_json(path: &Path, entries: &[(&str, &str)]) {
        let entries_json: Vec<serde_json::Value> = entries
            .iter()
            .map(|(prog, arch)| {
                serde_json::json!({
                    "name": format!("{prog}-1.0.0-rev1-abi6-{arch}-deadbeef.tar.zst"),
                    "program": prog,
                    "kind": "library",
                    "arch": arch,
                })
            })
            .collect();
        let doc = serde_json::json!({
            "abi_version": 6,
            "release_tag": "binaries-abi-v6-2026-04-29",
            "generated_at": "2026-04-29T00:00:00Z",
            "generator": "test",
            "entries": entries_json,
        });
        fs::write(path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    }

    #[test]
    fn passes_when_every_pair_is_present() {
        let dir = tempdir("ok");
        let reg = dir.join("registry");
        fs::create_dir_all(&reg).unwrap();
        write_lib_manifest(&reg, "alpha", &["wasm32", "wasm64"]);
        write_lib_manifest(&reg, "beta", &["wasm32"]);

        let mfp = dir.join("manifest.json");
        write_manifest_json(
            &mfp,
            &[
                ("alpha", "wasm32"),
                ("alpha", "wasm64"),
                ("beta", "wasm32"),
            ],
        );

        super::run(vec![
            "--manifest".into(),
            mfp.display().to_string(),
            "--registry".into(),
            reg.display().to_string(),
        ])
        .unwrap();
    }

    #[test]
    fn fails_when_an_arch_is_missing() {
        let dir = tempdir("partial");
        let reg = dir.join("registry");
        fs::create_dir_all(&reg).unwrap();
        write_lib_manifest(&reg, "alpha", &["wasm32", "wasm64"]);

        let mfp = dir.join("manifest.json");
        write_manifest_json(&mfp, &[("alpha", "wasm32")]);

        let err = super::run(vec![
            "--manifest".into(),
            mfp.display().to_string(),
            "--registry".into(),
            reg.display().to_string(),
        ])
        .expect_err("must fail when wasm64 missing");
        assert!(
            err.contains("1 (program, arch) pair(s)"),
            "error must report count: {err}"
        );
        assert!(
            err.contains("missing"),
            "error must say 'missing': {err}"
        );
    }

    #[test]
    fn allow_partial_downgrades_to_warning() {
        let dir = tempdir("allow-partial");
        let reg = dir.join("registry");
        fs::create_dir_all(&reg).unwrap();
        write_lib_manifest(&reg, "alpha", &["wasm32", "wasm64"]);

        let mfp = dir.join("manifest.json");
        write_manifest_json(&mfp, &[("alpha", "wasm32")]);

        super::run(vec![
            "--manifest".into(),
            mfp.display().to_string(),
            "--registry".into(),
            reg.display().to_string(),
            "--allow-partial".into(),
        ])
        .unwrap();
    }
}

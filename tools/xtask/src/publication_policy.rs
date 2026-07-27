//! Project-owned package publication readiness.
//!
//! A package cannot be published while it, or anything in its dependency
//! closure, has `publication_state = "pending"` in `build.toml`. Keeping this
//! graph rule in Rust gives archive staging, PR staging ledgers, and
//! prepare-merge matrices one fail-closed interpretation of project state.

use std::collections::BTreeMap;

use crate::build_deps::Registry;
use crate::pkg_manifest::{BuildToml, DepsManifest};

#[derive(Default)]
pub struct PublicationPolicy {
    blockers: BTreeMap<String, Option<Vec<String>>>,
}

impl PublicationPolicy {
    /// Return the deterministic package chain from `manifest` to the first
    /// pending package in its dependency closure.
    pub fn blocker_chain(
        &mut self,
        manifest: &DepsManifest,
        registry: &Registry,
    ) -> Result<Option<Vec<String>>, String> {
        self.visit(manifest, registry, &mut Vec::new())
    }

    fn visit(
        &mut self,
        manifest: &DepsManifest,
        registry: &Registry,
        visiting: &mut Vec<String>,
    ) -> Result<Option<Vec<String>>, String> {
        if let Some(cached) = self.blockers.get(&manifest.name) {
            return Ok(cached.clone());
        }
        if let Some(index) = visiting.iter().position(|name| name == &manifest.name) {
            let mut cycle = visiting[index..].to_vec();
            cycle.push(manifest.name.clone());
            return Err(format!(
                "package publication dependency cycle: {}",
                cycle.join(" -> ")
            ));
        }

        visiting.push(manifest.name.clone());
        let result = (|| {
            let build_path = manifest.dir.join("build.toml");
            if build_path.exists() {
                let build = BuildToml::load(&manifest.dir)?;
                if !build.publication_state.is_ready() {
                    return Ok(Some(vec![manifest.name.clone()]));
                }
            }

            let mut dependencies = manifest.depends_on.iter().collect::<Vec<_>>();
            dependencies.sort_by(|left, right| left.name.cmp(&right.name));
            for dependency in dependencies {
                let child = registry.load(&dependency.name)?;
                if child.version != dependency.version {
                    return Err(format!(
                        "{} depends on {}@{}, registry selected {}",
                        manifest.spec(),
                        dependency.name,
                        dependency.version,
                        child.spec()
                    ));
                }
                if let Some(mut chain) = self.visit(&child, registry, visiting)? {
                    chain.insert(0, manifest.name.clone());
                    return Ok(Some(chain));
                }
            }
            Ok(None)
        })();
        visiting.pop();

        let result = result?;
        self.blockers.insert(manifest.name.clone(), result.clone());
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tempdir(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "kandelo-publication-policy-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_package(root: &Path, name: &str, dependencies: &[&str], pending: bool) {
        let package = root.join(name);
        fs::create_dir_all(&package).unwrap();
        let dependency_text = dependencies
            .iter()
            .map(|dependency| format!("{dependency:?}"))
            .collect::<Vec<_>>()
            .join(", ");
        fs::write(
            package.join("package.toml"),
            format!(
                r#"kind = "program"
name = "{name}"
version = "1.0.0"
kernel_abi = {kernel_abi}
depends_on = [{dependency_text}]

[source]
url = "https://example.test/{name}.tar.gz"
sha256 = "{source_sha}"

[license]
spdx = "TestLicense"

[build]
script_path = "{name}/build.sh"

[[outputs]]
name = "{name}"
wasm = "{name}.wasm"
"#,
                source_sha = "0".repeat(64),
                kernel_abi = wasm_posix_shared::ABI_VERSION,
            ),
        )
        .unwrap();
        fs::write(package.join("build.sh"), "#!/bin/sh\n").unwrap();
        fs::write(
            package.join("build.toml"),
            format!(
                r#"script_path = "{name}/build.sh"
repo_url = "https://example.test/repo.git"
commit = "UNPUBLISHED"
revision = 1
publication_state = "{state}"

[binary]
index_url = "https://example.test/binaries-abi-v{{abi}}/index.toml"
"#,
                state = if pending { "pending" } else { "ready" },
            ),
        )
        .unwrap();
    }

    #[test]
    fn blocks_direct_and_transitive_dependents_but_not_unrelated_packages() {
        let root = tempdir("reverse-closure");
        write_package(&root, "pending", &[], true);
        write_package(&root, "direct", &["pending@1.0.0"], false);
        write_package(&root, "transitive", &["direct@1.0.0"], false);
        write_package(&root, "unrelated", &[], false);
        let registry = Registry {
            roots: vec![root.clone()],
        };
        let mut policy = PublicationPolicy::default();

        assert_eq!(
            policy
                .blocker_chain(&registry.load("pending").unwrap(), &registry)
                .unwrap(),
            Some(vec!["pending".into()])
        );
        assert_eq!(
            policy
                .blocker_chain(&registry.load("direct").unwrap(), &registry)
                .unwrap(),
            Some(vec!["direct".into(), "pending".into()])
        );
        assert_eq!(
            policy
                .blocker_chain(&registry.load("transitive").unwrap(), &registry)
                .unwrap(),
            Some(vec!["transitive".into(), "direct".into(), "pending".into()])
        );
        assert_eq!(
            policy
                .blocker_chain(&registry.load("unrelated").unwrap(), &registry)
                .unwrap(),
            None
        );

        fs::write(
            root.join("pending/build.toml"),
            fs::read_to_string(root.join("pending/build.toml"))
                .unwrap()
                .replace(
                    "publication_state = \"pending\"",
                    "publication_state = \"ready\"",
                ),
        )
        .unwrap();
        let mut ready_policy = PublicationPolicy::default();
        assert_eq!(
            ready_policy
                .blocker_chain(&registry.load("transitive").unwrap(), &registry)
                .unwrap(),
            None
        );
    }
}

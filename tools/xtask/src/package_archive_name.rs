//! Canonical transport naming for Kandelo package archives.
//!
//! Package names and versions may both contain `-`, so the rendered name is
//! intentionally one-way. Consumers recover identity from `manifest.toml` and
//! use this renderer only to verify that the transport label is canonical.

use crate::pkg_manifest::{DepsManifest, TargetArch};

pub(crate) fn render(
    manifest: &DepsManifest,
    arch: TargetArch,
    abi: u32,
    cache_key_sha: &str,
) -> String {
    let short = cache_key_sha
        .get(..8)
        .expect("package archive cache key must be validated before rendering");
    format!(
        "{}-{}-rev{}-abi{}-{}-{}.tar.zst",
        manifest.name,
        manifest.version,
        manifest.revision,
        abi,
        arch.as_str(),
        short,
    )
}

//! The artifact search tiers, and their order.
//!
//! # Why this module exists
//!
//! A built artifact can live in several places, and which copy you get depends
//! on the order they are searched. That order was spelled independently in
//! eight places: the TypeScript resolver's roots, `crates/host-native`'s
//! `ARTIFACT_TIERS`, and seven literals across `tools/xtask`, which is the
//! program that *writes* into the tiers.
//!
//! **The drift that follows is not hypothetical.** After a `./run.sh setup`
//! that exited 0, `local-binaries/source-only-v1/kernel.wasm` was a regular
//! file built that afternoon and exported `kernel_thread_parent_tid_target`,
//! while `local-binaries/kernel.wasm` was a symlink from seven hours earlier
//! that did not. `cargo test -p host-native` failed 39 of 53 against a tree
//! where the build had just succeeded, because the two halves disagreed about
//! which copy was current.
//!
//! TypeScript had already had this defect once *within itself* and fixed it by
//! extracting `host/src/binary-tiers.ts` — whose comment records that the
//! previous hand-maintained second copy "drifted in both directions". That fix
//! stopped at the language boundary. This module carries it across.

/// Where a tier's root is rooted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TierAnchor {
    /// Relative to the repository root. Present only in a source checkout.
    RepoRoot,
    /// Relative to the installed host package. Always present, with or without
    /// a checkout, which is why it is last and never conditional.
    PackageRoot,
}

/// One artifact search tier.
#[derive(Debug, Clone, Copy)]
pub struct ArtifactTier {
    /// Stable identifier, used by both hosts to name the tier in diagnostics.
    pub kind: &'static str,
    /// Human-facing label.
    pub label: &'static str,
    /// Path relative to the tier's anchor, using `/` separators.
    pub relative_path: &'static str,
    /// What `relative_path` is relative to.
    pub anchor: TierAnchor,
    /// True when the tier only exists once a local build has written it, so a
    /// consumer must check for existence before searching it.
    pub conditional: bool,
}

/// Every artifact tier, **in search order**. First match wins.
///
/// `source-only-v1` is first because it is the tier a completed local build
/// writes: `xtask local-build run` publishes into it and `xtask verify-fresh`
/// checks the kernel in it. Reading `local-binaries/` first is how a stale
/// symlink came to shadow a freshly built kernel.
pub const ARTIFACT_TIERS: &[ArtifactTier] = &[
    ArtifactTier {
        kind: "source-only-v1",
        label: "source-only-v1",
        relative_path: "local-binaries/source-only-v1",
        anchor: TierAnchor::RepoRoot,
        conditional: true,
    },
    ArtifactTier {
        kind: "local-binaries",
        label: "local-binaries",
        relative_path: "local-binaries",
        anchor: TierAnchor::RepoRoot,
        conditional: false,
    },
    ArtifactTier {
        kind: "binaries",
        label: "binaries",
        relative_path: "binaries",
        anchor: TierAnchor::RepoRoot,
        conditional: false,
    },
    ArtifactTier {
        kind: "installed-package",
        label: "installed package",
        relative_path: "wasm",
        anchor: TierAnchor::PackageRoot,
        conditional: false,
    },
];

/// The tier a completed local build publishes into.
pub const SOURCE_ONLY_TIER: &ArtifactTier = &ARTIFACT_TIERS[0];

#[cfg(test)]
mod tests {
    use super::*;

    fn position(kind: &str) -> Option<usize> {
        let mut i = 0;
        while i < ARTIFACT_TIERS.len() {
            if str_eq(ARTIFACT_TIERS[i].kind, kind) {
                return Some(i);
            }
            i += 1;
        }
        None
    }

    // `crates/shared` is no_std, so no `Vec` and no `str::eq` via PartialEq on
    // slices of &str in const context. Bytes are enough here.
    fn str_eq(a: &str, b: &str) -> bool {
        a.as_bytes() == b.as_bytes()
    }

    #[test]
    fn source_only_is_searched_before_local_binaries() {
        // The incident this module exists to prevent: reading
        // `local-binaries/` before `local-binaries/source-only-v1/` served a
        // seven-hour-old symlink after a build that had just succeeded.
        let source_only = position("source-only-v1").expect("source-only tier");
        let local = position("local-binaries").expect("local-binaries tier");
        assert!(
            source_only < local,
            "source-only-v1 must be searched before local-binaries",
        );
    }

    #[test]
    fn the_package_tier_is_last_and_unconditional() {
        // An installed npm consumer has no repo root, so this is the only tier
        // it has. A conditional or earlier placement loses that.
        let last = ARTIFACT_TIERS[ARTIFACT_TIERS.len() - 1];
        assert_eq!(last.anchor, TierAnchor::PackageRoot);
        assert!(!last.conditional);
        let mut i = 0;
        while i < ARTIFACT_TIERS.len() - 1 {
            assert_eq!(
                ARTIFACT_TIERS[i].anchor,
                TierAnchor::RepoRoot,
                "only the final tier may be package-anchored",
            );
            i += 1;
        }
    }

    #[test]
    fn kinds_are_unique() {
        let mut i = 0;
        while i < ARTIFACT_TIERS.len() {
            let mut j = i + 1;
            while j < ARTIFACT_TIERS.len() {
                assert!(
                    !str_eq(ARTIFACT_TIERS[i].kind, ARTIFACT_TIERS[j].kind),
                    "tier kinds must be unique",
                );
                j += 1;
            }
            i += 1;
        }
    }

    #[test]
    fn relative_paths_are_relative_and_slash_separated() {
        let mut i = 0;
        while i < ARTIFACT_TIERS.len() {
            let p = ARTIFACT_TIERS[i].relative_path;
            assert!(!p.is_empty(), "a tier path must not be empty");
            assert!(!p.starts_with('/'), "tier paths are relative");
            assert!(!p.contains('\\'), "tier paths use / separators");
            i += 1;
        }
    }
}
//! `xtask index-update` — atomically mutate `index.toml` with the
//! result of one per-package matrix-build job.
//!
//! Called from `scripts/index-update.sh` (Phase 8) inside the
//! state-lock acquired for the target tag. Reads the current
//! `index.toml`, applies a success-or-failed update, writes the
//! result back. The lock + GitHub-release sequence around it
//! guarantees readers always see a consistent ledger.

#[cfg(test)]
mod tests {
    #[test]
    fn index_update_success_writes_entry_to_index() {
        use super::*;
        use crate::index_toml::{EntryStatus, IndexToml};
        use crate::pkg_manifest::TargetArch;

        let tmp = std::env::temp_dir().join(format!(
            "wpk-xtask-idx-update-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let idx_path = tmp.join("index.toml");
        let empty = IndexToml::empty(8, "seeded".into(), "test-seed".into());
        std::fs::write(&idx_path, empty.write()).unwrap();

        let archive_path = tmp.join("foo-1.0-rev1-abi8-wasm32-deadbeef.tar.zst");
        std::fs::write(&archive_path, b"fake archive bytes").unwrap();

        run_index_update(&[
            "--index-path".to_string(),
            idx_path.to_string_lossy().into_owned(),
            "--package".to_string(),
            "foo".to_string(),
            "--version".to_string(),
            "1.0".to_string(),
            "--revision".to_string(),
            "1".to_string(),
            "--arch".to_string(),
            "wasm32".to_string(),
            "--status".to_string(),
            "success".to_string(),
            "--archive-path".to_string(),
            archive_path.to_string_lossy().into_owned(),
            "--archive-name".to_string(),
            "foo-1.0-rev1-abi8-wasm32-deadbeef.tar.zst".to_string(),
            "--cache-key-sha".to_string(),
            "deadbeefcafebabe".to_string(),
            "--built-at".to_string(),
            "2026-05-13T00:00:00Z".to_string(),
            "--built-by".to_string(),
            "https://example.com/run/1".to_string(),
        ])
        .unwrap();

        let updated = IndexToml::parse(&std::fs::read_to_string(&idx_path).unwrap()).unwrap();
        let entry = updated.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
        assert_eq!(entry.status, EntryStatus::Success);
        assert_eq!(
            entry.archive_url.as_deref(),
            Some("foo-1.0-rev1-abi8-wasm32-deadbeef.tar.zst")
        );
        assert_eq!(entry.cache_key_sha.as_deref(), Some("deadbeefcafebabe"));
        assert_eq!(entry.built_at.as_deref(), Some("2026-05-13T00:00:00Z"));
        assert_eq!(entry.built_by.as_deref(), Some("https://example.com/run/1"));

        // archive_sha256 is computed by the subcommand from the
        // archive file's bytes — not passed on the command line.
        // Verify it's the sha256 of the staged bytes.
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"fake archive bytes");
        let expected_sha: [u8; 32] = h.finalize().into();
        let expected_hex: String = expected_sha
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(entry.archive_sha256.as_deref(), Some(expected_hex.as_str()));
    }
}

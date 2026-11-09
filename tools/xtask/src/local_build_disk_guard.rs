//! Optional admission guard, not a disk reservation: an admitted node or an
//! unrelated process can still consume the remaining space. Check once at
//! each real node launch; never poll, delay recipes or alter cached skips.
use std::ffi::OsStr;
use std::path::Path;

const RESERVE_ENV: &str = "KANDELO_LOCAL_BUILD_MIN_FREE_BYTES";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct DiskReserve(Option<u64>);

impl DiskReserve {
    pub(crate) fn from_env() -> Result<Self, String> {
        Self::parse(std::env::var_os(RESERVE_ENV).as_deref())
    }

    fn parse(value: Option<&OsStr>) -> Result<Self, String> {
        let Some(value) = value else {
            return Ok(Self(None));
        };
        let invalid =
            || format!("{RESERVE_ENV} must be a positive decimal byte count; got {value:?}");
        let text = value.to_str().ok_or_else(invalid)?;
        if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid());
        }
        let bytes = text.parse::<u64>().map_err(|_| invalid())?;
        if bytes == 0 {
            return Err(invalid());
        }
        Ok(Self(Some(bytes)))
    }

    pub(crate) fn check(self, node: &str, roots: &[&Path]) -> Result<(), String> {
        self.check_with(node, roots, available_bytes)
    }

    fn check_with(
        self,
        node: &str,
        roots: &[&Path],
        mut available: impl FnMut(&Path) -> Result<u64, String>,
    ) -> Result<(), String> {
        // WHY no default stat: unset must preserve both the old admission
        // behavior and its cost. A reserve is an explicit operator decision.
        let Some(reserve) = self.0 else {
            return Ok(());
        };
        for root in roots {
            let free = available(root).map_err(|error| format!(
                "local-build refusing to start {node}: cannot inspect disk space at {}: {error}",
                root.display(),
            ))?;
            if free < reserve {
                return Err(format!(
                    "local-build refusing to start {node}: {} has {free} available bytes, below {RESERVE_ENV}={reserve}; no child was started",
                    root.display(),
                ));
            }
        }
        Ok(())
    }
}

#[cfg(unix)]
fn available_bytes(path: &Path) -> Result<u64, String> {
    let space = rustix::fs::statvfs(path).map_err(|error| error.to_string())?;
    // WHY bavail rather than bfree: only blocks available to this ordinary
    // caller count; reserved filesystem blocks cannot fund the next recipe.
    available_from_blocks(space.f_bavail, space.f_frsize)
}

#[cfg(not(unix))]
fn available_bytes(_path: &Path) -> Result<u64, String> {
    Err("the opt-in local-build disk reserve requires statvfs support".to_string())
}

fn available_from_blocks(blocks: u64, fragment_size: u64) -> Result<u64, String> {
    if fragment_size == 0 {
        return Err("statvfs reported a zero fragment size".to_string());
    }
    blocks
        .checked_mul(fragment_size)
        .ok_or_else(|| "statvfs available byte count overflowed u64".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_build::{NodeRunResultV1, PlanNodeV1, SuccessDispositionV1};
    use crate::local_build_executor::{NodeCompletionV1, execute_graph};
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn local_build_disk_guard_unset_never_queries_capacity() {
        let reserve = DiskReserve::parse(None).unwrap();
        reserve
            .check_with("unchanged", &[Path::new("missing")], |_| {
                panic!("unset guard must not inspect filesystems")
            })
            .unwrap();
    }

    #[test]
    fn local_build_disk_guard_rejects_invalid_budgets() {
        for invalid in [
            "",
            "0",
            "-1",
            "+1",
            " 1",
            "1 ",
            "1GiB",
            "1.5",
            "18446744073709551616",
        ] {
            assert!(
                DiskReserve::parse(Some(OsStr::new(invalid)))
                    .unwrap_err()
                    .contains(RESERVE_ENV)
            );
        }
        assert_eq!(
            DiskReserve::parse(Some(OsStr::new("18446744073709551615"))).unwrap(),
            DiskReserve(Some(u64::MAX))
        );
    }

    #[test]
    fn local_build_disk_guard_checks_each_write_root_and_accepts_exact_reserve() {
        let paths = [Path::new("repo"), Path::new("cache"), Path::new("output")];
        let mut seen = Vec::new();
        DiskReserve(Some(8))
            .check_with("test", &paths, |path| {
                seen.push(path.to_path_buf());
                Ok(8)
            })
            .unwrap();
        assert_eq!(seen, paths.map(Path::to_path_buf));
        let error = DiskReserve(Some(8))
            .check_with("package/wasm32", &paths, |path| {
                Ok(if path == paths[1] { 7 } else { 8 })
            })
            .unwrap_err();
        assert!(
            error.contains("package/wasm32")
                && error.contains("cache has 7")
                && error.contains("no child was started")
        );
    }

    #[test]
    fn local_build_disk_guard_inspection_failure_is_loud() {
        let error = DiskReserve(Some(8))
            .check_with("failed-probe", &[Path::new("cache")], |_| {
                Err("probe refused".into())
            })
            .unwrap_err();
        assert!(
            error.contains("failed-probe")
                && error.contains("cache")
                && error.contains("probe refused")
        );
        assert!(available_from_blocks(1, 0).is_err());
        assert!(available_from_blocks(u64::MAX, 2).is_err());
        assert_eq!(available_from_blocks(3, 4096).unwrap(), 12288);
    }

    #[cfg(unix)]
    #[test]
    fn local_build_disk_guard_queries_real_filesystem_without_a_shell() {
        let temporary = tempfile::tempdir().unwrap();
        available_bytes(temporary.path()).unwrap();
        assert!(available_bytes(&temporary.path().join("absent")).is_err());
    }

    #[test]
    fn local_build_disk_guard_scheduler_refusal_has_no_child_side_effects() {
        let first = PlanNodeV1::Product {
            id: "a-first".into(),
        };
        let refused = PlanNodeV1::Product {
            id: "b-refused".into(),
        };
        let dependent = PlanNodeV1::Product {
            id: "c-dependent".into(),
        };
        let graph = BTreeMap::from([
            (first.clone(), BTreeSet::new()),
            (refused.clone(), BTreeSet::from([first.clone()])),
            (dependent.clone(), BTreeSet::from([refused.clone()])),
        ]);
        let calls = AtomicUsize::new(0);
        let temp = tempfile::tempdir().unwrap();
        let result = execute_graph(&graph, 1, |node, completions| {
            DiskReserve(Some(8)).check_with("test-node", &[temp.path()], |_| {
                Ok(if node == first { 8 } else { 7 })
            })?;
            calls.fetch_add(1, Ordering::SeqCst);
            // Positive control launches an actual native child. A refused
            // launch must reach neither this child nor its marker write.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("--help")
                .output()
                .unwrap();
            assert!(output.status.success());
            std::fs::write(
                temp.path()
                    .join(if node == first { "first" } else { "refused" }),
                b"started",
            )
            .unwrap();
            completions
                .send(NodeCompletionV1::succeeded(
                    node,
                    SuccessDispositionV1::Published,
                ))
                .unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(temp.path().join("first").is_file());
        assert!(!temp.path().join("refused").exists());
        assert!(
            result
                .iter()
                .any(|r| matches!(r, NodeRunResultV1::Failed { node, .. } if node == &refused))
        );
        assert!(
            result
                .iter()
                .any(|r| matches!(r, NodeRunResultV1::Blocked { node, .. } if node == &dependent))
        );
    }
}

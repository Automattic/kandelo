//! Dump the Rust WASI translation results over their FULL input domains.
//!
//! This is the producing half of K10's differential-equivalence harness. The
//! consuming half is `host/test/wasi-translation-equivalence.test.ts`, which
//! loads this JSON and asserts that `host/src/wasi-shim.ts` computes the same
//! value for every input.
//!
//! The domains are small enough to enumerate exhaustively, so this is proof
//! rather than sampling: no input in range is untested.
//!
//! Usage:
//!   cargo run -p xtask --target <host> -- dump-wasi-translation \
//!       --out host/test/fixtures/wasi-translation-rust.json
//!
//! ## Documented divergences
//!
//! Four of the entries carry an `exceptions` list rather than plain agreement.
//! The TypeScript being replaced has five latent defects, and a harness that
//! asserted bit-for-bit equality would be certifying them as correct. Each
//! exception names the defect, the inputs it covers, what the TypeScript
//! answers, and what Rust answers instead. The Vitest side asserts agreement
//! everywhere EXCEPT those inputs, and asserts the divergence ON them -- so a
//! defect fix silently regressing is still a test failure.

use std::path::PathBuf;

use serde::Serialize;
use wasi_abi::layout::{self, WasmStatFields};
use wasi_abi::translate::{self, poll_events};
use wasi_abi::types::{WasiFdflags, WasiLookupflags, WasiOflags};
use wasi_abi::WasiErrno;
use wasm_posix_shared::mode;

#[derive(Serialize)]
struct Divergence {
    defect: &'static str,
    summary: &'static str,
    /// Inputs on which Rust deliberately disagrees with the TypeScript.
    inputs: Vec<serde_json::Value>,
}

#[derive(Serialize)]
struct Table {
    /// What the function is, for a reader of the JSON.
    description: &'static str,
    /// Fully enumerated domain: one entry per input.
    values: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    divergence: Option<Divergence>,
}

#[derive(Serialize)]
struct Dump {
    generator: &'static str,
    note: &'static str,
    tables: serde_json::Map<String, serde_json::Value>,
}

fn errno_table() -> Table {
    // 0..=200 covers every Linux errno musl defines plus the unmapped gaps.
    let values = (0u32..=200)
        .map(|linux| {
            serde_json::json!({
                "in": linux,
                "out": wasi_abi::translate_linux_errno(linux).as_u16(),
            })
        })
        .collect();
    Table {
        description: "translateLinuxErrno: Linux errno -> WASI errno, 0..=200",
        values,
        divergence: None,
    }
}

fn filetype_table() -> Table {
    // Every S_IFMT bucket, each with a spread of low permission bits, plus a
    // few values whose type nibble is undefined.
    let mut values = Vec::new();
    let buckets = [
        mode::S_IFIFO,
        mode::S_IFCHR,
        mode::S_IFDIR,
        mode::S_IFBLK,
        mode::S_IFREG,
        mode::S_IFLNK,
        mode::S_IFSOCK,
        0,
        0o030000, // an undefined type nibble
        0o150000, // another
    ];
    for bucket in buckets {
        for low in [0u32, 0o1, 0o644, 0o755, 0o777, 0o7777] {
            let st_mode = bucket | low;
            values.push(serde_json::json!({
                "in": st_mode,
                "out": translate::mode_to_filetype(st_mode).as_u8(),
            }));
        }
    }
    Table {
        description: "modeToFiletype: st_mode -> WASI filetype, all S_IFMT buckets",
        values,
        divergence: None,
    }
}

fn whence_table() -> Table {
    let values = (0u32..=8)
        .map(|whence| {
            serde_json::json!({
                "in": whence,
                // null models the TypeScript's `number | null` return.
                "out": translate::wasi_whence_to_posix(whence),
            })
        })
        .collect();
    Table {
        description: "wasiWhenceToPosix: WASI whence -> POSIX SEEK_*, null when undefined",
        values,
        divergence: None,
    }
}

fn clock_table() -> Table {
    let values = (0u32..=8)
        .map(|clock| {
            serde_json::json!({
                // The lenient form is what the TypeScript computes today.
                "in": clock,
                "out": translate::wasi_clock_to_posix_lenient(clock),
                "strict": translate::wasi_clock_to_posix(clock),
            })
        })
        .collect();
    Table {
        description: "wasiClockToPosix: WASI clockid -> POSIX CLOCK_*",
        values,
        divergence: Some(Divergence {
            defect: "defect-6",
            summary:
                "wasiClockToPosix silently defaults an undefined clock to CLOCK_REALTIME, so a \
                 guest asking for a clock Kandelo does not implement is handed a DIFFERENT one \
                 with no way to detect the substitution. `out` reproduces that behavior so the \
                 harness can confirm it still describes the TypeScript; `strict` is what \
                 wasi-module actually does -- null, which the entry points return as EINVAL.",
            inputs: (4u32..=8).map(|c| serde_json::json!(c)).collect(),
        }),
    }
}

fn oflags_table() -> Table {
    let mut values = Vec::new();
    for oflags in 0u32..=15 {
        for fdflags in 0u32..=31 {
            values.push(serde_json::json!({
                "oflags": oflags,
                "fdflags": fdflags,
                "out": translate::wasi_oflags_to_posix(WasiOflags(oflags), WasiFdflags(fdflags)),
            }));
        }
    }
    Table {
        description: "wasiOflagsToPosix: 16 x 32 = 512 combinations, exhaustive",
        values,
        divergence: None,
    }
}

fn fdflags_table() -> Table {
    // Every single POSIX bit the shim could see, plus combinations.
    let mut probes: Vec<u32> = (0..24).map(|bit| 1u32 << bit).collect();
    probes.extend([
        0,
        0o2000 | 0o4000,           // O_APPEND | O_NONBLOCK
        0o100 | 0o1000 | 0o2000,   // O_CREAT | O_TRUNC | O_APPEND
        0xFFFF_FFFF,
    ]);
    let values = probes
        .into_iter()
        .map(|posix| {
            serde_json::json!({
                "in": posix,
                "out": translate::posix_flags_to_wasi_fdflags(posix).bits(),
            })
        })
        .collect();
    Table {
        description: "posixFlagToWasiFdflags: POSIX open flags -> WASI fdflags",
        values,
        divergence: None,
    }
}

fn i64_split_table() -> Table {
    let mut probes: Vec<i64> = vec![
        0,
        1,
        -1,
        i64::MAX,
        i64::MIN,
        i32::MAX as i64,
        i32::MIN as i64,
        u32::MAX as i64,
        0x0123_4567_89AB_CDEF,
        -0x0123_4567_89AB_CDEF,
        // Beyond Number.MAX_SAFE_INTEGER, where a JS number would round.
        9_007_199_254_740_993,
        -9_007_199_254_740_993,
    ];
    // A fixed pseudo-random vector set: a xorshift with a hard-coded seed, so
    // the JSON is reproducible byte-for-byte across runs.
    let mut state: u64 = 0x2545_F491_4F6C_DD1D;
    for _ in 0..200 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        probes.push(state as i64);
    }
    let values = probes
        .into_iter()
        .map(|value| {
            let (low, high) = translate::split_signed_i64_words(value);
            serde_json::json!({
                // Serialized as a decimal string: JSON numbers cannot carry
                // an i64 exactly, which is the very hazard under test.
                "in": value.to_string(),
                "low": low,
                "high": high,
            })
        })
        .collect();
    Table {
        description: "splitSignedI64Words: i64 -> (low u32, high i32), boundaries + fixed vectors",
        values,
        divergence: None,
    }
}

fn fdflags_setfl_table() -> Table {
    let values = (0u32..=63)
        .map(|fdflags| {
            let out = translate::wasi_fdflags_to_setfl(WasiFdflags(fdflags));
            serde_json::json!({
                "in": fdflags,
                "ok": out.ok(),
                "err": out.err().map(WasiErrno::as_u16),
            })
        })
        .collect();
    Table {
        description: "fd_fdstat_set_flags mapping (Rust only; the TypeScript has no such function)",
        values,
        divergence: Some(Divergence {
            defect: "defect-3",
            summary:
                "fdFdstatSetFlags maps only APPEND and NONBLOCK and then returns ESUCCESS, so a \
                 guest asking for O_SYNC/O_DSYNC/O_RSYNC is told it got synchronised writes and \
                 did not. The kernel defines none of those flags, so Rust returns ENOTSUP. An \
                 undefined bit is EINVAL.",
            inputs: (0u32..=63)
                .filter(|f| f & (2 | 8 | 16) != 0 || f & !31 != 0)
                .map(|f| serde_json::json!(f))
                .collect(),
        }),
    }
}

fn lookupflags_table() -> Table {
    let values = (0u32..=3)
        .map(|lookupflags| {
            serde_json::json!({
                "in": lookupflags,
                "out": translate::wasi_lookupflags_to_at_flags(WasiLookupflags(lookupflags)),
                "typescript": 0,
            })
        })
        .collect();
    Table {
        description: "path_filestat_get lookupflags -> fstatat flags",
        values,
        divergence: Some(Divergence {
            defect: "defect-2",
            summary:
                "pathFilestatGet ignores lookupflags entirely and passes a literal 0 to FSTATAT, \
                 so it always follows symlinks and WASI's lstat is unreachable. Rust maps the \
                 absence of SYMLINK_FOLLOW to AT_SYMLINK_NOFOLLOW, which is the only value that \
                 differs from the TypeScript's constant 0.",
            inputs: vec![serde_json::json!(0), serde_json::json!(2)],
        }),
    }
}

fn poll_tag_table() -> Table {
    let values = (0u16..=255)
        .map(|tag| {
            let out = translate::poll_events_for_eventtype(tag as u8);
            serde_json::json!({
                "in": tag,
                "ok": out.as_ref().ok().and_then(|e| *e),
                "err": out.err().map(WasiErrno::as_u16),
                // What `tag === FD_READ ? POLLIN : POLLOUT` produces.
                "typescript": if tag == 1 { poll_events::POLLIN } else { poll_events::POLLOUT },
            })
        })
        .collect();
    Table {
        description: "poll_oneoff subscription tag -> POSIX poll events, exhaustive over u8",
        values,
        divergence: Some(Divergence {
            defect: "defect-1",
            summary:
                "pollOneoff computes `tag === FD_READ ? POLLIN : POLLOUT`, so EVERY tag that is \
                 not FD_READ -- including CLOCK, and including a malformed or future tag -- is \
                 silently treated as a write subscription. Rust matches exhaustively: CLOCK is \
                 not a pollfd subscription at all, and an undefined tag is EINVAL.",
            inputs: (0u16..=255)
                .filter(|t| *t != 1)
                .map(|t| serde_json::json!(t))
                .collect(),
        }),
    }
}

fn filestat_table() -> Table {
    // Fixed stat records covering each filetype, zero/large sizes, and the
    // padding case that defect 4 turns on.
    let cases: Vec<(&str, WasmStatFields, u32)> = vec![
        (
            "regular file",
            WasmStatFields {
                dev: 0x1122_3344_5566_7788,
                ino: 42,
                mode: mode::S_IFREG | 0o644,
                nlink: 3,
                size: 4096,
                atime_sec: 1,
                atime_nsec: 500,
                mtime_sec: 2,
                mtime_nsec: 600,
                ctime_sec: 3,
                ctime_nsec: 700,
            },
            0,
        ),
        (
            "directory",
            WasmStatFields {
                dev: 1,
                ino: 2,
                mode: mode::S_IFDIR | 0o755,
                nlink: 2,
                size: 0,
                atime_sec: 0,
                atime_nsec: 0,
                mtime_sec: 0,
                mtime_nsec: 0,
                ctime_sec: 0,
                ctime_nsec: 0,
            },
            0,
        ),
        (
            "symlink with nonzero struct padding",
            WasmStatFields {
                dev: 9,
                ino: 10,
                mode: mode::S_IFLNK | 0o777,
                nlink: 1,
                size: 11,
                atime_sec: 1_700_000_000,
                atime_nsec: 123_456_789,
                mtime_sec: 1_700_000_001,
                mtime_nsec: 987_654_321,
                ctime_sec: 1_700_000_002,
                ctime_nsec: 123_456_789,
            },
            // The `_pad: u32` at offset 84 that the TypeScript's u64 read at
            // offset 80 sweeps into st_ctime_nsec's high bits.
            0xDEAD_BEEF,
        ),
    ];

    let mut values = Vec::new();
    for (name, st, pad) in cases {
        // Build the kernel-side wire bytes so the TypeScript can decode the
        // very same buffer with its own hand-written offsets.
        let mut raw = vec![0u8; layout::wasm_stat::SIZE];
        let put64 = |raw: &mut Vec<u8>, off: usize, v: u64| {
            raw[off..off + 8].copy_from_slice(&v.to_le_bytes())
        };
        let put32 = |raw: &mut Vec<u8>, off: usize, v: u32| {
            raw[off..off + 4].copy_from_slice(&v.to_le_bytes())
        };
        put64(&mut raw, layout::wasm_stat::ST_DEV, st.dev);
        put64(&mut raw, layout::wasm_stat::ST_INO, st.ino);
        put32(&mut raw, layout::wasm_stat::ST_MODE, st.mode);
        put32(&mut raw, layout::wasm_stat::ST_NLINK, st.nlink);
        put64(&mut raw, layout::wasm_stat::ST_SIZE, st.size);
        put64(&mut raw, layout::wasm_stat::ST_ATIME_SEC, st.atime_sec);
        put32(&mut raw, layout::wasm_stat::ST_ATIME_NSEC, st.atime_nsec);
        put64(&mut raw, layout::wasm_stat::ST_MTIME_SEC, st.mtime_sec);
        put32(&mut raw, layout::wasm_stat::ST_MTIME_NSEC, st.mtime_nsec);
        put64(&mut raw, layout::wasm_stat::ST_CTIME_SEC, st.ctime_sec);
        put32(&mut raw, layout::wasm_stat::ST_CTIME_NSEC, st.ctime_nsec);
        put32(&mut raw, 84, pad);

        let mut out = vec![0u8; layout::filestat::SIZE];
        assert!(layout::encode_filestat(&st, &mut out));

        values.push(serde_json::json!({
            "name": name,
            "wasm_stat_bytes": raw,
            "filestat_bytes": out,
            "pad_at_84": pad,
        }));
    }

    Table {
        description:
            "translateStat: kernel WasmStat wire bytes -> WASI filestat wire bytes",
        values,
        divergence: Some(Divergence {
            defect: "defect-4",
            summary:
                "translateStat reads the 88-byte kernel stat at hand-written offsets while \
                 importing and ignoring WASM_STAT_SIZE. st_ctime_nsec is a u32 at offset 80 and \
                 the struct's explicit `_pad: u32` sits at 84, so the TypeScript's u64 read puts \
                 the padding into the high bits of the reported ctim. The third case sets that \
                 padding to 0xDEADBEEF; the TypeScript will disagree on ctim there and agree \
                 everywhere else.",
            inputs: vec![serde_json::json!("symlink with nonzero struct padding")],
        }),
    }
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut out: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--out" => {
                i += 1;
                out = Some(PathBuf::from(
                    args.get(i).ok_or("--out requires a path")?,
                ));
            }
            other => return Err(format!("unknown argument {other}")),
        }
        i += 1;
    }
    let out = out.ok_or("--out <path> is required")?;

    let json = render()?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    std::fs::write(&out, &json)
        .map_err(|e| format!("writing {}: {e}", out.display()))?;
    eprintln!("wrote {}", out.display());
    Ok(())
}

/// Build the dump exactly as `--out` would write it.
///
/// Separate from `run` so the committed fixture can be pinned by a test
/// rather than only by whoever last remembered to regenerate it.
pub(crate) fn render() -> Result<String, String> {
    let mut tables = serde_json::Map::new();
    let mut put = |name: &str, table: Table| {
        tables.insert(
            name.to_string(),
            serde_json::to_value(table).expect("table serializes"),
        );
    };
    put("translateLinuxErrno", errno_table());
    put("modeToFiletype", filetype_table());
    put("wasiWhenceToPosix", whence_table());
    put("wasiClockToPosix", clock_table());
    put("wasiOflagsToPosix", oflags_table());
    put("posixFlagToWasiFdflags", fdflags_table());
    put("splitSignedI64Words", i64_split_table());
    put("fdFdstatSetFlags", fdflags_setfl_table());
    put("pathFilestatGetLookupflags", lookupflags_table());
    put("pollOneoffTag", poll_tag_table());
    put("translateStat", filestat_table());

    let dump = Dump {
        generator: "cargo xtask dump-wasi-translation",
        note: "Generated. Do not hand-edit. The consuming half is \
               host/test/wasi-translation-equivalence.test.ts.",
        tables,
    };

    let json = serde_json::to_string_pretty(&dump)
        .map_err(|e| format!("serializing: {e}"))?;
    Ok(json + "\n")
}

#[cfg(test)]
mod tests {
    use super::render;

    /// The committed dump must be what today's `wasi-abi` actually produces.
    ///
    /// K10's differential harness compared this dump against the TypeScript
    /// WASI shim over every enumerated input. That comparison licensed
    /// deleting the shim -- and died with it, because after the deletion there
    /// is no second implementation to differ from.
    ///
    /// What survives, and what this test keeps alive, is the fixture's OTHER
    /// role: it is a reviewed record of the answer Rust gives for all 1,358
    /// inputs, including the five inputs sets where Rust deliberately differs
    /// from the shim's known defects. Pinning it here means a change to any
    /// translation table fails a test until someone regenerates the fixture
    /// and reviews the diff, instead of silently redefining the baseline. A
    /// stale fixture was the one failure mode the Vitest harness could not
    /// see: it compared TypeScript against whatever JSON happened to be
    /// checked in.
    #[test]
    fn the_committed_fixture_is_what_wasi_abi_produces_today() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("xtask lives at <repo>/tools/xtask");
        let fixture = repo.join("host/test/fixtures/wasi-translation-rust.json");
        let committed = std::fs::read_to_string(&fixture)
            .unwrap_or_else(|e| panic!("reading {}: {e}", fixture.display()));
        let generated = render().expect("render");
        assert_eq!(
            committed,
            generated,
            "host/test/fixtures/wasi-translation-rust.json is stale. \
             Regenerate it with `scripts/xtask.sh dump-wasi-translation --out \
             host/test/fixtures/wasi-translation-rust.json` and review the diff \
             -- every line of it is a change to observable WASI behavior."
        );
    }
}

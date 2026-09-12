# Rust-first ABI-44 campaign curation report

**Status: DONE**

Curated branch: `brandonpayton/rust-first-abi44-curated`
(local only, HEAD `eafb623f5`, NOT pushed)

The raw working/PR branch `brandonpayton/rust-first-abi44-reconcile`
was not modified (still at `9638a20235d8b3f888e23387a693bc5a6ca36ba9`).
This is a pure history re-expression: same final tree, 449 commits
regrouped into 18 phase-narrative commits.

## Inputs

- Working/PR branch HEAD: `9638a20235d8b3f888e23387a693bc5a6ca36ba9`
- merge-base with origin/main: `9195dedd1d0d0911dd1a024c55838f212e2ae531`
- 449 commits in `9195dedd1..9638a2023`, all authored by
  Brandon Payton <brandon@happycode.net>

## Method

`git commit-tree` range-squash (`rebase -i` unavailable). For each of
18 contiguous phase ranges: tree = the range's LAST commit's tree,
parent = the previous curated commit (base for the first), author =
Brandon Payton with the last-in-range author date (monotonic),
committer = repo git user (Brandon Payton). Each message is
purpose-prefixed (`Area:`) with a `## Why` before `## What changed`,
wrapped at 72 columns.

## Curated log (oneline)

```
eafb623f5 Fork: Invert control flow to coarse module entries; reach the floor
1f529e512 Fork: Make the module the only continuation path (point of no return)
a684c5485 Fork: Delete the JS reference engine; module reconstructs on V8
7980794f0 POSIX: Fix tmpfs MAP_SHARED writeback and package freshness
0a8eb3ed8 Host: Implement native fork with real reference capture (N1)
5f998bf4e Host: Bring the native host to Node parity for FS and processes
bb080564f Fork: Add module abort-replay and reconcile onto ABI 44 (F1)
53ed3d7a1 Fork: Gate unsupported reference kinds with a truthful abort (M4)
0ff38f6d9 Fork: Make the reference transit tables module-owned (M1/M2)
8f4d370d6 Fork: Reconstruct Wasm references through the co-resident module
ac2a12606 Fork: Drive qualifying forks through a co-resident Wasm module
48540c09b Fork: Add the Rust fork codec and Rust-owned exec/spawn decode
011859514 VFS: Make the in-kernel overlay the sole `/` authority (cutover)
69a6dc3fa VFS: Read filesystem images in the kernel and materialize lazily
814db547c VFS: Add the in-kernel rootfs overlay (Phase 5 Increment 2)
b62b4c5de VFS: Move scratch mounts into an in-kernel tmpfs (Phase 5)
e7e89184f Host: Add the native Wasmtime host and route epoll through the kernel
d0a69cb0a Transport: Introduce the opaque syscall channel record (ABI 44)
```

## Phase partition (source-commit range -> curated commit)

Source commits identified by their position (N of 449) in
`git log --oneline --reverse 9195dedd1..9638a2023`.

| # | Source range (first..last) | Src count | Curated commit |
|---|---|---|---|
| 1 | 10d1d0e50..3f030e916 (1..13) | 13 | d0a69cb0a Transport: opaque syscall channel record (ABI 44) |
| 2 | 774cc6e08..d94c4652b (14..24) | 11 | e7e89184f Host: native Wasmtime host + epoll kernel route |
| 3 | e4cc807f2..e6b1ea2c1 (25..48) | 24 | b62b4c5de VFS: in-kernel tmpfs scratch mounts |
| 4 | 273e14fad..33a69544c (49..70) | 22 | 814db547c VFS: in-kernel rootfs overlay (Inc 2) |
| 5 | e2ccce86f..51be0b1af (71..113) | 43 | 69a6dc3fa VFS: in-kernel image readers + lazy materialization |
| 6 | 6b02ead71..c673ea27a (114..122) | 9 | 011859514 VFS: overlay is sole / authority (cutover) |
| 7 | c673ea27a..de27b2923 (123..137) | 15 | 48540c09b Fork: Rust fork codec + Rust-owned exec/spawn decode |
| 8 | 7b5b02870..cff0101a2 (138..143) | 6 | ac2a12606 Fork: drive qualifying forks through co-resident module |
| 9 | 309e5db06..c1ee1f0a8 (144..182) | 39 | 8f4d370d6 Fork: reference reconstruction through the module |
| 10 | 74f320670..b19ad3295 (183..195) | 13 | 0ff38f6d9 Fork: module-owned transit tables (M1/M2) |
| 11 | 8a905619d..0ff8531a2 (196..204) | 9 | 53ed3d7a1 Fork: gate unsupported reference kinds (M4) |
| 12 | 059aeed56..c0b10b25f (205..219) | 15 | bb080564f Fork: module abort-replay + ABI-44 reconcile (F1) |
| 13 | 8b4bb7cba..64fba8227 (220..253) | 34 | 5f998bf4e Host: native host FS + process lifecycle (N1) |
| 14 | 9c9856c3e..6fbb939ec (254..304) | 51 | 0a8eb3ed8 Host: native fork + real reference capture (N1) |
| 15 | 2cd223397..d372dd4c3 (305..314) | 10 | 7980794f0 POSIX: tmpfs MAP_SHARED writeback + package freshness |
| 16 | 020770377..f6bde7852 (315..355) | 41 | a684c5485 Fork: delete JS reference engine; module on V8 |
| 17 | 1636cffb5..137c82e0b (356..390) | 35 | 1f529e512 Fork: module is the only continuation path (PONR) |
| 18 | b71a80fa0..9638a2023 (391..449) | 59 | eafb623f5 Fork: coarse-entry control-flow inversion; reach floor |

Total: 449 source commits -> 18 curated commits (contiguous, no gaps,
no overlaps).

## Verification results

### 1. Byte-identical diff (REQUIRED) -- PASS

```
git diff brandonpayton/rust-first-abi44-reconcile brandonpayton/rust-first-abi44-curated
```
Output: EMPTY (0 bytes). Tree equality confirmed:
- working tree: `291607d0fefa196cd0cf87846ccc01a51f70fa70`
- curated tree: `291607d0fefa196cd0cf87846ccc01a51f70fa70`

The final curated tree is byte-for-byte identical to the working
branch tree. Curation is lossless.

### 2. range-diff clean regrouping (REQUIRED) -- PASS

```
git range-diff 9195dedd1..9638a2023 9195dedd1..brandonpayton/rust-first-abi44-curated
```
Exit 0. Pairing accounting is a clean regrouping:
- 449 original commits: 444 shown as folded-away (`<`), 5 paired (`!`)
- 18 curated commits: 13 new (`>`), 5 paired (`!`)

Every original commit and every curated commit is accounted for. The
5 `!` pairings show only commit-message text plus the folded-in
content of the squashed range (the expected artifact of representing
"N commits -> 1"); there is no orphaned or divergent file content,
which is proven definitively by verification #1's byte-identical final
tree.

### 3. Author = Brandon Payton on every commit (REQUIRED) -- PASS

```
git log --format=fuller 9195dedd1..brandonpayton/rust-first-abi44-curated
```
All 18 curated commits: Author = Brandon Payton <brandon@happycode.net>
(Committer also Brandon Payton, the repo git user.)

## Constraints honored

- Nothing pushed (0 remotes carry the curated ref).
- Working branch `brandonpayton/rust-first-abi44-reconcile` untouched
  (still `9638a20235d8b3f888e23387a693bc5a6ca36ba9`).
- No tracked file deleted or modified; pure history re-expression.
- The curated branch's force-push waits for maintainer review.

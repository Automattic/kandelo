# Filesystem Permission Enforcement — Audit (PR 5/5)

**Audit Date:** 2026-05-10  
**Branch:** `vfs-resumed/05-perm-enforcement` (stacked on `vfs-resumed/04-mount-cutover`)  
**Scope:** Read-only review of existing credential tracking, access-control stubs, musl wiring, and infrastructure for PR 5/5 permission enforcement.

---

## A. Process credential fields

**File:** `crates/kernel/src/process.rs`

### Credential Fields (lines 244–328)

The `Process` struct carries the following credential-related fields:

- **`uid: u32`** (line 247) — real user ID
- **`gid: u32`** (line 248) — real group ID
- **`euid: u32`** (line 249) — effective user ID
- **`egid: u32`** (line 250) — effective group ID
- **`umask: u32`** (line 274) — file creation mask
- **`pgid: u32`** (line 251) — process group ID (not strictly credential, but related to process identity)
- **`sid: u32`** (line 252) — session ID
- **`is_session_leader: bool`** (line 259) — whether process is session leader

### Missing Credential Fields

**NOT present:**
- `suid` / `saved_set_uid` — saved-set-uid is not tracked. `seteuid` and `setresuid` reuse `uid` as the saved value.
- `sgid` / `saved_set_gid` — same as above for group
- `groups` / `supplementary_groups` — supplementary group IDs; system is single-group per process (primary gid only)

### Defaults from `Process::new()` (lines 337–403)

**File:** `crates/kernel/src/process.rs:337–403`

```rust
pub fn new(pid: u32) -> Self {
    // ...
    Process {
        // ...
        uid: 0,      // root
        gid: 0,      // root
        euid: 0,     // root
        egid: 0,     // root
        umask: 0o022,  // standard umask
        // ...
    }
}
```

**All processes default to root (uid=0, euid=0, gid=0, egid=0)** with `umask=0o022`.

### Notes

- Real UID and saved-set-UID are conflated: `setresuid(ruid, euid, suid)` ignores the `suid` parameter and uses `ruid` as the "saved" value for `seteuid` calls.
- Supplementary groups are not implemented; the system treats each process as belonging to exactly one group (`gid`/`egid`).
- Per-thread credentials (e.g., for `pthread_setuid`) are not a concern since the kernel does not track them.

---

## B. Existing credential syscalls

**File:** `crates/kernel/src/syscalls.rs`

### Implemented Syscalls

| Syscall | Syscall# | Location | Behavior | EPERM Check |
|---------|----------|----------|----------|-------------|
| `sys_getuid` | 30 | lines 3021–3023 | Returns `proc.uid` | None (read-only) |
| `sys_geteuid` | 31 | lines 3026–3028 | Returns `proc.euid` | None (read-only) |
| `sys_getgid` | 32 | lines 3031–3033 | Returns `proc.gid` | None (read-only) |
| `sys_getegid` | 33 | lines 3036–3038 | Returns `proc.egid` | None (read-only) |
| `sys_setuid` | 105 | lines 7840–7854 | Sets uid/euid if caller is root OR uid == ruid | **EPERM if euid ≠ 0 AND uid ≠ proc.uid** |
| `sys_setgid` | 106 | lines 7857–7871 | Sets gid/egid if caller is root OR gid == rgid | **EPERM if euid ≠ 0 AND gid ≠ proc.gid** |
| `sys_seteuid` | (no syscall#) | lines 7874–7882 | Sets euid only; root can set to any, others only to ruid | **EPERM if euid ≠ 0 AND euid ≠ proc.uid** |
| `sys_setresuid` | 208 | lines 8121–8125 | Sets ruid/euid (ignores suid param); no checks | **No EPERM checks** — always succeeds |
| `sys_getresuid` | 209 | lines 8128–8130 | Returns (uid, euid, uid) | None (read-only) |
| `sys_setresgid` | 210 | lines 8133–8137 | Sets rgid/egid (ignores sgid param); no checks | **No EPERM checks** — always succeeds |
| `sys_getresgid` | 211 | lines 8140–8142 | Returns (gid, egid, gid) | None (read-only) |
| `sys_getgroups` | 205 | lines 8147–8156 | Returns single group (proc.gid) in array; always returns 1 | None (supplementary groups not supported) |
| `sys_setgroups` | 206 | lines 8159–8165 | Silently accepts any array; no-op (supplementary groups not supported) | **EPERM if euid ≠ 0** (enforced) |
| `sys_umask` | 74 | lines 7238–7242 | Sets proc.umask; returns old value | None (no checks) |

### Key Notes on EPERM Enforcement

**From PR #326 (commit b9d19f771):**
- `sys_setuid` and `sys_setgid` enforce the POSIX rule: root (euid=0) can set to any value; non-root can only "drop" (set to their real uid/gid).
- `sys_setresuid` / `sys_setresgid` are currently unrestricted (no EPERM checks). This is a known gap — they should mirror `sys_setuid`/`sys_setgid`.
- `sys_setgroups` enforces `EPERM if euid != 0`, matching POSIX requirements.

**Credential-related access-control helpers (not syscalls, but part of permission model):**
- `can_signal(sender_euid: u32, target_uid: u32, target_euid: u32) -> bool` (lines 7905–7914) — POSIX rule for `kill`: sender euid must equal target uid OR target euid OR sender is root.
- `can_query_sched(sender_euid: u32, target_uid: u32, target_euid: u32) -> bool` (lines 7908–7921) — stricter rule for `sched_getparam` / `sched_setparam`: sender euid must equal target uid, target euid, OR sender is root.

**Currently wired into:**
- `sys_kill` — uses `can_signal()` for remote process checks (line 3106+).
- `sys_sched_getparam`, `sys_sched_setparam`, etc. — use `can_query_sched()` (line ~7930+).

---

## C. musl wiring (userland → syscall)

**Files:** 
- `musl-overlay/src/process/wasm32posix/` — wasm32 posix-specific overrides (fork, posix_spawn, sched overrides)
- No standard musl `/unistd/` overrides for getuid/setuid found in overlay

### Credential Syscall Wiring

The credential syscalls are **directly wired via the standard musl implementations**:
- musl's `unistd/getuid.c`, `unistd/setuid.c`, etc. (in musl's main tree, not overlay) call `__syscall(SYS_getuid)` etc.
- These syscalls map to kernel syscalls 30, 31, 105, 106, 208, 209, 210, 211 via `crates/kernel/src/wasm_api.rs` dispatcher (e.g., line 1654 for getuid).
- **No overlay required** — musl's stock implementations work as-is.

### Filesystem Syscall Wiring (Related to Permission Enforcement)

| Userland Function | Expected Syscall | Status in Kernel |
|---|---|---|
| `getuid(2)` | `SYS_GETUID` (30) | ✓ Wired (line 1654 `wasm_api.rs`) |
| `setuid(2)` | `SYS_SETUID` (105) | ✓ Wired (line 2190 `wasm_api.rs`) |
| `umask(2)` | `SYS_UMASK` (74) | ✓ Wired (line 1876 `wasm_api.rs`) |
| `chmod(2)` | `SYS_CHMOD` (20) | ✓ Wired (line 1639 `wasm_api.rs`) |
| `fchmod(2)` | `SYS_FCHMOD` (91) | ✓ Wired (line 2033 `wasm_api.rs`) |
| `access(2)` | `SYS_ACCESS` (22) | ✓ Wired (line 1727 `wasm_api.rs`) |
| `faccessat(2)` | `SYS_FACCESSAT` (439) | ✓ Wired (line 2379 `wasm_api.rs`) |
| `getgroups(2)` | `SYS_GETGROUPS` (205) | ✓ Wired (line 2157 `wasm_api.rs`) — returns primary gid only |
| `setgroups(2)` | `SYS_SETGROUPS` (206) | ✓ Wired (line 2161 `wasm_api.rs`) — no-op for supplementary |

**Observation:** All critical credential and filesystem permission syscalls are already wired. The gap is not in the wiring, but in the **enforcement logic inside the syscalls** (Tasks 5.3–5.9).

---

## D. Existing access-control sites

**File:** `crates/kernel/src/syscalls.rs`

### Current EACCES/EPERM Sites

#### 1. Procfs Write Denial (lines 2510, 7586)

**Location:** `sys_access` and `sys_faccessat`

```rust
if crate::procfs::match_procfs(&resolved, proc.pid).is_some() {
    // Procfs entries are read-only: allow R_OK/F_OK/X_OK(dirs), deny W_OK
    if amode & 0o2 != 0 { return Err(Errno::EACCES); }
    return Ok(());
}
```

**Rule:** Write (mode bit 0o2 = `W_OK`) to procfs always returns `EACCES`.  
**Status:** Hardcoded; not gated on process credentials.

#### 2. No Sticky-Bit Checks

**Search result:** Grep for `sticky\|ISVTX\|1777` returned no matches in `syscalls.rs`.  
**Status:** Sticky-bit semantics for unlink/rename in `/tmp` not yet implemented.

#### 3. No `check_access` Helper

**Search result:** No `check_access`, `access_check`, or similar helper exists yet.  
**Status:** Permission checking is ad-hoc; PR 5/5 must introduce a centralized helper.

#### 4. Multi-user EPERM (PR #326, already landed)

**Location:** `sys_kill` (line 3106+), `sys_sched_getparam` / `sys_sched_setparam` (lines ~7930+)

**Checks:**
- `can_signal(proc.euid, target_proc.uid, target_proc.euid)` for `kill` (enforces POSIX signal-send rule).
- `can_query_sched(proc.euid, target_proc.uid, target_proc.euid)` for sched syscalls (stricter: euid-only match).
- Both return EPERM if the check fails; otherwise, the operation proceeds.

**File locations for helper functions:**
- `can_signal`: lines 7905–7914
- `can_query_sched`: lines 7908–7921
- `sys_kill` call site: line 3106 (local process) and line 3112 (remote — checks are in host, not kernel)
- `sched_*` call sites: search for `can_query_sched` usage around line 7930+

#### 5. Setpgid EPERM Checks

**Location:** `sys_setpgid` (search in syscalls.rs)

**Checks:** POSIX requires setpgid to fail with EPERM if:
- Caller is not in the same session as target, OR
- Caller is trying to move target to a different session

These checks exist but are not permission-file-related.

### Summary Table

| Check | Syscalls | Rule | Type | PR5 Impact |
|-------|----------|------|------|-----------|
| Procfs write deny | `access`, `faccessat` | W_OK → EACCES | Hardcoded | Keep as-is; may refactor into `check_access` |
| Multi-user kill/sched | `kill`, `sched_*` | euid vs uid matching | Helper-based (PR #326) | Model for credential checks in file ops |
| Sticky bit | None yet | Directory unlink/rename | N/A | **TODO in Task 5.5** |
| File permission bits | None yet | rwx check against st_mode | N/A | **TODO in Task 5.3** |

---

## E. WasmStat.st_mode semantics

**File:** `crates/shared/src/lib.rs`

### Structure (lines 712–727)

```rust
pub struct WasmStat {
    pub st_dev: u64,
    pub st_ino: u64,
    pub st_mode: u32,     // ← permission + file-type bits
    pub st_nlink: u32,
    pub st_uid: u32,
    pub st_gid: u32,
    // ... timestamps, size, etc.
}
```

### Mode Constants Defined

**File type bits (lines 628–635):**
- `S_IFMT` = 0o170000 (mask)
- `S_IFSOCK` = 0o140000
- `S_IFLNK` = 0o120000
- `S_IFREG` = 0o100000 (regular file)
- `S_IFBLK` = 0o060000
- `S_IFDIR` = 0o040000 (directory)
- `S_IFCHR` = 0o020000
- `S_IFIFO` = 0o010000

**Permission bits (lines 639–653):**
- `S_IRUSR` = 0o400, `S_IWUSR` = 0o200, `S_IXUSR` = 0o100 (user rwx)
- `S_IRGRP` = 0o040, `S_IWGRP` = 0o020, `S_IXGRP` = 0o010 (group rwx)
- `S_IROTH` = 0o004, `S_IWOTH` = 0o002, `S_IXOTH` = 0o001 (other rwx)

### MISSING: Special Permission Bits

**Not defined:**
- `S_ISUID` (0o4000) — set-user-ID-on-execution
- `S_ISGID` (0o2000) — set-group-ID-on-execution
- `S_ISVTX` (0o1000) — sticky bit

**Status:** These constants are **not present**. PR 5/5 must add them.

### Implications

- `st_mode` currently can represent any combination of file type + rwx permission bits.
- Special bits (setuid, setgid, sticky) are not exposed to the kernel, so they cannot be:
  - Applied on file creation (Task 5.8: umask)
  - Checked during exec (Task 5.7: setuid-on-exec)
  - Checked during unlink/rename (Task 5.5: sticky-bit in directories)

**Action for PR 5/5:**
1. Define `S_ISUID`, `S_ISGID`, `S_ISVTX` in `crates/shared/src/lib.rs`.
2. Ensure host's `stat`/`lstat` preserves these bits in `st_mode`.
3. Use them in permission checks.

---

## F. Mount infrastructure (readonly)

**Files:**
- `host/src/vfs/types.ts` — `MountConfig` interface
- `host/src/vfs/vfs.ts` — `VirtualPlatformIO` implementation

### MountConfig Interface (lines 48–52)

```typescript
export interface MountConfig {
  mountPoint: string;
  backend: FileSystemBackend;
  readonly?: boolean;  // ← defined
}
```

**Status:** `readonly` field exists and is optional.

### Current Enforcement (VirtualPlatformIO)

**File:** `host/src/vfs/vfs.ts`

**Search result:** `readonly` field is **defined in MountConfig but NOT checked during write operations**.

**Example:** `open()` method (lines 87–93):
```typescript
open(path: string, flags: number, mode: number): number {
    const { backend, relativePath } = this.resolve(path);
    const localHandle = backend.open(relativePath, flags, mode);
    // ↑ No check: if MountConfig.readonly=true, this should return EROFS
    const globalHandle = this.nextFileHandle++;
    this.fileHandles.set(globalHandle, { backend, localHandle });
    return globalHandle;
}
```

**Status:** The `readonly` flag is **advisory only** — not enforced by the kernel.

### Public Surface for PR 5/5

PR 5/5's Task 5.9 ("Enforce MountConfig.readonly") must:
1. Store `readonly` per-mount in `VirtualPlatformIO` (currently discarded).
2. Check `readonly` before `write`, `open(O_WRONLY/O_RDWR)`, `unlink`, `rename`, `mkdir`, `rmdir`, `chmod`, `chown`, etc.
3. Return `EROFS` (Read-only file system) on violations.
4. Wire `EROFS` error from the host down to the kernel.

---

## G. CA-cert injection (Task 4.4 flag)

**File:** `examples/browser/lib/kernel-worker-entry.ts:305–318`

### Current Implementation

```typescript
// Install the MITM CA certificate in the VFS so OpenSSL trusts it.
const caCertPem = tlsBackend.getCACertPEM();
try {
  // Demo images don't always include /etc — create the full chain.
  for (const dir of ["/etc", "/etc/ssl", "/etc/ssl/certs"]) {
    try { memfs.mkdir(dir, 0o755); } catch { /* exists */ }
  }
  const certBytes = new TextEncoder().encode(caCertPem);
  const certFd = memfs.open("/etc/ssl/certs/ca-certificates.crt", 0o1101, 0o644);
  memfs.write(certFd, certBytes, 0, certBytes.length);
  memfs.close(certFd);
} catch (e) {
  console.error("[kernel-worker] Failed to write CA cert to VFS:", e);
}
```

### When It Runs

- **Phase:** Kernel worker initialization, **before** the first program launches.
- **Entry point:** `kernel-worker-entry.ts`, called once on worker startup.
- **VFS backend used:** `memfs` (the in-memory filesystem powering `/etc` and other root directories in browser examples).

### What It Writes

- **Target:** `/etc/ssl/certs/ca-certificates.crt`
- **Source:** MITM CA certificate PEM from `tlsBackend.getCACertPEM()`
- **Mode:** 0o644 (readable by all, writable by owner)
- **Operations:** `mkdir` for `/etc`, `/etc/ssl`, `/etc/ssl/certs`; then `open`, `write`, `close` the cert file.

### Why It Works Today

**Current state:** `MemoryFileSystem.fromImage()` returns a **mutable in-memory copy** of the image. Each process/kernel worker gets its own heap-allocated instance, so mutations are safe (they don't affect other processes or the original image).

### PR 5/5 Problem

When Task 5.9 wires `readonly: true` enforcement on mounts, the CA-cert injection code will hit `EROFS` on the `memfs.write()` call if the root mount is marked as `readonly`.

### Recommended Resolution

**Option A (preferred):** Create a separate `/etc/ssl/certs` mount with `readonly: false`.
- Layers a read-write mount over a read-only root.
- Follows POSIX practice (certificate bundles are often on separate partitions).
- Clean separation: root stays read-only, certs stay writable during initialization.

**Option B:** Pre-bake certificates into the rootfs image.
- Move CA cert injection earlier, to image-build time.
- Avoids runtime filesystem mutations.
- Less flexible if cert bundles change between kernel versions.

**Option C:** Exempt the kernel worker initialization from readonly checks.
- Add a flag to VirtualPlatformIO: `allowInitialMutation` or similar.
- Not recommended: violates the readonly contract and complicates test isolation.

**Action for Task 5.9:** Coordinate with browser example initialization. Most likely outcome: Option A (separate rw mount for `/etc/ssl/certs`).

---

## H. Sticky-bit semantics

**Search:** No existing sticky-bit checks found in kernel.

### Constant Definition Status

**File:** `crates/shared/src/lib.rs`

- `S_ISVTX` (0o1000) is **not defined**.
- Must be added alongside `S_ISUID` and `S_ISGID` (see Section E).

### POSIX Rule

A file in a directory with the sticky bit set (`S_ISVTX` in `st_mode`) can only be deleted or renamed by:
1. The file's owner, OR
2. The directory's owner, OR
3. root (euid=0).

**Typical use:** `/tmp` has mode 1777 (rwxrwxrwx + sticky bit) so users can create files but not delete others' files.

### Current Status

- No checks for sticky bit in `sys_unlink`, `sys_rename`, or `sys_rmdir`.
- These syscalls currently succeed regardless of sticky bit.

### Action for PR 5/5

Task 5.5 must:
1. Define `S_ISVTX = 0o1000`.
2. In `check_access` helper, add a sticky-bit check for unlink/rename:
   - Get the directory's `st_mode` and `st_uid`.
   - If `st_mode & S_ISVTX != 0`, check caller's euid against file owner uid and directory owner uid.
   - Return `EACCES` if the check fails.

---

## I. compromising-xfails.md remaining gaps

**File:** `docs/compromising-xfails.md`

### Target 4: Multi-user permission model (EPERM) — PARTIALLY CLOSED

**Status (as of this audit):**
- **Closed:** `kill/2-2`, `kill/3-1`, `sched_getparam/6-1`, `sched_getscheduler/7-1` (PR #326, commit b9d19f771).
- **Still open:** File-system-specific EPERM and EACCES checks for permission bits, setuid/setgid on exec, umask, sticky bits.

**Current section (lines 87–100):**
```markdown
### 4. Multi-user permission model (EPERM)

**Gap:** No uid/gid access-control model. Every process runs as the same effective user. ...

**Status:** basic `setuid` / `setgid` EPERM checks landed in PR #326; file-permission checks remain.
```

### File-Permission-Related Remaining XFAILs

Likely candidates (to be confirmed when running full test suites):
- Tests that rely on file permissions (mode bits) blocking access.
- Tests that rely on setuid-on-exec behavior.
- Tests that rely on umask being applied at file creation.
- Tests that rely on sticky-bit semantics.

**Known:** The xfails file does not yet document these as separate entries because they are filesystem-permission concerns, not process-operation concerns.

### Action for PR 5/5

1. After Tasks 5.3–5.9 are implemented, re-run `scripts/run-libc-tests.sh` / `scripts/run-posix-tests.sh` / `scripts/run-sortix-tests.sh --all`.
2. Collect any newly-passing permission-related tests.
3. Update Task 5.11 to remove those from `compromising-xfails.md` or create a sub-entry documenting the file-permission gap closure.

---

## J. Test harness — setting proc credentials

**File:** `host/test/centralized-test-helper.ts`

### Current RunProgramOptions (lines 70–91)

```typescript
export interface RunProgramOptions {
  programPath: string;
  env?: string[];
  argv?: string[];
  timeout?: number;
  io?: PlatformIO;
  execPrograms?: Map<string, string>;
  stdin?: string;
  stdinBytes?: Uint8Array;
  onStarted?: (kernelProxy: KernelStdinProxy, pid: number) => void | Promise<void>;
}
```

### Missing: Credential Fields

**Not present:**
- `uid`, `euid`, `gid`, `egid` — no way to specify process credentials at startup.

**Current behavior:** `runCentralizedProgram` spawns processes with default credentials (uid=0, euid=0, gid=0, egid=0, umask=0o022).

### Why This Matters for PR 5/5

To test permission denial (EACCES, EPERM), tests need to spawn processes with **non-root credentials**. Without a harness extension, all tests run as root and can access/modify any file.

**Example test case needed:**
```typescript
// Run a program as uid=1000 (non-root) to test permission denial
const result = await runCentralizedProgram({
  programPath: "program.wasm",
  uid: 1000,         // ← NOT CURRENTLY SUPPORTED
  euid: 1000,        // ← NOT CURRENTLY SUPPORTED
  gid: 1000,
  egid: 1000,
});
// Expect: EACCES on file reads/writes that require root
```

### Recommended Harness Extension

1. **Add fields to `RunProgramOptions`:**
   ```typescript
   uid?: number;      // default 0
   euid?: number;     // default 0
   gid?: number;      // default 0
   egid?: number;     // default 0
   umask?: number;    // default 0o022
   ```

2. **Wire them into `CentralizedKernelWorker` process initialization:**
   - When the process is first created (`create_process`), check if credentials are overridden.
   - If so, directly set `proc.uid`, `proc.euid`, etc. before the program starts.
   - Alternatively: introduce a new syscall (e.g., `SYS_TEST_SET_CREDENTIALS`) that only works in test mode.

3. **Test mode flag (optional):**
   - Add a global `#[cfg(test)]` flag or a kernel runtime mode to enable the test syscall.
   - Prevents accidental exposure in production builds.

### Estimated Effort

- **Minimal:** Add `uid`/`euid`/`gid`/`egid`/`umask` to options interface; pass them to `create_process` or a post-creation hook. ~50 LoC.
- **Proper:** Introduce a kernel test-mode syscall (`SYS_TEST_SET_CREDENTIALS`) that works only in `#[cfg(test)]` builds. ~100 LoC.

---

## Recommendations for PR 5/5 design

### What's Already Done

1. **Credential tracking:** uid, euid, gid, egid, umask all stored in Process struct.
2. **Syscall wiring:** getuid, setuid, getgid, setgid, umask, chmod, access all wired (no new syscalls needed).
3. **Multi-user EPERM foundation (PR #326):** can_signal(), can_query_sched() helpers; EPERM checks on kill/sched_*.
4. **Procfs write denial:** Already returns EACCES on W_OK checks.
5. **Mount config:** readonly field exists (not enforced).

### What Needs the Runtime Toggle (Task 5.2)

PR 5/5 should introduce a **feature flag** `enforce_permissions` (default: false) to gate all new permission checks:

```rust
// crates/kernel/src/lib.rs or a new crates/kernel/src/config.rs
pub fn enforce_permissions() -> bool {
    #[cfg(feature = "enforce_permissions")]
    true
    #[cfg(not(feature = "enforce_permissions"))]
    false
}
```

**Why?** Permission enforcement will break existing tests that assume root privileges. The toggle allows:
- Task 5.2–5.9: Implement checks behind the flag (tests stay passing).
- Task 5.10: Flip the flag to true and triage failures.
- Task 5.11: Close the loop with documentation updates and xfail removals.

**Cargo.toml:** Add `enforce_permissions` as an optional feature (default off in kernel crate, on in final integration).

### Minimum-Viable Scope vs Nice-to-Have

#### MVP (must have for PR 5/5):
1. **check_access helper** (Task 5.3): Core permission-bit check (rwx against st_mode, uid/gid matching).
2. **Wire into open/openat** (Task 5.4): `O_RDONLY`/`O_WRONLY`/`O_RDWR` vs file mode.
3. **Wire into modify ops** (Task 5.5): unlink, rename, mkdir, rmdir, chmod, chown.
4. **Pathwalk search permission** (Task 5.6): X_OK on directories during name resolution.
5. **Sticky-bit in unlink/rename** (Task 5.5 extension): Additional check in the modify-op suite.
6. **Enforce readonly mounts** (Task 5.9): EROFS on writes to readonly mounts.

#### Nice-to-have (can defer):
1. **setuid/setgid on exec** (Task 5.7): Copy setuid/setgid bits into euid/egid during execve.
   - Low priority: Most tests don't rely on this; it's a security feature.
   - Can land as a quick follow-up PR.
2. **Umask applied at file creation** (Task 5.8): Strip umask bits from mode at open/mkdir.
   - Low priority: Mostly cosmetic; affects file mode reporting but not access.
   - Can be deferred if time is tight.
3. **Supplementary groups** (future): getgroups/setgroups with actual lists.
   - Out of scope for PR 5/5; leave as future target.

#### Not in PR 5/5:
- Full POSIX ACL support (extended attributes, ACL syscalls).
- SELinux or apparmor-style contexts.
- Capability-based security model.

### CA-cert Resolution Recommendation

**Recommendation:** **Option A — separate `/etc/ssl/certs` mount.**

1. In browser examples, add a second mount:
   ```typescript
   new MountConfig({
     mountPoint: "/etc/ssl/certs",
     backend: memfs,          // separate writable copy
     readonly: false,         // explicitly not readonly
   })
   ```

2. Root `/` mount remains `readonly: false` for now (browser demos are trusted environments).
   - If hardening is needed later, can be flipped without touching cert injection.

3. Test harness (`centralized-test-helper`) can mock this:
   ```typescript
   const io = new VirtualPlatformIO([
     { mountPoint: "/", backend: rootMemfs, readonly: false },
     { mountPoint: "/etc/ssl/certs", backend: certMemfs, readonly: false },
   ]);
   ```

This approach:
- ✓ Isolates cert writes to a dedicated mount.
- ✓ Keeps root filesystem logic clean.
- ✓ Makes future readonly enforcement on `/` straightforward.
- ✓ Requires no changes to the CA-cert injection code.

### Test Harness Extension Needed

**Essential for Tasks 5.3–5.9:** Extend `RunProgramOptions` to accept `uid`, `euid`, `gid`, `egid`, `umask`.

```typescript
export interface RunProgramOptions {
  // existing fields
  programPath: string;
  env?: string[];
  argv?: string[];
  // ... others
  
  // NEW: Credential overrides
  uid?: number;
  euid?: number;
  gid?: number;
  egid?: number;
  umask?: number;
}
```

**Wire-up:** In `runOnMainThread()` and `runInWorkerThread()`, after process creation, call a new function:
```typescript
function applyProcessCredentials(proc: Process, opts: RunProgramOptions) {
  if (opts.uid !== undefined) proc.uid = opts.uid;
  if (opts.euid !== undefined) proc.euid = opts.euid;
  // ... etc
}
```

**Test example:**
```typescript
// Test: non-root process cannot read root-owned file
const result = await runCentralizedProgram({
  programPath: "cat-etc-shadow.wasm",
  uid: 1000, euid: 1000,  // non-root
  // Program will fail with EACCES when check_access rejects the read
});
expect(result.exitCode).toBe(13); // EACCES
```

---

## Summary: Ready-to-Implement Checklist

**Before Tasks 5.2 onward:**

- [ ] Define `S_ISUID`, `S_ISGID`, `S_ISVTX` in `crates/shared/src/lib.rs`.
- [ ] Ensure host's stat/lstat preserves these bits.
- [ ] Verify readonly flag in VirtualPlatformIO is accessible during write operations.

**For Task 5.2 (runtime toggle):**
- [ ] Add `enforce_permissions` feature flag (default off).
- [ ] Wrap all new checks in `if enforce_permissions() { ... }`.

**For Task 5.3 (check_access helper):**
- [ ] Create `pub fn check_access(proc: &Process, stat: &WasmStat, mode: AccessMode) -> Result<(), Errno>`.
- [ ] Implement POSIX rwx logic: check owner, group, other bits against caller's euid/gid.
- [ ] Add tests (unit + integration).

**For Tasks 5.4–5.9:**
- [ ] Extend test harness `RunProgramOptions` with uid/euid/gid/egid/umask fields.
- [ ] Wire checks into syscalls.
- [ ] Run full test suite at each checkpoint.

**For Task 5.10:**
- [ ] Flip `enforce_permissions=true`.
- [ ] Triage failures; add runtime xfails if needed.

**For Task 5.11:**
- [ ] Update `compromising-xfails.md` to document file-permission gaps.
- [ ] Update `posix-status.md` with new PASS/XFAIL counts.
- [ ] Update `architecture.md` § 3.4 (Permission Model) with details.

**For CA-cert handling (Task 5.9 integration):**
- [ ] Decide: separate `/etc/ssl/certs` mount (Option A) or pre-bake (Option B).
- [ ] If Option A: add mount in browser examples.
- [ ] If Option B: move injection to build time.

---

**Audit complete.** This document provides the foundation for Task 5.2 onward.

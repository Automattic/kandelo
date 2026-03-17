# libc-test Failure Report

Generated: 2026-03-17

Run with: `scripts/run-libc-tests.sh --report`

| Status | Count |
|--------|-------|
| PASS | 175 |
| FAIL | 136 |
| BUILD | 0 |
| TIMEOUT | 14 |
| **TOTAL** | **325** |

**Pass rate: 54% overall (46/57 functional, 40/63 regression, 89/199 math, 0/6 timeout-prone)**

## Failure Analysis by Root Cause

### 1. Wasm FP exception flags not supported (110 math tests)

WebAssembly has no floating-point exception flag mechanism (`fenv.h`). All math tests that check `fetestexcept()` for INEXACT, INVALID, DIVBYZERO, UNDERFLOW, or OVERFLOW fail because Wasm traps or returns 0 for these flags. This is a **Wasm platform limitation**, not a musl or kernel bug.

The `long double` variants (which use software fp128) pass because they implement exception tracking in software.

**Affected:** All 110 failing `math/*` tests (acos, asinf, ceil, sin, sqrt, etc.) plus `math/fenv`

**Fix path:** Not fixable in kernel — would require a software fenv emulation layer in musl's Wasm port. Low priority since math results are correct; only exception flags are wrong.

### 2. No pthreads support (17 tests — 11 fail + 6 timeout)

`pthread_create` returns ENOSYS. Tests requiring real threads fail immediately or hang.

| Test | Category | Symptom |
|------|----------|---------|
| `pthread_cancel-points` | functional | `__syscall_cp_asm` unimplemented |
| `pthread_cancel` | functional | `__syscall_cp_asm` unimplemented |
| `pthread_cond` | functional | timeout (hangs on futex) |
| `pthread_mutex` | functional | timeout |
| `pthread_robust` | functional | timeout |
| `pthread_tsd` | functional | timeout |
| `sem_init` | functional | timeout |
| `sem_open` | functional | timeout |
| `tls_init` | functional | `pthread_create` fails |
| `pthread_cancel-sem_wait` | regression | `__syscall_cp_asm` unimplemented |
| `pthread_cond_wait-cancel_ignored` | regression | `__syscall_cp_asm` unimplemented |
| `pthread_cond-smasher` | regression | timeout on cond wait |
| `pthread_create-oom` | regression | timeout |
| `pthread_exit-cancel` | regression | `pthread_create` ENOSYS |
| `pthread_rwlock-ebusy` | regression | `pthread_create` ENOSYS |
| `pthread_once-deadlock` | regression | timeout |
| `pthread-robust-detach` | regression | timeout |

**Fix path:** Requires Wasm threading support (SharedArrayBuffer + Web Workers for threads within a single process). Significant effort.

### 3. No fork/vfork/spawn (5 tests)

| Test | Category | Symptom |
|------|----------|---------|
| `popen` | functional | `fork` returns ENOSYS |
| `spawn` | functional | `posix_spawnp` returns ENOSYS |
| `vfork` | functional | `vfork` returns ENOSYS |
| `daemon-failure` | regression | `fork` returns ENOSYS |
| `fflush-exit` | regression | `fork` returns ENOSYS |

**Fix path:** fork/exec is host-initiated via ProcessManager. These tests call fork() directly from userspace, which our kernel stubs as ENOSYS. Would need the kernel's fork syscall to create a new worker and instantiate a new Wasm module.

### 4. No SysV IPC (3 tests)

| Test | Category |
|------|----------|
| `ipc_msg` | functional |
| `ipc_sem` | functional |
| `ipc_shm` | functional |

**Fix path:** SysV IPC (msgget, semget, shmget) all return ENOSYS. Low priority — POSIX IPC would be more useful.

### 5. Socket test failures (1 test)

`functional/socket` — Tests AF_UNIX datagram sockets (bind/sendto/recvfrom). Our socket implementation only supports AF_INET TCP. AF_UNIX and UDP are not implemented.

**Fix path:** Implement AF_UNIX or at minimum UDP socket support.

### 6. Missing host import (2 tests)

| Test | Symptom |
|------|---------|
| `setjmp` | `CompileError: invalid value type 'exn'` — needs `--experimental-wasm-exnref` |
| `tls_get_new-dtv_dso` | `env.__main_void` unimplemented import |

**Fix path:** `setjmp` requires the Wasm exception handling proposal to be enabled in the host runtime. `tls_get_new-dtv_dso` needs dlopen support.

### 7. Incomplete syscall implementations (4 tests)

| Test | Category | Symptom |
|------|----------|---------|
| `execle-env` | regression | execle fails (ENOENT) |
| `sigaltstack` | regression | `sigaltstack` returns ENOSYS |
| `sigreturn` | regression | exit code 2 |
| `statvfs` | regression | f_bsize=0, blocks=0, inodes=0, namemax=0 |

**Fix path:**
- `statvfs`: Return realistic values from kernel (block size, inode count, etc.)
- `sigaltstack`: Implement signal alternate stack
- `execle-env`: Fix execve to handle environment passing
- `sigreturn`: Investigate signal return path

### 8. Kernel timing regression (1 test)

`regression/syscall-sign-extend` — `SYS_clock_gettime` vs `clock_gettime()` shows non-monotonic results (2ns difference).

**Fix path:** Ensure raw syscall and libc wrapper return consistent values.

### 9. OOM / resource exhaustion (3 timeouts)

| Test | Category |
|------|----------|
| `malloc-brk-fail` | regression |
| `malloc-oom` | regression |
| `setenv-oom` | regression |

These tests intentionally exhaust memory. In Wasm with a 1GB max memory, they may hang rather than fail cleanly.

### 10. Other timeouts (2)

| Test | Category | Likely cause |
|------|----------|-------------|
| `flockfile-list` | regression | Uses flockfile which may deadlock single-threaded |
| `tls_get_new-dtv` | regression | Needs dlopen + threads |

## Passing Tests (175)

<details>
<summary>Click to expand</summary>

### Functional (46/57)

argv, basename, clocale_mbfuncs, clock_gettime, crypt, dirname, env, fcntl, fdopen, fnmatch, fscanf, fwscanf, iconv_open, inet_pton, mbc, memstream, qsort, random, search_hsearch, search_insque, search_lsearch, search_tsearch, snprintf, sscanf, sscanf_long, stat, string, string_memcpy, string_memmem, string_memset, string_strchr, string_strcspn, string_strstr, strtod, strtod_long, strtod_simple, strtof, strtol, strtold, swprintf, tgmath, time, udiv, ungetc, wcstol, wcsstr

### Regression (40/63)

dn_expand-empty, dn_expand-ptr-0, fgets-eof, fpclassify-invalid-ld80, ftello-unflushed-append, getpwnam_r-crash, getpwnam_r-errno, iconv-roundtrips, inet_ntop-v4mapped, inet_pton-empty-last-field, iswspace-null, lrand48-signextend, malloc-0, mbsrtowcs-overflow, memmem-oob, memmem-oob-read, mkdtemp-failure, mkstemp-failure, printf-1e9-oob, printf-fmt-g-round, printf-fmt-g-zeros, printf-fmt-n, pthread_condattr_setclock, putenv-doublefree, regex-backref-0, regex-bracket-icase, regex-ere-backref, regex-escaped-high-byte, regex-negated-range, regexec-nosub, rewind-clear-error, rlimit-open-files, scanf-bytes-consumed, scanf-match-literal-eof, scanf-nullbyte-char, sigprocmask-internal, strverscmp, uselocale-0, wcsncpy-read-overflow, wcsstr-false-negative

### Math (89/199)

acoshl, acosl, asinhf, asinhl, asinl, atan2l, atanhl, atanl, cbrt, cbrtf, cbrtl, ceill, copysign, copysignf, copysignl, coshl, cosl, erf, erfcl, erff, erfl, exp10, exp10f, exp10l, exp2l, expl, expm1f, expm1l, fabs, fabsf, fabsl, fdiml, floorl, fmal, fmax, fmaxf, fmaxl, fmin, fminf, fminl, fmodl, fpclassify, frexp, frexpf, frexpl, hypotl, ilogbl, isless, j0f, j1, j1f, ldexpl, lgammal, lgammal_r, llrintl, llroundl, log10l, log1pl, log2l, logbl, logl, lrintl, lroundl, modf, modff, modfl, nearbyintl, nextafterl, nexttoward, nexttowardf, nexttowardl, pow10, pow10f, pow10l, powl, remainderl, remquol, rintl, roundl, scalblnl, scalbnl, sincosl, sinhl, sinl, sqrtl, tanhl, tanl, tgammal, truncl

</details>

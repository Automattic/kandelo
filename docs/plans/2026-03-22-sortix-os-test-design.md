# Sortix os-test Integration Design

## Overview

Integrate [Sortix os-test](https://gitlab.com/sortix/os-test) as a POSIX conformance test suite for Kandelo. The suite tests compliance with POSIX.1-2024 across ~4730 tests.

## Architecture

- **Submodule**: `os-test/` (ISC license, gitlab.com/sortix/os-test)
- **Runner**: `scripts/run-sortix-tests.sh` — discovers, compiles, and runs tests
- **Build output**: `os-test/build/` (gitignored)

## Suites

| Suite | Tests | Description | Pass Rate |
|-------|-------|-------------|-----------|
| include | 3741 | Header declaration type-correctness | 93% (3482 pass) |
| limits | 46 | POSIX limits.h constant values | 100% |
| basic | 933 | Function invocation smoke tests | 70% (657 pass) |
| malloc | 3 | Memory allocation edge cases | 100% |
| stdio | 7 | printf formatting tests | 100% |
| **Total** | **4730** | | **89% (4195 pass)** |

## XFAIL Categories (483 expected failures)

1. **POSIX.1-2024 additions** (~150): O_CLOFORK, posix_getdents, ALTMON, new math constants, clock-aware pthread waits, sig2str/str2sig — musl targets POSIX.1-2008
2. **Wasm limitations** (~50): dlopen/dlsym, setjmp, signal delivery, terminal I/O, process groups
3. **Not implemented** (~100): exec, posix_spawn, SysV IPC, scheduler, named semaphores
4. **Runtime failures** (~100): filesystem-dependent tests, socket operations, user/group database
5. **Headers not in musl** (~80): ndbm, libintl, devctl, nl_types, typed memory objects

## Additional Suites (not yet enabled)

| Suite | Tests | Requirement |
|-------|-------|-------------|
| io | 55 | Fork + file locking |
| signal | 32 | Signal delivery model |
| process | 24 | Fork + exec + waitpid |
| paths | 48 | Virtual device files (/dev/null, etc.) |

## Usage

```bash
scripts/run-sortix-tests.sh                    # Default suites (include limits basic malloc stdio)
scripts/run-sortix-tests.sh include            # Single suite
scripts/run-sortix-tests.sh basic stdio/printf # Specific test
scripts/run-sortix-tests.sh --all              # All suites including io/signal/process/paths
TEST_TIMEOUT=5 scripts/run-sortix-tests.sh     # Custom timeout
```

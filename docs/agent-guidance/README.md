# Agent Guidance Reference

These files contain detailed operating guidance for agents working in Kandelo.
`CLAUDE.md` is the loaded contract router; use it first, then read the focused
guide for the contract your change touches.

| Contract | Read when touching |
|---|---|
| `validation.md` | Test selection, evidence, completion claims |
| `debugging-and-posix.md` | Root-cause debugging, syscall/process/VFS/device behavior |
| `abi.md` | ABI surface, snapshot policy, package/VFS ABI consequences |
| `host-runtime.md` | Node/browser parity, worker protocols, host runtime failures |
| `packages-and-builds.md` | Package recipes, build scripts, resolver/cache behavior |
| `browser-and-user.md` | Browser demos, `KernelHost`, sharing, VFS image metadata |
| `performance.md` | Benchmark claims, performance evidence, hot-path restrictions |
| `build-docs-and-prs.md` | Dev shell, build commands, documentation, PR/final report scope |

Keep `CLAUDE.md` concise. Put detailed, contract-specific operating rules here
unless an invariant must be visible to every agent on every turn.

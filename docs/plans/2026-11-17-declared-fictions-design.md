# Declared fictions

Status: implemented for `mprotect` (this document records the design; the
reference is "Declared fictions" in
[package-management.md](../package-management.md#declared-fictions)).

## Problem

Some behaviour cannot be provided on WebAssembly. Page protection is the
current case: linear memory has no protection, so `mprotect()` cannot make a
page inaccessible or read-only. The truthful answer is an error (`ENOTSUP`),
and since #1746 libc gives no other answer. Some real software cannot run on
that answer. Ruby's fiber pool refuses to create a fiber if the stack guard
page cannot be protected. Qt's QML engine crashes when decommit fails.

Before #1746 every program got silent success. That was a fiction applied to
everything, invisible to the program, its packager, and its user. The goal is
the opposite: a fiction is named, reviewed, bounded, selected per package
with a reason, and visible in the built program and at run time.

## Model

A **fiction** is behaviour Kandelo reports as provided without providing it.
It is never the default. The truthful behaviour is what a program gets unless
its link selects the fiction.

### Registry

`sdk/fictions/<name>.toml`, one file per fiction, reviewed like code:

- `fakes`, `posix_difference`, `risks`: what is pretended, how that differs
  from POSIX, and what can go wrong.
- `allowed_intents` and `forbidden_intents`: what a declaration may use it
  for. A reviewer checks each declaration's reason against these.
- `truthful_subset`: what to use when no fiction is needed (for `mprotect`,
  `-lkandelo-mprotect` alone, which accepts requests that keep read and write
  access).
- `[config.<key>]`: the schema. `enum` keys choose a behaviour per request
  class; their first value is the truthful default. `size` keys with `limits`
  bound what an enum key accepts. A selection must depart from at least one
  enum default.

The SDK driver embeds the schema (it runs inside Kandelo too, without the
repository); a driver test keeps the copy equal to the registry.

### Selection

Two inputs, one syntax, `name:key=value,...`:

- `--kandelo-fiction=<selection>` on a driver invocation (by hand).
- `KANDELO_FICTIONS="<selection>;..."` in the environment.

A program package declares fictions in `package.toml`:

```toml
[[fictions]]
name = "mprotect"
reason = "cont.c fiber stack guard pages (one 64 KiB PROT_NONE page per fiber stack); GC compaction is compiled out"
config = { prot_none = "accept-unenforced", prot_none_max = 65536 }
```

The package build checks each declaration against the registry and sets
`KANDELO_FICTIONS` for the recipe, so every SDK link of that build gets it
without recipe edits, including links that libtool would strip unknown flags
from. Declarations are allowed only on `kind = "program"`: a fiction changes
what an executable link produces, and the program that links the code is the
one that answers for it. The declaration (not the reason) is part of the
package cache key.

Selections apply to executable links. Other invocations validate and ignore
them.

### Linking

For each selected fiction the driver generates a small C file into its glue
directory: a public definition (`mprotect`) that calls the one shared
implementation with a constant policy, plus the stamp. It is linked lazily
(`--start-lib`) ahead of crt1.o and the caller's inputs, and the support
library (`-lkandelo-mprotect`) is added after the caller's inputs. lld keeps
the first lazy definition of a symbol, so:

- a program that never refers to `mprotect` links nothing and carries no
  stamp;
- a program that does gets the declared policy, even if its own link line
  names `-lkandelo-mprotect` (whose member is the truthful definition);
- a program that defines its own `mprotect` keeps it.

### Implementation of the mprotect fiction

`libkandelo-mprotect.a` holds `__kandelo_mprotect_with_policy()` and the
truthful `mprotect()`. Requests are classified:

| Class | Requests | Default | Fiction |
|---|---|---|---|
| read/write | `PROT_READ\|PROT_WRITE`, with or without `PROT_EXEC` | allowed (to the kernel) | allowed |
| `prot_none` | no `PROT_READ` (`PROT_NONE`, write-only, exec-only) | `ENOTSUP` | `accept-unenforced`, optional `prot_none_max` |
| `read_only` | `PROT_READ` without `PROT_WRITE` | `ENOTSUP` | `accept-unenforced`, optional `read_only_max` |

Limits compare against the request length after page rounding. Unknown bits
are `EINVAL`. An accepted request still goes to the kernel, so the kernel's
own validation applies (with #1737, `EINVAL` for misalignment and `ENOMEM`
for unmapped pages).

### Provenance

- **Stamp.** The generated object carries a `kandelo.fictions` custom section
  holding its canonical selection line. wasm-ld concatenates the sections of
  linked objects, so a program records each fiction it actually links. The
  section survives clang's post-link wasm-opt, fork instrumentation and
  package installation (tested).
- **Package index.** `program-packages.json` reports each package's
  declarations (`name`, `reason`, `selection`).
- **Run time.** The kernel logs the first request of each process image that
  it reports as successful without enforcing (`ProtectionNotEnforced`,
  `LOG_WARNING`, `/dev/kmsg`). This is kernel-side because a guest cannot
  write the kernel log, and it is POSIX-neutral: the system log is
  diagnostics, not program-visible behaviour. It covers raw `SYS_mprotect`
  too. A host-side report of the stamp at exec was considered and left out:
  the kernel record already names the process, and the stamp is readable
  from the file.

## Review rules

- A declaration needs a reason that names the caller and what it protects,
  in terms of the registry's allowed intents. Reviewers reject forbidden
  intents (fault-driven algorithms, security boundaries).
- Prefer the truthful subset: a package whose callers only widen access
  links `-lkandelo-mprotect` and declares nothing. A package whose restrictive
  caller already has a truthful failure path declares nothing either: PHP's
  fiber stack guard makes `Fiber::start()` throw a catchable exception, which
  is better than the `makecontext()` abort it reached before.
- Bound the fiction: set the per-class maximum when the legitimate caller
  has a fixed size, and turn off the callers the fiction would corrupt (Ruby
  compiles out GC compaction, whose read barrier needs real protection and
  uses requests of the same size as fiber guards).
- Adding a fiction means adding a registry file, the driver schema and
  generator, and tests for every class and limit on wasm32 and wasm64.

## Future: ucontext

`-lkandelo-ucontext-unsupported` is today a library a recipe links by hand:
`getcontext()` reports failure and `makecontext()`/`swapcontext()` abort. It
fits the model as a fiction named `ucontext` whose generated definitions
choose, per function, between the truthful link failure and the stand-in
behaviour, with the same stamp and package declaration. Moving it means a
registry file, driver support, and replacing each recipe's `-l` flag with a
`[[fictions]]` declaration; that is left for a follow-up.

## Declarations made with this change

- **ruby**: `prot_none` accepted up to 65536 bytes (fiber stack guards);
  GC compaction compiled out. Fibers still fail today, after the stack is
  allocated: the Kandelo coroutine backend's `coroutine_transfer()` is
  `ENOSYS`. Without the fiction they would fail one step earlier with
  `ENOTSUP` from the guard. The declaration is kept so that fibers need no
  further change once the backend can switch; dropping it (and linking
  `-lkandelo-mprotect`) is the alternative if reviewers prefer no fiction
  until then.
- **quickshell**: `prot_none` accepted without a limit (QML V4 heap
  decommit, any size). The executable-memory probe stays `ENOTSUP`.
- **php**: no fiction; links `-lkandelo-mprotect`.
- **erlang**: nothing. The literal-area sealing (`erts_mem_guard`) runs only
  in `DEBUG` emulators and the JIT is disabled, so a release build has no
  live `mprotect` call.

## Not done

- Library packages cannot declare fictions; a library whose code needs one
  documents it, and each program that links it declares it.
- No fiction other than `mprotect` exists yet.

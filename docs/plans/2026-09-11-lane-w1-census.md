# Lane W1 — census of `web-libs/kandelo-session`

**Date: 2026-09-11. Status: complete.**

Lane W was scoped as "split the host contract from the browser product
surface, 5,360 lines, target 2,500". The split is real. **But the census
found a third population the lane did not anticipate, and one measured
defect inside it.**

## Three populations, not two

`kernel-host.ts` (2,776 of the 5,360 lines) holds:

**1. The host contract** — what a host implements. `KernelHost`,
`KernelLike`, `FileSystemLike`, `FramebufferRegistryLike`, `PtyHandle`,
`KmsDisplayHandle`, `AudioOutputHandle`, `LiveKernelHost`, `Snapshot`,
`ProcessEvent`, `MountInfo`, `VfsDirent`, `MemMapEntry`, `DmesgLine`.
This is the part a native host would want and cannot use today.

**2. Browser product surface** — `GalleryItem`, `GalleryQuery`,
`GalleryTab`, `DemoPresentation`, `BootDescriptor`, `BootCommand`,
`DescriptorMount`, `ShareMode`, `WebPreviewState`, `TerminalProgram`,
`TerminalSessionPolicy`, `shellPrompt`. **Stays**, and the
browser-and-user contract says descriptors are untrusted input whose
validation is a security boundary.

**3. Hand-written parsers of kernel-emitted formats** — the population the
lane missed. `parseMaps`, `parseMounts`, `parseProcEntry`,
`parseStatusBytes`, `parseRangeSize`, plus `formatMode`, `direntKind`,
`idToLabel`, `loadIdNameMaps`, `syscallNumberName`.

## Population 3 is the interesting finding

**The kernel writes `/proc` and a browser UI library parses it back with
hand-written regexes.** From the source:

```
// Each line: "00400000-005c2000 r-xp 00000000 fe:00 14222 /bin/bash"
// /proc/mounts format: source target fs opts dump pass
const m = /(\d+)\s*kB/.exec(raw);
```

That is kernel-owned format knowledge, reimplemented in TypeScript, with
nothing binding the two together. The kernel can change what it writes to
`/proc/<pid>/maps`, `/proc/<pid>/status` or `/proc/mounts` and this parser
will silently produce wrong rows rather than fail. It is lane G's failure
mode — a format agreed by convention with no gate — in the UI layer.

## W-D1: a hand-maintained syscall table with a generated one available

`kernel-host.ts` carries `SYSCALL_NAMES_LOCAL`, and its comment states the
reason:

> The authoritative table lives in `host/src/kernel-worker.ts:SYSCALL_NAMES`.
> We duplicate the common subset here to keep `kandelo-session` from
> importing the heavyweight kernel-worker module (which transitively pulls
> in Node-only imports).

## CORRECTION (2026-09-12, during W2)

**This census's recommendation was wrong in one respect**, found while
implementing it. The census said the copy's stated blocker "does not
apply" because the generated table is a leaf module with no Node-only
imports, and concluded the fix was to import it.

The technical claim is true. **The architectural one is not.**
`kandelo-session` deliberately does not depend on `host/` **at all** — it
redefines host types structurally, with comments saying "so this file
doesn't depend on host/'s wire types" and "so kandelo-session doesn't
drag the concrete class into UI bundles". Importing
`host/src/generated/abi.ts` would have crossed a boundary the codebase
maintains on purpose, for one table.

The fix landed instead as a **third option the census did not consider**:
generate a small `SESSION_SYSCALL_NAMES` module into
`web-libs/kandelo-session/src/generated/` as well. `dump-abi` already
writes ten files; this is the eleventh. No `host/` dependency, no hand
maintenance, correct data.

**The lesson:** "the stated reason does not hold" is not the same as
"there is no reason". The census checked the reason given in the comment
and stopped there.

**Two things are wrong with that.**

First, `kernel-worker.ts:SYSCALL_NAMES` is not authoritative — it is
literally `export const SYSCALL_NAMES = ABI_SYSCALL_NAMES`, an alias of the
table generated from `crates/shared`. The real authority is generated, and
lives in `host/src/generated/abi.ts`, **a leaf module with no Node-only
imports**. The stated reason for the copy does not apply to the table that
should have been imported.

Second, the copy is measurably wrong:

| | Entries |
|---|---|
| Generated `ABI_SYSCALL_NAMES` | **233** |
| `SYSCALL_NAMES_LOCAL` | **137** |

- **96 syscalls are missing** from the copy. Each renders in the UI as
  `syscall_NNN` instead of a name.
- **2 names actively disagree**: number 129 is `statfs` in the copy and
  `statfs64` in the generated table; 130 is `fstatfs` versus `fstatfs64`.

The file's own comment predicted this — "a brand-new syscall would show up
as `syscall_NNN` until the name is added" — so the drift is documented,
accepted, and avoidable by importing a module that was already available.

**This is the cheapest fix found in any census so far**: delete the table,
import the generated one.

## The gate

`webLibsSessionTypeScript` (5,360 → 2,500) measured lines, which does not
capture either finding: the product surface stays, so the line count
mostly cannot move, and the syscall table is 137 lines out of 5,360.

**Replaced by two surfaces that measure the actual defects:**

- `sessionHandMaintainedSyscallNames` — entries in `SYSCALL_NAMES_LOCAL`.
  **Ceiling 137, target 0.**
- `sessionKernelFormatParsers` — hand-written parsers of kernel-emitted
  text formats in `web-libs`. **Ceiling 5, target 0.**

## Revised increments

- **W1 — this census.** Done.
- **W2 — delete `SYSCALL_NAMES_LOCAL`**, import `ABI_SYSCALL_NAMES`.
  Closes W-D1, and the stated blocker for the copy does not exist.
- **W3 — the kernel serves structured process/mount/map data** instead of
  the UI parsing `/proc` text. The kernel already has this data
  structured; it is serialising it to text and having TypeScript
  re-derive it.
- **W4 — separate the host contract from the product surface**, the
  original W1 deliverable, now better informed.
- **W5 — express the host contract where both hosts can consume it**,
  generated from Rust the way `generated/abi.ts` already is.
- **The product surface stays and is named as such.**

## Estimate

**4–8 agent-days, medium** — unchanged in total, but redistributed: W2 is
hours, W3 is most of the lane and is a kernel change rather than a
`web-libs` change.

## What this census did not establish

- **Whether the `/proc` parsers are actually wrong today.** They were read,
  not tested against live kernel output. The finding is that nothing binds
  them, not that they currently disagree.
- **Whether a native host wants `KernelHost` as it stands**, or whether the
  interface is shaped by browser assumptions. W4 has to answer that.
- **The other 2,584 lines of `kandelo-session`** outside `kernel-host.ts`
  were not classified.

# Lane S — deferral and handoff

**Status: DEFERRED by the maintainer, 2026-09-12. Nothing landed.**

> ## UPDATE 2026-09-12 — the thing this lane was waiting for now exists
>
> The deferral was *"I only want the problem fixed for the new Rust-based FS
> which is not completed yet."* The part of that filesystem this lane needs —
> **somewhere to record integrity for a deferred file** — is built and carried
> end to end. Lane S can now be designed against a real format instead of a
> promise. Written here so the next agent does not have to infer it from the
> lane V section.
>
> ### Where a digest goes
>
> `crates/runtime-core/src/sffs_deferred.rs` — the image's in-body `SDEF`
> section. Two places, both opaque to the kernel:
>
> * **A deferred FILE record** carries `payload`: the fetch description for one
>   file — URL, transport, and **digest**. This is where `sudo` and
>   `sudo-lite`'s integrity belongs, because they are URL-backed single files,
>   which is exactly the case this lane's defect is scoped to.
> * **A deferred ARCHIVE declaration** carries its own `payload`, added for the
>   same reason. Before it, a Rust-written image declared how long its archives
>   were and nothing else — silently dropping the digest this lane measured as
>   present on every archive group in all nine production images.
>
> The kernel **never parses either**. `sffs_deferred`'s doc states the contract:
> whoever fetches decides whether a URL may be fetched, validates the digest,
> and honours the activation mode; carrying the bytes authorises nothing. That
> is the same division this lane's own floor section argues for — *"the host
> performs the fetch because the network is its own; verification is not the
> host's"* — so nothing here contradicts it. The kernel is the courier, and the
> digest rides with the reference rather than beside it.
>
> ### What is verified end to end
>
> The payload survives the whole round trip: `load_image_inner` retains it from
> the image it loaded, and the export re-emits it under the NEW inode number it
> assigns. That mattered more than it sounds — a deferred file's identity could
> not be carried by inode number, because an export renumbers, which is why
> retention rather than reconstruction was the only available design.
>
> ### UPDATE 2026-09-13 — where today's integrity ACTUALLY lives, and why it bounds this lane
>
> Measured while designing the seal verifier. **The integrity that exists today
> is not in `SDEF`. It is in the image's host-side lazy JSON** — each lazy
> archive entry carries `activation.atomicGroup` with a cohort digest and a
> per-member descriptor digest, and `MemoryFileSystem.verifyImportedLazyAtomicGroupSeals`
> authenticates them. That section is the one `load_image` walks straight past,
> so **the Rust filesystem cannot see any of today's digests**.
>
> What this means for this lane, concretely:
>
> * **A Rust-side verification applies only to images the NEW producer wrote.**
>   The nine recipes repointed on 2026-09-13 emit `SDEF`; everything else still
>   emits lazy JSON. Verifying an existing shipped base in Rust would mean
>   reproducing JavaScript's `JSON.stringify` byte-for-byte — the cohort
>   identity is literally `JSON.stringify({schema:1,id,members:[…sorted]})` —
>   in a `no_std` crate, over member names that are archive paths.
> * **So "is a digest mandatory" has a prerequisite**: mandatory for which
>   images? A rule applied to `SDEF` producers today would exempt every image
>   still written through the TypeScript path, which is most of them.
> * **The maintainer has an open call that decides this**: whether derived
>   builds from existing JSON-sealed bases must still verify, or whether those
>   bases are rebuilt through the new producer.
>   `docs/agent-guidance/abi.md` argues for rebuilding — a stale artifact should
>   fail loudly rather than be shimmed — but it is a product call.
>
> **Nothing above changes where a digest GOES.** The payload is still the place,
> and the courier contract still holds. What it changes is the honest scope of
> any requirement this lane writes.

> ### Two things this lane still has to decide, and one it must know
>
> 1. **Whether a digest is MANDATORY.** Deliberately left open: an archive or
>    file with an empty descriptor is a representable state, and a test says so.
>    Making it required is this lane's call, not lane V's. The format will not
>    decide it by accident.
> 2. **Whether the setuid bit is honoured on unverified bytes**, which is the
>    other half of this lane's end state and is untouched.
> 3. **A mandatory rule is not satisfiable yet, and the reason is not this
>    lane's fault.** An image described by the older `KLZY` section yields an
>    EMPTY descriptor, because KLZY has no field for one. A derived build whose
>    base came from a KLZY image cannot re-emit what it never received. So the
>    requirement can be written now but only becomes enforceable once the
>    producers emit `SDEF` — lane V's V5 / lane Y's Y5. **This lane's policy
>    depends on that cutover rather than blocking it**, which is a better
>    position than the deferral left it in.
>
> ### What has NOT changed
>
> The defect is still unfixed and still real. `generate-rootfs-package-manifest.mjs`
> still emits no digest, and nothing yet refuses unverified setuid bytes.
> Everything below this box stands.

**The decision, in the maintainer's words:** *"I only want the problem fixed
for the new Rust-based FS which is not completed yet."*

This file is the handoff that deferral requires. It exists so the next person
does not re-derive what was already measured, and does not rebuild a fix in the
layer the campaign is deleting.

## The defect, restated

`images/rootfs/PACKAGES.toml` sets `default_install = "lazy"`. Three packages
are `mode = "4755", uid = 0` — setuid root. `login` opts out with
`install = "eager"`; **`sudo` and `sudo-lite` do not.**

`scripts/generate-rootfs-package-manifest.mjs` emits those two as
`<path> f 4755 0 0 lazy_url=… lazy_size=…`. **Mode preserved; URL and size the
only attributes; no digest anywhere.** `LazyFileEntry` in
`host/src/vfs/memory-fs.ts` carries no integrity field either — the lazy
*archive* and *tree* types do, and `assertLazyIntegrity` already exists to
check them.

So two setuid-root binaries are fetched at run time by URL with **length as the
only check**. Bytes of the same length from a substituting host, a poisoned
cache or a network position execute as root inside the guest. HTTPS is
transport security, not artifact integrity, and a third-party host is under no
obligation to use it.

## Why this was deferred rather than fixed

The fix was built, and it worked. It was **~46 code lines in
`host/src/vfs/memory-fs.ts`** — which is the 8,501-line TypeScript filesystem
lane V exists to delete, budgeted at `memoryFsTypeScript` with a target of 0.

Spending 46 lines to harden a file scheduled for deletion buys a real security
property for however long that file survives, and buys a second implementation
to throw away. The maintainer chose the Rust side. **That is a scheduling
decision, not a downgrade of the defect:** the defect is real, verified, and
still open.

**It is off the critical path in one specific sense and not in another.** The
bytes are served from the same origin as the page in every shipping
configuration today, so the substituting-host case is not currently reachable
without an attacker who already controls that origin. It becomes reachable the
moment a deferred file is served from a third-party host or a mirror — which
lazy references exist to permit.

## Measurements — do not re-derive these

All taken 2026-09-12 against the built corpus in
`local-binaries/source-only-v1/programs/wasm32/`.

**The nine production images, restored with the reference implementation
applied:**

| image | deferred files | with digest | set-ID deferred files |
|---|---|---|---|
| `rootfs.vfs` | 65 | 0 | 2 |
| `shell.vfs.zst` | 79 | 0 | 2 |
| `wordpress.vfs.zst` | 79 | 0 | 2 |
| `lamp.vfs.zst` | 79 | 0 | 2 |
| `nginx-php-vfs.vfs.zst` | 79 | 0 | 2 |
| `nginx-vfs.vfs.zst` | 79 | 0 | 2 |
| `node-vfs.vfs.zst` | 79 | 0 | 2 |
| `kandelo-sdk.vfs.zst` | 0 | 0 | 0 |
| `mariadb-test.vfs.zst` | 0 | 0 | 0 |

**9 of 9 restored; 0 refused.** That is lane C's lazy-identity property and the
reference implementation preserved it, because it *demotes* rather than
refuses (below).

The two set-ID deferred files are the same two in every image that has any:
`/usr/bin/sudo` and `/usr/bin/sudo-lite`, both `4755`. **The blast radius of
any fix that changes their handling is exactly those two paths**, and two of
the nine images are unaffected entirely.

## The design that was built and reverted

Kept here because the shape survives the language. The reference
implementation is not in git; it was 547 diff lines across eight files plus one
new 340-line test.

**Producer (host-independent, survives into the Rust world unchanged):**

1. `scripts/generate-rootfs-package-manifest.mjs` emits `lazy_sha256=<64 hex>`
   on both lazy branches. The `--resolved-output-map` branch already *has* the
   digest — `resolved.sha256`, validated against the reference — and simply
   was not writing it. The binaries-dir branch reads the artifact it is
   deferring and hashes it; `createHash` was already imported.
2. `tools/mkrootfs/src/manifest.ts` accepts `lazy_sha256=`, rejecting anything
   that is not 64 lowercase hex digits, and rejecting the field without
   `lazy_url=`. **Lowercase and exact length matter:** an uppercase or
   truncated digest compares unequal for bytes that are in fact correct, which
   reads as tampering and is not.

**Consumer (what the Rust filesystem has to own):**

3. The digest rides on the deferred-file record beside the URL and size,
   through registration, image save, image restore and export.
4. **Verification happens where the bytes land.** In the TypeScript version the
   right seam turned out to be `fetchLazyBytes`, which *already* asserts
   `details.integrity` on both its buffered and streamed branches for archives
   and trees, and already declines to retry an integrity failure. Passing
   `integrity` for a URL-backed file made verification structural rather than a
   second mechanism beside the first. **The Rust equivalent should look for the
   same property:** one verification point that a deferred fetch cannot reach
   the filesystem without passing.
5. **A refusal must not be `EAGAIN`.** The kernel parks and retries on it, so a
   file failing verification would hang its reader forever. The TypeScript path
   gets this right by construction — a rejected preparation becomes `EIO` in
   `guardSynchronousLazyAccess` — and it was pinned by a test that drives the
   real park-and-retry loop rather than awaiting the promise, because awaiting
   consumes the settled preparation and cannot observe what a retrying reader
   sees.
6. **Set-ID is not honoured on bytes nothing can check.** Two different
   answers, deliberately:
   - **At registration, refuse.** A producer describing a deferred setuid file
     holds the bytes it is describing and can hash them, so this is a defect in
     the producer, not an artifact inherited from elsewhere.
   - **At restore, demote** — strip `S_ISUID | S_ISGID` from the stub and leave
     everything else alone. Refusing would reject images that are otherwise
     entirely valid, including every image built before the digest existed, and
     "this image will not boot" is a far larger claim than the defect supports.
     The property owed is narrow: unverified bytes must not run with
     credentials the caller does not have. The file still fetches and still
     executes; `stat` reports the mode it really has.
   - Demotion must cover **every hard-linked name** of the inode: the bytes are
     the same bytes, so the credentials must be the same credentials.
   - In the TypeScript version `chmod` touches `ctime` only and never
     `INO_DATA_SEQUENCE`, so demotion did not disturb the inode identity the
     caller had just matched. **The Rust filesystem needs the same property or
     an explicit re-stat**, or the later materialisation will fail to find its
     own stub.

**Forbidding setuid + deferred is still not available** — production depends on
the combination.

## Two findings the next person needs

**1. The lane's own gate can be satisfied without verifying anything.**
`setuidLazyWithoutDigest` in `host/test/surface-budget.test.ts` greps the
emitter for `lazy_sha256=|lazy_digest=` and returns 0 if it finds either. So
**landing the producer half alone drives the gate to 0 and marks lane S
closed** while nothing on earth checks the digest — a recorded digest nobody
verifies is exactly hazard H-2, a guard that cannot fail. That is the specific
reason the producer half was not landed on its own during the pause.

Whoever picks this up should **re-point the gate at the consumer**, not the
emitter: measure that deferred bytes are verified, or that no set-ID deferred
file exists without a digest in the built images. The current measure is a
proxy for the fix rather than the fix.

**2. `assertLazyIntegrity` is a no-op when integrity is absent — latent, not
live.** Its first line is `if (expected === undefined) return;`, so a lazy
archive or tree registered without integrity has the *shape* of an integrity
check without having one.

**Measured across the nine production images 2026-09-12, and the archive path
is clean:**

| | archive groups | without integrity | members | set-ID members |
|---|---|---|---|---|
| `shell`, `wordpress`, `lamp`, `nginx-php`, `nginx` | 9 each | **0** | 7,467 each | **0** |
| `node-vfs` | 8 | **0** | 5,307 | **0** |
| `rootfs`, `kandelo-sdk`, `mariadb-test` | 0 | 0 | 0 | 0 |

So **every archive group in production carries a digest, and not one of the
7,467 members is set-ID.** The defect is confined to URL-backed deferred files,
exactly as the lane states — the archive path is not a second instance of it.

What remains is the shape: nothing *makes* a producer supply integrity, and a
future archive registered without it would skip verification silently rather
than refuse. **The Rust filesystem should require the digest rather than accept
its absence**, which costs nothing today precisely because every producer
already supplies one.

## What unblocks this

S2's blocker, verified rather than assumed:

- **The kernel already receives the bytes.** `host_fetch_deferred(kind, id,
  offset, dest)` hands a URL-backed deferred file's bytes to the kernel by
  inode. The seam exists.
- **The kernel cannot learn the expected digest.** The image's kernel-facing
  section is `KLZY`, and `crates/runtime-core/src/klzy.rs` says outright that
  integrity digests deliberately stay in the host-side JSON. Adding one means
  changing `VFS_IMAGE_KERNEL_LAZY_*` in `crates/shared/src/lib.rs` — ABI
  surface, requiring a snapshot regeneration — for a section **V5 retires
  anyway**.
- **SDEF is the intended home and is already shaped for it.**
  `crates/runtime-core/src/sffs_deferred.rs` exists, decodes and encodes, and
  its own header names *"fetch URL, transport, integrity digest, activation
  mode, atomic-group seal"* as the opaque payload the kernel carries but never
  inspects. **It has no production caller yet.** Giving it one is V5, which
  lane Y gates.

**So lane S resumes when SDEF has a production caller**, and its increments
then become: put the digest in the SDEF payload, verify in the kernel, and
demote set-ID in the Rust filesystem. The producer half above is a prerequisite
either way and can land with it.

## Acceptance evidence when it resumes

Unchanged in substance, with one addition forced by finding 1:

- a tampered byte stream **of the correct length** is refused — length already
  passes today, so nothing weaker demonstrates anything;
- the refusal is `EIO` and reaches a *retrying* reader as `EIO`;
- a set-ID deferred file with no digest does not execute set-ID;
- the nine production images still restore with **0 refused**;
- and the gate measures the verification, not the emission.

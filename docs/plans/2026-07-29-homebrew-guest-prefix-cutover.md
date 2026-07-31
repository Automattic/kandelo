# Homebrew Guest-Prefix Cutover

Date: 2026-07-29
Last reconciled: 2026-07-31

This plan moves Kandelo guest packages from the retired
`/home/linuxbrew/.linuxbrew` layout to a Kandelo-owned layout without
misrepresenting old bottle provenance or exposing a partially migrated tap.

Implementation update, 2026-07-30: #1144 landed the inactive target-layout
contract and made bottle inspection bind to its exact SHA-256. Campaign
derivation can therefore land while the retired prefix remains active.
Activating the target layout remains a later atomic cutover step.

## Accelerated Usable Cutover Checkpoint: 2026-07-31

This checkpoint separates the first usable in-guest Homebrew delivery
from the complete prefix and catalog migration. It changes ordering
only. The 64-Formula, 71-variant campaign below remains required for
the final `/opt/kandelo/homebrew` catalog and removal of every
retired-prefix path.

The immutable main-shell release is a green 38-Formula base. Its three
embedded Formulae and 35 independent lazy bottle trees have passed exact
Node.js and Chromium product validation. The usable cutover must reuse
those layers. An unfinished sibling Formula or the later full campaign
is not a reason to rebuild them.

The bottle delta for the first usable proof is Libyaml and Ruby:

1. Land the publisher authority on protected Kandelo `main`, read its
   exact SHA, and rotate the tap's reusable-workflow pin and
   `kandelo-ref` together to that SHA.
2. Publish Libyaml as a new public package namespace. Hold package
   creation, child upload, and version-index mutation under the same
   first-publication shared writer lock. The lock is repository-scoped
   and Formula-keyed. Do not let parallel first-publication and index
   jobs race one another.
3. Publish Ruby only after the exact Libyaml bottle is publicly readable
   and admitted as its dependency. Every other runtime-support input
   reuses its immutable bottle digest and truthful producer provenance.
4. Regenerate the runtime-support descriptor and shell package
   generation. Publish a bottle mirror that preserves every reused
   layer byte for byte, and close one immutable lifecycle release. The
   generated contracts must name the new Libyaml/Ruby identities and
   the reused 38-Formula base. They must not relabel old bytes as newly
   built.
5. Run PR #1147's Chromium product lifecycle. Install, link, execute,
   and remove core Bzip2. Then install independent-tap M4 and verify
   that its core-tap Dash dependency resolves and runs through normal
   Homebrew behavior. Preserve the peer exact-byte Node.js evidence as
   well.
6. Switch the shell only after the regenerated descriptor, generation,
   mirror, lifecycle release, and both host claims agree on the same
   bytes.

The pin order is part of the authority contract. A tap caller cannot
predict the final Kandelo merge SHA. Merge Kandelo first, read
protected `main`, rotate both exact tap pins, then merge and read the
resulting tap source before dispatch. The ordinary publisher rereads
protected Kandelo `main` immediately before every write and requires
exact equality. If it moved, stop and rebind; do not substitute ancestry
or a branch name.

This usable proof is not the end of the guest-prefix migration. The
complete campaign below must still publish or truthfully reuse all 71
variants, switch the guest to `/opt/kandelo/homebrew`, remove
retired-prefix source and bottle state, and finalize the complete tap.
It also does not retire the registry, finish service runtimes, complete
third-party tap operations, add manual-page support, or produce
bottle-declared VFS layers.

The temporary Ruby `posix_spawn` patch is explicitly transitional. A
separate Kandelo worktree owns the general vfork and process-memory
solution. Once that platform behavior is available, remove the patch,
rebuild pristine upstream Ruby, and rerun this lifecycle. Do not let
the accelerated proof turn the package workaround into the permanent
runtime contract.

The canonical guest contract is:

- prefix and repository: `/opt/kandelo/homebrew`;
- Cellar: `/opt/kandelo/homebrew/Cellar`;
- stable command: `/usr/bin/brew`;
- writable user state: the existing UID/GID 1000 account under
  `/home/user`; and
- no `linuxbrew` user, retired-prefix alias, or compatibility symlink.

Native Linux CI is a separate host-tool realm. It may use Linuxbrew's native
prefix when pouring official Linux host-tool bottles. Those paths must never
become target Formula inputs, target bottle paths, or VFS entries.

## Audited Inventory

The 2026-07-29 audit anonymously fetched and verified every public bottle
named by the current Formula sidecars. It checked each recorded byte count
and SHA-256, opened each TAR archive, and scanned every regular member across
chunk boundaries for the retired prefix.

The tap contains three different inventories:

1. `Kandelo/metadata.json` selects 52 ABI-42 Formulae and 58 variants.
2. `Kandelo/formula/*.json` contains 63 Formulae and 70 variants.
3. The 11 additional Formula sidecars contain 12 ABI-41 variants.

The additional ABI-41 Formulae are `dinit`, `erlang`, `libpng`, `libxml2`,
`patch`, `pax`, `python`, `sqlite` on both architectures, `tcl`, `texlive`,
and `what`.

The raw archive scan found 38 byte-clean variants and 32 variants containing
the retired prefix. ABI truth makes the cutover classification stricter:

- 34 selected ABI-42 variants may preserve their exact bytes through a
  provenance-preserving admission;
- 24 selected ABI-42 variants contain the retired prefix and must rebuild;
  and
- all 12 ABI-41 variants must rebuild for ABI 42, including four that happen
  to be byte-clean.

The campaign therefore has 34 reuse candidates and 36 required rebuilds.
The new `homebrew-bootstrap` bottle is additional, producing a final catalog
of 64 Formulae and 71 variants if no Formula changes concurrently.

Never relabel an ABI-41 archive as ABI 42. A content scan cannot prove ABI
compatibility.

## Reuse Candidates

The following selected ABI-42 variants were byte-clean in the dated audit.
The campaign manifest must rederive this set from exact selected metadata and
fresh public readback; this list is review evidence, not publication input.

```text
asa/wasm32
bc/wasm32
bzip2/wasm32
coreutils/wasm32
ctags/wasm32
dash/wasm32
ed/wasm32
fbdoom/wasm32
findutils/wasm32
gencat/wasm32
getconf/wasm32
grep/wasm32
gzip/wasm32
libcurl/wasm32
libcurl/wasm64
libcxx/wasm32
libcxx/wasm64
libzip/wasm32
lsof/wasm32
m4/wasm32
modeset/wasm32
musl-fts/wasm32
musl-fts/wasm64
ncompress/wasm32
netcat/wasm32
pcre2/wasm32
posix-utils-lite/wasm32
sed/wasm32
unzip/wasm32
xz/wasm32
zip/wasm32
zlib/wasm32
zlib/wasm64
zstd/wasm32
```

Reuse retains the exact archive digest, byte count, URL, build time, builder,
and original source provenance. `derive-reuse` binds the old selected record,
anonymous readback, inspection result, guest-layout digest, historical
Formula source, Formula/link sidecars, and provenance report. It produces a
content-addressed Formula/architecture handoff without changing `built_from`.

If that truthful handoff takes longer to finish than rebuilding the 34
variants, rebuilding is the approved fallback. The reusable set totals only
about 17.8 MiB compressed.

## Required Rebuilds

The required rebuild Formulae and architectures are:

```text
bash/wasm32
binutils/wasm32
curl/wasm32
curl/wasm64
diffutils/wasm32
dinit/wasm32
erlang/wasm32
file-formula/wasm32
gawk/wasm32
git/wasm32
icu/wasm32
less/wasm32
libiconv/wasm32
libmagic/wasm32
libpng/wasm32
libxml2/wasm32
make/wasm32
nano/wasm32
ncurses/wasm32
nethack/wasm32
openssl/wasm32
openssl/wasm64
patch/wasm32
pax/wasm32
perl/wasm32
procps/wasm32
python/wasm32
ruby/wasm32
sqlite/wasm32
sqlite/wasm64
tar/wasm32
tcl/wasm32
texlive/wasm32
vim/wasm32
wget/wasm32
what/wasm32
```

Destination package/rebuild identities must be proven absent before upload.
The campaign manifest derives the next permitted rebuild from selected
metadata and the reviewed Formula source; a hand-edited list is not
authority.

## Dependency-Ready Schedule

After reuse handoffs exist, the rebuild graph has three logical levels:

1. `binutils`, `diffutils`, `dinit`, `erlang`, `gawk`, `icu`, `libiconv`,
   `libmagic`, `libpng`, `make`, `ncurses`, `openssl`, `patch`, `pax`,
   `perl`, `procps`, `python`, `ruby`, `sqlite`, `tar`, `tcl`, and `what`;
2. `bash`, `curl`, `file-formula`, `less`, `libxml2`, `nano`, `nethack`,
   `texlive`, `vim`, and `wget`; and
3. `git`.

`homebrew-bootstrap` follows Git and Ruby. Its remaining build/test tools are
admitted reuse candidates.

The tap-owned bootstrap recipe is also a target-package input. Before that
entrant can build, replace the retired prefix in its Kandelo patch and
regenerate its exact Homebrew source revision, patch digest, patched-tree
identities, deterministic output identities, source lock, and recipe lock.
The campaign must reject a bootstrap recipe whose patch or lock still names a
retired guest prefix; native Linux publisher paths are not an exception for
target recipe bytes.

Do not impose three global barriers. Keep at most eight jobs active and start
each Formula as soon as its exact dependencies have candidate handoffs.
Prioritize Ncurses, OpenSSL, libmagic, libiconv, and libpng because they
unlock the most work. Tex Live has no downstream consumer in this graph and
must not block the smaller critical path.

Each publication task selects exactly one Formula and one architecture.
The serialized Formula index writer merges that successful child with a
compatible public sibling, so wasm32 can become usable before wasm64
without losing either architecture when wasm64 later succeeds.

## Independent Bottles And Atomic Activation

This is the complete `/opt/kandelo/homebrew` prefix-migration sequence.
The 2026-07-31 usable cutover above may ship first, but none of these
completion steps is removed.

1. Land the final publisher compatibility work.
2. Rebase the Kandelo layout and tap source-authority changes onto their
   exact protected default branches.
3. Generate one campaign manifest binding Kandelo SHA, tap source SHA, old
   metadata digest, layout digest, every old record, each disposition, and
   destination-absence evidence.
4. For each Formula/architecture, run the restricted publisher with tap
   finalization deferred. Each successful variant publishes and
   anonymously verifies its reserved GHCR child and version index
   independently, but it must not change tap Git state or activate a
   product VFS release.
5. Seal each verified variant result as an immutable, content-addressed
   handoff. Produce the 34 scan-admission handoffs, or rebuild those
   variants.
6. Build the 36 required variants with a dependency-ready queue. Feed
   downstream jobs only verified same-campaign dependency handoffs.
7. Build and bottle the patched Homebrew bootstrap after Git and Ruby.
8. Compose all 71 handoffs into one inert tap candidate.
9. Remove orphan Formula sidecars and unreferenced root-level live link
   and provenance records. Keep historical failure evidence under its
   explicit failure namespace.
10. Validate the complete candidate tap once.
11. Under one tap state lock, create and push one final tap commit.
12. Regenerate shell migration, runtime, artifact, and mirror locks from
    that exact tap commit.
13. Rebuild the mostly-lazy shell and every shell-derived image.
14. Prove the first-party and independent third-party `brew` lifecycle
    in Node.js and Chromium before rotating product indexes.

Public immutable child blobs may be uploaded before finalization because the
old tap does not select their reserved identities. Selected metadata must not
expose a mixture of old- and new-prefix records.

Plan correction, 2026-07-30: publication availability and product
activation are different transactions. A successful bottle variant is
indexable and reusable immediately. A Brew/VFS candidate can be composed
when that root's exact same-architecture dependency closure is complete.
Only the live tap prefix switch and each named product activation remain
atomic; an unrelated Formula failure must not strand a successful
bottle. Named activation still needs an immutable candidate locator,
resolver/VFS readback, and compare-and-swap pointer transaction.

The `defer-tap-finalization` publisher input is not a general operator
shortcut. Only the reviewed `prefix-campaign-bottles.yml` caller may use
it, for one Formula and one architecture at a time, in write and
forced-rebuild mode, with ordinary VFS acceptance disabled. The build,
upload, index readback, and bottle verification still run. The
`finalize-tap` and
`publish-vfs-release` jobs do not.

If tap main advances before final commit, discard the candidate composition,
rebind the exact new source SHA, and rerun validation. Do not three-way merge
a partial package catalog.

## Required Campaign Tooling

The ordinary publisher already provides secure build, upload, readback, and
multi-Formula finalization. The prefix campaign additionally requires:

- an exact manifest/checker deriving reuse, rebuild, and retirement;
- the Kandelo-owned `derive-reuse` handoff, which preserves original build
  provenance and rejects private or changed historical bytes;
- an inert, no-push candidate overlay for dependency waves;
- a sparse dependency-ready scheduler with a global eight-job bound;
- immutable, digest-bound handoff storage when work spans workflow runs;
- a reserved-rebuild override that does not mutate selected bottle blocks;
- whole-tap directory-closure validation;
- final pruning of unreferenced live sidecars;
- a tap retired-prefix source guard; and
- one bootstrap lock synchronizer for Kandelo and tap-owned evidence.

Actions cache is not publication authority. Cross-run campaign state belongs
in a content-addressed immutable release or registry object with verified
digest-bound retrieval.

### Exact Campaign Manifest

`scripts/homebrew-prefix-campaign.py` derives the first atomic campaign
manifest from four distinct clean Git snapshots:

- the exact Kandelo source, which owns the ABI, guest-layout contract, and
  reviewed source-only Formula classifications;
- the exact old selected tap, which owns old metadata, sidecars, Formula
  receipts, and immutable bottle provenance; and
- the exact candidate source tap, which owns the Formula and recipe sources
  from which destination identities and required builds will proceed; and
- the exact native Homebrew source, which resolves each candidate Formula's
  `pkg_version` through Homebrew's own JSON metadata implementation.

The split is deliberate. An old bottle's archived Formula receipt is checked
against the Formula at its exact historical `built_from.tap_commit`. The
candidate Formula identity is bound separately and is never substituted into
old provenance. Reuse requires those historical and candidate Formula
identities to match exactly outside canonical bottle metadata.

The fixed
`homebrew/guest-prefix-campaign-inputs.json` contract classifies every
candidate Formula that has no old sidecar. It admits ordinary `libyaml` from
its exact Formula source and `homebrew-bootstrap` from its stronger recipe-lock
contract, and explicitly defers the remaining service Formulae. The build-input
discriminator prevents bootstrap from bypassing its extra source validation or
an ordinary Formula from needing a fabricated bootstrap lock. Any unclassified
source-only Formula fails derivation.

Run `derive` with all four exact 40-character commits and the reviewed old
metadata and guest-layout SHA-256 values. The output must not already exist
and must be outside all four input worktrees. Run `check` with the same
inputs to repeat anonymous bottle reads, full canonical archive inspection,
and credential-free destination-absence probes before accepting the
manifest. Neither command publishes a package or changes a tap.

Both commands read committed Git archives rather than live worktree bytes
and recheck every input HEAD and cleanliness at completion. The manifest
also inventories every active candidate source file that still contains a
retired guest prefix. Every such occurrence must be regenerated or removed
during composition.

Before final tap publication, run `check-final-prefix` against the exact
candidate commit. It fails if a retired guest prefix remains in a Formula,
generated sidecar, example, VFS acceptance file, recipe, or other active
source. Historical failure/rollback evidence and the explicit negative test
that asserts the old prefix is absent are the only source exceptions.

Kandelo's guest installation is `/opt/kandelo/homebrew`, its Cellar is
`/opt/kandelo/homebrew/Cellar`, and its stable command is `/usr/bin/brew`.
`/home/linuxbrew/.linuxbrew` is historical migration input, not a supported
guest layout. No final guest path uses the name `linuxbrew`.

### Campaign Source And Checkout Identity

The campaign uses two tap commit identities for different claims:

- `source_tap_commit`, exposed as `tap_commit` in public bottle
  provenance, is the reviewed commit from the public tap's protected
  history.
- `tap_checkout_commit` is a deterministic, local-only Git commit for
  one build or verification job. Its tree contains the sealed target
  source and the exact dependency bottle blocks admitted by earlier
  campaign handoffs.

The prepared checkout commit is a descendant of the public source
commit. Both the executor and publisher derive its tree and commit
identity independently. The build must run from that exact clean
checkout, and handoff, dependency, and runtime evidence record both
identities. A job-supplied checkout SHA, dirty checkout, changed tree,
or raw/prepared identity swap fails validation.

The prepared commit is never pushed, tagged, or used as public package
provenance. Immutable campaign and Formula-handoff releases target the
public source commit. This keeps the reviewed public SHA truthful while
still giving each dependency wave one complete Formula checkout.

The campaign authority also binds this exact contract:

```text
homebrew/kandelo-guest-layout.json
```

It records the path and SHA-256 of the contract. The publisher verifies
those bytes in the admitted Kandelo checkout before selecting the target
layout, and the digest is carried through build, dependency-provenance,
handoff, and runtime validation. In campaign mode, only that digest
selects `/opt/kandelo/homebrew` and
`/opt/kandelo/homebrew/Cellar`. An absent digest selects the
still-active layout only for an ordinary publication; a campaign with a
missing, wrong, or changed digest fails.

### Deferred Formula Handoffs

Each Formula/architecture call may publish its immutable bottle child
and reserved GHCR version index because the old tap does not select the
new rebuild identity. After anonymous readback and runtime
verification, the executor seals the result under:

```text
homebrew-prefix-handoff-sha256-<handoff-sha256>
```

The handoff binds the campaign digest, Formula identity, architecture,
publications, dependency handoffs, public tap source, target source
tree, and guest-layout authority. A downstream Formula reconstructs its
dependency bottle blocks only from verified handoffs in its exact
same-architecture campaign closure.

No per-Formula run updates Formula bottle blocks, sidecars, aggregate
metadata, or tap `main`. A closed selection may nevertheless compose
those inert files in a digest-bound local candidate for Brew and
VFS consumers. That command validates the candidate but does not publish
or activate it. Named product activation must publish the exact bytes at
an immutable locator, verify consumer readback, and then update its
pointer atomically. After every migration handoff exists, the campaign
separately composes and validates one complete candidate and performs one
atomic final live-tap update.

### Campaign Mutation Authority

Ordinary bottle and immutable-release publication still requires the
exact commit currently named by `Automattic/kandelo`
`refs/heads/main`. The prefix campaign is a narrow exception for a
long-running, already sealed campaign. Its reviewed Kandelo source may
authorize a mutation only while that source remains an ancestor of
current protected `main`.

The campaign path selects this rule explicitly; ordinary callers cannot
select it. Immediately before every GHCR or immutable-release mutation,
the mutation primitive fetches protected `main` and proves the sealed
source is still in that history. A detached, descendant, diverged, or
force-pushed-away source fails closed. Immutable handoff release tags
apply the same rule to the target tap repository and continue to point
at the public tap source commit.

Current protected `main` therefore remains the live mutation authority.
The ancestor rule lets it approve the already reviewed campaign source
without pretending that a synthetic prepared checkout is public source.

### Bridge Follow-Ups Before Cutover

The campaign bridge is sufficient to publish and seal Formula handoffs,
but two checks must be completed before the worktree is considered
finished:

- derive the browser shell test's first expected `PATH` entry from the
  configured shell path or guest-layout contract instead of retaining a
  `/home/linuxbrew/.linuxbrew/bin` assertion; and
- strengthen the standalone campaign publisher `verify` command so it
  cross-binds Formula and dependency arrays, campaign tag and digest,
  guest-layout bytes, and prepared-checkout ancestry. Today `prepare`
  constructs and immediately verifies its own receipt, and no
  downstream publisher consumes that receipt, so this is not a current
  mutation boundary.

### Superseded Execution Checkpoint: 2026-07-30

The browser lazy-download proxy in Kandelo PR #1159 has exact Node.js,
Chromium, and repository CI evidence. Keep its reviewed head unchanged.
Its Prepare merge candidate will validate that head against the current
`main` immediately before merge.

PR #1156 contains the campaign derivation. PR #1160 contains the
execution and publication bridge and is stacked on #1156. Merge #1156
separately after its exact shell proof succeeds. It already has complete
repository CI and a successful merge gate, and its focused squash commit
keeps the campaign derivation reviewable.

After #1156 merges, progress #1159 through Prepare merge against that
new `main`. Do not merge anything else while the Prepare merge candidate
is running. After #1159 lands, transplant only #1160's bridge commits
onto the actual merged `main`, retarget #1160 to `main`, and run fresh
exact CI. Do not carry #1156's pre-squash commits into the restack.

The first public campaign canary is `what` for `wasm32`. Run it only
after the combined campaign series is on protected Kandelo `main`,
fresh exact-main package generations exist, and the campaign manifest
and tap activation record are immutable. Do not weaken the
protected-main authority to run a canary from an unmerged PR head.

Before that canary, update the tap controller to read the campaign
executor's `handoff.json` contract. The older controller expects the
ordinary publisher's `manifest.json` and would reject a valid campaign
after publication. The campaign canary must leave Formula metadata,
sidecars, and tap `main` unchanged; only immutable bottle and handoff
evidence may be published.

The native publisher currently verifies Homebrew's rolling signed API
feeds against a committed compatibility lock. Keep that exact check on
the cutover path: the 2026-07-30 drift changed executable post-install
contracts, not only timestamps. After cutover, replace the mutable
per-PR feed with an immutable, JWS-verified feed snapshot and run a
daily read-only drift canary. That preserves Homebrew authenticity while
preventing unrelated packaging PRs from failing when the live feed
changes.

After #1159 lands, rotate the three tap trust pins and run the existing
public Node.js and Chromium lifecycle proof. Then reparent the five
validated Pages deployment commits from #1147 onto the actual merged
`main`. Refresh #1147's proof references, run fresh exact-head CI, and
restore its `ready-to-ship` label only after those checks pass. Prefer
landing that user-visible deployment before #1160; rebase #1160 over
the deployment before its final CI.

## Completion Evidence

The cutover is complete only when all of the following are true:

- every Formula/architecture result is an immutable handoff bound to the exact
  campaign and guest-layout digests;
- public bottle provenance names the raw tap source, while build and
  runtime evidence also bind the deterministic prepared checkout;
- no selected or live tap record names the retired prefix;
- no guest Formula source hardcodes a Linuxbrew or duplicate Kandelo path;
- no selected bottle contains the retired prefix;
- every selected bottle is ABI 42 with truthful provenance;
- `/usr/bin/brew --prefix` reports `/opt/kandelo/homebrew`;
- `brew --repository` reports `/opt/kandelo/homebrew`;
- `brew --cellar` reports `/opt/kandelo/homebrew/Cellar`;
- first-party install, execute, upgrade/reinstall, and uninstall pass;
- an independent third-party tap install and execution pass;
- no `/home/linuxbrew` directory or alias is created;
- one validated, complete handoff set produces one atomic final tap
  commit;
- the mostly-lazy shell and shell-derived products use the final tap; and
- exact Node.js and Chromium product evidence is green.

# Homebrew Guest-Prefix Cutover

Date: 2026-07-29

This plan moves Kandelo guest packages from the retired
`/home/linuxbrew/.linuxbrew` layout to a Kandelo-owned layout without
misrepresenting old bottle provenance or exposing a partially migrated tap.

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

Reuse must retain the exact archive digest, byte count, URL, build time,
builder, and original source provenance. Separate admission evidence must
bind the old selected record, anonymous readback, inspector revision, guest
layout digest, scan result, canonical-prefix pour, and runtime result.

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

Do not impose three global barriers. Keep at most eight jobs active and start
each Formula as soon as its exact dependencies have candidate handoffs.
Prioritize Ncurses, OpenSSL, libmagic, libiconv, and libpng because they
unlock the most work. Tex Live has no downstream consumer in this graph and
must not block the smaller critical path.

Dual-architecture siblings remain one Formula-scoped publication task so
their bottle block and sibling policy stay coherent.

## Atomic Campaign

1. Land the final publisher compatibility work.
2. Rebase the Kandelo layout and tap source-authority changes onto their
   exact protected default branches.
3. Generate one campaign manifest binding Kandelo SHA, tap source SHA, old
   metadata digest, layout digest, every old record, each disposition, and
   destination-absence evidence.
4. Produce the 34 scan-admission handoffs, or rebuild those variants.
5. Build the 36 required variants with a dependency-ready queue. Feed
   downstream jobs only verified same-campaign dependency handoffs.
6. Build and bottle the patched Homebrew bootstrap after Git and Ruby.
7. Compose all 71 handoffs into one inert tap candidate.
8. Remove orphan Formula sidecars and unreferenced root-level live link and
   provenance records. Keep historical failure evidence under its explicit
   failure namespace.
9. Validate the complete candidate tap once.
10. Under one tap state lock, create and push one final tap commit.
11. Regenerate shell migration, runtime, artifact, and mirror locks from that
    exact tap commit.
12. Rebuild the mostly-lazy shell and every shell-derived image.
13. Prove the first-party and independent third-party `brew` lifecycle in
    Node.js and Chromium before rotating product indexes.

Public immutable child blobs may be uploaded before finalization because the
old tap does not select their reserved identities. Selected metadata must not
expose a mixture of old- and new-prefix records.

If tap main advances before final commit, discard the candidate composition,
rebind the exact new source SHA, and rerun validation. Do not three-way merge
a partial package catalog.

## Required Campaign Tooling

The ordinary publisher already provides secure build, upload, readback, and
multi-Formula finalization. The prefix campaign additionally requires:

- an exact manifest/checker deriving reuse, rebuild, and retirement;
- a reuse handoff that preserves original build provenance;
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

## Completion Evidence

The cutover is complete only when all of the following are true:

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
- the mostly-lazy shell and shell-derived products use the final tap; and
- exact Node.js and Chromium product evidence is green.

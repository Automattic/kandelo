# Shared private native string bytes

Source132 removes hash/HMAC/cipher string conversion through mutable public
Buffer allocation. Their unchanged pinned public wrappers pass original data
and encoding to actual native owners. Strings use the existing pinned native
ParseEncoding and owned bytes;nonstring BufferSource inputs immediately take
the existing native path without coercing ignored encoding arguments. Public
Buffer constructors,allocators,pool and codec behavior remain unchanged.

string-bytes.h is allocation-free and independent of OpenSSL/KeyMaterial. Five
exact pinned nbytes base64/hex sections plus reviewed ASCII/Latin1/UTF16LE byte
writes operate on supplied storage. The crypto owner allocates cleansing Bytes.
JWK retains its native import/export/material/realm behavior from130,forwarding
unchanged decoder primitives to this shared owner. Its canonical output encoder
is unchanged. Actual rooted-string UTF8,BufferSource and atomic-copy function
bodies remain byte-for-byte unchanged;this is not proof of their runtime edges.

A declared staging helper verifies version/commit,whole-file and selected
identities before staging. Native unity lifts/deduplicates includes. Its normal
canonical include alias rewrite is source-equivalent;an initial source-check
fixture incorrectly expected staged bytes to lack that rewrite. The failed log
and corrected exact-transform assertion are preserved;no runtime assertion or
product code was altered to hide it.

## Scoped evidence

Root31frontend groups pass:one new group executes96byte-authority comparisons,
plus30affected digest/cipher/key groups. The new durable fixture poisons public
allocators with throws/wrong bytes,forbids JS fromString access,checks ignored
encoding callbacks and shared/growable/resizable/detached inputs and odd hex.
Those are candidate adapters over actual native Node handles,not execution of
candidate native JSAPI/backing-store paths. Twelve package checks pass.

Private24,736portable bytes versus pinned Buffer/raw Hash/Hmac/CipherBase,
12,308affected JWK byte cases and226material cases passed. Root verifies exact
source/dependency/binary/corpus/output identities rather than claiming new runs.
The JWK input/reference/owner output identities equal sealed130. Eleven private
source/control commands and96private adapter cases are separate evidence,not
extra root runs. Root SDK Wasm object compilation also instantiates the new
portable codec without OpenSSL/ncrypto;complete native JSAPI remains uncompiled.
Five full references/five selected primitives,generation/bootstrap syntax,
642declared inputs and native unity/staging pass. No new engine patch is needed.

## Remaining boundaries and work

Combined117–132engine/JSAPI has not compiled successfully;accepted116stale,
failed127evidence preserved. Actual UTF8/BufferSource/RAB/SAB/concurrent snapshot,
encoding/error/GC/OOM/realm/provider behavior needs rebuilt four-host controls.
Existing sign/WebCrypto class/prototype consumer failures,cipher exceptions,
provider pressure,worker transfer and other crypto APIs remain incomplete.
The separate SDK recovery-AST fix has native component evidence but is not yet
in root because its toolchain/sysroot/dependency freshness impact is explicit.
The inherited engine Linux target/macro also remains portability debt.

No public API/family closure,platform/engine exclusion,performance claim,overall
suite,full product rebuild,merge of a PR or deployment occurred for this slice.
All19families remain partial. Main documentation was reconciled in131without
changing runtime sources or discarding unrelated dirty work.

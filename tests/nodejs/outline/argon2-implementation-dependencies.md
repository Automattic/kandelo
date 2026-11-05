# Argon2 source ownership and remaining dependencies

Current integration checkpoint: the normal targeted engine96 build compiles
the source through95 with guest OpenSSL3.5.9; four focused Node-host
differential controls pass. Current source99 includes metadata97, sync whole-file98 and queued
promise write/append99 owners; these remain guest-uncompiled. Changed kernel/host
and complete four-host conformance remain outstanding. Recipe-stage
compilation statements below describe their historical checkpoints. See
[the current build and evidence record](engine96-integration.md).

Source recipe92 adds the unchanged pinned public Argon2 module over actual
OpenSSL3.5.9 derivation. The exact Node26.13.0 target/source/reference pins
and frozen audit remain unchanged. This advances C-001/C-008/C-015 only in
scope; it does not complete those findings, crypto or the overall goal.

## Reused algorithms and native ownership

sources.json retains full lib/internal/crypto/argon2.js, crypto_argon2.cc/.h
and ncrypto.cc/.h inputs under upstream/kdf with exact pinned hashes.
build.py embeds the complete public JavaScript module unchanged. Its
algorithm selection, input conversion, parameter/length checks, getter order,
callback validation and Buffer result construction own public argon2 and
argon2Sync. Private WebCrypto functions in that same file are not wired as
public WebCrypto support; actual key/job owners remain missing.

kdf-platform-adapter.js supplies Argon2Job using the existing private KDF
bridge. Digest byte helpers and the captured validation/error owners are
shared. The native argon2Supported method reports actual OpenSSL compile
configuration; unavailable provider/FIPS operation fails during real native
derivation, independently of compile-time API availability. Constants match
the pinned ncrypto Argon2 type enum. No runtime identity or algorithm list
is fabricated to make tests select a different path.

kdf-operations.h ports the pinned ncrypto provider algorithm through native
OpenSSL KDF/context/parameter owners. It supplies actual password, salt,
secret, associated data, lanes, memory, passes and output length for Argon2d,
Argon2i and Argon2id. The default provider context is checked before creating
any private thread-pool context, preserving FIPS policy. Real OpenSSL thread
support controls worker parallelism; lanes remain algorithm inputs when
execution is serial. Output and input bytes use cleansed native storage.
Provider failure captures actual code/library/reason/error-stack fields
through the shared KDF error owner. PBKDF2/scrypt use that same owner.

native-kdf.cpp copies all four async byte inputs before resource init.
Sync jobs retain actual input objects across init hooks and copy their bytes
at run time, including secret and associatedData. Wide input-byte accounting
prevents four-input size sums wrapping wasm32 before allocation checks.
FsResourceKind::Argon2 and the actual Argon2Job engine class carry the pinned
ARGON2REQUEST provider identity. Engine patch0093 registers resource-info
inspection and actual compile capability; the normal shared work queue,
CPU work class, callback scope, cancellation suppression and resource/GC
retirement are reused. This is source ownership, not proof the guest bridge
compiles or behaves correctly.

The existing shared OpenSSL source recipe6 remains3.5.9, with its declared
threaded SDK configuration. This slice reused the retained native-only
control library; it neither built nor substituted a host library into a
guest resolver artifact. Last accepted guest engine88 still uses its older
dependency and does not contain source89–92.

## Evidence and limitations

Exact reports/artifact/source identities are in argon2-finding-progress.json.

| Evidence | Result | What it establishes |
|---|---|---|
| node26-argon2-frontend-r2.json | 4 new and7 affected controls pass;0 fail/skip | Selected generated public source over actual native Node jobs/hooks/ALS/bytes; byte forms, validation/getter order, callback resource/receiver/scope and four-input snapshot timing |
| node26-argon2-native-r2/report.json | 12 native comparisons pass | Actual portable OpenSSL owner output/error parity against exact native26 private jobs: variants, empty inputs, nondivisible memory/lanes, extended output, invalid native parameters/type, zero length and FIPS/default-context gating |
| node26-argon2-kdf-regression-r2/report.json | 20 comparisons pass | Existing actual portable PBKDF2/scrypt owner behavior after the shared config/error refactor |
| node26-argon2-upstream-r1/report.json | 3 unchanged files pass per mode | Public Argon2 plus affected PBKDF2/scrypt upstream assertions with actual native dependency owners; bodies verified against pinned archive |
| node26-argon2-source-r2/report.json | 6 source commands pass | Full pinned source/audit identities, generated bootstrap syntax, exact patch round trip, unchanged Mozilla source/style and evidence registration |

All report paths above are under .context. These evidence dimensions overlap;
they are not unique API counts, overall conformance results or guest/browser
tests. The frontend fixture deliberately supplies native Node job execution,
async resources and byte ownership. The portable helper executes the new
OpenSSL algorithm but not guest JSAPI, scheduler, pthread or kernel paths.
Native controls using private Argon2Job do not establish a public private-API
compatibility promise.

The initial portable native and affected-helper compilations failed on an
adapter pointer-type mismatch; the preimage/header/logs are retained under
node26-argon2-first-nonpass. The first frontend invocation ran only7 existing
KDF controls because registration was not yet updated after a wrong-cwd
registration command. Its result is retained as incomplete coverage, not an
Argon2 pass. The registered rerun includes all11 cases. No upstream assertion
or body was changed and no failed result was relabeled.

## Still open

* Guest OpenSSL3.5.9, engine92 and changed kernel compilation, exact guest
  JSAPI/memory/provider/thread/queue and four-host evidence. Native helpers
  do not compile the new engine request class or test worker shutdown.
* Complete GC/ref/cancellation/OOM/reentry/realm/worker lifetime, large or
  detached/resized/shared byte behavior, provider memory accounting and fatal
  callback policy. Source copies do not prove those lifetimes conform.
* KeyObject/CryptoKey, HKDF and full WebCrypto derivation/import/export/
  algorithm policy; the public raw-byte Argon2 API does not complete them.
* Remaining key/cipher/signature/exchange/KEM/certificate/FIPS/provider and
  other crypto obligations, plus all19 partial families. The retained
  SQLite load failure and process/metadata compilation debts remain open.

No new engine/platform exclusion is accepted. The full product rebuild and
overall suites remain deferred. Continue other independent audited source
owners before expanding a deep Argon2 test campaign.

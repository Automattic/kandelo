# Symmetric key generation owner

Public crypto.generateKey/generateKeySync consume complete unchanged Node26.13.0 keygen wrapper sections over actual SecretKeyGenJob/KEYGENREQUEST resources. HMAC uses whole-byte truncation; AES accepts its pinned lengths. Validation/getter/callback error chronology stays in pinned source. This does not implement asymmetric keypair or WebCrypto generation.

The owning native job uses packaged ncrypto::DataPointer::Alloc and CSPRNG, moves the real allocation into existing immutable KeyMaterial, and publishes actual KeyObjectHandle/SecretKeyObject brands. Async work uses the existing CPU work queue, captured root/frame/provider and callbackscope/retirement; canceled work suppresses callbacks. Sync jobs remain weak/GC owned like pinned CryptoJob. Actual allocation length is accounted as requested native storage, not RSS. No JS metadata key, synthetic entropy, host production delegation or completed-job facade.

Focused component evidence:16native/candidate semantic groups plus unchanged test-crypto-secret-keygen.js each subject. Portable generation header compiled over exact pinned native Node26.13.0/OpenSSL3.5.9 exports; V8/uv/InternalMakeCallback/frame and copied native KeyObject adoption are explicit control dependencies. That fixture copies generated storage into a native Node key handle; production instead moves original DataPointer ownership. Native component evidence does not compile or execute the guest JSAPI bridge or guest OpenSSL dependency/configuration.

Preserve original source/fixture failures and corrected publication/queue-policy review. Historical source232 left shared outer keyOperation packet publication and the MarkPop wrapper open. Source234 implements the bounded publication transaction below; runtime remains unvalidated. MarkPop policy, full AsyncWrap inherited surface, actual guest entropy/error/OOM/GC/realm/fatal/ref/shutdown behavior, provider/permissions and all4hosts remain open. Backend fault/allocator-injection controls were not run. No complete keygen/crypto/API-family or runtime conformance claim.

## Outer native packet publication prerequisite

Secret-job admission now registers the actual freshly allocated request with
an owning publication transaction before init hooks run. Its rooted exact
request/state survives creator realm wrapping and the outer key-operation
value/error packet allocation and property definitions. Commit occurs only
when that real packet has been placed in the native return value.

An unsuccessful transaction retires and clears only its still-preparing
request in that request's realm, without invoking JS or replacing the original
pending error. If init-hook reentry already submitted actual asynchronous
work, the queue retains its callback/frame/result ownership; failed outer
publication does not cancel or abandon that admitted work. Synchronously
executed weak jobs have no asynchronous queue ownership marker; an otherwise
unpublished, still-preparing resource may be retired on failure.

This is source ownership work, not allocation-failure or guest conformance
evidence. The existing outer OpenSSL MarkPop policy is unchanged and remains
a separate queue-semantics question. Complete AsyncWrap/GC/realm/Worker and
four-host execution still require identified-artifact validation.

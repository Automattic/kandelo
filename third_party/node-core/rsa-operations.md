# One-shot RSA transform owner

The public publicEncrypt/privateDecrypt/privateEncrypt/publicDecrypt wrappers
are unchanged pinned Node26.13.0 cipher.js functions. Their native bridge uses
actual imported KeyMaterial and ncrypto::Cipher encrypt/decrypt/sign/recover.
The latter sign/recover operations are the raw RSA cipher APIs, not the missing
public crypto.sign/verify signature API. The original cipher module source and
native reference section are verified by the existing source manifest checks.

The bridge retains the genuine material edge before conversion can reenter JS.
Input allocation/range is captured before padding's Uint32 conversion, and its
bytes are consumed afterwards. A callback may mutate the original data; an
early payload snapshot would be incorrect. Real allocation capabilities protect
storage across that boundary. Checked source/realm preparation finishes before
pointer use; actual shared bytes use atomic loads into cleansing native
scratch. The result owns its provider allocation until the engine copies it.

The target's private-decrypt PKCS1 implicit-rejection context admission precedes
OAEP digest, label and MGF1 processing. It queries the actual context; unsupported
providers fail with the pinned error, without an unsafe decrypt fallback or
fabricated support bit. Context allocation retains the target's fatal CHECK
policy. Ordinary crypto errors use the shared genuine Error owner.

Native tests compile the actual portable helper against the identified native
Node executable's ncrypto/OpenSSL. N-API acquisition, native key preprocessing,
DER material projection and stream owners are explicit component dependencies.
The unchanged upstream files execute with the candidate private Buffer owner
installed, as guest bootstrap would, and override only the four subject RSA
methods. Those dependencies do not implement the guest API. The guest bridge
has source/staging/style checks but no new guest compile or four-host runtime
conformance evidence.

STORE key loading remains an existing implementation gap, with truthful failure.
JWK/raw material reuse is source-integrated through existing key owners; their
exact guest getter, realm and lifetime behavior needs runtime validation.
Temporary C++ vector/control-block capacity and opaque provider allocations are
not newly covered by a complete memory ledger and are not claimed as RSS.
Complete signatures, key generation, exchange/KEM, WebCrypto and other crypto
requirements remain separate. Passing this slice does not close C-001/C-015.

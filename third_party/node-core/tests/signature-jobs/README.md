# One-shot native signature controls and callback-frame dependency

The portable crypto operation is genuine. Native key parsing/transport, V8 byte
leases, Node IDs/hooks/frame/promise state, libuv and OpenSSL are explicit control
dependencies. Guest JSAPI/queue/realm/fatal/worker/four-host conformance is separate.

The pinned target CryptoJob calls AsyncWrap::MakeCallback with its captured frame.
The original component used public C++ node::AsyncResource::MakeCallback. A
standalone no-Kandelo control on 26.13.0 shows that public path loses ALS state in
before/callback/after; the explicit-frame entry and actual crypto.sign retain it.
Pinned source traces AsyncResource's captured Scope into public MakeCallback,
which supplies undefined to InternalCallbackScope and replaces that frame. This
is an observed native route mismatch; no production runtime workaround or upstream
fault attribution is required to select the faithful CryptoJob control owner.

The corrected component captures the actual continuation frame immediately before
init, preserves real AsyncResource IDs/resource/destroy and invokes exact pinned
InternalMakeCallback. No bound callback, fabricated frame/ID metadata, skipped
hooks or assertion change. Only public V8/async_context types cross this private
entry; no Environment/private object layout is accessed. native-reference.json
and node-frame-reference.h pin its exact source declaration and executable SHA.
This private reference dependency is not introduced into production Kandelo.

The original 40 assertion groups remain byte-identical. frame-control.cjs adds
native comparisons of before/after context, init ambient mutation, callback frame
mutation/restoration, real IDs/trigger/receiver/resource and destruction. Invoke
it after run-controls.sh using the same SIGNATURE_COMPONENT and
SIGNATURE_JOBS_COMPONENT environment. No product setup or overall suite is needed.

native-frame-repro/ is standalone: copy that directory, supply the exact reference
Node binary/headers and compile with its run.sh. It imports no Kandelo code and
prints a self-judging REPRO-VERDICT. Public-vs-explicit-frame and crypto controls
are distinct reference observations, not guest compatibility passes. Original
39/40 results and setup/compiler failures remain retained as historical evidence.
No registry production workaround or upstream message is introduced here.

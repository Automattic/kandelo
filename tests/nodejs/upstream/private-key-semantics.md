# Private-key semantics for unchanged Node core JavaScript

Read-only source investigation. Node target is 26.13.0 / commit `18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`; Mozilla source is the retained patched 140.11.0 tree. No runtime probes, tests, builds, generation, tracked edits or Git mutations. No engine defect claim is made: these are different nonstandard embedding contracts, exposed when Kandelo supplies hidden keys to unchanged Node JS.

**A registry returning SpiderMonkey `js::NewPrivateName` is insufficient to implement Node/V8 internal Private symbols.** It gives useful hidden-key storage, but ordinary JS operations differ for inheritance, nonextensibility, proxy missing reads, deletion and descriptor attributes. Do not infer broad equivalence from the clone marker working on native objects.

Source abbreviations below:

- **N**: `.context/nodejs-lts-cache-v2/node-v26.13.0/`
- **SM**: `.context/node26-mozilla-style-source/tree/firefox-140.11.0/`
- **K**: repository source. Per-file hashes appear at the end.

## Distinct key kinds

Node `src/env_properties.h:17–42` declares per-isolate private symbols. `src/env.cc:504–514` constructs them with `v8::Private::New`; `src/node_util.cc:542–555` publishes the actual same identities through `util.privateSymbols`. Unchanged core uses ordinary bracket reads/writes, for example `lib/internal/buffer.js:1089–1105`.

V8 `deps/v8/src/api/api.cc:9517–9524` creates `Factory::NewPrivateSymbol()`. `src/heap/factory.cc:1268–1280` makes the important distinction: this is `PrivateSymbolKind::kInternal`; class `#private` field names use `kFieldName`. The private-kind accessors are in `src/objects/name-inl.h:41–68`. Missing internal private properties therefore return `undefined`; class field names can throw. These kinds must not be conflated.

SpiderMonkey `js/src/vm/Interpreter-inl.h:559–560` constructs **PrivateNameSymbol**, the key class used for language `#private` names. Existing K `packages/registry/spidermonkey/patches/0042-kandelo-node-clone-boundary.patch:28–64` creates such a name but sets the clone marker through native `DefineDataProperty` after checked unwrapping and an explicit **NativeObject-only** admission. This narrow storage path never proves arbitrary upstream bracket semantics.

## Operation comparison

| Operation | Node/V8 internal Private source behavior | SpiderMonkey NewPrivateName through ordinary operations | Disposition |
|---|---|---|---|
| Stable hidden identity | Per-isolate `Private::New` identity shared by JS/native bindings. | Fresh private-name primitive can be rooted and shared with native owners. | Useful building block; keep one native registry/identity, not per-adapter symbols. |
| `Reflect.ownKeys` / `Object.getOwnPropertySymbols` | `KeyAccumulator::AddKey` excludes any private kind for normal key collection. | Enumerator skips private names unless privileged `JSITER_PRIVATE` is requested; both public APIs omit that flag, including proxy key filtering. | Source paths align for normal enumeration. This is one contract, not overall equivalence. |
| Missing read on a plain native object | Own-only lookup; `kInternal` absence returns `undefined`. | Native own miss ultimately returns `undefined` if no prototype supplies it. | Superficially aligns only without inherited key/proxy branches. |
| Inherited private key | `LookupIterator::ComputeConfiguration` forces `OWN_SKIP_INTERCEPTOR`; private properties are explicitly non-inherited. | Ordinary NativeGetProperty/NativeSetProperty walk prototypes; their own lookup has no private-name short circuit. Inherited data/accessor state can be observed. | **Mismatch.** Must implement own-only semantics for embedding internal keys, without changing class-private rules. |
| First bracket write on nonextensible native object | `ExtendingNonExtensible` exempts private keys by default; `js_nonextensible_applies_to_private` defaults false. | Optimized assignment uses `DefineNonexistentProperty`, which rejects any nonextensible receiver without an `isPrivateName` exception. | **Mismatch for pinned default V8 configuration.** Native DefineProperty being permissive does not fix ordinary JS assignment. |
| Native define on nonextensible native object | `SetPrivate` uses its special native own-property route. | NativeDefineProperty explicitly permits `isPrivateName` on nonextensible objects. | Useful native initialization route; distinguish it from bracket write. |
| Freeze/seal existing key | Integrity checks and ordinary property collection exclude private keys; internal fields remain outside public frozen state. | PropMap freeze/seal preserves private-name flags and TestIntegrityLevel skips them. | Useful aligned behavior for existing keys. First write after freezing still has the assignment mismatch above. |
| Missing bracket read on a scripted Proxy | Private lookup bypasses proxy traps and examines the proxy’s own hidden dictionary; absent `kInternal` returns `undefined`. | ProxyGetOnExpando requires an existing expando and own field; missing either throws `GET_MISSING_PRIVATE`/related missing-private error. | **Mismatch.** Need internal-key missing-read behavior while preserving language private-field errors. |
| First bracket write on a scripted Proxy | AddDataProperty explicitly rejects internal private symbols with `kProxyPrivate`; native SetPrivate is the special initializer. | ProxySetOnExpando rejects a missing expando/field; native DefineProperty can initialize the expando. | Both reject first ordinary write, so rejection itself is **not** evidence of a mismatch. Error contract/descriptor/revocation detail remains unverified. |
| Read/update initialized scripted Proxy key | V8 lookup skips user traps and uses own hidden dictionary. | Base proxy handler uses its own expando without user get/set traps; an existing data entry can be read/updated. | Partial source alignment; do not extend it to missing reads, inherited behavior, deletion or all proxy types. |
| Delete internal key on Proxy | Native DeletePrivate uses ordinary runtime deletion with the private key; JSReceiver::DeleteProperty has a direct proxy-private dictionary path and returns true without user script. | Proxy::delete_ asserts `!id.isPrivateName()` because language private deletion is assumed syntactically impossible, then forwards to handler. | **Unsupported/incompatible path.** In release, forwarding could reach a user trap; never present this as safe equivalent deletion. |
| Descriptor of new ordinary bracket data field | V8 forces `DONT_ENUM` for all private additions. | AddDataProperty uses default configurable/enumerable/writable data flags even for PrivateName keys. Public enumeration still hides them by key kind. | **Descriptor mismatch** when holder/key are accessible internally; hidden enumeration does not imply nonenumerable descriptor equivalence. |
| Cross-compartment wrappers / other exotic proxies | V8 internal private lookup also bypasses access/interceptor paths; exact allowed exotic owners depend on native API/type. | Wrapper handlers override expando behavior to forward private fields to their target; policy/security checks precede access, and some handlers forbid private fields. | Separate ownership/security contract. Do not apply scripted-Proxy behavior or unchecked unwrap globally. |

## Exact traces

### Hidden enumeration

- N `deps/v8/src/objects/keys.cc:134–144`: normal key accumulation skips `is_any_private()`. The privileged `PRIVATE_NAMES_ONLY` branch specifically selects field-name/brand kinds, not all internal Private keys.
- SM `js/src/vm/Iteration.cpp:207–218`: no `JSITER_PRIVATE` means hidden private names are skipped even when symbols are requested.
- SM `js/src/builtin/Reflect.cpp:99–113`: Reflect.ownKeys flags are OWNONLY/HIDDEN/SYMBOLS, with no PRIVATE flag.
- SM `js/src/builtin/Object.cpp:2183–2196`: Object.getOwnPropertySymbols adds SYMBOLSONLY, still no PRIVATE flag.
- SM `js/src/vm/Iteration.cpp:438–466`: proxy-reported keys are passed through the same enumerator filter. `GetPropertyKeys` accepts privileged PRIVATE only from its explicit flags (`:726–734`).

### Own-only reads and missing values

- N `deps/v8/include/v8-object.h:427–436` documents non-inheritance; `deps/v8/src/objects/name.h:139–142` states any private kind can only name own properties.
- N `deps/v8/src/objects/lookup-inl.h:382–387`: `ComputeConfiguration` forces OWN_SKIP_INTERCEPTOR for all private keys.
- N `deps/v8/src/objects/lookup.cc:1330–1347`: private keys bypass ordinary Proxy/module-namespace/access-check/interceptor paths. This is actual special behavior, not hiding a public Symbol.
- N `deps/v8/src/objects/objects.cc:1363–1388`: missing class private field/brand throws, missing **internal Private** returns undefined.
- SM `js/src/vm/NativeObject.cpp:2239–2293`: ordinary native Get first checks own shape, then traverses staticPrototype, potentially calling generalized getter/proxy operations.
- SM `js/src/vm/NativeObject-inl.h:707–780`: own-property lookup does not mark private-name misses as ignore-prototype; its special stop behavior is for typed-array numeric indexes/resolve hooks.
- SM `js/src/vm/NativeObject.cpp:2660–2721`: ordinary native Set also traverses prototypes and can honor inherited data/accessor behavior.

Concrete public consequence already identified in upstream source: N `lib/internal/buffer.js:1101–1105` explicitly comments **“Private symbols are not inherited”** before implementing `isMarkedAsUntransferable` with a bracket read. Reusing a class-private name with ordinary inherited lookup can mark a child object as untransferable solely because its prototype has the key. This requires no private-key leak to the application; prototype construction is public. This is a predicted source-path mismatch, not a runtime result.

### Nonextensible objects and descriptor defaults

- N `deps/v8/src/objects/lookup-inl.h:289–317`: ordinary non-private addition is blocked; internal private addition is allowed unless the real V8 flag says otherwise or object has a fixed shared layout.
- N `deps/v8/src/flags/flag-definitions.h:406`: `js_nonextensible_applies_to_private` defaults false. Record exact native reference flags in later controls; do not claim universal V8 behavior across versions/configurations.
- N `deps/v8/src/objects/lookup.cc:623–625`: private additions force DONT_ENUM.
- SM `js/src/vm/NativeObject.cpp:2660–2691` calls SetNonexistentProperty on an ordinary miss. Its optimized direct-receiver branch at `:2523–2551` calls DefineNonexistentProperty.
- SM `js/src/vm/NativeObject.cpp:1852–1918`: DefineNonexistentProperty checks `!obj->isExtensible()` unconditionally at `:1900` and then uses AddDataProperty.
- SM `js/src/vm/NativeObject.cpp:1627–1640`: general NativeDefineProperty instead has `!obj->isExtensible() && !id.isPrivateName()`. A native implementation using this path cannot establish that unchanged bracket assignment works.
- SM `js/src/vm/NativeObject.cpp:1402–1415` and `js/src/vm/PropertyInfo.h:83–85`: new bracket data fields use default Configurable/Enumerable/Writable flags, without private-key enumerable suppression.
- SM `js/src/vm/PropMap.cpp:438–454` preserves flags for private names during freeze/seal; `js/src/vm/JSObject.cpp:678–682` ignores private names when testing frozen state.

Upstream `markAsUntransferable` writes a private key directly before setting a real ArrayBuffer detach key (N `lib/internal/buffer.js:1089–1096`). An ordinary frozen object therefore exercises precisely the bracket path that native-only initialization does not cover. No control was executed.

### Proxy and native APIs

- N `deps/v8/src/api/api.cc:4706–4735`: SetPrivate defines an own DONT_ENUM value for JSObject and invokes JSProxy::SetPrivateSymbol for JSProxy. Unsupported special object types return false. Native methods are not interchangeable with bracket assignment.
- N `deps/v8/src/objects/objects.cc:2808–2813`: first ordinary internal-key addition to Proxy fails with kProxyPrivate; `:3576–3621` supplies the separate native SetPrivateSymbol dictionary initialization/update path.
- N `deps/v8/src/api/api.cc:4770–4772`: GetPrivate delegates to actual private-key Get. `:5027–5028`: HasPrivate is HasOwnProperty. `:4996–5006`: DeletePrivate explicitly says no author script runs.
- N `deps/v8/src/objects/js-objects.cc:976–994`: proxy hidden-data deletion is handled directly before ordinary property deletion/trap branches.
- SM `js/public/Proxy.h:318–327`: base handlers use private expando by default, with separate throwOnPrivateField policy.
- SM `js/src/proxy/Proxy.cpp:84–122`: missing private expando/get descriptor throws; existing values/getters use the real receiver.
- SM `js/src/proxy/Proxy.cpp:38–69`: update requires existing expando and own descriptor. `:139–156` native define may create the expando.
- SM `js/src/proxy/Proxy.cpp:245–250`, `:505–510`, `:585–592`: private define/get/set special paths bypass ordinary scripted traps but are class-private semantics.
- SM `js/src/proxy/Proxy.cpp:434–460`: private HasOwn is a dedicated path. Native registry helpers should not substitute ordinary inherited HasProperty.
- SM `js/src/proxy/Proxy.cpp:272–292`: delete path asserts a private key cannot arrive, then delegates to handler. No special private expando deletion appears here.
- SM `js/public/Wrapper.h:114–117`: wrapper private accesses target the wrapped object instead of scripted-proxy expando. Native checked-unwrapping and cross-realm symbol/object wrapping remain important, not optional cleanup.

## Required design restrictions before registry implementation

1. Keep Node internal embedding keys distinguishable from JavaScript class field names. Extending all PrivateName semantics globally would risk changing real `#field` behavior and security policies. A dedicated engine kind or an equally explicit native-key identity distinction must govern the special property paths.
2. Own-only lookup must apply to **unchanged ordinary bracket reads/writes**, not just native helper APIs. Otherwise `isMarkedAsUntransferable`, VM identity and module bookkeeping can inherit hidden state from prototypes.
3. Distinguish native SetPrivate initialization from ordinary JS assignment, including scripted proxies. Do not “fix” first proxy bracket assignment to succeed merely because missing proxy read should return undefined.
4. Cover native/ordinary creation, descriptor attributes, missing reads, update, own-presence and deletion separately. Returning genuine hidden key identities satisfies only part of this contract.
5. Preserve native frame/zone rooting and realm identity, and explicitly trace security wrappers, revoked proxies, module namespaces and non-native host objects before broad claims. Existing clone patch admits native objects only and cannot be stretched silently to those owners.
6. No fallback to public Symbol, Symbol.for, source WeakMap substitution, changed upstream bracket expressions or fake successful bindings. Engine-owned implementation can change behind the original JS contract, but library semantics must remain upstream.

## Later validation obligations (not run)

When runtime validation is authorized, use unchanged upstream cases where available plus pinned native controls for: hidden ownKeys/getOwnPropertySymbols; child/prototype marker independence; absent own key; first/updated ordinary and native writes before/after preventExtensions/seal/freeze; descriptor flags; proxy missing read; first bracket write rejection vs native initialization; proxy traps and revoked proxies; native delete; cross-realm wrappers; native GC/root lifetime; actual markAsUntransferable/isMarkedAsUntransferable/detach behavior. Preserve native flags and outcome/error distinctions. No one of these is a proxy for the others.

These are source-derived predictions and design restrictions. Complete cross-engine equivalence is not established, and the report does not authorize tests or implementation.

## Exact inspected file identities

- `node:src/env_properties.h` SHA256 `891cb90ba1164eecc1ae5eef69ef3102369eeebc7630dccda2ca5737a2a097ad`.
- `node:src/env.cc` SHA256 `1b300917d1ec6e7c93d67638f28e88eda68157f08c22f884e6c4e464750cede8`.
- `node:src/node_util.cc` SHA256 `49623ce5e9712f6efd74762b439a4b0a812a96130ee638530d1128893e0d18ae`.
- `node:lib/internal/buffer.js` SHA256 `066f6cec5e6ea81e376005cf8102bf944828903e8441eece0be2149ca809f14f`.
- `node:deps/v8/include/v8-object.h` SHA256 `d0fba4db8ee994b3d431ba3a432dfcb3d6cea832fe0013e79d2dd4a51ad515a0`.
- `node:deps/v8/src/api/api.cc` SHA256 `147e419129137728659555cdb7866823e0ee7bc005e81ff5206c9f064e094f86`.
- `node:deps/v8/src/heap/factory.cc` SHA256 `e16d2ccca327ccacff24ecf783b451562f1a162784f6f284dc83a4cecf20b663`.
- `node:deps/v8/src/objects/name.h` SHA256 `1fb429660fb357927c5980d3510cb255f2fb2e2612b4e684c1d1514319fe31c3`.
- `node:deps/v8/src/objects/name-inl.h` SHA256 `a6faac3698a61b9a8665c33ee862739a535c3119083a95e96d4a2741dc961af6`.
- `node:deps/v8/src/objects/keys.cc` SHA256 `7d70731b33def3bfe1913de76fc4619e07e53cf1fca4303a59c6eac780d0f517`.
- `node:deps/v8/src/objects/lookup-inl.h` SHA256 `004c63d1533640a84bccf24a93edb186d7ab5323d0015543d5a64fd486d54324`.
- `node:deps/v8/src/objects/lookup.cc` SHA256 `a932af97555b9801ee38a770fd818ec1a88b8a779dbf6460c2354072bef7bbf3`.
- `node:deps/v8/src/objects/objects.cc` SHA256 `17ddead52e49c1a5967cbafacd35cbbc3e7c504730ed94789663367866c8ef9c`.
- `node:deps/v8/src/objects/js-objects.cc` SHA256 `b9b77eec122059b1408f35cc3122d72e01375a784af4d6cb019ad0df83b00bff`.
- `node:deps/v8/src/flags/flag-definitions.h` SHA256 `9ca9821c2d9b29477cea1cb4d0686024be384ae6a4585e8586629017d557dac4`.
- `engine:js/src/vm/Interpreter-inl.h` SHA256 `e700318d5129a54e6fcc52d1ff89e82a8690dbf0041efc811f1cf833a54c4f32`.
- `engine:js/src/vm/NativeObject.cpp` SHA256 `ca4498f0aecd2ed132e2ad821c537f35f313107f3a1256c135cff4df7f3efbc9`.
- `engine:js/src/vm/NativeObject-inl.h` SHA256 `f4598a6c9cda32f0a052683be38dd4bd757f527d1094ac6d3ebb0953d7607c30`.
- `engine:js/src/vm/PropertyInfo.h` SHA256 `26a16a2b4c80e41eee7ef095982128d37e05f3946621e46b8537c3989188cce4`.
- `engine:js/src/vm/Iteration.cpp` SHA256 `73afc8924cefccda86cc778135e04778b4a720c0c86e62cd41d939e74228c53d`.
- `engine:js/src/vm/PropMap.cpp` SHA256 `9756e7c6398253cc65b6a44b531ed8a2cd9f750cb88ce2377ed008d286b8ccc3`.
- `engine:js/src/vm/JSObject.cpp` SHA256 `dd6db4cca2928018a449629caf5d6f423ca6fd0a1d803807658f207dee1dc8dc`.
- `engine:js/src/builtin/Reflect.cpp` SHA256 `1bbb7cf2117977a00a43bd3d6e1c8b19f61a78886b2540d0699bb5785f403981`.
- `engine:js/src/builtin/Object.cpp` SHA256 `fcecaf6b25d85b471efb64ddcd356e3f14f7aa875b75b395be6eccc5e31e0241`.
- `engine:js/src/proxy/Proxy.cpp` SHA256 `a5513201d159e3b5abbaa00a51ce6f97eb236c95ec37878784110856c2a54648`.
- `engine:js/public/Proxy.h` SHA256 `636ad3f079207365d0b4b0f4cf86ad00cbb9db99450776be0b34c9ac8d808d83`.
- `engine:js/public/Wrapper.h` SHA256 `9253517fa372dde76beb1edf805f113155e31ea930125670a7bca9ed64ef6c45`.
- `candidate:packages/registry/spidermonkey/patches/0042-kandelo-node-clone-boundary.patch` SHA256 `e0800939d1db4aa4b5cc9794ddda95211fc9677f958d2529959a7b8673c5ba6e`.

## Subsequent coordinator native control

The coordinator ran `private-key-native-controls.cjs` with the pinned native
Node 26.13.0 Darwin arm64 executable and `--expose-internals`. All eleven
assertion cases passed. Its executable SHA-256, control SHA-256, exact flags,
engine version, outcomes and limitations are recorded separately in
`private-key-native-reference.json`. This confirms the covered reference
expectations, including the public untransferable-marker consequences. It
does not validate SpiderMonkey, native SetPrivate initialization, initialized
proxy deletion, cross-realm/security wrappers, revocation or GC ownership.
The source review above remains source-scoped; no guest conformance follows.

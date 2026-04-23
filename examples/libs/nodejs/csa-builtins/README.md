# Hand-written CSA-replacement shims (Torque CC backend)

This directory holds C++ implementations that stand in for V8 builtins
whose source is NOT available in Torque — builtins at
`deps/v8/src/builtins/builtins-<group>.cc` written directly against
`CodeStubAssembler`. The Torque CC backend translates Torque sources
only; CSA-only builtins need hand-written equivalents when they end up
on our interpreter dispatch path.

## When to write a shim

Write one when:
1. A Phase 5+ d8 / cctest / mjsunit run fails with "undefined reference
   to `Builtin_<Name>`" or crashes inside a builtin that has no
   translated `.tq` body.
2. Inspection of `deps/v8/src/builtins/` confirms `<Name>` lives only
   in CSA C++, not in any `.tq` file.

## Shape of a shim — two mechanisms depending on linkage

Phase 5 (revised) uses V8's existing **CPP-ABI adaptor pipeline**
(`AdaptorWithBuiltinExitFrameN` via `BuildAdaptor`) for Torque-translated
JS-linkage builtins. Hand-written shims follow the same shape.

### Stub-linkage shim (Phase-4-style)

For a stub-linkage builtin (no `javascript` keyword in its
declaration), write a shim with the Phase-4 signature:

```cpp
// File: builtins-<group>.cc
#include "src/builtins/builtins.h"
#include "src/execution/isolate.h"
#include "src/objects/tagged.h"
// … whatever <Name> needs

namespace v8::internal {

Tagged<RetType> Builtin_<Name>(Isolate* isolate,
                               Tagged<Context> context,
                               // … args
                               ) {
  // port CSA logic to plain C++
}

}  // namespace v8::internal
```

Register via an addition to the hand-written companion to
`torque-generated/builtins-cc-table.inc`. `Builtins::TorqueCcEntryOf`
will resolve `<Name>` to `&Builtin_<Name>`. No edit to V8's
hand-written `builtins-definitions.h` is needed — stub-linkage builtins
aren't accessed by V8's Kind dispatch, only by function pointer.

### JS-linkage shim (Phase-5-style)

For a JS-linkage builtin, write a shim with the CPP-ABI signature
(matching `BUILTIN(Name, ...)` expansion from
`deps/v8/src/builtins/builtins-utils.h`):

```cpp
// File: builtins-<group>.cc
#include "src/builtins/builtins-utils-inl.h"
#include "src/execution/isolate.h"
#include "src/objects/tagged.h"
// … whatever <Name> needs

namespace v8::internal {

Address Builtin_<Name>(int args_length, Address* args_object,
                       Isolate* isolate) {
  DCHECK(isolate->context().is_null() || IsContext(isolate->context()));
  BuiltinArguments args(args_length, args_object);
  HandleScope scope(isolate);
  // port CSA logic to plain C++ using args.receiver()/target()/etc.
  return result.ptr();
}

}  // namespace v8::internal
```

Register by patching `deps/v8/src/builtins/builtins-definitions.h`
(the hand-written file, NOT the torque-generated include) to replace
the builtin's existing `TFJ(<Name>, ...)` entry with
`CPP(<Name>, JSParameterCount(<N>))`. V8's existing `DECL_CPP` static-
init + `BUILD_CPP_WITHOUT_JOB` bootstrap pipeline handles the rest.

## Ledger

| Builtin | Linkage | Shim file | Phase | Notes |
|---------|---------|-----------|-------|-------|
| _(none yet)_ | | | | |

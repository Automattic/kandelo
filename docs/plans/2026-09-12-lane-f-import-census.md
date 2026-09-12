# Fork-module import census — what Wasm genuinely cannot do

The host fork TypeScript is set aside (`attic/fork-typescript-do-not-use/`,
commit `49d7f6574`). This census answers: if fork capture and replay are built
entirely in the Rust fork-module, **which host imports are actually required?**

**Method.** Every claim below is either measured from a binary or tested against
V8 with a passing control. No claim rests on a comment in the set-aside code —
several of those have already been shown wrong. Where I reasoned rather than
measured, it says so.

---

## 1. What the fork-module imports today — measured

`WebAssembly.Module.imports()` on `local-binaries/fork_module32.wasm`:

| import | kind |
|---|---|
| `env.memory` | memory |
| `env.__indirect_function_table` | table |
| `env.__stack_pointer`, `env.__memory_base`, `env.__table_base` | global ×3 |
| `env.__wpk_fork_function_catalog` | table funcref |
| `env.__wpk_fork_drive_table` | table funcref |
| `env.__wpk_fork_static_root_catalog` | table anyref |
| **`env.resolve_externref`** | **function — the only one** |

**9 entries, exactly one function.** It also *exports* a table,
`__wpk_fork_ref_gc_transit`, which the guest imports — the module already owns a
reference-typed table rather than borrowing one. That matters below.

## 2. The surface that actually has to be served — measured

The module's own 9 imports are not the problem. The problem is what the **guest**
imports for fork, because that is what the deleted TypeScript was implementing.
Parsing the import section of a fork-instrumented guest
(`examples/accept_signal_test.wasm`) with signatures:

**58 fork-related imports**, of which 7 are `kernel.kernel_*fork*` syscalls
already served by the kernel channel. The remaining **51 `env.__wpk_fork_*`
entries are the fork ABI the set-aside TypeScript served.**

### The finding: 44 of the 51 are pure scalar

Exactly **seven** entries touch a reference type or a non-function kind:

| entry | signature |
|---|---|
| `__wpk_fork_ref_provenance_externref` | `(externref) -> externref` |
| `__wpk_fork_ref_encode_funcref` | `(funcref) -> i32` |
| `__wpk_fork_ref_decode_funcref` | `(i32) -> funcref` |
| `__wpk_fork_unwind` | `tag () -> ()` |
| `__wpk_fork_ref_gc_transit` | `table anyref` |
| `__wpk_fork_resume_table` | `table funcref` |
| `__wpk_fork_module_activation`, `__wpk_fork_module_state_table_generation_addr` | `global i32`, `global i64` |

**The other 44 are `(i32…) -> i32/i64` in every position** — the whole
`__wpk_fork_module_state_*` family (12), `__wpk_fork_ref_gc_*` (11 of 12),
`__wpk_fork_ref_exn_*` (9), `__wpk_fork_ref_vector_*` (4),
`__wpk_fork_frame_*` (4), `__wpk_fork_ref_scratch_*` (2), and the rest. They are
computation over linear memory with no reference value at the boundary.

**A Rust function can serve every one of those 44.** They are in JavaScript today
because that is where they were written, not because Wasm cannot express them. A
guest import can be bound to another module's export — that binding is wiring at
instantiation, not TypeScript.

---

## 3. Challenging the seven

### 3.1 The tag — NOT a host import. Measured.

Claim in the set-aside code: the fork-unwind tag is host-minted.

Tested: a module that *defines* a tag, exports it, throws it and catches it:

```
exports: __wpk_fork_unwind:tag, boom:function, catches:function
tag is a WebAssembly.Tag: true
module catches its own throw: true
```

A Wasm module can define and export a tag, and the export is a real
`WebAssembly.Tag` the guest can import. **The fork-module should define
`__wpk_fork_unwind` itself.** (Rust does not emit a tag definition; the existing
`fork-module-inject` walrus pass is the same mechanism already used for
`__wpk_fork_ref_decode_funcref`.)

### 3.2 The four reference-typed tables — NOT host imports. Measured.

The shipped module already **exports** `__wpk_fork_ref_gc_transit` as an anyref
table, and the guest imports it. That is the existence proof: a Wasm module can
define and export reference-typed tables, and the host only wires them.

The same applies to `__wpk_fork_function_catalog`, `__wpk_fork_drive_table`,
`__wpk_fork_static_root_catalog` and `__wpk_fork_resume_table`. **Defining them
is not a host import.** *Populating* them is the real question — §3.4.

### 3.3 The two globals — NOT host imports.

A module can define and export globals; this one already exports `__data_end`.
`__wpk_fork_module_activation` and the generation address are module-owned state.

### 3.4 Reference IDENTITY — the one genuine capability floor. Measured.

`__wpk_fork_ref_encode_funcref (funcref) -> i32` and the externref equivalent
require deciding whether two live references are the same. Put to V8 directly,
with hand-encoded modules and a **passing control**:

```
ref.eq on eqref        VALIDATES — ref.eq accepted          <- control
ref.eq on funcref      REJECTED — expected either eqref or (ref null shared eq)
ref.eq on externref    REJECTED — expected either eqref or (ref null shared eq)
ref.eq on anyref       REJECTED — expected either eqref or (ref null shared eq)
```

*(An earlier attempt with `wat2wasm --enable-all` "rejected" all three — but its
control failed too, because that build does not know `eqref`. That test proved
nothing and was discarded. This one has a control that passes.)*

And a host reference cannot be cast into the comparable hierarchy either —
`any.convert_extern` then `ref.test eq`:

```
a JS object   -> 0      a JS function -> 0
a string      -> 0      null          -> 0        (1 would mean comparable)
```

**So: Wasm cannot compare two funcrefs or two externrefs, and no cast rescues a
host reference into the eq hierarchy. JavaScript can, with `===`. This is the
floor, and it is the only one in the reference machinery.**

Note the asymmetry, which halves the surface:

- **value → ordinal (capture)** needs identity. **Host.**
- **ordinal → value (replay)** is `table.get` on a populated table. **Pure Wasm**
  — `__wpk_fork_ref_decode_funcref` is already an injected `table.get` shim, and
  `env.resolve_externref` is the same shape done as a per-lookup call instead.

`env.resolve_externref` is therefore **not irreducible as a function**. It is a
per-lookup crossing that a bulk seed replaces: the host fills an externref table
once, the module does `table.get`. That converts a hot import into cold setup.

**Challenge to even the identity floor, which the maintainer should rule on:**
identity is only needed because the guest hands over a reference *value*. If
`fork-instrument` were changed to carry the ordinal alongside the value at each
encode site, the comparison disappears. That is an instrumentation redesign and
an ABI change, not a Wasm limit — so the honest statement is *"given today's
instrumentation, this needs the host."*

### 3.5 Instantiation wiring — required, but not an implementation.

`env.memory`, `env.__indirect_function_table` and the three PIC placement globals
cannot come from the module: it must share the guest's memory and table, and it
cannot place itself before it exists. These are real imports a new host supplies,
but they are five wiring lines, not logic.

The `--pie` placement is itself a *choice* — a fixed-offset link would need no
placement globals. It was chosen because fixed offsets collide with live guest
data, which is a real constraint, so the choice stands.

---

## 4. The final list

**Host imports the fork-module genuinely needs.**

### Irreducible — a capability Wasm does not have (2 functions)

| import | why | evidence |
|---|---|---|
| `host_funcref_ordinal(funcref) -> i32` | no funcref equality | V8 rejects `ref.eq` on funcref, control passes |
| `host_externref_handle(externref) -> i32` | no externref equality, and no cast into the eq hierarchy | V8 rejects `ref.eq` on externref; `any.convert_extern`+`ref.test eq` returns 0 for every host value |

Both are the **same capability** — reference identity — in two type flavours.
Both are *capture-direction only*; replay is `table.get`.

### Irreducible — bootstrap wiring, no logic (5 entries)

`env.memory`, `env.__indirect_function_table`, `env.__memory_base`,
`env.__stack_pointer`, `env.__table_base`.

### Required, but as COLD SETUP rather than a live import (2 loops)

Populating the funcref catalog / resume table, and the externref table for
replay. Only the host can obtain another instance's function references and live
host values. This is `table.set` in a loop at fork time — **or zero, if
instrumentation is changed to have the guest publish its own `ref.func`s.**

### Outside the module, and unchanged by any of this (2)

Child worker spawn + COW instantiate, and the worker-message bridge. The fork
spans two workers; no module call can span them.

---

**Total: 2 functions, 5 wiring entries, 2 setup loops.** Against 51 guest fork
imports served by TypeScript today, and 44 of those 51 provably serveable by Rust
with no host involvement at all.

**What I have NOT established:** that the 44 scalar entries are *correct* as
specified — only that their signatures admit a Rust implementation. And the
two-worker span means the parent/child join stays host-sequenced regardless.

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

**A challenge I raised and then had to withdraw — RETRACTED 2026-09-12.**

I suggested that if `fork-instrument` carried the ordinal alongside the value at
each encode site, the comparison would disappear and the irreducible count would
go to zero. **That was wrong twice over, and the maintainer caught the first
reason before I did: it would grow the stack frame.**

**Reason 1 — it costs a local per live reference, which this design forbids on
measured grounds.** `docs/fork-instrumentation.md` states the invariant as a
stack-depth requirement, not a space optimisation, and gives the numbers from the
PR #701 V8 reproducer — an instrumented recursive function's surviving call
depth against its declared local count:

| declared locals | surviving recursive calls |
|---|---|
| 4 | 9,959 |
| 8 | 8,536 |
| 12 | 6,639 |

About **-415 calls per added local on average, and worsening** (-356/local from
4 to 8, -474/local from 8 to 12). Hence: *"ABI 43 does not add a generated local
or linked-frame field per live reference, recipe, catch arm, or catch region."*

**It is enforced, not just documented.**
`crates/fork-instrument/tests/switch_dispatch.rs` asserts that 32
reference-bearing catch arms produce **identical** generated local counts to 1
(`assert_eq!(many_arms, one_arm)`), and that the linked-frame payload stays
**16 bytes** in both cases. Carrying a per-reference ordinal fails both.

Today a live reference costs **zero locals and zero frame bytes**: the frame owns
only the reference-vector ordinal in its existing `+12` header word, and the
recipes live in the process transaction arena, outside every native activation.

**Reason 2 — it would not remove the import anyway.** The statically-known case
is already handled and never reaches this path:
`crates/fork-instrument/src/static_reference_catalog.rs` harvests statically
initialised references once at instantiation. So the encode calls that remain are
precisely the ones with *dynamic* provenance — a funcref from a `table.get` whose
index is dead by unwind time, or one that arrived as a parameter. Those are
exactly the cases an ordinal cannot be carried for without a local, or without a
signature change that adds a parameter (which is a local) at every call site.

**So the identity floor stands, and it is not an artefact of the instrumentation
design — the instrumenter already avoids it everywhere it can.** The two
functions in the final list are irreducible.

The static path still needs the host, but in the shape already on the list as
cold setup rather than a live import: the harvest function's output is recorded
by the host as weak object-to-ordinal mappings.

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

**Total: 2 functions, 5 wiring entries, 2 setup loops** — and the instrumentation challenge that might have removed the 2 is withdrawn on stack-frame grounds (see 3.4). Against 51 guest fork
imports served by TypeScript today, and 44 of those 51 provably serveable by Rust
with no host involvement at all.

**What I have NOT established:** that the 44 scalar entries are *correct* as
specified — only that their signatures admit a Rust implementation. And the
two-worker span means the parent/child join stays host-sequenced regardless.


---

## 5. Implementation finding — the GC capture family is gated on table primitives

Added 2026-09-12 while implementing, and it changes the order of the work
without changing the host import list.

Reading `crates/fork-instrument/src/module_gc_codec.rs` at each emitted call
site shows how a GC reference reaches the module: **the guest publishes it into
the module-owned anyref transit table and passes the SLOT**, never the value.

```
table.set(transit, 0, value) ; i32.const 0 ; call lookup   -> existing recipe or 0
i32.const 0                  ; call claim                  -> fresh recipe
                             ; table.set(transit, recipe+1, value)
```

That is why the signatures are honestly scalar. But it means the module has to
operate on that table, and **Rust/LLVM emits none of the table instructions**:

| guest import | needs | plain Rust? |
|---|---|---|
| `__wpk_fork_ref_gc_i31` | nothing — the guest does `i31.get_s` first | **yes, landed** |
| `__wpk_fork_ref_gc_lookup` | `table.get` + `ref.eq` to find an existing recipe | no — shim |
| `__wpk_fork_ref_gc_claim` | `table.grow` ("claim grows the process-owned transit table through recipe+1 before returning") | no — shim |
| `__wpk_fork_ref_gc_broker_encode` | `table.grow`, same shape | no — shim |
| `__wpk_fork_ref_gc_capture_layout` | unclear — called while the value sits in transit slot 0, so it may inspect it | **undetermined** |
| `__wpk_fork_ref_gc_define`, `provenance_*` | scalar args over the builder | likely yes |

**This is injector work, not host work.** The shims run inside the module, so
none of it adds a host import and the approved list is unchanged. But it means
the GC block cannot be finished by writing Rust alone: `fork-module-inject`
needs a small set of anyref-table primitives (`get`, `set`, `grow`) exposed to
the Rust side, in the same way it already injects `__wpk_fork_ref_decode_funcref`
and `fm_drive_execute`.

Note this also settles the transit `table.grow` item from §3.5 as *required*
rather than *optional*: `claim` cannot be implemented without it.

**`capture_layout` is marked undetermined rather than guessed.** The guest
`ref.cast`s the value itself and clears transit slot 0 immediately after the
call, so whether the module must read the slot is not decidable from the call
site alone. It is not implemented on a guess.

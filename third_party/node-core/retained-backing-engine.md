The backing-store engine delta retains actual native allocations across
asynchronous byte users. It is source work pending the coordinated engine
build; it does not install a production BufferSource binding by itself.

The VM sees a C++17 capability interface, with no Node headers, retained JS
values or context pointers in allocation/owner/span/transfer handles. One
immutable process provider creates real allocation handles. Its resolver looks
up the existing owning-thread primary environment; missing/retired accounts
return no account and never create an environment. Provider code and its hooks
must remain loaded until all capabilities retire. The C++20 shell implementation
uses the existing native-retained-memory service and sealed backing primitive.


Root review corrected a distinct controller projection gap: native owner and
span records now claim the actual allocation-wrapper record as well as their
payload/store and self records. The original helper placed136 controller bytes
in the fallback pool and credited an unrelated live account. The unchanged
known-owner assertion now passes, including native-only span retention and
last release. Truly contextless packet/raw-only records still use pending
ownership. This is accounting evidence, not RSS or production JSAPI pressure.

ArrayBuffer concrete classes append owner slots; data/length/view/flags and RAB
maximum slots keep their existing indices. Inline storage becomes a real
maximum-capacity allocation before capture and existing views are notified.
The moving-GC hook still uses the class's symbolic inline offset, while C++
owner metadata moves with the object's slots. Native spans keep their initial
offset and length independently of later visible view metadata. RAB resize
continues to zero discarded bytes in its real maximum allocation. No length
pin, source-list reread or old-send snapshot replaces allocation ownership.

Retirement dispatches the actual original allocator: arena malloc, mapped
extent, external callback/user data or Wasm raw allocation. Finalization and
detach drop the actual JS owner after retiring its engine charge. Fixed,
unchanged nonzero transfer can adopt the same allocation; RAB transfers and
length changes create the operation's actual destination while pending users
keep the old allocation. Wasm same-allocation grow/adoption moves ownership;
moving grow leaves the previous allocation live for its retained users.

Shared storage has one controller per actual SharedArrayRawBuffer. Raw atomic
references and a mutex protect reconstruction of the controller across raw
owners; the controller holds one actual raw reference. It drops the raw/store
cycle when that is the last raw reference. Actual JS-wrapper counts determine
payload pressure ownership, separately from raw/packet/native references.
Controller destruction and the final raw release run outside the raw mutex.
GSAB retains its existing maximum allocation and does not pin visible growth.

Same-process structured-clone packets retain actual allocation entries in an
owned sidecar. Encoded bytes contain a validated sidecar index, never a JS slot
or a raw ownership pointer. Reader commit, retry, malformed input, abort and
packet destruction retain/release the same allocation. Different-process
serialization keeps its existing byte path; native ownership cannot cross a
process/host boundary. This adds an ephemeral internal transfer-map tag and
requires one coherently built engine/embedding, not mixed packet formats.

USER_OWNED memory requires the actual embedder's deallocation capability via
InstallUserOwned before a nonempty span can be retained. The public user-owned
API gives SpiderMonkey no authority to retain an embedder allocation after
explicit detach. The capability transaction consumes ownership only on success;
a JS root or borrowed pointer cannot manufacture that missing ownership. No
production path is routed through this prerequisite yet, and it remains a gap
for embedders that have not supplied an actual capability.

Payload credits move to the existing process ledger when engine JS owners
retire; external/user-owned data uses that ledger while retained. Wrapper,
policy and packet-table material has separate real allocation records. Credits
track requested payload/object capacities, not allocator overhead, shared_ptr
control blocks, full Wasm guard reservations, admission, committed pages or RSS.
Wasm retained span capacity is its clamped logical maximum; accounting that
quantity does not establish exact virtual/committed mapping pressure. The
existing owning-thread primary projection remains advisory and can lag.

Validation is bounded: strict C++17 public capability/transfer compilation,
C++20 actual native factory and sealed ledger/primitive, source-extracted raw
reference synchronization with eight native threads, and exact pinned Node
backing identity/initial-span controls. The extraction replaces only the VM's
final raw deallocator with a controlled native destructor; it does not compile
VM JSAPI, GC, zones, Wasm mappings or the complete shared wrapper path. Per-file
upstream include/path/order checks and zero-fuzz source patch application are
source checks, not engine compilation or full checker gates.

Pending integration includes build/configuration and actual engine source
checks; routing native work/FS/codecs/UDP through Acquire with real lifetime and
cancellation ownership; full OOM/GC/realm/worker/shutdown/transfer observations;
USER_OWNED embedder adoption; Wasm pressure validation; and Node/browser parity
across all four hosts. No sanitizer pass, guest/package/product build, whole
suite, performance result or completed public BufferSource compatibility is
claimed. The independent UDP corrections and default-trigger handoffs remain
separate; the queued-copy UDP path remains incomplete until actual routing is
implemented and checked. The kernel buffer-budget proposal still requires its
explicit ABI transition.

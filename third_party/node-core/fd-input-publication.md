# Private fd input byte ownership

The fd stream consumer receives actual Uint8Array spans, not arbitrary values.
Generic fd and legacy captured-input Promise reads publish independently copied
native JS bytes via KandeloResolvePromiseWithBytes/KandeloNewUint8ArrayCopy.
The current captured TTY path creates a JS ArrayBuffer copy of its read ticket,
then its terminal dispatcher supplies the real offset/count Uint8Array window.
A zero-length span is EOF; public borrowed descriptors and native request
retirement remain with their existing owners.

The fd publisher now retains those bytes through the real private FastBuffer
constructor and captured typed-array buffer/offset/length getters. It neither
copies a view through an iterable/array-like route nor calls captured/public
Buffer.from, whose pinned algorithm can consult mutable valueOf. Like target
onStreamRead, it wraps the exact native allocation/window. That allocation is
already independent of kernel/native read storage and stays alive through the
Buffer view after request retirement; this does not alias a reusable native
scratch vector or borrowed pointer. It also preserves nonzero offsets/counts
without exposing other bytes from the allocation.

Bootstrap supplies its existing lexical _FastBuffer. No fallback through a
public Buffer constructor or object-shaped capability is provided. Callback,
read-stop/ref/cancel/error, EOF and descriptor ownership are otherwise unchanged.
This does not implement public TTY/Socket subclasses or full StreamBase.

Focused evidence uses real native Node pipe/TTY onStreamRead and normally
generated candidate JS over explicit native dependencies. It does not execute
guest JSAPI/provider, GC/realm/OOM/fatal/Worker/fork or four-host paths. Native
span retention observations are not public API pass counts or complete fd/
stdio compatibility.

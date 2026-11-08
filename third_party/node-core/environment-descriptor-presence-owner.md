# Live environment descriptor admission

The actual native environment virtual object remains the live store owner.
KandeloEnvDefine passes its real incomplete native descriptor through
JS::FromPropertyDescriptor. That operation creates an ordinary object and
materializes only the native descriptor fields that are present. The process
state callback must therefore distinguish an own field from an inherited one.

The pinned Node26.13 EnvDefiner requires value presence plus all three writable,
enumerable and configurable presence bits before accepting a data descriptor.
Only then does it inspect their values, in configurable/enumerable/writable order,
and delegate to the real setter. The adapter now uses its captured own-property
intrinsic for those three presence tests before any flag-value reads. Existing
own checks for value/get/set remain unchanged. An own value of undefined is still
a present data value and becomes the string undefined through the actual setter;
an explicit own get or set of undefined remains an accessor descriptor rejection.
Missing flags and false flags still take the original generic descriptor error
before key/value coercion and real environment mutation.

This closes a concrete source-level wrong-success path: a null-prototype caller
descriptor can have only value during ToPropertyDescriptor, while properties
poisoned onto Object.prototype appear later on the ordinary native descriptor
carrier. Previously they could supply missing true flags, run additional getters
or replace the required error. They now cannot invent native has_* state. Ordinary
user-descriptor getter/coercion order remains owned by the existing engine
ToPropertyDescriptor operation; legitimate inherited fields on that original
descriptor are still honored there. No property is removed from Object.prototype,
no shadow environment is created and failed POSIX names retain current store policy.

The existing source107 live environment hooks/store and source148/160 process
owners are reused, not reimplemented. This slice does not correct the remaining
prototype/anonymous-constructor/native construction gap: actual guest creation
currently passes ObjectPrototype directly, while the preserved native reference
records an intermediate prototype with a constructor. A native V8 addon fixture
has its own template and cannot prove the guest prototype shape. Worker/SHARE_ENV,
warning/deprecation, permission, TZ, cloning, GC, realm, errors and full descriptor
conformance remain open. No platform or environment capability is fabricated.

This is source-only. No runtime/reference/component test, probe, compiler,
generation, package or overall suite ran. The original source107 15/16 native
frontend outcome and snapshot nonpass, original compiler/setup failures and their
actual evidence remain immutable; no old outcome is credited again. Guest JSAPI
and four-host behavior are not established by this change. Processes remains partial.
